/**
 * Builds a read-only tool from a declarative description of one foundU GET
 * endpoint, so every tool validates, encodes, and sends parameters the same
 * way:
 * - each `{name}` in the path is a required integer ID, validated and
 *   percent-encoded;
 * - `csv` lists go on the wire comma-separated (`filter_branches=1,2`), as
 *   foundU documents for most filters;
 * - `array` lists go on the wire in bracket form (`filter_ids[]=1&filter_ids[]=2`),
 *   for the parameters foundU types as arrays;
 * - booleans are flags: true sends the documented truthy value, false sends
 *   nothing;
 * - integers above `maximum` are capped to the vendor maximum;
 * - `wire` renames a param on the wire. Two params may share a wire name;
 *   their values are sent in declaration order.
 * Pagination is passed through as-is: no tool ever fetches a second page.
 * Most foundU list endpoints document `limit` but no `page`, so they can
 * never return more than one batch. Those tools say so in their description,
 * and a result that may have been cut off (as many rows as the limit sent, or
 * no limit sent, so foundU's undocumented default applied) is marked
 * `possibly_truncated`.
 */
import type { Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { founduGet } from '../client.js';
import { ArgumentError } from '../types.js';
import { idSegment } from '../validate.js';
import type { ToolArgs, ToolDef } from './types.js';

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

type Common = { description: string; required?: boolean; wire?: string };

export type StringParam = Common & { type: 'string'; enum?: readonly string[]; pattern?: RegExp };
export type IntegerParam = Common & { type: 'integer'; minimum: number; maximum?: number };
/** `trueValue` is what foundU expects for "on" (default `1`). */
export type BooleanParam = Common & { type: 'boolean'; trueValue?: string };
export type ListParam = Common & { type: 'csv' | 'array'; items: 'integer' | 'string'; enum?: readonly string[] };

export type Param = StringParam | IntegerParam | BooleanParam | ListParam;

export interface Endpoint {
  name: string;
  description: string;
  /** e.g. `/api/v2/employees/{id}`. */
  path: string;
  /** Description for each `{placeholder}` in `path`. */
  pathParams?: Record<string, string>;
  query?: Record<string, Param>;
  /** Cross-parameter rules (e.g. "exactly one of"); throws ArgumentError. Runs before any request. */
  validate?: (args: ToolArgs) => void;
}

const NO_PAGING_NOTE =
  ' Not paged: a list result is capped at `limit` and there is no next page, so narrow with filters or a shorter date window to see the rest.';
const POSSIBLY_TRUNCATED_NOTE =
  'This endpoint has no next page and returned as many records as the limit allows (or foundU applied its undocumented default limit), so more may exist. Narrow the filters or date window, or raise limit if it is below the maximum.';

/** Marks an unpaged `{ data: [...] }` result that may have been cut off at the limit. */
function flagIfPossiblyTruncated(result: unknown, sentLimit: number | undefined): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) return result;
  if (sentLimit !== undefined && data.length < sentLimit) return result;
  return { ...result, possibly_truncated: true, truncation_note: POSSIBLY_TRUNCATED_NOTE };
}

const MAX_STRING = 1000;
const MAX_LIST_ITEMS = 100;

function schemaFor(p: Param): Record<string, unknown> {
  switch (p.type) {
    case 'string':
      return {
        type: 'string',
        description: p.description,
        ...(p.enum ? { enum: [...p.enum] } : { maxLength: MAX_STRING }),
        ...(p.pattern ? { pattern: p.pattern.source } : {}),
      };
    case 'integer':
      return { type: 'integer', description: p.description, minimum: p.minimum, ...(p.maximum !== undefined ? { maximum: p.maximum } : {}) };
    case 'boolean':
      return { type: 'boolean', description: p.description };
    case 'csv':
    case 'array':
      return {
        type: 'array',
        description: p.description,
        maxItems: MAX_LIST_ITEMS,
        items:
          p.items === 'integer'
            ? { type: 'integer', minimum: 0 }
            : p.enum
              ? { type: 'string', enum: [...p.enum] }
              : { type: 'string', maxLength: MAX_STRING },
      };
  }
}

function checkString(value: unknown, key: string, p: { enum?: readonly string[]; pattern?: RegExp }): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ArgumentError(`"${key}" must be a non-empty string.`);
  const s = value.trim();
  if (s.length > MAX_STRING) throw new ArgumentError(`"${key}" is too long (max ${MAX_STRING}).`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new ArgumentError(`"${key}" must not contain control characters.`);
  if (p.enum && !p.enum.includes(s)) throw new ArgumentError(`"${key}" must be one of: ${p.enum.join(', ')}.`);
  if (p.pattern && !p.pattern.test(s)) throw new ArgumentError(`"${key}" has the wrong format (expected ${p.pattern.source}).`);
  return s;
}

function checkInteger(value: unknown, key: string, minimum: number): number {
  const n = typeof value === 'string' && /^\s*-?\d+\s*$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new ArgumentError(`"${key}" must be an integer.`);
  if (n < minimum) throw new ArgumentError(`"${key}" must be at least ${minimum}.`);
  return n;
}

function listItems(value: unknown, key: string, p: ListParam): string[] {
  if (!Array.isArray(value)) throw new ArgumentError(`"${key}" must be an array.`);
  if (value.length > MAX_LIST_ITEMS) throw new ArgumentError(`"${key}" accepts at most ${MAX_LIST_ITEMS} values.`);
  return value.map((item, i) => {
    const itemKey = `${key}[${i}]`;
    if (p.items === 'integer') return String(checkInteger(item, itemKey, 0));
    const s = checkString(typeof item === 'number' ? String(item) : item, itemKey, p);
    if (p.type === 'csv' && s.includes(',')) throw new ArgumentError(`"${itemKey}" must not contain a comma.`);
    return s;
  });
}

/** The wire values for one argument, or [] to send nothing. */
function wireValues(key: string, p: Param, value: unknown): string[] {
  switch (p.type) {
    case 'string':
      return [checkString(value, key, p)];
    case 'integer': {
      const n = checkInteger(value, key, p.minimum);
      return [String(p.maximum !== undefined ? Math.min(n, p.maximum) : n)];
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new ArgumentError(`"${key}" must be true or false.`);
      return value ? [p.trueValue ?? '1'] : [];
    case 'csv': {
      const items = listItems(value, key, p);
      return items.length ? [items.join(',')] : [];
    }
    case 'array':
      return listItems(value, key, p);
  }
}

function wireName(key: string, p: Param): string {
  const name = p.wire ?? key;
  return p.type === 'array' ? `${name}[]` : name;
}

export function endpointTool(spec: Endpoint): ToolDef {
  const pathParams = spec.pathParams ?? {};
  const placeholders = [...spec.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  if (placeholders.join() !== Object.keys(pathParams).join()) {
    throw new Error(`${spec.name}: pathParams must match the placeholders in ${spec.path}.`);
  }
  const query = spec.query ?? {};
  const paged = 'page' in query;
  const unpagedLimit = 'limit' in query && !paged;

  const properties: Record<string, object> = {};
  for (const [key, description] of Object.entries(pathParams)) properties[key] = { type: 'integer', minimum: 0, description };
  for (const [key, p] of Object.entries(query)) properties[key] = schemaFor(p);
  const required = [...placeholders, ...Object.entries(query).filter(([, p]) => p.required).map(([key]) => key)];

  const tool: Tool = {
    name: spec.name,
    description: unpagedLimit ? `${spec.description}${NO_PAGING_NOTE}` : spec.description,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    annotations: READ_ONLY,
  };

  return {
    tier: 'read',
    tool,
    paged,
    handler: async (args: ToolArgs, creds) => {
      const path = spec.path.replace(/\{(\w+)\}/g, (_match, key: string) => idSegment(args[key], key));
      const pairs: Array<[string, string]> = [];
      for (const [key, p] of Object.entries(query)) {
        const value = args[key];
        if (value === undefined || value === null) {
          if (p.required) throw new ArgumentError(`"${key}" is required.`);
          continue;
        }
        for (const v of wireValues(key, p, value)) pairs.push([wireName(key, p), v]);
      }
      spec.validate?.(args);
      const result = await founduGet(creds, { path, query: pairs });
      if (!unpagedLimit) return result;
      const sentLimit = pairs.find(([name]) => name === 'limit')?.[1];
      return flagIfPossiblyTruncated(result, sentLimit === undefined ? undefined : Number(sentLimit));
    },
  };
}
