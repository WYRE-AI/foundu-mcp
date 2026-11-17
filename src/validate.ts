import { ArgumentError } from './types.js';

const MAX_SEGMENT = 256;

/**
 * Returns one URL path segment, percent-encoded. Rejects anything that could
 * change which endpoint is hit: non-strings, empty, `.`, `..`, `/` or `\`,
 * percent-encoded separators or dots, and control characters. The URL is
 * also checked against the expected path after it is built (client.ts).
 */
export function pathSegment(value: unknown, key: string): string {
  if (typeof value !== 'string') throw new ArgumentError(`"${key}" is required and must be a string ID.`);
  const s = value.trim();
  if (
    s.length === 0 ||
    s.length > MAX_SEGMENT ||
    s === '.' ||
    s === '..' ||
    /[/\\]/.test(s) ||
    /%(2f|5c|2e)/i.test(s) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(s)
  ) {
    throw new ArgumentError(`Invalid "${key}": must be a single ID (1-${MAX_SEGMENT} characters) without ".", "..", "/", or "\\".`);
  }
  return encodeURIComponent(s);
}

/**
 * Every foundU path ID is a positive integer. Accepts a safe integer or a
 * digit string, runs it through pathSegment, and then insists on digits only.
 */
export function idSegment(value: unknown, key: string): string {
  const raw = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  const segment = pathSegment(raw, key);
  if (!/^\d{1,18}$/.test(segment)) throw new ArgumentError(`Invalid "${key}": foundU IDs are positive integers.`);
  return segment;
}
