# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `foundu-mcp`, please email **security@wyretechnology.com** with a description of the issue, reproduction steps, and any relevant logs.

Please do not file a public GitHub issue for security reports.

We aim to acknowledge reports within two business days and provide a remediation plan within seven business days for confirmed issues.

## Scope

This server is read-only. Do not add tools that write to foundU, or that return payroll, banking, tax, HR, or medical data (see the README's "What is not exposed").

Access tokens are supplied at runtime: `FOUNDU_ACCESS_TOKEN` in stdio mode, or `X-FoundU-Access-Token` from the gateway. This server must never hold or use a refresh token; foundU refresh tokens are one-time use. Do not commit tokens, integration keys, `.env` files, or sample payroll extracts.

## Supported Versions

The latest minor version on the `main` branch is supported. Older versions are not patched.
