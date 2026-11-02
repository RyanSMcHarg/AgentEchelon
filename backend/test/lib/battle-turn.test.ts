/**
 * The battle entry's identity guard, and the side resolution that moved onto the turn path.
 *
 * WHY THE IDENTITY GUARD MATTERS MOST HERE. Under the per-side handoff the CALLER tells the handler
 * which bot to answer as, because a duel has two sides and the handler otherwise resolves exactly one
 * from its own per-classification SSM parameter. A caller-supplied identity that is never checked is
 * an impersonation seam: anything able to invoke the handler could post as any bot in the app
 * instance. This is the only new authority the handoff introduces, so it is the part worth pinning
 * hardest.
 */
jest.mock('../../lambda/src/lib/experiment-manager.js', () => ({
  resolveBattleSides: jest.fn(),
}), { virtual: true });

/** The conversation's battle config, which binds the experiment a duel reads by id. */
const mockLoadChannelBattleConfig = jest.fn(async (_channelArn: string): Promise<unknown> => null);
jest.mock('../../lambda/src/lib/battle-state.js', () => ({
  loadChannelBattleConfig: (channelArn: string) => mockLoadChannelBattleConfig(channelArn),
}), { virtual: true });

/**
 * THE ASSIGNMENT RECORDS, mocked as the two answers the guard asks of them: the live occupants of this
 * classification's roles, and the alt of one (classification, role). The real reader pages the records
 * once per classification; what matters here is which ARNs come back and that a failure refuses rather
 * than admits.
 */
const mockLiveBotArns = jest.fn();
const mockAltBotArnFor = jest.fn();
jest.mock('../../lambda/src/lib/default-agents.js', () => ({
  liveBotArnsForClassification: (...a: unknown[]) => mockLiveBotArns(...a),
  altBotArnFor: (...a: unknown[]) => mockAltBotArnFor(...a),
}), { virtual: true });

import {
  isSanctionedBattleBot,
  resolveBattleSide,
  resolveDuelSides,
  battlePlaceholderContent,
  type DuelSides,
} from '../../lambda/src/lib/battle-turn';
import { resolveBattleSides } from '../../lambda/src/lib/experiment-manager';

/** The duel's experiment, as one read answers it: active, with the two sides given. */
function answerSides(control: unknown, treatment: unknown, active = true): void {
  (resolveBattleSides as jest.Mock).mockResolvedValue({ active, control, treatment });
}

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const OWN_BOT = `${APP}/bot/advisor-bot`;
/** This classification's primary-role alt, from its own record. */
const ALT_OWN = `${APP}/bot/alt-own`;
/** Another classification's alt. */
const OTHER_ALT = `${APP}/bot/alt-concierge`;
const STRANGER = `${APP}/bot/not-an-assistant`;
/** The classification a duel below runs in, and its challenger's bot (the `alt-primary-premium` record's). */
const DUEL_CLASSIFICATION = 'premium';
const CHALLENGER = `${APP}/bot/alt-premium`;

/** The classification and role every assertion below serves, unless it says otherwise. */
const OWN_CLASSIFICATION = 'advisor';
const OWN_ROLE = 'primary';
/** The alt of a DIFFERENT role in the same classification. */
const ALT_OTHER_ROLE = `${APP}/bot/alt-meetings`;
/** The LIVE occupant of a second role in this classification - an `ops` assistant, not an alt. */
const OPS_LIVE = `${APP}/bot/ops-live`;

// ONE ALT PER (CLASSIFICATION, ROLE), the key of its record.
const ALTS: Record<string, string> = {
  [`${OWN_CLASSIFICATION}/${OWN_ROLE}`]: ALT_OWN,
  [`concierge/${OWN_ROLE}`]: OTHER_ALT,
  [`${OWN_CLASSIFICATION}/meetings`]: ALT_OTHER_ROLE,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAltBotArnFor.mockImplementation(async (c: string, r: string) => ALTS[`${c}/${r}`]);
  // The common case: one assistant, so the only live bot in the classification is the handler's own.
  mockLiveBotArns.mockResolvedValue([OWN_BOT]);
});

describe('which identity a turn addressed to a SECOND ROLE may answer as', () => {
  // THE DEFECT THESE PIN, measured live 2026-09-30. In a premium conversation holding both `advisor`
  // and `ops-premium`, a mention of the ops assistant resolved, the flow claimed the turn and declared the ops identity,
  // and this gate refused it: an ops bot is neither the primary handler's own bot nor an alt of the
  // primary role. The turn fell back to the primary, so Advisor answered a question only Ops can answer
  // and the only trace was one SecurityEvent line. Nothing asserted this, which is why it shipped.

  it('allows the LIVE occupant of another role in the same classification', async () => {
    mockLiveBotArns.mockResolvedValue([OWN_BOT, OPS_LIVE]);
    expect(await isSanctionedBattleBot(OPS_LIVE, OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE)).toBe(true);
  });

  it('asks for the live occupants of THIS classification and no other', async () => {
    mockLiveBotArns.mockResolvedValue([OWN_BOT, OPS_LIVE]);
    await isSanctionedBattleBot(OPS_LIVE, OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE);
    expect(mockLiveBotArns).toHaveBeenCalledWith(OWN_CLASSIFICATION);
  });

  it('refuses a live bot that belongs to a DIFFERENT classification', async () => {
    // The records are read per classification, so a bot absent from this classification's set is
    // refused - which is ADR-042 holding: an assistant acts in exactly one classification.
    mockLiveBotArns.mockResolvedValue([OWN_BOT]);
    expect(await isSanctionedBattleBot(OPS_LIVE, OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE)).toBe(false);
  });

  it('FAILS CLOSED when the assignment records cannot be read', async () => {
    // A records outage must not widen who may post. The own bot still answers, so the deployment
    // degrades to one assistant rather than to none.
    mockLiveBotArns.mockRejectedValue(new Error('ssm down'));
    mockAltBotArnFor.mockRejectedValue(new Error('ssm down'));
    expect(await isSanctionedBattleBot(OPS_LIVE, OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE)).toBe(false);
    expect(await isSanctionedBattleBot(ALT_OWN, OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE)).toBe(false);
    expect(await isSanctionedBattleBot(OWN_BOT, OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE)).toBe(true);
  });

  it('still refuses a stranger that holds no role at all', async () => {
    mockLiveBotArns.mockResolvedValue([OWN_BOT, OPS_LIVE]);
    expect(await isSanctionedBattleBot(STRANGER, OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE)).toBe(false);
  });
});

describe('which identity a battle turn may answer as', () => {
  it('allows the classification’s OWN bot', async () => {
    expect(await isSanctionedBattleBot(OWN_BOT, OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE)).toBe(true);
  });

  it('allows the alt its record assigns to THIS (classification, role)', async () => {
    expect(await isSanctionedBattleBot(ALT_OWN, OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE)).toBe(true);
    expect(mockAltBotArnFor).toHaveBeenCalledWith(OWN_CLASSIFICATION, OWN_ROLE);
  });

  it('REJECTS an alt of the SAME classification occupying a DIFFERENT role', async () => {
    // THE CASE CLASSIFICATION ALONE CANNOT SEE, and the reason the guard scopes on the pair. Once a
    // classification declares a second role, two alts share its classification and only ONE of them
    // is the alternate occupant of this role.
    expect(await isSanctionedBattleBot(ALT_OTHER_ROLE, OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE)).toBe(false);
    // Symmetric, so this cannot pass by the role filter being stuck on one value.
    expect(await isSanctionedBattleBot(ALT_OTHER_ROLE, OWN_BOT, OWN_CLASSIFICATION, 'meetings')).toBe(true);
    expect(await isSanctionedBattleBot(ALT_OWN, OWN_BOT, OWN_CLASSIFICATION, 'meetings')).toBe(false);
  });

  it('rejects every alt when the turn names no role', async () => {
    // A handler that cannot say which role it serves admits no alt.
    expect(await isSanctionedBattleBot(ALT_OWN, OWN_BOT, OWN_CLASSIFICATION, '')).toBe(false);
    expect(await isSanctionedBattleBot(OWN_BOT, OWN_BOT, OWN_CLASSIFICATION, '')).toBe(true);
  });

  it('REJECTS an alt belonging to ANOTHER classification', async () => {
    // An assistant acts in exactly one classification (ADR-042), and an alt is an assistant: the
    // concierge room's alt may not answer an advisor turn.
    expect(await isSanctionedBattleBot(OTHER_ALT, OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE)).toBe(false);
    // ...and the symmetric direction, so this cannot pass by the filter being stuck on one value.
    expect(await isSanctionedBattleBot(OTHER_ALT, OWN_BOT, 'concierge', OWN_ROLE)).toBe(true);
    expect(await isSanctionedBattleBot(ALT_OWN, OWN_BOT, 'concierge', OWN_ROLE)).toBe(false);
  });

  it('REJECTS a bot that no record names', async () => {
    // The impersonation case. A caller that can invoke the handler must not be able to name any bot
    // in the app instance and have the turn post as it.
    expect(await isSanctionedBattleBot(STRANGER, OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE)).toBe(false);
  });

  it('rejects an empty identity rather than defaulting', async () => {
    expect(await isSanctionedBattleBot('', OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE)).toBe(false);
  });

  it('rejects every alt when the turn names no classification', async () => {
    // An unset CLASSIFICATION env is a handler that cannot say which room it serves. That must admit
    // no alt at all. The own-bot path is unaffected: it compares ARNs.
    mockAltBotArnFor.mockResolvedValue(undefined);
    mockLiveBotArns.mockResolvedValue([]);
    expect(await isSanctionedBattleBot(ALT_OWN, OWN_BOT, '', OWN_ROLE)).toBe(false);
    expect(await isSanctionedBattleBot(OWN_BOT, OWN_BOT, '', OWN_ROLE)).toBe(true);
  });

  it('admits no alt for a classification that provisions none', async () => {
    // Battle not wired there: no `.../alt` record, so no bot can claim to be that classification's alt.
    mockAltBotArnFor.mockResolvedValue(undefined);
    expect(await isSanctionedBattleBot(ALT_OWN, OWN_BOT, OWN_CLASSIFICATION, OWN_ROLE)).toBe(false);
  });
});
describe('resolving which side of the duel this turn is', () => {
  // Each side is a PINNED VERSION (§3.7): the control's under the live assistant, the treatment's under the alt.
  const controlVersion = { profileName: 'advisor', configId: 'c-ctl', modelKey: 'sonnet', displayName: 'Control' };
  const treatmentVersion = { profileName: 'alt-primary-advisor', configId: 'c-trt', modelKey: 'opus', displayName: 'Treatment' };
  const control = { experimentId: 'e1', variantId: 'control', modelKey: 'sonnet', displayName: 'Control', variantProfile: controlVersion };
  const treatment = { experimentId: 'e1', variantId: 'treatment', modelKey: 'opus', displayName: 'Treatment', variantProfile: treatmentVersion };

  beforeEach(() => {
    answerSides(control, treatment);
    // The challenger is the duel classification's alt, whose bot its own assignment record names.
    mockAltBotArnFor.mockImplementation(async (c: string, r: string) =>
      (c === DUEL_CLASSIFICATION && r === 'primary' ? CHALLENGER : undefined));
  });

  it('names the challenger by assistant id, and finds its side by the bot its record names', async () => {
    await resolveDuelSides({ classification: DUEL_CLASSIFICATION, selfBotArn: OWN_BOT });
    // ONE READ of the experiment for both sides and whether it is active.
    expect(resolveBattleSides).toHaveBeenCalledTimes(1);
    expect(resolveBattleSides).toHaveBeenCalledWith('alt-primary-premium', {});
    expect(mockAltBotArnFor).toHaveBeenCalledWith(DUEL_CLASSIFICATION, 'primary');
  });

  it('reads the experiment by the id the battle config of the conversation bound, once', async () => {
    mockLoadChannelBattleConfig.mockResolvedValueOnce({ channelArn: 'arn:ch', enabled: true, experimentId: 'e1' });
    await resolveDuelSides({ classification: DUEL_CLASSIFICATION, selfBotArn: OWN_BOT, channelArn: 'arn:ch' });
    expect(mockLoadChannelBattleConfig).toHaveBeenCalledWith('arn:ch');
    expect(resolveBattleSides).toHaveBeenCalledTimes(1);
    expect(resolveBattleSides).toHaveBeenCalledWith('alt-primary-premium', { experimentId: 'e1' });
  });

  it('ends the duel when its experiment is no longer active, and never on a read failure', async () => {
    answerSides(null, null, false);
    expect(await resolveDuelSides({ classification: DUEL_CLASSIFICATION, selfBotArn: OWN_BOT })).toEqual({ self: null, rival: null, ended: true });
    (resolveBattleSides as jest.Mock).mockRejectedValueOnce(new Error('throttled'));
    expect(await resolveDuelSides({ classification: DUEL_CLASSIFICATION, selfBotArn: OWN_BOT })).toEqual({ self: null, rival: null });
  });

  it('gives the ALT bot the treatment side and the live bot the control, each naming the other as rival', async () => {
    // Getting this backwards silently swaps the duel's arms, so every result is inverted while the
    // duel still looks perfectly healthy.
    const alt = await resolveBattleSide({ classification: DUEL_CLASSIFICATION, selfBotArn: CHALLENGER, intent: 'general' });
    const dflt = await resolveBattleSide({ classification: DUEL_CLASSIFICATION, selfBotArn: OWN_BOT, intent: 'general' });

    expect(alt.selfVariant).toEqual(treatment);
    expect(alt.rivalName).toBe('Control');
    expect(dflt.selfVariant).toEqual(control);
    expect(dflt.rivalName).toBe('Treatment');
  });

  it('reads both sides once when the caller already resolved them', async () => {
    const sides = await resolveDuelSides({ classification: DUEL_CLASSIFICATION, selfBotArn: CHALLENGER });
    jest.clearAllMocks();
    const side = await resolveBattleSide({ classification: DUEL_CLASSIFICATION, selfBotArn: CHALLENGER, intent: 'general', sides: sides as DuelSides });
    expect(side.selfVariant).toEqual(treatment);
    expect(resolveBattleSides).not.toHaveBeenCalled();
  });

  it('never chooses DIRECT: a duel always produces a generated reply', async () => {
    // A greeting in a duel is still answered by the model - two canned strings are not a comparison.
    const side = await resolveBattleSide({ classification: DUEL_CLASSIFICATION, selfBotArn: CHALLENGER, intent: 'greeting' });
    expect(side.deliveryOption).toBe('PLACEHOLDER_UPDATE');
  });

  it('carries a multi-step intent through as a task type', async () => {
    const side = await resolveBattleSide({ classification: DUEL_CLASSIFICATION, selfBotArn: CHALLENGER, intent: 'data_extraction' });
    expect(side.deliveryOption).toBe('TASK_MULTI_STEP');
    expect(side.taskType).toBe('data_extraction');
  });

  it('will not open a workflow the side\'s pinned version deselected, and plans a REPLY instead (ADR-047)', async () => {
    // `/battle` WAS A WALK-AROUND FOR THE SELECTION. A duel side is the second door into task
    // creation, so it is gated by the version that serves it like the first door is.
    answerSides(control, { ...treatment, variantProfile: { ...treatmentVersion, workflows: ['report_generation'] } });
    const side = await resolveBattleSide({
      classification: DUEL_CLASSIFICATION,
      selfBotArn: CHALLENGER,
      intent: 'data_extraction',
      workflowSelection: ['data_extraction'],
    });
    expect(side.deliveryOption).toBe('PLACEHOLDER_UPDATE');
    expect(side.taskType).toBeUndefined();
    // Still a duel: the side keeps its version, so the comparison the person asked for still happens.
    expect(side.selfVariant?.variantProfile.workflows).toEqual(['report_generation']);
  });

  it('gates each side by its OWN version, not by the selection the turn resolved', async () => {
    // The pinned version is what serves, so its selection is the gate whatever the live assistant's
    // active version selects. The treatment deselects `data_extraction`; the control's version selects
    // nothing (every workflow), so the control opens it even though the turn resolved a narrower one.
    answerSides(control, { ...treatment, variantProfile: { ...treatmentVersion, workflows: ['report_generation'] } });
    const alt = await resolveBattleSide({
      classification: DUEL_CLASSIFICATION, selfBotArn: CHALLENGER, intent: 'data_extraction', workflowSelection: ['data_extraction'],
    });
    expect(alt.taskType).toBeUndefined();
    const dflt = await resolveBattleSide({
      classification: DUEL_CLASSIFICATION, selfBotArn: OWN_BOT, intent: 'data_extraction', workflowSelection: ['report_generation'],
    });
    expect(dflt.deliveryOption).toBe('TASK_MULTI_STEP');
    expect(dflt.taskType).toBe('data_extraction');
  });

  it('falls back to the turn\'s selection only for a side with no pinned version', async () => {
    answerSides(control, null);
    const side = await resolveBattleSide({
      classification: DUEL_CLASSIFICATION, selfBotArn: CHALLENGER, intent: 'data_extraction', workflowSelection: ['report_generation'],
    });
    expect(side.selfVariant).toBeNull();
    expect(side.taskType).toBeUndefined();
  });

  it('opens the workflow when the selection allows it, so the gate is not simply off', async () => {
    const side = await resolveBattleSide({
      classification: DUEL_CLASSIFICATION,
      selfBotArn: CHALLENGER,
      intent: 'data_extraction',
      workflowSelection: ['data_extraction'],
    });
    expect(side.deliveryOption).toBe('TASK_MULTI_STEP');
    expect(side.taskType).toBe('data_extraction');
  });

  it('degrades to serving the assistant as it is when a resolver throws', async () => {
    (resolveBattleSides as jest.Mock).mockRejectedValue(new Error('boom'));

    const side = await resolveBattleSide({ classification: DUEL_CLASSIFICATION, selfBotArn: CHALLENGER, intent: 'general' });
    expect(side.selfVariant).toBeNull();
    expect(side.deliveryOption).toBe('PLACEHOLDER_UPDATE');
  });

  it('resolves nothing when the classification provisions no alt, instead of guessing a side', async () => {
    mockAltBotArnFor.mockResolvedValue(undefined);
    const side = await resolveBattleSide({ classification: DUEL_CLASSIFICATION, selfBotArn: OWN_BOT, intent: 'general' });
    expect(side.selfVariant).toBeNull();
    expect(resolveBattleSides).not.toHaveBeenCalled();
  });

  it('resolves nothing when the challenger\'s record cannot be read', async () => {
    mockAltBotArnFor.mockRejectedValue(new Error('throttled'));
    const side = await resolveBattleSide({ classification: DUEL_CLASSIFICATION, selfBotArn: CHALLENGER, intent: 'general' });
    expect(side.selfVariant).toBeNull();
    expect(resolveBattleSides).not.toHaveBeenCalled();
  });

  it('resolves an image turn quietly: a side with no image model is refused at arming, so the turn never warns', async () => {
    // Arming answers 409 BATTLE_SIDE_HAS_NO_IMAGE_MODEL (`battleImageRefusal`, covered in
    // a-battle-runs-the-whole-task-and-sums-its-steps.test.ts), so no duel reaches a turn that would have to say so.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // A pack intent that declares it needs an image, on a side whose version answers it in text.
      const side = await resolveBattleSide({ classification: DUEL_CLASSIFICATION, selfBotArn: CHALLENGER, intent: 'logo', need: 'image' });
      expect(side.selfVariant?.variantProfile).toBe(treatmentVersion);
      // A text intent resolves the same way.
      await resolveBattleSide({ classification: DUEL_CLASSIFICATION, selfBotArn: CHALLENGER, intent: 'general' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('carries no variant field beside the version: everything the side serves is on its pinned version', async () => {
    const side = await resolveBattleSide({ classification: DUEL_CLASSIFICATION, selfBotArn: CHALLENGER, intent: 'image_generation' });
    for (const field of ['imageGenModelId', 'rivalVariant', 'variantModelKey', 'variantAddendum', 'variantImageModelKey']) {
      expect(side).not.toHaveProperty(field);
    }
    expect(side.selfVariant?.variantProfile).toBe(treatmentVersion);
  });
});

describe('the placeholder a battle side posts', () => {
  it('carries the correlation marker AND the battle marker', async () => {
    const content = battlePlaceholderContent({
      correlationId: 'battle-r1-abc',
      battleId: 'b1',
      round: 1,
      totalRounds: 2,
      rivalBotArn: OTHER_ALT,
      displayName: 'Control',
    });

    expect(content).toContain('<!--corr:battle-r1-abc-->');
    expect(content).toContain('battleId=b1,round=1,total=2');
    expect(content).toContain(`rivalArn=${OTHER_ALT}`);
  });

  it('percent-encodes the display name, so a name with a comma cannot break the marker', async () => {
    // The marker is comma-delimited, so an un-encoded name splits it into fields that parse as
    // something else - the frontend then renders a working state for a bot that does not exist.
    const content = battlePlaceholderContent({
      correlationId: 'c', battleId: 'b1', round: 1, totalRounds: 2,
      rivalBotArn: OTHER_ALT, displayName: 'Fast, Cheap',
    });

    expect(content).toContain('name=Fast%2C%20Cheap');
  });

  it('omits name= entirely when no variant resolved, rather than emitting an empty one', async () => {
    const content = battlePlaceholderContent({
      correlationId: 'c', battleId: 'b1', round: 1, totalRounds: 2, rivalBotArn: OTHER_ALT,
    });

    expect(content).not.toContain('name=');
  });

  it('references the rival reply on a round-2 placeholder', async () => {
    const content = battlePlaceholderContent({
      correlationId: 'c', battleId: 'b1', round: 2, totalRounds: 2,
      rivalBotArn: OTHER_ALT, rivalReplyMsgId: 'msg-9',
    });

    expect(content).toContain('round=2');
    expect(content).toContain('rivalReplyMsgId=msg-9');
  });
});
