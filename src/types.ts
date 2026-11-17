/**
 * A short-lived foundU OAuth2 access token. The upstream host is fixed and the
 * tenant is implied by the token, so the token is the whole credential. This
 * server never sees the integration key, client credentials, or the
 * (one-time, rotating) refresh token: the gateway owns that lifecycle.
 */
export interface FounduCredentials {
  accessToken: string;
}

/** Caller-supplied arguments failed validation. Never reaches foundU. */
export class ArgumentError extends Error {}

/** The access token is missing or malformed. Messages never contain the token. */
export class AccessTokenError extends Error {}

/** Any non-2xx, redirect, oversized, malformed, or unreachable upstream response. */
export class FounduApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}
