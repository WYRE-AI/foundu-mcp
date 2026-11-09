/**
 * Output hygiene for anything returned to the model or written to logs.
 * Order matters: redact first, then truncate, so a secret straddling the
 * truncation boundary can never survive as a partial prefix.
 *
 * Two kinds of field are removed by key name, whatever their value:
 * - credentials (access/refresh tokens, client secrets, passwords);
 * - payroll and identity data this server never returns: every pay figure
 *   (see isPayFigure), salary/wages/earnings, tax declaration data, bank
 *   details, superannuation, date of birth, visa, passport, licence numbers,
 *   ABNs, emergency contacts, and medical data. The endpoints that exist to
 *   carry these are not exposed (see tools/catalog.ts), but ordinary reads
 *   still embed some (a leave ledger's `payable_rate`, a position's
 *   `position_casual_rate`, an allowance's `rates`), so this is enforced here.
 * Hours, leave balances, and quantities are kept: a bare `amount` in the v1
 * surface is leave hours, and `allowance_qty` is a count.
 * The token itself is also caught by exact match (the token in use) and by
 * shape (Bearer headers and JWTs).
 */

export const REDACTED = '[REDACTED]';

/** Normalized (lower-case, no `_`/`-`/space) key names whose values are credentials. */
const CREDENTIAL_KEYS = new Set([
  'authorization',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'password',
  'secret',
  'apikey',
  'authtoken',
  'token',
  'integrationkey',
  'xfounduaccesstoken',
  'clockpasscode',
  'passcode',
]);

/** Single tokens that always mark a sensitive payroll or identity field. */
const SENSITIVE_TOKENS = new Set([
  'tfn',
  'taxfile',
  'bsb',
  'iban',
  'swift',
  'super',
  'superannuation',
  'salary',
  'salaries',
  'wage',
  'wages',
  'earning',
  'earnings',
  'payrate',
  'payrates',
  'tax',
  'medicare',
  'dob',
  'birthdate',
  'visa',
  'medical',
  'passport',
  'emergency',
  'abn',
]);

/** Splits camelCase, snake_case, kebab-case, and "Title Case" keys into lower-case tokens. */
export function tokensOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Words that make a `pay` or `amount` field a money figure rather than hours or a label. */
const PAY_QUALIFIERS = new Set([
  'pay',
  'payable',
  'paid',
  'total',
  'gross',
  'net',
  'base',
  'ordinary',
  'casual',
  'penalty',
  'allowance',
  'allowances',
  'overtime',
  'loading',
  'hourly',
  'cost',
  'reimbursement',
  'deduction',
]);

/**
 * A pay figure is any rate (`rate`, `rates`, `payable_rate`,
 * `position_casual_rate`, `charge_rate`), a bare `pay`, or a pay/amount
 * word with a pay qualifier (`Total Pay`, `overtime_pay`, `penalty_amount`,
 * `Taxable Allowance Paid`). A trailing `type` or `id` makes it a label or a
 * reference (`pay_rate_type`, `allowance_rate_id`), and unqualified amounts or
 * pay flags (`amount` leave hours, `pay_nopay`, `break_is_payable`) are kept.
 */
function isPayFigure(tokens: readonly string[]): boolean {
  const last = tokens.at(-1);
  if (last === 'type' || last === 'id' || last === 'ids') return false;
  if (tokens.includes('rate') || tokens.includes('rates')) return true;
  if (tokens.length === 1 && tokens[0] === 'pay') return true;
  return tokens.some(
    (t, i) => ['pay', 'payable', 'paid', 'amount', 'amounts'].includes(t) && tokens.some((q, j) => j !== i && PAY_QUALIFIERS.has(q)),
  );
}

export function isSensitiveKey(key: string): boolean {
  if (CREDENTIAL_KEYS.has(key.toLowerCase().replace(/[\s_-]/g, ''))) return true;
  const tokens = tokensOf(key);
  const has = (t: string) => tokens.includes(t);
  if (tokens.some((t) => SENSITIVE_TOKENS.has(t))) return true;
  if (isPayFigure(tokens)) return true;
  if ((has('licence') || has('license')) && has('number')) return true;
  if (has('bank') || has('banking')) return true;
  if (has('account') && (has('number') || has('name') || has('bsb'))) return true;
  if (has('date') && has('birth')) return true;
  return false;
}

/** Recursively replaces values under sensitive keys. Returns a new value; the input is not mutated. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 64) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) && v !== null && v !== undefined && v !== '' ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

const TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, REDACTED],
  // No leading \b: a JWT glued to other word characters must still be caught.
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // The one-time integration key travels as ?auth_token= during bootstrap; never let one through.
  [/([?&]auth_token=)[^&\s"']+/gi, `$1${REDACTED}`],
];

/** Pattern-based redaction plus exact removal of any secrets known for this request. */
export function redactText(text: string, knownSecrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of TEXT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[truncated: ${omitted} more characters omitted. Narrow the query with limit, page, filters, or a shorter date range.]`;
}

type Page = Record<string, unknown> & { data: unknown[] };

function isPage(value: unknown): value is Page {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as Page).data);
}

/**
 * Fits a list page under the cap by dropping `data` items from the end while
 * keeping every other top-level field (meta, pagination, totals), so the
 * model can still page. Returns undefined when even an empty `data` does not
 * fit.
 */
function shrinkPage(page: Page, maxChars: number, render: (v: unknown) => string, paged: boolean): string | undefined {
  const total = page.data.length;
  const hint = (n: number) =>
    paged
      ? `Only the first ${n} of ${total} items in this page fit in the response. Moving to the next page skips the rest: ` +
        `to see them, repeat this request with a smaller limit (at most ${Math.max(n, 1)}).`
      : `Only the first ${n} of ${total} items fit in the response, and this endpoint has no paging: ` +
        'to see the rest, narrow the filters or date window.';
  const build = (n: number) =>
    render({
      ...page,
      data: page.data.slice(0, n),
      truncated: true,
      returned_items: n,
      total_items_in_page: total,
      truncation_hint: hint(n),
    });
  if (build(0).length > maxChars) return undefined;
  // Output length only grows with n, so binary-search the largest n that fits.
  let lo = 0;
  let hi = total - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(mid).length <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return build(lo);
}

/**
 * Serializes, redacts, then fits the cap. The single exit path for tool
 * output. Length is measured on the redacted text. An oversized list page is
 * shrunk structurally (pagination fields kept); anything else is cut as text.
 * `paged` says whether the tool can fetch a next page, which decides how the
 * shrink hint tells the model to reach the dropped items.
 */
export function renderSafe(
  value: unknown,
  maxChars: number,
  knownSecrets: readonly (string | undefined)[] = [],
  { paged = false }: { paged?: boolean } = {},
): string {
  if (typeof value === 'string') return truncate(redactText(value, knownSecrets), maxChars);
  const render = (v: unknown) => redactText(JSON.stringify(v) ?? 'null', knownSecrets);
  const redacted = redactValue(value);
  const text = render(redacted);
  if (text.length <= maxChars) return text;
  return (isPage(redacted) && shrinkPage(redacted, maxChars, render, paged)) || truncate(text, maxChars);
}
