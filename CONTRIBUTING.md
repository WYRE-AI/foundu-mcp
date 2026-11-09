# Contributing to foundU MCP Server

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

## Scope

Every tool is a GET against a documented endpoint in the [foundU OpenAPI](https://api.foundu.com.au/api/reference), declared in `src/tools/catalog.ts`. Pull requests that add writes, or that expose payroll, banking, tax, HR, or medical data, will not be accepted. Keep the employee `include` allowlist closed.

Do not add token refresh to this server. foundU refresh tokens are one-time use; only the gateway may rotate them.

## Development

Requirements: Node.js 22 or newer.

```bash
npm ci --ignore-scripts
npm test
npm run lint
npm run typecheck
npm run build && npm run smoke
```

Tests mock `fetch`. Do not point the test suite at a live foundU tenant. Every new tool needs a row in `src/__tests__/endpoints.test.ts` pinning its exact path and query.

## Commit messages

This repository uses [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation
- `test:` tests
- `chore:` tooling

## License

Contributions are licensed under the Apache License 2.0.
