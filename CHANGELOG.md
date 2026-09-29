# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial FoundU MCP server for the Infinity Investments / Steadfast engagement.
- Aggregate-only tools: `foundu_status`, `foundu_roster_summary`, `foundu_hours_summary`, `foundu_labour_cost_aggregates`, and `foundu_raw_request`.
- HTTP client for `FOUNDU_BASE_URL` and `FOUNDU_API_TOKEN`, with `x-foundu-base-url` and `x-foundu-api-token` in gateway mode.
- Path allowlist, response redaction, and Australian `foundu.com.au` origin check. Pay rates, bank details, tax file numbers, and employee personal data are refused.
