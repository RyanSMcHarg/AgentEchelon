/**
 * A DUEL SIDE'S PLACEHOLDER NAMES THE MESSAGE IT ANSWERS, AND A REBUTTAL DELIBERATELY DOES NOT.
 *
 * ── WHY THIS POPULATION AND NOT ANOTHER ─────────────────────────────────────────────────────────
 *
 * A battle side is the worst combination there is to leave undeclared: the id is FREE and the turn is
 * SLOW. Free, because the round-1 fan-out hands the turn the user's `MessageId`
 * (`channel-flow-processor.ts` sets `userMessageId`, which the router reads back as `AE.message.id`),
 * so no channel read is bought to learn it. Slow, because a duel runs two model calls per round, so
 * its time to first feedback routinely exceeds the five second Kinesis batching window - and beyond
 * that window the in-batch pairer never sees the turn, the sweep mints the exchange from the
 * placeholder CREATE alone, and an undeclared pairing is recorded `paired_by = 'swept'` and excluded
 * from TTFF by design (migration 042).
 *
 * `battlePlaceholderContent` composed a `corr` marker and a `battle` marker and declared nothing at
 * all, so every duel side in the system was in that excluded population.
 *
 * ── AND THE ROUND-2 OMISSION IS A DECISION, WHICH IS WHY IT IS TESTED TOO ───────────────────────
 *
 * The orchestrator holds `originatingMessageId` when it posts a round-2 placeholder, so the omission
 * has to be pinned or it reads as an oversight somebody will helpfully close. A rebuttal answers the
 * RIVAL'S reply, off a clock that starts when the rival finished; nobody asked for it and nobody is
 * waiting on it, which is why LATENCY-TARGETS keeps it out of the perceived-latency SLO. Declaring
 * the originating message would readmit it as a `declared` pairing - the label that means "exact" -
 * at a latency spanning both rounds and the orchestrator's coordination gap.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ChannelFlowCallbackCommand: jest.fn().mockImplementation((args) => ({ __type: 'Callback', input: args })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMessages', input: args })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((args) => ({ __type: 'Invoke', input: args })),
  InvocationType: { Event: 'Event', RequestResponse: 'RequestResponse' },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetParam', input: args })),
  // The assignment records the router resolves the turn's assistant from.
  GetParametersByPathCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetByPath', input: args })),
}), { virtual: true });

const mockGetActiveTaskForOwner = jest.fn();
const mockGetActiveTask = jest.fn();

jest.mock('../../lambda/src/lib/task-tracking.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/task-tracking.js');
  return {
    ...actual,
    getActiveTaskForOwner: (...a: unknown[]) => mockGetActiveTaskForOwner(...a),
    getActiveTasksForOwnerInChannel: async (...a: unknown[]) => {
      const t = await mockGetActiveTaskForOwner(...a);
      return t ? [t] : [];
    },
    getAssigneeChannelTasks: async (...a: unknown[]) => {
      const t = await mockGetActiveTaskForOwner(...a);
      return { live: t ? [t] : [], recentlyEnded: [] };
    },
    getActiveTask: (...a: unknown[]) => mockGetActiveTask(...a),
  };
}, { virtual: true });

import { battlePlaceholderContent } from '../../lambda/src/lib/battle-turn';
import { turnDeclarationOf } from '../../lambda/src/lib/turn-declaration';
import { stripMessageMarkers } from '../../lambda/src/lib/message-markers';
import { transformToMessageRecord } from '../../lambda/src/analytics-aurora/kinesis-archival';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
const BOT_DEFAULT = `${APP}/bot/premium-bot`;
const BOT_ALT = `${APP}/bot/AltSlot0`;
const HUMAN = `${APP}/user/alice`;
const BATTLE_ID = 'battle-xyz';

/** The frontend's own battle-marker pattern, so this file tests what a client will actually parse. */
const BATTLE_MARKER_PATTERN = /<!--battle:([^>]+)-->/;

describe('what a duel side declares on the placeholder it posts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const side = (answersMessageId?: string) => battlePlaceholderContent({
    correlationId: 'battle-r1-default-abc',
    battleId: BATTLE_ID,
    round: 1,
    totalRounds: 2,
    rivalBotArn: BOT_ALT,
    displayName: 'Control',
    ...(answersMessageId !== undefined ? { answersMessageId } : {}),
  });

  it('names the message when the caller handed it the id', () => {
    expect(turnDeclarationOf(side('m-the-battle-command')).answers).toBe('m-the-battle-command');
  });

  it('declares NOTHING when no caller held the id, and adds no marker at all', () => {
    // THE NON-VACUITY. A duel side that was never told which message it answers posts exactly the
    // content it posted before, and the repair is the update fold - never a channel read in front of
    // the person's first frame.
    const content = side();

    expect(turnDeclarationOf(content).answers).toBeUndefined();
    expect(content).not.toContain('<!--turn:');
  });

  it('treats an empty id the same as no id, because the router passes one either way', () => {
    // `knownInboundMessageId` is a string that is empty until something resolves it, so the empty
    // case is the ordinary Lex-entry case rather than an edge one.
    expect(side('')).not.toContain('<!--turn:');
  });

  it('DROPS an id that cannot survive the round trip rather than mangling it', () => {
    // A truncated or escaped id would pair the side with nothing while looking exactly like a
    // declaration that worked.
    const content = side('not a readable id');

    expect(content).not.toContain('<!--turn:');
    expect(turnDeclarationOf(content).answers).toBeUndefined();
  });

  it('declares no PHASE, so the placeholder does not close the response it opens', () => {
    // The ledger reads a corr-marked bot message as a response something else will close. A duel
    // side's worker posts that close; declaring `final` here would end the turn as it began.
    expect(turnDeclarationOf(side('m-the-battle-command')).phase).toBeUndefined();
  });

  it('declares no KIND, because a duel side IS an answer - delivered twice', () => {
    // `turn_kind` is a closed set of NON-answers, and both pairers exclude any message that declares
    // one. A duel side declaring a kind would vanish from the exchange population entirely.
    expect(turnDeclarationOf(side('m-the-battle-command')).kind).toBeUndefined();
  });

  it('leaves the battle marker intact and parseable, with the declaration after it', () => {
    // The frontend's marker pattern is bounded by `[^>]+`, so an appended comment cannot be absorbed
    // into it - but the ordering is what makes that true, and the ordering is what this pins.
    const content = side('m-the-battle-command');
    const marker = content.match(BATTLE_MARKER_PATTERN);

    expect(marker).toBeTruthy();
    expect(marker![1]).toContain(`battleId=${BATTLE_ID}`);
    expect(marker![1]).toContain('round=1');
    expect(marker![1]).not.toContain('turn:');
    expect(content.indexOf('<!--turn:')).toBeGreaterThan(content.indexOf('<!--battle:'));
  });

  it('shows the person none of it', () => {
    expect(stripMessageMarkers(side('m-the-battle-command'))).not.toContain('turn:');
  });
});

/**
 * AND THE ROUTER PASSES THE ID IT ALREADY HOLDS, ON THE ENTRY A ROUND-1 SIDE ACTUALLY ARRIVES ON.
 *
 * The fan-out invokes the router per side with `userMessageId` set, which the bypass envelope carries
 * as `AE.message.id`. Everything above tests the composer; this tests that the composer is reached
 * with the id rather than without it.
 */
describe('the router hands a duel side the id the fan-out declared', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let routerHandler: (e: any) => Promise<{ messages?: Array<{ content: string }> }>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'AgentEchelonAssistants-premium-AgentHandler';
    // THE ROUTER IS DEPLOYED AS A CLASSIFICATION; a handler with none declines the turn (ADR-046).
    process.env.CLASSIFICATION = 'premium';
    mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT_DEFAULT } });
    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      // DELIBERATELY EMPTY. Nothing here may depend on the router reading the channel for the id:
      // that read is the cost the declaration is not allowed to buy.
      if (cmd?.__type === 'ListMessages') return { ChannelMessages: [] };
      return { MessageId: 'sent-1' };
    });
    mockGetActiveTaskForOwner.mockResolvedValue(null);
    mockGetActiveTask.mockResolvedValue(null);
    ({ handler: routerHandler } = await import('../../lambda/src/router-agent-handler.js'));
  });

  const duelTurn = (userMessageId?: string) => ({
    aeTurn: {
      channelArn: CHANNEL,
      senderArn: HUMAN,
      userMessage: 'Which database should we pick for the events pipeline?',
      botArn: BOT_DEFAULT,
      correlationId: 'battle-r1-default-abc',
      ...(userMessageId ? { userMessageId } : {}),
      battleContext: {
        battleId: BATTLE_ID,
        round: 1,
        totalRounds: 2,
        selfBotArn: BOT_DEFAULT,
        rivalBotArn: BOT_ALT,
        ...(userMessageId ? { originatingMessageId: userMessageId } : {}),
      },
    },
  });

  /**
   * WHAT THE SIDE ACTUALLY POSTED, not what it handed back.
   *
   * A duel side posts its own placeholder as its own bot (ADR-025) and then returns silence, so the
   * Lex envelope is empty by design and the content under test is the `SendChannelMessage` the turn
   * made. Reading the envelope here would assert on the wrong artifact and pass on an empty string.
   */
  // Posted percent-encoded, as every platform message is, and read as the client reads it.
  const posted = () => decodeURIComponent((mockMessagingSend.mock.calls
    .map((c) => c[0])
    .find((cmd: { __type?: string }) => cmd?.__type === 'SendMessage')?.input?.Content ?? '') as string);

  it('posts a duel placeholder that names the /battle message', async () => {
    await routerHandler(duelTurn('m-the-battle-command'));
    const content = posted();

    // Still a duel side: the battle marker is what makes the frontend render it as one.
    expect(content).toMatch(BATTLE_MARKER_PATTERN);
    expect(turnDeclarationOf(content).answers).toBe('m-the-battle-command');
  });

  it('posts the same duel placeholder declaring NO answered message when no id was handed over', async () => {
    // The non-vacuity for the routing half: the branch is reached either way, and what differs is
    // only whether the id was there to declare. The entry is declared either way: it is how the turn
    // came in, which the router knows without any id.
    await routerHandler(duelTurn());
    const content = posted();

    expect(content).toMatch(BATTLE_MARKER_PATTERN);
    expect(turnDeclarationOf(content).answers).toBeUndefined();
    expect(turnDeclarationOf(content).entry).toBe('flow');
  });
});

/**
 * AND ARCHIVAL FOLDS IT OFF THE CREATE ROW, WHICH IS THE WHOLE POINT.
 *
 * Both pairers read the declaration from the UPDATE row first and the CREATE row second. A duel's
 * sweep runs on the batch carrying the placeholder CREATE, when no UPDATE row exists yet - so before
 * this the COALESCE fell through to NULL and the CASE wrote `swept`.
 */
describe('archival folds a duel placeholder declaration onto the CREATE row', () => {
  const duelPlaceholderEvent = (content: string) => ({
    EventType: 'CREATE_CHANNEL_MESSAGE',
    Payload: {
      MessageId: 'm-duel-side-a',
      ChannelArn: CHANNEL,
      Content: content,
      Sender: { Arn: BOT_DEFAULT, Name: 'Control' },
      CreatedTimestamp: '2026-09-15T10:00:31.000Z',
      Persistence: 'PERSISTENT',
    },
  });

  it('carries the declared target into answers_message_id', async () => {
    const record = await transformToMessageRecord(
      duelPlaceholderEvent(battlePlaceholderContent({
        correlationId: 'battle-r1-default-abc',
        battleId: BATTLE_ID,
        round: 1,
        totalRounds: 2,
        rivalBotArn: BOT_ALT,
        answersMessageId: 'm-the-battle-command',
      })) as never,
    );

    expect(record?.answers_message_id).toBe('m-the-battle-command');
    // And it is still a placeholder: nothing closes the response here.
    expect(record?.resp_phase).toBeNull();
  });

  it('records NOTHING for the same duel placeholder without the declaration - the swept row', async () => {
    // This is the exact row every duel side wrote before this change: marked, undeclared, therefore
    // labelled `swept` and dropped from the TTFF average the duel is slow enough to matter in.
    const record = await transformToMessageRecord(
      duelPlaceholderEvent(battlePlaceholderContent({
        correlationId: 'battle-r1-default-abc',
        battleId: BATTLE_ID,
        round: 1,
        totalRounds: 2,
        rivalBotArn: BOT_ALT,
      })) as never,
    );

    expect(record?.answers_message_id).toBeNull();
  });
});

afterAll(() => { delete process.env.CLASSIFICATION; });
