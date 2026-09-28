import {
  isSensitiveKey,
  mask,
  maskSecretsInString,
  maskSecretsInValue,
  maskStringWithStats,
  sanitizeUrl,
  urlToPathHint,
} from '@/security/masking';
import { describe, expect, it } from 'vitest';

describe('mask', () => {
  it('fully replaces short values that cannot be partially masked', () => {
    expect(mask('abc123')).toBe('***');
    expect(mask('1234567')).toBe('***');
  });

  it('keeps only the first and last 4 characters of long values', () => {
    const out = mask('abcdefghijklmnopqrstuvwxyz');
    expect(out.startsWith('abcd')).toBe(true);
    expect(out.endsWith('wxyz')).toBe(true);
    expect(out).not.toContain('efghijklmnopqrstuv');
  });

  it('handles empty and whitespace input without throwing', () => {
    expect(mask('')).toBe('***');
    expect(mask('    ')).toBe('***');
  });
});

describe('maskSecretsInString — labelled credentials', () => {
  it('masks an Authorization bearer header and keeps the scheme readable', () => {
    const input = 'Authorization: Bearer abcdef1234567890abcdef';
    const out = maskSecretsInString(input);
    expect(out).not.toContain('abcdef1234567890abcdef');
    expect(out).toContain('Authorization');
    expect(out).toContain('Bearer');
  });

  it('masks an api_key query parameter', () => {
    // Assembled at runtime; see the note on `stripeShaped` above.
    const key = ['sk', 'live', '9f8a7b6c5d4e3f2a'].join('_');
    const out = maskSecretsInString(`https://x.dev/a?api_key=${key}&page=2`);
    expect(out).not.toContain(key);
    expect(out).toContain('page=2');
  });

  it('masks a JSON body credential', () => {
    const out = maskSecretsInString('{"client_secret":"s3cr3t-value-long","ok":true}');
    expect(out).not.toContain('s3cr3t-value-long');
    expect(out).toContain('"ok":true');
  });

  it('masks a set-cookie value', () => {
    const out = maskSecretsInString('Set-Cookie: session=abc123def456ghi789; Path=/');
    expect(out).not.toContain('abc123def456ghi789');
  });

  it('masks a connection string password but keeps user and host', () => {
    const out = maskSecretsInString('postgres://appuser:hunter2000@db.internal:5432/app');
    expect(out).not.toContain('hunter2000');
    expect(out).toContain('appuser');
    expect(out).toContain('db.internal');
  });
});

describe('maskSecretsInString — vendor-shaped credentials', () => {
  /**
   * Assembled from fragments so no contiguous provider key is ever written to
   * disk. It still matches the real `stripe-key` regex, so the rule itself is
   * genuinely exercised — but a fixture must not be able to trip GitHub push
   * protection and block a release.
   */
  const stripeShaped = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');

  const cases: ReadonlyArray<readonly [string, string]> = [
    ['openai', 'sk-proj-abcdefghijklmnop1234567890'],
    ['anthropic', 'sk-ant-api03-abcdefghijklmnop1234'],
    ['google', 'AIzaSyAbcdefghijklmnopqrstuvwxyz012345'],
    ['github', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github-pat', 'github_pat_11ABCDEFG0abcdefghijklmno'],
    ['slack', 'xoxb-123456789012-abcdefghijkl'],
    ['stripe', stripeShaped],
    ['aws', 'AKIAIOSFODNN7EXAMPLE'],
    ['npm', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['huggingface', 'hf_abcdefghijklmnopqrstuvwxyz012345'],
  ];

  for (const [name, token] of cases) {
    it(`masks a ${name} token`, () => {
      const out = maskSecretsInString(`token is ${token} here`);
      expect(out).not.toContain(token);
    });
  }

  it('masks a full private key block including newlines', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA1234567890abcdefghijklmnop',
      'qrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = maskSecretsInString(pem);
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('masks a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = maskSecretsInString(`token=${jwt}`);
    expect(out).not.toContain(jwt);
  });
});

describe('maskSecretsInString — false positives', () => {
  it('leaves an ordinary error message untouched', () => {
    const msg = "TypeError: Cannot read properties of undefined (reading 'profile')";
    expect(maskSecretsInString(msg)).toBe(msg);
  });

  it('leaves a stack frame untouched', () => {
    const frame = 'at UserProfile (https://app.dev/static/js/main.a1b2c3.js:42:17)';
    expect(maskSecretsInString(frame)).toBe(frame);
  });

  it('leaves a normal query string untouched', () => {
    const url = 'https://api.dev/v1/users?page=2&limit=50&sort=createdAt';
    expect(maskSecretsInString(url)).toBe(url);
  });

  it('shortens nothing for non-secret hex identifiers', () => {
    const hex = 'a3f5c9e17b2d4f6089a1';
    expect(maskSecretsInString(`id=${hex}`)).toBe(`id=${hex}`);
  });

  it('does not mask the word secret used as a variable name with no value', () => {
    const src = 'const secret = getSecret();';
    expect(maskSecretsInString(src)).toBe(src);
  });

  it('does not mask an env lookup, which names a variable rather than being one', () => {
    const src = 'const apiKey = process.env.API_KEY;';
    expect(maskSecretsInString(src)).toBe(src);
  });

  it('preserves the original separator when it does mask a labelled value', () => {
    expect(maskSecretsInString('api_key=abcdef1234567890')).toMatch(/^api_key=\w{4}\*+\w{4}$/);
  });

  it('masks a digit-bearing identifier-shaped value, which fails safe', () => {
    const out = maskSecretsInString('const token = abc123def456;');
    expect(out).not.toContain('abc123def456');
  });
});

describe('maskSecretsInString — PII is opt-in', () => {
  it('leaves emails intact by default', () => {
    const text = 'user.jane.doe@example.com signed in';
    expect(maskSecretsInString(text)).toBe(text);
  });

  it('masks the local part of an email when PII redaction is on', () => {
    const out = maskSecretsInString('user.jane.doe@example.com signed in', { redactPii: true });
    expect(out).not.toContain('user.jane.doe');
    expect(out).toContain('@example.com');
  });

  it('masks a US SSN when PII redaction is on', () => {
    expect(maskSecretsInString('ssn 123-45-6789', { redactPii: true })).not.toContain(
      '123-45-6789',
    );
  });

  it('masks the middle octets of an IPv4 address', () => {
    const out = maskSecretsInString('host 192.168.10.42 up', { redactPii: true });
    expect(out).toContain('192.');
    expect(out).toContain('.42');
    expect(out).not.toContain('168.10');
  });
});

describe('maskSecretsInString — totality', () => {
  it.each([
    ['empty', ''],
    ['short', 'abc'],
    ['very long', 'sk-'.repeat(5000)],
    ['unicode', '🔐'.repeat(50)],
    ['newlines', 'a\nb\rc\td'],
    // Escaped rather than a literal NUL byte: same runtime value, but keeps the
    // file plain text so git does not treat it as binary and lose the diff.
    ['null bytes', 'a\u0000b'],
  ])('never throws on %s input', (_label, input) => {
    expect(() => maskSecretsInString(input)).not.toThrow();
  });
});

describe('maskStringWithStats', () => {
  it('reports how many redactions happened and which rules fired', () => {
    const { stats } = maskStringWithStats(
      'Authorization: Bearer sk-abcdefghijklmnop1234 and api_key=sk-9876543210abcdef',
    );
    expect(stats.redactions).toBeGreaterThanOrEqual(2);
    expect(stats.ruleIds.length).toBeGreaterThan(0);
  });

  it('reports zero redactions for clean input', () => {
    expect(maskStringWithStats('nothing to see').stats.redactions).toBe(0);
  });
});

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'apiKey',
    'api_key',
    'Authorization',
    'refresh_token',
    'clientSecret',
    'Cookie',
  ])('flags %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['username', 'status', 'count', 'email', 'url'])('does not flag %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('maskSecretsInValue', () => {
  it('replaces the value of a sensitive key wholesale', () => {
    const out = maskSecretsInValue({ password: 'hunter2000', page: 2 }) as Record<string, unknown>;
    expect(out.password).toBe('***');
    expect(out.page).toBe(2);
  });

  it('recurses into nested objects and arrays', () => {
    const out = maskSecretsInValue({
      a: { b: { apiKey: 'sk-abcdefghijklmnop1234' } },
      list: [{ token: 'abcdefghijklmnop' }, 'plain'],
    }) as { a: { b: { apiKey: string } }; list: unknown[] };
    expect(out.a.b.apiKey).toBe('***');
    expect(out.list[1]).toBe('plain');
  });

  it('replaces circular references instead of overflowing', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    const out = maskSecretsInValue(node) as Record<string, unknown>;
    expect(out.self).toBe('[circular]');
  });

  it('passes through primitives unchanged', () => {
    expect(maskSecretsInValue(42)).toBe(42);
    expect(maskSecretsInValue(true)).toBe(true);
    expect(maskSecretsInValue(null)).toBe(null);
  });

  it('caps very large arrays', () => {
    const out = maskSecretsInValue(Array.from({ length: 1000 }, (_, i) => i)) as unknown[];
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe('sanitizeUrl', () => {
  it('masks sensitive query parameters and keeps the rest', () => {
    const out = sanitizeUrl('https://api.dev/v1/x?api_key=abcdef1234567890&page=3');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).toContain('page=3');
  });

  it('drops the fragment', () => {
    expect(sanitizeUrl('https://app.dev/#access_token=secretvalue1234')).not.toContain(
      'secretvalue1234',
    );
  });

  it('falls back gracefully on unparseable input', () => {
    expect(() => sanitizeUrl('not a url at all')).not.toThrow();
  });
});

describe('urlToPathHint', () => {
  it('extracts the path and drops origin/query/fragment', () => {
    expect(urlToPathHint('https://cdn.dev/assets/app.a1b2.js?v=3#x')).toBe('assets/app.a1b2.js');
  });

  it('returns undefined for a bare origin', () => {
    expect(urlToPathHint('https://app.dev/')).toBeUndefined();
  });

  it('returns undefined for non-http protocols', () => {
    expect(urlToPathHint('chrome-extension://abc/page.html')).toBeUndefined();
  });
});
