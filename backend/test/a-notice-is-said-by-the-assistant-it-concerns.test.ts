/**
 * A NOTICE IS SAID BY THE ASSISTANT IT CONCERNS, IN THAT ASSISTANT'S OWN WORDS.
 *
 * The channel flow names a notice kind and hands it to the router (`aeNotice`); it composes no words.
 * The router resolves the assistant behind the bot from its assignment record, reads that assistant's active copy,
 * and posts the line on a speak session, targeted at whoever the flow named, with the assistant's
 * attribution and the notice's kind. Every field of the hand-off is checked before anything is said.
 */
const mockDdbSend = jest.fn();
const mockSsmSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockChimeSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  return { ...actual, DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })) };
});
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: mockSsmSend })) };
});
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  return { ...actual, LambdaClient: jest.fn(() => ({ send: mockLambdaSend })) };
});
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => {
  const actual = jest.requireActual('@aws-sdk/client-chime-sdk-messaging');
  return { ...actual, ChimeSDKMessagingClient: jest.fn(() => ({ send: mockChimeSend })) };
});
const mockDocSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return { ...actual, DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDocSend })) } };
});
const mockSpeak = jest.fn(async () => ({}));
jest.mock('../lambda/src/lib/assistant-session', () => {
  const actual = jest.requireActual('../lambda/src/lib/assistant-session');
  return { ...actual, speakAsRoutedAssistant: (...a: unknown[]) => mockSpeak(...(a as [])) };
});
const mockSanctioned = jest.fn(async () => true);
jest.mock('../lambda/src/lib/battle-turn', () => {
  const actual = jest.requireActual('../lambda/src/lib/battle-turn');
  return { ...actual, isSanctionedBattleBot: (...a: unknown[]) => mockSanctioned(...(a as [])) };
});
const mockActive = jest.fn();
jest.mock('../lambda/src/lib/active-profile', () => {
  const actual = jest.requireActual('../lambda/src/lib/active-profile');
  return { ...actual, resolveActiveProfile: (...a: unknown[]) => mockActive(...a) };
});

process.env.CLASSIFICATION = 'premium';
process.env.TURN_ROUTING_TABLE = 'routing-premium';
process.env.SSM_ROOT = '/agent-echelon';
process.env.BOT_ARN_PARAM = '/agent-echelon/premium/bot-arn';
process.env.ASSISTANT_ROLE = 'primary';
process.env.PROFILE_NAME = 'advisor';

import { SendChannelMessageCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { handler } from '../lambda/src/router-agent-handler';
import { DEFAULT_NOTICE_COPY } from '../lambda/src/lib/assistant-notice';
import { SPEAK_ROUTE_PREFIX } from '../lambda/src/lib/assistant-grant';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1';
const CHANNEL = `${APP}/channel/c1`;
const PRIMARY_BOT = `${APP}/bot/advisor-bot`;
const OPS_BOT = `${APP}/bot/ops-bot`;
const STRAY_BOT = `${APP}/bot/stray-bot`;
const ALICE = `${APP}/user/alice`;

const sends = () => mockChimeSend.mock.calls.map((c) => c[0]).filter((c) => c instanceof SendChannelMessageCommand)
  .map((c) => (c as SendChannelMessageCommand).input);

const say = (req: Record<string, unknown>) => handler({ aeNotice: req } as never) as unknown as Promise<{ posted: boolean; reason?: string }>;

beforeEach(() => {
  for (const m of [mockDdbSend, mockSsmSend, mockLambdaSend, mockChimeSend, mockSpeak, mockActive]) m.mockReset();
  mockSpeak.mockResolvedValue({});
  mockSanctioned.mockReset().mockResolvedValue(true);
  mockChimeSend.mockImplementation(async (cmd: { constructor: { name: string } }) => (
    cmd.constructor.name === 'ListTagsForResourceCommand'
      ? { Tags: [{ Key: 'classification', Value: 'premium' }] }
      : { MessageId: 'm-notice' }
  ));
  mockSsmSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'GetParameterCommand') return { Parameter: { Value: PRIMARY_BOT } };
    if (cmd.constructor.name === 'GetParametersByPathCommand') {
      return {
        Parameters: [
          { Value: JSON.stringify({ botArn: PRIMARY_BOT, assistant: 'advisor', role: 'primary', occupancy: 'live' }) },
          { Value: JSON.stringify({ botArn: OPS_BOT, assistant: 'ops-premium', role: 'ops', occupancy: 'live' }) },
        ],
      };
    }
    return {};
  });
});

describe('the router says a notice as the assistant it names', () => {
  it("posts the assigned assistant's line, to the sender alone, with its attribution, on a speak route", async () => {
    // A version's retired `copy` line is not read: the line is the assistant's template, here the shipped one.
    mockActive.mockResolvedValue({ copy: { battleNotEnabled: 'Ops here: Battle Mode is off in this room.' } });
    const out = await say({ kind: 'battleNotEnabled', channelArn: CHANNEL, botArn: OPS_BOT, to: [ALICE] });
    expect(out).toEqual({ posted: true });
    expect(mockActive).toHaveBeenCalledWith('ops-premium', expect.anything());
    const [msg] = sends();
    expect(msg.Content).toBe(encodeURIComponent(DEFAULT_NOTICE_COPY.battleNotEnabled));
    expect(msg.ChimeBearer).toBe(OPS_BOT);
    expect(msg.Target).toEqual([{ MemberArn: ALICE }]);
    expect(JSON.parse(msg.Metadata!)).toMatchObject({
      botResponse: true, agentType: 'ops-premium', assistantRole: 'ops', classification: 'premium',
      turnKind: 'battle-notice', targetedSender: ALICE,
    });
    const [[route]] = mockSpeak.mock.calls as unknown as Array<[{ routeId: string; botArn: string }]>;
    expect(route.routeId.startsWith(`${SPEAK_ROUTE_PREFIX}notice-`)).toBe(true);
    expect(route.botArn).toBe(OPS_BOT);
  });

  it('keeps the shipped English when the assistant set no line, with the placeholders filled', async () => {
    mockActive.mockResolvedValue({ copy: {} });
    await say({ kind: 'rateLimited', channelArn: CHANNEL, botArn: PRIMARY_BOT, to: [ALICE], vars: { minutes: 7 } });
    const [msg] = sends();
    expect(msg.Content).toBe(encodeURIComponent(DEFAULT_NOTICE_COPY.rateLimited.replace('{minutes}', '7')));
    expect(JSON.parse(msg.Metadata!)).toMatchObject({ agentType: 'advisor', turnKind: 'notice' });
  });

  it('says it to the whole conversation when the flow names nobody', async () => {
    mockActive.mockResolvedValue(undefined);
    await say({ kind: 'battleSideStartFailed', channelArn: CHANNEL, botArn: PRIMARY_BOT, to: [] });
    const [msg] = sends();
    expect(msg.Target).toBeUndefined();
    expect(msg.Content).toBe(encodeURIComponent(DEFAULT_NOTICE_COPY.battleSideStartFailed));
  });
});

describe('every field of the hand-off is checked before anything is said', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => errorSpy.mockRestore());

  it('refuses a kind the platform does not say', async () => {
    const out = await say({ kind: 'anythingYouLike', channelArn: CHANNEL, botArn: PRIMARY_BOT, to: [ALICE] });
    expect(out.posted).toBe(false);
    expect(sends()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[SecurityEvent]'), expect.anything());
  });

  it("refuses a conversation of another classification", async () => {
    mockChimeSend.mockImplementation(async () => ({ Tags: [{ Key: 'classification', Value: 'basic' }] }));
    const out = await say({ kind: 'battleUnavailable', channelArn: CHANNEL, botArn: PRIMARY_BOT, to: [ALICE] });
    expect(out).toEqual({ posted: false, reason: 'the conversation is not this classification' });
    expect(sends()).toHaveLength(0);
  });

  it('refuses a bot that is not one of this classification\'s assistants', async () => {
    mockSanctioned.mockResolvedValue(false);
    const out = await say({ kind: 'battleUnavailable', channelArn: CHANNEL, botArn: STRAY_BOT, to: [ALICE] });
    expect(out.posted).toBe(false);
    expect(sends()).toHaveLength(0);
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it('declines, with no reply in another assistant\'s words, when the bot\'s assistant cannot be named', async () => {
    // Sanctioned, but no assignment record names it and it is not the classification's own bot.
    const out = await say({ kind: 'battleUnavailable', channelArn: CHANNEL, botArn: STRAY_BOT, to: [ALICE] });
    expect(out).toEqual({ posted: false, reason: 'no-assignment-record' });
    expect(sends()).toHaveLength(0);
    expect(mockActive).not.toHaveBeenCalled();
  });

  it('addresses people only, never another assistant', async () => {
    mockActive.mockResolvedValue(undefined);
    await say({ kind: 'battleNoneRunning', channelArn: CHANNEL, botArn: PRIMARY_BOT, to: [OPS_BOT, ALICE] });
    expect(sends()[0].Target).toEqual([{ MemberArn: ALICE }]);
  });
});

describe('every notice can be worded by a deployment', () => {
  const read = (...p: string[]) => require('fs').readFileSync(require('path').join(__dirname, ...p), 'utf8') as string;

  it('every notice key is declared on AssistantCopy and documented in the profile guide', () => {
    const profile = read('..', 'lambda', 'src', 'lib', 'active-profile.ts');
    const guide = read('..', '..', 'docs', 'guides', 'developer', 'HOW-TO-ADD-OR-MANAGE-A-PROFILE.md');
    for (const key of Object.keys(DEFAULT_NOTICE_COPY)) {
      expect({ key, declared: profile.split('\n').some((l) => l.trim() === `${key}?: string;`) }).toEqual({ key, declared: true });
      expect({ key, documented: guide.includes(`| \`${key}\` |`) }).toEqual({ key, documented: true });
    }
  });

  it('the channel flow composes no notice text of its own', () => {
    const flow = read('..', 'lambda', 'src', 'channel-flow-processor.ts');
    for (const line of Object.values(DEFAULT_NOTICE_COPY)) {
      expect({ line: line.slice(0, 40), inFlow: flow.includes(line.slice(0, 40)) }).toEqual({ line: line.slice(0, 40), inFlow: false });
    }
  });
});
