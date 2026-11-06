import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getCredentials } from '../credentials.js';
import { ALLOWED_PREFIXES, validateAuBaseUrl } from '../scope.js';
import { VERSION } from '../version.js';
import { toolJson, type ToolTextResult } from './result.js';

export const statusTool: Tool = {
  name: 'foundu_status',
  description:
    'Report FoundU MCP configuration: whether partner credentials are present, Australian data-residency status, and the aggregate-only tool surface. Does not call the FoundU API and does not return pay rates, bank details, tax file numbers, or employee personal data.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

export async function handleStatus(): Promise<ToolTextResult> {
  const credentials = getCredentials();
  let baseUrlHost: string | null = null;
  let residency: 'au' | 'rejected' | 'unconfigured' = credentials ? 'rejected' : 'unconfigured';

  if (credentials) {
    try {
      baseUrlHost = validateAuBaseUrl(credentials.baseUrl).hostname;
      residency = 'au';
    } catch {
      residency = 'rejected';
    }
  }

  return toolJson({
    ok: true,
    service: 'foundu-mcp',
    version: VERSION,
    hasCredentials: Boolean(credentials),
    baseUrlHost,
    dataResidency: 'AU',
    residency,
    scope: ['roster_summary', 'hours_summary', 'labour_cost_aggregates'],
    allowedPathPrefixes: ALLOWED_PREFIXES,
    omitted: ['pay_rates', 'bank_details', 'tax_file_numbers', 'employee_pii'],
    partnerAccess: 'Infinity Ben must grant FoundU partner API access before live reads succeed.',
    credentialRotation: 'Steadfast owns credential rotation.',
    engagement: 'Infinity Investments / Steadfast',
  });
}
