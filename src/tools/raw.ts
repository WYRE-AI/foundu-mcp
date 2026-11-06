import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createFounduClient } from '../client.js';
import { getCredentials } from '../credentials.js';
import { FounduError } from '../errors.js';
import { ALLOWED_PREFIXES, assertAggregateQuery, canonicalizeAggregatePath } from '../scope.js';
import { requireCredentials, runTool, toolJson, type ToolTextResult } from './result.js';

const ALLOWED_METHODS = ['GET'] as const;

export const rawRequestTool: Tool = {
  name: 'foundu_raw_request',
  description:
    'GET an allowlisted FoundU roster, timesheet-hours, or labour-cost aggregate path. ' +
    `Allowed prefixes: ${ALLOWED_PREFIXES.join(', ')}. ` +
    'Employee, payroll, pay-rate, bank, tax-file, and other personal-data paths are refused before any network call. ' +
    'Requires partner API access granted by Infinity Ben. The public OpenAPI is partner-gated; these prefixes are the only surface this server will call.',
  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: ['GET'],
        description: 'HTTP method. Only GET is accepted.',
      },
      path: {
        type: 'string',
        minLength: 1,
        description: 'Aggregate path under an allowed prefix, for example "/api/v1/aggregates/rosters".',
      },
      query: {
        type: 'object',
        description: 'Query parameters. Employee, pay-rate, bank, and tax-file parameters are refused.',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
};

export async function handleRawRequest(args: unknown): Promise<ToolTextResult> {
  return runTool(async () => {
    const record = asRecord(args);
    for (const key of Object.keys(record)) {
      if (key !== 'method' && key !== 'path' && key !== 'query') {
        throw new FounduError(
          'not_authorized',
          'Refused. foundu_raw_request accepts method, path, and query only.',
        );
      }
    }

    const method = (typeof record.method === 'string' ? record.method : 'GET').toUpperCase();
    if (!ALLOWED_METHODS.includes(method as (typeof ALLOWED_METHODS)[number])) {
      throw new FounduError(
        'not_authorized',
        'Refused. foundu_raw_request accepts GET only, and only for roster, hours, and labour-cost aggregates.',
      );
    }
    if (typeof record.path !== 'string' || !record.path.trim()) {
      throw new FounduError('invalid_request', 'A non-empty aggregate path is required.');
    }

    const query = readQuery(record.query);
    // Scope is enforced before credentials so a sensitive path is refused
    // even when the partner token has not been configured.
    const path = canonicalizeAggregatePath(record.path);
    assertAggregateQuery(query);

    const credentials = requireCredentials(getCredentials());
    const client = createFounduClient(credentials);
    const result = await client.getAggregate(path, query);
    return toolJson({
      scope: 'raw_aggregate',
      aggregateOnly: true,
      omitted: ['pay_rates', 'bank_details', 'tax_file_numbers', 'employee_pii'],
      redactedFields: result.redactedFields,
      data: result.data,
    });
  });
}

function asRecord(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

function readQuery(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FounduError('invalid_request', 'Query parameters must be an object.');
  }
  const query: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      throw new FounduError('invalid_request', 'Query values must be strings, numbers, or booleans.');
    }
    query[key] = String(entry);
  }
  return query;
}
