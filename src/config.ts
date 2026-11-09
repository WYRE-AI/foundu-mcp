/**
 * Every tool in this server is read-only. `read` is the default surface.
 * `admin` holds the two reports whose output includes per-employee pay
 * figures (labour management, timesheet analysis); it is off unless
 * FOUNDU_TOOL_TIERS names it. The tier machinery is kept identical to the
 * rest of the fleet so Conduit's X-Conduit-Tool-Tiers contract behaves the
 * same here.
 */
export type ToolTier = 'read' | 'admin';

export const ALL_TIERS: readonly ToolTier[] = ['read', 'admin'];

export const DEFAULT_TIERS: readonly ToolTier[] = ['read'];

/** Env var holding the access token for stdio and AUTH_MODE=env. Never read in gateway mode. */
export const ACCESS_TOKEN_ENV = 'FOUNDU_ACCESS_TOKEN';

/** Env var naming the enabled tool tiers. */
export const TOOL_TIERS_ENV = 'FOUNDU_TOOL_TIERS';

/**
 * Parses FOUNDU_TOOL_TIERS. Unset or blank means DEFAULT_TIERS. An unknown
 * value throws so a typo fails loudly at startup.
 */
export function parseToolTiers(raw: string | undefined): ReadonlySet<ToolTier> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return new Set(DEFAULT_TIERS);
  const tiers = new Set<ToolTier>();
  for (const part of trimmed.split(',')) {
    const value = part.trim().toLowerCase();
    if (!value) continue;
    if (!(ALL_TIERS as readonly string[]).includes(value)) {
      throw new Error(`Invalid ${TOOL_TIERS_ENV} entry "${value}". Allowed: ${ALL_TIERS.join(', ')}.`);
    }
    tiers.add(value as ToolTier);
  }
  if (tiers.size === 0) return new Set(DEFAULT_TIERS);
  return tiers;
}

function positiveInt(raw: string | undefined, fallback: number, max: number, min = 1): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

export const MAX_BODY_BYTES = 1024 * 1024;

/** Deadline for one whole upstream call: waiting for a permit, every attempt, and any backoff. */
export function requestTimeoutMs(): number {
  return positiveInt(process.env.FOUNDU_REQUEST_TIMEOUT_MS, 30_000, 120_000);
}

export function maxResponseChars(): number {
  return positiveInt(process.env.FOUNDU_MAX_RESPONSE_CHARS, 60_000, 1_000_000);
}

/** Upper bound on any upstream response body, enforced while streaming and before parsing, redaction, or truncation. */
export function maxUpstreamBytes(): number {
  return positiveInt(process.env.FOUNDU_MAX_UPSTREAM_BYTES, 4 * 1024 * 1024, 128 * 1024 * 1024);
}

/** foundU publishes no rate limits, so upstream calls are throttled conservatively per access token (per tenant). */
export function maxConcurrency(): number {
  return positiveInt(process.env.FOUNDU_MAX_CONCURRENCY, 4, 32);
}

/** Base delay for the exponential backoff on 429/503 when foundU sends no Retry-After. */
export function retryBaseMs(): number {
  return positiveInt(process.env.FOUNDU_RETRY_BASE_MS, 500, 10_000, 0);
}

/** Retries per upstream call on 429/503. A Retry-After longer than MAX_RETRY_DELAY_MS is surfaced, not waited out. */
export const MAX_RETRIES = 2;
export const MAX_RETRY_DELAY_MS = 5_000;

export type AuthMode = 'gateway' | 'env';

/**
 * The single AUTH_MODE parser (trimmed, case-insensitive). Unset or blank is
 * `env`; anything else unknown throws. Every caller must go through this so
 * the startup check and the per-request credential path can never disagree.
 */
export function parseAuthMode(raw: string | undefined): AuthMode {
  const value = (raw ?? '').trim().toLowerCase() || 'env';
  if (value !== 'gateway' && value !== 'env') {
    throw new Error(`AUTH_MODE must be "gateway" or "env" (got "${(raw ?? '').trim()}").`);
  }
  return value;
}

let gatewayLocked = false;

/** Called once the HTTP server starts in gateway mode. Irreversible for the process lifetime. */
export function lockGatewayMode(): void {
  gatewayLocked = true;
}

/** Test-only. */
export function resetGatewayLock(): void {
  gatewayLocked = false;
}

/** Fails closed: an unparseable AUTH_MODE counts as gateway, so env credentials are never used by mistake. */
export function isGatewayMode(): boolean {
  if (gatewayLocked) return true;
  try {
    return parseAuthMode(process.env.AUTH_MODE) === 'gateway';
  } catch {
    return true;
  }
}

/** Header Conduit may send to narrow (never widen) the enabled tiers for one request. */
export const TOOL_TIERS_HEADER = 'x-conduit-tool-tiers';

/**
 * Intersects the configured tiers with a per-request tier header. Unknown or
 * not-configured entries are dropped, so the header can only remove tiers.
 * A present header that names no configured tier (including an empty one)
 * yields an empty set (no tools), not the configured default.
 */
export function narrowTiers(configured: ReadonlySet<ToolTier>, header: string | undefined): ReadonlySet<ToolTier> {
  if (header === undefined) return configured;
  const requested = new Set(
    header
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
  );
  return new Set(ALL_TIERS.filter((t) => configured.has(t) && requested.has(t)));
}
