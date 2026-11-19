/**
 * A TEAM ROOM THAT STOPPED PART WAY IS COMPLETED WHEN IT IS NEXT ASKED FOR (SPEC-WORKFLOWS-AND-TASKS WT121).
 *
 * A team room's id is fixed and it is created once, so a creation that stopped after `CreateChannel` is only ever seen again
 * through `ConflictException`. A room whose first member add was refused would otherwise answer every later attach with
 * "reused" for a room with nobody in it. So each later ask completes the room: the flow first, then the primary and the lead as moderators, the people and the assistants the type names,
 * each add tolerating the already-there answer, and an assistant that cannot be added failing it, as it fails a creation.
 */
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: (cmd: unknown) => mockSend(cmd) })),
  DescribeChannelCommand: jest.fn((input: unknown) => ({ __type: 'Describe', input })),
  AssociateChannelFlowCommand: jest.fn((input: unknown) => ({ __type: 'AssociateFlow', input })),
  CreateChannelMembershipCommand: jest.fn((input: unknown) => ({ __type: 'Membership', input })),
  CreateChannelModeratorCommand: jest.fn((input: unknown) => ({ __type: 'Moderator', input })),
  ListTagsForResourceCommand: jest.fn((input: unknown) => ({ __type: 'ListTags', input })),
}), { virtual: true });

import { completeTeamRoom } from '../../lambda/src/lib/channel-creation';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/app';
const ROOM = `${APP}/channel/team-ops-team-premium`;
const ADMIN = `${APP}/user/service-admin`;
const PRIMARY = `${APP}/bot/advisor`;
const OPS = `${APP}/bot/ops`;
const LEAD = `${APP}/user/lead`;
const OTHER = `${APP}/user/other`;
const conflict = () => Object.assign(new Error('already a member'), { name: 'ConflictException' });
const calls = () => mockSend.mock.calls.map(([c]) => `${c.__type}:${String(c.input.MemberArn ?? c.input.ChannelModeratorArn ?? c.input.ChannelFlowArn ?? '').split('/').pop()}`);
const input = { channelArn: ROOM, primaryBotArn: PRIMARY, leadArn: LEAD, memberArns: [LEAD, OTHER], agentBotArns: [PRIMARY, OPS], roleModerators: [], bearerArn: ADMIN, channelFlowArn: `${APP}/channel-flow/flow` };

beforeEach(() => mockSend.mockReset());

describe('a team room that stopped part way', () => {
  it('gets its flow before anyone, then its primary and lead as moderators, its people and its type\'s assistants', async () => {
    mockSend.mockImplementation(async (c: { __type: string }) => (c.__type === 'Describe' ? { Channel: {} } : {}));
    await completeTeamRoom(input);
    expect(calls()).toEqual([
      'Describe:', 'AssociateFlow:flow',
      'Membership:advisor', 'Moderator:advisor', 'Membership:lead', 'Moderator:lead',
      'Membership:other', 'Membership:ops',
    ]);
    for (const [c] of mockSend.mock.calls) expect(c.input.ChimeBearer).toBe(ADMIN);
  });

  it('is complete already: every add answers already-there and nothing fails', async () => {
    mockSend.mockImplementation(async (c: { __type: string }) => {
      if (c.__type === 'Describe') return { Channel: { ChannelFlowArn: 'flow' } };
      throw conflict();
    });
    await expect(completeTeamRoom(input)).resolves.toBeUndefined();
    expect(calls()).not.toContain('AssociateFlow:flow');
  });

  it('fails when an assistant cannot be added, and only logs a person who cannot', async () => {
    const refused = () => Object.assign(new Error('not authorized'), { name: 'ForbiddenException' });
    mockSend.mockImplementation(async (c: { __type: string; input: { MemberArn?: string } }) => {
      if (c.__type === 'Describe') return { Channel: { ChannelFlowArn: 'flow' } };
      if (c.input.MemberArn === OTHER) throw refused();
      if (c.input.MemberArn === OPS) throw refused();
      return {};
    });
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(completeTeamRoom(input)).rejects.toThrow('not authorized');
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('could not carry a member into the team room'), expect.anything());
    logged.mockRestore();
  });
});

/**
 * A HANDOVER NEVER BLOCKS AN ATTACH. Opening a team room needs its one lead; completing a standing one does not, so
 * while the on-call role has no single holder the room is completed with everyone else, and only a room that does not stand is
 * refused with the lead's reason.
 */
describe('a team room whose lead role has no single holder', () => {
  it('is completed without a lead: the primary and the type\'s assistants and people, and no empty member', async () => {
    mockSend.mockImplementation(async (c: { __type: string }) => (c.__type === 'Describe' ? { Channel: { ChannelFlowArn: 'flow' } } : {}));
    await completeTeamRoom({ ...input, leadArn: '' });
    expect(calls()).toEqual(['Describe:', 'Membership:advisor', 'Moderator:advisor', 'Membership:lead', 'Membership:other', 'Membership:ops']);
    expect(mockSend.mock.calls.some(([c]) => c.input.MemberArn === '' || c.input.ChannelModeratorArn === '')).toBe(false);
  });

  it('the creator completes a standing room without its lead, and refuses to open a new one without it', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const creator = require('fs').readFileSync(require('path').resolve(__dirname, '../../lambda/src/typed-conversation-from-event.ts'), 'utf8') as string;
    expect(creator).toMatch(/soleHolderOf\(detail\.conversationType, detail\.forRole\)\.catch\(async \(err\) => \{\s*if \(!detail\.teamRoom\) throw err;\s*await completeTeamRoomWithoutLead/);
    const leadless = creator.slice(creator.indexOf('async function completeTeamRoomWithoutLead'), creator.indexOf('/** Hand the run that asked'));
    expect(leadless).toMatch(/if \(!\(await channelStands\(channelArn, bearerArn\)\)\) throw leadErr;/);
    expect(leadless).toContain("leadArn: ''");
  });
});

describe('whether a channel stands', () => {
  it('reads a channel never created, which Amazon Chime SDK answers as forbidden, as not standing, and throws anything else', async () => {
    const { channelStands } = await import('../../lambda/src/lib/channel-creation');
    mockSend.mockResolvedValueOnce({ Channel: {} });
    await expect(channelStands(ROOM, ADMIN)).resolves.toBe(true);
    for (const name of ['NotFoundException', 'ForbiddenException']) {
      mockSend.mockRejectedValueOnce(Object.assign(new Error(name), { name }));
      await expect(channelStands(ROOM, ADMIN)).resolves.toBe(false);
    }
    mockSend.mockRejectedValueOnce(Object.assign(new Error('slow down'), { name: 'ThrottledClientException' }));
    await expect(channelStands(ROOM, ADMIN)).rejects.toThrow('slow down');
  });
});
