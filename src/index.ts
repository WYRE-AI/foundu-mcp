import { config } from 'dotenv';
import { startHttpTransport } from './http-transport.js';
import { startStdioTransport } from './stdio-transport.js';

// Load environment variables. A bare `node dist/index.js` speaks MCP over stdio,
// which is what local clients and the mcp-eval-baseline CI harness spawn.
// HTTP (gateway/container) mode is opt-in via MCP_TRANSPORT=http — which the
// Dockerfile sets — or the --http flag.
config();

const transport = process.env.MCP_TRANSPORT || (process.argv.includes('--http') ? 'http' : 'stdio');

async function main() {
  try {
    if (transport === 'stdio') {
      console.error('Starting FoundU MCP server (stdio)...');
      await startStdioTransport();
    } else {
      console.error('Starting FoundU MCP server (http)...');
      await startHttpTransport();
    }
  } catch (error) {
    console.error('Failed to start FoundU MCP server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
