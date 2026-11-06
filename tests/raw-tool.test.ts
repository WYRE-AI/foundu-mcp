import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleRawRequest, rawRequestTool } from '../src/tools/raw.js';

describe('foundu_raw_request', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    vi.unstubAllGlobals();
  });

  it('schema is GET-only and requires a path', () => {
    const props = (rawRequestTool.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
    expect(rawRequestTool.inputSchema.required).toContain('path');
    expect(props.method.enum).toEqual(['GET']);
    expect(rawRequestTool.description).toMatch(/aggregates\/rosters/);
    expect(rawRequestTool.description).toMatch(/pay-rate/i);
  });

  it('refuses payroll and employee paths before credentials or the network', async () => {
    delete process.env.FOUNDU_BASE_URL;
    delete process.env.FOUNDU_API_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const path of ['/api/v1/employees', '/api/v1/payroll/pay-rates', '/api/v1/aggregates/hours/by-employee']) {
      const result = await handleRawRequest({ path });
      const payload = JSON.parse(result.content[0].text);
      expect(result.isError).toBe(true);
      expect(payload.code).toBe('not_authorized');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-GET method', async () => {
    const result = await handleRawRequest({ method: 'POST', path: '/api/v1/aggregates/rosters' });
    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('not_authorized');
  });

  it('returns not_configured for an allowlisted path when credentials are missing', async () => {
    delete process.env.FOUNDU_BASE_URL;
    delete process.env.FOUNDU_API_TOKEN;
    const result = await handleRawRequest({ path: '/api/v1/aggregates/timesheets' });
    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('not_configured');
  });

  it('GETs an allowlisted timesheet aggregate and drops bank details', async () => {
    process.env.FOUNDU_BASE_URL = 'https://tenant.foundu.com.au';
    process.env.FOUNDU_API_TOKEN = 'token-value';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      workedHours: 12,
      bankAccount: { bsb: '000-000', accountNumber: '999' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleRawRequest({
      path: '/api/v1/aggregates/timesheets/by-day',
      query: { from: '2026-09-01' },
    });
    expect(result.isError).toBeUndefined();
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://tenant.foundu.com.au/api/v1/aggregates/timesheets/by-day?from=2026-09-01',
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.data).toEqual({ workedHours: 12 });
    expect(payload.redactedFields).toContain('$.bankAccount');
    expect(result.content[0].text).not.toContain('000-000');
  });

  it('refuses a sensitive query parameter on an otherwise allowed path', async () => {
    process.env.FOUNDU_BASE_URL = 'https://tenant.foundu.com.au';
    process.env.FOUNDU_API_TOKEN = 'token-value';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleRawRequest({
      path: '/api/v1/aggregates/labour-cost',
      query: { include: 'payRate' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('not_authorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
