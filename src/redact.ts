/**
 * Output hygiene for anything returned to the model or written to logs.
 * Order matters: redact first, then truncate, so a secret straddling the
 * truncation boundary can never survive as a partial prefix.
 *
 * Two kinds of field are removed by key name, whatever their value:
 * - credentials (access/refresh tokens, client secrets, passwords);
 * - payroll and identity data this server never returns: every pay or money
 *   figure (see isPayFigure), salary/wages/earnings, tax and STP declaration
 *   data, bank details, superannuation, date of birth, gender, home address,
 *   visa, passport, licence numbers, background checks, ABNs, emergency
 *   contacts, medical data, and whole HR/tax/contact side-loads (see
 *   SENSITIVE_RESOURCES). The endpoints that exist to carry these are not
 *   exposed (see tools/catalog.ts), but ordinary reads still embed some (a
 *   leave ledger's `payable_rate`, a position's `position_casual_rate`, an
 *   allowance's `rates`, a shift's `costing`), so this is enforced here.
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
  'idtoken',
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
  'password',
  // STP and residency declarations (employee-stp-compliance).
  'stp',
  'income',
  'resident',
  'residency',
  'pensioner',
  'pensioners',
  'loan',
  'palm',
  // Identity and background checks.
  'birthday',
  'gender',
  'kin',
  'nok',
  'wwcc',
  'police',
  'citizenship',
]);

/** Words that mark a money figure on their own (`cost`, `total_charge`, `Net Pay`), unless the key is a label or reference. */
const MONEY_TOKENS = new Set(['cost', 'costs', 'costing', 'charge', 'charges', 'price', 'prices', 'fee', 'fees', 'gross', 'net', 'dollar', 'dollars']);

/** A key ending in one of these names a label or a reference, not a figure (`pay_rate_type`, `cost_code`). */
const LABEL_SUFFIXES = new Set(['type', 'id', 'ids', 'code']);

/**
 * JSON:API side-loads (`included` keys such as `hr-details-12`) that carry
 * only HR, tax, contact, medical, or onboarding data. They are removed whole,
 * because some endpoints (leave applications with include=employee) document
 * them in `included` even though the employee include allowlist never asks
 * for them.
 */
const SENSITIVE_RESOURCES = [
  'hr-details',
  'employee-stp-compliance',
  'employee-contact',
  'emergency-contact',
  'custom-fields',
  'current-medical',
  'onboarding-overview',
];

/** Home-address keys. Business addresses (`office_address`, `postal_address` on an operation) are kept. */
const HOME_ADDRESS_WORDS = new Set(['address', 'full', 'home', 'residential']);

/** ASCII [a-z0-9]. */
function isLowerOrDigit(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
}

/** ASCII [A-Z]. */
function isUpper(c: number): boolean {
  return c >= 0x41 && c <= 0x5a;
}

/**
 * Splits camelCase, snake_case, kebab-case, and "Title Case" keys into
 * lower-case tokens: runs of [a-z0-9] after lower-casing, also split where a
 * lower-case letter or digit is followed by a capital. A manual scan, not
 * String.replace: keys come from upstream JSON, and a replace with millions
 * of matches on one long key ("aBaB...") is a fatal V8 abort, not an error.
 */
export function tokensOf(key: string): string[] {
  const tokens: string[] = [];
  const pushRuns = (part: string) => {
    const lower = part.toLowerCase();
    let start = -1;
    for (let i = 0; i <= lower.length; i++) {
      const inRun = i < lower.length && isLowerOrDigit(lower.charCodeAt(i));
      if (inRun && start < 0) start = i;
      else if (!inRun && start >= 0) {
        tokens.push(lower.slice(start, i));
        start = -1;
      }
    }
  };
  let from = 0;
  for (let i = 1; i < key.length; i++) {
    if (isUpper(key.charCodeAt(i)) && isLowerOrDigit(key.charCodeAt(i - 1))) {
      pushRuns(key.slice(from, i));
      from = i;
    }
  }
  pushRuns(key.slice(from));
  return tokens;
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
 * `position_casual_rate`, `charge_rate`), any money word (`cost`, `costing`,
 * `total_charge`, `price`, `fee`, `gross`, `Net Pay`), a bare `pay`, or a
 * pay/amount word with a pay qualifier (`Total Pay`, `overtime_pay`,
 * `penalty_amount`, `Taxable Allowance Paid`). A trailing `type`, `id`, or
 * `code` makes it a label or a reference (`pay_rate_type`,
 * `allowance_rate_id`, `cost_code`), and unqualified amounts or pay flags
 * (`amount` leave hours, `pay_nopay`, `break_is_payable`) are kept.
 */
function isPayFigure(tokens: readonly string[]): boolean {
  if (LABEL_SUFFIXES.has(tokens.at(-1) ?? '')) return false;
  if (tokens.includes('rate') || tokens.includes('rates')) return true;
  if (tokens.some((t) => MONEY_TOKENS.has(t))) return true;
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
  const dashed = tokens.join('-');
  if (SENSITIVE_RESOURCES.some((r) => dashed === r || dashed.startsWith(`${r}-`))) return true;
  if (isPayFigure(tokens)) return true;
  if ((has('licence') || has('license')) && ['number', 'no', 'num', 'driver', 'drivers'].some(has)) return true;
  if (has('address') && tokens.every((t) => HOME_ADDRESS_WORDS.has(t))) return true;
  if (has('holiday') && has('maker')) return true;
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

const DOT = 0x2e;

/** Base64url characters plus ".": [A-Za-z0-9_.-]. */
function isTokenChar(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2d || c === DOT;
}

/** Index of the first "eyJ" inside text[from, to), or -1. Never looks past `to`. */
function findEyJ(text: string, from: number, to: number): number {
  for (let i = from; i + 3 <= to; i++) {
    if (text.charCodeAt(i) === 0x65 && text.charCodeAt(i + 1) === 0x79 && text.charCodeAt(i + 2) === 0x4a) return i;
  }
  return -1;
}

/**
 * Redacts JWT-shaped tokens (foundU Passport access tokens): three
 * consecutive dot-separated segments of [A-Za-z0-9_-], each at least 8
 * characters, the first counted from an "eyJ" anywhere in its segment. No word
 * boundary is needed, so a token glued to other text keeps that text and loses
 * only the token. Every segment may start a token, including the last segment
 * of a token just redacted, so back-to-back tokens (`<jwt><jwt>`, where the
 * second header is glued to the first signature) are removed whole; the
 * overlapping spans are merged into one [REDACTED].
 *
 * One forward pass, O(n): each maximal run of [A-Za-z0-9_.-] is scanned once
 * to record its segment bounds, then each segment is searched for "eyJ" once,
 * only within itself, and untouched text is copied in slices. The regex this
 * replaces, eyJ[...]{8,}\.[...]{8,}\.[...]{8,}, retried from every "eyJ" of a
 * long run and was quadratic on caller-influenced text such as shift notes.
 */
function redactJwts(text: string): string {
  const out: string[] = [];
  let copied = 0; // text[0, copied) is already in `out`
  let i = 0;
  while (i < text.length) {
    if (!isTokenChar(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const starts: number[] = [];
    const ends: number[] = [];
    let start = i;
    for (; i < text.length && isTokenChar(text.charCodeAt(i)); i++) {
      if (text.charCodeAt(i) === DOT) {
        starts.push(start);
        ends.push(i);
        start = i + 1;
      }
    }
    starts.push(start);
    ends.push(i);
    for (let k = 0; k + 2 < starts.length; k++) {
      if (ends[k + 1] - starts[k + 1] < 8 || ends[k + 2] - starts[k + 2] < 8) continue;
      const at = findEyJ(text, starts[k], ends[k]);
      if (at < 0 || ends[k] - at < 11) continue;
      // A token starting inside the span just redacted extends that span instead of opening a new one.
      if (at > copied || out.length === 0) out.push(text.slice(copied, at), REDACTED);
      copied = ends[k + 2];
    }
  }
  out.push(text.slice(copied));
  return out.join('');
}

const WHITESPACE = /\s/y;

/** JavaScript's \s at text[i]: a sticky one-character test, no quantifier. */
function isSpaceAt(text: string, i: number): boolean {
  WHITESPACE.lastIndex = i;
  return WHITESPACE.test(text);
}

/** The first index at or after `from` where ok(i) is false. */
function skipWhile(text: string, from: number, ok: (i: number) => boolean): number {
  let i = from;
  while (i < text.length && ok(i)) i++;
  return i;
}

/** After "Bearer": \s+, then [A-Za-z0-9._~+/-]+, then any "=" padding. Returns `from` when no token follows. */
function bearerEnd(text: string, from: number): number {
  const tokenStart = skipWhile(text, from, (i) => isSpaceAt(text, i));
  const tokenEnd = skipWhile(text, tokenStart, (i) => {
    const c = text.charCodeAt(i);
    return isTokenChar(c) || c === 0x7e || c === 0x2b || c === 0x2f; // ~ + /
  });
  if (tokenStart === from || tokenEnd === tokenStart) return from;
  return skipWhile(text, tokenEnd, (i) => text.charCodeAt(i) === 0x3d); // =
}

/** After "auth_token=": [^&\s"']+. Returns `from` when the value is empty. */
function queryValueEnd(text: string, from: number): number {
  return skipWhile(text, from, (i) => {
    const c = text.charCodeAt(i);
    return c !== 0x26 && c !== 0x22 && c !== 0x27 && !isSpaceAt(text, i); // & " '
  });
}

/**
 * Credentials that follow a fixed prefix. Each regex only finds the prefix and
 * has no quantifier; the value's extent is found by a manual scan, so a pass
 * is linear and never touches the regex backtracking stack.
 */
const PREFIXED_SECRETS: ReadonlyArray<{ prefix: RegExp; end: (text: string, from: number) => number; keepPrefix: boolean }> = [
  { prefix: /\bBearer/gi, end: bearerEnd, keepPrefix: false },
  // The one-time integration key travels as ?auth_token= during bootstrap; never let one through.
  { prefix: /[?&]auth_token=/gi, end: queryValueEnd, keepPrefix: true },
];

function redactPrefixed(text: string, { prefix, end, keepPrefix }: (typeof PREFIXED_SECRETS)[number]): string {
  const out: string[] = [];
  let copied = 0; // text[0, copied) is already in `out`
  prefix.lastIndex = 0;
  for (let m = prefix.exec(text); m; m = prefix.exec(text)) {
    const valueStart = prefix.lastIndex;
    const valueEnd = end(text, valueStart);
    if (valueEnd === valueStart) continue;
    out.push(text.slice(copied, keepPrefix ? valueStart : m.index), REDACTED);
    copied = prefix.lastIndex = valueEnd;
  }
  out.push(text.slice(copied));
  return out.join('');
}

/** Pattern-based redaction plus exact removal of any secrets known for this request. Linear in the text length. */
export function redactText(text: string, knownSecrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const spec of PREFIXED_SECRETS) out = redactPrefixed(out, spec);
  return redactJwts(out);
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

const INCLUDED_DROPPED =
  ' The side-loaded `included` records alone exceeded the size cap and were dropped: repeat with fewer include values or a smaller limit to get them.';

/** Largest n in [0, max] with fits(n), given fits(0) and that fits only turns false as n grows. */
function largestFitting(max: number, fits: (n: number) => boolean): number {
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Fits a list page under the cap by dropping `data` items from the end while
 * keeping every other top-level field (meta, pagination, totals), so the
 * model can still page. If the page with its side-loaded `included` block
 * fits no whole item, `included` is dropped (and the hint says so). If not
 * even the first item fits on its own, it is returned cut short, as clearly
 * marked JSON text in `truncated_first_item`, rather than as an empty page.
 * Returns undefined when not even the page fields fit.
 *
 * The page fields and each item are serialized and redacted once, up front;
 * the searches below only join already-redacted slices. Redacting the pieces
 * separately matches redacting the whole text: they are joined by JSON
 * punctuation outside any string, which no redaction pattern crosses. `data`
 * is written last.
 */
function shrinkPage(page: Page, maxChars: number, redact: (s: string) => string, paged: boolean): string | undefined {
  const total = page.data.length;
  const items = page.data.map((v) => redact(JSON.stringify(v) ?? 'null'));
  // The page's own copies of the keys this function writes are dropped, so the output has no duplicate keys.
  const own: Record<string, unknown> = { ...page, data: undefined, truncated: undefined, returned_items: undefined, total_items_in_page: undefined, truncation_hint: undefined, truncated_first_item: undefined };
  const variants: Array<[Record<string, unknown>, string]> = [[own, '']];
  if (own.included !== undefined) variants.push([{ ...own, included: undefined }, INCLUDED_DROPPED]);

  const itemsHint = (n: number) =>
    paged
      ? `Only the first ${n} of ${total} items in this page fit in the response. Moving to the next page skips the rest: ` +
        `to see them, repeat this request with a smaller limit (at most ${Math.max(n, 1)}).`
      : `Only the first ${n} of ${total} items fit in the response, and this endpoint has no paging: ` +
        'to see the rest, narrow the filters or date window.';
  const cutHint =
    'The first item alone is larger than the response cap, so it is returned cut short, as JSON text that does not parse, ' +
    `in truncated_first_item, and data is empty. The other ${total - 1} items in this page are not returned. ` +
    (paged ? 'Moving to the next page skips them. ' : '') +
    'Fetch that item through its get tool, or narrow the filters, include values, or date window.';

  const builders = variants.map(([v, note]) => {
    const fields = redact(JSON.stringify(v)).slice(1, -1);
    return (n: number, cut?: string) => {
      const meta = JSON.stringify({
        truncated: true,
        returned_items: n,
        total_items_in_page: total,
        truncation_hint: (cut !== undefined ? cutHint : n < total ? itemsHint(n) : `All ${total} items are returned.`) + note,
        truncated_first_item: cut,
      }).slice(1, -1);
      return `{${fields ? `${fields},` : ''}${meta},"data":[${items.slice(0, n).join(',')}]}`;
    };
  });
  const fits = (s: string) => s.length <= maxChars;
  const usable = builders.filter((build) => fits(build(0)));
  for (const build of usable) {
    const n = largestFitting(total, (k) => fits(build(k)));
    if (n > 0 || total === 0) return build(n);
  }
  // Not even the first item fits on its own. Cut its already-redacted text, so no secret survives as a prefix.
  const build = usable.at(-1);
  if (!build) return undefined;
  const cutAt = (k: number) => build(0, `${items[0].slice(0, k)}…[cut]`);
  if (!fits(cutAt(0))) return undefined;
  return cutAt(largestFitting(items[0].length, (k) => fits(cutAt(k))));
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
  const redact = (text: string) => redactText(text, knownSecrets);
  if (typeof value === 'string') return truncate(redact(value), maxChars);
  const redacted = redactValue(value);
  const text = redact(JSON.stringify(redacted) ?? 'null');
  if (text.length <= maxChars) return text;
  return (isPage(redacted) && shrinkPage(redacted, maxChars, redact, paged)) || truncate(text, maxChars);
}
