import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { createFounduHttpServer } from '../src/http-transport.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return address.port;
}

describe('HTTP transport', () => {
  const originalSecret = process.env.CONDUIT_S2S_SECRET;
  let server: Server | undefined;

  afterEach(async () => {
    if (originalSecret === undefined) delete process.env.CONDUIT_S2S_SECRET;
    else process.env.CONDUIT_S2S_SECRET = originalSecret;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
    }
  });

  it('serves /health without credentials and 404s unknown paths', async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    server = createFounduHttpServer();
    const port = await listen(server);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', service: 'foundu-mcp' });

    const missing = await fetch(`http://127.0.0.1:${port}/employees`);
    expect(missing.status).toBe(404);
  });

  it('rejects /mcp when the gateway S2S secret is set and the header is absent', async () => {
    process.env.CONDUIT_S2S_SECRET = 'test-secret';
    server = createFounduHttpServer();
    const port = await listen(server);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);

    const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
    expect(mcp.status).toBe(401);
  });
});
