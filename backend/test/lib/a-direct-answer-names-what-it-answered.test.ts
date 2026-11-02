/**
 * THE FASTEST ANSWER IN THE SYSTEM WAS THE ONLY ONE THAT NAMED NOTHING.
 *
 * A `DIRECT` answer is returned by the Lex fulfillment and materialized by Amazon Chime SDK. It never
 * reaches the async processor, so it carried no correlation marker, no declared target, no delivery
 * option and nothing a second event could fold telemetry onto. Archival paired it by ADJACENCY - the
 * first bot message after a user message in the same Kinesis batch, with no marker test, no time
 * bound and no intervening-message test - which under a queue is exactly wrong: a burst produces a
 * deferral notice, a reading's proposal and an answer in an order that has nothing to do with which
 * message each belongs to.
 *
 * The marker was missing by CODE ORDERING rather than by any platform limit: the branch returned four
 * lines before the correlation id was minted. Owner direction, 2026-09-11: "the lambda should match
 * the message it is responding to and at a min have a corr marker... I'd rather have accuracy with
 * delay than mismatching."
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────────────────────────
 *
 *  1. the declaration round-trips, is bounded and character-classed, and cannot be forged by text
 *     that arrived with a declaration already in it;
 *  2. a handler-answered greeting carries a correlation marker AND names the message it answers;
 *  3. it declares that it is already FINISHED, so the marker does not open a response nothing closes;
 *  4. marking it does not let one person's repeated "thanks" silence the second answer;
 *  5. none of it is ever visible to a human.
 */

import {
  TURN_KINDS,
  isDeclarableValue,
  stripTurnDeclarations,
  turnDeclarationMarker,
  turnDeclarationOf,
  withTurnDeclaration,
  declaresFinalAnswer,
} from '../../lambda/src/lib/turn-declaration.js';
import { stripMessageMarkers } from '../../lambda/src/lib/message-markers.js';
import { correlationMarkerOf } from '../../lambda/src/lib/correlation.js';
import { ledgerRowsFor } from '../../lambda/src/analytics-aurora/turn-events-live.js';
// FROM THE REGISTRY, not a literal: the assistant names are deployment configuration, so a test that
// hardcoded one would fail the day a deployment renamed its profiles - reporting a config change as a
// contract break.
import { defaultProfileRegistry } from '../../lib/profile-registry.js';

describe('what a turn declares about itself', () => {
  it('round-trips every fact it states', () => {
    const content = withTurnDeclaration('Hey, what can I help you with?', {
      answers: 'msg-abc123',
      delivery: 'DIRECT',
      phase: 'final',
    });

    expect(turnDeclarationOf(content)).toEqual({
      answers: 'msg-abc123',
      delivery: 'DIRECT',
      phase: 'final',
    });
  });

  /**
   * WHICH ASSISTANT ANSWERED, on the one path with no metadata channel.
   *
   * Every other path stamps the responding assistant in metadata. A Lex-entry answer is materialized
   * by Amazon Chime SDK from the fulfillment return and carries none, so before this field the two
   * corr-marked returns - the DIRECT quick answer and the drift-spawned welcome - landed with a NULL
   * `agent_type` that every console rollup renders as an unknown assistant.
   */
  it('carries the assistant that answered, and reads it back', () => {
    const name = defaultProfileRegistry.profileNames()[0];
    const content = withTurnDeclaration('Q3 is up 10%.', {
      answers: 'msg-abc123',
      delivery: 'DIRECT',
      phase: 'final',
      assistant: name,
    });

    expect(turnDeclarationOf(content).assistant).toBe(name);
  });

  it('refuses an assistant this deployment does not declare', () => {
    // It lands in `messages.agent_type`, which readers group and filter by, so a crafted value would
    // invent an assistant in every console rollup. A declaration is content-carried and content
    // reaches the model, so "nobody would write that" is not an argument available here.
    //
    // DROPPED rather than kept, which leaves the turn unattributed - exactly where it was before this
    // field existed - instead of attributed to something that does not exist.
    const forged = withTurnDeclaration('hi', { assistant: 'not-a-real-assistant' });
    expect(turnDeclarationOf(forged).assistant).toBeUndefined();

    // And it is not a classification. ADR-051: this names the assistant, which is an identity; the
    // conversation's classification is a separate fact resolved from the channel tag.
    expect(turnDeclarationOf(withTurnDeclaration('hi', { assistant: 'premium' })).assistant)
      .toBeUndefined();
  });

  it('declares nothing rather than declaring a value it could not read back', () => {
    // A value that cannot survive the reader's own pattern is not mangled or escaped, because a
    // truncated message id pairs the answer with nothing while looking exactly like a declaration
    // that worked. The same guarantee `isReadableCorrelationId` gives a correlation id.
    expect(isDeclarableValue('a message id with spaces')).toBe(false);
    expect(turnDeclarationMarker({ answers: 'a message id with spaces' })).toBe('');
    expect(turnDeclarationOf(withTurnDeclaration('hi', { answers: 'has spaces' }))).toEqual({});
  });

  it('refuses a kind outside the closed set', () => {
    // The set is closed so a query can ask for "everything that is not an answer" without naming the
    // kinds it has not heard of. A value from outside it is not a new kind, it is a typo.
    //
    // CLOSED, NOT FROZEN. This asserted the exact pair ['reading', 'drift'], which made the set
    // unable to grow without the test reading as a deliberate rule being broken. It grew for a real
    // reason: a welcome and a platform notification answer nothing either, and a kind missing from
    // here was DROPPED by the parser, so declaring one achieved nothing and the message landed in
    // `answer` - the bucket that means "declared nothing". What matters is that the set is an
    // allowlist and that the originals are still in it, which is what these two lines say.
    expect(TURN_KINDS).toEqual(expect.arrayContaining(['reading', 'drift']));
    expect(TURN_KINDS).not.toContain('answer'); // `answer` is the ABSENCE of a declaration, never one
    expect(turnDeclarationOf('<!--turn:kind=whatever-->')).toEqual({});
    expect(turnDeclarationOf('<!--turn:kind=drift-->')).toEqual({ kind: 'drift' });
  });

  it('cannot be forged by a declaration that arrived inside the text', () => {
    // A drift suggestion is model-composed prose, and a model that leaked this marker - or a person
    // who typed one and had it quoted back - would otherwise be asserting who answered what.
    const composed = 'Sure. <!--turn:answers=someone-elses-message-->';

    const posted = withTurnDeclaration(composed, { answers: 'the-real-one', kind: 'drift' });

    expect(posted).not.toContain('someone-elses-message');
    expect(turnDeclarationOf(posted)).toEqual({ answers: 'the-real-one', kind: 'drift' });
  });

  it('is never shown to a human', () => {
    const posted = withTurnDeclaration('Happy to help.', { answers: 'm-1', delivery: 'DIRECT' });

    // The SPA strips every HTML comment and the backend mirror does the same, so a marker added here
    // needs no client change to stay invisible - to the reader, to the relevance judge, and to the
    // admin conversation browser.
    expect(stripMessageMarkers(posted)).toBe('Happy to help.');
  });

  it('leaves content untouched when there is nothing to declare', () => {
    expect(withTurnDeclaration('Goodbye!', {})).toBe('Goodbye!');
    expect(stripTurnDeclarations('Goodbye! <!--turn:answers=m-1-->')).toBe('Goodbye! ');
  });
});

/**
 * ADDING THE MARKER CHANGED WHAT FOUR EXISTING READERS BELIEVE ABOUT THIS MESSAGE.
 *
 * Each decided "this is a placeholder" from the marker alone, and each was right for as long as the
 * only marked messages were placeholders. A handler-answered turn posts once and is the whole
 * answer, so every one of them had to learn to ask what the turn DECLARED instead.
 */
describe('a marked message is no longer necessarily a placeholder', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

  it('recognizes a turn that said it is already finished', () => {
    expect(declaresFinalAnswer('Hi <!--corr:abcd1234--><!--turn:delivery=DIRECT;phase=final-->')).toBe(true);
    expect(declaresFinalAnswer('One moment... <!--corr:abcd1234-->')).toBe(false);
    expect(declaresFinalAnswer('Shall I split that out? <!--turn:answers=m-1;kind=drift-->')).toBe(false);
    expect(declaresFinalAnswer(null)).toBe(false);
  });

  it('keeps a handler-answered turn in the history handed to the model', () => {
    // `isPlaceholderMessage` drops placeholders from the conversation history. Its own header
    // records what that costs when it is wrong: an invisible, intermittent drop that reads as "the
    // assistant forgot the previous turn".
    expect(src('lambda/src/lib/async-processor-core.ts'))
      .toContain('if (declaresFinalAnswer(content)) return false;');
  });

  it('lets the judge score the greeting rather than walking past it', () => {
    // The evaluation runner skips placeholders and walks FORWARD for the real reply, so a greeting
    // read as one hands its user message to somebody else's answer to be judged against - a
    // mispairing inside the judge, which is worse than not judging the turn at all.
    expect(src('lambda/src/evaluation/evaluation-runner.ts'))
      .toContain('!declaresFinalAnswer(content) && (');
  });

  it('lets the client stop the clock on it', () => {
    // The client skips latency tracking on a placeholder, so the turn would report no answer at all.
    expect(src('../frontend/packages/chat/src/providers/MessagingProvider.tsx'))
      .toContain('if (declaresFinalAnswer(rawContent)) return false;');
  });
});

describe('the ledger reads a handler-answered turn as finished, not as a placeholder', () => {
  const base = {
    channel_arn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c1',
    message_id: 'm-greeting-reply',
    event_type: 'CREATE_CHANNEL_MESSAGE',
    sender_arn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/bot/premium',
    is_bot: true,
    created_at: '2026-09-11T10:00:00.000Z',
    task_id: null,
    task_state: null,
    trigger_kind: null,
    acknowledges: null,
    queue_status: null,
    content: 'Hey, what can I help you with? <!--corr:abcd1234abcd1234-->',
  };

  it('closes the response the same instant it opens it', () => {
    // Without the declared phase this message is read as a placeholder something else will close, so
    // every greeting would sit `unresolved` with no e2e_ms and a place in every unclosed-turn count.
    const rows = ledgerRowsFor([{ ...base, resp_phase: 'final' } as never]);

    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain('placeholder_posted');
    expect(kinds).toContain('final_response');
    // One response, two instants that are the same instant: first feedback and the answer were the
    // same event.
    expect(new Set(rows.map((r) => r.response_id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.occurred_at)).size).toBe(1);
  });

  it('closes nothing when the producer declared no phase', () => {
    // The ordinary placeholder: the answer has not happened yet, and forging a finish here would
    // report a turn still running as a fast one.
    const rows = ledgerRowsFor([{ ...base, resp_phase: null } as never]);

    expect(rows.map((r) => r.kind)).toEqual(['placeholder_posted']);
  });
});

// ── AND THE ROUTER ITSELF ──────────────────────────────────────────────────────────────────────

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

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

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
const BOT_SELF = `${APP}/bot/premium-bot`;
const HUMAN = `${APP}/user/alice`;

/** The environment this file runs the router in, declared rather than inherited. */
const ROUTER_ENV: Record<string, string | undefined> = {
  AWS_LAMBDA_FUNCTION_NAME: 'AgentEchelonAssistants-premium-AgentHandler',
  // THE ROUTER IS DEPLOYED AS A CLASSIFICATION; a handler with none declines the turn (ADR-046).
  CLASSIFICATION: 'premium',
  ABUSE_CONTROLS_TABLE: undefined,
  ENABLE_LIVE_DRIFT: undefined,
};

const applyEnv = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

/** What the turn answered the person with. */
const lexReply = (response: { messages?: Array<{ content: string }> }) =>
  response?.messages?.[0]?.content ?? '';

describe('a greeting answered from the handler says what it answered', () => {
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
      if (cmd?.__type === 'ListMessages') {
        // Newest first, which is what makes the match identifying when the same words were sent
        // more than once.
        return {
          ChannelMessages: [
            { MessageId: 'm-second-hello', Content: 'hello', Sender: { Arn: HUMAN } },
            { MessageId: 'm-first-hello', Content: 'hello', Sender: { Arn: HUMAN } },
          ],
        };
      }
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
    },
  });

  it('carries a correlation marker, which it never did before', async () => {
    const reply = lexReply(await routerHandler(lexTurn('hello')));

    expect(reply).toContain('Hey, what can I help you with?');
    expect(correlationMarkerOf(reply)).toBeTruthy();
  });

  it('names the message it is answering, resolved from the channel', async () => {
    // Amazon Chime SDK sends Lex exactly three request attributes and a message id is not among
    // them, so the id comes from a content-matched channel read. That read is the accepted price of
    // the pairing: "I'd rather have accuracy with delay than mismatching."
    const reply = lexReply(await routerHandler(lexTurn('hello')));

    expect(turnDeclarationOf(reply).answers).toBe('m-second-hello');
  });

  it('declares the delivery it took and that it is already finished', async () => {
    const reply = lexReply(await routerHandler(lexTurn('thanks')));

    expect(turnDeclarationOf(reply)).toMatchObject({ delivery: 'DIRECT', phase: 'final' });
  });

  it('gives two sends of the same words two different correlations', async () => {
    // The derived id buckets on (channel, sender, text, 90s), and the channel flow DENIES a second
    // message holding a correlation already claimed. Marking this answer without this would mean
    // "thanks" twice inside a minute gets one reply - and a pleasantry is exactly the shape of
    // message people repeat. The resolved message id separates the two turns; a genuine retry
    // replays the same message and still collapses.
    const first = lexReply(await routerHandler(lexTurn('hello')));

    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      if (cmd?.__type === 'ListMessages') {
        return { ChannelMessages: [{ MessageId: 'm-third-hello', Content: 'hello', Sender: { Arn: HUMAN } }] };
      }
      return { MessageId: 'sent-1' };
    });

    const second = lexReply(await routerHandler(lexTurn('hello')));

    expect(correlationMarkerOf(first)).not.toBe(correlationMarkerOf(second));
  });

  it('still answers when the message it was answering could not be found', async () => {
    // A declaration that could not be made is not faked. The turn keeps its marker and its delivery
    // option, the pairing falls back to exactly where it was, and the person still gets an answer.
    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      if (cmd?.__type === 'ListMessages') return { ChannelMessages: [] };
      return { MessageId: 'sent-1' };
    });

    const reply = lexReply(await routerHandler(lexTurn('hello')));

    expect(reply).toContain('Hey, what can I help you with?');
    expect(turnDeclarationOf(reply).answers).toBeUndefined();
    expect(turnDeclarationOf(reply).delivery).toBe('DIRECT');
    expect(correlationMarkerOf(reply)).toBeTruthy();
  });

  it('shows the person none of it', async () => {
    const reply = lexReply(await routerHandler(lexTurn('hello')));

    expect(stripMessageMarkers(reply)).toBe('Hey, what can I help you with?');
  });

  // ── AND IT NAMES HOW IT ARRIVED, WHICH HAD NO CARRIER AT ALL ──────────────────────────────────
  //
  // `entry` rides the analytics metadata, and this is the turn that proves metadata is not enough:
  // a `DIRECT` answer is materialized by Amazon Chime SDK from a Lex fulfillment and carries NO
  // message metadata. `delivery` survived that because archival falls back to this declaration;
  // `entry` had no fallback and was simply lost.
  //
  // Measured before it was added: over 30 days, 153 `TASK_MULTI_STEP` and 24 `DIRECT` turns carried
  // a delivery option and no entry - one key having a content carrier and the other not.
  it('names how the turn arrived, on the one answer that carries no metadata at all', async () => {
    const reply = lexReply(await routerHandler(lexTurn('hello')));

    expect(turnDeclarationOf(reply).entry).toBe('lex');
    // Beside the facts it already declared, not instead of them.
    expect(turnDeclarationOf(reply).delivery).toBe('DIRECT');
    expect(stripMessageMarkers(reply)).toBe('Hey, what can I help you with?');
  });

  // `messages.turn_entry` is VARCHAR(8) and a declarable value runs to 128 characters. Archival
  // inserts inside a transaction, so an over-long value is not one bad row - it aborts the whole
  // Kinesis batch and retries on it. Content reaches the model, so "nobody would write that" is not
  // an argument available here.
  it('drops an entry it does not recognise rather than passing it through', () => {
    expect(turnDeclarationOf('hi <!--turn:entry=flow-->').entry).toBe('flow');
    expect(turnDeclarationOf('hi <!--turn:entry=lex-->').entry).toBe('lex');
    expect(turnDeclarationOf('hi <!--turn:entry=websocket-->').entry).toBeUndefined();
    expect(turnDeclarationOf(`hi <!--turn:entry=${'x'.repeat(40)}-->`).entry).toBeUndefined();
  });
});
