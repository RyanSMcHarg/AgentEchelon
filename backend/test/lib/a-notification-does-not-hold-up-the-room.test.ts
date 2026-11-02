/**
 * A NOTIFICATION DOES NOT HOLD UP THE ROOM (ADR-041 decision 7, SPEC-NOTIFICATION-BRIDGE).
 *
 * The fan-out that reaches people who are NOT in the conversation used to be awaited in the channel
 * flow's assistant pass, in front of `ChannelFlowCallback`. The comment above it said it never blocked
 * the callback, which was true of its failures and false of its latency: a `ListTagsForResource`, a
 * paginated membership read, then a serial `AdminGetUser` and a serial SES send per recipient all sat
 * between an assistant's message being ready and everybody in the room seeing it. A fan-out slow
 * enough to carry the flow past its 35 second deadline also loses the turn's work outright, because
 * `FallbackAction: CONTINUE` then delivers the message unprocessed.
 *
 * It runs on the message stream now. These tests pin the four things the move had to preserve, and
 * they are written so that a version where NOTHING sends fails rather than passes: the admin case
 * asserts a real SES send with a real resolved address.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');

// ── The AWS surface the fan-out touches, mocked so no call leaves the process ────────────────────
const mockChimeSend = jest.fn();
const mockCognitoSend = jest.fn();
const mockSesSend = jest.fn();
let cognitoConstructorThrows = false;

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockChimeSend })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListTags', input })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListMemberships', input })),
  DescribeChannelCommand: jest.fn().mockImplementation((input) => ({ __type: 'DescribeChannel', input })),
}), { virtual: true });

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn().mockImplementation(() => {
    if (cognitoConstructorThrows) throw new Error('cognito client could not be constructed');
    return { send: mockCognitoSend };
  }),
  AdminGetUserCommand: jest.fn().mockImplementation((input) => ({ __type: 'AdminGetUser', input })),
}), { virtual: true });

jest.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: jest.fn().mockImplementation(() => ({ send: mockSesSend })),
  SendEmailCommand: jest.fn().mockImplementation((input) => ({ __type: 'SendEmail', input })),
}), { virtual: true });

const POOL = 'us-east-1_AAAA';
const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/a/bot/atlas';
const PERSON = 'arn:aws:chime:us-east-1:1:app-instance/a/user/sarah';

const ADMIN_TAG = [{ Key: 'aeChannelKind', Value: 'admin-notifications' }];
const ORDINARY_TAGS = [{ Key: 'classification', Value: 'premium' }];

/** A Chime client that answers the two reads the fan-out makes. */
function chimeAnswering(tags: Array<{ Key: string; Value: string }>, memberIds: string[]) {
  return async (cmd: { __type: string }) => {
    if (cmd.__type === 'ListTags') return { Tags: tags };
    if (cmd.__type === 'ListMemberships') {
      return {
        ChannelMemberships: memberIds.map((id) => ({
          Member: { Arn: `arn:aws:chime:us-east-1:1:app-instance/a/user/${id}` },
        })),
      };
    }
    return {};
  };
}

/** A stream record of a bot message carrying a notify directive. */
function notifyMessage(over: Record<string, unknown> = {}) {
  return {
    EventType: 'CREATE_CHANNEL_MESSAGE',
    Payload: {
      MessageId: 'm1',
      ChannelArn: CHANNEL,
      Content: encodeURIComponent('A context source has stopped answering.'),
      Metadata: JSON.stringify({ notify: { email: true }, notifySubject: 'Context source alarm' }),
      Sender: { Arn: BOT },
      ...over,
    },
  };
}

async function loadRule(env: Record<string, string | undefined> = {}) {
  jest.resetModules();
  process.env.USER_POOL_ID = POOL;
  process.env.SENDER_EMAIL = 'assistant@verified.example.com';
  delete process.env.NOTIFY_ALLOWED_POOL_IDS;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../../lambda/src/lib/notify-on-delivery');
}

beforeEach(() => {
  jest.clearAllMocks();
  cognitoConstructorThrows = false;
  mockCognitoSend.mockImplementation(async (cmd: { input: { Username: string } }) => ({
    UserAttributes: [
      { Name: 'email', Value: `${cmd.input.Username}@example.com` },
      { Name: 'name', Value: cmd.input.Username },
    ],
  }));
  mockSesSend.mockResolvedValue({});
});

/**
 * THE CALLBACK IS NO LONGER BEHIND THE FAN-OUT.
 *
 * Asserted as the absence of the call from the flow rather than by timing it, which is the honest
 * form: the flow either awaits the fan-out before `callbackAllow` or it does not reference it at all,
 * and there is no third state to measure. Both directions are checked, so this fails if the fan-out
 * comes back to the flow AND if it never reaches the stream.
 */
describe('the person waits for the callback and nothing else', () => {
  const flow = fs.readFileSync(path.join(SRC, 'channel-flow-processor.ts'), 'utf8');

  it('the channel flow neither imports nor calls the notification fan-out', () => {
    expect(flow).not.toMatch(/from '\.\/lib\/channel-notify/);
    expect(flow).not.toMatch(/fanOutChannelNotification\(/);
    expect(flow).not.toMatch(/parseNotifyDirective\(/);
  });

  it('the email bridge on the stream runs the fan-out, and post-processing does not', () => {
    const bridge = fs.readFileSync(path.join(SRC, 'notification-bridge.ts'), 'utf8');
    // Called, not merely imported: an import nothing runs would be the same silence by a longer route.
    expect(bridge).toMatch(/await notifyOnDelivery\(message\)/);
    const pp = fs.readFileSync(path.join(SRC, 'message-post-processing.ts'), 'utf8');
    expect(pp).not.toMatch(/notifyOnDelivery/);
  });
});

describe('decideNotify: what the record alone settles', () => {
  it('an assistant message carrying a directive is fanned out, from the stored text', async () => {
    const { decideNotify } = await loadRule();
    const d = decideNotify(notifyMessage());
    expect(d.notify).toBe(true);
    if (!d.notify) throw new Error('unreachable');
    expect(d.channelArn).toBe(CHANNEL);
    expect(d.senderArn).toBe(BOT);
    // Decoded, so the email carries what a reader sees rather than a percent-encoded blob.
    expect(d.messageText).toBe('A context source has stopped answering.');
    expect(d.directive.subject).toBe('Context source alarm');
  });

  it('a person cannot send email to the room by writing a directive into their own message', async () => {
    const { decideNotify } = await loadRule();
    expect(decideNotify(notifyMessage({ Sender: { Arn: PERSON } })))
      .toEqual({ notify: false, reason: 'person-mentions-no-one' });
  });

  // Anyone's mention may send the one email, when the directive asks for email.
  it('a person\'s message that mentions someone and asks for email is fanned out, marked as theirs', async () => {
    const { decideNotify } = await loadRule();
    const d = decideNotify(notifyMessage({
      Sender: { Arn: PERSON },
      Content: encodeURIComponent('@<Marcus Lee|marcus> can you look at this?'),
    }));
    expect(d.notify).toBe(true);
    if (!d.notify) throw new Error('unreachable');
    expect(d.personSent).toBe(true);
  });

  it('a mention alone sends nothing: the directive must ask for email', async () => {
    const { decideNotify } = await loadRule();
    expect(decideNotify(notifyMessage({
      Sender: { Arn: PERSON },
      Content: encodeURIComponent('@<Marcus Lee|marcus> can you look at this?'),
      Metadata: undefined,
    }))).toEqual({ notify: false, reason: 'no-directive' });
  });

  it('an update is not a second notification', async () => {
    const { decideNotify } = await loadRule();
    // The flow's assistant pass ran on an updated bot message too, so an acknowledgment carrying a
    // directive and then overwritten with the answer could fan out twice. The stream says which.
    expect(decideNotify({ ...notifyMessage(), EventType: 'UPDATE_CHANNEL_MESSAGE' }))
      .toEqual({ notify: false, reason: 'not-a-new-message' });
  });

  it('ordinary assistant traffic is rejected without a single call', async () => {
    const { decideNotify } = await loadRule();
    expect(decideNotify(notifyMessage({ Metadata: JSON.stringify({ respPhase: 'notice' }) })))
      .toEqual({ notify: false, reason: 'no-directive' });
    expect(mockChimeSend).not.toHaveBeenCalled();
  });
});

describe('the fan-out still happens, and still only where it should', () => {
  it('an admin conversation emails its members, resolved live from membership and the IdP', async () => {
    mockChimeSend.mockImplementation(chimeAnswering(ADMIN_TAG, ['admin1']));
    const { notifyOnDelivery } = await loadRule();

    await notifyOnDelivery(notifyMessage());

    // NON-VACUITY: a real send, to an address resolved from the IdP, carrying the directive's
    // subject and the message's own text. A version of this rule that sent nothing would fail here
    // rather than passing the two "sends nothing" cases below.
    expect(mockSesSend).toHaveBeenCalledTimes(1);
    const sent = mockSesSend.mock.calls[0][0];
    expect(sent.input.Destination.ToAddresses).toEqual([expect.stringContaining('<admin1@example.com>')]);
    expect(sent.input.Content.Simple.Subject.Data).toBe('Context source alarm');
    expect(sent.input.Content.Simple.Body.Text.Data).toContain('A context source has stopped answering.');
    // The recipient list is read LIVE (tenet D7), not carried on the trigger.
    expect(mockChimeSend.mock.calls.some(([c]) => c.__type === 'ListMemberships')).toBe(true);
  });

  it('an ordinary conversation sends nothing, however its messages are tagged', async () => {
    mockChimeSend.mockImplementation(chimeAnswering(ORDINARY_TAGS, ['owner']));
    const { notifyOnDelivery } = await loadRule();

    await notifyOnDelivery(notifyMessage());

    expect(mockSesSend).not.toHaveBeenCalled();
    // Decided from the live tag, and nobody's contact is looked up once that answer is no.
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  it('a member is asked of the pool by the subject Identities names, never by their person id', async () => {
    // The person id is an opaque UUID v7 the pool has never heard of; their subject is reached through
    // the `byPerson` reverse lookup, and a member with no subject in a trusted pool is skipped.
    const person = '0192f0e0-0000-7000-8000-00000000abcd';
    const nobody = '0192f0e0-0000-7000-8000-00000000dead';
    mockChimeSend.mockImplementation(chimeAnswering(ADMIN_TAG, [person, nobody]));
    const { notifyOnDelivery } = await loadRule();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { subjectsOfPerson } = require('../../lambda/src/lib/person-identity');
    (subjectsOfPerson as jest.Mock).mockImplementation(async (arn: string) => (arn.endsWith(person)
      // This deployment's own pool, by its trusted-issuer registry id.
      ? [{ issuer: 'deployment', subject: 'admin1' }]
      : []));

    await notifyOnDelivery(notifyMessage());

    const asked = mockCognitoSend.mock.calls.map(([c]) => c.input.Username);
    expect(asked).toEqual(['admin1']);
    expect(mockSesSend.mock.calls[0][0].input.Destination.ToAddresses).toEqual([expect.stringContaining('<admin1@example.com>')]);
  });

  it('without a trusted issuer whose directory holds contacts (no pool here) the bridge is inert and reads nothing', async () => {
    mockChimeSend.mockImplementation(chimeAnswering(ADMIN_TAG, ['admin1']));
    const { notifyOnDelivery } = await loadRule({ USER_POOL_ID: undefined });

    await notifyOnDelivery(notifyMessage());

    expect(mockChimeSend).not.toHaveBeenCalled();
    expect(mockSesSend).not.toHaveBeenCalled();
  });
});

describe('a failed notification is survivable, and is counted', () => {
  it('a fan-out that rejects does not propagate, so nothing behind it stalls', async () => {
    mockChimeSend.mockImplementation(chimeAnswering(ADMIN_TAG, ['admin1']));
    cognitoConstructorThrows = true;
    const { notifyOnDelivery } = await loadRule();

    // A throw on a Kinesis rule stalls the shard for every message behind it, and before the move it
    // would have been a throw inside the channel flow's assistant pass.
    await expect(notifyOnDelivery(notifyMessage())).resolves.toBeUndefined();
  });

  it('a send failure is counted, because nothing else reports it', async () => {
    mockChimeSend.mockImplementation(chimeAnswering(ADMIN_TAG, ['admin1']));
    mockSesSend.mockRejectedValue(new Error('AccessDenied'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { notifyOnDelivery } = await loadRule();

    await notifyOnDelivery(notifyMessage());

    // The fan-out collects send failures rather than throwing and its caller never surfaced them, so
    // this metric is the only place a failed notification is visible at all (ADR-032 tenet 6).
    const emitted = log.mock.calls
      .map(([line]) => (typeof line === 'string' ? line : ''))
      .filter((line) => line.includes('"AgentEchelon/Notifications"'));
    expect(emitted.join('')).toContain('"Failed"');
    log.mockRestore();
  });
});
