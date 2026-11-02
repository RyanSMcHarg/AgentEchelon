/**
 * THE ADMIN NOTIFICATION CHANNEL'S PRIMARY IS THE ADMIN ASSISTANT (ADR-062 decision 6).
 *
 * The admin channel resolves its primary like every room: its `primaryAssistant` tag, read through
 * `primaryAssistantOf`, names the Admin Assistant, whose own AppInstanceBot speaks for it. The service app-instance
 * admin is a service user with app-instance-admin access that adds members; it is never the room's speaker. An email
 * copied from the room carries the Admin Assistant's name and words with no fault logged.
 */
jest.unmock('../../lambda/src/lib/conversation-primary');
jest.unmock('../../lambda/src/lib/email-copy');

const mockSsmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: mockSsmSend })) };
});
const mockTags: Record<string, Record<string, string>> = {};
jest.mock('../../lambda/src/lib/chime/clients', () => ({
  chimeMessagingClient: () => ({
    send: async (cmd: { input: { ResourceARN: string } }) => ({
      Tags: Object.entries(mockTags[cmd.input.ResourceARN] || {}).map(([Key, Value]) => ({ Key, Value })),
    }),
  }),
}));
const mockResolveActiveProfile = jest.fn(async (name: string) => ({
  displayName: name === 'admin-agent' ? 'Admin Assistant' : `${name} name`, copy: undefined, messages: undefined,
}));
jest.mock('../../lambda/src/lib/active-profile', () => ({
  resolveActiveProfile: (name: string) => mockResolveActiveProfile(name),
}));

import { emailVoiceForRoom, __clearEmailVoiceCache } from '../../lambda/src/lib/email-copy';
import { primaryAssistantOf, PRIMARY_TAG, __resetRoomPrimaryCache } from '../../lambda/src/lib/conversation-primary';
import { __resetAssistantCacheForTests } from '../../lambda/src/lib/default-agents';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1';
const ADMIN_ROOM = `${APP}/channel/admin-notifications`;
const MEMBER_ROOM = `${APP}/channel/room-1`;
const ADMIN_AGENT_BOT = `${APP}/bot/admin-agent`;
const SERVICE_ADMIN = `${APP}/user/ae-admin`;
const ADVISOR = `${APP}/bot/advisor-bot`;
const ADMIN = profiles.adminPlaneValues()[0];
const ADMIN_AGENT = profiles.requireProfileFor(ADMIN).name;

const records: Record<string, Array<Record<string, unknown>>> = {
  // The admin assistant's own record, as its seed writes it (`admin-services-stack.ts`).
  [ADMIN]: [{ assistant: ADMIN_AGENT, role: 'primary', botArn: ADMIN_AGENT_BOT, occupancy: 'live' }],
  premium: [{ assistant: 'advisor', role: 'primary', botArn: ADVISOR, occupancy: 'live' }],
};

let err: jest.SpyInstance;
let warn: jest.SpyInstance;
beforeEach(() => {
  process.env.ADMIN_USER_ARN = SERVICE_ADMIN;
  process.env.ADMIN_BEARER_ARN = SERVICE_ADMIN;
  mockSsmSend.mockReset();
  mockSsmSend.mockImplementation(async (cmd: { input: { Path?: string } }) => {
    const classification = (cmd.input.Path || '').split('/assistant-assignments/')[1] || '';
    return { Parameters: (records[classification] || []).map((r) => ({ Value: JSON.stringify(r) })) };
  });
  mockResolveActiveProfile.mockClear();
  __resetAssistantCacheForTests();
  __resetRoomPrimaryCache();
  __clearEmailVoiceCache();
  mockTags[ADMIN_ROOM] = { classification: ADMIN, aeChannelKind: 'admin-notifications', [PRIMARY_TAG]: ADMIN_AGENT };
  mockTags[MEMBER_ROOM] = { classification: 'premium', [PRIMARY_TAG]: 'advisor' };
  err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  err.mockRestore();
  warn.mockRestore();
});

const tagReader = { send: async (cmd: { input: { ResourceARN: string } }) => ({
  Tags: Object.entries(mockTags[cmd.input.ResourceARN] || {}).map(([Key, Value]) => ({ Key, Value })),
}) };

describe('the admin plane room', () => {
  it("an admin-channel email names the admin assistant, in the admin assistant's words, and logs no fault", async () => {
    const voice = await emailVoiceForRoom(ADMIN_ROOM);
    expect(voice.assistantName).toBe('Admin Assistant');
    expect(mockResolveActiveProfile).toHaveBeenCalledWith(ADMIN_AGENT);
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("its primary is the admin assistant's own bot, read from its tag, never the service app-instance admin", async () => {
    const primary = await primaryAssistantOf(ADMIN_ROOM, tagReader as never);
    expect(primary).toEqual({ assistant: ADMIN_AGENT, botArn: ADMIN_AGENT_BOT, classification: ADMIN, source: 'tag' });
    expect(primary.botArn).not.toBe(SERVICE_ADMIN);
    expect(primary.botArn).toMatch(/\/bot\//);
    expect(err).not.toHaveBeenCalled();
    expect(String(err.mock.calls)).not.toContain('PrimaryAssistantFault');
  });
});

describe('a member conversation', () => {
  it('resolves its primary through the same resolver', async () => {
    const primary = await primaryAssistantOf(MEMBER_ROOM, tagReader as never);
    expect(primary).toEqual({ assistant: 'advisor', botArn: ADVISOR, classification: 'premium', source: 'tag' });
    const voice = await emailVoiceForRoom(MEMBER_ROOM);
    expect(mockResolveActiveProfile).toHaveBeenCalledWith('advisor');
    expect(voice.assistantName).toBe('advisor name');
    expect(err).not.toHaveBeenCalled();
  });
});
