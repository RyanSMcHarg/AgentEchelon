/**
 * AN ASSISTANT'S CAPABILITIES ARE SAID ONCE, and the sentence a person reads is assembled from the
 * taxonomy that actually decides.
 *
 * THE DEFECT THIS CLOSES. Capabilities were authored twice: as the intent pack, which decides what the
 * assistant recognizes, and as prose in the onboarding greeting, which told a person what it covers.
 * Two hand-maintained statements of one fact on the same profile, with nothing comparing them - so a
 * pack edit left the greeting lying and no test failed. The greeting is the more dangerous half,
 * because it is the thing a person acts on.
 *
 * THE HALF THAT STAYS AUTHORED. Absence is not a phrase. A pack says nothing about the intents it does
 * not declare, so "I cannot see customer accounts" is underivable - and in a room holding several
 * assistants that is the sentence that sends somebody to the right one. It is `boundary` on the profile.
 */
import {
  capabilityStatement,
  isEmptyStatement,
} from '../lambda/src/lib/assistant-capabilities';
import {
  advertisedIntents,
  resolveStoredPack,
  validateIntentPackBody,
  MAX_INTENT_SUMMARY,
  MAX_ADVERTISED_IN_INTRODUCTION,
  type StoredIntentPack,
} from '../lambda/src/lib/intent-pack';
import { stratumIntentPack, opsIntentPack } from '../demo/intent-packs';
import { BASIC_ONBOARDING, STANDARD_ONBOARDING, PREMIUM_ONBOARDING } from '../demo/onboarding';
import { BASIC_BOUNDARY, STANDARD_BOUNDARY, PREMIUM_BOUNDARY } from '../demo/boundaries';

const packFor = (t: 'basic' | 'standard' | 'premium') => resolveStoredPack(stratumIntentPack(t));

describe('what an assistant says it does is derived from what it recognizes', () => {
  it('only advertises intents that carry a person-facing summary', () => {
    // Absence is the default, so advertising is a decision rather than a consequence of declaring an
    // intent. An assistant that listed everything it could classify would introduce itself with a menu.
    const pack: StoredIntentPack = {
      intents: [
        { key: 'shown', description: 'd', keywords: ['k'], delivery: 'PLACEHOLDER_UPDATE', summary: 'you get this' },
        { key: 'hidden', description: 'd', keywords: ['k'], delivery: 'PLACEHOLDER_UPDATE' },
      ],
    };
    expect(advertisedIntents(resolveStoredPack(pack)).map((a) => a.key)).toEqual(['shown']);
  });

  it('changes when the pack changes, which is the whole point', () => {
    const before = capabilityStatement({ pack: packFor('basic') });
    const withExtra: StoredIntentPack = {
      intents: [
        ...stratumIntentPack('basic').intents,
        { key: 'new_thing', description: 'd', keywords: ['k'], delivery: 'PLACEHOLDER_UPDATE', summary: 'ask me something new' },
      ],
    };
    const after = capabilityStatement({ pack: resolveStoredPack(withExtra) });
    expect(after.does).not.toEqual(before.does);
    expect(after.does).toContain('ask me something new');
  });

  it('caps an INTRODUCTION but not an answer to a direct question', () => {
    // The same content serves both and they fail differently: an introduction competes with a person's
    // patience, while somebody who ASKED has opted into the longer answer.
    const many: StoredIntentPack = {
      intents: Array.from({ length: MAX_ADVERTISED_IN_INTRODUCTION + 3 }, (_, i) => ({
        key: `k${i}`, description: 'd', keywords: ['k'], delivery: 'PLACEHOLDER_UPDATE' as const, summary: `thing ${i}`,
      })),
    };
    const intro = capabilityStatement({ pack: resolveStoredPack(many), forIntroduction: true });
    expect(intro.does).toHaveLength(MAX_ADVERTISED_IN_INTRODUCTION);
    expect(intro.truncated).toBe(true);

    const asked = capabilityStatement({ pack: resolveStoredPack(many) });
    expect(asked.does).toHaveLength(MAX_ADVERTISED_IN_INTRODUCTION + 3);
    expect(asked.truncated).toBe(false);
  });

  it('returns parts, never a sentence, so the joining words stay the deployment\'s', () => {
    // Every word a person reads carries the assistant's persona and the conversation's language
    // (tenets P5 and D11). A module that returned "I can help with: ..." would be fixed English in a new
    // place, which is the defect this replaced rather than a smaller version of it.
    const s = capabilityStatement({ pack: packFor('premium'), boundary: PREMIUM_BOUNDARY });
    expect(Array.isArray(s.does)).toBe(true);
    for (const line of s.does) expect(line).not.toMatch(/I can help with|Here is what/i);
  });

  it('says nothing when there is nothing to say', () => {
    const s = capabilityStatement({ pack: resolveStoredPack({ intents: [{ key: 'k', description: 'd', keywords: ['k'], delivery: 'PLACEHOLDER_UPDATE' }] }) });
    expect(isEmptyStatement(s)).toBe(true);
    // ...but a boundary alone is still worth saying, so it is not empty.
    expect(isEmptyStatement({ ...s, boundary: 'I cannot see accounts.' })).toBe(false);
  });
});

describe('the boundary is authored, because absence is not derivable', () => {
  it('every shipped assistant states what it cannot reach', () => {
    for (const b of [BASIC_BOUNDARY, STANDARD_BOUNDARY, PREMIUM_BOUNDARY]) {
      expect(b.length).toBeGreaterThan(0);
      expect(b).toMatch(/cannot|outside|not/i);
    }
  });

  it('the boundary is NOT recoverable from the pack, which is why it is a field', () => {
    // Stated as a test so the next person to propose "derive the whole introduction" sees why it fails:
    // nothing in basic's advertised intents mentions customer accounts, because it does not have that
    // intent - and the useful sentence is precisely about the thing that is not there.
    const advertised = capabilityStatement({ pack: packFor('basic') }).does.join(' ').toLowerCase();
    expect(advertised).not.toContain('customer account');
    expect(BASIC_BOUNDARY.toLowerCase()).toContain('customer account');
  });
});

describe('the greeting no longer restates what the pack already says', () => {
  it.each([
    ['basic', BASIC_ONBOARDING],
    ['standard', STANDARD_ONBOARDING],
    ['premium', PREMIUM_ONBOARDING],
  ] as const)('the %s greeting carries no capability prose', (_name, intake) => {
    // The drift guard. A greeting that lists coverage is a second hand-maintained copy of the pack, and
    // the one that goes stale silently. If somebody reintroduces one, this fails and says why.
    const g = (intake.greeting ?? '').toLowerCase();
    for (const phrase of ['i can help with', 'i can reach', 'ask me for a figure', 'i answer questions about']) {
      expect(g).not.toContain(phrase);
    }
    expect((intake.greeting ?? '').length).toBeLessThan(120);
  });
});

describe('the person-facing line is bounded and is not the classifier line', () => {
  it('refuses a summary over the limit', () => {
    const errs = validateIntentPackBody({
      intents: [{ key: 'k', description: 'd', keywords: ['x'], delivery: 'PLACEHOLDER_UPDATE', summary: 'x'.repeat(MAX_INTENT_SUMMARY + 1) }],
    });
    expect(errs.join(' ')).toContain('summary is');
  });

  it('every shipped summary fits, and none of them is the description', () => {
    for (const tier of ['basic', 'standard', 'premium'] as const) {
      const pack = stratumIntentPack(tier);
      for (const intent of pack.intents) {
        if (!intent.summary) continue;
        expect(intent.summary.length).toBeLessThanOrEqual(MAX_INTENT_SUMMARY);
        // Two jobs, two voices. If a summary is ever just the description, the split has collapsed.
        expect(intent.summary).not.toBe(intent.description);
      }
    }
  });

  it('each shipped assistant advertises something', () => {
    for (const tier of ['basic', 'standard', 'premium'] as const) {
      expect(capabilityStatement({ pack: packFor(tier) }).does.length).toBeGreaterThan(0);
    }
    // THE ROLE'S ASSISTANT TOO, and it is the one that most needs to be advertised: a primary deciding
    // where to send an operational question reads exactly these lines, and `ops-premium` had no pack at
    // all, so there was nothing to read and nowhere to send it.
    expect(capabilityStatement({ pack: resolveStoredPack(opsIntentPack()) }).does.length).toBeGreaterThan(0);
  });

  it('every ops summary fits, and none of them is the description', () => {
    for (const intent of opsIntentPack().intents) {
      if (!intent.summary) continue;
      expect(intent.summary.length).toBeLessThanOrEqual(MAX_INTENT_SUMMARY);
      expect(intent.summary).not.toBe(intent.description);
    }
  });
});
