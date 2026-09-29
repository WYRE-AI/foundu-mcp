import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { credentialsStorage, type FounduCredentials } from './credentials.js';
import { verifyS2sHeader, S2S_HEADER } from './s2s-verify.js';

const port = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
const host = process.env.MCP_HTTP_HOST || '0.0.0.0';

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// Uses the raw node:http server (not Fastify) to match the WYRE MCP fleet
// convention. The StreamableHTTPServerTransport reads the request body off the
// raw stream itself; a framework that pre-parses the body drains that stream
// and the SDK then fails every call with -32700 "Parse error".
export function createFounduHttpServer(): HttpServer {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // /health is container liveness, not credential readiness. In gateway mode
    // credentials arrive per request via x-foundu-* headers, so gating this on
    // credentials would always 503. Always 200, no auth required.
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'foundu-mcp' }));
      return;
    }

    // The MCP endpoint MUST be /mcp: the gateway proxies vendor traffic to
    // `${containerUrl}${mcpPath ?? '/mcp'}` and FoundU sets no mcpPath.
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health'] }));
      return;
    }

    const s2sSecret = process.env.CONDUIT_S2S_SECRET || '';
    if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.',
      }));
      return;
    }

    const handle = async () => {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on('close', () => {
        transport.close();
        server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res);
    };

    // Gateway mode: per-request credentials via headers, scoped through
    // AsyncLocalStorage so concurrent requests never cross credentials.
    // tools/list works without credentials. A partial header set does not
    // fall back to process env.
    const baseUrl = headerValue(req.headers['x-foundu-base-url'])?.trim();
    const apiToken = headerValue(req.headers['x-foundu-api-token'])?.trim();

    if (baseUrl || apiToken) {
      if (baseUrl && apiToken) {
        const credentials: FounduCredentials = { baseUrl, apiToken };
        await credentialsStorage.run({ kind: 'creds', credentials }, handle);
      } else {
        await credentialsStorage.run({ kind: 'incomplete' }, handle);
      }
      return;
    }

    await handle();
  });
}

export async function startHttpTransport(): Promise<void> {
  const httpServer = createFounduHttpServer();
  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      console.error(`FoundU MCP HTTP server listening on ${host}:${port}`);
      resolve();
    });
  });
}
