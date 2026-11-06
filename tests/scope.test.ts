import { describe, it, expect } from 'vitest';
import { FounduError } from '../src/errors.js';
import {
  canonicalizeAggregatePath,
  isSensitiveKey,
  redactSensitive,
  validateAuBaseUrl,
} from '../src/scope.js';

describe('aggregate path allowlist', () => {
  it('accepts roster, hours, timesheet, and labour-cost aggregate prefixes', () => {
    expect(canonicalizeAggregatePath('/api/v1/aggregates/rosters')).toBe('/api/v1/aggregates/rosters');
    expect(canonicalizeAggregatePath('/api/v1/aggregates/hours/by-location')).toBe(
      '/api/v1/aggregates/hours/by-location',
    );
    expect(canonicalizeAggregatePath('/api/v1/aggregates/timesheets')).toBe('/api/v1/aggregates/timesheets');
    expect(canonicalizeAggregatePath('/API/v1/aggregates/labour-cost/')).toBe('/api/v1/aggregates/labour-cost');
  });

  it.each([
    '/api/v1/employees',
    '/api/v1/payroll/payslips',
    '/api/v1/pay-rates',
    '/api/v1/bank-details',
    '/api/v1/tax-file-numbers',
    '/api/v1/aggregates/rosters/employees',
    '/api/v1/aggregates/hours/../employees',
    '/api/v1/aggregates/timesheets/12345',
    '/api/v1/aggregates/hours/%65mployees',
    '/api/v1/aggregates/hours/x%3Fdob=1',
    '/api/v1/aggregates/hours/x%23frag',
    '/api/v1/aggregates/hours/%252565',
    'https://evil.example/api/v1/aggregates/rosters',
    '//evil.example/api/v1/aggregates/rosters',
  ])('refuses %s', (path) => {
    expect(() => canonicalizeAggregatePath(path)).toThrow(FounduError);
    try {
      canonicalizeAggregatePath(path);
    } catch (error) {
      expect(error).toBeInstanceOf(FounduError);
      expect((error as FounduError).code).toBe('not_authorized');
    }
  });
});

describe('sensitive field policy', () => {
  it('keeps aggregate measures and drops pay, bank, tax, and identity fields', () => {
    expect(isSensitiveKey('workedHours')).toBe(false);
    expect(isSensitiveKey('employeeCount')).toBe(false);
    expect(isSensitiveKey('labourCost')).toBe(false);
    expect(isSensitiveKey('payRate')).toBe(true);
    expect(isSensitiveKey('hourlyRate')).toBe(true);
    expect(isSensitiveKey('taxFileNumber')).toBe(true);
    expect(isSensitiveKey('bsb')).toBe(true);
    expect(isSensitiveKey('employeeId')).toBe(true);
    expect(isSensitiveKey('firstName')).toBe(true);

    const redacted = redactSensitive({
      locationId: 'north',
      workedHours: 80,
      employeeCount: 4,
      labourCost: 1200,
      payRate: 32.5,
      employee: { employeeId: 'e1', firstName: 'Ada', taxFileNumber: '000000000' },
    });

    expect(redacted.data).toEqual({
      locationId: 'north',
      workedHours: 80,
      employeeCount: 4,
      labourCost: 1200,
      employee: {},
    });
    expect(redacted.redactedFields).toEqual([
      '$.employee.employeeId',
      '$.employee.firstName',
      '$.employee.taxFileNumber',
      '$.payRate',
    ]);
  });
});

describe('Australian residency', () => {
  it('accepts a foundu.com.au https origin', () => {
    expect(validateAuBaseUrl('https://tenant.foundu.com.au').hostname).toBe('tenant.foundu.com.au');
  });

  it.each([
    'http://tenant.foundu.com.au',
    'https://tenant.foundu.com',
    'https://user:token@tenant.foundu.com.au',
    'https://tenant.foundu.com.au/api',
    'https://tenant.foundu.com.au.evil.example',
    'not a url',
  ])('refuses %s', (baseUrl) => {
    expect(() => validateAuBaseUrl(baseUrl)).toThrow(FounduError);
  });
});
