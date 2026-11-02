/**
 * Membership Audit (SPEC-CONVERSATION-SECURITY Layer 6) — unit tests.
 *
 * Covers the pure decision logic (member classification + tier-violation check) and the
 * handler behavior: report-only alerts without revoking, enforce revokes, the admin service user is
 * skipped, and every person is audited by their AppInstanceUser whichever issuer signs them in.
 */

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
process.env.USER_POOL_ID = 'us-east-1_pool';
process.env.APP_INSTANCE_ARN = APP;
process.env.MEMBERSHIP_AUDIT_ALERT_CHANNEL_ARN = `${APP}/channel/admin-conv`;
process.env.ADMIN_ARN_PARAM = '/agent-echelon/app-instance-admin-arn';
process.env.SSM_ROOT = '/agent-echelon';
process.env.AUDIT_TABLE = 'AuditTable';
process.env.TOKENS_TABLE = 'Tokens';
// The second read of the invitations index, for a member no invitation names yet, is taken at once here.
process.env.INVITATION_SETTLE_MS = '0';
// MEMBERSHIP_AUDIT_ENFORCE left unset => report-only default.

const chimeSends: Array<{ _t: string; input: unknown }> = [];
// Identity-client calls, tracked separately: which CLIENT a tag read went through is the fact these
// tests exist to pin, and one shared array cannot express it.
const identitySends: Array<{ _t: string; input: unknown }> = [];
let memberGroups: string[] = ['basic'];
let channelModelTier = 'premium';
let enforceConfig: string | undefined; // undefined => no config item => fall back to env default
const ddbSends: Array<{ _cmd: string; input: unknown }> = [];
// Sweep (#2) + reeval-user (#3) enumeration fixtures.
let sweepChannels: string[] = [];   // channels ListChannels returns
let channelMembers: string[] = [];  // member ARNs ListChannelMemberships returns (per channel)
let userChannels: string[] = [];    // channel ARNs ListChannelMembershipsForAppInstanceUser returns
// A conversation's invitation records, as the token store's sparse index returns them.
let invitationItems: Array<Record<string, unknown>> = [];
// Pages the index answers in turn, when a case needs the index to change between reads; otherwise `invitationItems`.
let invitationPages: Array<{ Items: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> }> = [];

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => {
  class DescribeChannelCommand { _t = 'describe'; constructor(public input: unknown) {} }
  class DeleteChannelMembershipCommand { _t = 'delete'; constructor(public input: unknown) {} }
  class SendChannelMessageCommand { _t = 'send'; constructor(public input: unknown) {} }
  // The handler resolves the channel's tier from the IMMUTABLE `classification`
  // tag (ListTagsForResource), NOT mutable `metadata.modelTier` — see
  // membership-audit.ts resolveChannelClassification(). So the mock must serve the tag.
  class ListTagsForResourceCommand { _t = 'listtags'; constructor(public input: unknown) {} }
  class ListChannelsCommand { _t = 'listchannels'; constructor(public input: unknown) {} }
  class ListChannelMembershipsCommand { _t = 'listmemberships'; constructor(public input: unknown) {} }
  class ListChannelMembershipsForAppInstanceUserCommand { _t = 'listuserchannels'; constructor(public input: unknown) {} }
  return {
    ChimeSDKMessagingClient: jest.fn(() => ({
      send: async (cmd: { _t: string; input: unknown }) => {
        chimeSends.push(cmd);
        // TAGS ARE PER-RESOURCE, AND SO IS THE CLIENT THAT READS THEM. A CHANNEL and an ASSISTANT
        // both carry a `classification` tag, and the handler reads both - the channel's to know what
        // the room is, the assistant's to know what it is - but a channel is a Messaging resource and
        // an assistant is an Identity one, so only the channel read lands here.
        //
        // This mock served one value for every ARN it was handed, which made an assistant read as
        // whatever the channel was. The clearance comparison could then never come out
        // unequal, and the enforcement tests below were asserting against a tautology.
        if (cmd._t === 'listtags') {
          const arn = String((cmd.input as { ResourceARN?: string })?.ResourceARN || '');
          if (arn.includes('/bot/')) {
            // CHANNELS ONLY. A channel is a Messaging resource; an AppInstanceBot is an IDENTITY one
            // and its tags are unreadable here. Throwing reproduces what real AWS does with that ARN,
            // so a regression back to one shared client fails in this file instead of degrading
            // silently to the SSM fallback in production - which is how it shipped.
            throw Object.assign(new Error('not a messaging resource'), { name: 'ValidationException' });
          }
          return { Tags: [{ Key: 'classification', Value: channelModelTier }] };
        }
        if (cmd._t === 'describe') return { Channel: { Metadata: JSON.stringify({ modelTier: channelModelTier }) } };
        if (cmd._t === 'listchannels') return { Channels: sweepChannels.map((a) => ({ ChannelArn: a })) };
        if (cmd._t === 'listmemberships') return { ChannelMemberships: channelMembers.map((a) => ({ Member: { Arn: a } })) };
        if (cmd._t === 'listuserchannels') return { ChannelMemberships: userChannels.map((a) => ({ ChannelSummary: { ChannelArn: a } })) };
        return {};
      },
    })),
    DescribeChannelCommand,
    DeleteChannelMembershipCommand,
    SendChannelMessageCommand,
    ListTagsForResourceCommand,
    ListChannelsCommand,
    ListChannelMembershipsCommand,
    ListChannelMembershipsForAppInstanceUserCommand,
  };
});

// THE IDENTITY CLIENT IS MOCKED SEPARATELY FROM THE MESSAGING ONE, because the handler must use a
// DIFFERENT client for each and one shared mock cannot tell you whether it did. An AppInstanceBot is
// an Identity resource; reading its tags through the Messaging client fails against real AWS on every
// call, falls through to the SSM map, and leaves the tag-first design never executing - which a mock
// that answers any ARN reports as a pass.
jest.mock('@aws-sdk/client-chime-sdk-identity', () => {
  class ListTagsForResourceCommand { _t = 'identity-listtags'; constructor(public input: unknown) {} }
  return {
    ChimeSDKIdentityClient: jest.fn(() => ({
      send: async (cmd: { _t: string; input: unknown }) => {
        identitySends.push(cmd);
        const arn = String((cmd.input as { ResourceARN?: string })?.ResourceARN || '');
        const name = arn.split('/bot/')[1] || '';
        // An assistant carries its OWN classification. A bot that is not one (a `/battle` alt-slot)
        // carries no classification tag, which is what tells the auditor to leave it alone.
        return ['basic', 'standard', 'premium'].includes(name)
          ? { Tags: [{ Key: 'classification', Value: name }] }
          : { Tags: [] };
      },
    })),
    ListTagsForResourceCommand,
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
        // Per-assistant bot-arn keys are `${SSM_ROOT}/assistant/{tier}/bot-arn`
        // (migrated from the legacy `/tier/{tier}/…` path).
        if (name.includes('/assistant/')) {
          const tier = name.split('/assistant/')[1].split('/')[0]; // basic | standard | premium
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
  class QueryCommand { _cmd = 'query'; constructor(public input: unknown) {} }
  class UpdateCommand { _cmd = 'update'; constructor(public input: unknown) {} }
  return {
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { _cmd: string; input: unknown }) => {
          ddbSends.push(cmd);
          if (cmd._cmd === 'get') {
            return enforceConfig === undefined ? {} : { Item: { pk: 'config', sk: 'enforce', value: enforceConfig } };
          }
          if (cmd._cmd === 'query') return invitationPages.length ? invitationPages.shift() : { Items: invitationItems };
          return {};
        },
      }),
    },
    GetCommand,
    PutCommand,
    QueryCommand,
    UpdateCommand,
  };
});

const mockFanOut = jest.fn(async () => ({ emailed: [] as string[], skipped: [] as string[], failed: [] as string[] }));
jest.mock('../lambda/src/lib/channel-notify', () => ({
  fanOutChannelNotification: mockFanOut,
}));

// THE ALERT GOES THROUGH THE ONE ADMIN-NOTICE PATH, which posts as the admin assistant and whose channel fan-out
// emails the roster. Recorded here as a 'send' so the assertions below read the same as before.
const mockPostAdminNotice = jest.fn(async (notice: unknown) => { chimeSends.push({ _t: 'send', input: notice } as never); return true; });
jest.mock('../lambda/src/lib/admin-notice', () => ({
  ...jest.requireActual('../lambda/src/lib/admin-notice'),
  postAdminNotice: (n: unknown) => mockPostAdminNotice(n),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const audit = require('../lambda/src/membership-audit');

/** A membership event for `memberArn`, who is in the room when it is read, as the member of a real add is. */
function kinesisEvent(memberArn: string, eventType = 'CREATE_CHANNEL_MEMBERSHIP') {
  if (!channelMembers.includes(memberArn)) channelMembers.push(memberArn);
  return staleKinesisEvent(memberArn, eventType);
}

/** A membership event for `memberArn` that is read after they left the room: the room's listing does not hold them. */
function staleKinesisEvent(memberArn: string, eventType = 'CREATE_CHANNEL_MEMBERSHIP') {
  const payload = { ChannelArn: `${APP}/channel/room-1`, Member: { Arn: memberArn } };
  const data = Buffer.from(JSON.stringify({ EventType: eventType, Payload: payload })).toString('base64');
  return { Records: [{ kinesis: { data } }] };
}

beforeEach(() => {
  chimeSends.length = 0;
  identitySends.length = 0;
  ddbSends.length = 0;
  memberGroups = ['basic'];
  channelModelTier = 'premium';
  enforceConfig = undefined;
  sweepChannels = [];
  channelMembers = [];
  userChannels = [];
  invitationItems = [];
  invitationPages = [];
  mockFanOut.mockClear();
});

describe('pure helpers', () => {
  const userArn = (id: string) => `${APP}/user/${id}`;

  it('classifyMember distinguishes user / bot / admin / unknown, and reads nothing else off the id', () => {
    expect(audit.classifyMember(userArn('sub-123'), 'agent-echelon-admin')).toEqual({ kind: 'user', sub: 'sub-123' });
    expect(audit.classifyMember(`${APP}/bot/assistant`, 'agent-echelon-admin').kind).toBe('bot');
    expect(audit.classifyMember(userArn('agent-echelon-admin'), 'agent-echelon-admin').kind).toBe('admin');
    // A person of another issuer is a person: which issuer signed them in lives only in Identities.
    expect(audit.classifyMember(userArn('fed_abc'), 'agent-echelon-admin').kind).toBe('user');
    expect(audit.classifyMember(undefined).kind).toBe('unknown');
    expect(audit.classifyMember(userArn('')).kind).toBe('unknown');
  });

  it('isClassificationViolation flags lower-on-higher only, failing safe on unknown tiers', () => {
    expect(audit.isClassificationViolation('basic', 'premium')).toBe(true);
    expect(audit.isClassificationViolation('standard', 'premium')).toBe(true);
    expect(audit.isClassificationViolation('basic', 'standard')).toBe(true);
    expect(audit.isClassificationViolation('premium', 'basic')).toBe(false);
    expect(audit.isClassificationViolation('premium', 'premium')).toBe(false);
    expect(audit.isClassificationViolation('basic', 'basic')).toBe(false);
    expect(audit.isClassificationViolation('mystery', 'premium')).toBe(true);
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
    expect(kinds).toContain('listtags'); // resolved channel classification from the immutable tag
    expect(kinds).toContain('send'); // posted the admin-conversation alert
    expect(kinds).not.toContain('delete'); // report-only: no revocation
    expect(mockPostAdminNotice).toHaveBeenCalledTimes(1); // posted once; the channel's notify fan-out emails the roster
  });

  it('does nothing for a compliant (premium) member on a premium channel', async () => {
    memberGroups = ['premium'];
    await audit.handler(kinesisEvent(`${APP}/user/premium-sub`));
    expect(chimeSends.map((c) => c._t)).not.toContain('send');
    expect(mockFanOut).not.toHaveBeenCalled();
  });

  it('flags a member whose only issuer the registry no longer declares: they reach nothing (C3)', async () => {
    // A REMOVED ISSUER'S PERSON. Their only subject is under an issuer this deployment does not trust,
    // so they resolve to no clearance at all, and a member who reaches nothing sits over the room's
    // classification wherever they are: flagged as a violation, and nothing is revoked in report-only.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { subjectsOfPerson } = require('../lambda/src/lib/person-identity');
    (subjectsOfPerson as jest.Mock).mockResolvedValueOnce([{ issuer: 'removed-partner', subject: 'partner-raw' }]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await audit.handler(kinesisEvent(`${APP}/user/0192f0e0-0000-7000-8000-00000000beef`));
    const flagged = warn.mock.calls.find((c) => String(c[0]).includes('uncleared member'));
    expect(flagged?.[1]).toMatchObject({ _auditEvent: 'membership_tier_violation', subjectClearance: 'none', action: 'reported' });
    expect(chimeSends.map((c) => c._t)).not.toContain('delete');
    warn.mockRestore();
  });

  it('audits a pool member by the subject Identities names, not by their person id', async () => {
    // The person id is an opaque UUID v7; the pool knows them by their subject. The groups read is
    // asked of that subject, and a basic member on a premium room is flagged.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { subjectsOfPerson } = require('../lambda/src/lib/person-identity');
    // This deployment's own pool, by its trusted-issuer registry id.
    (subjectsOfPerson as jest.Mock).mockResolvedValueOnce([{ issuer: 'deployment', subject: 'pool-sub-1' }]);
    memberGroups = ['basic'];
    await audit.handler(kinesisEvent(`${APP}/user/0192f0e0-0000-7000-8000-00000000cafe`));
    expect(chimeSends.map((c) => c._t)).toContain('send');
  });

  it('stands down on a bot that is not a classification assistant, after reading its tag', async () => {
    // NOT "without any Chime calls" any more, and the difference is the design rather than a cost.
    // An assistant's classification is its own identity TAG, so the auditor has to read that tag to
    // know whether this bot is a classification assistant at all - it cannot tell from the ARN, which
    // is exactly the naming-convention guessing the tag replaced. An untagged bot (a `/battle`
    // alt-slot) resolves to no classification and the audit stops there: one read, no channel lookup,
    // no alert, no revocation.
    await audit.handler(kinesisEvent(`${APP}/bot/assistant`));
    // The tag read goes through the IDENTITY client, and nothing goes through the Messaging one: the
    // audit stops before it ever looks up the channel.
    expect(identitySends.map((c) => c._t)).toEqual(['identity-listtags']);
    expect(chimeSends).toHaveLength(0);
    expect(mockFanOut).not.toHaveBeenCalled();
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

describe('trigger #2 - scheduled sweep', () => {
  it('sweeps every channel + member and flags an uncleared member the event stream missed', async () => {
    // A basic member sits on a premium channel with NO membership event (e.g. a post-join downgrade).
    sweepChannels = [`${APP}/channel/room-1`];
    channelMembers = [`${APP}/user/basic-sub`];
    channelModelTier = 'premium';
    memberGroups = ['basic'];

    await audit.handler({ type: 'sweep' });

    const kinds = chimeSends.map((c) => c._t);
    expect(kinds).toContain('listchannels');   // enumerated channels
    expect(kinds).toContain('listmemberships'); // enumerated the channel's members
    expect(kinds).toContain('listtags');        // resolved classification from the immutable tag
    expect(kinds).toContain('send');            // flagged the uncleared member
  });

  it('a sweep of a compliant channel flags nothing', async () => {
    sweepChannels = [`${APP}/channel/room-1`];
    channelMembers = [`${APP}/user/premium-sub`];
    channelModelTier = 'premium';
    memberGroups = ['premium'];

    await audit.handler({ type: 'sweep' });
    expect(chimeSends.map((c) => c._t)).not.toContain('send');
  });
});

describe('trigger #3 - on-downgrade user re-eval', () => {
  it('re-evaluates a downgraded user\'s existing memberships and flags the no-longer-cleared one', async () => {
    // The marquee case: a user downgraded to basic still sits on a premium channel. No Chime membership
    // event fired (a Cognito group change is invisible to the stream), so only this targeted re-eval catches it.
    userChannels = [`${APP}/channel/premium-room`];
    channelMembers = [`${APP}/user/basic-sub`]; // still in the room when the finding is reported
    channelModelTier = 'premium';
    memberGroups = ['basic'];

    await audit.handler({ type: 'reeval-user', userArn: `${APP}/user/basic-sub` });

    const kinds = chimeSends.map((c) => c._t);
    expect(kinds).toContain('listuserchannels'); // listed the user's channels
    expect(kinds).toContain('send');             // flagged the uncleared membership
  });

  it('re-evaluates a person disabled at their pool: their row stays active, so a downgrade while disabled is audited', async () => {
    // The platform keeps no copy of the pool's disable, so the person is on the ordinary active reverse
    // lookup and the audit reads them like anybody else.
    const identity = jest.requireMock('../lambda/src/lib/person-identity') as { subjectsOfPerson: jest.Mock };
    identity.subjectsOfPerson.mockClear();
    userChannels = [`${APP}/channel/premium-room`];
    channelMembers = [`${APP}/user/basic-sub`]; // still in the room when the finding is reported
    channelModelTier = 'premium';
    memberGroups = ['basic'];
    await audit.handler({ type: 'reeval-user', userArn: `${APP}/user/basic-sub` });
    expect(chimeSends.map((c) => c._t)).toContain('send');
    expect(identity.subjectsOfPerson).toHaveBeenCalled();
    for (const call of identity.subjectsOfPerson.mock.calls) expect(call[2]).toBeUndefined();
  });

  it('an unrecognized control event is a no-op (no Chime calls)', async () => {
    await audit.handler({ type: 'reeval-user' } as never); // missing userArn
    expect(chimeSends.map((c) => c._t)).not.toContain('send');
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

  it('revokes an uncleared assistant when enforcing', async () => {
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

// This file declares its jest mocks at top level and imports the module under test lazily
// inside each case, so it has no top-level import/export of its own. Without one TypeScript treats
// it as a global SCRIPT rather than a module: its top-level `const`s then share one global scope
// with every other such test file, they collide (TS2451), and symbols resolve against whichever
// file won - which is how `abuse-controls.test.ts` came to be typechecked against
// `user-profile-client`. `npm run typecheck` was red with 52 errors for that reason alone, and
// these files were effectively unchecked. This marks the file as a module. Do not remove.
export {};

/**
 * AN INVITEE IS AUDITED BY THE INVITATION THAT NAMES THEM (B8, M-10).
 *
 * An invitation mints its invitee at invite time and adds it to the conversation with no `Identities` row,
 * so it resolves to no clearance. The audit recognizes the invitation record of THIS conversation naming it
 * as what admits it, and nothing else: a revoked or expired invitation, one naming somebody else, one of
 * another classification, and any member who resolves to a clearance are audited as before.
 */
describe('a member an invitation minted', () => {
  const INVITEE = `${APP}/user/0192f0e0-0000-7000-8000-0000000001ee`;
  const ROOM = `${APP}/channel/room-1`;
  const NOW = Math.floor(Date.now() / 1000);
  const record = (over: Record<string, unknown> = {}) => ({
    pk: 'invitation#h', kind: 'invitation', invitationId: 'i-1', inviterArn: `${APP}/user/inviter`, mode: 'sign-in',
    personArn: INVITEE, channelArn: ROOM, invitationChannel: ROOM, classification: 'premium', expiresAt: NOW + 86_400, ...over,
  });
  const asInvitee = () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { subjectsOfPerson } = require('../lambda/src/lib/person-identity');
    (subjectsOfPerson as jest.Mock).mockResolvedValueOnce([]);
  };
  const flaggedAfter = async (member = INVITEE): Promise<boolean> => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await audit.handler(kinesisEvent(member));
    const flagged = warn.mock.calls.some((c) => String(c[0]).includes('uncleared member'));
    warn.mockRestore();
    log.mockRestore();
    return flagged;
  };

  it('without an invitation, a member with no Identities row is flagged, as before', async () => {
    asInvitee();
    expect(await flaggedAfter()).toBe(true);
  });

  it('a pending invitation of this conversation naming the member audits them: no finding, no alert', async () => {
    mockPostAdminNotice.mockClear();
    invitationItems = [record()];
    asInvitee();
    expect(await flaggedAfter()).toBe(false);
    expect(mockPostAdminNotice).not.toHaveBeenCalled();
    // The read is the conversation's invitations through the index, never a token by its key.
    const q = ddbSends.find((c) => c._cmd === 'query')?.input as { IndexName?: string; ExpressionAttributeValues?: Record<string, string> };
    expect(q?.IndexName).toBe('invitationsByChannel');
    expect(q?.ExpressionAttributeValues?.[':c']).toBe(ROOM);
  });

  it('a link-redeemed invitee stays audited by the invitation; a sign-in one is audited by their clearance', async () => {
    invitationItems = [record({ mode: 'link', consumedAt: NOW - 60, redeemedVia: 'link' })];
    asInvitee();
    expect(await flaggedAfter()).toBe(false);
    invitationItems = [record({ consumedAt: NOW - 60, redeemedVia: 'sign-in' })];
    asInvitee();
    expect(await flaggedAfter()).toBe(true);
  });

  it('a revoked, expired, other-person or other-classification invitation admits nobody', async () => {
    for (const over of [
      { revokedAt: NOW - 10 },
      { expiresAt: NOW - 10 },
      { personArn: `${APP}/user/someone-else` },
      { classification: 'basic' },
    ]) {
      mockPostAdminNotice.mockClear();
      invitationItems = [record(over)];
      asInvitee();
      expect({ over, flagged: await flaggedAfter() }).toEqual({ over, flagged: true });
    }
  });

  it('is never consulted for a member who resolves to a clearance: a basic member named by an invitation is still flagged', async () => {
    invitationItems = [record({ personArn: `${APP}/user/basic-sub` })];
    memberGroups = ['basic'];
    expect(await flaggedAfter(`${APP}/user/basic-sub`)).toBe(true);
    expect(ddbSends.some((c) => c._cmd === 'query')).toBe(false);
  });

  it('a stale add for a revoked invitee who is no longer in the room reports nothing: the room is read first', async () => {
    // THE REVOKE-AT-ONCE CASE: an invitation is made and revoked within seconds, so its add event is read after the
    // revoke removed the invitee. Judged against the revoked record alone it read as an uncleared member.
    mockPostAdminNotice.mockClear();
    invitationItems = [record({ revokedAt: NOW - 5 })];
    asInvitee();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await audit.handler(staleKinesisEvent(INVITEE));
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[SecurityEvent]'))).toBe(false);
    expect(log.mock.calls.some((c) => String(c[0]).includes('the event was stale'))).toBe(true);
    warn.mockRestore();
    log.mockRestore();
    expect(mockPostAdminNotice).not.toHaveBeenCalled();
    expect(ddbSends.some((c) => c._cmd === 'put')).toBe(false);
    // The room was read as the service admin, its visible members and its hidden ones.
    const reads = chimeSends.filter((c) => c._t === 'listmemberships').map((c) => c.input as { ChimeBearer?: string; Type?: string });
    expect(reads.map((r) => r.Type)).toEqual(['DEFAULT', 'HIDDEN']);
    expect(reads.every((r) => r.ChimeBearer === `${APP}/user/agent-echelon-admin`)).toBe(true);
  });

  it('a revoked invitee still in the room is flagged: a member a revocation left behind', async () => {
    mockPostAdminNotice.mockClear();
    invitationItems = [record({ revokedAt: NOW - 5 })];
    asInvitee();
    expect(await flaggedAfter()).toBe(true);
    expect(mockPostAdminNotice).toHaveBeenCalledTimes(1);
  });

  it('a fresh invitee whose record has not reached the index yet is admitted by the second read, not flagged', async () => {
    mockPostAdminNotice.mockClear();
    invitationPages = [{ Items: [] }, { Items: [record()] }];
    asInvitee();
    expect(await flaggedAfter()).toBe(false);
    expect(mockPostAdminNotice).not.toHaveBeenCalled();
    expect(ddbSends.filter((c) => c._cmd === 'query')).toHaveLength(2);
  });

  it('the invitation naming the member is found past the first page, filtered to the member', async () => {
    const others = Array.from({ length: 3 }, (_, i) => record({ pk: `invitation#o${i}`, personArn: `${APP}/user/other-${i}` }));
    invitationPages = [{ Items: others, LastEvaluatedKey: { pk: 'p1' } }, { Items: [record()] }];
    asInvitee();
    expect(await flaggedAfter()).toBe(false);
    const q = ddbSends.filter((c) => c._cmd === 'query').map((c) => c.input as { ExclusiveStartKey?: unknown; ExpressionAttributeValues?: Record<string, string>; Limit?: number });
    expect(q).toHaveLength(2);
    expect(q[1].ExclusiveStartKey).toEqual({ pk: 'p1' });
    expect(q[0].ExpressionAttributeValues?.[':p']).toBe(INVITEE);
    expect(q[0].Limit).toBeUndefined();
  });

  it('an unreadable token store admits nobody', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const failing = { send: async () => { throw Object.assign(new Error('x'), { name: 'AccessDeniedException' }); } };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await audit.invitationAdmitsMember(ROOM, INVITEE, 'premium', { doc: failing, table: 'Tokens' })).toBe(false);
    warn.mockRestore();
  });
});
