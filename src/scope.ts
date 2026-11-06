import { AU_RESIDENCY_MESSAGE, FounduError, SCOPE_REFUSAL_MESSAGE } from './errors.js';

/**
 * FoundU surface for the Infinity / Steadfast engagement.
 *
 * Public OpenAPI is partner-gated. Until Infinity Ben grants access, these
 * prefixes are the only paths the client will call. They are aggregate
 * routes for rosters, timesheet hours, and rolled-up labour cost.
 *
 * Pay rates, bank details, tax file numbers, payroll records, and employee
 * personal data are refused before any network call.
 */
export const ALLOWED_PREFIXES = [
  '/api/v1/aggregates/rosters',
  '/api/v1/aggregates/hours',
  '/api/v1/aggregates/timesheets',
  '/api/v1/aggregates/labour-cost',
] as const;

export const ROSTER_SUMMARY_PATH = '/api/v1/aggregates/rosters';
export const HOURS_SUMMARY_PATH = '/api/v1/aggregates/hours';
export const LABOUR_COST_PATH = '/api/v1/aggregates/labour-cost';

const PATH_DENY_TOKENS = new Set([
  'employee',
  'employees',
  'payroll',
  'payslip',
  'payslips',
  'payrate',
  'payrates',
  'rate',
  'rates',
  'salary',
  'wage',
  'wages',
  'bank',
  'banking',
  'bsb',
  'iban',
  'tfn',
  'tax',
  'taxfile',
  'super',
  'superannuation',
  'pii',
  'onboarding',
  'contact',
  'contacts',
  'address',
  'email',
  'phone',
  'mobile',
  'line',
  'lines',
  'entry',
  'entries',
  'record',
  'records',
  'detail',
  'details',
  'dump',
  'export',
]);

const KEY_DENY_TOKENS = new Set([
  'tfn',
  'bsb',
  'iban',
  'salary',
  'wage',
  'wages',
  'dob',
  'email',
  'phone',
  'mobile',
  'super',
  'superannuation',
  'address',
  'surname',
  'firstname',
  'lastname',
  'fullname',
  'birthdate',
  'taxfile',
  'payrate',
]);

const SINGLE_RESOURCE =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function tokensOf(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveKey(key: string): boolean {
  const tokens = tokensOf(key);
  if (tokens.some((token) => KEY_DENY_TOKENS.has(token))) {
    return true;
  }
  const has = (token: string) => tokens.includes(token);
  if (has('rate') && (has('pay') || has('hour') || has('hourly') || has('base') || has('penalty') || has('overtime') || has('ordinary') || has('loaded') || has('average'))) {
    return true;
  }
  if (has('tax') && (has('file') || has('number'))) {
    return true;
  }
  if (has('bank') || (has('account') && (has('number') || has('name') || has('bsb')))) {
    return true;
  }
  if ((has('first') || has('last') || has('full') || has('given') || has('preferred')) && has('name')) {
    return true;
  }
  if (has('date') && has('birth')) {
    return true;
  }
  if (has('employee') && (has('id') || has('name') || has('number') || has('email') || has('phone'))) {
    return true;
  }
  return false;
}

function valueMentionsSensitive(value: string): boolean {
  const tokens = tokensOf(value);
  return tokens.some((token) => PATH_DENY_TOKENS.has(token) || KEY_DENY_TOKENS.has(token));
}

export function canonicalizeAggregatePath(input: string): string {
  if (typeof input !== 'string' || !input.startsWith('/')) {
    throw new FounduError('not_authorized', SCOPE_REFUSAL_MESSAGE);
  }
  if (input.includes('\\') || input.includes('\0') || input.includes('://') || input.startsWith('//')) {
    throw new FounduError('not_authorized', SCOPE_REFUSAL_MESSAGE);
  }

  let decoded = input;
  try {
    decoded = decodeURIComponent(decoded);
    if (decoded.includes('%')) {
      decoded = decodeURIComponent(decoded);
    }
  } catch {
    throw new FounduError('not_authorized', SCOPE_REFUSAL_MESSAGE);
  }

  if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0') || decoded.includes('://') || decoded.startsWith('//')
    || /[?#%]/.test(decoded)) {
    throw new FounduError('not_authorized', SCOPE_REFUSAL_MESSAGE);
  }

  const safe: string[] = [];
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      throw new FounduError('not_authorized', SCOPE_REFUSAL_MESSAGE);
    }
    safe.push(part.toLowerCase());
  }

  const path = `/${safe.join('/')}`;
  const allowed = ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  if (!allowed) {
    throw new FounduError('not_authorized', SCOPE_REFUSAL_MESSAGE);
  }

  for (const part of safe) {
    if (SINGLE_RESOURCE.test(part)) {
      throw new FounduError('not_authorized', SCOPE_REFUSAL_MESSAGE);
    }
    if (tokensOf(part).some((token) => PATH_DENY_TOKENS.has(token))) {
      throw new FounduError('not_authorized', SCOPE_REFUSAL_MESSAGE);
    }
  }

  return path;
}

export function assertAggregateQuery(query: Record<string, string> | undefined): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (isSensitiveKey(key) || valueMentionsSensitive(key) || valueMentionsSensitive(value)) {
      throw new FounduError('not_authorized', SCOPE_REFUSAL_MESSAGE);
    }
    if (value.length > 200 || /[\r\n]/.test(value)) {
      throw new FounduError('invalid_request', 'Query values must be a single line of at most 200 characters.');
    }
    safe[key] = value;
  }
  return safe;
}

export function validateAuBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new FounduError('not_authorized', AU_RESIDENCY_MESSAGE);
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const auHost = host === 'foundu.com.au' || host.endsWith('.foundu.com.au');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !auHost) {
    throw new FounduError('not_authorized', AU_RESIDENCY_MESSAGE);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new FounduError('not_authorized', AU_RESIDENCY_MESSAGE);
  }
  return url;
}

export interface RedactionResult {
  data: unknown;
  redactedFields: string[];
}

const MAX_REDACTION_DEPTH = 20;

export function redactSensitive(value: unknown): RedactionResult {
  const redactedFields: string[] = [];
  const data = walk(value, '$', redactedFields, 0);
  redactedFields.sort();
  return { data, redactedFields };
}

function walk(value: unknown, path: string, redactedFields: string[], depth: number): unknown {
  if (depth > MAX_REDACTION_DEPTH) {
    redactedFields.push(path);
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => walk(item, `${path}[${index}]`, redactedFields, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    const childPath = `${path}.${key}`;
    if (isSensitiveKey(key)) {
      redactedFields.push(childPath);
      continue;
    }
    output[key] = walk(child, childPath, redactedFields, depth + 1);
  }
  return output;
}
