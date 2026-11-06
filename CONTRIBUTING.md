# Contributing to FoundU MCP Server

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

## Scope

Tools stay limited to roster, hours, and labour-cost aggregates. Pull requests that add pay rates, bank details, tax file numbers, payroll records, or employee personal-data endpoints will not be accepted. `foundu_raw_request` must keep its path allowlist.

Partner API paths are not in the public OpenAPI. When Infinity Ben grants access, update the allowlisted aggregate prefixes only. Steadfast owns credential rotation; do not commit tokens or `.env` files.

## Development

Requirements: Node.js 20 or newer, npm 10 or newer.

```bash
git clone https://github.com/WYRE-AI/foundu-mcp.git
cd foundu-mcp
npm install
cp .env.example .env
npm test
npm run typecheck
```

Tests mock `fetch`. Do not point the test suite at a live FoundU tenant.

## Commit messages

This repository uses [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation
- `test:` tests
- `chore:` tooling

## License

Contributions are licensed under the Apache License 2.0.
