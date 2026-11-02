/**
 * THE ADMIN NOTIFICATION CHANNEL'S THREE IDENTITIES STAY DISTINCT.
 *
 * The first version of this path created and posted as the service app-instance-admin, and that
 * identity cannot legitimately post: a `SendChannelMessage` by it to a RESTRICTED, PRIVATE channel it
 * is not a member of is refused (verified live, `ForbiddenException`). It looked provisioned and was
 * discovered only when an alert was owed - so the failure is invisible right up to the moment it
 * matters, which is what a test is for.
 *
 * The rule, from DESIGN-ADMIN-AGENT-NOTIFICATIONS:
 *
 *   - The ADMIN ASSISTANT's bot CREATES the channel, which makes it the moderator and the only identity
 *     that may post into it.
 *   - The SERVICE app-instance-admin is borrowed for `CreateChannelMembership` only, because bots
 *     cannot call it, and NEVER becomes a member.
 *   - HUMAN ADMINS are the members.
 *
 * The last of those is the one worth a test of its own: making the service admin a member would make
 * the alerts work, which is exactly why somebody would do it.
 */

const mockChimeSend = jest.fn();
const mockCognitoSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: (...a: unknown[]) => mockChimeSend(...a) })),
  CreateChannelCommand: class { __t = 'CreateChannel'; constructor(public input: any) {} },
  CreateChannelMembershipCommand: class { __t = 'CreateMembership'; constructor(public input: any) {} },
  UpdateChannelCommand: class { __t = 'UpdateChannel'; constructor(public input: any) {} },
  DeleteChannelCommand: class { __t = 'DeleteChannel'; constructor(public input: any) {} },
  DescribeChannelCommand: class { __t = 'DescribeChannel'; constructor(public input: any) {} },
  TagResourceCommand: class { __t = 'TagResource'; constructor(public input: any) {} },
  CreateChannelModeratorCommand: class { __t = 'CreateModerator'; constructor(public input: any) {} },
  DeleteChannelMembershipCommand: class { __t = 'DeleteMembership'; constructor(public input: any) {} },
}));
// THE ROOM'S PRIMARY, through the one resolver every creator uses; its own reads are covered with it.
const mockPrimaryTagFor = jest.fn(async (_classification: string, _botArn: string) => ({ Key: 'primaryAssistant', Value: 'admin-agent' }));
jest.mock('../lambda/src/lib/conversation-primary', () => ({
  ...jest.requireActual('../lambda/src/lib/conversation-primary'),
  primaryTagFor: (c: string, b: string) => mockPrimaryTagFor(c, b),
}));
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: (...a: unknown[]) => mockCognitoSend(...a) })),
  ListUsersInGroupCommand: class { __t = 'ListUsersInGroup'; constructor(public input: any) {} },
}));

const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
const SERVICE_ADMIN = `${APP}/user/agent-echelon-admin`;
const AGENT_BOT = `${APP}/bot/admin-agent`;
const CHANNEL = `${APP}/channel/c1`;
const ADMIN_A = '11111111-0000-4000-8000-00000000aaaa';
const ADMIN_B = '22222222-0000-4000-8000-00000000bbbb';

// ── SET BEFORE THE IMPORT, AND PUT BACK AFTERWARDS ──────────────────────────────────────────────
//
// The provisioner reads these into module-level consts, so they have to exist before the require
// below. But process.env is shared by every test file jest runs in the same WORKER, and leaving
// APP_INSTANCE_ARN and USER_POOL_ID behind made cdk-synth.test.ts fail when the two happened to be
// scheduled together - a failure with nothing to do with either file, which is the worst kind.
const SAVED_ENV = { ...process.env };
process.env.APP_INSTANCE_ARN = APP;
process.env.ADMIN_BEARER_ARN = SERVICE_ADMIN;
process.env.ADMIN_AGENT_BOT_ARN = AGENT_BOT;
process.env.USER_POOL_ID = 'us-east-1_test';
process.env.ADMIN_GROUP_NAME = 'admins';

afterAll(() => {
  process.env = SAVED_ENV;
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/src/admin-notification-channel-provision');

const callsOf = (t: string) => mockChimeSend.mock.calls.map((c) => c[0]).filter((c) => c.__t === t);

beforeEach(() => {
  mockChimeSend.mockReset();
  mockCognitoSend.mockReset();
  mockCognitoSend.mockResolvedValue({
    Users: [
      { Attributes: [{ Name: 'sub', Value: ADMIN_A }] },
      { Attributes: [{ Name: 'sub', Value: ADMIN_B }] },
    ],
  });
  mockChimeSend.mockImplementation(async (cmd: any) =>
    cmd.__t === 'CreateChannel' ? { ChannelArn: CHANNEL } : {});
});

describe('provisioning the admin notification channel', () => {
  it('creates the channel as the ADMIN ASSISTANT, not as the service admin', async () => {
    await handler({ RequestType: 'Create' } as never);

    const [create] = callsOf('CreateChannel');
    expect(create).toBeTruthy();
    // The creator is the moderator, and the moderator is the only identity that may post here.
    expect(create.input.ChimeBearer).toBe(AGENT_BOT);
    expect(create.input.Mode).toBe('RESTRICTED');
    expect(create.input.Privacy).toBe('PRIVATE');
  });

  it('adds members as the service admin, because a bot cannot', async () => {
    await handler({ RequestType: 'Create' } as never);

    const adds = callsOf('CreateMembership');
    expect(adds).toHaveLength(2);
    for (const add of adds) {
      expect(add.input.ChimeBearer).toBe(SERVICE_ADMIN);
    }
    expect(adds.map((a) => a.input.MemberArn).sort())
      .toEqual([`${APP}/user/${ADMIN_A}`, `${APP}/user/${ADMIN_B}`].sort());
  });

  it('NEVER makes the service admin a member', async () => {
    // ── THE RULE THIS EXISTS FOR ────────────────────────────────────────────────────────────────
    //
    // Adding it would make a post by it succeed, which is precisely why somebody would reach for it.
    // It is the cross-channel administration identity: it reads and moderates WITHOUT membership, and
    // as an email recipient it would be wrong - the fan-out resolves recipients from live membership,
    // so a service account in the roster becomes an address the platform tries to mail.
    await handler({ RequestType: 'Create' } as never);

    const members = callsOf('CreateMembership').map((c) => c.input.MemberArn);
    expect(members).not.toContain(SERVICE_ADMIN);
    expect(members.some((m: string) => m.includes('agent-echelon-admin'))).toBe(false);
  });

  it('stamps the roster as the bot, and the roster is a record rather than a recipient list', async () => {
    await handler({ RequestType: 'Create' } as never);

    const [update] = callsOf('UpdateChannel');
    expect(update.input.ChimeBearer).toBe(AGENT_BOT);
    const meta = JSON.parse(update.input.Metadata);
    expect(meta.kind).toBe('admin-notifications');
    expect(meta.participants.sort()).toEqual([ADMIN_A, ADMIN_B].sort());
    // The stamp holds SUBS, never the service account: it records who was provisioned.
    expect(meta.participants).not.toContain('agent-echelon-admin');
  });

  it('creates the channel naming the ADMIN ASSISTANT as its primary, in the same call as its classification', async () => {
    // Every room names its primary at creation, and this one's is the admin assistant: the admin notices are its
    // templates (ADR-062 decision 6). Without the tag every email from this room logged a primary-assistant fault.
    mockPrimaryTagFor.mockClear();
    await handler({ RequestType: 'Create' } as never);
    expect(mockPrimaryTagFor).toHaveBeenCalledWith('admin', AGENT_BOT);
    const [create] = callsOf('CreateChannel');
    expect(create.input.Tags).toEqual(expect.arrayContaining([
      { Key: 'primaryAssistant', Value: 'admin-agent' },
      { Key: 'classification', Value: 'admin' },
    ]));
  });

  it('creates no channel when the admin plane has no live primary assistant', async () => {
    mockPrimaryTagFor.mockRejectedValueOnce(Object.assign(new Error('no primary'), { name: 'RoomHasNoPrimary' }));
    await expect(handler({ RequestType: 'Create' } as never)).rejects.toThrow(/no primary/);
    expect(callsOf('CreateChannel')).toHaveLength(0);
  });

  it('refuses to provision at all without the agent identity', async () => {
    // FAILS THE DEPLOY rather than falling back to the service admin. A channel created by the wrong
    // identity looks provisioned and cannot be posted to - the exact failure this rework ends - and
    // would be found only when an alert was owed.
    const saved = process.env.ADMIN_AGENT_BOT_ARN;
    delete process.env.ADMIN_AGENT_BOT_ARN;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fresh = require('../lambda/src/admin-notification-channel-provision');

    await expect(fresh.handler({ RequestType: 'Create' } as never)).rejects.toThrow(/ADMIN_AGENT_BOT_ARN/);

    process.env.ADMIN_AGENT_BOT_ARN = saved;
    jest.resetModules();
  });
});

describe('migrating a deployment whose channel the agent does not own', () => {
  // ── WHY THE CHANNEL IS ADOPTED AND NOT REPLACED ─────────────────────────────────────────────
  //
  // A channel provisioned by the previous version was created by the service app-instance-admin, so
  // the agent can neither post into it nor update it. Making a new one the agent owns is the
  // obvious fix and CANNOT WORK: the channel ARN is a cross-stack export consumed by the analytics
  // stack and every classification stack. Both routes were tried against CloudFormation and both
  // were refused - renaming the construct gives "Cannot delete export ... as it is in use", and
  // returning a different ARN gives "Cannot update export ... as it is in use".
  //
  // So the authority moves instead of the channel, and these pin that end state: the agent may
  // speak in the channel, the service admin is not a member of it, and the ARN never changes.

  const describeAs = (creator: string) => {
    mockChimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.__t === 'DescribeChannel') return { Channel: { CreatedBy: { Arn: creator } } };
      if (cmd.__t === 'CreateChannel') return { ChannelArn: `${APP}/channel/NEW` };
      return {};
    });
  };

  it('keeps the channel ARN, because other stacks import it', async () => {
    describeAs(SERVICE_ADMIN);

    const out: any = await handler({ RequestType: 'Update', PhysicalResourceId: CHANNEL } as never);

    expect(out.PhysicalResourceId).toBe(CHANNEL);
    expect(callsOf('CreateChannel')).toHaveLength(0);
    expect(callsOf('DeleteChannel')).toHaveLength(0);
  });

  it('makes the agent a member AND a moderator of it', async () => {
    // Membership is what lets it SEND into a RESTRICTED channel; moderation is what lets it UPDATE
    // the channel. Creating a channel confers both, and an adopted one has to be granted both.
    describeAs(SERVICE_ADMIN);

    await handler({ RequestType: 'Update', PhysicalResourceId: CHANNEL } as never);

    const asMember = callsOf('CreateMembership').find((c) => c.input.MemberArn === AGENT_BOT);
    expect(asMember).toBeTruthy(); // the agent is added as a member
    expect(asMember.input.ChimeBearer).toBe(SERVICE_ADMIN);

    const [mod] = callsOf('CreateModerator');
    expect(mod).toBeTruthy(); // the agent is promoted to moderator
    expect(mod.input.ChannelModeratorArn).toBe(AGENT_BOT);
    expect(mod.input.ChimeBearer).toBe(SERVICE_ADMIN);
  });

  it('takes the service admin OUT of the membership it acquired by creating the channel', async () => {
    // The design is explicit that it must never be a member: it reads and moderates across channels
    // WITHOUT membership, and as a member it is also an address the email fan-out would resolve.
    describeAs(SERVICE_ADMIN);

    await handler({ RequestType: 'Update', PhysicalResourceId: CHANNEL } as never);

    const [removed] = callsOf('DeleteMembership');
    expect(removed).toBeTruthy(); // the service admin is removed
    expect(removed.input.MemberArn).toBe(SERVICE_ADMIN);
  });

  it('stamps an existing channel with the admin assistant as its primary, beside its classification', async () => {
    // A channel provisioned before the tag existed gets it on the next deploy: every deploy is an Update.
    describeAs(`${APP}/bot/admin-agent`);
    await handler({ RequestType: 'Update', PhysicalResourceId: CHANNEL } as never);
    const [tag] = callsOf('TagResource');
    expect(tag.input.ResourceARN).toBe(CHANNEL);
    expect(tag.input.Tags).toEqual(expect.arrayContaining([
      { Key: 'primaryAssistant', Value: 'admin-agent' },
      { Key: 'classification', Value: 'admin' },
    ]));
  });

  it('REFUSES to invent a replacement when the recorded channel is gone', async () => {
    // ── THE MISTAKE THIS LOCKS OUT, WHICH WAS MADE ────────────────────────────────────────────
    //
    // Falling through to create a new channel here looks like healing and is not: an unreadable
    // channel reads the same as a throttle or a revoked bearer, and a new one moves the admins off
    // the channel holding every alert they have been sent. An update has one default outcome - the
    // ARN it was handed - and replacing it takes the operator's explicit flag.
    mockChimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.__t === 'DescribeChannel') throw Object.assign(new Error('gone'), { name: 'NotFoundException' });
      if (cmd.__t === 'CreateChannel') return { ChannelArn: `${APP}/channel/NEW` };
      return {};
    });

    await expect(handler({ RequestType: 'Update', PhysicalResourceId: CHANNEL } as never))
      .rejects.toThrow(/cannot be read/);

    // And it created nothing on the way out.
    expect(callsOf('CreateChannel')).toHaveLength(0);
  });
});
describe('an alert is an event, and only the admin backend posts it', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

  it('gives the core an events:PutEvents grant for ae.alert, and no channel, bearer or parameter', () => {
    // ── THE COUPLING THIS REMOVED ─────────────────────────────────────────────────────────────
    //
    // The channel ARN reached the core first as a CloudFormation export (which made the channel
    // unreplaceable), then as SSM parameter names read at runtime, with a send grant on the tagged
    // channel bearing the admin assistant. Either way a core stack knew the admin channel. Now an alert is a
    // fact on the default bus and the core names nothing of the admin backend.
    const common = read('lib/stacks/agent-classification-common.ts');
    const wiring = common.slice(common.indexOf('export function alertEmitterWiring('), common.indexOf('export const ALERT_SOURCE'));
    expect(wiring).toContain("actions: ['events:PutEvents']");
    expect(wiring).toContain("'events:source': [ALERT_SOURCE]");
    expect(wiring).not.toMatch(/SendChannelMessage|adminNotificationChannelArn|adminAgentBotArn|aeChannelKind/);
    expect(common).not.toContain('export function adminErrorAlertWiring(');
  });

  it('posts from one rule, in AdminServices, into its own channel as its own agent', () => {
    const stack = read('lib/stacks/admin-services-stack.ts');
    expect(stack).toContain('eventPattern: { source: [ALERT_SOURCE], detail: { instance: [INSTANCE_NAME] } }');
    expect(stack).toContain('resources: [notification.channelArn],');
    expect(stack).toContain("conditions: { StringEquals: { 'aws:ResourceTag/classification': profiles.adminPlaneValues() } },");
  });

  it('publishes the channel ARN to SSM for scripts and exports it to no stack', () => {
    const stack = read('lib/stacks/admin-services-stack.ts');
    expect(stack).toContain('parameterName: INSTANCE_SSM.adminNotificationChannelArn');
    expect(stack).not.toMatch(/exportName: `\$\{this\.stackName\}-AdminNotificationChannelArn`/);
    // And nothing plumbs a channel into the core: the deployer-named channel key is retired.
    const bin = read('bin/backend.ts');
    expect(bin).not.toContain('adminNotificationChannelArn');
    expect(bin).not.toContain("tryGetContext('membershipAuditAlertChannelArn')");
  });

  it('the membership audit alerts through the admin-notice path while still moderating as the service admin', () => {
    const audit = read('lambda/src/membership-audit.ts');
    // The alert goes through the one admin-notice path, which raises an ae.alert.
    expect(audit).toContain('postAdminNotice(');
    expect(audit).not.toContain('SendChannelMessageCommand');
    // The sweep and the revoke keep the admin identity, which acts without membership by design.
    expect(audit).toContain('ChimeBearer: adminArn');
    // And an alert that cannot be raised degrades to log-only rather than failing the audit: losing the
    // announcement must not cost the security control.
    expect(audit).toContain('logging it instead');
  });

  it('the membership audit reports what the revoke did, after it ran', () => {
    const audit = read('lambda/src/membership-audit.ts');
    const handler = audit.slice(audit.indexOf('async function handleViolation('));
    // The revoke comes first, and the alert names its outcome, so a failed revoke is never announced as done.
    expect(handler.indexOf('DeleteChannelMembershipCommand')).toBeLessThan(handler.indexOf('await alertAdmins('));
    // A failed revoke names its own label of the `uncleared-membership` template (ADR-062 decision 6), whose words say so.
    expect(handler).toContain("failed: 'failed'");
    expect(read('lambda/src/lib/admin-notice-templates.ts')).toContain("'label.failed': 'The audit could not revoke the membership.");
  });
});

describe('the membership audit role sends no message at all', () => {
  // Amazon Chime SDK authorizes a send against its bearer, so `chime:SendChannelMessage` on `user/*` lets a
  // role post as any person. This role held it on `channel/*` and `user/*` with no condition, then on the
  // tagged admin channel bearing the admin assistant. Its alert is an event now, so it holds no send.
  const cdk = require('aws-cdk-lib');
  const { Template } = require('aws-cdk-lib/assertions');
  const kinesis = require('aws-cdk-lib/aws-kinesis');
  const { MembershipAuditConstruct } = require('../lib/constructs/membership-audit');

  function statements(): Array<{ Action: unknown; Resource: unknown; Condition?: Record<string, Record<string, unknown>> }> {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'AuditTest', { env: { account: '123456789012', region: 'us-east-1' } });
    new MembershipAuditConstruct(stack, 'MembershipAudit', {
      stream: new kinesis.Stream(stack, 'Stream'),
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
      userPoolId: 'us-east-1_test',
      userPoolArn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_test',
      adminArnParam: '/agent-echelon/app-instance-admin-arn',
    });
    return (Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy')) as any[])
      .flatMap((p) => p.Properties.PolicyDocument.Statement);
  }

  it('holds no SendChannelMessage, and raises its alert on the default bus for ae.alert only', () => {
    const all = statements();
    expect(all.filter((s) => ([] as string[]).concat(s.Action as string[]).includes('chime:SendChannelMessage'))).toEqual([]);
    const puts = all.filter((s) => ([] as string[]).concat(s.Action as string[]).includes('events:PutEvents'));
    expect(puts).toHaveLength(1);
    expect(JSON.stringify(puts[0].Resource)).toContain(':event-bus/default');
    expect(puts[0].Condition?.StringEquals?.['events:source']).toEqual(['ae.alert']);
  });
});

describe('the admin channel provisioner reads the admin plane assignment records and no other classification', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { adminServicesTemplate } = require('./helpers/synth');
  const statements = (): any[] => (Object.values(adminServicesTemplate({}).findResources('AWS::IAM::Policy')) as any[])
    .filter((p) => JSON.stringify(p.Properties.Roles).includes('ProvisionFn'))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);

  it('enumerates assistant-assignments/admin and its children only, and writes none', () => {
    const all = statements();
    const reads = all.filter((s) => s.Sid === 'ReadTheAdminPlanesAssignments');
    expect(reads).toHaveLength(1);
    expect(reads[0].Action).toBe('ssm:GetParametersByPath');
    const resources = JSON.stringify(reads[0].Resource);
    expect(resources).toContain('/assistant-assignments/admin"');
    expect(resources).toContain('/assistant-assignments/admin/*');
    for (const c of ['basic', 'standard', 'premium']) expect(resources).not.toContain(`assistant-assignments/${c}`);
    expect(resources).not.toContain('assistant-assignments/*');
    expect(JSON.stringify(all)).not.toMatch(/ssm:(PutParameter|DeleteParameter)/);
  });
});
