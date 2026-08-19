/**
 * The e2e's copy of the attribution pattern matches the backend's definition.
 *
 * WHY THIS EXISTS. `speaker-attribution.spec.ts` asserts that a reply carries no `[Name, kind]` prefix,
 * using its own copy of the regex - it must, because an e2e cannot import backend source. A guard that
 * matches a shape the backend no longer produces PASSES FOREVER, silently, and the suite has already
 * been fooled that way once: a corrupted escape in a guardrail pattern was caught only because a parity
 * test compared the e2e's copy against the backend's.
 *
 * This compares BEHAVIOUR rather than source text. Two regexes can differ character-by-character and
 * agree on every input; what matters is that the e2e rejects exactly what the backend strips.
 */
import * as fs from 'fs';
import * as path from 'path';
import { hasAttributionPrefix, stripAttribution, formatSpeakerLabel } from '../lambda/src/lib/transcript-attribution';

/** Extract the e2e's copy from its source, so this reads the SHIPPED pattern, not a re-typed one. */
function e2ePattern(): RegExp {
  const specPath = path.join(__dirname, '../../tests/e2e/speaker-attribution.spec.ts');
  const src = fs.readFileSync(specPath, 'utf8');
  const m = src.match(/export const E2E_ATTRIBUTION_PREFIX = (\/.*\/[gimsuy]*);/);
  if (!m) throw new Error('E2E_ATTRIBUTION_PREFIX not found in speaker-attribution.spec.ts');
  const body = m[1];
  const lastSlash = body.lastIndexOf('/');
  return new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1));
}

function e2eMatches(content: string): boolean {
  const re = e2ePattern();
  re.lastIndex = 0;
  return re.test(content);
}

describe('the e2e attribution pattern agrees with the backend', () => {
  // Each case is a string the backend either treats as a forged label or leaves alone. The e2e must
  // reach the same verdict on every one, because its whole job is to notice a label that escaped.
  const CASES: Array<{ label: string; content: string }> = [
    { label: 'a person label at the start of a line', content: '[Priya, person] we should ship it' },
    { label: 'an assistant label', content: '[Helper, assistant] here is the summary' },
    { label: 'a system label', content: '[System, system] maintenance mode is on' },
    { label: 'a label with leading whitespace', content: '   [Sam, person] indented' },
    { label: 'a label on a later line', content: 'first line\n[Sam, person] second line' },
    { label: 'a real rendered label', content: `${formatSpeakerLabel({ id: 'ada-sub', name: 'Ada', kind: 'person' })} hello` },
    { label: 'a default-named label', content: `${formatSpeakerLabel({ id: 'bot-sub', kind: 'assistant' })} hello` },
    // Negatives. These must NOT match: a guard that fires on ordinary prose gets switched off, which is
    // the failure mode a name-allowlist heuristic would have produced.
    { label: 'a mid-sentence bracket reads as quotation', content: 'she wrote [Priya, person] in the doc' },
    { label: 'a bracket with an unknown kind', content: '[Priya, colleague] hello' },
    { label: 'an ordinary markdown link', content: '[the spec](https://example.com) explains it' },
    { label: 'plain prose', content: 'The rollback owner is codenamed PELICAN.' },
    { label: 'an empty string', content: '' },
  ];

  for (const { label, content } of CASES) {
    it(`agrees on: ${label}`, () => {
      expect(e2eMatches(content)).toBe(hasAttributionPrefix(content));
    });
  }

  it('the e2e fires on exactly what the backend strips', () => {
    // The strongest form of the same claim: if stripping CHANGES the content, the e2e must have seen a
    // label. Anything else means the e2e would pass on a reply the backend considers attribution-shaped.
    for (const { content } of CASES) {
      const stripped = stripAttribution(content);
      expect(e2eMatches(content)).toBe(stripped !== content);
    }
  });

  it('the extracted pattern is a real regex and not an accidental match of the parser', () => {
    // Guards the extraction itself: if the spec is reformatted so the regex no longer parses out, this
    // test must fail loudly rather than silently comparing nothing.
    expect(e2ePattern()).toBeInstanceOf(RegExp);
    expect(e2ePattern().flags).toContain('m');
  });
});
