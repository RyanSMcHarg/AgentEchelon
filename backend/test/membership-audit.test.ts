/**
 * Membership Audit (SPEC-CONVERSATION-SECURITY Layer 6) — unit tests.
 *
 * Covers the pure decision logic (member classification + tier-violation check) and the
 * handler behavior: report-only alerts without revoking, enforce revokes, and non-user
 * members (bot / admin / federated) are skipped.
 */

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
process.env.USER_POOL_ID = 'us-east-1_pool';
process.env.APP_INSTANCE_ARN = APP;
process.env.MEMBERSHIP_AUDIT_ALERT_CHANNEL_ARN = `${APP}/channel/admin-conv`;
process.env.ADMIN_ARN_PARAM = '/agent-echelon/app-instance-admin-arn';
process.env.SSM_ROOT = '/agent-echelon';
process.env.AUDIT_TABLE = 'AuditTable';
// MEMBERSHIP_AUDIT_ENFORCE left unset => report-only default.

const chimeSends: Array<{ _t: string; input: unknown }> = [];
let memberGroups: string[] = ['basic'];
let channelModelTier = 'premium';
let enforceConfig: string | undefined; // undefined => no config item => fall back to env default
const ddbSends: Array<{ _cmd: string; input: unknown }> = [];

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => {
  class DescribeChannelCommand { _t = 'describe'; constructor(public input: unknown) {} }
  class DeleteChannelMembershipCommand { _t = 'delete'; constructor(public input: unknown) {} }
  class SendChannelMessageCommand { _t = 'send'; constructor(public input: unknown) {} }
  return {
    ChimeSDKMessagingClient: jest.fn(() => ({
      send: async (cmd: { _t: string; input: unknown }) => {
        chimeSends.push(cmd);
        if (cmd._t === 'describe') return { Channel: { Metadata: JSON.stringify({ modelTier: channelModelTier }) } };
        return {};
      },
    })),
    DescribeChannelCommand,
    DeleteChannelMembershipCommand,
    SendChannelMessageCommand,
  };
});

jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  class AdminListGroupsForUserCommand { constructor(public input: unknown) {} }
  return {
    CognitoIdentityProviderClient: jest.fn(() => ({
      send: async () => ({ Groups: memberGroups.map((g) => ({ GroupName: g })) }),
    })),
    AdminListGroupsForUserCommand,
  };
});

jest.mock('@aws-sdk/client-ssm', () => {
  class GetParameterCommand { constructor(public input: { Name: string }) {} }
  return {
    SSMClient: jest.fn(() => ({
      send: async (cmd: { input: { Name: string } }) => {
        const name = cmd.input?.Name || '';
        if (name.includes('/tier/')) {
          const tier = name.split('/tier/')[1].split('/')[0]; // basic | standard | premium
          return { Parameter: { Value: `${APP}/bot/${tier}` } };
        }
        return { Parameter: { Value: `${APP}/user/agent-echelon-admin` } };
      },
    })),
    GetParameterCommand,
  };
});

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => {
  class GetCommand { _cmd = 'get'; constructor(public input: unknown) {} }
  class PutCommand { _cmd = 'put'; constructor(public input: unknown) {} }
  return {
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { _cmd: string; input: unknown }) => {
          ddbSends.push(cmd);
          if (cmd._cmd === 'get') {
            return enforceConfig === undefined ? {} : { Item: { pk: 'config', sk: 'enforce', value: enforceConfig } };
          }
          return {};
        },
      }),
    },
    GetCommand,
    PutCommand,
  };
});

const mockFanOut = jest.fn(async () => ({ emailed: [] as string[], skipped: [] as string[], failed: [] as string[] }));
jest.mock('../lambda/src/lib/channel-notify', () => ({
  fanOutChannelNotification: mockFanOut,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const audit = require('../lambda/src/membership-audit');

function kinesisEvent(memberArn: string, eventType = 'CREATE_CHANNEL_MEMBERSHIP') {
  const payload = { ChannelArn: `${APP}/channel/room-1`, Member: { Arn: memberArn } };
  const data = Buffer.from(JSON.stringify({ EventType: eventType, Payload: payload })).toString('base64');
  return { Records: [{ kinesis: { data } }] };
}

beforeEach(() => {
  chimeSends.length = 0;
  ddbSends.length = 0;
  memberGroups = ['basic'];
  channelModelTier = 'premium';
  enforceConfig = undefined;
  mockFanOut.mockClear();
});

describe('pure helpers', () => {
  const userArn = (id: string) => `${APP}/user/${id}`;

  it('classifyMember distinguishes user / bot / admin / federated / unknown', () => {
    expect(audit.classifyMember(userArn('sub-123'), 'agent-echelon-admin')).toEqual({ kind: 'user', sub: 'sub-123' });
    expect(audit.classifyMember(`${APP}/bot/assistant`, 'agent-echelon-admin').kind).toBe('bot');
    expect(audit.classifyMember(userArn('agent-echelon-admin'), 'agent-echelon-admin').kind).toBe('admin');
    expect(audit.classifyMember(userArn('fed_abc'), 'agent-echelon-admin').kind).toBe('federated');
    expect(audit.classifyMember(undefined).kind).toBe('unknown');
    expect(audit.classifyMember(userArn('')).kind).toBe('unknown');
  });

  it('isTierViolation flags lower-on-higher only, failing safe on unknown tiers', () => {
    expect(audit.isTierViolation('basic', 'premium')).toBe(true);
    expect(audit.isTierViolation('standard', 'premium')).toBe(true);
    expect(audit.isTierViolation('basic', 'standard')).toBe(true);
    expect(audit.isTierViolation('premium', 'basic')).toBe(false);
    expect(audit.isTierViolation('premium', 'premium')).toBe(false);
    expect(audit.isTierViolation('basic', 'basic')).toBe(false);
    expect(audit.isTierViolation('mystery', 'premium')).toBe(true);
  });

  it('audits only membership create/update events', () => {
    expect(audit.AUDITED_EVENT_TYPES.has('CREATE_CHANNEL_MEMBERSHIP')).toBe(true);
    expect(audit.AUDITED_EVENT_TYPES.has('UPDATE_CHANNEL_MEMBERSHIP')).toBe(true);
    expect(audit.AUDITED_EVENT_TYPES.has('DELETE_CHANNEL_MEMBERSHIP')).toBe(false);
    expect(audit.AUDITED_EVENT_TYPES.has('CREATE_CHANNEL_MESSAGE')).toBe(false);
  });
});

describe('handler (report-only default)', () => {
  it('alerts but does NOT revoke a basic member on a premium channel', async () => {
    await audit.handler(kinesisEvent(`${APP}/user/basic-sub`));
    const kinds = chimeSends.map((c) => c._t);
    expect(kinds).toContain('describe'); // resolved channel tier
    expect(kinds).toContain('send'); // posted the admin-conversation alert
    expect(kinds).not.toContain('delete'); // report-only: no revocation
    expect(mockFanOut).toHaveBeenCalledTimes(1); // email fan-out attempted
  });

  it('does nothing for a compliant (premium) member on a premium channel', async () => {
    memberGroups = ['premium'];
    await audit.handler(kinesisEvent(`${APP}/user/premium-sub`));
    expect(chimeSends.map((c) => c._t)).not.toContain('send');
    expect(mockFanOut).not.toHaveBeenCalled();
  });

  it('skips a federated member (fed_ sub) without any Chime calls', async () => {
    await audit.handler(kinesisEvent(`${APP}/user/fed_xyz`));
    expect(chimeSends).toHaveLength(0);
    expect(mockFanOut).not.toHaveBeenCalled();
  });

  it('skips a bot member', async () => {
    await audit.handler(kinesisEvent(`${APP}/bot/assistant`));
    expect(chimeSends).toHaveLength(0);
  });
});

describe('handler (assistant / bot enforcement)', () => {
  it('flags a premium assistant on a basic channel (report-only)', async () => {
    channelModelTier = 'basic';
    await audit.handler(kinesisEvent(`${APP}/bot/premium`));
    const kinds = chimeSends.map((c) => c._t);
    expect(kinds).toContain('send'); // alerted
    expect(kinds).not.toContain('delete'); // report-only
  });

  it('does not flag a tier-matched assistant', async () => {
    channelModelTier = 'premium';
    await audit.handler(kinesisEvent(`${APP}/bot/premium`));
    expect(chimeSends.map((c) => c._t)).not.toContain('send');
  });

  it('does not flag a lower-tier assistant on a higher channel (not a leak)', async () => {
    channelModelTier = 'premium';
    await audit.handler(kinesisEvent(`${APP}/bot/basic`));
    expect(chimeSends.map((c) => c._t)).not.toContain('send');
  });

  it('leaves an unknown / battle alt-slot bot alone', async () => {
    channelModelTier = 'basic';
    await audit.handler(kinesisEvent(`${APP}/bot/altslot-xyz`));
    const kinds = chimeSends.map((c) => c._t);
    expect(kinds).not.toContain('send');
    expect(kinds).not.toContain('delete');
  });
});

describe('runtime enforce toggle + findings', () => {
  it('auto-revokes when the config toggle is on, even without the env flag', async () => {
    await jest.isolateModulesAsync(async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require('../lambda/src/membership-audit');
      enforceConfig = 'true';
      channelModelTier = 'premium';
      await m.handler(kinesisEvent(`${APP}/user/basic-sub`));
      expect(chimeSends.map((c) => c._t)).toContain('delete');
    });
  });

  it('stays report-only when the config toggle is off, even if the env flag is on', async () => {
    await jest.isolateModulesAsync(async () => {
      process.env.MEMBERSHIP_AUDIT_ENFORCE = 'true';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require('../lambda/src/membership-audit');
      enforceConfig = 'false';
      channelModelTier = 'premium';
      await m.handler(kinesisEvent(`${APP}/user/basic-sub`));
      expect(chimeSends.map((c) => c._t)).not.toContain('delete');
      expect(chimeSends.map((c) => c._t)).toContain('send'); // still alerts
      delete process.env.MEMBERSHIP_AUDIT_ENFORCE;
    });
  });

  it('persists a finding on a violation', async () => {
    channelModelTier = 'premium';
    await audit.handler(kinesisEvent(`${APP}/user/basic-sub`));
    expect(ddbSends.some((c) => c._cmd === 'put')).toBe(true);
  });
});

describe('handler (enforce mode)', () => {
  it('revokes a basic member on a premium channel when MEMBERSHIP_AUDIT_ENFORCE=true', async () => {
    await jest.isolateModulesAsync(async () => {
      process.env.MEMBERSHIP_AUDIT_ENFORCE = 'true';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const enforced = require('../lambda/src/membership-audit');
      await enforced.handler(kinesisEvent(`${APP}/user/basic-sub`));
      expect(chimeSends.map((c) => c._t)).toContain('delete');
      delete process.env.MEMBERSHIP_AUDIT_ENFORCE;
    });
  });

  it('revokes an over-tier assistant when enforcing', async () => {
    await jest.isolateModulesAsync(async () => {
      process.env.MEMBERSHIP_AUDIT_ENFORCE = 'true';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const enforced = require('../lambda/src/membership-audit');
      channelModelTier = 'basic';
      await enforced.handler(kinesisEvent(`${APP}/bot/premium`));
      expect(chimeSends.map((c) => c._t)).toContain('delete');
      delete process.env.MEMBERSHIP_AUDIT_ENFORCE;
    });
  });
});
