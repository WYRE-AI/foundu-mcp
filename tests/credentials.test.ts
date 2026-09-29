import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCredentials, credentialsStorage } from '../src/credentials.js';

describe('getCredentials', () => {
  const original = { ...process.env };

  beforeEach(() => {
    delete process.env.FOUNDU_BASE_URL;
    delete process.env.FOUNDU_API_TOKEN;
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('returns null when partner credentials are absent', () => {
    expect(getCredentials()).toBeNull();
  });

  it('returns null when only one of the env vars is set', () => {
    process.env.FOUNDU_BASE_URL = 'https://tenant.foundu.com.au';
    expect(getCredentials()).toBeNull();
  });

  it('reads both env vars in single-tenant mode', () => {
    process.env.FOUNDU_BASE_URL = 'https://tenant.foundu.com.au';
    process.env.FOUNDU_API_TOKEN = 'partner-token';
    expect(getCredentials()).toEqual({
      baseUrl: 'https://tenant.foundu.com.au',
      apiToken: 'partner-token',
    });
  });

  it('prefers AsyncLocalStorage over env vars', () => {
    process.env.FOUNDU_BASE_URL = 'https://env.foundu.com.au';
    process.env.FOUNDU_API_TOKEN = 'env-token';
    credentialsStorage.run(
      {
        kind: 'creds',
        credentials: { baseUrl: 'https://gateway.foundu.com.au', apiToken: 'gateway-token' },
      },
      () => {
        expect(getCredentials()).toEqual({
          baseUrl: 'https://gateway.foundu.com.au',
          apiToken: 'gateway-token',
        });
      },
    );
  });

  it('does not fall back to env when gateway headers are incomplete', () => {
    process.env.FOUNDU_BASE_URL = 'https://env.foundu.com.au';
    process.env.FOUNDU_API_TOKEN = 'env-token';
    credentialsStorage.run({ kind: 'incomplete' }, () => {
      expect(getCredentials()).toBeNull();
    });
  });
});
