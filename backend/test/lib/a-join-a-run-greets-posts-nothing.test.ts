/**
 * A JOIN WHOSE ROOM A RUN GREETS LEAVES NOTHING IN THE ROOM (ADR-061 decision 5: where a `conversation-opened` workflow
 * opens the room, "the join posts nothing"; where the welcome runs, its steps are the opening).
 *
 * A `WelcomeIntent` that closes with no message is not silent: Amazon Chime SDK posts `{"Code":500}` as the assistant,
 * and that message does not pass through the channel flow. Measured on dev 2026-10-29 in an event-opened `ops` room:
 * the primary's join closed with `messages: []`, the lead read `{"Code":500}` from the primary, and the flow logged no
 * invocation for it. So the join returns `NOTHING_TO_POST` and the flow denies it. Each half is proved here:
 *  - every join return that says nothing is `formatLexNothingToPost`, never a silent close;
 *  - what it returns is the marker, and the marker alone;
 *  - the flow denies an assistant message carrying it, in the envelope Amazon Chime SDK materializes, and still allows
 *    a welcome beside it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { NOTHING_TO_POST, isNothingToPost } from '../../lambda/src/lib/lex-envelope';

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ChannelFlowCallbackCommand: jest.fn().mockImplementation((args) => ({ __type: 'Callback', input: args })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
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
}), { virtual: true });

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/ops-1';
const BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/bot/premium-advisor';

/** The message Amazon Chime SDK materializes from a Lex return of one PlainText message. */
const materialized = (content: string) => JSON.stringify({ Messages: [{ Content: content, ContentType: 'PlainText' }] });

function botMessage(content: string, messageId: string) {
  return {
    CallbackId: `cb-${messageId}`,
    EventType: 'CREATE_CHANNEL_MESSAGE',
    ChannelMessage: { MessageId: messageId, Content: content, Metadata: undefined, Sender: { Arn: BOT, Name: 'Advisor' }, ChannelArn: CHANNEL },
  };
}

/** The callback the flow answered a message with: a deny carries `DeleteResource`. */
const callbackFor = (messageId: string) => mockMessagingSend.mock.calls
  .map((c) => c[0])
  .find((cmd) => cmd?.__type === 'Callback' && cmd?.input?.ChannelMessage?.MessageId === messageId);

describe('the join returns NOTHING_TO_POST wherever a run greets the room', () => {
  const router = read('router-agent-handler.ts');
  const join = router.slice(router.indexOf("if (lexIntentName === 'WelcomeIntent'"), router.indexOf('// A PERSON OF ANOTHER ISSUER'));

  it('no return of the join is a silent close, which Amazon Chime SDK turns into {"Code":500}', () => {
    expect(join.length).toBeGreaterThan(0);
    expect(join).not.toContain('formatLexSilentResponse(');
  });

  it('a conversation-opened owner and a finished welcome run each return it', () => {
    expect(join).toContain("if (channelArn && arrivals === 'conversation-opened') return formatLexNothingToPost(event);");
    expect(join).toMatch(/await runWorkflowFor\(loaded\.welcome\.name, loaded\.welcome\.workflow, \{\n\s+event: 'assistant-joined'[\s\S]*?\n\s+return formatLexNothingToPost\(event\);/);
  });

  it('what it returns is the one marker message the flow recognizes', () => {
    const fn = router.slice(router.indexOf('export function formatLexNothingToPost('));
    expect(fn).toMatch(/^export function formatLexNothingToPost\(event: LexEvent\): LexResponse \{\n\s+return formatLexResponse\(event, \[\{ contentType: 'PlainText', content: NOTHING_TO_POST \}\]\);\n\}/);
    expect(isNothingToPost(materialized(NOTHING_TO_POST))).toBe(true);
  });
});

describe('isNothingToPost', () => {
  it('recognizes the marker raw, percent-encoded, and carried by a Lex envelope', () => {
    expect(isNothingToPost(NOTHING_TO_POST)).toBe(true);
    expect(isNothingToPost(` ${NOTHING_TO_POST}\n`)).toBe(true);
    expect(isNothingToPost(materialized(NOTHING_TO_POST))).toBe(true);
    expect(isNothingToPost(encodeURIComponent(materialized(NOTHING_TO_POST)))).toBe(true);
  });

  it('leaves a message that merely contains it, an empty envelope and a status artifact to their own checks', () => {
    expect(isNothingToPost(`Welcome to the room. ${NOTHING_TO_POST}`)).toBe(false);
    expect(isNothingToPost(materialized(`Welcome. ${NOTHING_TO_POST}`))).toBe(false);
    expect(isNothingToPost('{"Messages":[]}')).toBe(false);
    expect(isNothingToPost('{"Code":500}')).toBe(false);
    expect(isNothingToPost('')).toBe(false);
    expect(isNothingToPost(undefined)).toBe(false);
  });
});

describe('the channel flow denies it, and only it', () => {
  let handler: (e: any) => Promise<void>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.PREMIUM_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-premium';
    process.env.PREMIUM_ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:premium';
    mockSsmSend.mockResolvedValue({ Parameter: { Value: '' } });
    mockLambdaSend.mockResolvedValue({});
    mockMessagingSend.mockImplementation((cmd: any) => {
      if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'premium' }] });
      if (cmd.__type === 'ListMemberships') return Promise.resolve({ ChannelMemberships: [] });
      return Promise.resolve({});
    });
    ({ handler } = await import('../../lambda/src/channel-flow-processor.js'));
  });

  it('a join with nothing to post is denied, so no member reads it', async () => {
    await handler(botMessage(materialized(NOTHING_TO_POST), 'm-nothing'));
    expect(callbackFor('m-nothing')?.input?.DeleteResource).toBe(true);
  });

  it('a welcome is allowed through, so the denial is the marker\'s and not every join\'s', async () => {
    await handler(botMessage(materialized('Welcome. This room was opened for the report generation slowdown.'), 'm-welcome'));
    const cb = callbackFor('m-welcome');
    expect(cb).toBeTruthy();
    expect(cb?.input?.DeleteResource).toBeFalsy();
  });
});
