import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createFounduClient } from '../client.js';
import { getCredentials } from '../credentials.js';
import { FounduError } from '../errors.js';
import { HOURS_SUMMARY_PATH, LABOUR_COST_PATH, ROSTER_SUMMARY_PATH } from '../scope.js';
import { requireCredentials, runTool, toolJson, type ToolTextResult } from './result.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const idValue = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const aggregateQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    locationId: idValue.optional(),
    operationId: idValue.optional(),
    groupBy: z.enum(['location', 'operation', 'position', 'day']).optional(),
  })
  .strict();

export type AggregateQuery = z.infer<typeof aggregateQuerySchema>;

const AGGREGATE_PROPERTIES = {
  from: { type: 'string', description: 'Inclusive start date (YYYY-MM-DD)' },
  to: { type: 'string', description: 'Inclusive end date (YYYY-MM-DD)' },
  locationId: { type: 'string', description: 'FoundU location id. Site dimension only.' },
  operationId: { type: 'string', description: 'FoundU operation id. Operation dimension only.' },
  groupBy: {
    type: 'string',
    enum: ['location', 'operation', 'position', 'day'],
    description: 'Aggregate dimension. Per-employee breakdowns are refused.',
  },
} as const;

function aggregateSchema(description: string): Tool['inputSchema'] {
  return {
    type: 'object',
    description,
    properties: AGGREGATE_PROPERTIES,
    additionalProperties: false,
  };
}

export const rosterSummaryTool: Tool = {
  name: 'foundu_roster_summary',
  description:
    'Roster aggregate only: shift counts and rostered hours by location, operation, position, or day. Does not return employee names, pay rates, bank details, or tax file numbers. Requires FoundU partner API access granted by Infinity Ben.',
  inputSchema: aggregateSchema('Roster aggregate filters'),
};

export const hoursSummaryTool: Tool = {
  name: 'foundu_hours_summary',
  description:
    'Timesheet hours aggregate only: rostered and worked hours by location, operation, position, or day. Does not return employee names, pay rates, bank details, or tax file numbers. Requires FoundU partner API access granted by Infinity Ben.',
  inputSchema: aggregateSchema('Hours aggregate filters'),
};

export const labourCostAggregatesTool: Tool = {
  name: 'foundu_labour_cost_aggregates',
  description:
    'Labour-cost aggregate only: rolled-up labour cost totals by location, operation, position, or day. Individual pay rates are stripped from the response. Does not return bank details, tax file numbers, or employee personal data. Requires FoundU partner API access granted by Infinity Ben.',
  inputSchema: aggregateSchema('Labour-cost aggregate filters'),
};

const SENSITIVE_ARG = /employee|pay.?rate|tfn|tax|bank|bsb|salary|wage/i;

export function parseAggregateArgs(args: unknown): AggregateQuery {
  const record = asRecord(args);
  for (const key of Object.keys(record)) {
    if (SENSITIVE_ARG.test(key)) {
      throw new FounduError(
        'not_authorized',
        'Refused. Aggregate tools accept from, to, locationId, operationId, and groupBy. Employee, pay-rate, bank, and tax-file filters are omitted.',
      );
    }
  }

  if (typeof record.groupBy === 'string' && !['location', 'operation', 'position', 'day'].includes(record.groupBy)) {
    throw new FounduError(
      'not_authorized',
      'Refused. groupBy accepts location, operation, position, or day. Per-employee breakdowns are omitted.',
    );
  }

  const parsed = aggregateQuerySchema.safeParse(record);
  if (!parsed.success) {
    throw new FounduError('invalid_request', 'Aggregate filters must be a date window and an optional location, operation, or groupBy dimension.');
  }

  if (parsed.data.from && parsed.data.to && parsed.data.to < parsed.data.from) {
    throw new FounduError('invalid_request', 'The end date must be on or after the start date.');
  }
  if (parsed.data.from && !isCalendarDate(parsed.data.from)) {
    throw new FounduError('invalid_request', 'The start date is not a calendar date.');
  }
  if (parsed.data.to && !isCalendarDate(parsed.data.to)) {
    throw new FounduError('invalid_request', 'The end date is not a calendar date.');
  }
  if (parsed.data.from && parsed.data.to) {
    const from = Date.parse(`${parsed.data.from}T00:00:00Z`);
    const to = Date.parse(`${parsed.data.to}T00:00:00Z`);
    const days = (to - from) / 86_400_000;
    if (!Number.isFinite(days) || days > 366) {
      throw new FounduError('invalid_request', 'The date window must be 366 days or fewer.');
    }
  }

  return parsed.data;
}

function isCalendarDate(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function asRecord(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

function toQuery(query: AggregateQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.from) params.from = query.from;
  if (query.to) params.to = query.to;
  if (query.locationId) params.locationId = query.locationId;
  if (query.operationId) params.operationId = query.operationId;
  if (query.groupBy) params.groupBy = query.groupBy;
  return params;
}

async function handleAggregate(scope: string, path: string, args: unknown): Promise<ToolTextResult> {
  return runTool(async () => {
    const query = parseAggregateArgs(args);
    const credentials = requireCredentials(getCredentials());
    const client = createFounduClient(credentials);
    const result = await client.getAggregate(path, toQuery(query));
    return toolJson({
      scope,
      aggregateOnly: true,
      omitted: ['pay_rates', 'bank_details', 'tax_file_numbers', 'employee_pii'],
      redactedFields: result.redactedFields,
      data: result.data,
    });
  });
}

export function handleRosterSummary(args: unknown): Promise<ToolTextResult> {
  return handleAggregate('roster_summary', ROSTER_SUMMARY_PATH, args);
}

export function handleHoursSummary(args: unknown): Promise<ToolTextResult> {
  return handleAggregate('hours_summary', HOURS_SUMMARY_PATH, args);
}

export function handleLabourCostAggregates(args: unknown): Promise<ToolTextResult> {
  return handleAggregate('labour_cost_aggregates', LABOUR_COST_PATH, args);
}
