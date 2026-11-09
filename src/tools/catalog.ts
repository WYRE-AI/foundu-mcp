/**
 * The 24 foundU endpoints this server exposes, one tool each, all GET, all
 * `read` tier. Paths, parameter names, enums, and per-page limits follow the
 * official OpenAPI (https://api.foundu.com.au/api/reference-json, 3.0.1);
 * review changes against it line by line.
 *
 * Deliberately NOT exposed: any write (POST/PUT/PATCH/DELETE), and the
 * payroll/identity surface even though it is readable: employee financial
 * details, payslips, paycycles, operation pay rates, deductions, ETP, the
 * payroll-activity and deduction/reimbursement reports, invoice and
 * compliance documents, the visa checklist, and the read-shaped POST
 * /api/v1/accounting/payroll-ledger-map/report. The labour-management and
 * timesheet-analysis reports return pay per employee and per shift, so they
 * are left out of v1 (a possible future admin-tier feature). Employee
 * `include` values are allowlisted so hr-details, custom-fields, medical, and
 * contact data cannot be requested from the employee endpoints. Other
 * endpoints with include=employee (leave applications) document those
 * resources in `included`, so redact.ts removes them by type key.
 */
import { ArgumentError } from '../types.js';
import { endpointTool, type Endpoint, type Param, type StringParam } from './endpoint.js';
import type { ToolArgs, ToolDef } from './types.js';

// ---- shared parameters ----------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;
const DATE_RANGE = /^\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2}$/;
const ORDER = /^[A-Za-z_]{1,64}:(asc|desc)$/;

function limit(maximum: number, note = ''): Param {
  return { type: 'integer', minimum: 1, maximum, description: `Maximum records to return (1-${maximum}; larger values are capped).${note ? ` ${note}` : ''}` };
}

const page: Param = {
  type: 'integer',
  minimum: 1,
  description: 'Page number (1-based). Read the pagination fields in the response to choose the next page; this tool never fetches more than one page.',
};

const date = (what: string, required = false): StringParam => ({ type: 'string', required, pattern: DATE, description: `${what} (YYYY-MM-DD).` });
const datetime = (what: string): StringParam => ({ type: 'string', pattern: DATETIME, description: `${what} (YYYY-MM-DD or YYYY-MM-DD HH:mm:ss).` });
const dateRange = (what: string): StringParam => ({ type: 'string', pattern: DATE_RANGE, description: `${what}, as "start,end" (YYYY-MM-DD,YYYY-MM-DD).` });
const updatedSince = datetime('Only records created or updated since this time');
const text = (description: string): Param => ({ type: 'string', description });
const id = (description: string): Param => ({ type: 'integer', minimum: 1, description });
const ids = (what: string): Param => ({ type: 'csv', items: 'integer', description: `Only these ${what} (integer IDs; sent comma-separated).` });
const idArray = (what: string): Param => ({ type: 'array', items: 'integer', description: `Only these ${what} (integer IDs; sent as an array).` });
const flag = (description: string, trueValue?: string): Param => ({
  type: 'boolean',
  description: `${description} Set true to apply; false is the same as leaving it out.`,
  ...(trueValue ? { trueValue } : {}),
});
/** `fields` must be wire names only (they are checked against ORDER); say anything else in `note`. */
const order = (fields: string, note = ''): Param => ({
  type: 'string',
  pattern: ORDER,
  description: `Sort as field:direction, e.g. id:desc. Fields: ${fields}.${note ? ` ${note}` : ''}`,
});
const include = (values: readonly string[], note = ''): Param => ({
  type: 'csv',
  items: 'string',
  enum: values,
  description: `Related data to embed in the response.${note ? ` ${note}` : ''}`,
});

const OPERATION_STATUS = ['Approved', 'Archived', 'Declined', 'Unverified'] as const;

/** Employee includes that are safe to expose. hr-details, custom-fields, current-medical, contacts, and onboarding/STP data are left out on purpose. */
const EMPLOYEE_INCLUDES = [
  'tag',
  'employee-status',
  'office-code',
  'current-associated-operation',
  'current-associated-location',
  'current-positions',
  'employee-state-suburb',
  'employee-employment-type-start-date',
  'employee-last-worked-date',
  'employment-status-history',
] as const;
const EMPLOYEE_INCLUDE_NOTE = 'HR details, custom fields, medical, contact, and onboarding data cannot be requested.';

// ---- approve-shifts (v3) ---------------------------------------------------

/**
 * The reference documents these two v3 endpoints as GET with a JSON body.
 * HTTP clients (including fetch) cannot send a body on GET, so the filters
 * go in the query string with bracket arrays, which Laravel reads the same
 * way. Not yet verified against a live tenant.
 */
const V3_NOTE = 'Filters are sent as query parameters.';
const shiftWindow = {
  filterStartDate: date('Start of the date window'),
  filterEndDate: date('End of the date window'),
  filterOperation: idArray('operation IDs'),
  filterRoster: idArray('roster branch IDs'),
};
const v3Paging = { limit: limit(1000, 'Default 100; this server caps at 1000.'), page };

/** foundU: filterIds still needs the start and end filters. */
function filterIdsNeedWindow(args: ToolArgs): void {
  if (args.filterIds !== undefined && (args.filterStartDate === undefined || args.filterEndDate === undefined)) {
    throw new ArgumentError('filterIds needs filterStartDate and filterEndDate.');
  }
}

// ---- endpoints ------------------------------------------------------------

const ENDPOINTS: Endpoint[] = [
  {
    name: 'foundu_states_list',
    description: 'List the Australian states foundU uses for work locations (state and state_id). Cheap, and the quickest way to check that the foundU connection works.',
    path: '/api/v1/state',
  },

  // People
  {
    name: 'foundu_employees_search',
    description:
      'Search the employee directory: status, operation, location, manager, and employment type. Returns directory fields only; payroll, banking, tax, HR, and medical details are never returned.',
    path: '/api/v2/employees',
    query: {
      filter: text('Free-text search across name, email, phone number, and employee ID.'),
      filter_status: { type: 'string', enum: ['Approved', 'Unverified', 'Archived', 'Declined', 'Approved-and-Archived'], description: 'Employee status.' },
      filter_operation_ids: ids('operation IDs (employees associated with them)'),
      filter_location: ids('location IDs the employee can work in'),
      filter_managers: ids('manager IDs'),
      filter_employment_types: { type: 'csv', items: 'string', enum: ['full', 'part', 'casual', 'no_pos'], description: 'Only these employment types.' },
      filter_terminated_employees: flag('Only employees who have been terminated.'),
      filter_record_last_updated_at: datetime('Only employees updated since this time'),
      include: include(EMPLOYEE_INCLUDES, EMPLOYEE_INCLUDE_NOTE),
      order: order('id, email, status, suburb, name, created_at'),
      limit: limit(2000),
    },
  },
  {
    name: 'foundu_employee_get',
    description: 'Get one employee by ID (directory fields; payroll, banking, tax, HR, and medical details are never returned).',
    path: '/api/v2/employees/{id}',
    pathParams: { id: 'Employee ID.' },
    query: {
      include: include(EMPLOYEE_INCLUDES, EMPLOYEE_INCLUDE_NOTE),
      filter_positions_effective_from: date('With include=current-positions: positions still running on or after this date'),
      filter_positions_effective_to: date('With include=current-positions: leave out positions that start after this date'),
      limit: limit(1000),
    },
  },
  {
    name: 'foundu_employee_positions_list',
    description: "List an employee's positions, including historical ones (operation, position, effective dates).",
    path: '/api/v1/employees/{id}/positions',
    pathParams: { id: 'Employee ID.' },
    query: {
      filter_current_positions: flag('Only current positions (no end date, or an end date in the future).'),
      filter_casual_positions: flag('Only casual positions.'),
      filter_operation_id: id('Only positions at this operation ID.'),
      filter_dates_between: dateRange('Only positions active in this window'),
      include: include(['positions', 'position-location', 'employee-permanent-part-time-positions', 'position-entitlement-settings']),
      limit: limit(1000),
    },
  },
  {
    name: 'foundu_employee_leave_history_list',
    description: "List one employee's leave history.",
    path: '/api/v2/employees/{id}/leave-history',
    pathParams: { id: 'Employee ID.' },
    query: {
      filter_start_date: date('Only leave starting on or after this date'),
      filter_type: text('Leave type.'),
      limit: limit(1000),
    },
  },
  {
    name: 'foundu_employee_leave_balances_get',
    description: "Get one employee's leave balances (the leave ledger).",
    path: '/api/v1/employee-leave-ledger/{employeeId}',
    pathParams: { employeeId: 'Employee ID.' },
    query: {
      include: include(['position-entitlement-settings', 'positionEntitlementSetting']),
      filter_entitlement: id('Only this entitlement ID.'),
      filter_by_employable_operation: id('Only balances for this employable operation ID.'),
      limit: limit(1000),
    },
  },

  // Rosters, shifts, and time and attendance
  {
    name: 'foundu_employee_shifts_list',
    description: 'List rostered employee shifts: who is rostered where and when, with status. Use filter_shifts_between to bound the window.',
    path: '/api/v1/employee-shifts',
    query: {
      filter_shifts_between: dateRange('Only shifts in this window'),
      filter_previous_shifts: flag('Only past shifts.'),
      filter_upcoming_shifts: flag('Only upcoming shifts.'),
      filter_branches: ids('roster branch IDs'),
      filter_employees: ids('employee IDs'),
      filter_shift_status: ids('shift status codes'),
      filter_updated_since: updatedSince,
      include: include(
        ['branch', 'employee', 'position', 'position_group', 'errors', 'rosterShiftComment', 'attendance', 'rosterShift', 'clockLog', 'tags', 'qualifications', 'shiftLeave'],
        'Costing and shift documents are not offered.',
      ),
      order: order('id', 'Other shift fields are accepted by foundU but their wire names are not documented.'),
      limit: limit(1000),
    },
  },
  {
    name: 'foundu_shift_history_list',
    description: 'List the change history of rostered shift candidates.',
    path: '/api/v1/shift-history',
    query: {
      filter_roster_shift_candidate_ids: ids('roster shift candidate IDs'),
      limit: limit(1000),
    },
  },
  {
    name: 'foundu_clock_logs_list',
    description: 'List clock-in and clock-out records (time and attendance), including breaks and location issues.',
    path: '/api/v1/clock-logs',
    query: {
      filter_date_from: datetime('Only shifts starting or ending after this time'),
      filter_date_to: datetime('Only shifts starting or ending before this time'),
      filter_operation: id('Only this operation ID.'),
      filter_roster: id('Only this roster branch ID.'),
      filter_employee: id('Only this employee ID.'),
      filter_clocked_status: { type: 'string', enum: ['clocked_with_missing_times', 'clocked_with_location_issues'], description: 'Only records with this problem.' },
      filter_on_site_personnel_only: flag('Only shifts that are active now (people on site).'),
      filter_updated_since: updatedSince,
      include: include(['branch', 'client', 'employee', 'roster_shift_breaks', 'candidate']),
      order: order(
        'id, date',
        'Only these wire names are confirmed. foundU also documents sorting by shift start/end, break start/end, employee, operation, branch, and duration without giving their wire names.',
      ),
      limit: limit(1000),
    },
  },
  {
    name: 'foundu_rosters_list',
    description: 'List rosters (foundU "roster branches"): the sites or teams shifts are rostered to, with their operation and location.',
    path: '/api/v2/roster-branches',
    query: {
      filter: text('Match roster branch ID or title.'),
      filter_status: { type: 'string', enum: OPERATION_STATUS, description: 'Roster status (Unverified means pending).' },
      filter_client_id: ids('operation IDs'),
      filter_location_id: ids('location IDs'),
      filter_state_id: ids('state IDs'),
      filter_roster_ids: ids('roster branch IDs'),
      filter_archive_only: flag('Only archived rosters.'),
      filter_updated_since: updatedSince,
      include: include(['client', 'location', 'qualification', 'qualifications', 'tag', 'tags', 'roster-comment', 'rosterComment', 'rosterDayComment']),
      order: order('id, title'),
      limit: limit(3000),
    },
  },
  {
    name: 'foundu_roster_get',
    description: 'Get one roster (roster branch) by ID.',
    path: '/api/v2/roster-branches/{id}',
    pathParams: { id: 'Roster branch ID.' },
    query: {
      include: include(['client', 'location', 'qualification', 'qualifications', 'tag', 'tags', 'roster-comment', 'rosterComment', 'rosterDayComment']),
    },
  },
  {
    name: 'foundu_approved_shifts_list',
    description: `List timesheet shifts (approve-shifts): worked and rostered shifts with approval state. Paged; the response carries meta.pagination. ${V3_NOTE}`,
    path: '/api/v3/approve-shifts',
    query: {
      ...shiftWindow,
      filterIds: idArray('approved shift IDs (still needs the date window)'),
      filterEmployee: idArray('employee IDs'),
      filterShiftType: { type: 'array', items: 'string', enum: ['all', 'unapproved', 'approved', 'declined'], description: 'Only these shift types (sent as an array).' },
      filterOfficeCode: idArray('office code IDs'),
      filterUpdatedSince: datetime('Only shifts updated since this time'),
      include: { type: 'string', enum: ['tags', 'tag-groups'], description: 'Related data to embed.' },
      ...v3Paging,
    },
    validate: filterIdsNeedWindow,
  },
  {
    name: 'foundu_unassigned_shifts_list',
    description: `List unassigned shifts (coverage gaps: shifts with nobody rostered). Paged; the response carries meta.pagination. ${V3_NOTE}`,
    path: '/api/v3/approve-shifts/unassigned',
    query: { ...shiftWindow, ...v3Paging },
  },

  // Leave
  {
    name: 'foundu_leave_applications_list',
    description: 'List leave applications with status and dates. Note: filter_updated_since also returns deleted applications.',
    path: '/api/v1/leave/leave-applications',
    query: {
      filter_employee_id: id('Only this employee ID.'),
      filter_operations: ids('operation IDs'),
      filter_branches: ids('roster branch IDs'),
      filter_leave_status: text('Leave status.'),
      filter_approved: flag('Only approved applications.'),
      filter_dates_between: dateRange('Only applications with dates in this window'),
      filter_from_date: date('Only applications on or after this date'),
      filter_to_date: date('Only applications before this date'),
      filter_upcoming: flag('Only upcoming applications.'),
      filter_leave_type: ids('leave rule IDs'),
      filter_updated_since: datetime('Only applications created, edited, approved, declined, or deleted since this time'),
      include: include(
        ['leave-rule', 'leave-application-hours', 'leave-shift', 'employee', 'leaveRule', 'leaveApplicationHours', 'leaveShift', 'leaveLedger', 'leaveLedgerV2'],
        'Attached files and audit logs are not offered.',
      ),
      order: { type: 'string', enum: ['id', 'startDate', 'endDate', 'requested', 'name', 'status'], wire: 'order[]', description: 'Sort field.' },
      order_direction: { type: 'string', enum: ['asc', 'desc'], wire: 'order[]', description: 'Sort direction (needs order).' },
      limit: limit(1000),
    },
    validate: (args) => {
      if (args.order_direction !== undefined && args.order === undefined) throw new ArgumentError('"order_direction" needs "order".');
    },
  },
  {
    name: 'foundu_leave_rules_list',
    description: 'List leave rules (the leave types an organisation uses).',
    path: '/api/v1/leave-rules',
    query: {
      filter: text('Match leave rule title.'),
      filter_pay_no_pay: { type: 'string', enum: ['pay', 'nopay'], description: 'Paid or unpaid leave types.' },
      filter_entitlement: flag('Leave out TOIL, RDO, and long service leave types.'),
      filter_categories: { type: 'csv', items: 'string', enum: ['pay', 'nopay', 'award_basis', 'archived'], description: 'Any of these categories (OR).' },
      order: order('id, title'),
      limit: limit(1000),
    },
  },
  {
    name: 'foundu_holidays_list',
    description: 'List public holidays.',
    path: '/api/v1/holidays',
    query: {
      filter_between_date: dateRange('Only holidays in this window'),
      include: include(['holiday-additional-details', 'additionalDetails']),
      limit: limit(1000),
    },
  },

  // Organisation
  {
    name: 'foundu_operations_list',
    description: 'List operations (foundU calls them "clients"): the businesses or sites staff are placed at.',
    path: '/api/v1/clients',
    query: {
      filter: text('Free-text search across ID, name, trade name, phone, and emails.'),
      filter_status: { type: 'string', enum: OPERATION_STATUS, description: 'Operation status.' },
      filter_branch_ids: idArray('roster branch IDs'),
      filter_operation_ids: ids('operation IDs'),
      filter_state_id: ids('state IDs'),
      filter_managers: ids('manager IDs'),
      filter_tags: ids('tag IDs'),
      filter_updated_since: updatedSince,
      include: include(['operation-tags', 'branch']),
      order: order('id, name, trade_name, office_code, rep_id'),
      limit: limit(1500),
    },
  },
  {
    name: 'foundu_operation_get',
    description: 'Get one operation (foundU "client") by ID.',
    path: '/api/v1/clients/{id}',
    pathParams: { id: 'Operation ID.' },
    query: { include: include(['operation-tags', 'branch']) },
  },
  {
    name: 'foundu_locations_list',
    description: 'List work locations. Paged; the response carries meta.pagination.',
    path: '/api/v2/locations',
    query: {
      statuses: { type: 'csv', items: 'string', description: 'Location statuses to include. foundU defaults to active.' },
      search: text('Match location ID (exact), name, or state (partial).'),
      sort_by: { type: 'string', enum: ['location', 'state'], description: 'Sort column.' },
      sort_direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (needs sort_by).' },
      limit: limit(1000, 'foundU documents no maximum; this server caps at 1000.'),
      page,
    },
  },
  {
    name: 'foundu_positions_list',
    description: 'List every position (job role) recorded in foundU.',
    path: '/api/v1/positions',
  },
  {
    name: 'foundu_managers_list',
    description: 'List managers.',
    path: '/api/v1/managers',
    query: { filter_updated_since: updatedSince, limit: limit(1000) },
  },
  {
    name: 'foundu_absence_reasons_list',
    description: 'List shift absence reasons (lookup for attendance data). Reason types: 1 Attendance, 2 Performance, 3 Termination.',
    path: '/api/v1/reason-list',
    query: {
      filter_by_reason_types: { type: 'csv', items: 'string', enum: ['1', '2', '3'], description: 'Only these reason types (1 Attendance, 2 Performance, 3 Termination).' },
      filter: text('Partial match on title.'),
      order: order('title'),
      limit: limit(1000),
    },
  },

  // Reports
  {
    name: 'foundu_attendance_performance_report',
    description: 'Attendance and performance report: absences and incidents (e.g. called in sick, no show) by employee, operation, and position. Paged.',
    path: '/api/v2/workforce-report-centre/attendance-and-performance',
    query: {
      duration: {
        type: 'string',
        required: true,
        // specific_date_range is left out: foundU documents no parameter carrying its date.
        enum: ['custom_date_range', 'this_month', 'last_month', 'last_week', 'last_30_days', 'last_90_days', 'last_120_days', 'this_financial_year', 'last_financial_year', 'all'],
        description: 'Reporting period. custom_date_range needs from_date and to_date.',
      },
      from_date: date('Start date (for custom_date_range)'),
      to_date: date('End date (for custom_date_range)'),
      filter_employee_ids: idArray('employee IDs'),
      filter_operation_ids: idArray('operation IDs'),
      filter_positions: idArray('position IDs'),
      filter_reason_type: { type: 'integer', minimum: 1, maximum: 3, description: 'Reason type: 1 Attendance, 2 Performance, 3 Termination.' },
      limit: limit(1000),
      page,
    },
    validate: (args) => {
      if (args.duration === 'custom_date_range' && (args.from_date === undefined || args.to_date === undefined)) {
        throw new ArgumentError('duration "custom_date_range" needs from_date and to_date.');
      }
    },
  },
  {
    name: 'foundu_qualifications_licences_report',
    description: 'Qualifications and licences report: who holds which qualification or licence and when it expires. Paged.',
    path: '/api/v2/workforce-report-centre/qualifications-and-licences',
    query: {
      filter: text('Free-text search across employees, qualifications, and licences.'),
      filter_employee_ids: ids('employee IDs'),
      filter_employee_status: text('Employee status.'),
      filter_qualification_types: text('Qualification types.'),
      filter_expire_status: text('Expiry status.'),
      filter_office_codes: ids('office code IDs'),
      order: order(
        'expiry_date',
        'Only this wire name is confirmed. foundU also documents sorting by capture date, qualification name, upload date, and days to expiry without giving their wire names.',
      ),
      limit: limit(500),
      page,
    },
  },
];

export const CATALOG_TOOLS: readonly ToolDef[] = ENDPOINTS.map(endpointTool);
