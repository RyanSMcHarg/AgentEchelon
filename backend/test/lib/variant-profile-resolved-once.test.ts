/**
 * A `profileRef` variant's version IS the definition for the turn, and it is resolved EXACTLY ONCE.
 *
 * WHY THIS GUARD EXISTS. The processor resolved the profile twice. The first resolution honoured
 * `event.variantProfile` (SPEC-PORTABLE §6) and fed the persona; the second called
 * `resolveActiveProfile` again, unconditionally, and fed everything else - the tool allowlist, the
 * guardrail selection, per-intent model routing, the base model and the attribution `configId`. So a
 * turn serving a variant got the VARIANT'S persona and the ACTIVE version's everything-else.
 *
 * WHAT THAT COST, AND WHY NO TEST CAUGHT IT. A `profileRef` experiment whose two versions differ only
 * in tools, guardrail, per-intent routing or image model ran BOTH ARMS IDENTICALLY and reported
 * "indistinguishable". That is a false negative that reads exactly like a real result: nothing errors,
 * both arms answer, the console shows a clean verdict, and the conclusion drawn from it is wrong. Every
 * such turn was also attributed to the active version's `configId`, so the analytics join pointed at a
 * version that did not serve the turn.
 *
 * The shape of the defect is two lookups that are SUPPOSED to agree. This pins one binding instead,
 * because "they agree" is a property nobody re-checks after the next edit.
 */
import { stripComments } from '../helpers/strip-comments';
import * as fs from 'fs';
import * as path from 'path';

const PROCESSOR = path.join(__dirname, '..', '..', 'lambda', 'src', 'assistant-async-processor.ts');

/**
 * Source with comments stripped, so the rationale above (and the processor's own, which names the
 * function it no longer calls twice) cannot satisfy a check.
 *
 * Uses the SHARED stripper: a bare `\/\*` pattern treats an IAM/ARN glob such as
 * `${appInstanceArn}/user/*` as a comment opener and blanks everything to the next close-comment, which
 * defeated a sibling scan in this repo. One definition means a new ratchet inherits the fix instead of
 * copying whichever version it happened to find.
 */
const code = stripComments(fs.readFileSync(PROCESSOR, 'utf8'));

describe('the serving profile version is resolved once per turn', () => {
  it('calls resolveActiveProfile exactly once', () => {
    // Two calls is the defect itself: the second one cannot see `event.variantProfile`, so it serves
    // the profile's ACTIVE version to every consumer downstream of it.
    const calls = (code.match(/\bresolveActiveProfile\s*\(/g) || []).length;
    expect(calls).toBe(1);
  });

  it('that one call is the variant-aware branch', () => {
    // The single call must sit on the `event.variantProfile ? … : …` fallback, so a variant turn never
    // reaches SSM for the active version at all.
    expect(code).toMatch(/event\.variantProfile[\s\S]{0,200}resolveFromDefinition[\s\S]{0,200}resolveActiveProfile/);
  });

  it('every downstream consumer reads the resolved object, not a second lookup', () => {
    // The consumers that made this matter. Each one must be fed from the binding, so adding a consumer
    // later inherits the variant automatically rather than needing to remember.
    // A fixed window after the binding rather than a delimiter search: the consumers sit within a few
    // dozen lines, and a blank-line delimiter moves every time someone reformats.
    const from = code.indexOf('const active = ');
    expect(from).toBeGreaterThan(-1);
    const window = code.slice(from, from + 3000);
    expect(window).toMatch(/const active = activeProfile;/);
    for (const consumer of ['active.profile.modelKey', 'active.models', 'active.tools', 'active.guardrailId', 'active.configId']) {
      expect(window).toContain(consumer);
    }
  });
});
