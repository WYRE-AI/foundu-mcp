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

  it('redacts JWTs glued to other text, to each other, or chained by dots', () => {
    expect(redactText(`id-${JWT_LIKE} end`)).toBe(`id-${REDACTED} end`);
    // Back to back: the second token starts inside the first one's signature segment.
    expect(redactText(`${JWT_LIKE}${JWT_LIKE}`)).toBe(REDACTED);
    expect(redactText(`a ${JWT_LIKE}${JWT_LIKE}${JWT_LIKE} b`)).toBe(`a ${REDACTED} b`);
    expect(redactText(`${JWT_LIKE}.${JWT_LIKE}`)).toBe(REDACTED);
    // A JWT glued after a payload-like segment of other text.
    expect(redactText(`v1.abcd${JWT_LIKE}`)).toBe(`v1.abcd${REDACTED}`);
    expect(redactText(`${JWT_LIKE}.tail`)).toBe(`${REDACTED}.tail`);
    expect(redactText(`"${JWT_LIKE}","${JWT_LIKE}"`)).toBe(`"${REDACTED}","${REDACTED}"`);
  });

  it('leaves ordinary and almost-JWT text untouched', () => {
    for (const text of [
      'version 1.2.3 of eyJ-lib, see a.b.c',
      'eyJaaaaaaaa.bbbbbbb.cccccccc', // middle segment too short
      'eyJaaaaa.bbbbbbbb.cccccccc', // first segment too short
      'eyJaaaaaaaa.bbbbbbbb', // only two segments
      'Bearer', // no token after it
      'auth_token is a query parameter',
      'plain text with no secrets',
    ]) {
      expect(redactText(text)).toBe(text);
    }
  });
});

/**
 * Redaction runs on caller-influenced text up to the 4 MiB upstream cap, so
 * it must stay linear: a backtracking pattern such as
 * eyJ[...]{8,}\.[...]{8,}\.[...]{8,} retries from every "eyJ" of a long run
 * and takes minutes on a few hundred KiB.
 */
describe('redaction is linear time on adversarial input', () => {
  const MIB = 1024 * 1024;
  const SECRET = 'opaque-access-token-0123456789abcdefghijklmnop';

  /** Best of three, in ms. */
  function time(fn: () => unknown): number {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      fn();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  }

  const fill = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

  it.each([
    ['-eyJ repeated', (n: number) => fill('-eyJ', n)],
    ['eyJ repeated', (n: number) => fill('eyJ', n)],
    ['eyJ then one long dotless run', (n: number) => `eyJ${'a'.repeat(n - 3)}`],
    ['JWT-shaped segments chained by dots', (n: number) => fill('eyJaaaaaaaa.', n)],
    ['JWT-shaped tokens glued together', (n: number) => fill('eyJaaaaaaaa.bbbbbbbb.cccccccc', n)],
    ['near-miss JWTs (short last segment)', (n: number) => fill('eyJaaaaaaaa.bbbbbbbb.c ', n)],
    ['Bearer with no token', (n: number) => fill('Bearer ', n)],
    ['Bearer then long whitespace', (n: number) => fill(`Bearer${' '.repeat(1000)}!`, n)],
    ['auth_token= with no value', (n: number) => fill('?auth_token=', n)],
    ['known-secret near-miss', (n: number) => fill(SECRET.slice(0, -1), n)],
  ])('redactText: %s', (_name, make) => {
    const small = make(MIB);
    const large = make(4 * MIB);
    const t1 = time(() => redactText(small, [SECRET]));
    const t4 = time(() => redactText(large, [SECRET]));
    expect(t4).toBeLessThan(500);
    expect(t4 / Math.max(t1, 2)).toBeLessThan(8);
  });

  it('renderSafe: an oversized page of adversarial items is redacted once, not once per shrink step', () => {
    const page = (size: number) => ({
      data: Array.from({ length: 1000 }, (_, i) => ({ id: i, notes: fill('eyJ', size / 1000) })),
      meta: { pagination: { current_page: 1, last_page: 9 } },
    });
    const small = page(MIB);
    const large = page(4 * MIB);
    const t1 = time(() => renderSafe(small, 100_000, [SECRET], { paged: true }));
    const t4 = time(() => renderSafe(large, 100_000, [SECRET], { paged: true }));
    expect(t4).toBeLessThan(500);
    expect(t4 / Math.max(t1, 2)).toBeLessThan(8);
    expect(JSON.parse(renderSafe(large, 100_000, [SECRET], { paged: true })).meta).toEqual(large.meta);
  });

  it('every JWT in a long glued run is redacted', () => {
    const run = JWT_LIKE.repeat(20_000);
    expect(redactText(run)).toBe(REDACTED);
  });

  it.each([
    ['camelCase pairs', 'aB'],
    ['digit then capital', '1A'],
  ])(
    'isSensitiveKey: a 32M-character key of %s neither aborts the process nor goes quadratic',
    (_name, unit) => {
      // FOUNDU_MAX_UPSTREAM_BYTES allows up to 128 MiB, so one upstream key can be this long.
      // A String.replace with millions of '$1 $2' matches is a fatal V8 "invalid size" abort, not a catchable error.
      const key = (size: number) => fill(unit, size);
      const t1 = time(() => isSensitiveKey(key(MIB)));
      const t4 = time(() => isSensitiveKey(key(4 * MIB)));
      expect(t4 / Math.max(t1, 2)).toBeLessThan(8);
      const huge = key(32 * MIB);
      const t0 = performance.now();
      expect(redactValue({ [huge]: 1 })).toEqual({ [huge]: 1 });
      expect(performance.now() - t0).toBeLessThan(10_000);
    },
    30_000,
  );

  it.each([
    ['one long Bearer token', (n: number) => `Bearer ${'a'.repeat(n - 7)}`, (out: string) => out === REDACTED],
    ['dense Bearer tokens', (n: number) => fill('Bearer a ', n), (out: string) => !out.includes('Bearer a')],
    ['one long auth_token value', (n: number) => `?auth_token=${'a'.repeat(n - 12)}`, (out: string) => out === `?auth_token=${REDACTED}`],
    ['dense auth_token values', (n: number) => fill('&auth_token=a', n), (out: string) => !out.includes('=a')],
  ])(
    'redactText at 32M characters: %s',
    (_name, make, redacted) => {
      const text = make(32 * MIB);
      const t0 = performance.now();
      const out = redactText(text);
      expect(performance.now() - t0).toBeLessThan(5000);
      expect(redacted(out)).toBe(true);
    },
    30_000,
  );
});

describe('Bearer and auth_token scanning', () => {
  it.each([
    ['Authorization: Bearer abc.def-ghi', `Authorization: ${REDACTED}`],
    ['bearer lower-case', REDACTED],
    ['BEARER\t\tabc==tail', `${REDACTED}tail`],
    ['Bearer abc+/~_.-xyz== next', `${REDACTED} next`],
    ['Bearer  nbsp1', REDACTED],
    ['Bearer \t\n abc!', `${REDACTED}!`],
    ['xBearer abc', 'xBearer abc'],
    ['_Bearer abc', '_Bearer abc'],
    ['-Bearer abc', `-${REDACTED}`],
    ['Bearer', 'Bearer'],
    ['Bearer   ', 'Bearer   '],
    ['Bearer !abc', 'Bearer !abc'],
    ['Bearerabc', 'Bearerabc'],
    ['Bearer ! Bearer abc', `Bearer ! ${REDACTED}`],
    ['/x?auth_token=k3y&x=1', `/x?auth_token=${REDACTED}&x=1`],
    ['/x?a=1&AUTH_TOKEN=k3y next', `/x?a=1&AUTH_TOKEN=${REDACTED} next`],
    [`"?auth_token=k3y'"`, `"?auth_token=${REDACTED}'"`],
    ['?auth_token=&auth_token=k3y', `?auth_token=&auth_token=${REDACTED}`],
    ['?auth_token= k3y', '?auth_token= k3y'],
    ['auth_token=k3y', 'auth_token=k3y'],
  ])('%j', (input, expected) => {
    expect(redactText(input)).toBe(expected);
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
    'rate',
    'award_rate',
    'rate_loading',
    'cost_rate',
    'passport_number',
    'driver_licence_number',
    'license_number',
    'emergency_contact_phone',
    'abn',
    'tax_scale',
    // Every pay-bearing figure: any rate, and pay or amount fields with a pay qualifier.
    'payable_rate',
    'position_casual_rate',
    'position_base_rate',
    'rate_unloaded',
    'charge_rate',
    'rates',
    'foreign_tax_rate_percent',
    'annual_salary',
    'pay',
    'Total Pay',
    'Total Pay Overtime',
    'gross_pay',
    'net_pay',
    'base_pay',
    'overtime_pay',
    'penalty_pay',
    'casual_pay',
    'payable_amount',
    'paid_amount',
    'total_amount',
    'penalty_amount',
    'allowance_amount',
    'overtime_amount',
    'casual_loading_amount',
    'base_amount',
    'Taxable Allowance Paid',
    'Ordinary Time Earnings',
    'earnings',
    // Tax declaration data.
    'has_tax_file_number',
    'tax_free_threshold_from_employer',
    'withhold_tax',
    'medicare_levy_surcharge',
    // Money words other than pay: cost, charge, price, fee, gross, net.
    'cost',
    'costs',
    'costing',
    'shift_costing',
    'shift_cost',
    'total_cost',
    'labour_cost',
    'TotalCost',
    'gross',
    'gross_v2',
    'net',
    'Net Pay',
    'price',
    'charge',
    'total_charge',
    'Charge Out Standard',
    'fee',
    'dollar_value',
    // STP and residency declarations (employee-stp-compliance attributes).
    'training_support_loan',
    'seniors_pensioners',
    'resident_status',
    'resident_status_code',
    'is_resident',
    'working_holiday_maker_registered_employer',
    'palm_approved_employer',
    'income_type',
    'income_type_code',
    // Identity data.
    'birthday',
    'gender',
    'gender_detail',
    'address',
    'full_address',
    'home_address',
    'next_of_kin',
    'nok_name',
    'licence_no',
    'drivers_licence',
    'wwcc_number',
    'police_check',
    'police_clearance_check',
    'citizenship',
    'id_token',
    'idToken',
    'password_hash',
    // Side-loaded JSON:API resources that carry only HR, tax, contact, or medical data.
    'hr-details-12',
    'employee-stp-compliance-12',
    'employee-contact-12',
    'emergency-contact-12',
    'custom-fields-12',
    'current-medical-12',
    'onboarding-overview-12',
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
    'Overtime Hours',
    'employee_id',
    'supervisor',
    'position_title',
    'operation_id',
    'shift_status',
    'pay_rate_type',
    'rate_type',
    'licence_type',
    'qualification_name',
    // Hours, quantities, IDs, and yes/no labels that only sound like pay.
    'amount',
    'amount_requested',
    'leave_rule_amount',
    'allowance_qty',
    'allowance_rate_id',
    'allowance_id',
    'pay_nopay',
    'pay_or_nopay',
    'leave_pay_nopay',
    'break_is_payable',
    'is_monthly_pay',
    'payment_type',
    // Counts, codes, business addresses, and labels next to the new money and identity rules.
    'total',
    'cost_code',
    'Cost code',
    'cost_centre_id',
    'licence_type',
    'licence_state',
    'licence_expiry',
    'office_address',
    'postal_address',
    'holiday_id',
    'is_holiday',
    'casual_loading',
    'employee-12',
    'location-12',
    'current-positions-12',
  ])('keeps %j (directory, hours, and label data)', (key) => {
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

  it('removes pay totals from report rows and keeps hours', () => {
    const row = { 'Total Hours': '3.00', 'Total Pay': '96.00', 'Total Pay Overtime': '0.00', 'Overtime Hours': '0.00', 'Ordinary Time Earnings': '96.00' };
    expect(JSON.parse(renderSafe({ data: [row] }, 10_000))).toEqual({
      data: [{ 'Total Hours': '3.00', 'Total Pay': REDACTED, 'Total Pay Overtime': REDACTED, 'Overtime Hours': '0.00', 'Ordinary Time Earnings': REDACTED }],
    });
  });
});

/**
 * Response shapes from the official foundU spec for the tools this server
 * exposes, with the spec's own example values. Every pay figure must come
 * back as [REDACTED]; hours, balances, IDs, and labels must survive.
 */
describe('pay figures in real v1 responses are removed', () => {
  const render = (body: unknown) => JSON.parse(renderSafe(body, 1_000_000));

  it('foundu_positions_list: position base and casual rates', () => {
    const body = { data: [{ id: 6, title: 'Process Worker Level 1', position_base_rate: 21.57, position_casual_rate: 26.96, is_no_pay_award: 0 }] };
    expect(render(body).data[0]).toEqual({ id: 6, title: 'Process Worker Level 1', position_base_rate: REDACTED, position_casual_rate: REDACTED, is_no_pay_award: 0 });
  });

  it('foundu_employee_leave_balances_get: payable_rate and rate go, the leave balance stays', () => {
    const ledger = {
      amount: '105.3570',
      leave_loading: '0.007',
      accrual_limit: '3.6500',
      entitlement_value: '0.0769',
      payable_rate: 45.5488,
      rate: 28.92,
      leave_rule: { title: 'Annual Leave', pay_nopay: 'pay', display_payslip: 1 },
    };
    const body = { data: [{ type: 'employee-leave-ledger', id: 1, attributes: { data: [{ type: 'leave-ledger', attributes: ledger }] } }] };
    const out = render(body).data[0].attributes.data[0].attributes;
    expect(out.payable_rate).toBe(REDACTED);
    expect(out.rate).toBe(REDACTED);
    expect(out.amount).toBe('105.3570');
    expect(out.accrual_limit).toBe('3.6500');
    expect(out.leave_rule).toEqual(ledger.leave_rule);
  });

  it('foundu_employee_positions_list: position rates, classification rates, and annual salary', () => {
    const body = {
      data: [{ type: 'employee-positions', id: 1, attributes: { data: [{ attributes: { position_id: 6, rate: 28.92, start_date: '2026-01-01' } }] } }],
      included: {
        'classification-3': { attributes: { title: 'Level 1', rate: '27.15', rate_unloaded: '21.720' } },
        'employee-permanent-part-time-positions-9': { attributes: { attributes: { annual_salary: 84150, rate: 42.586, hours_per_week: 38 } } },
      },
    };
    const out = render(body);
    expect(out.data[0].attributes.data[0].attributes).toEqual({ position_id: 6, rate: REDACTED, start_date: '2026-01-01' });
    expect(out.included['classification-3'].attributes).toEqual({ title: 'Level 1', rate: REDACTED, rate_unloaded: REDACTED });
    expect(out.included['employee-permanent-part-time-positions-9'].attributes.attributes).toEqual({ annual_salary: REDACTED, rate: REDACTED, hours_per_week: 38 });
  });

  it('foundu_approved_shifts_list: allowance rates go, the allowance and its quantity stay', () => {
    const allowance = { allowance_id: '300', allowance_rate_id: '154', title: 'Forklift Allowance', type: 'hourly', rates: { label: 'Forklift Allowance', rate: '0.550000' }, allowance_qty: 5 };
    const shift = { id: 123, approved_time: { approved_duration: 5.87, approved_breaks: [{ break_is_payable: false }] }, allowances: [allowance], attendance: [{ leave_rule_amount: '0.0000' }] };
    const out = render({ success: true, data: [shift], meta: { pagination: { total: 878 } } });
    expect(out.data[0].allowances[0]).toEqual({ allowance_id: '300', allowance_rate_id: '154', title: 'Forklift Allowance', type: 'hourly', rates: REDACTED, allowance_qty: 5 });
    expect(out.data[0].approved_time).toEqual(shift.approved_time);
    expect(out.data[0].attendance).toEqual(shift.attendance);
    expect(out.meta.pagination.total).toBe(878);
  });

  it('foundu_employee_get with include=current-positions: the position rate goes', () => {
    const body = { data: { id: 10034 }, included: { 'current-positions-1': { attributes: { positions: [{ position_id: 6, payment_type: 'hourly', rate: '36.1100' }] } } } };
    expect(render(body).included['current-positions-1'].attributes.positions[0]).toEqual({ position_id: 6, payment_type: 'hourly', rate: REDACTED });
  });

  it('foundu_approved_shifts_list: the untyped costing array goes, the approved time stays', () => {
    const shift = { id: 123, approved_time: { approved_duration: 5.87 }, costing: [{ cost: 312.5, total: 340.1 }], shift_costing: [{ id: 175, invoicing_po_id: 3 }] };
    const out = render({ success: true, data: [shift], meta: { pagination: { total: 878 } } });
    expect(out.data[0]).toEqual({ id: 123, approved_time: shift.approved_time, costing: REDACTED, shift_costing: REDACTED });
    expect(out.meta.pagination.total).toBe(878);
  });

  it('foundu_leave_applications_list with include=employee: side-loaded HR, tax, contact, and custom-field resources go', () => {
    // The `included` shape the spec documents for GET /api/v1/leave/leave-applications.
    const stp = {
      income_type_code: 'SAW',
      income_type: 'Salary and Wages',
      foreign_tax_rate_percent: '25',
      is_resident: true,
      resident_status: 'Working holiday maker',
      resident_status_code: 'working_holiday_maker',
      training_support_loan: true,
      medicare_levy_surcharge: 0,
      has_tax_file_number: true,
      tax_free_threshold_from_employer: true,
      working_holiday_maker_registered_employer: true,
      palm_approved_employer: false,
      seniors_pensioners: false,
    };
    const body = {
      data: [{ type: 'employee-leave', id: 7, attributes: { amount_requested: 22.6, status: 'approved' } }],
      included: {
        'employee-1': { type: 'employee', id: 1, attributes: { first_name: 'A.', last_name: 'Worker' } },
        'employee-stp-compliance-1': { type: 'employee-stp-compliance', id: 1, attributes: stp },
        'hr-details-1': { type: 'hr-details', id: 1, attributes: { title: 'Mr', gender: 'male', address: { full_address: '1 Example St' }, dob: '1991-01-01' } },
        'employee-contact-1': { type: 'employee-contact', id: 1, attributes: { mobile: '0400 000 000' } },
        'custom-fields-1': { type: 'custom-fields', id: 1, attributes: { data: { 'field 1': 'x' } } },
        'branch-4': { type: 'branch', id: 4, attributes: { title: 'Warehouse' } },
      },
    };
    const out = render(body);
    expect(out.data).toEqual(body.data);
    expect(out.included).toEqual({
      'employee-1': body.included['employee-1'],
      'employee-stp-compliance-1': REDACTED,
      'hr-details-1': REDACTED,
      'employee-contact-1': REDACTED,
      'custom-fields-1': REDACTED,
      'branch-4': body.included['branch-4'],
    });
    // Defence in depth: the same STP fields are removed wherever they appear.
    expect(Object.values(render({ data: [stp] }).data[0]).every((v) => v === REDACTED)).toBe(true);
  });

  it('leave applications and history keep their hours', () => {
    const body = { data: [{ attributes: { amount_requested: 22.6, status: 'approved' } }, { attributes: { amount: '20.0000' } }] };
    expect(render(body)).toEqual(body);
  });
});

describe('rendering', () => {
  it('serializes tool output compactly', () => {
    expect(renderSafe({ data: [{ id: 'a' }], meta: { pagination: { total: 1 } } }, 10_000)).toBe('{"data":[{"id":"a"}],"meta":{"pagination":{"total":1}}}');
  });

  it('shrinks an oversized page structurally and keeps the pagination block', () => {
    const page = { data: Array.from({ length: 200 }, (_, i) => ({ id: i, title: 'x'.repeat(50) })), meta: { pagination: { current_page: 1, last_page: 4 } } };
    const out = JSON.parse(renderSafe(page, 2000, [], { paged: true }));
    expect(out.truncated).toBe(true);
    expect(out.meta).toEqual(page.meta);
    expect(out.data.length).toBeGreaterThan(0);
    expect(out.data.length).toBeLessThan(200);
    expect(out.truncation_hint).toMatch(/smaller limit/);
  });

  it('drops an oversized `included` and keeps the pagination block when side-loads alone exceed the cap', () => {
    const included = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`branch-${i}`, { attributes: { title: 'y'.repeat(50) } }]));
    const page = { data: Array.from({ length: 20 }, (_, i) => ({ id: i })), included, meta: { pagination: { current_page: 1, last_page: 4 } } };
    const out = JSON.parse(renderSafe(page, 2000, [], { paged: true }));
    expect(out.included).toBeUndefined();
    expect(out.meta).toEqual(page.meta);
    expect(out.data).toEqual(page.data);
    expect(out.truncated).toBe(true);
    expect(out.truncation_hint).toMatch(/included/);
  });

  it('a first item larger than the cap comes back as marked, cut JSON text, never as a silent empty page', () => {
    const page = {
      data: [{ id: 1, notes: 'n'.repeat(5000) }, { id: 2 }, { id: 3 }],
      meta: { pagination: { current_page: 1, last_page: 3 } },
    };
    const text = renderSafe(page, 2000, [], { paged: true });
    expect(text.length).toBeLessThanOrEqual(2000);
    const out = JSON.parse(text);
    expect(out.meta).toEqual(page.meta);
    expect(out.truncated).toBe(true);
    expect(out.data).toEqual([]);
    expect(out.returned_items).toBe(0);
    expect(out.truncated_first_item).toMatch(/^\{"id":1,"notes":"nnnn/);
    expect(out.truncation_hint).toMatch(/first item/);
    expect(out.truncation_hint).toMatch(/truncated_first_item/);
    expect(out.truncation_hint).not.toMatch(/smaller limit/);
  });

  it('the cut first item is redacted before it is cut', () => {
    const page = { data: [{ id: 1, notes: `${'x'.repeat(1500)}${JWT_LIKE}${'y'.repeat(3000)}` }], meta: { pagination: { total: 1 } } };
    for (const cap of [1700, 1800, 2000, 2500]) {
      const out = renderSafe(page, cap, [], { paged: true });
      expect(out.length).toBeLessThanOrEqual(cap);
      expect(out).not.toContain('eyJhbGciOiJSUzI1');
      expect(JSON.parse(out).meta).toEqual(page.meta);
    }
  });

  it('prefers dropping `included` over cutting the first item', () => {
    // `included` fits on its own, and the item fits on its own, but not both.
    const included = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`branch-${i}`, { attributes: { title: 'y'.repeat(50) } }]));
    const page = { data: [{ id: 1, title: 'z'.repeat(900) }], included, meta: { pagination: { total: 1 } } };
    const out = JSON.parse(renderSafe(page, 2000, [], { paged: true }));
    expect(out.truncation_hint).toMatch(/included/);
    expect(out.included).toBeUndefined();
    expect(out.data).toEqual(page.data);
    expect(out.truncated_first_item).toBeUndefined();
  });

  it('for an endpoint without paging, the shrink hint never points at a next page', () => {
    const page = { data: Array.from({ length: 200 }, (_, i) => ({ id: i, title: 'x'.repeat(50) })) };
    const out = JSON.parse(renderSafe(page, 2000));
    expect(out.truncated).toBe(true);
    expect(out.truncation_hint).not.toMatch(/next page/i);
    expect(out.truncation_hint).toMatch(/narrow the filters or date window/);
  });

  it('caps upstream bodies at 4 MiB by default', () => {
    delete process.env.FOUNDU_MAX_UPSTREAM_BYTES;
    expect(maxUpstreamBytes()).toBe(4 * 1024 * 1024);
  });
});
