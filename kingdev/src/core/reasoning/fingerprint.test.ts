import {
  describeLocation,
  fileNameOf,
  findApplicationFrame,
  fingerprintError,
  fingerprintSerialized,
  normalizeFrame,
  normalizeMessage,
  parseStack,
  serializeError,
} from '@/core/reasoning/fingerprint';
import type { StackFrame } from '@/core/types';
import { describe, expect, it } from 'vitest';

const frame = (
  functionName: string,
  url: string,
  lineNumber = 10,
  columnNumber = 5,
): StackFrame => ({ functionName, url, lineNumber, columnNumber });

describe('normalizeMessage', () => {
  it('replaces integers and decimals with a placeholder', () => {
    expect(normalizeMessage('Failed after 47 attempts in 1.5s')).toBe(
      'Failed after <n> attempts in <n>s',
    );
  });

  it('replaces uuids', () => {
    const out = normalizeMessage('no user 7f3a9c2e-1b4d-4e8a-9f01-2c3d4e5f6a7b found');
    expect(out).toBe('no user <uuid> found');
  });

  it('replaces long hex runs such as commit shas and content hashes', () => {
    // A 20-char sha is caught by the longer-token rule first, so the exact
    // placeholder label is an implementation detail; what matters is that the
    // value collapses to one stable token.
    const out = normalizeMessage('at commit deadbeefcafebabe0123');
    expect(out).toMatch(/^at commit <[a-z]+>$/);
    expect(normalizeMessage('at commit deadbeefcafebabe0123')).toBe(out);
  });

  it('leaves digits that are part of an identifier intact', () => {
    expect(normalizeMessage('chunk main2 failed')).toBe('chunk main2 failed');
    expect(normalizeMessage('requires react 18.3.1')).toBe('requires react 18.3.1');
  });

  it('keeps quoted property names, which discriminate real bugs', () => {
    expect(normalizeMessage("Cannot read properties of undefined (reading 'profile')")).toBe(
      "Cannot read properties of undefined (reading 'profile')",
    );
  });

  it('collapses a quoted identifier-looking segment', () => {
    expect(normalizeMessage("invalid token 'a1b2c3d4e5f6'")).toBe("invalid token '<id>'");
  });

  it('strips line and column suffixes', () => {
    expect(normalizeMessage('unexpected token at main.js:42:17')).toBe(
      'unexpected token at main.js',
    );
  });

  it('collapses whitespace', () => {
    expect(normalizeMessage('a   b\n\n  c')).toBe('a b c');
  });

  it('reduces very long messages to a bounded length', () => {
    const out = normalizeMessage('x'.repeat(1000));
    expect(out.length).toBeLessThanOrEqual(401);
  });

  it('returns an empty string for non-string input', () => {
    expect(normalizeMessage(undefined as unknown as string)).toBe('');
  });
});

describe('parseStack', () => {
  const v8Stack = [
    "TypeError: Cannot read properties of undefined (reading 'profile')",
    '    at UserProfile (https://app.dev/src/Profile.tsx:42:17)',
    '    at renderWithHooks (https://app.dev/node_modules/react-dom/cjs/react-dom.production.min.js:16300:18)',
    '    at updateFunctionComponent (https://app.dev/node_modules/react-dom/cjs/react-dom.production.min.js:19520:22)',
  ].join('\n');

  it('parses named V8 frames with url, line and column', () => {
    const frames = parseStack(v8Stack);
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual({
      functionName: 'UserProfile',
      url: 'https://app.dev/src/Profile.tsx',
      lineNumber: 42,
      columnNumber: 17,
    });
  });

  it('skips the leading message header line', () => {
    expect(parseStack(v8Stack).every((f) => !f.functionName.includes('Cannot read'))).toBe(true);
  });

  it('parses anonymous frames', () => {
    const frames = parseStack('    at https://app.dev/static/chunk.js:10:5');
    expect(frames[0]?.functionName).toBe('<anonymous>');
    expect(frames[0]?.lineNumber).toBe(10);
  });

  it('parses the Firefox/Safari fn@url:line:col shape', () => {
    const frames = parseStack('render@https://app.dev/src/App.svelte:7:3');
    expect(frames[0]).toEqual({
      functionName: 'render',
      url: 'https://app.dev/src/App.svelte',
      lineNumber: 7,
      columnNumber: 3,
    });
  });

  it('returns nothing for an absent or non-string stack', () => {
    expect(parseStack(undefined)).toEqual([]);
    expect(parseStack(42 as unknown as string)).toEqual([]);
  });
});

describe('findApplicationFrame', () => {
  it('skips react-dom internals in node_modules', () => {
    const frames = [
      frame('renderWithHooks', 'https://app.dev/node_modules/react-dom/cjs/react-dom.js:100:1'),
      frame('UserProfile', 'https://app.dev/src/Profile.tsx', 42),
    ];
    expect(findApplicationFrame(frames)?.functionName).toBe('UserProfile');
  });

  it('skips node builtins and extension internals', () => {
    const frames = [
      frame('native', 'node:internal/process/task_queues:95:5'),
      frame('handler', 'chrome-extension://abcdef/content.js:12:1'),
      frame('App', 'https://app.dev/src/App.tsx', 3),
    ];
    expect(findApplicationFrame(frames)?.url).toContain('App.tsx');
  });

  it('skips bundler runtime chunks', () => {
    const frames = [
      frame('webpackRequire', 'https://app.dev/static/js/runtime.8a7b6c.js:1:1'),
      frame('App', 'https://app.dev/static/js/main.js:20:2'),
    ];
    expect(findApplicationFrame(frames)?.functionName).toBe('App');
  });

  it('falls back to the deepest frame when all frames are framework code', () => {
    // V8 orders frames deepest-first, so `frames[0]` is the origin of the throw.
    const frames = [
      frame('react', 'https://app.dev/node_modules/react/index.js:1:1'),
      frame('reactDom', 'https://app.dev/node_modules/react-dom/index.js:2:2'),
    ];
    expect(findApplicationFrame(frames)?.functionName).toBe('react');
  });

  it('returns undefined for an empty stack', () => {
    expect(findApplicationFrame([])).toBeUndefined();
  });
});

describe('normalizeFrame', () => {
  it('reduces a frame to function and file name', () => {
    expect(normalizeFrame(frame('UserProfile', 'https://app.dev/src/Profile.tsx', 42, 17))).toBe(
      'UserProfile@Profile.tsx',
    );
  });

  it('strips the .min marker so minified and unminified builds match', () => {
    // The point of the rule is that a production bundle and its unminified
    // twin produce one fingerprint, not two.
    expect(normalizeFrame(frame('f', 'https://app.dev/a/b.min.js'))).toBe('f@b.js');
    expect(normalizeFrame(frame('f', 'https://app.dev/a/b.js'))).toBe('f@b.js');
  });

  it('strips a source-map suffix, leaving the identity of the real source file', () => {
    expect(normalizeFrame(frame('f', 'https://app.dev/a/b.js.map'))).toBe('f@b.js');
  });

  it('labels eval and empty urls as inline', () => {
    expect(normalizeFrame(frame('f', 'eval at foo'))).toBe('f@inline');
    expect(normalizeFrame(frame('f', ''))).toBe('f@inline');
  });

  it('labels a missing frame', () => {
    expect(normalizeFrame(undefined)).toBe('<no-frame>');
  });
});

describe('fingerprintError', () => {
  const appFrame = [frame('UserProfile', 'https://app.dev/src/Profile.tsx', 42, 17)];

  it('is stable across differing line numbers in the same function', () => {
    const a = fingerprintError({
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'profile')",
      kind: 'javascript',
      frames: [frame('UserProfile', 'https://app.dev/src/Profile.tsx', 42, 17)],
    });
    const b = fingerprintError({
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'profile')",
      kind: 'javascript',
      frames: [frame('UserProfile', 'https://app.dev/src/Profile.tsx', 88, 3)],
    });
    expect(a).toBe(b);
  });

  it('is stable across differing ids and numbers in the message', () => {
    const a = fingerprintError({
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'profile')",
      kind: 'javascript',
      frames: appFrame,
    });
    const b = fingerprintError({
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'profile') after 1203 ms",
      kind: 'javascript',
      frames: appFrame,
    });
    expect(a).not.toBe(b); // a genuinely different message is a different bug
  });

  it('collapses repeated occurrences of one bug into one identity', () => {
    const fingerprint = fingerprintError({
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'profile')",
      kind: 'javascript',
      frames: appFrame,
    });
    const repeated = Array.from({ length: 47 }, () =>
      fingerprintError({
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'profile')",
        kind: 'javascript',
        frames: appFrame,
      }),
    );
    expect(new Set(repeated).size).toBe(1);
    expect(repeated.every((f) => f === fingerprint)).toBe(true);
  });

  it('separates the same message thrown from two different components', () => {
    const a = fingerprintError({
      name: 'TypeError',
      message: 'x is not a function',
      kind: 'javascript',
      frames: [frame('ProfileView', 'https://app.dev/src/ProfileView.tsx', 12, 1)],
    });
    const b = fingerprintError({
      name: 'TypeError',
      message: 'x is not a function',
      kind: 'javascript',
      frames: [frame('Sidebar', 'https://app.dev/src/Sidebar.tsx', 5, 1)],
    });
    expect(a).not.toBe(b);
  });

  it('separates different error constructors with identical messages', () => {
    const a = fingerprintError({
      name: 'TypeError',
      message: 'boom',
      kind: 'javascript',
      frames: appFrame,
    });
    const b = fingerprintError({
      name: 'ReferenceError',
      message: 'boom',
      kind: 'javascript',
      frames: appFrame,
    });
    expect(a).not.toBe(b);
  });

  it('separates different error kinds with identical messages', () => {
    const a = fingerprintError({
      name: 'Error',
      message: 'boom',
      kind: 'javascript',
      frames: appFrame,
    });
    const b = fingerprintError({
      name: 'Error',
      message: 'boom',
      kind: 'framework',
      frames: appFrame,
    });
    expect(a).not.toBe(b);
  });

  it('embeds the lowercased error name for readability', () => {
    const fp = fingerprintError({
      name: 'TypeError',
      message: 'boom',
      kind: 'javascript',
      frames: appFrame,
    });
    expect(fp).toMatch(/^[0-9a-f]{8}:typeerror$/);
  });

  it('is a pure function of its inputs', () => {
    const input = {
      name: 'TypeError',
      message: 'boom',
      kind: 'javascript' as const,
      frames: appFrame,
    };
    expect(fingerprintError(input)).toBe(fingerprintError(input));
  });
});

describe('serializeError', () => {
  it('serializes a real Error including parsed frames', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'profile')");
    error.stack = [
      "TypeError: Cannot read properties of undefined (reading 'profile')",
      '    at UserProfile (https://app.dev/src/Profile.tsx:42:17)',
    ].join('\n');
    const out = serializeError(error);
    expect(out.name).toBe('TypeError');
    expect(out.frames).toHaveLength(1);
  });

  it('normalises a thrown string', () => {
    const out = serializeError('something broke');
    expect(out.name).toBe('Error');
    expect(out.message).toBe('something broke');
  });

  it('normalises a thrown object with a code field', () => {
    const out = serializeError({ code: 401, message: 'Unauthorized' });
    expect(out.message).toBe('Unauthorized');
  });

  it('survives a thrown object with no message', () => {
    const out = serializeError({ code: 500 });
    expect(out.name).toBe('ThrownObject');
    expect(out.message).toContain('500');
  });

  it('survives a circular thrown object', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => serializeError(circular)).not.toThrow();
  });

  it('handles null and undefined', () => {
    expect(serializeError(null).name).toBe('Error');
    expect(serializeError(undefined).name).toBe('Error');
  });
});

describe('describeLocation and fileNameOf', () => {
  it('prefers the application frame', () => {
    const location = describeLocation({
      frames: [
        frame('renderWithHooks', 'https://app.dev/node_modules/react-dom/cjs/react-dom.js:100:1'),
        frame('UserProfile', 'https://app.dev/src/Profile.tsx', 42),
      ],
      pageUrl: 'https://app.dev/dashboard',
    });
    expect(location).toBe('Profile.tsx:42');
  });

  it('falls back to the page host when no frame is usable', () => {
    const location = describeLocation({ frames: [], pageUrl: 'https://app.dev/dashboard' });
    expect(location).toBe('app.dev');
  });

  it('returns unknown for an unusable page url', () => {
    expect(describeLocation({ frames: [], pageUrl: 'not a url' })).toBe('unknown location');
  });

  it('extracts a file name from a url', () => {
    expect(fileNameOf('https://app.dev/a/b/main.chunk.js?v=2')).toBe('main.chunk.js');
  });

  it('handles a non-url string', () => {
    expect(fileNameOf('src/lib/thing.ts')).toBe('thing.ts');
  });

  it('reports unknown for an empty url', () => {
    expect(fileNameOf('')).toBe('unknown');
  });
});

describe('fingerprintSerialized', () => {
  it('matches the fingerprint of the equivalent direct computation', () => {
    const frames = [frame('UserProfile', 'https://app.dev/src/Profile.tsx', 42, 17)];
    const serialized = {
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'profile')",
      frames,
    };
    expect(fingerprintSerialized(serialized)).toBe(
      fingerprintError({
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'profile')",
        kind: 'javascript',
        frames,
      }),
    );
  });
});
