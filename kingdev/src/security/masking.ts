/**
 * Secret and PII masking.
 *
 * This module is the single chokepoint every outbound path goes through. The
 * rules are deliberately ordered most-specific-first so a labelled
 * `Authorization: sk-...` header is masked as a labelled secret rather than
 * being partially eaten by a generic high-entropy rule.
 *
 * Design notes:
 *  - Masking is *lossy but structural*: the first 4 and last 4 characters of a
 *    long token survive so a human can still correlate two occurrences, while
 *    the middle — the part that actually grants access — never leaves.
 *  - Short values (< 8 chars) are fully replaced. A 6-char "token" is not
 *    meaningfully maskable, and a partial mask of it leaks it entirely.
 *  - Every function is pure and total: it never throws on hostile input.
 */

/** Values shorter than this are fully replaced rather than partially masked. */
const MIN_PARTIAL_MASK_LENGTH = 12;

export const MASK = '***';

/* ------------------------------------------------------------------ *
 * Rule table
 * ------------------------------------------------------------------ */

interface Rule {
  readonly id: string;
  readonly pattern: RegExp;
  /**
   * Given a match, return the replacement, or `null` to leave the match alone.
   * Allows rules to skip values that fail a plausibility check.
   */
  readonly replace?: (m: RegExpMatchArray) => string | null;
}

/** A bare JS identifier: `getSecret`, `config`, `pending`. */
const CODE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Decides whether an unquoted value is plausibly a credential *literal* rather
 * than a reference to one.
 *
 * KingDev reads source code as often as it reads wire traffic, and in source
 * code `secret = getSecret()` must not be rewritten — destroying it would break
 * the very context the developer is trying to reason about. The test used here
 * is "does this look like an opaque token": real tokens carry digits and are
 * long, while code references are short, digit-free identifiers, calls, or env
 * lookups.
 *
 * This guard is applied only to the *labelled* rules, which match developer
 * source and console dumps. Wire-format rules (Authorization headers, cookies,
 * vendor-shaped tokens) are not guarded: there, a value in that position is a
 * credential by definition.
 */
function isPlausibleSecret(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  // A call, closure, or delimited code fragment: a reference, not a literal.
  if (/[(){}[\];<>]/.test(v)) return false;
  // `process.env.API_KEY` names a variable; masking it destroys debug context
  // for no security gain, because the variable *name* is not the secret.
  if (/^(?:process|import\.meta|window|globalThis)\.env\./i.test(v)) return false;
  if (/^(?:true|false|null|undefined|none|nil|nan|empty)$/i.test(v)) return false;
  // Short, digit-free identifier -> code reference. Genuine tokens keep digits.
  if (CODE_IDENTIFIER.test(v) && !/\d/.test(v)) return false;
  return true;
}

/**
 * Named secret keys. Matched against `key: value`, `key=value`, `"key": "value"`
 * and the JSON-ish forms that show up in logged payloads.
 */
const LABELLED_RULES: readonly Rule[] = [
  {
    id: 'authorization-header',
    pattern: /\b(authorization|proxy-authorization)\b(\s*[:=]\s*)("?)([A-Za-z0-9._~+/=-]{8,})\3/gi,
    replace: (m) => `${m[1]}${m[2]}${m[3]}${mask(m[4] ?? '')}${m[3]}`,
  },
  {
    id: 'bearer-token',
    pattern: /\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (m) => `${m[1]} ${mask(m[2] ?? '')}`,
  },
  {
    id: 'cookie-header',
    pattern: /\b(set-cookie|cookie)\b(\s*[:=]\s*)("?)([^\r\n";]{6,})\3/gi,
    replace: (m) => `${m[1]}${m[2]}"${mask(m[3] ?? '')}"`,
  },
  {
    id: 'labelled-credential',
    // Tolerates a closing quote on the key and independent optional quotes around
    // the value, so JSON bodies ("client_secret":"…") and source code
    // (secret: getSecret()) are both matched by the same rule.
    pattern:
      /\b(api[-_]?key|apikey|api[-_]?secret|secret[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|session[-_]?token|private[-_]?key|passwd|password|pwd|secret|credential|passphrase|sessionid|phpsessid|jsessionid|token)\b["']?(\s*[:=]\s*)["']?([^"'\s,;&}\]]{6,})["']?/gi,
    replace: (m) => (isPlausibleSecret(m[3] ?? '') ? `${m[1]}${m[2]}${mask(m[3] ?? '')}` : null),
  },
  {
    id: 'query-param-credential',
    pattern:
      /([?&])(api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|key|secret|password|sig|signature|access[-_]?key)=([^&\s"']{6,})/gi,
    replace: (m) => (isPlausibleSecret(m[3] ?? '') ? `${m[1]}${m[2]}=${mask(m[3] ?? '')}` : null),
  },
  {
    id: 'jwt',
    // Three base64url segments. The header/signature are safe to lose entirely.
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
    replace: (m) => mask(m[0]),
  },
];

/** Unlabelled, vendor-shaped credentials. These are near-zero false-positive. */
const SHAPED_RULES: readonly Rule[] = [
  { id: 'openai-key', pattern: /\bsk-(?:proj-|ant-|live-)?[A-Za-z0-9_-]{16,}\b/g },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { id: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g },
  { id: 'github-fine-grained-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'stripe-key', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { id: 'google-oauth-refresh', pattern: /\b1\/\/[A-Za-z0-9_-]{30,}\b/g },
  { id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { id: 'hugging-face-token', pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  {
    id: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'conn-string-password',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^:@/\s]{1,64}:)([^@/\s]{1,128})(@)/gi,
    replace: (m) => `${m[1]}${mask(m[2] ?? '')}${m[3]}`,
  },
];

/* ------------------------------------------------------------------ *
 * PII rules — only applied when explicitly enabled
 * ------------------------------------------------------------------ */

const PII_RULES: readonly Rule[] = [
  {
    id: 'email',
    pattern: /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    replace: (m) => `${m[1]}${MASK}@${m[2]}`,
  },
  {
    id: 'ipv4',
    pattern: /\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.(\d{1,3})\b/g,
    replace: (m) => `${m[1]}.${MASK}.${MASK}.${m[2]}`,
  },
  { id: 'us-ssn', pattern: /\b(\d{3})-(\d{2})-(\d{4})\b/g, replace: () => '***-**-****' },
  { id: 'credit-card', pattern: /\b(?:\d[ -]?){13,19}\b/g, replace: (m) => mask(m[0]) },
];

/* ------------------------------------------------------------------ *
 * Core primitives
 * ------------------------------------------------------------------ */

export function mask(value: string): string {
  const s = value.trim();
  if (s.length === 0) return MASK;
  if (s.length < MIN_PARTIAL_MASK_LENGTH) return MASK;
  return `${s.slice(0, 4)}${'*'.repeat(Math.min(12, Math.max(4, Math.floor(s.length / 3))))}${s.slice(-4)}`;
}

export interface MaskStats {
  readonly redactions: number;
  readonly ruleIds: readonly string[];
}

/**
 * Builds a `String.replace` replacer for a rule, reporting whether it actually
 * changed anything.
 *
 * `replace` hands the callback the whole match, the capture groups, the offset,
 * the groups object, and the input string. Rebuilding a `RegExpMatchArray` from
 * those positional arguments is fiddly and easy to get subtly wrong, so it
 * happens in exactly one place here rather than at every call site.
 */
function replacerFor(
  rule: Rule,
  onRedaction: (ruleId: string) => void,
): (substring: string, ...args: unknown[]) => string {
  return (...args: unknown[]) => {
    const groups = args.slice(0, -2) as string[];
    const offset = args[args.length - 2];
    const m = Object.assign(groups, {
      index: typeof offset === 'number' ? offset : 0,
    }) as unknown as RegExpMatchArray;

    // A replacer only runs on a match, so element 0 is always present, but the
    // index signature makes the compiler believe otherwise. Narrow it explicitly
    // instead of asserting: an absent match would be a real bug, not a cast.
    const whole = m[0];
    if (typeof whole !== 'string') return '';

    const replacement = rule.replace ? rule.replace(m) : mask(whole);
    // A rule may decline a match it does not recognise as a real secret, and a
    // rule may re-emit the match unchanged. Neither is a redaction.
    if (replacement === null || replacement === whole) return whole;

    onRedaction(rule.id);
    return replacement;
  };
}

function applyRules(input: string, rules: readonly Rule[]): { text: string; stats: MaskStats } {
  let text = input;
  let redactions = 0;
  const ruleIds: string[] = [];

  for (const rule of rules) {
    // Fresh copy per invocation: these regexes are module-level and may be /g.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    text = text.replace(
      re,
      replacerFor(rule, (ruleId) => {
        redactions += 1;
        if (!ruleIds.includes(ruleId)) ruleIds.push(ruleId);
      }),
    );
  }

  return { text, stats: { redactions, ruleIds } };
}

export interface MaskOptions {
  readonly redactPii?: boolean;
}

/**
 * Masks credentials and, when `redactPii`, common personal identifiers.
 * Safe to call on any string including empty, huge, or binary-ish input.
 */
export function maskSecretsInString(input: string, options: MaskOptions = {}): string {
  if (typeof input !== 'string' || input.length === 0) return input;

  // Cheap length guard: rules are regex-heavy, so skip trivially short input.
  if (input.length < 8) return input;

  let out = input;
  let touched = false;

  for (const rule of [...LABELLED_RULES, ...SHAPED_RULES]) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    out = out.replace(
      re,
      replacerFor(rule, () => {
        touched = true;
      }),
    );
  }

  if (options.redactPii) {
    for (const rule of PII_RULES) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      out = out.replace(
        re,
        replacerFor(rule, () => {
          touched = true;
        }),
      );
    }
  }

  return touched ? out : input;
}

export function maskStringWithStats(
  input: string,
  options: MaskOptions = {},
): { text: string; stats: MaskStats } {
  if (typeof input !== 'string' || input.length < 8) {
    return { text: input, stats: { redactions: 0, ruleIds: [] } };
  }
  const secretResult = applyRules(input, [...LABELLED_RULES, ...SHAPED_RULES]);
  let text = secretResult.text;
  const ruleIds = [...secretResult.stats.ruleIds];
  let redactions = secretResult.stats.redactions;

  if (options.redactPii) {
    const piiResult = applyRules(text, PII_RULES);
    text = piiResult.text;
    redactions += piiResult.stats.redactions;
    for (const id of piiResult.stats.ruleIds) if (!ruleIds.includes(id)) ruleIds.push(id);
  }

  return { text, stats: { redactions, ruleIds } };
}

const SENSITIVE_KEY_PATTERN =
  /(pass(word|wd)?|secret|token|api[-_]?key|authorization|auth|credential|session|cookie|private[-_]?key|client[-_]?secret|bearer)/i;

/** Heuristic used when redacting structured values by key name. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Recursively masks a structured value. Keys that look sensitive have their
 * value replaced wholesale; all other strings pass through the string rules.
 * Cycles and non-cloneable leaves are tolerated.
 */
export function maskSecretsInValue(
  value: unknown,
  options: MaskOptions = {},
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return maskSecretsInString(value, options);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => maskSecretsInValue(item, options, seen));
  }

  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (count++ > 200) {
      out.__truncated__ = true;
      break;
    }
    if (isSensitiveKey(k)) {
      out[k] = v === null || v === undefined ? v : MASK;
      continue;
    }
    try {
      out[k] = maskSecretsInValue(v, options, seen);
    } catch {
      out[k] = '[unserialisable]';
    }
  }
  return out;
}

/**
 * Strips credential-bearing fields from a URL before it is sent anywhere or
 * persisted. Returns the origin + path + non-sensitive query params.
 */
export function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const sensitive = [
      'api_key',
      'apikey',
      'access_token',
      'auth_token',
      'token',
      'key',
      'secret',
      'password',
      'sig',
      'signature',
      'code',
      'client_secret',
    ];
    for (const param of [...url.searchParams.keys()]) {
      if (sensitive.includes(param.toLowerCase())) {
        url.searchParams.set(param, MASK);
      }
    }
    url.hash = '';
    return url.toString();
  } catch {
    // Not a parseable URL. Fall back to regex redaction of query-ish fragments.
    return maskSecretsInString(raw, { redactPii: false });
  }
}

/**
 * Reduces a full URL to a filename-style path used as a probable source file
 * hint in analysis. Strips host, query, and fragment.
 */
export function urlToPathHint(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!/^https?:|^file:|^blob:/.test(url.protocol)) return undefined;
    if (url.protocol === 'blob:') return url.pathname.split('/').pop() || undefined;
    const p = url.pathname;
    if (!p || p === '/') return undefined;
    return p.startsWith('/') ? p.slice(1) : p;
  } catch {
    return undefined;
  }
}
