import { describe, it, expect, vi } from 'vitest';
import { createFounduClient } from '../src/client.js';
import { FounduError } from '../src/errors.js';

describe('FoundU HTTP client', () => {
  const credentials = {
    baseUrl: 'https://tenant.foundu.com.au',
    apiToken: 'do-not-log',
  };

  it('refuses a non-AU base URL without calling fetch', async () => {
    const fetchMock = vi.fn();
    const client = createFounduClient(
      { baseUrl: 'https://tenant.example.com', apiToken: 'do-not-log' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    await expect(client.getAggregate('/api/v1/aggregates/rosters')).rejects.toMatchObject({
      code: 'not_authorized',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow redirects and does not put the token in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example' } }));
    const client = createFounduClient(credentials, { fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(client.getAggregate('/api/v1/aggregates/hours')).rejects.toBeInstanceOf(FounduError);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.redirect).toBe('manual');
    expect(String(url)).not.toContain('do-not-log');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer do-not-log');
  });

  it('hides upstream failure bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('do-not-log leaked', {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    }));
    const client = createFounduClient(credentials, { fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(client.getAggregate('/api/v1/aggregates/labour-cost')).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'FoundU partner API request failed (HTTP 500).',
    });
  });
});
