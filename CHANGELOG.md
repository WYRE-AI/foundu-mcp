# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- 26 read-only tools over the official foundU API (`https://api.foundu.com.au`): employees, positions, leave history and balances, employee shifts, shift history, clock logs, rosters, approved and unassigned shifts, leave applications and rules, holidays, operations, locations, positions, managers, absence reasons, and the attendance, qualifications, labour-management, and timesheet-analysis reports. The labour-management and timesheet-analysis reports are `admin` tier and off by default, because they return per-employee pay figures; the rest are `read` tier.
- `possibly_truncated: true` on `{ data: [...] }` results from tools that declare `limit` but no `page`, when the result reaches the `limit` sent or no `limit` was sent. Those tools say in their description that there is no next page. Tools that declare neither `limit` nor `page` (such as `foundu_positions_list`) and results without a `data` array are never marked, so an absent marker does not prove a list is complete.
- `filterIds` on `foundu_approved_shifts_list` requires `filterStartDate` and `filterEndDate`, as foundU documents.
- OAuth2 bearer access tokens: `X-FoundU-Access-Token` per request in gateway mode, `FOUNDU_ACCESS_TOKEN` for stdio. The server never refreshes tokens.
- Template security contract: fixed origin and exact-path check, `redirect: "manual"`, path-ID validation and encoding, enum/date/limit validation, bounded upstream reads, credential and payroll-field redaction in output and logs, fail-closed S2S startup, gateway-mode lock, and `X-Conduit-Tool-Tiers` narrowing.
- Key-name redaction also covers a bare `rate`, award/loading/cost rates, passport, licence numbers, ABNs, emergency contacts, and tax scales. `*_rate_type` labels such as `pay_rate_type` are kept.
- Key-name redaction removes every pay-bearing field, not only qualified pay rates: any `rate`/`rates` key (`payable_rate` in the leave ledger, `position_casual_rate` and `position_base_rate` in positions, allowance `rates`, `rate_unloaded`), pay and amount fields with a pay qualifier (`Total Pay`, `overtime_pay`, `penalty_amount`, `Taxable Allowance Paid`), earnings, and tax declaration fields. Leave hours (`amount`), counts, IDs, and labels such as `pay_rate_type` and `pay_nopay` are kept.
- Conservative throttling per access token (`FOUNDU_MAX_CONCURRENCY`), so one tenant never queues behind another, and bounded retry on 429/503 that releases its permit while backing off. One deadline (`FOUNDU_REQUEST_TIMEOUT_MS`) covers queueing, every attempt, and backoff, and a cancelled call leaves the queue at once.
- Stdio smoke test, destructive-tool lint, mcp-assert evals, gitleaks workflow, and CODEOWNERS.

### Changed

- Release workflow pinned to the current reusable workflow, with `actions: read` and `fail-on-severity: HIGH,CRITICAL`.
- Container image: digest-pinned `node:22-alpine`, `npm ci --ignore-scripts`, non-root user, `AUTH_MODE=gateway`.
- Test runner on vitest 4.1.12 (clears the critical vitest/tinypool advisories); runtime dependency is only `@modelcontextprotocol/sdk`.

### Removed

- The unpublished scaffold's invented `/api/v1/aggregates/*` tools, `foundu_raw_request`, `foundu_status`, and the per-tenant base URL and static API token settings (`FOUNDU_BASE_URL`, `FOUNDU_API_TOKEN`, `x-foundu-base-url`, `x-foundu-api-token`). None of those paths exist in the foundU API.
