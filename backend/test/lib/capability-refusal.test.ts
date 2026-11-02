/**
 * A REQUEST FOR SOMETHING THIS ASSISTANT DOES NOT OFFER IS RECOGNIZED AND REFUSED (DESIGN-CAPABILITY-REFUSAL).
 *
 * Measured live 2026-10-05: basic's pack declares no `report_generation`, so "Compile a one-page
 * overview of the StratumFlow product" classified `general` and was answered inline. The owner's rule:
 * a request for a platform intent the assistant's pack does not declare is refused, and the person is
 * told where they could get it - "non-existence should trigger refusal".
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────────────────────────
 *
 *  1. ABSENCE decides: every platform intent the served pack does not declare is refused, and nothing
 *     a pack declares is (so an `extends: 'default'` pack refuses nothing);
 *  2. the MODEL decides, never a matched word: refused intents reach the model's categories and never
 *     the keyword path, and a failed model call refuses nothing (tenet D11);
 *  3. WHAT THE PERSON IS TOLD comes from declarations (`produces`, `needs`) and their clearance, and
 *     the no-access line names no classification;
 *  4. the refusal is a FINAL answer with the `REFUSED` delivery, so it pairs as the exchange;
 *  5. the router refuses after DIRECT and before the claim, from the assistant's OWN pack.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  ConverseCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}), { virtual: true });

import { classifyIntent, classifyIntentByKeyword } from '../../lambda/src/lib/intent-classifier';
import {
  DEFAULT_INTENT_PACK,
  getIntentPack,
  needsOf,
  refusedPlatformIntents,
  validateIntentPackBody,
  type IntentPack,
} from '../../lambda/src/lib/intent-pack';
import { composeRefusal, DEFAULT_REFUSAL_COPY } from '../../lambda/src/lib/capability-refusal';
import { turnDeclarationOf, withTurnDeclaration } from '../../lambda/src/lib/turn-declaration';
import { DeliveryOption } from '../../lambda/src/lib/delivery-options';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { DEFAULT_PROFILES_CONFIG, validateProfilesConfig } from '../../lib/config/profiles';
import { stratumIntentPack } from '../../demo/intent-packs';
import { ownWords } from '../helpers/own-templates';

/** Basic's demo pack, resolved the way a reader resolves it: no `extends`, so it replaces. */
const basicPack: IntentPack = { intents: stratumIntentPack('basic').intents as IntentPack['intents'] };

function modelSays(category: string) {
  mockSend.mockResolvedValueOnce({
    output: { message: { content: [{ text: category }] } },
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

function lastPrompt(): string {
  const call = mockSend.mock.calls[mockSend.mock.calls.length - 1][0];
  return call.input.messages[0].content[0].text as string;
}

beforeEach(() => mockSend.mockReset());

describe('absence decides what is refused', () => {
  it('refuses every platform intent basic does not declare, and none it does', () => {
    const refused = refusedPlatformIntents(basicPack).map((d) => d.key);
    expect(refused).toEqual(expect.arrayContaining([
      'report_generation', 'data_extraction', 'image_generation', 'code_generation', 'code_review', 'strategic_analysis',
    ]));
    expect(refused).not.toContain('guided_troubleshooting');
    expect(refused).not.toContain('product_info');
  });

  it('refuses nothing for a pack that inherits the platform taxonomy', () => {
    expect(refusedPlatformIntents(DEFAULT_INTENT_PACK)).toEqual([]);
  });

  it('carries the PLATFORM definition, which is what lets the model recognize the request', () => {
    const report = refusedPlatformIntents(basicPack).find((d) => d.key === 'report_generation')!;
    expect(report.description).toBe(DEFAULT_INTENT_PACK.intents.find((d) => d.key === 'report_generation')!.description);
    expect(needsOf(report)).toBe('document');
    expect(needsOf({ key: 'code_generation' })).toBeUndefined();
    expect(needsOf({ key: 'my_report', needs: 'document' })).toBe('document');
  });
});

describe('the model decides; a matched word never does (tenet D11)', () => {
  const refused = refusedPlatformIntents(basicPack);

  it('offers the refused intents to the model as categories', async () => {
    modelSays('GENERAL');
    await classifyIntent('Compile a one-page report on the StratumFlow product', { pack: basicPack, refused });
    expect(lastPrompt()).toContain('REPORT_GENERATION');
    expect(lastPrompt()).toContain('IMAGE_GENERATION');
  });

  it('marks a request for a refused intent as refused, with its key', async () => {
    modelSays('REPORT_GENERATION');
    const result = await classifyIntent('Compile a one-page report on the StratumFlow product', { pack: basicPack, refused });
    expect(result).toMatchObject({ intent: 'report_generation', refused: true });
  });

  it('never refuses an intent the served pack declares, whatever the caller passed', async () => {
    modelSays('GUIDED_TROUBLESHOOTING');
    const result = await classifyIntent('my sync keeps failing', {
      pack: basicPack,
      refused: [...refused, DEFAULT_INTENT_PACK.intents.find((d) => d.key === 'guided_troubleshooting')!],
    });
    expect(result.intent).toBe('guided_troubleshooting');
    expect(result.refused).toBeUndefined();
  });

  it('refuses nothing when the model call fails: the keyword fallback answers as before', async () => {
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    const result = await classifyIntent('please compile a report', { pack: basicPack, refused });
    expect(result.refused).toBeUndefined();
  });

  it('the keyword path never refuses, even on a word a refused intent owns', () => {
    const result = classifyIntentByKeyword('please compile a report', basicPack);
    expect(result.intent).not.toBe('report_generation');
    expect((result as { refused?: boolean }).refused).toBeUndefined();
  });
});

describe('summarizing the conversation is the platform\'s, not a report', () => {
  const refused = refusedPlatformIntents(basicPack);

  it('is a universal intent every assistant has, so it is never in the refused set', () => {
    expect(refused.map((d) => d.key)).not.toContain('conversation_summary');
    expect(refusedPlatformIntents({ intents: [] }).map((d) => d.key)).not.toContain('conversation_summary');
  });

  it('is offered to the model as its own category, distinct from a report', async () => {
    modelSays('GENERAL');
    await classifyIntent('summarize what we discussed', { pack: basicPack, refused });
    expect(lastPrompt()).toMatch(/CONVERSATION_SUMMARY: .*never REPORT_GENERATION/);
  });

  it('is answered on basic, not refused', async () => {
    modelSays('CONVERSATION_SUMMARY');
    const result = await classifyIntent('summarize what we discussed', { pack: basicPack, refused });
    expect(result.intent).toBe('conversation_summary');
    expect(result.refused).toBeUndefined();
  });

  it('cannot be declared, overridden or dropped by a pack', () => {
    const errs = validateIntentPackBody({
      intents: [{ key: 'conversation_summary', description: 'x', keywords: [], delivery: 'TASK_MULTI_STEP' }],
    });
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('what the person is told', () => {
  const base = { channelClassification: 'basic', registry: profiles };

  it('lists the classifications the person reaches that produce the output', () => {
    const r = composeRefusal({ ...base, need: 'document', userClearance: 'premium' });
    expect(r.refusal).toBe("I don't produce report documents in this conversation.");
    expect(r.access).toBe(`${DEFAULT_REFUSAL_COPY.capabilityHasAccess}\n- Standard\n- Premium\n\n${DEFAULT_REFUSAL_COPY.capabilityHasAccessClose}`);
  });

  it('lists only the classifications that produce THAT output', () => {
    const r = composeRefusal({ ...base, need: 'image', userClearance: 'premium' });
    expect(r.access).toContain('- Premium');
    expect(r.access).not.toContain('Standard');
  });

  it('sends a person who reaches none to their administrator, naming no classification', () => {
    const r = composeRefusal({ ...base, need: 'image', userClearance: 'standard' });
    expect(r.access).toBe('If you need images, ask your administrator for access.');
    for (const c of DEFAULT_PROFILES_CONFIG.classifications) {
      // Whole words: "administrator" is the route, not the `admin` classification.
      expect(r.access!.toLowerCase()).not.toMatch(new RegExp(`\\b${c.value}\\b`));
      if (c.displayName) expect(r.access).not.toContain(c.displayName);
    }
  });

  it('says nothing about access when clearance did not resolve', () => {
    expect(composeRefusal({ ...base, need: 'document', userClearance: undefined }))
      .toEqual({ refusal: "I don't produce report documents in this conversation." });
  });

  it('for an intent with no output, points at an administrator only when nothing else is reachable', () => {
    expect(composeRefusal({ ...base, userClearance: 'basic' })).toEqual({
      refusal: DEFAULT_REFUSAL_COPY.capabilityNotOffered,
      access: DEFAULT_REFUSAL_COPY.capabilityNotOfferedNeedsAccess,
    });
    expect(composeRefusal({ ...base, userClearance: 'standard' })).toEqual({
      refusal: DEFAULT_REFUSAL_COPY.capabilityNotOffered,
    });
  });

  it('never points at the admin plane, which reaches admin conversations only', () => {
    // The admin classification grants itself alone, so an admin-plane holder reaches no conversation that
    // produces a document and is pointed at access, never at a member classification or the admin plane.
    const r = composeRefusal({ ...base, need: 'document', userClearance: 'admin' });
    expect(r.access).not.toMatch(/admin\b/i);
    expect(r.access).not.toContain('- ');
    expect(r.access).toBe(DEFAULT_REFUSAL_COPY.capabilityNeedsAccess.split('{output}').join('report documents'));
  });

  it('speaks the assistant\'s own words where it authored them', () => {
    const r = composeRefusal({
      ...base, need: 'document', userClearance: 'basic',
      copy: ownWords({ capabilityUnavailable: 'Reports live elsewhere: no {output} here.', capabilityOutputDocument: 'write-ups' }),
    });
    expect(r.refusal).toBe('Reports live elsewhere: no write-ups here.');
    expect(r.access).toBe('If you need write-ups, ask your administrator for access.');
  });
});

describe('the refusal is the answer, and is counted as one', () => {
  it('declares a final answer with the REFUSED delivery', () => {
    const content = withTurnDeclaration('No reports here.', { answers: 'msg-1', delivery: DeliveryOption.REFUSED, phase: 'final' });
    expect(turnDeclarationOf(content)).toEqual({ answers: 'msg-1', delivery: 'REFUSED', phase: 'final' });
  });
});

describe('what a classification produces is declared once', () => {
  it('matches what each demo stack wires', () => {
    expect(profiles.produces('basic', 'document')).toBe(false);
    expect(profiles.produces('basic', 'image')).toBe(false);
    expect(profiles.produces('standard', 'document')).toBe(true);
    expect(profiles.produces('standard', 'image')).toBe(false);
    expect(profiles.produces('premium', 'image')).toBe(true);
    expect(profiles.produces('admin', 'document')).toBe(false);
  });

  it('refuses an output the platform does not know', () => {
    const config = JSON.parse(JSON.stringify(DEFAULT_PROFILES_CONFIG));
    config.classifications.find((c: { value: string }) => c.value === 'standard').produces = ['spreadsheet'];
    expect(() => validateProfilesConfig(config)).toThrow(/unknown output 'spreadsheet'/);
  });

  it('refuses an intent that declares an unknown need', () => {
    const errs = validateIntentPackBody({ intents: [{ key: 'x', description: 'x', keywords: [], delivery: 'DIRECT', needs: 'video' }] });
    expect(errs.join(' ')).toMatch(/needs must be one of/);
  });
});

describe('where the router refuses', () => {
  const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const at = (needle: string): number => {
    const i = router.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it('refuses after the DIRECT branch and before the turn is claimed', () => {
    const refusal = at('if (willRefuse) {');
    expect(refusal).toBeGreaterThan(at('const quickResponse = quickReply('));
    expect(refusal).toBeLessThan(at('await claimTurn('));
  });

  it('decides the refusal before drift, and a refused request is never offered as drift', () => {
    // 2026-10-16: an image request a basic room cannot serve was a new subject, so drift answered with
    // an offer to split the conversation and the person never learned the thing is not offered here.
    expect(at('const willRefuse =')).toBeLessThan(at('const driftResponse ='));
    const gate = router.slice(at('const driftResponse ='), at('await runLiveDriftFlow({'));
    expect(gate).toContain('willRefuse');
  });

  it('computes the refused set from the assistant\'s own pack, and gives it to the model only', () => {
    expect(router).toContain('refusedPlatformIntents(profileIntentPack ?? getIntentPack())');
    // The model call's options, however they are laid out: the served pack and the refused set together.
    expect(router).toMatch(/classifyIntent\(userMessage, \{[^}]*pack: packForClassification,\s*refused: refusedIntents/);
    expect(router).not.toMatch(/classifyIntentByKeyword\([^)]*refused/);
  });

  it('still resolves an absent pack to the deployment pack', () => {
    expect(getIntentPack().intents.length).toBeGreaterThan(0);
  });
});
