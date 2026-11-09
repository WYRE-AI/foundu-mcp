import { vi } from 'vitest';
import type { CallToolResult } from '../tools/types.js';

/**
 * Every fake credential used by the test suite lives here. .gitleaks.toml
 * allowlists these exact strings and nothing broader.
 */
export const FAKE_TOKEN = 'foundu-test-access-token-not-real-1234567890';
export const FAKE_ENV_TOKEN = 'foundu-env-token-must-not-be-used-0000';
/** A second tenant's token, for tests that need two tenants at once. */
export const FAKE_TOKEN_B = 'foundu-test-access-token-b-not-real-0987654321';
export const FAKE_S2S_SECRET = 'test-s2s-7Hq2Lw9Zr4Kx8Mv3Nb6Pc1Td5Fg0Yj';

export const API_BASE = 'https://api.foundu.com.au';

/** Every tool, in all tiers. */
export const TOOL_COUNT = 26;
/** The default (read tier) surface: every tool except the two pay-figure reports. */
export const READ_TOOL_COUNT = 24;
export const ADMIN_TOOLS = ['foundu_labour_management_report', 'foundu_timesheet_analysis_report'];

export function textOf(result: CallToolResult): string {
  const block = result.content?.[0];
  if (!block || block.type !== 'text') throw new Error(`Expected text content, got ${JSON.stringify(block)}`);
  return block.text;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A Laravel-style error body, with the request ID in a response header. */
export function vendorError(status: number, message: string, requestId = 'req_test_0001', extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ message, ...extra }, status, { 'x-request-id': requestId });
}

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
  body: unknown;
}

export type Route = (call: RecordedCall) => Response | undefined | Promise<Response | undefined>;

/**
 * Stubs globalThis.fetch as the foundU API. Unmatched requests answer 599
 * so a wrong path fails the test loudly instead of looking like a vendor 404.
 */
export function mockFoundu(routes: Route[] = []) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = { method: init?.method ?? 'GET', url, headers, redirect: init?.redirect, body: init?.body };
    calls.push(call);
    for (const route of routes) {
      const response = await route(call);
      if (response) return response;
    }
    return new Response(`unmatched ${call.method} ${url.pathname}`, { status: 599 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** Answers every request with the given response factory. */
export function always(respond: (call: RecordedCall) => Response): Route {
  return (call) => respond(call);
}

/** Answers with the given responses in order, then repeats the last one. */
export function sequence(...responses: Array<() => Response>): Route {
  let i = 0;
  return () => responses[Math.min(i++, responses.length - 1)]();
}
