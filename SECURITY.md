# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `foundu-mcp`, please email **security@wyretechnology.com** with a description of the issue, reproduction steps, and any relevant logs.

Please do not file a public GitHub issue for security reports.

We aim to acknowledge reports within two business days and provide a remediation plan within seven business days for confirmed issues.

## Scope

This server is limited to FoundU roster, hours, and labour-cost aggregates. Do not add tools that return pay rates, bank details, tax file numbers, or bulk employee personal data.

Partner API tokens are supplied at runtime by Steadfast (environment variables or `x-foundu-*` gateway headers). Do not commit tokens, tenant secrets, or sample payroll extracts.

## Supported Versions

The latest minor version on the `main` branch is supported. Older versions are not patched.
