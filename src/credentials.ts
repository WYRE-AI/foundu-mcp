import { AsyncLocalStorage } from 'node:async_hooks';

export interface FounduCredentials {
  baseUrl: string;
  apiToken: string;
}

type CredentialStore =
  | { kind: 'creds'; credentials: FounduCredentials }
  | { kind: 'incomplete' };

// Per-request credentials in gateway mode. An `incomplete` store blocks the
// env-var fallback so a partial x-foundu-* header set cannot mix with another
// tenant's process environment.
export const credentialsStorage = new AsyncLocalStorage<CredentialStore>();

export function getCredentials(): FounduCredentials | null {
  const store = credentialsStorage.getStore();
  if (store) {
    return store.kind === 'creds' ? store.credentials : null;
  }

  const baseUrl = process.env.FOUNDU_BASE_URL?.trim();
  const apiToken = process.env.FOUNDU_API_TOKEN?.trim();
  if (!baseUrl || !apiToken) {
    return null;
  }

  return { baseUrl, apiToken };
}
