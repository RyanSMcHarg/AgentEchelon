/**
 * A `profileRef` variant's version IS the definition for the turn, and it is resolved EXACTLY ONCE.
 *
 * WHY THIS GUARD EXISTS. The processor resolved the profile twice. The first resolution honored
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
  it('calls resolveActiveProfile exactly once for the serving definition', () => {
    // Two calls is the defect itself: the second one cannot see `event.variantProfile`, so it serves
    // the profile's ACTIVE version to every consumer downstream of it.
    // No other read of the active version sits beside it: the external provider is the classification's
    // selection (`externalProviderSelected`), not a field on any version.
    const calls = (code.match(/\bresolveActiveProfile\s*\(/g) || []).length;
    expect(calls).toBe(1);
  });

  it('that one call is the variant-aware branch', () => {
    // The single call must sit on the `event.variantProfile ? … : …` fallback, so a variant turn's
    // serving definition never comes from the active version.
    // The vend's narrowed version (`resolveProfileVersion`) sits between them: still one expression, so
    // a variant turn still never reaches SSM for any other version.
    expect(code).toMatch(/event\.variantProfile[\s\S]{0,200}resolveFromDefinition[\s\S]{0,300}resolveProfileVersion[\s\S]{0,200}resolveActiveProfile/);
  });

  it('the narrowed version is resolved once too', () => {
    expect((code.match(/\bresolveProfileVersion\s*\(/g) || []).length).toBe(1);
  });

  it('every downstream consumer reads the resolved object, not a second lookup', () => {
    // The consumers that made this matter. Each one must be fed from the binding, so adding a consumer
    // later inherits the variant automatically rather than needing to remember.
    // From the binding to the turn's attribution log, which names the version that served it: the turns that run alone
    // (an event step, a voice send, a prompt welcome) sit between them, so a fixed window no longer reaches the log.
    const from = code.indexOf('const active = ');
    expect(from).toBeGreaterThan(-1);
    const to = code.indexOf("'[AssistantAsyncProcessor] active profile'", from);
    expect(to).toBeGreaterThan(from);
    const window = code.slice(from, to + 200);
    expect(window).toMatch(/const active = activeProfile;/);
    for (const consumer of ['active.profile.modelKey', 'active.models', 'active.tools', 'active.guardrailId', 'active.configId']) {
      expect(window).toContain(consumer);
    }
  });
});
