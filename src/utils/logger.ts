import { scopedAccessToken } from '../client.js';
import { ACCESS_TOKEN_ENV } from '../config.js';
import { redactText } from '../redact.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

function getConfiguredLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return env in LEVELS ? (env as LogLevel) : 'info';
}

/** Logs to stderr (stdout is the stdio transport). Every line is redacted, including the message itself. */
function log(level: LogLevel, message: string, context?: unknown): void {
  if (LEVELS[level] < LEVELS[getConfiguredLevel()]) return;
  let line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  if (context !== undefined) {
    let contextStr: string;
    try {
      contextStr = JSON.stringify(context);
    } catch {
      contextStr = String(context);
    }
    line += ` ${contextStr}`;
  }
  // Redact both the env token (stdio/env mode) and the per-request gateway token in scope.
  console.error(redactText(line, [process.env[ACCESS_TOKEN_ENV]?.trim(), scopedAccessToken()]));
}

export const logger = {
  debug: (msg: string, ctx?: unknown) => log('debug', msg, ctx),
  info: (msg: string, ctx?: unknown) => log('info', msg, ctx),
  warn: (msg: string, ctx?: unknown) => log('warn', msg, ctx),
  error: (msg: string, ctx?: unknown) => log('error', msg, ctx),
};
