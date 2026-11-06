import { FounduError, notConfiguredError, toMcpError, type FounduErrorCode } from '../errors.js';

export interface ToolTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function toolJson(body: unknown, isError = false): ToolTextResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function errorResult(code: FounduErrorCode, message: string): ToolTextResult {
  return toolJson({ code, message }, true);
}

export async function runTool(work: () => Promise<ToolTextResult>): Promise<ToolTextResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof FounduError) {
      return errorResult(error.code, error.message);
    }
    const mcpError = toMcpError(error);
    return errorResult('upstream_error', mcpError.message);
  }
}

export function requireCredentials<T>(credentials: T | null): T {
  if (!credentials) {
    throw notConfiguredError();
  }
  return credentials;
}
