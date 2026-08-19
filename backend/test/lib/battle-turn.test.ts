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
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetParam', input: args })),
}), { virtual: true });

jest.mock('../../lambda/src/lib/experiment-manager.js', () => ({
  resolveBattleVariantBySlotArn: jest.fn(),
  resolveBattleControlVariantByAltSlotArn: jest.fn(),
  resolveBattleImageGenPair: jest.fn(),
}), { virtual: true });

import { SSMClient } from '@aws-sdk/client-ssm';
import {
  isSanctionedBattleBot,
  altSlotBotArns,
  resolveBattleSide,
  battlePlaceholderContent,
  __resetRosterCacheForTests,
} from '../../lambda/src/lib/battle-turn';
import {
  resolveBattleVariantBySlotArn,
  resolveBattleControlVariantByAltSlotArn,
  resolveBattleImageGenPair,
} from '../../lambda/src/lib/experiment-manager';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const OWN_BOT = `${APP}/bot/premium-bot`;
const SLOT_0 = `${APP}/bot/slot-zero`;
const SLOT_1 = `${APP}/bot/slot-one`;
const STRANGER = `${APP}/bot/not-a-slot`;

const ssm = new SSMClient({});

const rosterValue = JSON.stringify([
  { slotId: 'slot-0', botArn: SLOT_0 },
  { slotId: 'slot-1', botArn: SLOT_1 },
]);

beforeEach(() => {
  jest.clearAllMocks();
  __resetRosterCacheForTests();
  mockSsmSend.mockResolvedValue({ Parameter: { Value: rosterValue } });
});

describe('which identity a battle turn may answer as', () => {
  it('allows the classification’s OWN bot', async () => {
    expect(await isSanctionedBattleBot(OWN_BOT, OWN_BOT, ssm)).toBe(true);
  });

  it('allows a bot in the published alt-slot roster', async () => {
    expect(await isSanctionedBattleBot(SLOT_1, OWN_BOT, ssm)).toBe(true);
  });

  it('REJECTS a bot that is neither', async () => {
    // The impersonation case. A caller that can invoke the handler must not be able to name any bot
    // in the app instance and have the turn post as it.
    expect(await isSanctionedBattleBot(STRANGER, OWN_BOT, ssm)).toBe(false);
  });

  it('rejects an empty identity rather than defaulting', async () => {
    expect(await isSanctionedBattleBot('', OWN_BOT, ssm)).toBe(false);
  });

  it('FAILS CLOSED when the roster cannot be read', async () => {
    // An unreadable roster must reject every caller-supplied identity, not wave them through. A duel
    // that cannot validate its slot is a duel that does not run, which is recoverable; an
    // unvalidated identity is not. The classification's own bot still works, so an ordinary turn is
    // unaffected by a roster outage.
    mockSsmSend.mockRejectedValue(new Error('ssm down'));

    expect(await isSanctionedBattleBot(SLOT_1, OWN_BOT, ssm)).toBe(false);
    expect(await isSanctionedBattleBot(OWN_BOT, OWN_BOT, ssm)).toBe(true);
  });

  it('reads the roster once per container, not once per turn', async () => {
    await altSlotBotArns(ssm);
    await altSlotBotArns(ssm);
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
  });
});

describe('resolving which side of the duel this turn is', () => {
  const control = { experimentId: 'e1', variantId: 'control', modelKey: 'sonnet', displayName: 'Control' };
  const treatment = { experimentId: 'e1', variantId: 'treatment', modelKey: 'opus', displayName: 'Treatment' };

  beforeEach(() => {
    (resolveBattleControlVariantByAltSlotArn as jest.Mock).mockResolvedValue(control);
    (resolveBattleVariantBySlotArn as jest.Mock).mockResolvedValue(treatment);
    (resolveBattleImageGenPair as jest.Mock).mockResolvedValue(null);
  });

  it('gives the ALT-SLOT bot the treatment variant and the default bot the control', async () => {
    // Getting this backwards silently swaps the duel's arms, so every result is inverted while the
    // duel still looks perfectly healthy.
    const alt = await resolveBattleSide({ altSlotArn: SLOT_1, selfBotArn: SLOT_1, intent: 'general' });
    const dflt = await resolveBattleSide({ altSlotArn: SLOT_1, selfBotArn: OWN_BOT, intent: 'general' });

    expect(alt.selfVariant).toEqual(treatment);
    expect(alt.rivalVariant).toEqual(control);
    expect(dflt.selfVariant).toEqual(control);
    expect(dflt.rivalVariant).toEqual(treatment);
  });

  it('never chooses DIRECT: a duel always produces a generated reply', async () => {
    // A greeting in a duel is still answered by the model - two canned strings are not a comparison.
    const side = await resolveBattleSide({ altSlotArn: SLOT_1, selfBotArn: SLOT_1, intent: 'greeting' });
    expect(side.deliveryOption).toBe('PLACEHOLDER_UPDATE');
  });

  it('carries a multi-step intent through as a task type', async () => {
    const side = await resolveBattleSide({ altSlotArn: SLOT_1, selfBotArn: SLOT_1, intent: 'data_extraction' });
    expect(side.deliveryOption).toBe('TASK_MULTI_STEP');
    expect(side.taskType).toBe('data_extraction');
  });

  it('degrades to the worker resolving normally when a resolver throws', async () => {
    // A resolver hiccup must never block the duel; the fields stay unset and the worker resolves.
    (resolveBattleVariantBySlotArn as jest.Mock).mockRejectedValue(new Error('boom'));

    const side = await resolveBattleSide({ altSlotArn: SLOT_1, selfBotArn: SLOT_1, intent: 'general' });
    expect(side.selfVariant).toBeNull();
    expect(side.deliveryOption).toBe('PLACEHOLDER_UPDATE');
  });

  it('resolves nothing when no slot is bound, instead of guessing a side', async () => {
    const side = await resolveBattleSide({ altSlotArn: '', selfBotArn: OWN_BOT, intent: 'general' });
    expect(side.selfVariant).toBeNull();
    expect(resolveBattleVariantBySlotArn).not.toHaveBeenCalled();
  });

  it('gives each side its OWN image model on a generation-out duel', async () => {
    (resolveBattleImageGenPair as jest.Mock).mockResolvedValue({
      controlModelId: 'titan', treatmentModelId: 'nova',
    });

    const alt = await resolveBattleSide({ altSlotArn: SLOT_1, selfBotArn: SLOT_1, intent: 'image_generation' });
    const dflt = await resolveBattleSide({ altSlotArn: SLOT_1, selfBotArn: OWN_BOT, intent: 'image_generation' });

    expect(alt.imageGenModelId).toBe('nova');
    expect(dflt.imageGenModelId).toBe('titan');
  });
});

describe('the placeholder a battle side posts', () => {
  it('carries the correlation marker AND the battle marker', async () => {
    const content = battlePlaceholderContent({
      correlationId: 'battle-r1-abc',
      battleId: 'b1',
      round: 1,
      totalRounds: 2,
      rivalBotArn: SLOT_1,
      displayName: 'Control',
    });

    expect(content).toContain('<!--corr:battle-r1-abc-->');
    expect(content).toContain('battleId=b1,round=1,total=2');
    expect(content).toContain(`rivalArn=${SLOT_1}`);
  });

  it('percent-encodes the display name, so a name with a comma cannot break the marker', async () => {
    // The marker is comma-delimited, so an un-encoded name splits it into fields that parse as
    // something else - the frontend then renders a working state for a bot that does not exist.
    const content = battlePlaceholderContent({
      correlationId: 'c', battleId: 'b1', round: 1, totalRounds: 2,
      rivalBotArn: SLOT_1, displayName: 'Fast, Cheap',
    });

    expect(content).toContain('name=Fast%2C%20Cheap');
  });

  it('omits name= entirely when no variant resolved, rather than emitting an empty one', async () => {
    const content = battlePlaceholderContent({
      correlationId: 'c', battleId: 'b1', round: 1, totalRounds: 2, rivalBotArn: SLOT_1,
    });

    expect(content).not.toContain('name=');
  });

  it('references the rival reply on a round-2 placeholder', async () => {
    const content = battlePlaceholderContent({
      correlationId: 'c', battleId: 'b1', round: 2, totalRounds: 2,
      rivalBotArn: SLOT_1, rivalReplyMsgId: 'msg-9',
    });

    expect(content).toContain('round=2');
    expect(content).toContain('rivalReplyMsgId=msg-9');
  });
});
