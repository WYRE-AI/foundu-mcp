import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCredentials } from '../client.js';
import { isGatewayMode, resetGatewayLock } from '../config.js';
import { resolveHttpConfig, s2sSecretProblem, startHttpServer, StartupError, type HttpConfig } from '../http.js';
import { resetToolsets } from '../tools/index.js';
import { FAKE_ENV_TOKEN, FAKE_S2S_SECRET, FAKE_TOKEN, jsonResponse, READ_TOOL_COUNT, TOOL_COUNT } from './helpers.js';

const ENV_KEYS = [
  'AUTH_MODE',
  'CONDUIT_S2S_SECRET',
  'MCP_ALLOW_INSECURE_DEV',
  'MCP_HTTP_HOST',
  'MCP_HTTP_PORT',
  'MCP_ALLOWED_HOSTS',
  'FOUNDU_ACCESS_TOKEN',
  'FOUNDU_TOOL_TIERS',
];
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
const servers: Server[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(async () => {
  vi.unstubAllGlobals();
  resetGatewayLock();
  resetToolsets();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function mint(secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`t=${t}`).digest('hex')}`;
}

async function listen(overrides: Partial<HttpConfig> = {}): Promise<number> {
  const config: HttpConfig = { s2sSecret: FAKE_S2S_SECRET, host: '127.0.0.1', port: 0, authMode: 'gateway', allowedHosts: null, ...overrides };
  const server = await startHttpServer(config);
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

const listTools = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const callStates = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'foundu_states_list', arguments: {} } });

const gatewayHeaders = { 'x-foundu-access-token': FAKE_TOKEN };

function post(port: number, body: string, headers: Record<string, string> = {}, path = '/mcp') {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body,
  });
}

/** Loopback traffic goes to the real fetch (the server under test); foundU traffic is recorded and mocked. */
function stubFounduOnly() {
  const upstream: Array<{ path: string; authorization: string | null }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === '127.0.0.1') return realFetch(input, init);
      upstream.push({ path: url.pathname, authorization: new Headers(init?.headers).get('authorization') });
      return jsonResponse({ '*': [{ state: 'QLD', state_id: 4 }] });
    }),
  );
  return upstream;
}

type RpcResult = { result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } };

describe('resolveHttpConfig (startup fails closed)', () => {
  it('refuses an empty S2S secret (the container default)', () => {
    // Mirrors the Dockerfile ENV with no CONDUIT_S2S_SECRET supplied.
    expect(() =>
      resolveHttpConfig({ MCP_TRANSPORT: 'http', MCP_HTTP_PORT: '8080', MCP_HTTP_HOST: '0.0.0.0', AUTH_MODE: 'gateway', FOUNDU_TOOL_TIERS: 'read' }),
    ).toThrow(/CONDUIT_S2S_SECRET is empty/);
  });

  it.each([
    ['changeme', /placeholder/],
    ['replace-with-a-real-secret-0123456789abcdef', /placeholder/],
    ['unknown', /shorter than 32/],
    ['short-but-random-Xy7', /shorter than 32/],
    ['a'.repeat(64), /repeated/],
    ['abcd'.repeat(10), /repeated/],
  ])('refuses weak secret %j', (secret, why) => {
    expect(s2sSecretProblem(secret)).toMatch(why);
    expect(() => resolveHttpConfig({ CONDUIT_S2S_SECRET: secret, AUTH_MODE: 'gateway' })).toThrow(StartupError);
  });

  it('accepts a strong secret and defaults to 127.0.0.1:8080', () => {
    expect(resolveHttpConfig({ CONDUIT_S2S_SECRET: FAKE_S2S_SECRET, AUTH_MODE: 'gateway' })).toMatchObject({
      host: '127.0.0.1',
      port: 8080,
      authMode: 'gateway',
      allowedHosts: null,
    });
  });

  it('insecure dev mode always binds loopback and still refuses a placeholder', () => {
    expect(resolveHttpConfig({ MCP_ALLOW_INSECURE_DEV: '1', MCP_HTTP_HOST: '0.0.0.0', AUTH_MODE: 'gateway' })).toMatchObject({ host: '127.0.0.1', s2sSecret: '' });
    expect(() => resolveHttpConfig({ MCP_ALLOW_INSECURE_DEV: '1', CONDUIT_S2S_SECRET: 'changeme' })).toThrow(StartupError);
  });

  it('env mode requires a usable token in FOUNDU_ACCESS_TOKEN', () => {
    const base = { CONDUIT_S2S_SECRET: FAKE_S2S_SECRET, AUTH_MODE: 'env' };
    expect(() => resolveHttpConfig(base)).toThrow(/FOUNDU_ACCESS_TOKEN/);
    expect(() => resolveHttpConfig({ ...base, FOUNDU_ACCESS_TOKEN: `Bearer ${FAKE_TOKEN}` })).toThrow(/Bearer/);
    expect(() => resolveHttpConfig({ ...base, FOUNDU_ACCESS_TOKEN: FAKE_TOKEN })).not.toThrow();
  });

  it('a startup error never echoes the token', () => {
    try {
      resolveHttpConfig({ CONDUIT_S2S_SECRET: FAKE_S2S_SECRET, AUTH_MODE: 'env', FOUNDU_ACCESS_TOKEN: `${FAKE_TOKEN} x` });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(FAKE_TOKEN);
    }
  });

  it('rejects unknown AUTH_MODE', () => {
    expect(() => resolveHttpConfig({ CONDUIT_S2S_SECRET: FAKE_S2S_SECRET, AUTH_MODE: 'gatway' })).toThrow(/AUTH_MODE/);
  });

  it.each([' gateway', 'GATEWAY', '\tGateway\n'])('padded/cased AUTH_MODE %j is gateway at startup and per request', (raw) => {
    expect(resolveHttpConfig({ CONDUIT_S2S_SECRET: FAKE_S2S_SECRET, AUTH_MODE: raw }).authMode).toBe('gateway');
    process.env.AUTH_MODE = raw;
    process.env.FOUNDU_ACCESS_TOKEN = FAKE_ENV_TOKEN;
    expect(isGatewayMode()).toBe(true);
    expect(() => resolveCredentials()).toThrow(/X-FoundU-Access-Token/);
  });

  it('an unparseable AUTH_MODE at request time fails closed (treated as gateway)', () => {
    process.env.AUTH_MODE = 'gatway';
    process.env.FOUNDU_ACCESS_TOKEN = FAKE_ENV_TOKEN;
    expect(() => resolveCredentials()).toThrow(/X-FoundU-Access-Token/);
  });
});

describe('HTTP transport', () => {
  it('/health is open and reveals no credentials', async () => {
    const port = await listen();
    const res = await realFetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ status: 'ok', mode: 'gateway' });
    expect(body).not.toContain(FAKE_TOKEN);
  });

  it('rejects /mcp without a valid S2S header', async () => {
    const port = await listen();
    expect((await post(port, listTools, gatewayHeaders)).status).toBe(401);
    expect((await post(port, listTools, { ...gatewayHeaders, 'x-gateway-s2s': mint('wrong-secret-wrong-secret-wrong-secret') })).status).toBe(401);
    expect((await post(port, listTools, { ...gatewayHeaders, 'x-gateway-s2s': mint(FAKE_S2S_SECRET, Math.floor(Date.now() / 1000) - 3600) })).status).toBe(401);
  });

  it('enforces MCP_ALLOWED_HOSTS', async () => {
    const port = await listen({ allowedHosts: new Set(['foundu-mcp.internal']) });
    expect((await post(port, listTools, { ...gatewayHeaders, 'x-gateway-s2s': mint(FAKE_S2S_SECRET) })).status).toBe(403);
  });

  it('rejects bodies over 1 MiB with 413', async () => {
    const port = await listen();
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(1024 * 1024) } });
    // The server answers 413 and drops the socket; the client may see the 413 or an EPIPE/reset mid-upload.
    const outcome = await post(port, big, { ...gatewayHeaders, 'x-gateway-s2s': mint(FAKE_S2S_SECRET) }).then(
      (res) => res.status,
      (err: Error & { cause?: { code?: string } }) => err.cause?.code,
    );
    expect([413, 'EPIPE', 'ECONNRESET']).toContain(outcome);
  });

  it('rejects non-POST methods', async () => {
    const port = await listen();
    const res = await realFetch(`http://127.0.0.1:${port}/mcp`, { method: 'GET', headers: { 'x-gateway-s2s': mint(FAKE_S2S_SECRET) } });
    expect(res.status).toBe(405);
  });

  it('gateway mode requires X-FoundU-Access-Token even when FOUNDU_ACCESS_TOKEN is set', async () => {
    process.env.FOUNDU_ACCESS_TOKEN = FAKE_ENV_TOKEN;
    const upstream = stubFounduOnly();
    const port = await listen();
    const res = await post(port, callStates, { 'x-gateway-s2s': mint(FAKE_S2S_SECRET) });
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/X-FoundU-Access-Token/);
    expect(upstream).toEqual([]);
  });

  it('gateway mode sends the header token upstream as a bearer token and ignores env', async () => {
    process.env.AUTH_MODE = 'gateway';
    process.env.FOUNDU_ACCESS_TOKEN = FAKE_ENV_TOKEN;
    const upstream = stubFounduOnly();
    const port = await listen();
    const headers = { ...gatewayHeaders, 'x-gateway-s2s': mint(FAKE_S2S_SECRET) };

    const list = (await (await post(port, listTools, headers)).json()) as RpcResult;
    expect(list.result.tools).toHaveLength(READ_TOOL_COUNT);

    const call = (await (await post(port, callStates, headers)).json()) as RpcResult;
    expect(call.result.isError).toBeFalsy();
    expect(call.result.content?.[0].text).toContain('QLD');
    expect(upstream).toEqual([{ path: '/api/v1/state', authorization: `Bearer ${FAKE_TOKEN}` }]);
  });

  it('concurrent calls with different tenant tokens each reach foundU with their own token', async () => {
    const tenants = Array.from({ length: 12 }, (_, i) => ({ token: `${FAKE_TOKEN}-tenant${i}`, state: `S${i}` }));
    const stateByAuth = new Map(tenants.map((t) => [`Bearer ${t.token}`, t.state]));
    const upstream: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname === '127.0.0.1') return realFetch(input, init);
        const authorization = new Headers(init?.headers).get('authorization');
        upstream.push(authorization);
        // Random delay so requests interleave and any shared-credential bug shows up as a mismatch.
        await new Promise((r) => setTimeout(r, Math.random() * 25));
        return jsonResponse({ '*': [{ state: stateByAuth.get(authorization ?? '') ?? 'UNKNOWN', state_id: 1 }] });
      }),
    );
    const port = await listen();

    const results = await Promise.all(
      tenants.map(async (t) => {
        const res = await post(port, callStates, { 'x-foundu-access-token': t.token, 'x-gateway-s2s': mint(FAKE_S2S_SECRET) });
        return (await res.json()) as RpcResult;
      }),
    );

    results.forEach((r, i) => {
      expect(r.result.isError).toBeFalsy();
      expect(JSON.parse(r.result.content![0].text)['*'][0].state).toBe(tenants[i].state);
    });
    expect([...upstream].sort()).toEqual(tenants.map((t) => `Bearer ${t.token}`).sort());
  });

  it('gateway mode rejects a malformed header token with a clear tool error and no upstream call', async () => {
    const upstream = stubFounduOnly();
    const port = await listen();
    const res = (await (await post(port, callStates, { 'x-foundu-access-token': `Bearer ${FAKE_TOKEN}`, 'x-gateway-s2s': mint(FAKE_S2S_SECRET) })).json()) as RpcResult;
    expect(res.result.isError).toBe(true);
    expect(res.result.content?.[0].text).toMatch(/without the "Bearer " prefix/);
    expect(res.result.content?.[0].text).not.toContain(FAKE_TOKEN);
    expect(upstream).toEqual([]);
  });

  it('starting in gateway mode locks the process out of env credentials', async () => {
    await listen();
    process.env.FOUNDU_ACCESS_TOKEN = FAKE_ENV_TOKEN;
    expect(() => resolveCredentials()).toThrow(/X-FoundU-Access-Token/);
  });

  describe('X-Conduit-Tool-Tiers (reduce-only)', () => {
    async function listWith(port: number, extra: Record<string, string>): Promise<string[]> {
      const res = await post(port, listTools, { ...gatewayHeaders, 'x-gateway-s2s': mint(FAKE_S2S_SECRET), ...extra });
      expect(res.status).toBe(200);
      return ((await res.json()) as RpcResult).result.tools!.map((t) => t.name);
    }

    it(`absent header or "read" exposes all ${READ_TOOL_COUNT} read tools`, async () => {
      const port = await listen();
      expect(await listWith(port, {})).toHaveLength(READ_TOOL_COUNT);
      expect(await listWith(port, { 'x-conduit-tool-tiers': 'read' })).toHaveLength(READ_TOOL_COUNT);
      expect(await listWith(port, { 'x-conduit-tool-tiers': 'READ, write, admin' })).toHaveLength(READ_TOOL_COUNT);
    });

    it('with FOUNDU_TOOL_TIERS=read,admin the header decides whether the pay-figure reports are listed', async () => {
      process.env.FOUNDU_TOOL_TIERS = 'read,admin';
      resetToolsets();
      try {
        const port = await listen();
        expect(await listWith(port, {})).toHaveLength(TOOL_COUNT);
        expect(await listWith(port, { 'x-conduit-tool-tiers': 'read,admin' })).toHaveLength(TOOL_COUNT);
        expect(await listWith(port, { 'x-conduit-tool-tiers': 'read' })).toHaveLength(READ_TOOL_COUNT);
      } finally {
        delete process.env.FOUNDU_TOOL_TIERS;
        resetToolsets();
      }
    });

    it('an empty or non-read header exposes zero tools and blocks calls', async () => {
      const upstream = stubFounduOnly();
      const port = await listen();
      expect(await listWith(port, { 'x-conduit-tool-tiers': '' })).toEqual([]);
      expect(await listWith(port, { 'x-conduit-tool-tiers': 'write,admin' })).toEqual([]);
      const res = (await (await post(port, callStates, { ...gatewayHeaders, 'x-gateway-s2s': mint(FAKE_S2S_SECRET), 'x-conduit-tool-tiers': '' })).json()) as RpcResult;
      expect(res.result.isError).toBe(true);
      expect(res.result.content?.[0].text).toBe('Error: Unknown tool: foundu_states_list');
      expect(upstream).toEqual([]);
    });
  });
});
