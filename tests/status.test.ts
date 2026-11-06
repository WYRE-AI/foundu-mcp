import { describe, it, expect, afterEach } from 'vitest';
import { handleStatus, statusTool } from '../src/tools/status.js';
import { TOOLS } from '../src/server.js';

describe('foundu_status', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('declares the expected tool name', () => {
    expect(statusTool.name).toBe('foundu_status');
  });

  it('lists only the aggregate tool surface', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      'foundu_status',
      'foundu_roster_summary',
      'foundu_hours_summary',
      'foundu_labour_cost_aggregates',
      'foundu_raw_request',
    ]);
    const names = TOOLS.map((tool) => tool.name).join(' ');
    expect(names).not.toMatch(/pay|bank|tfn|employee/i);
  });

  it('reports absent credentials without calling FoundU', async () => {
    delete process.env.FOUNDU_BASE_URL;
    delete process.env.FOUNDU_API_TOKEN;
    const result = await handleStatus();
    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBeUndefined();
    expect(payload.ok).toBe(true);
    expect(payload.hasCredentials).toBe(false);
    expect(payload.residency).toBe('unconfigured');
    expect(payload.dataResidency).toBe('AU');
    expect(payload.omitted).toContain('pay_rates');
    expect(payload.partnerAccess).toMatch(/Infinity Ben/);
    expect(payload.credentialRotation).toMatch(/Steadfast/);
  });

  it('reports an Australian host and never echoes the token', async () => {
    process.env.FOUNDU_BASE_URL = 'https://tenant.foundu.com.au';
    process.env.FOUNDU_API_TOKEN = 'super-secret-token';
    const result = await handleStatus();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.hasCredentials).toBe(true);
    expect(payload.baseUrlHost).toBe('tenant.foundu.com.au');
    expect(payload.residency).toBe('au');
    expect(result.content[0].text).not.toContain('super-secret-token');
  });
});
