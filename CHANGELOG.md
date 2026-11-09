# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- 26 read-only tools over the official foundU API (`https://api.foundu.com.au`): employees, positions, leave history and balances, employee shifts, shift history, clock logs, rosters, approved and unassigned shifts, leave applications and rules, holidays, operations, locations, positions, managers, absence reasons, and the attendance, qualifications, labour-management, and timesheet-analysis reports. All are `read` tier.
- OAuth2 bearer access tokens: `X-FoundU-Access-Token` per request in gateway mode, `FOUNDU_ACCESS_TOKEN` for stdio. The server never refreshes tokens.
- Template security contract: fixed origin and exact-path check, `redirect: "manual"`, path-ID validation and encoding, enum/date/limit validation, bounded upstream reads, credential and payroll-field redaction in output and logs, fail-closed S2S startup, gateway-mode lock, and `X-Conduit-Tool-Tiers` narrowing.
- Conservative throttling (`FOUNDU_MAX_CONCURRENCY`) and bounded retry on 429/503.
- Stdio smoke test, destructive-tool lint, mcp-assert evals, gitleaks workflow, and CODEOWNERS.

### Changed

- Release workflow pinned to the current reusable workflow, with `actions: read` and `fail-on-severity: HIGH,CRITICAL`.
- Container image: digest-pinned `node:22-alpine`, `npm ci --ignore-scripts`, non-root user, `AUTH_MODE=gateway`.
- Test runner on vitest 4.1.12 (clears the critical vitest/tinypool advisories); runtime dependency is only `@modelcontextprotocol/sdk`.

### Removed

- The unpublished scaffold's invented `/api/v1/aggregates/*` tools, `foundu_raw_request`, `foundu_status`, and the per-tenant base URL and static API token settings (`FOUNDU_BASE_URL`, `FOUNDU_API_TOKEN`, `x-foundu-base-url`, `x-foundu-api-token`). None of those paths exist in the foundU API.
