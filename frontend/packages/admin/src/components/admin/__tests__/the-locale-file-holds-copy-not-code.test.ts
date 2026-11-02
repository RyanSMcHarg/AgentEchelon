/**
 * THE LOCALE FILE HOLDS COPY, AND NOTHING ELSE.
 *
 * Bulk conversion moves strings by heuristic, and a heuristic that is wrong lands something in `en.json`
 * that was never copy. Three of those were found on 2026-10-02 and removed: `"1px solid {{surface}}"`, a CSS
 * declaration; `"(props: DataTableProps"`, a TypeScript generic the matcher tore in half; and
 * `"Bearer {{idToken}}"`, an HTTP authorization header.
 *
 * The last one is the reason this is a test rather than a note. A translator given "Bearer {{idToken}}"
 * may reasonably translate the word, and if any code path ever reads that key the request fails
 * authentication - a localization change breaking auth, which is a very long way from where anyone would
 * look. The other two are only waste, but they are waste a person is asked to read.
 *
 * This checks the VALUES, so it also covers whatever the next bulk pass gets wrong. It does not try to
 * decide whether copy is good - only that it is copy.
 */
import { describe, it, expect } from 'vitest';
import en from '@ae/shared/locales/en.json';

/** Every leaf, as dotted key + value. */
const leaves = (obj: unknown, prefix = ''): Array<[string, string]> => {
  if (typeof obj === 'string') return [[prefix, obj]];
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj as Record<string, unknown>)
    .flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
};

const ALL = leaves(en);

/**
 * Patterns that are never user-facing copy.
 *
 * Each is anchored tightly enough not to catch real prose: "2px" only as a CSS length, `var(--` only as a
 * custom property, and the auth scheme only at the start of a value.
 */
const NOT_COPY: Array<[string, RegExp]> = [
  ['a CSS length', /(?:^|\s)\d+(?:px|rem|em)(?:\s|$)/],
  ['a CSS custom property', /var\(--/],
  ['a CSS declaration', /^[a-z-]+:\s*(?:#[0-9a-f]{3,8}|\d|var\()/i],
  ['an rgb/rgba color', /\brgba?\(\s*\d/],
  // `Basic` alone is a classification name in this product, so the scheme only counts when a credential
  // follows it - a template hole, or a long opaque token.
  ['an HTTP auth scheme', /^(?:Bearer|Basic|Digest)\s+(?:\{\{|[A-Za-z0-9._~+/-]{12,}=*$)/],
  ['a TypeScript generic or signature', /\(props:|<[A-Z]\w*(?:Props|Type)\b|=>\s*\w/],
  ['a link rel value', /^(?:noopener|noreferrer)(?:\s+(?:noopener|noreferrer))*$/],
  // EVERY token hyphenated. Requiring only the first made this reject "tool-loop steps" and
  // "classifier-accuracy measurement pending", which are prose that happens to contain a compound word.
  ['a bare className list', /^[a-z][a-z0-9]*(?:-{1,2}[a-z0-9]+)+(?:\s+[a-z][a-z0-9]*(?:-{1,2}[a-z0-9]+)+)+$/],
];

describe('en.json', () => {
  it('contains no value that is code, CSS, or a protocol token', () => {
    const offenders: string[] = [];
    for (const [key, value] of ALL) {
      for (const [what, re] of NOT_COPY) {
        if (re.test(value)) { offenders.push(`${key} looks like ${what}: ${JSON.stringify(value).slice(0, 80)}`); break; }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('REJECTS the three real examples, so the patterns are not inert', () => {
    // Taken verbatim from the keys removed on 2026-10-02. If a pattern stops matching its own example,
    // this test is no longer checking what its header says it checks.
    const examples = ['1px solid {{surface}}', '(props: DataTableProps', 'Bearer {{idToken}}'];
    for (const ex of examples) {
      expect(NOT_COPY.some(([, re]) => re.test(ex)), `nothing rejects ${ex}`).toBe(true);
    }
  });

  it('accepts ordinary copy, including copy that mentions numbers and markup tags', () => {
    const fine = [
      'Hide rates over fewer than 30 observations',
      'This intent ran as multi-step <b>tasks</b> in this window.',
      '{{unscored}} of {{total}} exchanges carry no evaluator score.',
      'Cumulative Layout Shift (×1000)',
      'Quality ≥{{target}}% target',
      // Prose containing a compound word, and a tier name that is also an auth scheme. Both were
      // wrongly rejected by the first version of the patterns above.
      'tool-loop steps',
      'classifier-accuracy measurement pending',
      'Basic',
      'Basic tier and above',
    ];
    for (const ok of fine) {
      const hit = NOT_COPY.find(([, re]) => re.test(ok));
      expect(hit?.[0], `${JSON.stringify(ok)} was wrongly rejected as ${hit?.[0]}`).toBeUndefined();
    }
  });
});
