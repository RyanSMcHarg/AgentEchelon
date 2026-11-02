/**
 * WHAT THE ROUTER SAYS IS ATTRIBUTED, AND IS STILL NOT AN ANSWER.
 *
 * Steps 15 to 36 moved who posts what. A notice that a service used to post with no declaration at all is
 * now said by the router as the assistant it concerns, so it arrives naming that assistant (`agentType`)
 * and its kind (`turnKind: notice` or `battle-notice`). The share recap that the share Lambda used to post
 * as a plain announcement is now a turn by the room's assistant, declaring `trigger: join_recap`. A duel's
 * challenger is an ordinary assistant on its own bot, and each side serves a pinned version, with no
 * variant fields injected into the turn.
 *
 * Each of those is a new shape for archival to read. These pin that the archive records each one for what
 * it is: a notice is attributed but never an exchange; a recap is a turn but answers no message; a duel
 * side's attribution comes from what the turn declared, never from which bot posted it, so the old alt
 * bots and the new one file under the same variant during the transition.
 */
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: jest.fn(async () => null),
  writeMessageAnalytics: jest.fn(async () => undefined),
}));

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  batchInsert: jest.fn(async () => 0),
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  transaction: jest.fn(),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));

import * as fs from 'fs';
import * as path from 'path';
import { transformToMessageRecord } from '../../lambda/src/analytics-aurora/kinesis-archival';
import { botMessageMetadata } from '../../lambda/src/lib/bot-message-attribution';
import { noticeMetadata, noticeTurnKind } from '../../lambda/src/lib/assistant-notice';
import { answersNoMessage, ANSWERS_NO_MESSAGE_KINDS, isHumanWaiting } from '../../lambda/src/lib/interaction-kinds';

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c-room';
const LIVE_BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/bot/advisor';
/** The alt as its classification stack provisions it (step 30). */
const ALT_BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/bot/alt-primary-premium';
/** A retired battle-stack alt bot (`AltSlot0`), which rows archived before step 30 name. */
const OLD_SLOT_BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/bot/AltSlot0';
const PERSON = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/u-1';

const event = (sender: string, metadata: Record<string, unknown>, opts: { type?: string; content?: string; id?: string } = {}) => ({
  EventType: opts.type ?? 'CREATE_CHANNEL_MESSAGE',
  Payload: {
    MessageId: opts.id ?? 'm-1',
    ChannelArn: CHANNEL,
    Content: opts.content ?? 'A line.',
    Sender: { Arn: sender, Name: 'Sender' },
    CreatedTimestamp: '2026-10-15T10:00:00.000Z',
    LastUpdatedTimestamp: '2026-10-15T10:00:05.000Z',
    Persistence: 'PERSISTENT',
    Metadata: JSON.stringify(metadata),
  },
});

/** The Metadata `sayNotice` sends, built by the same helpers the router uses. */
const routerNotice = (kind: Parameters<typeof noticeTurnKind>[0], vars: Record<string, string> = {}) => ({
  ...JSON.parse(botMessageMetadata({
    agentType: 'advisor',
    assistantRole: 'primary',
    classification: 'premium',
    turnKind: noticeTurnKind(kind),
  })),
  ...noticeMetadata(kind, vars),
});

describe('a notice the router says', () => {
  it('names the assistant that said it and records its kind, so no pairing takes it for an answer', async () => {
    const rec = await transformToMessageRecord(event(LIVE_BOT, routerNotice('memberJoined', { name: 'Sam' })) as never);
    expect(rec?.assistant).toBe('advisor');
    expect(rec?.conversation_classification).toBe('premium');
    expect(rec?.turn_kind).toBe('notice');
    // No profile produced it, so no version is invented for it.
    expect(rec?.profile_version).toBeNull();
    expect(rec?.experiment_id).toBeNull();
  });

  it('a duel line (did not finish, none finished) is a battle notice and is filed under no duel', async () => {
    const rec = await transformToMessageRecord(event(ALT_BOT, routerNotice('battleSideDidNotFinish', { name: 'Echo' }), {
      content: "Echo didn't finish in time.",
    }) as never);
    expect(rec?.turn_kind).toBe('battle-notice');
    expect(rec?.battle_id).toBeNull();
    expect(rec?.battle_round).toBeNull();
    expect(rec?.variant_id).toBeNull();
  });
});

describe('the share recap is a turn that answers no message', () => {
  it('is recorded as its own kind from the trigger it declares', async () => {
    const rec = await transformToMessageRecord(event(LIVE_BOT, {
      botResponse: true, agentType: 'advisor', classification: 'premium', trigger: 'join_recap', respPhase: 'final',
    }, { type: 'UPDATE_CHANNEL_MESSAGE', content: 'Here is where things stand. <!--corr:recap-1-->' }) as never);
    expect(rec?.trigger_kind).toBe('join_recap');
    expect(rec?.turn_kind).toBe('join_recap');
    // Still the assistant's turn: its compute and its model are attributed like any other.
    expect(rec?.assistant).toBe('advisor');
  });

  it('reads the trigger from the nested analytics carrier too', async () => {
    const rec = await transformToMessageRecord(event(LIVE_BOT, {
      analytics: { agentType: 'advisor', trigger: 'join_recap' },
    }) as never);
    expect(rec?.turn_kind).toBe('join_recap');
  });

  it('a kind the turn declared itself wins over the one its trigger implies', async () => {
    const rec = await transformToMessageRecord(event(LIVE_BOT, { trigger: 'join_recap', turnKind: 'notification' }) as never);
    expect(rec?.turn_kind).toBe('notification');
  });

  it("is never read off a person's message", async () => {
    const rec = await transformToMessageRecord(event(PERSON, { trigger: 'join_recap' }) as never);
    expect(rec?.turn_kind).toBeNull();
  });

  it('an ordinary trigger implies no kind, so a real answer still pairs', async () => {
    for (const trigger of ['user', 'handover', 'repair', 'recovery', 'rebuttal']) {
      const rec = await transformToMessageRecord(event(LIVE_BOT, { trigger }) as never);
      expect(rec?.turn_kind).toBeNull();
    }
  });

  it('is not a turn anyone waits on, so time to first feedback leaves it out', () => {
    expect(isHumanWaiting('join_recap')).toBe(false);
    expect(answersNoMessage('join_recap')).toBe(true);
    expect(answersNoMessage('user')).toBe(false);
    expect(answersNoMessage(null)).toBe(false);
  });

  it('both pairing paths refuse it: the in-batch walk by the kind, the sweep by the kind and the trigger', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda/src/analytics-aurora/kinesis-archival.ts'), 'utf8');
    const flat = src.replace(/\s+/g, ' ');
    // In-batch: the existing "a declared kind is not an answer" skip, over the derived kind.
    expect(flat).toContain('const declaredKind = updateRecord?.turn_kind || botRecord.turn_kind;');
    expect(flat).toContain('if (declaredKind) continue;');
    // Sweep: the trigger exclusion is generated from the one list, so a kind added there is excluded here.
    expect(flat).toContain('NOT IN (${ANSWERS_NO_MESSAGE_SQL})');
    expect(flat).toContain('const ANSWERS_NO_MESSAGE_SQL = ANSWERS_NO_MESSAGE_KINDS.map(');
    expect(ANSWERS_NO_MESSAGE_KINDS).toContain('join_recap');
  });
});

describe('a duel side is attributed from what it declared, never from which bot posted it', () => {
  /** What a duel answer's slim Metadata carries after step 30c: no variant fields, just the join keys. */
  const duelAnswer = (variantId: 'control' | 'treatment', assistant: string, version: number) => ({
    botResponse: true,
    agentType: assistant,
    assistantRole: 'primary',
    classification: 'premium',
    experimentId: 'exp-1',
    variantId,
    assignmentMode: 'battle',
    battleId: 'btl-1',
    battleRound: 1,
    profileVersion: version,
    profileConfigId: `cfg-${assistant}-${version}`,
    bedrockModel: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  });
  const marker = (round: number) => `Answer. <!--battle:battleId=btl-1,round=${round},totalRounds=2-->`;

  it('the challenger on its own bot files under the treatment, its own name and its pinned version', async () => {
    const rec = await transformToMessageRecord(event(ALT_BOT, duelAnswer('treatment', 'alt-primary-premium', 4), { content: marker(1) }) as never);
    expect(rec?.experiment_id).toBe('exp-1');
    expect(rec?.variant_id).toBe('treatment');
    expect(rec?.battle_id).toBe('btl-1');
    expect(rec?.battle_round).toBe(1);
    expect(rec?.assistant).toBe('alt-primary-premium');
    expect(rec?.profile_version).toBe(4);
    expect(rec?.profile_config_id).toBe('cfg-alt-primary-premium-4');
  });

  it('a row a retired slot bot posted reads the same, because nothing reads the sender ARN', async () => {
    const fresh = await transformToMessageRecord(event(ALT_BOT, duelAnswer('treatment', 'alt-primary-premium', 4), { content: marker(1) }) as never);
    const old = await transformToMessageRecord(event(OLD_SLOT_BOT, duelAnswer('treatment', 'alt-primary-premium', 4), { content: marker(1) }) as never);
    for (const key of ['experiment_id', 'variant_id', 'battle_id', 'battle_round', 'assistant', 'profile_version'] as const) {
      expect(old?.[key]).toEqual(fresh?.[key]);
    }
  });

  it('the control serves a never-activated pinned version of the live assistant, and that version is what is recorded', async () => {
    const rec = await transformToMessageRecord(event(LIVE_BOT, duelAnswer('control', 'advisor', 12), { content: marker(2) }) as never);
    expect(rec?.variant_id).toBe('control');
    expect(rec?.assistant).toBe('advisor');
    expect(rec?.profile_version).toBe(12);
    expect(rec?.battle_round).toBe(2);
  });

  it('no reader in analytics keys on an alt bot ARN, a slot id or an injected variant field', () => {
    const dir = path.join(__dirname, '..', '..', 'lambda/src/analytics-aurora');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    // `imageGenModelId` as a whole word: `imageGenModelIdToKey` is the catalog lookup the cost path uses.
    const retired = /altSlotArn|altBotSlot|AltSlot|variantModelKey|variantAddendum|variantImageModelKey|selfDisplayName|rivalDisplayName|\bimageGenModelId\b/;
    for (const f of files) {
      expect({ file: f, hit: retired.test(fs.readFileSync(path.join(dir, f), 'utf8')) }).toEqual({ file: f, hit: false });
    }
  });
});
