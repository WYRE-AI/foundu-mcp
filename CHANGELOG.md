# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- 24 read-only tools over the official foundU API (`https://api.foundu.com.au`), all `read` tier: employees, positions, leave history and balances, employee shifts, shift history, clock logs, rosters, approved and unassigned shifts, leave applications and rules, holidays, operations, locations, positions, managers, absence reasons, and the attendance and qualifications reports.
- `possibly_truncated: true` on `{ data: [...] }` results from tools that declare `limit` but no `page`, when the result reaches the `limit` sent or no `limit` was sent. Those tools say in their description that there is no next page. Tools that declare neither `limit` nor `page` (such as `foundu_positions_list`) and results without a `data` array are never marked, so an absent marker does not prove a list is complete.
- `filterIds` on `foundu_approved_shifts_list` requires `filterStartDate` and `filterEndDate`, as foundU documents.
- OAuth2 bearer access tokens: `X-FoundU-Access-Token` per request in gateway mode, `FOUNDU_ACCESS_TOKEN` for stdio. The server never refreshes tokens.
- Template security contract: fixed origin and exact-path check, `redirect: "manual"`, path-ID validation and encoding, enum/date/limit validation, bounded upstream reads, credential and payroll-field redaction in output and logs, fail-closed S2S startup, gateway-mode lock, and `X-Conduit-Tool-Tiers` narrowing.
- Key-name redaction of every pay and money field: any `rate`/`rates` key (`payable_rate` in the leave ledger, `position_casual_rate` and `position_base_rate` in positions, allowance `rates`, `rate_unloaded`), any cost, costing, charge, price, fee, gross, net, or dollar key (an approved shift's untyped `costing` array, `total_cost`, `Charge Out Standard`), pay and amount fields with a pay qualifier (`Total Pay`, `overtime_pay`, `penalty_amount`, `Taxable Allowance Paid`), salary, wages, and earnings. It also removes tax and STP declaration data (residency, income type, `training_support_loan`, `seniors_pensioners`, working holiday maker and PALM flags), date of birth, gender, home address, next of kin, citizenship, passport and licence numbers, WWCC and police checks, ABNs, emergency contacts, medical data, and whole `hr-details`, `employee-stp-compliance`, `employee-contact`, `emergency-contact`, `custom-fields`, `current-medical`, and `onboarding-overview` side-loads (documented in leave applications with `include=employee`). Leave hours (`amount`), counts, pagination totals, IDs, codes, business addresses, and labels such as `pay_rate_type`, `cost_code`, and `pay_nopay` are kept.
- When the side-loaded `included` block alone exceeds the output cap, or leaves no room for a single item, it is dropped with a `truncation_hint` instead of cutting the JSON, so `meta.pagination` always survives.
- When the first item of a page is larger than the output cap on its own, it is returned cut short as marked JSON text in `truncated_first_item`, with the pagination fields kept and a hint that says so, instead of an empty page.
- Linear-time text redaction: JWTs are found with a single-pass scanner instead of a backtracking regex, so a 4 MiB upstream body of `eyJ` runs redacts in milliseconds rather than hours. Back-to-back JWTs, and JWTs glued to other text, are redacted whole. An oversized page is redacted once, then fitted from the redacted pieces.
- A malformed HTTP request target (such as `//h:99999/`) gets 400 instead of an unhandled rejection that stopped the process.
- Conservative throttling per access token (`FOUNDU_MAX_CONCURRENCY`), so one tenant never queues behind another, and bounded retry on 429/503 that releases its permit while backing off. One deadline (`FOUNDU_REQUEST_TIMEOUT_MS`) covers queueing, every attempt, and backoff, and a cancelled call leaves the queue at once.
- Stdio smoke test, destructive-tool lint, mcp-assert evals, gitleaks workflow, and CODEOWNERS.

### Changed

- Release workflow pinned to the current reusable workflow, with `actions: read` and `fail-on-severity: HIGH,CRITICAL`.
- Container image: digest-pinned `node:22-alpine`, `npm ci --ignore-scripts`, non-root user, `AUTH_MODE=gateway`.
- Test runner on vitest 4.1.12 (clears the critical vitest/tinypool advisories); runtime dependency is only `@modelcontextprotocol/sdk`.
- `server.json` declares the OCI package as `streamable-http` on `http://localhost:{MCP_HTTP_PORT}/mcp`, with the `X-Gateway-S2S` and `X-FoundU-Access-Token` headers and `CONDUIT_S2S_SECRET`, matching what the image runs (`MCP_TRANSPORT=http`, `AUTH_MODE=gateway`). It previously declared `stdio`, which the image does not speak by default.

### Removed

- The `admin` tier and the two reports in it, `foundu_labour_management_report` and `foundu_timesheet_analysis_report`: both return per-employee pay, which breaks the read-only v1 contract. The README notes them as a possible future admin feature. `FOUNDU_TOOL_TIERS=read,admin` now fails startup.
- The unpublished scaffold's invented `/api/v1/aggregates/*` tools, `foundu_raw_request`, `foundu_status`, and the per-tenant base URL and static API token settings (`FOUNDU_BASE_URL`, `FOUNDU_API_TOKEN`, `x-foundu-base-url`, `x-foundu-api-token`). None of those paths exist in the foundU API.
