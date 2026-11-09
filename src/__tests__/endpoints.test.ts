import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_TIERS } from '../config.js';
import { buildToolset } from '../tools/index.js';
import { ArgumentError } from '../types.js';
import { idSegment, pathSegment } from '../validate.js';
import { always, FAKE_TOKEN, jsonResponse, mockFoundu, textOf, TOOL_COUNT } from './helpers.js';

/** Every tier (v1 has only read). */
const toolset = () => buildToolset(new Set(ALL_TIERS));

/**
 * One row per endpoint in the build spec: the tool, the arguments a model
 * sends, and the exact upstream request. Query pairs are compared as decoded
 * (key, value) lists in wire order, so csv lists (`a=1,2`) and bracket arrays
 * (`a[]=1&a[]=2`) are both pinned down.
 */
type Row = { tool: string; args: Record<string, unknown>; path: string; query: Array<[string, string]> };

const ROWS: Row[] = [
  { tool: 'foundu_states_list', args: {}, path: '/api/v1/state', query: [] },
  {
    tool: 'foundu_employees_search',
    args: {
      filter: 'smith',
      filter_status: 'Approved',
      filter_operation_ids: [120, 121],
      filter_location: [1, 2],
      filter_managers: [7],
      filter_employment_types: ['casual', 'part'],
      filter_terminated_employees: true,
      filter_record_last_updated_at: '2026-11-01 10:00:00',
      include: ['current-positions', 'office-code'],
      order: 'name:asc',
      limit: 50,
    },
    path: '/api/v2/employees',
    query: [
      ['filter', 'smith'],
      ['filter_status', 'Approved'],
      ['filter_operation_ids', '120,121'],
      ['filter_location', '1,2'],
      ['filter_managers', '7'],
      ['filter_employment_types', 'casual,part'],
      ['filter_terminated_employees', '1'],
      ['filter_record_last_updated_at', '2026-11-01 10:00:00'],
      ['include', 'current-positions,office-code'],
      ['order', 'name:asc'],
      ['limit', '50'],
    ],
  },
  {
    tool: 'foundu_employee_get',
    args: { id: 10034, include: ['current-positions'], filter_positions_effective_from: '2026-01-01', filter_positions_effective_to: '2026-12-31', limit: 10 },
    path: '/api/v2/employees/10034',
    query: [['include', 'current-positions'], ['filter_positions_effective_from', '2026-01-01'], ['filter_positions_effective_to', '2026-12-31'], ['limit', '10']],
  },
  {
    tool: 'foundu_employee_positions_list',
    args: { id: '10034', filter_current_positions: true, filter_casual_positions: false, filter_operation_id: 120, filter_dates_between: '2026-01-01,2026-03-31', include: ['positions'], limit: 5 },
    path: '/api/v1/employees/10034/positions',
    query: [['filter_current_positions', '1'], ['filter_operation_id', '120'], ['filter_dates_between', '2026-01-01,2026-03-31'], ['include', 'positions'], ['limit', '5']],
  },
  {
    tool: 'foundu_employee_leave_history_list',
    args: { id: 10034, filter_start_date: '2026-07-01', filter_type: 'annual', limit: 20 },
    path: '/api/v2/employees/10034/leave-history',
    query: [['filter_start_date', '2026-07-01'], ['filter_type', 'annual'], ['limit', '20']],
  },
  {
    tool: 'foundu_employee_leave_balances_get',
    args: { employeeId: 10034, include: ['position-entitlement-settings'], filter_entitlement: 3, filter_by_employable_operation: 120, limit: 100 },
    path: '/api/v1/employee-leave-ledger/10034',
    query: [['include', 'position-entitlement-settings'], ['filter_entitlement', '3'], ['filter_by_employable_operation', '120'], ['limit', '100']],
  },
  {
    tool: 'foundu_employee_shifts_list',
    args: {
      filter_shifts_between: '2026-11-01,2026-11-14',
      filter_previous_shifts: false,
      filter_upcoming_shifts: true,
      filter_branches: [278, 279],
      filter_employees: [10034],
      filter_shift_status: [1, 2],
      filter_updated_since: '2026-11-01',
      include: ['branch', 'employee'],
      order: 'id:desc',
      limit: 200,
    },
    path: '/api/v1/employee-shifts',
    query: [
      ['filter_shifts_between', '2026-11-01,2026-11-14'],
      ['filter_upcoming_shifts', '1'],
      ['filter_branches', '278,279'],
      ['filter_employees', '10034'],
      ['filter_shift_status', '1,2'],
      ['filter_updated_since', '2026-11-01'],
      ['include', 'branch,employee'],
      ['order', 'id:desc'],
      ['limit', '200'],
    ],
  },
  {
    tool: 'foundu_shift_history_list',
    args: { filter_roster_shift_candidate_ids: [1, 2, 3], limit: 10 },
    path: '/api/v1/shift-history',
    query: [['filter_roster_shift_candidate_ids', '1,2,3'], ['limit', '10']],
  },
  {
    tool: 'foundu_clock_logs_list',
    args: {
      filter_date_from: '2026-11-01',
      filter_date_to: '2026-11-08 23:59:59',
      filter_operation: 120,
      filter_roster: 278,
      filter_employee: 10034,
      filter_clocked_status: 'clocked_with_missing_times',
      filter_on_site_personnel_only: true,
      filter_updated_since: '2026-11-01 00:00:00',
      include: ['employee', 'roster_shift_breaks'],
      order: 'date:asc',
      limit: 100,
    },
    path: '/api/v1/clock-logs',
    query: [
      ['filter_date_from', '2026-11-01'],
      ['filter_date_to', '2026-11-08 23:59:59'],
      ['filter_operation', '120'],
      ['filter_roster', '278'],
      ['filter_employee', '10034'],
      ['filter_clocked_status', 'clocked_with_missing_times'],
      ['filter_on_site_personnel_only', '1'],
      ['filter_updated_since', '2026-11-01 00:00:00'],
      ['include', 'employee,roster_shift_breaks'],
      ['order', 'date:asc'],
      ['limit', '100'],
    ],
  },
  {
    tool: 'foundu_rosters_list',
    args: {
      filter: 'night',
      filter_status: 'Unverified',
      filter_client_id: [120],
      filter_location_id: [5],
      filter_state_id: [4],
      filter_roster_ids: [278, 279],
      filter_archive_only: true,
      filter_updated_since: '2026-10-01',
      include: ['client', 'location'],
      order: 'title:asc',
      limit: 25,
    },
    path: '/api/v2/roster-branches',
    query: [
      ['filter', 'night'],
      ['filter_status', 'Unverified'],
      ['filter_client_id', '120'],
      ['filter_location_id', '5'],
      ['filter_state_id', '4'],
      ['filter_roster_ids', '278,279'],
      ['filter_archive_only', '1'],
      ['filter_updated_since', '2026-10-01'],
      ['include', 'client,location'],
      ['order', 'title:asc'],
      ['limit', '25'],
    ],
  },
  { tool: 'foundu_roster_get', args: { id: 278, include: ['tags'] }, path: '/api/v2/roster-branches/278', query: [['include', 'tags']] },
  {
    tool: 'foundu_approved_shifts_list',
    args: {
      filterStartDate: '2026-11-01',
      filterEndDate: '2026-11-07',
      filterOperation: [120, 121],
      filterRoster: [278],
      filterIds: [123],
      filterEmployee: [10034, 10035],
      filterShiftType: ['approved', 'unapproved'],
      filterOfficeCode: [1],
      filterUpdatedSince: '2026-11-01 03:37:15',
      include: 'tags',
      limit: 200,
      page: 2,
    },
    path: '/api/v3/approve-shifts',
    query: [
      ['filterStartDate', '2026-11-01'],
      ['filterEndDate', '2026-11-07'],
      ['filterOperation[]', '120'],
      ['filterOperation[]', '121'],
      ['filterRoster[]', '278'],
      ['filterIds[]', '123'],
      ['filterEmployee[]', '10034'],
      ['filterEmployee[]', '10035'],
      ['filterShiftType[]', 'approved'],
      ['filterShiftType[]', 'unapproved'],
      ['filterOfficeCode[]', '1'],
      ['filterUpdatedSince', '2026-11-01 03:37:15'],
      ['include', 'tags'],
      ['limit', '200'],
      ['page', '2'],
    ],
  },
  {
    tool: 'foundu_unassigned_shifts_list',
    args: { filterStartDate: '2026-11-01', filterEndDate: '2026-11-07', filterOperation: [120], filterRoster: [278, 279], limit: 50, page: 1 },
    path: '/api/v3/approve-shifts/unassigned',
    query: [
      ['filterStartDate', '2026-11-01'],
      ['filterEndDate', '2026-11-07'],
      ['filterOperation[]', '120'],
      ['filterRoster[]', '278'],
      ['filterRoster[]', '279'],
      ['limit', '50'],
      ['page', '1'],
    ],
  },
  {
    tool: 'foundu_leave_applications_list',
    args: {
      filter_employee_id: 10034,
      filter_operations: [120],
      filter_branches: [278],
      filter_leave_status: 'pending',
      filter_approved: true,
      filter_dates_between: '2026-12-01,2026-12-31',
      filter_from_date: '2026-12-01',
      filter_to_date: '2026-12-31',
      filter_upcoming: true,
      filter_leave_type: [2, 5],
      filter_updated_since: '2026-11-01',
      include: ['leave-rule', 'employee'],
      order: 'startDate',
      order_direction: 'desc',
      limit: 30,
    },
    path: '/api/v1/leave/leave-applications',
    query: [
      ['filter_employee_id', '10034'],
      ['filter_operations', '120'],
      ['filter_branches', '278'],
      ['filter_leave_status', 'pending'],
      ['filter_approved', '1'],
      ['filter_dates_between', '2026-12-01,2026-12-31'],
      ['filter_from_date', '2026-12-01'],
      ['filter_to_date', '2026-12-31'],
      ['filter_upcoming', '1'],
      ['filter_leave_type', '2,5'],
      ['filter_updated_since', '2026-11-01'],
      ['include', 'leave-rule,employee'],
      ['order[]', 'startDate'],
      ['order[]', 'desc'],
      ['limit', '30'],
    ],
  },
  {
    tool: 'foundu_leave_rules_list',
    args: { filter: 'annual', filter_pay_no_pay: 'pay', filter_entitlement: true, filter_categories: ['pay', 'archived'], order: 'title:asc', limit: 100 },
    path: '/api/v1/leave-rules',
    query: [['filter', 'annual'], ['filter_pay_no_pay', 'pay'], ['filter_entitlement', '1'], ['filter_categories', 'pay,archived'], ['order', 'title:asc'], ['limit', '100']],
  },
  {
    tool: 'foundu_holidays_list',
    args: { filter_between_date: '2026-01-01,2026-12-31', include: ['additionalDetails'], limit: 100 },
    path: '/api/v1/holidays',
    query: [['filter_between_date', '2026-01-01,2026-12-31'], ['include', 'additionalDetails'], ['limit', '100']],
  },
  {
    tool: 'foundu_operations_list',
    args: {
      filter: 'acme',
      filter_status: 'Approved',
      filter_branch_ids: [278, 279],
      filter_operation_ids: [120],
      filter_state_id: [4],
      filter_managers: [7, 8],
      filter_tags: [3],
      filter_updated_since: '2026-11-01',
      include: ['operation-tags', 'branch'],
      order: 'name:asc',
      limit: 10,
    },
    path: '/api/v1/clients',
    query: [
      ['filter', 'acme'],
      ['filter_status', 'Approved'],
      ['filter_branch_ids[]', '278'],
      ['filter_branch_ids[]', '279'],
      ['filter_operation_ids', '120'],
      ['filter_state_id', '4'],
      ['filter_managers', '7,8'],
      ['filter_tags', '3'],
      ['filter_updated_since', '2026-11-01'],
      ['include', 'operation-tags,branch'],
      ['order', 'name:asc'],
      ['limit', '10'],
    ],
  },
  { tool: 'foundu_operation_get', args: { id: 120, include: ['branch'] }, path: '/api/v1/clients/120', query: [['include', 'branch']] },
  {
    tool: 'foundu_locations_list',
    args: { statuses: ['active', 'archived'], search: 'Brisbane', sort_by: 'state', sort_direction: 'desc', limit: 20, page: 3 },
    path: '/api/v2/locations',
    query: [['statuses', 'active,archived'], ['search', 'Brisbane'], ['sort_by', 'state'], ['sort_direction', 'desc'], ['limit', '20'], ['page', '3']],
  },
  { tool: 'foundu_positions_list', args: {}, path: '/api/v1/positions', query: [] },
  {
    tool: 'foundu_managers_list',
    args: { filter_updated_since: '2026-11-01 00:00', limit: 10 },
    path: '/api/v1/managers',
    query: [['filter_updated_since', '2026-11-01 00:00'], ['limit', '10']],
  },
  {
    tool: 'foundu_absence_reasons_list',
    args: { filter_by_reason_types: ['1', 3], filter: 'sick', order: 'title:asc', limit: 50 },
    path: '/api/v1/reason-list',
    query: [['filter_by_reason_types', '1,3'], ['filter', 'sick'], ['order', 'title:asc'], ['limit', '50']],
  },
  {
    tool: 'foundu_attendance_performance_report',
    args: {
      duration: 'custom_date_range',
      from_date: '2026-10-01',
      to_date: '2026-10-31',
      filter_employee_ids: [10034, 10035],
      filter_operation_ids: [120],
      filter_positions: [6],
      filter_reason_type: 1,
      limit: 100,
      page: 2,
    },
    path: '/api/v2/workforce-report-centre/attendance-and-performance',
    query: [
      ['duration', 'custom_date_range'],
      ['from_date', '2026-10-01'],
      ['to_date', '2026-10-31'],
      ['filter_employee_ids[]', '10034'],
      ['filter_employee_ids[]', '10035'],
      ['filter_operation_ids[]', '120'],
      ['filter_positions[]', '6'],
      ['filter_reason_type', '1'],
      ['limit', '100'],
      ['page', '2'],
    ],
  },
  {
    tool: 'foundu_qualifications_licences_report',
    args: {
      filter: 'forklift',
      filter_employee_ids: [10034],
      filter_employee_status: 'Approved',
      filter_qualification_types: 'licence',
      filter_expire_status: 'expired',
      filter_office_codes: [1, 2],
      order: 'expiry_date:desc',
      limit: 100,
      page: 1,
    },
    path: '/api/v2/workforce-report-centre/qualifications-and-licences',
    query: [
      ['filter', 'forklift'],
      ['filter_employee_ids', '10034'],
      ['filter_employee_status', 'Approved'],
      ['filter_qualification_types', 'licence'],
      ['filter_expire_status', 'expired'],
      ['filter_office_codes', '1,2'],
      ['order', 'expiry_date:desc'],
      ['limit', '100'],
      ['page', '1'],
    ],
  },
];

beforeEach(() => {
  process.env.FOUNDU_ACCESS_TOKEN = FAKE_TOKEN;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FOUNDU_ACCESS_TOKEN;
  delete process.env.FOUNDU_MAX_RESPONSE_CHARS;
});

async function call(tool: string, args: Record<string, unknown>, body: unknown = { data: [] }) {
  const { calls } = mockFoundu([always(() => jsonResponse(body))]);
  const res = await toolset().dispatch(tool, args);
  return { res, calls };
}

async function expectRejected(tool: string, args: Record<string, unknown>, why: RegExp) {
  const { res, calls } = await call(tool, args);
  expect(res.isError, textOf(res)).toBe(true);
  expect(textOf(res)).toMatch(why);
  expect(calls).toHaveLength(0);
}

describe('endpoint catalog', () => {
  it(`covers every tool exactly once (${TOOL_COUNT})`, () => {
    expect(ROWS).toHaveLength(TOOL_COUNT);
    expect(new Set(ROWS.map((r) => r.tool))).toEqual(new Set(toolset().tools.map((t) => t.name)));
  });

  it.each(ROWS)('$tool -> GET $path', async ({ tool, args, path, query }) => {
    const { res, calls } = await call(tool, args);
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.origin).toBe('https://api.foundu.com.au');
    expect(calls[0].url.pathname).toBe(path);
    expect([...calls[0].url.searchParams.entries()]).toEqual(query);
  });

  it('every declared argument of every tool is exercised by a row', () => {
    for (const tool of toolset().tools) {
      const row = ROWS.find((r) => r.tool === tool.name)!;
      const declared = Object.keys(tool.inputSchema.properties ?? {});
      const unexercised = declared.filter((k) => !(k in row.args));
      expect(unexercised, tool.name).toEqual([]);
    }
  });
});

describe('pagination is passed through, never auto-paged', () => {
  it('forwards page and limit and returns the vendor pagination block untouched', async () => {
    const body = { success: true, data: [{ id: 1 }], meta: { pagination: { current_page: 2, per_page: 1, total: 878, last_page: 878, has_more_pages: true } } };
    const { res, calls } = await call('foundu_approved_shifts_list', { filterStartDate: '2026-11-01', filterEndDate: '2026-11-07', limit: 1, page: 2 }, body);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get('page')).toBe('2');
    expect(JSON.parse(textOf(res))).toEqual(body);
  });
});

describe('endpoints without paging say when a result may be cut off', () => {
  const rows = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ id: i + 1 })), included: {} });
  const unpaged = () => toolset().tools.filter((t) => 'limit' in (t.inputSchema.properties ?? {}) && !('page' in (t.inputSchema.properties ?? {})));

  it('every limit-only tool says it has no paging; paged tools do not', () => {
    expect(unpaged().length).toBeGreaterThan(10);
    for (const t of toolset().tools) {
      const props = t.inputSchema.properties ?? {};
      const noPaging = 'limit' in props && !('page' in props);
      expect(/no next page/.test(t.description ?? ''), t.name).toBe(noPaging);
    }
  });

  it('flags a full result (data.length reaches the effective limit)', async () => {
    const { res } = await call('foundu_employees_search', { limit: 2 }, rows(2));
    const out = JSON.parse(textOf(res));
    expect(out.possibly_truncated).toBe(true);
    expect(out.truncation_note).toMatch(/no next page/);
    expect(out.data).toHaveLength(2);
  });

  it('flags a result when limit was left to the undocumented vendor default', async () => {
    const { res } = await call('foundu_managers_list', {}, rows(3));
    expect(JSON.parse(textOf(res)).possibly_truncated).toBe(true);
  });

  it('does not flag a result shorter than the limit', async () => {
    const { res } = await call('foundu_employees_search', { limit: 5 }, rows(2));
    expect(JSON.parse(textOf(res))).toEqual(rows(2));
  });

  it('compares against the capped limit actually sent', async () => {
    const { res } = await call('foundu_managers_list', { limit: 999_999 }, rows(1000));
    expect(JSON.parse(textOf(res)).possibly_truncated).toBe(true);
  });

  it('never flags paged tools or tools with no limit', async () => {
    expect(JSON.parse(textOf((await call('foundu_locations_list', { limit: 1 }, rows(1))).res))).toEqual(rows(1));
    expect(JSON.parse(textOf((await call('foundu_positions_list', {}, rows(3))).res))).toEqual(rows(3));
  });

  it('when an unpaged result is shrunk to fit, the hint does not point at a next page', async () => {
    process.env.FOUNDU_MAX_RESPONSE_CHARS = '1500';
    const big = { data: Array.from({ length: 100 }, (_, i) => ({ id: i, title: 'x'.repeat(40) })) };
    const unpagedOut = JSON.parse(textOf((await call('foundu_rosters_list', { limit: 100 }, big)).res));
    expect(unpagedOut.truncated).toBe(true);
    expect(unpagedOut.truncation_hint).not.toMatch(/next page/i);
    expect(unpagedOut.truncation_hint).toMatch(/filters/);
    const pagedOut = JSON.parse(textOf((await call('foundu_locations_list', { limit: 100 }, big)).res));
    expect(pagedOut.truncation_hint).toMatch(/smaller limit/);
  });
});

describe('order descriptions list only wire field names', () => {
  it('every name after "Fields:" matches the order pattern', () => {
    for (const t of toolset().tools) {
      const order = (t.inputSchema.properties ?? {}).order as { description?: string; pattern?: string } | undefined;
      if (!order?.pattern) continue;
      const fields = /Fields: ([^.]+)\./.exec(order.description ?? '')?.[1];
      expect(fields, t.name).toBeDefined();
      for (const f of fields!.split(',').map((x) => x.trim())) expect(f, `${t.name}: ${f}`).toMatch(/^[A-Za-z_]{1,64}$/);
    }
  });
});

describe('limits are capped at the vendor maximum', () => {
  it.each([
    ['foundu_employees_search', {}, 2000],
    ['foundu_rosters_list', {}, 3000],
    ['foundu_operations_list', {}, 1500],
    ['foundu_qualifications_licences_report', {}, 500],
    ['foundu_approved_shifts_list', {}, 1000],
  ])('%s caps limit at %i', async (tool, args, max) => {
    const { calls } = await call(tool, { ...args, limit: 999_999 });
    expect(calls[0].url.searchParams.get('limit')).toBe(String(max));
  });

  it('rejects a limit below 1', async () => {
    await expectRejected('foundu_managers_list', { limit: 0 }, /at least 1/);
  });
});

describe('argument validation (all before any request)', () => {
  it.each([
    ['foundu_employees_search', { filter_status: 'Active' }, /must be one of/],
    ['foundu_employees_search', { include: ['hr-details'] }, /must be one of/],
    ['foundu_employee_get', { id: 1, include: ['custom-fields'] }, /must be one of/],
    ['foundu_employee_get', { id: 1, include: ['current-medical'] }, /must be one of/],
    ['foundu_employee_shifts_list', { include: ['costing'] }, /must be one of/],
    ['foundu_approved_shifts_list', { filterShiftType: ['deleted'] }, /must be one of/],
    ['foundu_employee_shifts_list', { filter_shifts_between: 'last week' }, /wrong format/],
    ['foundu_clock_logs_list', { filter_date_from: '01/11/2026' }, /wrong format/],
    ['foundu_employees_search', { order: 'name; drop' }, /wrong format/],
    ['foundu_employees_search', { filter_location: ['1,2'] }, /must be an integer/],
    ['foundu_locations_list', { statuses: ['active,archived'] }, /must not contain a comma/],
    ['foundu_employees_search', { filter_terminated_employees: 'yes' }, /true or false/],
    ['foundu_employees_search', { filter: 'a\u0000b' }, /control characters/],
    ['foundu_attendance_performance_report', {}, /"duration" is required/],
    ['foundu_attendance_performance_report', { duration: 'custom_date_range', from_date: '2026-10-01' }, /needs from_date and to_date/],
    ['foundu_leave_applications_list', { order_direction: 'desc' }, /needs "order"/],
    ['foundu_attendance_performance_report', { duration: 'specific_date_range' }, /must be one of/],
    ['foundu_approved_shifts_list', { filterIds: [123] }, /filterIds needs filterStartDate and filterEndDate/],
    ['foundu_approved_shifts_list', { filterIds: [123], filterStartDate: '2026-11-01' }, /filterIds needs filterStartDate and filterEndDate/],
  ])('%s rejects %j', async (tool, args, why) => {
    await expectRejected(tool, args as Record<string, unknown>, why);
  });

  it('a false flag is simply not sent', async () => {
    const { calls } = await call('foundu_employee_positions_list', { id: 1, filter_current_positions: false });
    expect(calls[0].url.search).toBe('');
  });

  it('drops undeclared arguments (e.g. a smuggled base URL or extra filter)', async () => {
    const { calls } = await call('foundu_states_list', { baseUrl: 'https://evil.example.net', filter_tfn: '123' });
    expect(calls[0].url.href).toBe('https://api.foundu.com.au/api/v1/state');
  });
});

describe('path parameters', () => {
  it.each(['../state', '..', '.', '1/2', '1\\2', '%2e%2e', '1%2F2', '1%5c2', '', ' ', '1\u0000', 'abc', '-1', 1.5, -3, null, { id: 1 }])(
    'rejects %j before any request',
    async (bad) => {
      const { res, calls } = await call('foundu_employee_get', { id: bad });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/"id"/);
      expect(calls).toHaveLength(0);
    },
  );

  it('accepts an integer or a digit string', async () => {
    expect((await call('foundu_employee_get', { id: 42 })).calls[0].url.pathname).toBe('/api/v2/employees/42');
    expect((await call('foundu_employee_get', { id: ' 42 ' })).calls[0].url.pathname).toBe('/api/v2/employees/42');
  });

  it('pathSegment percent-encodes what it lets through; idSegment then insists on digits', () => {
    expect(pathSegment('a b?c#d', 'x')).toBe('a%20b%3Fc%23d');
    expect(pathSegment('100%', 'x')).toBe('100%25');
    expect(() => idSegment('a b', 'x')).toThrow(ArgumentError);
    expect(idSegment(7, 'x')).toBe('7');
  });
});
