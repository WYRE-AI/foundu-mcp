import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, type ServerResult } from '@modelcontextprotocol/sdk/types.js';
import { toMcpError } from './errors.js';
import { VERSION } from './version.js';
import { statusTool, handleStatus } from './tools/status.js';
import {
  rosterSummaryTool,
  hoursSummaryTool,
  labourCostAggregatesTool,
  handleRosterSummary,
  handleHoursSummary,
  handleLabourCostAggregates,
} from './tools/aggregates.js';
import { rawRequestTool, handleRawRequest } from './tools/raw.js';
import type { ToolTextResult } from './tools/result.js';

export const TOOLS = [
  statusTool,
  rosterSummaryTool,
  hoursSummaryTool,
  labourCostAggregatesTool,
  rawRequestTool,
];

export function createServer(): Server {
  const server = new Server(
    { name: 'foundu-mcp', version: VERSION },
    { capabilities: { tools: {}, logging: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ServerResult> => {
    const { name, arguments: rawArgs = {} } = request.params;
    const args = rawArgs as Record<string, unknown>;
    // Rebuild a fresh result object. The SDK's ServerResult union includes
    // task results, and a named content-only type is not assignable to it.
    const reply = (result: { content: ToolTextResult['content']; isError?: boolean }): ServerResult => ({
      content: result.content,
      ...(result.isError ? { isError: true } : {}),
    });

    try {
      switch (name) {
        case 'foundu_status':
          return reply(await handleStatus());
        case 'foundu_roster_summary':
          return reply(await handleRosterSummary(args));
        case 'foundu_hours_summary':
          return reply(await handleHoursSummary(args));
        case 'foundu_labour_cost_aggregates':
          return reply(await handleLabourCostAggregates(args));
        case 'foundu_raw_request':
          return reply(await handleRawRequest(args));
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const mcpError = toMcpError(error);
      return {
        content: [{ type: 'text' as const, text: mcpError.message }],
        isError: true,
      };
    }
  });

  return server;
}
