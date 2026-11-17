#!/usr/bin/env node
// Spawns the built stdio server (dist/index.js) and checks the tool surface
// plus credential and argument handling. Makes no network call: the upstream
// host is fixed, so every tool call made here is one the server must refuse
// before any request (no token configured, or a path-traversal ID). Upstream
// round-trips are covered by the mocked tests in src/__tests__.
// Usage: npm run build && npm run smoke
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The whole surface: every tool is read tier. The per-employee pay reports
// were left out of v1 and must not be reachable.
const REMOVED_PAY_REPORTS = ['foundu_labour_management_report', 'foundu_timesheet_analysis_report'];
const EXPECTED = [
  'foundu_absence_reasons_list',
  'foundu_approved_shifts_list',
  'foundu_attendance_performance_report',
  'foundu_clock_logs_list',
  'foundu_employee_get',
  'foundu_employee_leave_balances_get',
  'foundu_employee_leave_history_list',
  'foundu_employee_positions_list',
  'foundu_employee_shifts_list',
  'foundu_employees_search',
  'foundu_holidays_list',
  'foundu_leave_applications_list',
  'foundu_leave_rules_list',
  'foundu_locations_list',
  'foundu_managers_list',
  'foundu_operation_get',
  'foundu_operations_list',
  'foundu_positions_list',
  'foundu_qualifications_licences_report',
  'foundu_roster_get',
  'foundu_rosters_list',
  'foundu_shift_history_list',
  'foundu_states_list',
  'foundu_unassigned_shifts_list',
];

function fail(message) {
  console.error(`smoke-stdio: FAIL - ${message}`);
  process.exitCode = 1;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  // No FOUNDU_ACCESS_TOKEN on purpose.
  env: { PATH: process.env.PATH ?? '', LOG_LEVEL: 'error' },
});
const client = new Client({ name: 'smoke', version: '0.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  if (tools.length !== EXPECTED.length) fail(`expected ${EXPECTED.length} tools, got ${tools.length}`);
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED)) fail(`tool names differ: ${names.join(', ')}`);
  if (!tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)) fail('a tool is not annotated read-only');

  const noToken = await client.callTool({ name: 'foundu_states_list', arguments: {} });
  const text = noToken.content?.[0]?.text ?? '';
  if (!noToken.isError || !/FOUNDU_ACCESS_TOKEN/.test(text)) fail(`missing token was not refused: ${text.slice(0, 200)}`);

  const unknown = await client.callTool({ name: 'foundu_employees_delete', arguments: {} });
  if (!unknown.isError) fail('unknown tool did not error');

  for (const name of REMOVED_PAY_REPORTS) {
    const res = await client.callTool({ name, arguments: {} });
    if (!res.isError || res.content?.[0]?.text !== `Error: Unknown tool: ${name}`) fail(`${name} is reachable`);
  }

  if (!process.exitCode) console.log(`smoke-stdio: OK (${tools.length} read-only tools; pay reports absent; missing token refused without a network call)`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await client.close().catch(() => {});
}
