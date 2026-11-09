import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { buildUrl, resolveCredentials, runWithCredentials } from '../client.js';
import { ALL_TIERS, lockGatewayMode, resetGatewayLock } from '../config.js';
import { createServer } from '../server.js';
import { buildToolset, getDefaultToolset } from '../tools/index.js';
import { logger } from '../utils/logger.js';
import { VERSION } from '../version.js';
import {
  always,
  FAKE_ENV_TOKEN,
  FAKE_TOKEN,
  FAKE_TOKEN_B,
  jsonResponse,
  mockFoundu,
  sequence,
  textOf,
  READ_TOOL_COUNT,
  TOOL_COUNT,
  vendorError,
} from './helpers.js';

const PROBE = 'foundu_states_list';
const JWT_LIKE = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLW5vdC1yZWFsLTEyMzQ1Ng';

let logSpy: MockInstance<typeof console.error>;
const logged = () => logSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n');

beforeEach(() => {
  process.env.FOUNDU_ACCESS_TOKEN = FAKE_TOKEN;
  process.env.LOG_LEVEL = 'debug';
  logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  logSpy.mockRestore();
  resetGatewayLock();
  for (const k of ['FOUNDU_ACCESS_TOKEN', 'AUTH_MODE', 'FOUNDU_MAX_CONCURRENCY', 'FOUNDU_REQUEST_TIMEOUT_MS']) delete process.env[k];
  process.env.FOUNDU_RETRY_BASE_MS = '1';
  process.env.LOG_LEVEL = 'error';
});

/** Minimal valid arguments for a tool: its required fields, plus any cross-field rule. */
function minimalArgs(name: string, required: readonly string[]): Record<string, unknown> {
  const sample: Record<string, unknown> = { duration: 'last_month', group_by: ['month'] };
  const extra = name === 'foundu_labour_management_report' ? { duration_specific_date: '2026-11-01' } : {};
  return { ...Object.fromEntries(required.map((k) => [k, sample[k] ?? 1])), ...extra };
}

describe('upstream request contract', () => {
  it('sends exactly Authorization: Bearer, accept, user-agent; GET with redirect: manual', async () => {
    const { calls } = mockFoundu([always(() => jsonResponse({ '*': [{ state: 'QLD', state_id: 4 }] }))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].url.href).toBe('https://api.foundu.com.au/api/v1/state');
    expect(calls[0].headers).toEqual({
      authorization: `Bearer ${FAKE_TOKEN}`,
      accept: 'application/json',
      'user-agent': `foundu-mcp/${VERSION}`,
    });
    expect(calls[0].redirect).toBe('manual');
  });

  it('every tool calls only https://api.foundu.com.au with GET and the bearer token', async () => {
    const { calls } = mockFoundu([always(() => jsonResponse({ data: [] }))]);
    const ts = buildToolset(new Set(ALL_TIERS));
    for (const tool of ts.tools) {
      const res = await ts.dispatch(tool.name, minimalArgs(tool.name, tool.inputSchema.required ?? []));
      expect(res.isError, `${tool.name}: ${textOf(res)}`).toBeFalsy();
    }
    expect(calls).toHaveLength(TOOL_COUNT);
    for (const c of calls) {
      expect(c.url.origin).toBe('https://api.foundu.com.au');
      expect(c.method).toBe('GET');
      expect(c.redirect).toBe('manual');
      expect(c.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    }
  });

  it('buildUrl refuses anything that leaves the fixed origin or the exact path', () => {
    expect(() => buildUrl('//evil.example.net/x')).toThrow(/outside the foundU API/);
    expect(() => buildUrl('/api/v1/../../x')).toThrow(/outside the foundU API/);
    expect(buildUrl('/api/v1/state', [['limit', '5']]).href).toBe('https://api.foundu.com.au/api/v1/state?limit=5');
  });
});

describe('access token validation', () => {
  it.each([
    ['Bearer prefix', `Bearer ${FAKE_TOKEN}`, /without the "Bearer " prefix/],
    ['header injection', 'tok\r\nX-Injected: 1', /invalid characters/],
    ['embedded space', 'tok en', /invalid characters/],
    ['oversized', 'x'.repeat(9000), /too long/],
  ])('rejects a token with %s without calling upstream', async (_label, token, why) => {
    process.env.FOUNDU_ACCESS_TOKEN = token;
    const { calls } = mockFoundu([always(() => jsonResponse({}))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(why);
    expect(textOf(res)).not.toContain('X-Injected');
    expect(calls).toHaveLength(0);
  });

  it('reports a missing token clearly in stdio mode', async () => {
    delete process.env.FOUNDU_ACCESS_TOKEN;
    const { calls } = mockFoundu();
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/FOUNDU_ACCESS_TOKEN/);
    expect(calls).toHaveLength(0);
  });
});

describe('redirects', () => {
  it.each([301, 302, 303, 307, 308])('refuses HTTP %i and never follows Location', async (status) => {
    const { calls } = mockFoundu([always(() => new Response(null, { status, headers: { location: 'https://evil.example.net/steal' } }))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(new RegExp(`redirect \\(HTTP ${status}\\)`));
    expect(calls).toHaveLength(1);
    expect(calls[0].url.hostname).toBe('api.foundu.com.au');
  });

  it('explains the 302-to-login that foundU sends for a bad or expired token', async () => {
    mockFoundu([always(() => new Response('<html>login</html>', { status: 302, headers: { location: 'https://api.foundu.com.au/login' } }))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(textOf(res)).toMatch(/access token is missing, expired, or revoked/);
  });
});

describe('error mapping', () => {
  it.each([
    [401, /HTTP 401/, /expired, or revoked/],
    [403, /HTTP 403/, /lacks permission/],
    [404, /HTTP 404/, /not found/i],
    [422, /HTTP 422/, /rejected the request parameters/],
    [500, /HTTP 500/, /Upstream says/],
  ])('HTTP %i surfaces status, vendor message and request_id', async (status, statusRe, hintRe) => {
    mockFoundu([always(() => vendorError(status, `Upstream says ${status}`, `req_${status}_abc`))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(statusRe);
    expect(text).toMatch(hintRe);
    expect(text).toContain(`Upstream says ${status}`);
    expect(text).toContain(`request_id: req_${status}_abc`);
  });

  it('flattens Laravel validation errors and reads a request_id from the body', async () => {
    mockFoundu([
      always(() => jsonResponse({ message: 'The given data was invalid.', errors: { duration: ['The duration field is required.'] }, request_id: 'body_req_9' }, 422)),
    ]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(textOf(res)).toContain('duration: The duration field is required.');
    expect(textOf(res)).toContain('request_id: body_req_9');
  });

  it('keeps the OAuth error type (e.g. invalid_client) in the message', async () => {
    mockFoundu([always(() => jsonResponse({ error: 'invalid_client', message: 'Client ID not supplied' }, 401))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(textOf(res)).toMatch(/HTTP 401 invalid_client/);
  });

  it('handles an HTML error page without echoing it', async () => {
    mockFoundu([always(() => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'x-request-id': 'req_hdr_1' } }))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/HTTP 502/);
    expect(textOf(res)).not.toContain('<html>');
    expect(textOf(res)).toContain('request_id: req_hdr_1');
  });

  it('maps a network failure to a clear error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/could not reach/i);
  });

  it('rejects a non-JSON success body', async () => {
    mockFoundu([always(() => new Response('<html>ok</html>', { status: 200 }))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/non-JSON/);
  });

  it('refuses a body over the upstream byte cap', async () => {
    process.env.FOUNDU_MAX_UPSTREAM_BYTES = '1024';
    try {
      mockFoundu([always(() => jsonResponse({ data: ['x'.repeat(4096)] }))]);
      const res = await getDefaultToolset().dispatch(PROBE, {});
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/exceeded 1024 bytes/);
    } finally {
      delete process.env.FOUNDU_MAX_UPSTREAM_BYTES;
    }
  });
});

describe('throttling and backoff', () => {
  it('retries a 429 that asks for a short wait, then succeeds', async () => {
    const { calls } = mockFoundu([
      sequence(
        () => jsonResponse({ message: 'Too Many Attempts.' }, 429, { 'retry-after': '0' }),
        () => jsonResponse({ '*': [] }),
      ),
    ]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(calls).toHaveLength(2);
  });

  it('does not wait out a long Retry-After; it surfaces it', async () => {
    const { calls } = mockFoundu([always(() => jsonResponse({ message: 'Too Many Attempts.' }, 429, { 'retry-after': '17' }))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/rate limited/);
    expect(textOf(res)).toMatch(/Retry after 17s/);
    expect(calls).toHaveLength(1);
  });

  it('gives up on a persistent 503 after two retries', async () => {
    const { calls } = mockFoundu([always(() => vendorError(503, 'maintenance'))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/HTTP 503/);
    expect(calls).toHaveLength(3);
  });

  it('never retries other errors', async () => {
    const { calls } = mockFoundu([always(() => vendorError(500, 'boom'))]);
    await getDefaultToolset().dispatch(PROBE, {});
    expect(calls).toHaveLength(1);
  });

  it('caps concurrent upstream calls at FOUNDU_MAX_CONCURRENCY', async () => {
    process.env.FOUNDU_MAX_CONCURRENCY = '2';
    let active = 0;
    let peak = 0;
    mockFoundu([
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return jsonResponse({ '*': [] });
      },
    ]);
    const results = await Promise.all(Array.from({ length: 6 }, () => getDefaultToolset().dispatch(PROBE, {})));
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(peak).toBe(2);
  });
});

describe('throttling is per tenant and bounded in time', () => {
  /** A promise plus its resolver, used to hold upstream responses until the test releases them. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
  }
  const asTenant = (token: string, name = PROBE, signal?: AbortSignal) =>
    runWithCredentials({ accessToken: token }, () => getDefaultToolset().dispatch(name, {}, signal));
  const within = <T>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms))]);

  it("one tenant's saturated permits never delay another tenant", async () => {
    process.env.FOUNDU_MAX_CONCURRENCY = '2';
    const slowA = gate();
    const { calls } = mockFoundu([
      async (call) => {
        if (call.headers.authorization === `Bearer ${FAKE_TOKEN}`) await slowA.opened;
        return jsonResponse({ '*': [] });
      },
    ]);
    const tenantA = Array.from({ length: 6 }, () => asTenant(FAKE_TOKEN));
    const tenantB = await within(asTenant(FAKE_TOKEN_B), 1000);
    expect(tenantB).not.toBe('timeout');
    expect((tenantB as { isError?: boolean }).isError).toBeFalsy();
    slowA.open();
    expect((await Promise.all(tenantA)).every((r) => !r.isError)).toBe(true);
    expect(calls).toHaveLength(7);
  });

  it('time waiting for a permit counts against FOUNDU_REQUEST_TIMEOUT_MS', async () => {
    process.env.FOUNDU_MAX_CONCURRENCY = '1';
    process.env.FOUNDU_REQUEST_TIMEOUT_MS = '50';
    const held = gate();
    const { calls } = mockFoundu([
      async () => {
        await held.opened;
        return jsonResponse({ '*': [] });
      },
    ]);
    const first = asTenant(FAKE_TOKEN);
    const queued = await within(asTenant(FAKE_TOKEN), 1000);
    expect(queued).not.toBe('timeout');
    expect((queued as { isError?: boolean }).isError).toBe(true);
    expect(textOf(queued as Awaited<typeof first>)).toMatch(/timed out or was cancelled/);
    expect(calls).toHaveLength(1);
    held.open();
    await first;
  });

  it('a cancelled caller leaves the queue at once and never reaches foundU', async () => {
    process.env.FOUNDU_MAX_CONCURRENCY = '1';
    const held = gate();
    const { calls } = mockFoundu([
      async () => {
        await held.opened;
        return jsonResponse({ '*': [] });
      },
    ]);
    const first = asTenant(FAKE_TOKEN);
    const controller = new AbortController();
    const queued = asTenant(FAKE_TOKEN, PROBE, controller.signal);
    controller.abort();
    const result = await within(queued, 200);
    expect(result).not.toBe('timeout');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(1);
    held.open();
    expect((await first).isError).toBeFalsy();
  });

  it('a call backing off after 429 does not hold its permit while it sleeps', async () => {
    process.env.FOUNDU_MAX_CONCURRENCY = '1';
    process.env.FOUNDU_RETRY_BASE_MS = '300';
    const finished: string[] = [];
    mockFoundu([
      sequence(
        () => jsonResponse({ message: 'Too Many Attempts.' }, 429),
        () => jsonResponse({ '*': [] }),
      ),
    ]);
    const backingOff = asTenant(FAKE_TOKEN, PROBE).then((r) => (finished.push('backing-off'), r));
    await new Promise((r) => setTimeout(r, 20));
    const other = asTenant(FAKE_TOKEN, 'foundu_positions_list').then((r) => (finished.push('other'), r));
    const results = await Promise.all([backingOff, other]);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(finished).toEqual(['other', 'backing-off']);
  });
});

describe('the access token never leaks', () => {
  it('is redacted when the vendor echoes it in an error message, and absent from logs', async () => {
    mockFoundu([always(() => vendorError(401, `Unauthenticated token ${FAKE_TOKEN}`))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain(FAKE_TOKEN);
    expect(textOf(res)).toContain('[REDACTED]');
    expect(logged()).not.toContain(FAKE_TOKEN);
  });

  it('is redacted from successful output that happens to contain it', async () => {
    mockFoundu([always(() => jsonResponse({ note: `key=${FAKE_TOKEN}`, jwt: JWT_LIKE }))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(textOf(res)).not.toContain(FAKE_TOKEN);
    expect(textOf(res)).not.toContain(JWT_LIKE);
  });

  it('a gateway (header) token is redacted from errors and logs too', async () => {
    lockGatewayMode();
    delete process.env.FOUNDU_ACCESS_TOKEN;
    mockFoundu([always(() => vendorError(500, `boom ${JWT_LIKE}`))]);
    const res = await runWithCredentials({ accessToken: JWT_LIKE }, () => getDefaultToolset().dispatch(PROBE, {}));
    expect(textOf(res)).not.toContain(JWT_LIKE);
    expect(logged()).not.toContain(JWT_LIKE);
  });

  it('the logger redacts the per-request gateway token by exact match, whatever its shape', () => {
    const SHORT_GATEWAY_TOKEN = 'gw-tok-9';
    lockGatewayMode();
    delete process.env.FOUNDU_ACCESS_TOKEN;
    runWithCredentials({ accessToken: SHORT_GATEWAY_TOKEN }, () => {
      logger.warn(`message with ${SHORT_GATEWAY_TOKEN}`, { echoed: SHORT_GATEWAY_TOKEN });
    });
    expect(logSpy).toHaveBeenCalled();
    expect(logged()).not.toContain(SHORT_GATEWAY_TOKEN);
    expect(logged()).toContain('[REDACTED]');
  });

  it('a one-time integration key in an auth_token query string is redacted from text', async () => {
    mockFoundu([always(() => vendorError(500, 'GET /init/integration?auth_token=abc123secret failed'))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(textOf(res)).not.toContain('abc123secret');
  });

  it('an unexpected internal error never echoes raw error text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`socket closed for ${FAKE_TOKEN}`); }));
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain(FAKE_TOKEN);
    expect(logged()).not.toContain(FAKE_TOKEN);
  });

  it('nothing logged during a full successful call contains the token', async () => {
    mockFoundu([always(() => jsonResponse({ '*': [] }))]);
    await getDefaultToolset().dispatch(PROBE, {});
    expect(logSpy).toHaveBeenCalled();
    expect(logged()).not.toContain(FAKE_TOKEN);
  });
});

describe('credential source', () => {
  it('stdio/env mode reads FOUNDU_ACCESS_TOKEN', () => {
    expect(resolveCredentials()).toEqual({ accessToken: FAKE_TOKEN });
  });

  it('gateway mode never falls back to the environment', async () => {
    process.env.FOUNDU_ACCESS_TOKEN = FAKE_ENV_TOKEN;
    process.env.AUTH_MODE = 'gateway';
    expect(() => resolveCredentials()).toThrow(/X-FoundU-Access-Token/);
    const { calls } = mockFoundu([always(() => jsonResponse({}))]);
    const res = await getDefaultToolset().dispatch(PROBE, {});
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('gateway mode uses the per-request token, not env', async () => {
    process.env.FOUNDU_ACCESS_TOKEN = FAKE_ENV_TOKEN;
    lockGatewayMode();
    const { calls } = mockFoundu([always(() => jsonResponse({ '*': [] }))]);
    const res = await runWithCredentials({ accessToken: FAKE_TOKEN }, () => getDefaultToolset().dispatch(PROBE, {}));
    expect(res.isError).toBeFalsy();
    expect(calls[0].headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });
});

describe('end to end over MCP (mocked upstream)', () => {
  it(`tools/list returns ${READ_TOOL_COUNT} read-only tools and tools/call round-trips a read`, async () => {
    const { calls } = mockFoundu([
      (call) =>
        call.url.pathname === '/api/v2/roster-branches'
          ? jsonResponse({ data: [{ id: 278, title: 'Night shift', status: 'Approved', client_id: 120 }], included: {} })
          : undefined,
    ]);
    const server = createServer(getDefaultToolset());
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(READ_TOOL_COUNT);
      expect(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)).toBe(true);

      const result = (await client.callTool({ name: 'foundu_rosters_list', arguments: { filter_status: 'Approved', limit: 1 } })) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        data: [{ id: 278, title: 'Night shift', status: 'Approved', client_id: 120 }],
        included: {},
        possibly_truncated: true,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].url.search).toBe('?filter_status=Approved&limit=1');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
