/**
 * The only path to the foundU API. The host is a compile-time constant (the
 * tenant comes from the access token, never from the caller), so there is no
 * base-URL, host-allowlist, or DNS-pinning layer; what remains is the request
 * contract:
 * - GET only, fixed headers, redirect: "manual" and every 3xx is an error
 *   (foundU answers unauthenticated calls with 302 to /login);
 * - the URL is built from an already-encoded path and checked to stay on
 *   https://api.foundu.com.au at exactly that path;
 * - upstream calls are throttled per access token (FOUNDU_MAX_CONCURRENCY),
 *   so one tenant can never queue behind another, and 429/503 are retried
 *   with bounded backoff, because foundU publishes no rate limits;
 * - one deadline (FOUNDU_REQUEST_TIMEOUT_MS, plus the caller's cancellation)
 *   covers the whole call: waiting for a permit, every attempt, and backoff;
 * - response bodies are bounded while streaming;
 * - vendor errors keep HTTP status, message, and any request ID.
 * This server never refreshes tokens: foundU refresh tokens are one-time use,
 * so only the gateway may rotate them.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateAccessToken } from './auth.js';
import {
  ACCESS_TOKEN_ENV,
  isGatewayMode,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  maxConcurrency,
  maxUpstreamBytes,
  requestTimeoutMs,
  retryBaseMs,
} from './config.js';
import { AccessTokenError, ArgumentError, FounduApiError, type FounduCredentials } from './types.js';
import { VERSION } from './version.js';

export const FOUNDU_API_BASE = 'https://api.foundu.com.au';

const credentialStore = new AsyncLocalStorage<FounduCredentials>();
const callerSignal = new AsyncLocalStorage<AbortSignal>();

/** Runs fn with per-request credentials (gateway mode: from X-FoundU-Access-Token). */
export function runWithCredentials<T>(creds: FounduCredentials, fn: () => T): T {
  return credentialStore.run(creds, fn);
}

/** The per-request (gateway) token in scope, if any. Used by the logger to redact it exactly. */
export function scopedAccessToken(): string | undefined {
  return credentialStore.getStore()?.accessToken.trim() || undefined;
}

/** Per-request credentials if in scope; otherwise FOUNDU_ACCESS_TOKEN, except in gateway mode, which never reads env. */
export function resolveCredentials(): FounduCredentials {
  const scoped = credentialStore.getStore();
  if (scoped) return scoped;
  if (isGatewayMode()) {
    throw new AccessTokenError('No foundU access token on this request. Gateway mode requires the X-FoundU-Access-Token header.');
  }
  const accessToken = process.env[ACCESS_TOKEN_ENV]?.trim();
  if (!accessToken) throw new AccessTokenError(`No foundU access token configured. Set ${ACCESS_TOKEN_ENV}.`);
  return { accessToken };
}

/** Runs fn with the MCP request's cancellation signal, so upstream calls abort when the client cancels or disconnects. */
export function runWithAbortSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return signal ? callerSignal.run(signal, fn) : fn();
}

/** The deadline for one whole call: the request timeout, plus the MCP caller's cancellation. */
function requestSignal(): AbortSignal {
  const timeout = AbortSignal.timeout(requestTimeoutMs());
  const caller = callerSignal.getStore();
  return caller ? AbortSignal.any([timeout, caller]) : timeout;
}

/** Ordered (wire name, value) pairs; a repeated name (e.g. `ids[]`) is sent once per pair. */
export type QueryPairs = ReadonlyArray<readonly [string, string]>;

export interface FounduRequest {
  /** Path with every dynamic segment already validated and percent-encoded. */
  path: string;
  query?: QueryPairs;
}

export function buildUrl(path: string, query: QueryPairs = []): URL {
  const params = new URLSearchParams();
  for (const [key, value] of query) params.append(key, value);
  const qs = params.toString();
  const url = new URL(`${path}${qs ? `?${qs}` : ''}`, FOUNDU_API_BASE);
  if (url.origin !== FOUNDU_API_BASE || url.pathname !== path) {
    throw new ArgumentError('Refusing to call a path outside the foundU API.');
  }
  return url;
}

const cancelled = () => new FounduApiError('The foundU API request timed out or was cancelled.');

// ---- throttling -------------------------------------------------------------

/**
 * One lane per access token, i.e. per tenant integration, so a slow or
 * rate-limited tenant only ever queues behind itself. A lane exists only
 * while it has calls in flight or waiting.
 */
interface Lane {
  active: number;
  waiting: Array<() => void>;
}
const lanes = new Map<string, Lane>();

function acquire(key: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled());
  let lane = lanes.get(key);
  if (!lane) lanes.set(key, (lane = { active: 0, waiting: [] }));
  if (lane.active < maxConcurrency()) {
    lane.active++;
    return Promise.resolve();
  }
  const queue = lane.waiting;
  return new Promise<void>((resolve, reject) => {
    const grant = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      const i = queue.indexOf(grant);
      if (i >= 0) queue.splice(i, 1);
      reject(cancelled());
    };
    queue.push(grant);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Hands the permit straight to the next waiter, or frees it. */
function release(key: string): void {
  const lane = lanes.get(key);
  if (!lane) return;
  const next = lane.waiting.shift();
  if (next) return next();
  if (--lane.active === 0) lanes.delete(key);
}

async function withPermit<T>(key: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  await acquire(key, signal);
  try {
    return await fn();
  } finally {
    release(key);
  }
}

/** Delay before retrying a 429/503, or undefined when the vendor asks for longer than we are willing to wait. */
function retryDelayMs(res: Response, attempt: number): number | undefined {
  const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    const ms = retryAfter * 1000;
    return ms <= MAX_RETRY_DELAY_MS ? ms : undefined;
  }
  return Math.min(retryBaseMs() * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

// ---- request ----------------------------------------------------------------

export async function founduGet(creds: FounduCredentials, req: FounduRequest): Promise<unknown> {
  const token = validateAccessToken(creds.accessToken);
  const url = buildUrl(req.path, req.query);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'user-agent': `foundu-mcp/${VERSION}`,
  };

  const signal = requestSignal();
  for (let attempt = 0; ; attempt++) {
    const outcome = await withPermit(token, signal, async (): Promise<{ value: unknown } | { retryInMs: number }> => {
      const res = await send(url, headers, signal);
      const retryInMs = (res.status === 429 || res.status === 503) && attempt < MAX_RETRIES ? retryDelayMs(res, attempt) : undefined;
      if (retryInMs === undefined) return { value: await readResult(res, req.path) };
      await res.body?.cancel().catch(() => undefined);
      return { retryInMs };
    });
    if ('value' in outcome) return outcome.value;
    // Back off without holding a permit, so other calls on this token keep moving.
    await sleep(outcome.retryInMs, undefined, { signal }).catch(() => {
      throw cancelled();
    });
  }
}

async function send(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { method: 'GET', headers, redirect: 'manual', signal });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw aborted ? cancelled() : new FounduApiError('Could not reach the foundU API (network error).');
  }
}

async function readResult(res: Response, path: string): Promise<unknown> {
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    await res.body?.cancel().catch(() => undefined);
    const toLogin = /\/login\b/.test(res.headers.get('location') ?? '');
    const hint = toLogin ? ' foundU sends unauthenticated requests to its login page: the access token is missing, expired, or revoked.' : '';
    throw new FounduApiError(`foundU API answered GET ${path} with a redirect (HTTP ${res.status}); refusing to follow it.${hint}`, res.status);
  }
  if (!res.ok) throw await vendorError(res);

  const text = await readBoundedText(res, maxUpstreamBytes());
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FounduApiError(`foundU API returned a non-JSON body for GET ${path}.`, res.status);
  }
}

const MAX_VENDOR_MESSAGE = 1000;
const REQUEST_ID_HEADERS = ['x-request-id', 'request-id', 'x-correlation-id'];

/** Laravel validation errors: `{ field: ["message", ...] }` -> "field: message; ...". */
function flattenErrors(errors: unknown): string | undefined {
  if (!errors || typeof errors !== 'object' || Array.isArray(errors)) return undefined;
  const parts = Object.entries(errors as Record<string, unknown>).map(([field, msgs]) => {
    const list = Array.isArray(msgs) ? msgs.filter((m) => typeof m === 'string') : typeof msgs === 'string' ? [msgs] : [];
    return `${field}: ${list.join(' ')}`;
  });
  return parts.length ? parts.join('; ') : undefined;
}

async function vendorError(res: Response): Promise<FounduApiError> {
  const body = await readBoundedText(res, 64 * 1024).catch(() => '');
  let type: string | undefined;
  let message: string | undefined;
  let details: string | undefined;
  let requestId: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown; errors?: unknown; request_id?: unknown };
    if (typeof parsed.error === 'string') type = parsed.error;
    if (typeof parsed.message === 'string') message = parsed.message;
    details = flattenErrors(parsed.errors);
    if (typeof parsed.request_id === 'string') requestId = parsed.request_id;
  } catch {
    // Non-JSON bodies are usually HTML error pages; the status and hint carry the meaning.
    const trimmed = body.trim();
    message = trimmed && !trimmed.startsWith('<') ? trimmed : undefined;
  }
  for (const header of REQUEST_ID_HEADERS) requestId ??= res.headers.get(header) ?? undefined;

  const status = res.status;
  const hint =
    status === 401
      ? ': the access token is invalid, expired, or revoked (the gateway refreshes it; reconnect foundU if this persists)'
      : status === 403
        ? ': the integration lacks permission for this area (check its permission areas and search restrictions in the foundU Integration Centre)'
        : status === 404
          ? ': resource not found'
          : status === 422
            ? ': foundU rejected the request parameters'
            : status === 429
              ? ': rate limited'
              : '';
  const retryAfter = status === 429 || status === 503 ? Number.parseInt(res.headers.get('retry-after') ?? '', 10) : Number.NaN;
  const parts = [
    `foundU API error (HTTP ${status}${type ? ` ${type}` : ''})${hint}.`,
    message ? message.slice(0, MAX_VENDOR_MESSAGE) : undefined,
    details ? details.slice(0, MAX_VENDOR_MESSAGE) : undefined,
    Number.isFinite(retryAfter) ? `Retry after ${retryAfter}s.` : undefined,
    requestId ? `(request_id: ${requestId})` : undefined,
  ];
  return new FounduApiError(parts.filter(Boolean).join(' '), status, requestId);
}

/** Reads a response body as text, cancelling the stream as soon as it exceeds maxBytes. */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new FounduApiError(`foundU API response exceeded ${maxBytes} bytes; narrow the query with limit or a shorter date range.`);
  const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw aborted ? cancelled() : new FounduApiError('The foundU API connection failed while reading the response.', res.status);
    }
    const { done, value } = chunk;
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
