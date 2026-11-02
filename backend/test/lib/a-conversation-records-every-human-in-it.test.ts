/**
 * A CONVERSATION RECORDS EVERY HUMAN IN IT, NOT ONLY THE ONE WHO CAUSED IT.
 *
 * The participant shape is derived from how many humans are in a conversation: one reads `single`,
 * several read `group`, and `onboardingApplies` only fires on `single` because a group has no one person
 * to key the gate on. The shape's own contract is that it "carries who is IN the conversation and never
 * who triggered it".
 *
 * ── THE DEFECT THIS PINS ─────────────────────────────────────────────────────────────────────────
 *
 * `createConversationFromDrift` was written for the drift case, which has exactly one human - the person
 * who accepted the suggestion - so it recorded that one human and the two lookups collapsed into one.
 * But `conversation-split.ts` passes `additionalMemberArns: await carryTheRoom()` for a non-private
 * topic, so a split that carries the room wrote `single` for a conversation containing several people.
 * Two consequences, both silent:
 *
 *   - the onboarding gate keyed on the requester, onboarding a group as though it were a 1:1;
 *   - the federated issuer hint was carried for the requester alone, so the notification fan-out resolved
 *     every other human against the default pool, failed, and skipped them. That is the exact failure the
 *     function's own comment describes, one member over.
 *
 * Nothing asserted the old behavior, which is why it survived. These cases are the guard it lacked.
 */
const mockMessagingSend = jest.fn();
const mockSsmSend = jest.fn();
const mockPutChannelContext = jest.fn();
const mockGetChannelContext = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  // The origin conversation's tag read, answered beside the recorded
  // calls so the order asserted below is unchanged: the origin is premium, as the creation is.
  ChimeSDKMessagingClient: jest.fn(() => ({
    send: (cmd: { __type: string }) => (cmd.__type === 'ListTags'
      ? Promise.resolve({ Tags: [{ Key: 'classification', Value: 'premium' }] })
      : mockMessagingSend(cmd)),
  })),
  ListTagsForResourceCommand: jest.fn((input: unknown) => ({ __type: 'ListTags', input })),
  CreateChannelCommand: jest.fn((input: unknown) => ({ __type: 'CreateChannel', input })),
  CreateChannelMembershipCommand: jest.fn((input: unknown) => ({ __type: 'CreateMembership', input })),
  CreateChannelModeratorCommand: jest.fn((input: unknown) => ({ __type: 'CreateModerator', input })),
  AssociateChannelFlowCommand: jest.fn((input: unknown) => ({ __type: 'AssociateFlow', input })),
  SendChannelMessageCommand: jest.fn((input: unknown) => ({ __type: 'SendMessage', input })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn((input: unknown) => ({ __type: 'GetParameter', input })),
}), { virtual: true });

jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  putChannelContext: (...a: unknown[]) => mockPutChannelContext(...a),
  getChannelContext: (...a: unknown[]) => mockGetChannelContext(...a),
}));

import { createConversationFromDrift } from '../../lambda/src/lib/channel-creation';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/app';
const user = (sub: string) => `${APP}/user/${sub}`;
const PARENT = `${APP}/channel/parent-1`;

/** The context written for the new conversation, which is what the welcome and the fan-out read. */
const writtenContext = () => mockPutChannelContext.mock.calls[0][1] as Record<string, unknown>;

const create = (over: Record<string, unknown> = {}) =>
  createConversationFromDrift({
    creatorBearerArn: `${APP}/user/service-admin`,
    appInstanceArn: APP,
    botArn: `${APP}/bot/advisor`,
    userArn: user('requester'),
    modelTier: 'premium',
    modelId: 'm',
    modelName: 'M',
    topicLabel: 'the thing',
    parentChannelArn: PARENT,
    originatingMessageId: 'msg-1',
    ...over,
  } as Parameters<typeof createConversationFromDrift>[0]);

beforeEach(() => {
  jest.clearAllMocks();
  mockMessagingSend.mockResolvedValue({ ChannelArn: `${APP}/channel/new-1` });
  mockGetChannelContext.mockResolvedValue(null);
});

describe('the participant shape follows the humans actually in the conversation', () => {
  it('reads single when one person is in it, which is the drift case', async () => {
    await create();
    expect(writtenContext().participants).toEqual(
      expect.objectContaining({ focus: 'single', subject: 'requester' }),
    );
  });

  it('reads GROUP when the room is carried, which is what a split does', async () => {
    // The regression: this wrote `single` and named the requester as the subject, so a room of four was
    // recorded as a 1:1 and the onboarding gate keyed on whoever asked.
    await create({ additionalMemberArns: [user('second'), user('third')] });
    const p = writtenContext().participants as { focus: string; humans: string[]; subject: string };
    expect(p.focus).toBe('group');
    expect(p.humans).toEqual(expect.arrayContaining(['requester', 'second', 'third']));
    // A group has no single subject to onboard, and asserting the emptiness is the point: a non-empty
    // subject here is what would let the onboarding gate fire on one member of a room.
    expect(p.subject).toBe('');
  });

  it('never counts an assistant as a human', async () => {
    // Agents are added separately. If a bot ARN reached the human list, a 1:1 would read `group` and
    // onboarding would stop firing for every ordinary conversation.
    await create();
    const p = writtenContext().participants as { humans: string[] };
    expect(p.humans).toEqual(['requester']);
  });
});

describe('the federated issuer hint is carried for every human', () => {
  it('carries all of them, not only the creator', async () => {
    // Without this, fan-out resolves the others against the default pool, fails, and skips them - so a
    // notification conversation notifies one person out of four and reports success.
    // A member recorded under an issuer subject is matched to the person that subject resolves to through
    // Identities (this suite's resolver answers the person whose id is the subject).
    const ISS = 'https://idp.example';
    // The issuer, declared in the trusted-issuer registry; an undeclared one resolves to nobody.
    process.env.TRUSTED_ISSUERS = JSON.stringify([
      { id: 'idp', kind: 'oidc', iss: ISS, subject: ['sub'], clearance: { fixed: ['basic'], classifications: ['basic'] }, admin: false, groupsClaim: 'groups' },
    ]);
    mockGetChannelContext.mockResolvedValue({
      memberIdentities: [
        { sub: 'requester-raw', iss: ISS },
        { sub: 'second-raw', iss: ISS },
        { sub: 'unrelated-raw', iss: ISS },
      ],
    });
    await create({
      userArn: user('requester-raw'),
      additionalMemberArns: [user('second-raw')],
    });
    const carried = writtenContext().memberIdentities as Array<{ sub: string }>;
    expect(carried.map((c) => c.sub).sort()).toEqual(['requester-raw', 'second-raw']);
    delete process.env.TRUSTED_ISSUERS;
  });

  it('carries nobody the conversation does not contain', async () => {
    // The parent's roster is a superset. Copying it wholesale would name people who are not in the new
    // conversation, which is a disclosure rather than a convenience.
    mockGetChannelContext.mockResolvedValue({
      memberIdentities: [{ sub: 'somebody-else', iss: 'https://idp.example' }],
    });
    await create();
    expect(writtenContext().memberIdentities).toBeUndefined();
  });
});
