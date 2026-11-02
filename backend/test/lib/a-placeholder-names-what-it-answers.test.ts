/**
 * THE PLACEHOLDER NAMES WHAT IT ANSWERS, AND THE SLOW TURNS STOPPED BEING CENSORED.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 *
 * The declaration rode the closing UPDATE alone. Kinesis archival batches on a five second window,
 * so a turn whose time to first feedback exceeds five seconds cannot have its user message and its
 * placeholder in one batch: the in-batch pairer never sees it, the cross-batch sweep mints the
 * exchange from the placeholder CREATE alone, and at that instant every carrier of the declaration
 * is still NULL. The sweep writes `paired_by = 'swept'`, the Latency tab excludes a swept pairing
 * from TTFF by name, and the turns dropped were precisely the slow ones the SLO exists to catch.
 *
 * ── THE CARRIER ─────────────────────────────────────────────────────────────────────────────────
 *
 * Amazon Chime SDK materializes this message from the Lex fulfillment return, which carries messages
 * and session attributes and no message metadata - so the 1024 byte Metadata cap is never reached
 * here. The declaration travels in content, the way a DIRECT answer's already does, and archival
 * folds it to `messages.answers_message_id` for both pairers to read.
 *
 * ── AND ONLY WHEN THE TURN ALREADY KNOWS ────────────────────────────────────────────────────────
 *
 * A bypass caller declares the id; a task row, a queue or the stop path may already have paid the
 * channel read. Buying a `ListChannelMessages` here would put it in front of the person's first
 * frame, which is exactly what `recordWhatThisTurnIsAnswering` moved out of the router. A turn that
 * does not know declares nothing and is repaired by the update fold instead.
 */

import { turnDeclarationOf } from '../../lambda/src/lib/turn-declaration.js';
import { correlationMarkerOf } from '../../lambda/src/lib/correlation.js';
import { stripMessageMarkers } from '../../lambda/src/lib/message-markers.js';
import { transformToMessageRecord } from '../../lambda/src/analytics-aurora/kinesis-archival.js';

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

// The abuse gate admits: this file is not about the gate, which fails closed with no control table
// (`abuse-controls.test.ts` pins that) and would refuse every turn here before the behavior under test.
jest.mock('../../lambda/src/lib/abuse-controls.js', () => ({
  ...jest.requireActual('../../lambda/src/lib/abuse-controls.js'),
  evaluateAbuseGate: async () => ({ allowed: true }),
}), { virtual: true });
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  UpdateChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'Update', input: args })),
  GetChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'Get', input: args })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMessages', input: args })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
  DescribeChannelCommand: jest.fn().mockImplementation((args) => ({ __type: 'DescribeChannel', input: args })),
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

// The out-of-band analytics store, which archival consults for every bot record. Absent here, so
// each record below is read from exactly the carrier under test.
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: jest.fn(async () => null),
}));

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
const BOT_SELF = `${APP}/bot/premium-bot`;
const HUMAN = `${APP}/user/alice`;
const PROCESSOR = 'arn:aws:lambda:us-east-1:111122223333:function:PremiumAsyncProcessor';

/** The environment this file runs the router in, declared rather than inherited. */
const ROUTER_ENV: Record<string, string | undefined> = {
  AWS_LAMBDA_FUNCTION_NAME: 'AgentEchelonAssistants-premium-AgentHandler',
  // THE ROUTER IS DEPLOYED AS A CLASSIFICATION; a handler with none declines the turn (ADR-046).
  CLASSIFICATION: 'premium',
  PREMIUM_ASYNC_PROCESSOR_ARN: PROCESSOR,
  ABUSE_CONTROLS_TABLE: undefined,
  ENABLE_LIVE_DRIFT: undefined,
  TURN_QUEUE_ENABLED: undefined,
};

const applyEnv = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

/** What the turn handed back for the channel to show. */
const lexReply = (response: { messages?: Array<{ content: string }> }) =>
  response?.messages?.[0]?.content ?? '';

describe('the placeholder declares the message it answers', () => {
  let routerHandler: (e: any) => Promise<{ messages?: Array<{ content: string }> }>;
  const envBefore: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of Object.keys(ROUTER_ENV)) envBefore[key] = process.env[key];
  });

  afterAll(() => applyEnv(envBefore));

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    applyEnv(ROUTER_ENV);

    mockSsmSend.mockResolvedValue({ Parameter: { Value: BOT_SELF } });
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ messages: [] })) });
    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      // DELIBERATELY EMPTY. Nothing in this file may depend on the router reading the channel to
      // find the message id: that read is the cost the declaration is not allowed to buy.
      if (cmd?.__type === 'ListMessages') return { ChannelMessages: [] };
      return { MessageId: 'sent-1' };
    });

    ({ handler: routerHandler } = await import('../../lambda/src/router-agent-handler.js'));
  });

  /** The turn as Amazon Chime SDK sends it to Lex: three request attributes, and no message id. */
  const lexTurn = (userMessage: string) => ({
    inputTranscript: userMessage,
    sessionState: { intent: { name: 'FallbackIntent' }, sessionAttributes: {} },
    requestAttributes: {
      'CHIME.channel.arn': CHANNEL,
      'CHIME.sender.arn': HUMAN,
      'x-amz-lex:channels:platform': 'Chime',
    } as Record<string, string>,
  });

  /** The same turn from a bypass caller, which declares the inbound id it already holds. */
  const bypassTurn = (userMessage: string, messageId: string) => {
    const turn = lexTurn(userMessage);
    turn.requestAttributes['AE.message.id'] = messageId;
    return turn;
  };

  const QUESTION = 'What was our Q2 ARR and how did it move against Q1?';

  it('names the message when the turn was handed the id, on the placeholder itself', async () => {
    const reply = lexReply(await routerHandler(bypassTurn(QUESTION, 'm-the-question')));

    // Still a placeholder: it carries its correlation marker and something else will close it.
    expect(correlationMarkerOf(reply)).toBeTruthy();
    expect(turnDeclarationOf(reply).answers).toBe('m-the-question');
  });

  it('declares no PHASE, so the placeholder does not close the response it opens', async () => {
    // A bot message carrying a correlation marker is read by the ledger as a response something else
    // will close. Declaring `final` here would close it the instant it opened, and every one of
    // these turns would report its own placeholder as the answer.
    const reply = lexReply(await routerHandler(bypassTurn(QUESTION, 'm-the-question')));

    expect(turnDeclarationOf(reply).phase).toBeUndefined();
  });

  it('names no message when no component has paid to resolve the id - and buys no read for it', async () => {
    // THE NON-VACUITY, AND THE BOUNDARY. An ordinary Lex turn arrives with three request attributes
    // and no message id. The repair for it is the update fold, not a `ListChannelMessages` sitting in
    // front of the person's first frame.
    //
    // THE BOUNDARY IS THE READ, NOT THE MARKER. This asserted that the turn declared nothing at all,
    // which held only while every declarable fact needed a lookup. `entry` does not: it is a property
    // of the invocation, known from the event itself (`isFlowEntry`), and it is declared precisely
    // BECAUSE this turn's metadata may never reach archival - a `DIRECT` answer materialized from a
    // Lex fulfillment carries none. So the marker is present and `answers` is still absent, which is
    // the fact that would have cost a read.
    const reply = lexReply(await routerHandler(lexTurn(QUESTION)));

    expect(correlationMarkerOf(reply)).toBeTruthy();
    expect(turnDeclarationOf(reply).answers).toBeUndefined();
    // Declared, and free.
    expect(turnDeclarationOf(reply).entry).toBe('lex');
  });

  it('shows the person none of it', async () => {
    const reply = lexReply(await routerHandler(bypassTurn(QUESTION, 'm-the-question')));

    expect(stripMessageMarkers(reply)).not.toContain('turn:');
    expect(stripMessageMarkers(reply)).not.toContain('corr:');
  });
});

/**
 * AND THE PAIRER READS IT OFF THE CREATE ROW, WHICH IS THE WHOLE POINT.
 *
 * Both pairers read the declaration from the UPDATE row first and the CREATE row second. The sweep
 * runs on the batch that carries the placeholder CREATE, when no UPDATE row exists yet - so before
 * this, the COALESCE fell through to NULL and the CASE wrote `swept`. With the declaration on the
 * CREATE the same COALESCE finds it, unchanged, and writes `declared`.
 */
describe('archival folds a placeholder declaration onto the CREATE row', () => {
  const placeholderEvent = (content: string) => ({
    EventType: 'CREATE_CHANNEL_MESSAGE',
    Payload: {
      MessageId: 'm-placeholder',
      ChannelArn: CHANNEL,
      Content: content,
      Sender: { Arn: BOT_SELF, Name: 'Assistant' },
      CreatedTimestamp: '2026-09-15T10:00:07.000Z',
      Persistence: 'PERSISTENT',
    },
  });

  it('carries the declared target into answers_message_id', async () => {
    const record = await transformToMessageRecord(
      placeholderEvent('One moment... <!--corr:abcd1234abcd1234--><!--turn:answers=m-the-question-->') as never,
    );

    expect(record?.answers_message_id).toBe('m-the-question');
    // And it is still a placeholder: no declared phase, so nothing closes the response here.
    expect(record?.resp_phase).toBeNull();
  });

  it('records NOTHING for the same placeholder without the declaration - the swept row', async () => {
    // The non-vacuity for the pairing half. This is the exact row the sweep saw before this change:
    // marked, undeclared, and therefore labelled `swept` and dropped from the TTFF average.
    const record = await transformToMessageRecord(
      placeholderEvent('One moment... <!--corr:abcd1234abcd1234-->') as never,
    );

    expect(record?.answers_message_id).toBeNull();
  });

  it('refuses a declaration a PERSON put in their own message', async () => {
    // A declaration is a statement a turn makes about its own answer. Read off a person's message it
    // would let anyone who can type assert who answered what.
    const record = await transformToMessageRecord({
      EventType: 'CREATE_CHANNEL_MESSAGE',
      Payload: {
        MessageId: 'm-typed-by-a-person',
        ChannelArn: CHANNEL,
        Content: 'nice <!--turn:answers=somebody-elses-message-->',
        Sender: { Arn: HUMAN, Name: 'Alice' },
        CreatedTimestamp: '2026-09-15T10:00:00.000Z',
        Persistence: 'PERSISTENT',
      },
    } as never);

    expect(record?.answers_message_id).toBeNull();
  });
});
