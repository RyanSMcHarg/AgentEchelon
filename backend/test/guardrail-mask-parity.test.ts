/**
 * The chat SPA's copy of the guardrail mask token matches the backend's declaration.
 *
 * WHY A COPY EXISTS AT ALL. `lib/config/guardrail-masks.ts` is the one declaration of the filter name,
 * read by the CDK construct that provisions the filter and by the runtime that strips the token. A
 * browser bundle can import neither, so `frontend/packages/shared/src/utils/messageParser.ts` carries
 * the literal - and it has to carry it, because the backend strip runs at the guardrail boundary and
 * cannot reach a message that was already persisted in Amazon Chime SDK before the fix shipped. The
 * SPA is the only thing standing between a stored token and the person re-reading that conversation.
 *
 * WHY THE COPY NEEDS A GUARD. Renaming the filter renames what Bedrock substitutes. The backend would
 * follow in one edit; the SPA would keep stripping a token nothing produces any more, and the new one
 * would be rendered to every reader. Nothing would fail. This is the same failure shape
 * `attribution-pattern-parity.test.ts` exists for, and the same one a corrupted guardrail escape
 * produced once already.
 *
 * It compares BEHAVIOUR, not source text: the SPA's parser is run over the token the backend declares.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  INTERNAL_MARKER_MASK_FILTER_NAMES,
  guardrailMaskToken,
} from '../lib/config/guardrail-masks';

const PARSER_PATH = path.join(
  __dirname, '../../frontend/packages/shared/src/utils/messageParser.ts',
);

/** The mask-token patterns the SHIPPED parser applies, read out of its source. */
function spaMaskPatterns(): RegExp[] {
  const src = fs.readFileSync(PARSER_PATH, 'utf8');
  // `content = content.replace(/\{Name\}/g, '');` - the brace-delimited replacements only.
  const matches = [...src.matchAll(/content\s*=\s*content\.replace\((\/\\\{[^/]+\\\}\/[gimsuy]*)\s*,/g)];
  return matches.map((m) => {
    const body = m[1];
    const lastSlash = body.lastIndexOf('/');
    return new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1));
  });
}

describe('the chat SPA strips every mask token the backend can produce', () => {
  it('finds the SPA mask-token strip at all (the guard is not vacuous)', () => {
    expect(spaMaskPatterns().length).toBeGreaterThan(0);
  });

  it.each(INTERNAL_MARKER_MASK_FILTER_NAMES.map((name) => [name]))(
    'strips the token for %s',
    (name: string) => {
      const token = guardrailMaskToken(name);
      const stripped = spaMaskPatterns().reduce((s, re) => {
        re.lastIndex = 0;
        return s.replace(re, '');
      }, `Here is the answer.${token}`);
      expect(stripped).toBe('Here is the answer.');
    },
  );

  // A PII entity mask is the INTENDED output of an ANONYMIZE entity rule, so removing it would delete
  // the evidence that a redaction happened. The backend excludes it deliberately; the SPA must too, or
  // the two disagree about what the reader is meant to see.
  it('does not strip a PII entity mask', () => {
    const stripped = spaMaskPatterns().reduce((s, re) => {
      re.lastIndex = 0;
      return s.replace(re, '');
    }, 'Reach the team at {EMAIL}.');
    expect(stripped).toBe('Reach the team at {EMAIL}.');
  });
});
