import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export type FounduErrorCode =
  | 'not_configured'
  | 'not_authorized'
  | 'invalid_request'
  | 'upstream_error';

export class FounduError extends Error {
  readonly code: FounduErrorCode;

  constructor(code: FounduErrorCode, message: string) {
    super(message);
    this.name = 'FounduError';
    this.code = code;
  }
}

export const NOT_CONFIGURED_MESSAGE =
  'FoundU partner API credentials are not configured. Set FOUNDU_BASE_URL and FOUNDU_API_TOKEN, or send x-foundu-base-url and x-foundu-api-token from the WYRE gateway. Infinity Ben must grant partner API access before roster, hours, or labour-cost aggregates can be read.';

export const NOT_AUTHORIZED_PARTNER_MESSAGE =
  'FoundU rejected the partner API token. Infinity Ben must grant partner API access for this Australian tenant. This server only requests roster, hours, and labour-cost aggregates.';

export const SCOPE_REFUSAL_MESSAGE =
  'Refused. foundu-mcp only calls roster, hours, and labour-cost aggregate endpoints. Pay rates, bank details, tax file numbers, and employee personal data are omitted.';

export const AU_RESIDENCY_MESSAGE =
  'Refused. FOUNDU_BASE_URL must be the https origin of a foundu.com.au tenant so workforce data stays on FoundU\'s Australian platform. Steadfast owns credential rotation.';

export function notConfiguredError(): FounduError {
  return new FounduError('not_configured', NOT_CONFIGURED_MESSAGE);
}

export function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) {
    return error;
  }

  if (error instanceof FounduError) {
    const code = error.code === 'upstream_error' ? ErrorCode.InternalError : ErrorCode.InvalidRequest;
    return new McpError(code, error.message);
  }

  const errorMessage = error instanceof Error ? error.message : String(error);

  if (errorMessage.includes('401') || errorMessage.includes('403')) {
    return new McpError(ErrorCode.InvalidRequest, NOT_AUTHORIZED_PARTNER_MESSAGE);
  }

  if (errorMessage.includes('404')) {
    return new McpError(ErrorCode.InvalidRequest, 'FoundU aggregate resource not found');
  }

  if (errorMessage.includes('429')) {
    return new McpError(ErrorCode.InvalidRequest, 'FoundU partner API rate limit exceeded');
  }

  if (errorMessage.includes('500') || errorMessage.includes('502') || errorMessage.includes('503')) {
    return new McpError(ErrorCode.InternalError, 'FoundU partner API service error');
  }

  return new McpError(ErrorCode.InternalError, `FoundU partner API error: ${errorMessage}`);
}
