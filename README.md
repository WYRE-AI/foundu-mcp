# FoundU MCP Server

MCP server for the [FoundU](https://www.foundu.com.au/) partner API, scoped to the Infinity Investments / Steadfast engagement.

FoundU is the Australian workforce platform Infinity uses for rostering and time capture. This server exposes **roster summaries, timesheet hour summaries, and labour-cost aggregates** to the WYRE fleet. It is a read-only aggregate client. Pay rates, bank details, tax file numbers, and employee personal data are refused and stripped if an upstream payload contains them.

The public OpenAPI is partner-gated. **Infinity Ben must grant partner API access** before any tool can return live data. Until that grant exists, tools answer with a structured `not_configured` or `not_authorized` error and do not call FoundU.

## Data residency and credentials

- FoundU runs in Australia. `FOUNDU_BASE_URL` must be an `https` origin on `foundu.com.au` (for example `https://tenant.foundu.com.au`). Other hosts are refused so the partner token is not sent outside FoundU's Australian platform.
- This process does not store FoundU responses. Workforce data should remain in Australia at rest. Processing outside Australia needs a written agreement.
- **Steadfast owns credential rotation.** WYRE does not keep standing client credentials. Supply the token at runtime, through the environment in stdio mode or through gateway headers in HTTP mode.
- Do not commit tokens, `.env` files, or sample payroll extracts.

## Tools

| Tool | What it returns |
| --- | --- |
| `foundu_status` | Configuration, Australian residency, and whether a partner token is present. Does not call FoundU. |
| `foundu_roster_summary` | Shift counts and rostered hours by location, operation, position, or day. |
| `foundu_hours_summary` | Rostered and worked hours by location, operation, position, or day. |
| `foundu_labour_cost_aggregates` | Rolled-up labour cost totals for those same dimensions. Individual pay rates are removed from the payload. |
| `foundu_raw_request` | `GET` against an allowlisted aggregate path only. |

`foundu_raw_request` accepts only these prefixes:

- `/api/v1/aggregates/rosters`
- `/api/v1/aggregates/hours`
- `/api/v1/aggregates/timesheets`
- `/api/v1/aggregates/labour-cost`

Employee records, payroll, pay rates, bank details, tax file numbers, single-resource ids, and any non-GET method are refused before a request is sent. These prefixes are the placeholder aggregate surface until the partner API catalogue is available. Widen them only to other roster, hours, or labour-cost aggregates.

Filters on the typed tools are `from`, `to` (`YYYY-MM-DD`, at most 366 days), `locationId`, `operationId`, and `groupBy` (`location`, `operation`, `position`, `day`).

## Errors

Missing `FOUNDU_BASE_URL` or `FOUNDU_API_TOKEN` (and missing gateway headers) produce:

```json
{ "code": "not_configured", "message": "..." }
```

A refused path, a non-Australian base URL, or an HTTP 401/403 from FoundU produces:

```json
{ "code": "not_authorized", "message": "..." }
```

Both are returned as MCP tool errors (`isError: true`). The 401/403 text tells the caller that Infinity Ben must grant partner API access. Upstream bodies are not copied into the error, so a rejected call cannot echo a token or a tax file number.

## Configuration

### Single-tenant (stdio)

```bash
FOUNDU_BASE_URL=https://tenant.foundu.com.au
FOUNDU_API_TOKEN=
```

Copy `.env.example` to `.env` and fill the token locally. The example token is empty on purpose.

### Gateway (HTTP)

The WYRE gateway injects one tenant per request:

- `x-foundu-base-url`
- `x-foundu-api-token`

A partial header pair does not fall back to the process environment. When `CONDUIT_S2S_SECRET` is set, `/mcp` requires a valid `X-Gateway-S2S` signature. `/health` stays unauthenticated so container liveness does not depend on partner credentials.

Default transport is stdio. HTTP mode is `MCP_TRANSPORT=http` or `--http`, which is what the container image sets. The MCP path is `/mcp`. The health path is `/health` and always returns `200 {"status":"ok","service":"foundu-mcp"}`.

## Run

```bash
npm install
npm test
npm run typecheck
npm run build

# stdio
npm start

# HTTP on port 8080
npm run start:http
```

### Docker

```bash
docker build -t foundu-mcp .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e FOUNDU_BASE_URL=https://tenant.foundu.com.au \
  -e FOUNDU_API_TOKEN \
  foundu-mcp
```

The image listens on `8080`, runs as a non-root user, and probes `/health`.

### Gateway call

```bash
curl -s http://localhost:8080/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'x-foundu-base-url: https://tenant.foundu.com.au' \
  -H 'x-foundu-api-token: <rotated by Steadfast>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"foundu_roster_summary","arguments":{"groupBy":"location"}}}'
```

## Development

Node.js 20 or newer. Tests use mocked `fetch` and do not call FoundU. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).

## Support

- [GitHub Issues](https://github.com/WYRE-AI/foundu-mcp/issues)
- [MCP protocol](https://modelcontextprotocol.io/)
