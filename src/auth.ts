import { AccessTokenError } from './types.js';

/** Generous upper bound for a Passport JWT access token; anything longer is not a token. */
export const MAX_ACCESS_TOKEN_LENGTH = 8192;

/**
 * Accepts a raw foundU OAuth2 access token. The token is restricted to visible
 * ASCII so it can never inject header lines, and must not carry its own
 * "Bearer " prefix (the client adds it). No error message here ever includes
 * the token.
 */
export function validateAccessToken(raw: string): string {
  const token = raw.trim();
  if (!token) throw new AccessTokenError('No foundU access token was provided.');
  if (/^bearer\s/i.test(token)) throw new AccessTokenError('Send the raw foundU access token without the "Bearer " prefix.');
  if (token.length > MAX_ACCESS_TOKEN_LENGTH) throw new AccessTokenError('The foundU access token is too long.');
  if (!/^[\x21-\x7e]+$/.test(token)) throw new AccessTokenError('The foundU access token contains invalid characters.');
  return token;
}
