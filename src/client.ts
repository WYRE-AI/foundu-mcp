import {
  FounduError,
  NOT_AUTHORIZED_PARTNER_MESSAGE,
} from './errors.js';
import type { FounduCredentials } from './credentials.js';
import {
  assertAggregateQuery,
  canonicalizeAggregatePath,
  redactSensitive,
  validateAuBaseUrl,
  type RedactionResult,
} from './scope.js';
import { VERSION } from './version.js';

const MAX_BODY_CHARS = 1_000_000;

export interface FounduClient {
  getAggregate(path: string, query?: Record<string, string>): Promise<RedactionResult>;
}

export interface FounduClientOptions {
  fetchImpl?: typeof fetch;
}

export function createFounduClient(
  credentials: FounduCredentials,
  options: FounduClientOptions = {},
): FounduClient {
  return {
    async getAggregate(path: string, query?: Record<string, string>): Promise<RedactionResult> {
      const fetchImpl = options.fetchImpl ?? globalThis.fetch;
      const canonical = canonicalizeAggregatePath(path);
      const safeQuery = assertAggregateQuery(query);
      const origin = validateAuBaseUrl(credentials.baseUrl);
      const url = new URL(canonical, origin.origin);
      if (url.origin !== origin.origin) {
        throw new FounduError('not_authorized', 'Refused a request that left the configured FoundU origin.');
      }
      for (const [key, value] of Object.entries(safeQuery)) {
        url.searchParams.append(key, value);
      }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${credentials.apiToken}`,
            Accept: 'application/json',
            'User-Agent': `wyre-foundu-mcp/${VERSION}`,
          },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new FounduError(
          'upstream_error',
          'FoundU partner API request failed before a response was received.',
        );
      }

      if (response.status >= 300 && response.status < 400) {
        throw new FounduError(
          'not_authorized',
          'FoundU partner API redirected the request. Redirects are refused so the API token stays on the Australian foundu.com.au host.',
        );
      }

      if (response.status === 401 || response.status === 403) {
        throw new FounduError('not_authorized', NOT_AUTHORIZED_PARTNER_MESSAGE);
      }

      if (response.status === 204) {
        return { data: null, redactedFields: [] };
      }

      if (!response.ok) {
        throw new FounduError(
          'upstream_error',
          `FoundU partner API request failed (HTTP ${response.status}).`,
        );
      }

      const text = await response.text();
      if (text.length > MAX_BODY_CHARS) {
        throw new FounduError(
          'not_authorized',
          'FoundU response exceeded the aggregate size limit and was discarded.',
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (text.length > 0 && !contentType.toLowerCase().includes('json')) {
        throw new FounduError(
          'upstream_error',
          'FoundU partner API returned a non-JSON payload for an aggregate request.',
        );
      }

      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          throw new FounduError('upstream_error', 'FoundU partner API returned invalid JSON.');
        }
      }

      return redactSensitive(parsed);
    },
  };
}
