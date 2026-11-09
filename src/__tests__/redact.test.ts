import { describe, expect, it } from 'vitest';
import { maxUpstreamBytes } from '../config.js';
import { isSensitiveKey, redactText, redactValue, REDACTED, renderSafe } from '../redact.js';
import { FAKE_TOKEN } from './helpers.js';

const JWT_LIKE = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLW5vdC1yZWFsLTEyMzQ1Ng';

describe('text redaction', () => {
  it('removes known secrets, bearer headers, JWTs, and auth_token query values', () => {
    expect(redactText(`a ${FAKE_TOKEN} b`, [FAKE_TOKEN])).toBe(`a ${REDACTED} b`);
    expect(redactText('Authorization: Bearer abc.def-ghi')).toBe(`Authorization: ${REDACTED}`);
    expect(redactText(`token ${JWT_LIKE} end`)).toBe(`token ${REDACTED} end`);
    expect(redactText('GET /init/integration?auth_token=k3y&x=1')).toBe(`GET /init/integration?auth_token=${REDACTED}&x=1`);
  });

  it('redacts before truncating so a token cannot survive as a prefix', () => {
    const out = renderSafe(`${'x'.repeat(10)}${JWT_LIKE}`, 30);
    expect(out).not.toContain('eyJhbGciOiJSUzI1');
  });
});

describe('field-level redaction (defence in depth)', () => {
  it.each([
    'tfn',
    'tfn_number',
    'tax_file_number',
    'taxFileNumber',
    'bank_account_number',
    'bankName',
    'bsb',
    'account_number',
    'super_fund',
    'superannuation_member_number',
    'pay_rate',
    'payRate',
    'hourly_rate',
    'base_rate',
    'Ordinary Rate',
    'salary',
    'wages',
    'date_of_birth',
    'dob',
    'visa_status',
    'medical_conditions',
    'access_token',
    'refresh_token',
    'client_secret',
    'password',
    'clock_pass_code',
  ])('treats %j as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'id',
    'name',
    'first_name',
    'email',
    'status',
    'state_id',
    'Total Hours',
    'Total Pay',
    'Total Pay Overtime',
    'Ordinary Time Earnings',
    'Taxable Allowance Paid',
    'Charge Out Standard',
    'employee_id',
    'supervisor',
    'position_title',
    'operation_id',
    'shift_status',
  ])('keeps %j (directory and aggregate data)', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it('replaces sensitive values of any type, recursively, without mutating input', () => {
    const input = {
      data: [{ id: 1, name: 'A. Worker', tfn: '123456782', pay_rate: 31.5, bank: { bsb: '062-000', account_number: '12345678' }, positions: [{ hourly_rate: 40 }] }],
      meta: { pagination: { total: 1 } },
    };
    const snapshot = JSON.stringify(input);
    expect(redactValue(input)).toEqual({
      data: [{ id: 1, name: 'A. Worker', tfn: REDACTED, pay_rate: REDACTED, bank: REDACTED, positions: [{ hourly_rate: REDACTED }] }],
      meta: { pagination: { total: 1 } },
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('keeps labour-report totals: they are the point of that report', () => {
    const row = { 'Total Hours': '3.00', 'Total Pay': '96.00', 'Total Charge Out': '120.00', 'Overtime Hours': '0.00' };
    expect(JSON.parse(renderSafe({ data: [row] }, 10_000))).toEqual({ data: [row] });
  });
});

describe('rendering', () => {
  it('serializes tool output compactly', () => {
    expect(renderSafe({ data: [{ id: 'a' }], meta: { pagination: { total: 1 } } }, 10_000)).toBe('{"data":[{"id":"a"}],"meta":{"pagination":{"total":1}}}');
  });

  it('shrinks an oversized page structurally and keeps the pagination block', () => {
    const page = { data: Array.from({ length: 200 }, (_, i) => ({ id: i, title: 'x'.repeat(50) })), meta: { pagination: { current_page: 1, last_page: 4 } } };
    const out = JSON.parse(renderSafe(page, 2000));
    expect(out.truncated).toBe(true);
    expect(out.meta).toEqual(page.meta);
    expect(out.data.length).toBeGreaterThan(0);
    expect(out.data.length).toBeLessThan(200);
    expect(out.truncation_hint).toMatch(/smaller limit/);
  });

  it('caps upstream bodies at 4 MiB by default', () => {
    delete process.env.FOUNDU_MAX_UPSTREAM_BYTES;
    expect(maxUpstreamBytes()).toBe(4 * 1024 * 1024);
  });
});
