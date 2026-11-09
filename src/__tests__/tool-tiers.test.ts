import { describe, expect, it } from 'vitest';
import { DEFAULT_TIERS, narrowTiers, parseToolTiers } from '../config.js';
import { ALL_TOOL_DEFS, buildToolset, pickDeclaredArgs } from '../tools/index.js';
import { ADMIN_TOOLS, READ_TOOL_COUNT, textOf, TOOL_COUNT } from './helpers.js';

describe('tool tiers', () => {
  it(`exposes exactly ${TOOL_COUNT} tools, all read-only annotated; only the pay-figure reports are admin tier`, () => {
    expect(ALL_TOOL_DEFS).toHaveLength(TOOL_COUNT);
    for (const d of ALL_TOOL_DEFS) {
      expect(d.tier, d.tool.name).toBe(ADMIN_TOOLS.includes(d.tool.name) ? 'admin' : 'read');
      expect(d.tool.annotations, d.tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    }
  });

  it('the pay-figure reports say so and are off by default', () => {
    const defaults = buildToolset(parseToolTiers(undefined)).tools.map((t) => t.name);
    for (const name of ADMIN_TOOLS) {
      expect(defaults).not.toContain(name);
      const tool = ALL_TOOL_DEFS.find((d) => d.tool.name === name)!.tool;
      expect(tool.description).toMatch(/per-employee pay/);
      expect(tool.description).not.toMatch(/pay rates are removed/i);
    }
    const withAdmin = buildToolset(parseToolTiers('read,admin'));
    expect(withAdmin.tools).toHaveLength(TOOL_COUNT);
    expect(buildToolset(narrowTiers(withAdmin.tiers, 'read')).tools).toHaveLength(READ_TOOL_COUNT);
    expect(buildToolset(narrowTiers(withAdmin.tiers, 'admin')).tools.map((t) => t.name).sort()).toEqual([...ADMIN_TOOLS].sort());
  });

  it('names are unique, foundu_<entity>_<read verb>', () => {
    const names = ALL_TOOL_DEFS.map((d) => d.tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^foundu_[a-z_]+_(list|get|search|report)$/);
  });

  it('no tool can reach the excluded payroll/identity surface', () => {
    const text = JSON.stringify(ALL_TOOL_DEFS.map((d) => d.tool));
    for (const banned of ['financial-details', 'payslip', 'paycycle', 'operation-pay-rates', 'deductions', '/etp', 'payroll-ledger', 'visa-check', 'hr-details', 'custom-fields', 'current-medical']) {
      // Mentions in descriptions are fine only as "cannot be requested"; never as an enum value or path.
      const enumHit = ALL_TOOL_DEFS.some((d) => JSON.stringify(d.tool.inputSchema).includes(`"${banned}"`));
      expect(enumHit, banned).toBe(false);
    }
    expect(text).not.toMatch(/"option_charge_out"/);
  });

  it('defaults to read', () => {
    expect([...DEFAULT_TIERS]).toEqual(['read']);
    expect([...parseToolTiers(undefined)]).toEqual(['read']);
    expect([...parseToolTiers('  ')]).toEqual(['read']);
    expect(buildToolset(parseToolTiers(undefined)).tools).toHaveLength(READ_TOOL_COUNT);
  });

  it('rejects unknown tier names loudly', () => {
    expect(() => parseToolTiers('read,write')).toThrow(/Invalid FOUNDU_TOOL_TIERS/);
  });

  it('the tier header can only narrow; empty narrows to nothing', () => {
    const configured = parseToolTiers('read');
    expect([...narrowTiers(configured, undefined)]).toEqual(['read']);
    expect([...narrowTiers(configured, 'read,admin')]).toEqual(['read']);
    expect([...narrowTiers(parseToolTiers('read,admin'), 'read,write')]).toEqual(['read']);
    expect([...narrowTiers(configured, '')]).toEqual([]);
    expect([...narrowTiers(configured, 'write')]).toEqual([]);
    const empty = buildToolset(narrowTiers(configured, ''));
    expect(empty.tools).toEqual([]);
  });

  it('a tool outside the enabled tiers is indistinguishable from an unknown one', async () => {
    const res = await buildToolset(new Set()).dispatch('foundu_employees_search', {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Error: Unknown tool: foundu_employees_search');
  });

  it('every input schema is closed (additionalProperties: false)', () => {
    for (const d of ALL_TOOL_DEFS) expect(d.tool.inputSchema.additionalProperties, d.tool.name).toBe(false);
  });
});

describe('argument forwarding', () => {
  it('drops undeclared arguments before the handler runs', () => {
    const tool = ALL_TOOL_DEFS.find((d) => d.tool.name === 'foundu_employee_get')!.tool;
    expect(pickDeclaredArgs(tool, { id: 1, baseUrl: 'https://evil.example.net', include: ['tag'], extra: 2 })).toEqual({ id: 1, include: ['tag'] });
    expect(pickDeclaredArgs(tool, ['nope'])).toEqual({});
  });
});
