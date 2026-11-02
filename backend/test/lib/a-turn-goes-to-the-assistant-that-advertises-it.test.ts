/**
 * WHERE A TURN GOES, DECIDED BY THE ONE CLASSIFICATION THE TURN ALREADY MAKES.
 *
 * The roommates' advertised lines join this assistant's own intents as categories in the SAME
 * classification that was going to happen anyway, so "whose question is this" costs no extra model call.
 * This file tests the two halves of that: what the merged pack contains, and what a classified key means.
 *
 * ── TWO MEASURED WRONG TURNS THIS REPLACES ──────────────────────────────────────────────────────
 *
 * First, gating on the classifier returning `general`. That assumed a classifier knows what it does not
 * know. Asked "what is the deployment error rate right now", the premium primary classified
 * `financial_metric` with HIGH confidence - its own pack advertises "ask for a figure like ARR or churn"
 * and an error rate is a figure - so no fall-through happened and the gate never fired. A classifier
 * places a message in the nearest category it was SHOWN, and nearest-among-mine is not mine.
 *
 * Second, asking a second time over the roommates' categories alone. That fixed the miss and cost a
 * second model call (measured 757 ms then 795 ms on one turn), and it could place a question the primary
 * genuinely serves into the nearest specialist category, because the primary's own lines were not on the
 * ballot. Merging both sides into one pass fixes both at once.
 */
import {
  decideDelegation,
  withRoommateCategories,
  delegationKey,
  parseDelegationKey,
  intentKeptHere,
} from '../../lambda/src/lib/delegation';
import type { Roommate } from '../../lambda/src/lib/assistant-advertisement';
import type { IntentPack } from '../../lambda/src/lib/intent-pack';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';

const roommate = (assistant: string, intents: Array<[string, string]>): Roommate => ({
  assistant,
  botArn: `${APP}/bot/${assistant}`,
  role: assistant === 'advisor' ? 'primary' : 'ops',
  advertisement: {
    assistant,
    displayName: assistant === 'ops-premium' ? 'Ops' : assistant,
    intents: intents.map(([key, summary]) => ({ key, summary })),
  },
});

const OPS = roommate('ops-premium', [
  ['deployment_health', 'ask for the error rate and I will read it from live metrics'],
  ['log_search', 'ask me to search the logs'],
]);

/** The answering assistant's own pack, with the real descriptions its classifier is tuned on. */
const OWN_PACK = {
  intents: [
    { key: 'financial_metric', description: 'A single business figure such as ARR or churn' },
    { key: 'report_generation', description: 'Compile a multi-section document' },
  ],
} as IntentPack;

describe('the pack the turn classifies against', () => {
  it('keeps this assistant\'s own keys AND its own descriptions', () => {
    // The real `description` is written to separate one intent from its neighbors for exactly this
    // classifier, so it is a better discriminator than the person-facing summary - and keeping the key
    // means a turn this assistant keeps flows on with its own delivery option and model route.
    const pack = withRoommateCategories(OWN_PACK, [OPS]);
    expect(pack.intents).toEqual(expect.arrayContaining([
      { key: 'financial_metric', description: 'A single business figure such as ARR or churn' },
      { key: 'report_generation', description: 'Compile a multi-section document' },
    ]));
  });

  it('adds the roommates\' advertised lines as prefixed categories', () => {
    const pack = withRoommateCategories(OWN_PACK, [OPS]);
    expect(pack.intents).toEqual(expect.arrayContaining([
      {
        key: delegationKey('ops-premium', 'deployment_health'),
        description: 'ask for the error rate and I will read it from live metrics',
      },
    ]));
  });

  it('publishes the roommate\'s SUMMARY as its description, never its own classifier text', () => {
    // A specialist's `description` is written for its own pack and is nobody else's business; the summary
    // is all a peer publishes.
    const pack = withRoommateCategories(OWN_PACK, [OPS]);
    const theirs = pack.intents.filter((i) => i.key.startsWith('delegate__'));
    expect(theirs.map((i) => i.description)).toEqual([
      'ask for the error rate and I will read it from live metrics',
      'ask me to search the logs',
    ]);
  });

  it('is the assistant\'s own pack unchanged when there are no roommates', () => {
    expect(withRoommateCategories(OWN_PACK, []).intents).toEqual(OWN_PACK.intents);
  });

  it('survives an assistant that carries no pack of its own', () => {
    const pack = withRoommateCategories(undefined, [OPS]);
    expect(pack.intents).toHaveLength(2);
    expect(pack.intents.every((i) => i.key.startsWith('delegate__'))).toBe(true);
  });

  it('round-trips a key containing underscores, and rejects one it did not mint', () => {
    expect(parseDelegationKey(delegationKey('ops-premium', 'platform_health_v2')))
      .toEqual({ assistant: 'ops-premium', intentKey: 'platform_health_v2' });
    expect(parseDelegationKey('deployment_health')).toBeNull();
    expect(parseDelegationKey('delegate__')).toBeNull();
    expect(parseDelegationKey('delegate__onlyassistant')).toBeNull();
  });
});

describe('what a classified key means', () => {
  it('hands over when the key names a roommate', () => {
    const d = decideDelegation({
      classifiedIntent: delegationKey('ops-premium', 'deployment_health'),
      roommates: [OPS],
    });
    expect(d.kind).toBe('handover');
    if (d.kind === 'handover') {
      expect(d.roommate.assistant).toBe('ops-premium');
      expect(d.key).toBe('deployment_health');
    }
  });

  it('keeps the turn when the key is one of this assistant\'s own', () => {
    // No special case needed and that is the saving: the turn continues with the intent it was classified
    // as, carrying that intent's delivery option and model route.
    const d = decideDelegation({ classifiedIntent: 'financial_metric', roommates: [OPS] });
    expect(d).toEqual({ kind: 'keep', reason: 'mine' });
  });

  it('keeps the turn when the classifier declined to place it', () => {
    for (const intent of ['general', 'GENERAL', 'greeting', 'acknowledgment', '']) {
      expect(decideDelegation({ classifiedIntent: intent, roommates: [OPS] }).kind).toBe('keep');
    }
  });

  it('ASKS when two roommates advertise the same key', () => {
    // Two roommates advertising one key produce two categories with the SAME description, so which the
    // model picks is a coin flip - and a coin flip must not be mistaken for a decision.
    const other = roommate('other', [['deployment_health', 'also this']]);
    const d = decideDelegation({
      classifiedIntent: delegationKey('ops-premium', 'deployment_health'),
      roommates: [OPS, other],
    });
    expect(d.kind).toBe('ask');
    if (d.kind === 'ask') expect(d.roommates.map((r) => r.assistant).sort()).toEqual(['ops-premium', 'other']);
  });

  it('keeps the turn when the key names an assistant that does not advertise it', () => {
    // The prefix carries the model's choice; the ownership lookup is the authority.
    const d = decideDelegation({
      classifiedIntent: delegationKey('someone-else', 'deployment_health'),
      roommates: [OPS],
    });
    expect(d).toEqual({ kind: 'keep', reason: 'not-placed' });
  });

  it('keeps the turn when nobody advertises the key at all', () => {
    const d = decideDelegation({
      classifiedIntent: delegationKey('ops-premium', 'something_else'),
      roommates: [OPS],
    });
    expect(d).toEqual({ kind: 'keep', reason: 'no-roommate-advertises-it' });
  });

  it('keeps the turn when the room holds no roommate', () => {
    expect(decideDelegation({ classifiedIntent: 'anything', roommates: [] }))
      .toEqual({ kind: 'keep', reason: 'no-roommates' });
  });

  it('makes no model call of its own, being synchronous', () => {
    // The guard against the two-pass shape coming back: a decision that cannot await cannot classify.
    const d = decideDelegation({ classifiedIntent: 'financial_metric', roommates: [OPS] });
    expect((d as unknown as Promise<unknown>).then).toBeUndefined();
  });
});

/**
 * A ROOMMATE'S KEY NEVER SURVIVES AS A TURN'S INTENT (2026-10-16).
 *
 * Measured live: a resumed duel side was offered roommate categories, classified as
 * `delegate__advisor__report_generation`, could not hand over (a Lex turn carries no message id), and ran
 * on with the synthetic key as its delivery option, model route and archived intent.
 */
describe('the intent a turn keeps when it was not handed over', () => {
  const pack = { intents: [{ key: 'report_generation' }, { key: 'financial_metric' }] } as Parameters<typeof intentKeptHere>[1];

  it('reads the key back as the intent it named, when this assistant declares it too', () => {
    expect(intentKeptHere('delegate__advisor__report_generation', pack)).toBe('report_generation');
  });

  it('falls through to general when this assistant has no such intent', () => {
    expect(intentKeptHere('delegate__ops-premium__deployment_health', pack)).toBe('general');
  });

  it('leaves an ordinary intent alone', () => {
    expect(intentKeptHere('financial_metric', pack)).toBe('financial_metric');
  });

  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const router: string = fs.readFileSync(path.resolve(__dirname, '../..', 'lambda/src/router-agent-handler.ts'), 'utf8');

  it('the router applies it to every turn that stays here', () => {
    const at = router.indexOf('const delegated = await actOnDelegation({');
    const after = router.slice(at, at + 1600);
    expect(after).toContain('const keptIntent = intentKeptHere(classification.intent, profileIntentPack ?? getIntentPack());');
  });

  it('a duel side, resumed or declared, is never delegated', () => {
    const at = router.indexOf('const delegated = await actOnDelegation({');
    expect(router.slice(at, at + 800)).toContain('roommates: battleCtx ? [] : roommates,');
  });
});

describe('a roommate key is read back before the decisions that read the intent', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const router: string = fs.readFileSync(path.resolve(__dirname, '../..', 'lambda/src/router-agent-handler.ts'), 'utf8');

  it('on a turn that cannot hand over, before drift, refusal and the image check', () => {
    const early = router.indexOf('if ((battleCtx || roommates.length === 0) && parseDelegationKey(classification.intent)) {');
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(router.indexOf('const servedIntentDef = profileIntentPack?.intents.find'));
  });

  it('with the deployment pack when the profile could not be resolved, never to no taxonomy', () => {
    expect(router).not.toContain('intentKeptHere(classification.intent, profileIntentPack)');
    // The two places a kept turn reads a roommate key back, and the other-work rule that compares the same mapping.
    expect(router.match(/intentKeptHere\(classification\.intent, profileIntentPack \?\? getIntentPack\(\)\)/g)?.length).toBe(3);
  });
});
