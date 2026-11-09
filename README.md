# foundU MCP Server

Read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for the [foundU](https://www.foundu.com.au/) workforce API: employees, rosters, shifts, clock logs, timesheets, leave, and the workforce and labour reports.

- 26 tools, all `read` tier, all GET, all annotated `readOnlyHint: true`.
- Fixed upstream host `https://api.foundu.com.au`. There is no base-URL setting; the tenant is implied by the access token.
- Payroll, banking, and tax data are out of scope. See [What is not exposed](#what-is-not-exposed).

## Authentication

foundU uses OAuth2 (Laravel Passport), bootstrapped from a customer-issued integration key:

1. A customer admin creates a custom integration in **Integrations > Integration Centre**, picks permission areas and search restrictions, and foundU emails an integration key.
2. The key is exchanged once for OAuth2 tokens.
3. Every API call sends `Authorization: Bearer <access_token>`.
4. Refresh tokens are **one-time use** and rotate. A spent or lost refresh token cannot be recovered; the integration must be recreated. An integration with no API calls for 3 months must be reconfigured.

Because of (4), **this server never sees the integration key, client credentials, or refresh token, and never refreshes.** It only accepts a short-lived access token:

- **Gateway mode** (`AUTH_MODE=gateway`, the container default): the token arrives per request on `X-FoundU-Access-Token`. The gateway owns exchange, storage, refresh, and rotation. The process never reads credentials from the environment, and the token is scoped to the one request (AsyncLocalStorage), so tenants never share a token.
- **stdio / env mode**: `FOUNDU_ACCESS_TOKEN`. Useful for local testing with a token you obtained yourself.

Send the raw token; a value with its own `Bearer ` prefix is refused. foundU answers a missing or expired token with a `302` to `/login`; this server refuses every redirect and says so.

When setting up an integration, grant least privilege: People, Rosters, Timesheets/Approved shifts, Leave, and Reports. Leave payroll and financial areas off.

## Tools

| Tool | foundU endpoint |
| --- | --- |
| `foundu_states_list` | `GET /api/v1/state` (cheap connection check) |
| `foundu_employees_search` | `GET /api/v2/employees` |
| `foundu_employee_get` | `GET /api/v2/employees/{id}` |
| `foundu_employee_positions_list` | `GET /api/v1/employees/{id}/positions` |
| `foundu_employee_leave_history_list` | `GET /api/v2/employees/{id}/leave-history` |
| `foundu_employee_leave_balances_get` | `GET /api/v1/employee-leave-ledger/{employeeId}` |
| `foundu_employee_shifts_list` | `GET /api/v1/employee-shifts` |
| `foundu_shift_history_list` | `GET /api/v1/shift-history` |
| `foundu_clock_logs_list` | `GET /api/v1/clock-logs` |
| `foundu_rosters_list` | `GET /api/v2/roster-branches` |
| `foundu_roster_get` | `GET /api/v2/roster-branches/{id}` |
| `foundu_approved_shifts_list` | `GET /api/v3/approve-shifts` |
| `foundu_unassigned_shifts_list` | `GET /api/v3/approve-shifts/unassigned` |
| `foundu_leave_applications_list` | `GET /api/v1/leave/leave-applications` |
| `foundu_leave_rules_list` | `GET /api/v1/leave-rules` |
| `foundu_holidays_list` | `GET /api/v1/holidays` |
| `foundu_operations_list` | `GET /api/v1/clients` |
| `foundu_operation_get` | `GET /api/v1/clients/{id}` |
| `foundu_locations_list` | `GET /api/v2/locations` |
| `foundu_positions_list` | `GET /api/v1/positions` |
| `foundu_managers_list` | `GET /api/v1/managers` |
| `foundu_absence_reasons_list` | `GET /api/v1/reason-list` |
| `foundu_attendance_performance_report` | `GET /api/v2/workforce-report-centre/attendance-and-performance` |
| `foundu_qualifications_licences_report` | `GET /api/v2/workforce-report-centre/qualifications-and-licences` |
| `foundu_labour_management_report` | `GET /api/v2/financial-report-centre/labour-management` |
| `foundu_timesheet_analysis_report` | `GET /api/v2/award-interpretation/analyse/time-based` |

Parameters follow the [official OpenAPI](https://api.foundu.com.au/api/reference) by name. Every tool validates its arguments before any request:

- Path IDs must be positive integers; `.`/`..`/separators/encoded separators are refused.
- Enums (statuses, `include` values, report durations, `group_by`) are checked.
- Dates are `YYYY-MM-DD`; timestamps also accept `YYYY-MM-DD HH:mm:ss`; ranges are `start,end`.
- `limit` is capped at foundU's documented per-page maximum.
- Lists foundU documents as comma-separated go on the wire as `a=1,2`; lists it types as arrays go as `a[]=1&a[]=2`.
- Pagination (`page`, where documented) is passed straight through. No tool fetches more than one page.

**Unverified:** foundU documents the two `/api/v3/approve-shifts` endpoints as GET with a JSON body. HTTP clients cannot send a body on GET, so their filters are sent as query parameters (with bracket arrays). Laravel normally reads both the same way, but this has not been checked against a live tenant.

## What is not exposed

- Any write: no POST, PUT, PATCH, or DELETE, including approve/decline shifts, clock start/end, roster changes, and uploads.
- Employee financial details (TFN, bank, super), payslips, paycycles, operation pay rates, deductions, ETP, the payroll-activity and deduction/reimbursement reports, invoice and compliance documents, the visa checklist, and the read-shaped `POST /api/v1/accounting/payroll-ledger-map/report`.
- Employee `include` values are allowlisted. `hr-details`, `custom-fields`, `current-medical`, contact, and onboarding data cannot be requested. Shift `costing` and documents, and leave attachments, are not offered either.

As defence in depth, every response is also scrubbed by key name before it reaches the model: tax file numbers, bank and account numbers, superannuation, pay rates, salary and wages, date of birth, visa and medical fields, and any credential field. Labour-report totals such as `Total Pay` and `Total Hours` are kept; they are the point of that report.

## Security contract

- Fixed origin, and every built URL is checked to stay on `https://api.foundu.com.au` at exactly the expected path.
- `redirect: "manual"`; every 3xx is an error.
- Upstream bodies are bounded while streaming (4 MiB default) and tool output is capped (60,000 characters), shrinking list pages structurally so pagination fields survive.
- foundU publishes no rate limits: upstream calls are throttled per process (`FOUNDU_MAX_CONCURRENCY`, default 4), and `429`/`503` are retried at most twice, never waiting more than 5 seconds. A longer `Retry-After` is reported, not waited out.
- Errors keep the HTTP status, foundU's message and validation errors, and any request ID.
- The token is redacted from every tool result and log line by exact match, plus Bearer/JWT patterns and any `auth_token=` query value.
- HTTP transport refuses to start without a real `CONDUIT_S2S_SECRET` (32+ characters, not a placeholder) and checks `X-Gateway-S2S` on every `/mcp` request. `/health` is open and reads no credentials.
- `X-Conduit-Tool-Tiers` can only narrow the tool set; a present but empty header exposes no tools.

## Configuration

See [.env.example](.env.example). The main settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FOUNDU_ACCESS_TOKEN` | | Access token for stdio and `AUTH_MODE=env`. Ignored in gateway mode. |
| `AUTH_MODE` | `env` (image: `gateway`) | `gateway` reads only `X-FoundU-Access-Token`. |
| `FOUNDU_TOOL_TIERS` | `read` | The only tier. |
| `CONDUIT_S2S_SECRET` | | Required for HTTP. |
| `MCP_TRANSPORT` | `stdio` (image: `http`) | |
| `FOUNDU_MAX_CONCURRENCY` | `4` | Upstream calls in flight per process. |

## Development

Node.js 22 or newer.

```bash
npm ci --ignore-scripts
npm run build
npm test            # mocked fetch; no network
npm run lint
npm run typecheck
npm run smoke       # spawns dist/index.js over stdio; no network
```

Data note: foundU data is Australian. Confirm the customer's data-residency requirements before hosting this server outside Australia.

## License

Apache License 2.0. See [LICENSE](LICENSE).
