import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleHoursSummary, handleLabourCostAggregates, handleRosterSummary } from '../src/tools/aggregates.js';

const TOKEN = 'partner-token-not-for-logs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('aggregate tools', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns not_configured when partner credentials are missing', async () => {
    delete process.env.FOUNDU_BASE_URL;
    delete process.env.FOUNDU_API_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleRosterSummary({});
    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('not_configured');
    expect(payload.message).toMatch(/Infinity Ben/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a per-employee groupBy before any network call', async () => {
    delete process.env.FOUNDU_BASE_URL;
    delete process.env.FOUNDU_API_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleRosterSummary({ groupBy: 'employee' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('not_authorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an employee filter before any network call', async () => {
    process.env.FOUNDU_BASE_URL = 'https://tenant.foundu.com.au';
    process.env.FOUNDU_API_TOKEN = TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleHoursSummary({ employeeId: 'e-1' });
    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('not_authorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requests the roster aggregate and strips pay rates from the payload', async () => {
    process.env.FOUNDU_BASE_URL = 'https://tenant.foundu.com.au';
    process.env.FOUNDU_API_TOKEN = TOKEN;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      rows: [{ locationId: 'qld', rosteredHours: 40, shiftCount: 6, payRate: 31 }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleRosterSummary({
      from: '2026-09-01',
      to: '2026-09-07',
      groupBy: 'location',
    });
    expect(result.isError).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(
      'https://tenant.foundu.com.au/api/v1/aggregates/rosters?from=2026-09-01&to=2026-09-07&groupBy=location',
    );
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(String(url)).not.toContain(TOKEN);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.scope).toBe('roster_summary');
    expect(payload.aggregateOnly).toBe(true);
    expect(payload.data.rows[0]).toEqual({ locationId: 'qld', rosteredHours: 40, shiftCount: 6 });
    expect(payload.redactedFields).toContain('$.rows[0].payRate');
    expect(result.content[0].text).not.toContain(TOKEN);
  });

  it('maps HTTP 401 to not_authorized without returning the upstream body', async () => {
    process.env.FOUNDU_BASE_URL = 'https://tenant.foundu.com.au';
    process.env.FOUNDU_API_TOKEN = TOKEN;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`token ${TOKEN} tfn 123456789`, {
      status: 401,
      headers: { 'content-type': 'text/plain' },
    })));

    const result = await handleLabourCostAggregates({});
    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('not_authorized');
    expect(payload.message).toMatch(/Infinity Ben/);
    expect(result.content[0].text).not.toContain(TOKEN);
    expect(result.content[0].text).not.toContain('123456789');
  });

  it('calls the hours and labour-cost aggregate paths', async () => {
    process.env.FOUNDU_BASE_URL = 'https://tenant.foundu.com.au/';
    process.env.FOUNDU_API_TOKEN = TOKEN;
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({
      workedHours: 10,
      labourCost: 100,
      employeeCount: 2,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const hours = await handleHoursSummary({ locationId: 'bne' });
    const labour = await handleLabourCostAggregates({ operationId: 'hire' });
    expect(hours.isError).toBeUndefined();
    expect(labour.isError).toBeUndefined();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/aggregates/hours?locationId=bne');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/v1/aggregates/labour-cost?operationId=hire');
    expect(JSON.parse(labour.content[0].text).data.employeeCount).toBe(2);
  });
});
