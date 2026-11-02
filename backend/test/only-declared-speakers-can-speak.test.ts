/**
 * ONLY A DECLARED COMPONENT CAN SPEAK AS AN ASSISTANT.
 *
 * Amazon Chime SDK does not bind the `ChimeBearer` to the caller, so three grants each confer the
 * ability to speak as an assistant: invoking a classification's vend (it mints a session as the
 * assistant a routing record names), writing that routing record, and sending or updating a message
 * on a bot resource. Before this test the inventory of who holds them was read from code, and it was
 * longer than anyone had written down.
 *
 * DEFAULT-REFUSE. The stacks are synthesized and every role in every template is classified from its
 * own policies. A role holding any of the three grants must match an entry in `lib/config/speakers.ts`,
 * whoever added it and whatever it is for; an entry no role matches fails too, so the list stays the
 * inventory rather than a superset of it. The deployed half is
 * `tests/e2e/no-platform-role-speaks-as-an-assistant.spec.ts`, which reads the same list.
 *
 * CONSERVATIVE BY CONSTRUCTION. Conditions are ignored (a tag-conditioned vend invoke still speaks),
 * wildcards in actions and resources are honored, and `NotAction` / `NotResource` count as matching. A
 * statement this test cannot rule out counts as a grant.
 *
 * AND NO ROLE SENDS AS A PERSON. A send on `user/*` posts as anybody; a person's own bearer is pinned
 * by a policy variable, which never matches the probe here.
 *
 * AND, ON THE SAME TEMPLATES, step 24: the services that add or remove members bearing a bot hold those
 * changes only on a channel and a bot carrying a declared classification
 * (`membershipAsAssistantStatements`).
 *
 * AND step 31: no role changes membership on a resource without a classification condition. The
 * creators that bear the service admin hold the change on a classified channel and the admin's exact
 * ARN (`membershipAsServiceAdminStatements`), and none of them can create a conversation bearing an
 * assistant (step 33), the proactive briefing and a host's add-member included (step 37). The
 * admin-plane roles hold theirs on a classified channel bearing the service admin's exact ARN (step 38).
 * The roles that remain unconditioned are a person acting as themselves, each named with its reason.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Template } from 'aws-cdk-lib/assertions';
import { SPEAKERS, speakerFor } from '../lib/config/speakers';
import { STACK_PREFIX, RES_PREFIX, speakAsAssistantStatements } from '../lib/stacks/agent-classification-common';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';
import { assistantsOf } from './helpers/assistants';
import { adminServicesOnLiteralsTemplate, nestedOnLiteralsTemplate, testMessageStream, testTokensTable } from './helpers/synth';
import { assistantClassifications } from '../lib/config/profiles';
import { classificationReachOf } from './helpers/classification-reach';

const env = { account: '123456789012', region: 'us-east-1' };
const APP = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';

/** What each grant would be exercised against: concrete ARNs, matched against every pattern. */
const CONVERSATIONAL = profiles.classificationValues().filter((c) => profiles.isConversational(c));
const pascal = (c: string) => c.charAt(0).toUpperCase() + c.slice(1);
const PROBE = {
  bot: [`${APP}/bot/probe-bot`],
  person: [`${APP}/user/probe-person`],
  vend: CONVERSATIONAL.map((c) => `arn:aws:lambda:${env.region}:${env.account}:function:${STACK_PREFIX}Assistants-${c}-AssistantVendProbe`),
  routing: CONVERSATIONAL.map((c) => `arn:aws:dynamodb:${env.region}:${env.account}:table/${RES_PREFIX}-turn-routing-${c}`),
};
const VEND_ACTIONS = ['lambda:InvokeFunction'];
const ROUTE_WRITE_ACTIONS = ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:BatchWriteItem'];
const SEND_ACTIONS = ['chime:SendChannelMessage', 'chime:UpdateChannelMessage'];

type Capability = 'vend' | 'route-write' | 'bot-send' | 'person-send';

const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : ([] as T[]).concat(v));
/**
 * An IAM pattern as a regex. A policy variable (`${aws:PrincipalTag/bot}`) names the caller's own
 * identity: for the person probe that is the pin this test exists to tell apart from `user/*`, so it
 * never matches; for every other probe it can be anything, so it is a wildcard.
 */
const glob = (pattern: string, flags = '', variables: 'wildcard' | 'pinned' = 'wildcard') => new RegExp(`^${pattern
  .replace(/\$\{[^}]*\}/g, variables === 'wildcard' ? '*' : '\u0000')
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*/g, '.*')
  .replace(/\?/g, '.')}$`, flags);

/**
 * A resource as a string, with what can be resolved resolved. A reference to another resource in the
 * template stands for that resource's ARN when it is one of the probes' kinds (the vend function, a
 * routing table), and otherwise for something no probe matches.
 */
function flatten(node: unknown, resources: Record<string, any>): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return String(node);
  const o = node as Record<string, any>;
  if ('Fn::Join' in o) return (o['Fn::Join'][1] as unknown[]).map((p) => flatten(p, resources)).join(o['Fn::Join'][0]);
  if ('Fn::Sub' in o) {
    const s = typeof o['Fn::Sub'] === 'string' ? o['Fn::Sub'] : o['Fn::Sub'][0];
    return s.replace(/\$\{AWS::Region\}/g, env.region).replace(/\$\{AWS::AccountId\}/g, env.account).replace(/\$\{AWS::Partition\}/g, 'aws');
  }
  const ref = o.Ref ?? (Array.isArray(o['Fn::GetAtt']) ? o['Fn::GetAtt'][0] : undefined);
  if (ref === 'AWS::Region') return env.region;
  if (ref === 'AWS::AccountId') return env.account;
  if (ref === 'AWS::Partition') return 'aws';
  if (ref === 'AWS::URLSuffix') return 'amazonaws.com';
  if (typeof ref === 'string') {
    const r = resources[ref];
    if (r?.Type === 'AWS::Lambda::Function' && /AssistantVend/.test(ref)) return PROBE.vend[0];
    if (r?.Type === 'AWS::DynamoDB::Table' && /turn-routing/.test(JSON.stringify(r.Properties?.TableName ?? ''))) return PROBE.routing[0];
    return `token:${ref}`;
  }
  return `token:${JSON.stringify(o)}`;
}

function grants(
  statement: any, actions: string[], probes: string[], resources: Record<string, any>, variables: 'wildcard' | 'pinned' = 'wildcard',
): boolean {
  if (statement.Effect !== 'Allow') return false;
  const actionHit = statement.NotAction !== undefined
    ? actions.some((a) => !asList(statement.NotAction).some((p: string) => glob(p, 'i').test(a)))
    : actions.some((a) => asList(statement.Action).some((p: string) => glob(p, 'i').test(a)));
  if (!actionHit) return false;
  if (statement.NotResource !== undefined) return true;
  return asList(statement.Resource).some((r) => {
    const pattern = glob(flatten(r, resources), '', variables);
    return probes.some((p) => pattern.test(p));
  });
}

/** Every statement on every role, by logical id: inline, attached `AWS::IAM::Policy`, and local managed policies. */
function statementsByRole(tpl: Template): Map<string, any[]> {
  const resources = tpl.toJSON().Resources as Record<string, any>;
  const out = new Map<string, any[]>();
  const add = (roleId: string, doc: any) => {
    if (!out.has(roleId)) return;
    out.get(roleId)!.push(...asList(doc?.Statement));
  };
  for (const [id, r] of Object.entries(resources)) if (r.Type === 'AWS::IAM::Role') out.set(id, []);
  for (const [id, r] of Object.entries(resources)) {
    if (r.Type === 'AWS::IAM::Role') {
      for (const p of asList(r.Properties?.Policies) as any[]) add(id, p.PolicyDocument);
      // A permissions boundary only narrows, so it is never read as a grant. Attached managed policies are.
      for (const m of asList(r.Properties?.ManagedPolicyArns) as any[]) {
        if (m?.Ref && resources[m.Ref]?.Type === 'AWS::IAM::ManagedPolicy') add(id, resources[m.Ref].Properties.PolicyDocument);
      }
    }
    if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') {
      for (const ref of asList(r.Properties?.Roles) as any[]) if (ref?.Ref) add(ref.Ref, r.Properties.PolicyDocument);
    }
  }
  return out;
}

/** What each role in a template can do that matters here. Roles with none are left out. */
function capabilities(tpl: Template): Map<string, Set<Capability>> {
  const resources = tpl.toJSON().Resources as Record<string, any>;
  const out = new Map<string, Set<Capability>>();
  for (const [roleId, statements] of statementsByRole(tpl)) {
    const caps = new Set<Capability>();
    for (const s of statements) {
      if (grants(s, VEND_ACTIONS, PROBE.vend, resources)) caps.add('vend');
      if (grants(s, ROUTE_WRITE_ACTIONS, PROBE.routing, resources)) caps.add('route-write');
      if (grants(s, SEND_ACTIONS, PROBE.bot, resources)) caps.add('bot-send');
      if (grants(s, SEND_ACTIONS, PROBE.person, resources, 'pinned')) caps.add('person-send');
    }
    if (caps.size) out.set(roleId, caps);
  }
  return out;
}

const SPEAKING: Capability[] = ['vend', 'route-write', 'bot-send'];

/** The classification a host's context conversations are created at, in this synthesis. */
const CONTEXT_CLASSIFICATION = 'standard';

const classificationProps = {
  env,
  appInstanceArn: APP,
  attachmentsBucketName: 'test-attachments',
  attachmentsBucketArn: 'arn:aws:s3:::test-attachments',
  auroraDriftHookup: { rdsProxy: false, liveDrift: true },
};

/**
 * The stacks that hold any speaking grant, each in its own app, at their widest: a second issuer on, every
 * role the shipped catalog offers (each stack reads the catalog, which declares them), live drift wired.
 */
async function synthesized(): Promise<Array<{ stack: string; tpl: Template }>> {
  const out: Array<{ stack: string; tpl: Template }> = [];
  const context = {
    // A host app's pool with the one-conversation session, which stands up the context membership role.
    issuers: [
      { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true },
      { id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostApp', clearance: { oneChannel: CONTEXT_CLASSIFICATION, classifications: [CONTEXT_CLASSIFICATION] } },
    ],
  };
  const add = (stack: string, build: (app: cdk.App) => cdk.Stack) => {
    out.push({ stack, tpl: Template.fromStack(build(new cdk.App({ context }))) });
  };
  const { BattleStack } = await import('../lib/stacks/battle-stack');
  const { ChannelFlowStack } = await import('../lib/stacks/channel-flow-stack');
  const { PostProcessingStack } = await import('../lib/stacks/post-processing-stack');
  const { NotificationStack } = await import('../lib/stacks/notification-stack');
  const { ConversationsStack } = await import('../lib/stacks/conversations-stack');
  const { ArchiveStackAurora } = await import('../lib/stacks/archive-stack-aurora');
  const { MessagingStack } = await import('../lib/stacks/messaging-stack');
  const { IdentityStack } = await import('../lib/stacks/identity-stack');

  add('Assistants-basic', (app) => assistantsOf('basic')(app, `${STACK_PREFIX}Assistants-basic`, classificationProps as never));
  add('Assistants-standard', (app) => assistantsOf('standard')(app, `${STACK_PREFIX}Assistants-standard`, classificationProps as never));
  add('Assistants-premium', (app) => assistantsOf('premium')(app, `${STACK_PREFIX}Assistants-premium`, classificationProps as never));
  add('Battle', (app) => new BattleStack(app, `${STACK_PREFIX}Battle`, { env, appInstanceArn: APP, selfPoolId: 'us-east-1_x', appUrl: 'https://app.example.com' } as never));
  add('ChannelFlow', (app) => new ChannelFlowStack(app, `${STACK_PREFIX}ChannelFlow`, { env, classifications: assistantClassifications(), appInstanceArn: APP } as never));
  add('PostProcessing', (app) => new PostProcessingStack(app, `${STACK_PREFIX}PostProcessing`, {
    env, appInstanceArn: APP, messageStream: testMessageStream(app),
    attachmentsBucketName: 'test-attachments', attachmentsBucketArn: 'arn:aws:s3:::test-attachments',
  }));
  add('Notifications', (app) => new NotificationStack(app, `${STACK_PREFIX}Notifications`, {
    env, userPoolId: 'us-east-1_x', classifications: assistantClassifications(), appInstanceArn: APP, senderEmail: 'assistant@example.com',
    messageStream: testMessageStream(app), tokens: testTokensTable(app), notifyBridge: true,
  } as never));
  {
    // Conversations takes the pool and the roles by reference, so the identity stacks are built in the
    // same app, and checked too: the credential exchange's roles send as people.
    const app = new cdk.App({ context });
    const messaging = new MessagingStack(app, `${STACK_PREFIX}Messaging`, { env, appInstanceName: 'test' });
    const cog = new IdentityStack(app, `${STACK_PREFIX}Identity`, { env, appInstanceArn: APP });
    const conversations = new ConversationsStack(app, `${STACK_PREFIX}Conversations`, {
      env, appInstanceArn: APP, selfPoolId: 'us-east-1_x',
    });
    out.push({ stack: 'Messaging', tpl: Template.fromStack(messaging) });
    out.push({ stack: 'Identity', tpl: Template.fromStack(cog) });
    out.push({ stack: 'Conversations', tpl: Template.fromStack(conversations) });
  }
  // The admin backend, on the core it sits on, with the experiments it administers, and its nested stacks.
  // On literal core references, so a grant on the app instance reads as its ARN.
  out.push({ stack: 'AdminServices', tpl: adminServicesOnLiteralsTemplate(context) });
  out.push({ stack: 'AdminServices/AssistantAdministration', tpl: nestedOnLiteralsTemplate('AssistantAdministration', context) });
  out.push({ stack: 'AdminServices/Analytics', tpl: nestedOnLiteralsTemplate('Analytics', context) });
  add('Archive', (app) => new ArchiveStackAurora(app, `${STACK_PREFIX}Archive`, {
    env, appInstanceArn: APP, messageStream: testMessageStream(app), userPoolId: 'us-east-1_x', userPoolArn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_x',
  } as never));
  return out;
}

let stacks: Array<{ stack: string; tpl: Template }>;
let found: Array<{ stack: string; roleId: string; caps: Set<Capability> }>;

beforeAll(async () => {
  stacks = await synthesized();
  found = stacks.flatMap(({ stack, tpl }) => [...capabilities(tpl)].map(([roleId, caps]) => ({ stack, roleId, caps })));
}, 600_000);

const speaks = (caps: Set<Capability>) => SPEAKING.some((c) => caps.has(c));
const describeRole = (f: { stack: string; roleId: string; caps: Set<Capability> }) => `${f.stack}/${f.roleId} (${[...f.caps].join(', ')})`;

describe('the roles that can speak as an assistant are exactly the declared ones', () => {
  it('every role that can invoke a vend, write a routing record or send bearing a bot is declared', () => {
    const undeclared = found.filter((f) => speaks(f.caps) && !speakerFor(f.roleId)).map(describeRole);
    expect(undeclared).toEqual([]);
  });

  it('every declared speaker is a role that can speak, so the list is the inventory', () => {
    const stale = SPEAKERS.filter((s) => !found.some((f) => speaks(f.caps) && f.roleId.startsWith(s.constructId))).map((s) => s.constructId);
    expect(stale).toEqual([]);
  });

  it('no Battle role can invoke a vend, write a routing record or send bearing a bot (step 36)', () => {
    // The battle orchestrator names every line of a duel to the router (a round placeholder, a closing
    // notice, a marker clear), and the battle administration API names its notices and marker clears the
    // same way. So no role in the Battle stack speaks, and none is declared: a grant reappearing here is a
    // second speaker for a duel, which is refused rather than added to the list.
    expect(stacks.some((s) => s.stack === 'Battle')).toBe(true);
    expect(found.filter((f) => f.stack === 'Battle' && speaks(f.caps)).map(describeRole)).toEqual([]);
    expect(SPEAKERS.filter((s) => /^Battle|^ChannelBattle/.test(s.constructId)).map((s) => s.constructId)).toEqual([]);
  });

  it('no role can send as a person', () => {
    expect(found.filter((f) => f.caps.has('person-send')).map(describeRole)).toEqual([]);
  });

  it('a throwaway role given speakAsAssistantStatements is refused', () => {
    // The test's own proof that it refuses by default: the helper every notice caller uses, on a role
    // nobody declared, is caught by the same classification the stacks go through.
    const stack = new cdk.Stack(new cdk.App(), 'Throwaway', { env });
    new iam.Role(stack, 'ThrowawaySpeakerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: { Speak: new iam.PolicyDocument({ statements: speakAsAssistantStatements(stack, ['basic']) }) },
    });
    const caught = [...capabilities(Template.fromStack(stack))].filter(([id, caps]) => speaks(caps) && !speakerFor(id));
    expect(caught.map(([id, caps]) => [id.replace(/[0-9A-F]{8}$/, ''), [...caps].sort()])).toEqual([
      ['ThrowawaySpeakerRole', ['route-write', 'vend']],
    ]);
  });

  it('every entry carries a kind and a reason', () => {
    const kinds = ['turn', 'router', 'queue-edit', 'admin-alert'];
    for (const s of SPEAKERS) {
      expect([s.constructId, kinds.includes(s.kind)]).toEqual([s.constructId, true]);
      expect([s.constructId, s.reason.trim().length > 0]).toEqual([s.constructId, true]);
    }
    expect(new Set(SPEAKERS.map((s) => s.constructId)).size).toBe(SPEAKERS.length);
  });
});

describe('a membership change bearing an assistant is conditioned on the classification (step 24)', () => {
  // The services that add or remove members bearing a bot on their own role. Their membership grants
  // were `${appInstanceArn}/*` with no condition: any channel, as any bot or person.
  const MEMBERSHIP_ROLES = ['ShareConversationRole', 'ChannelBattleRole', 'ConversationMembershipRole'];
  const MEMBERSHIP = ['chime:CreateChannelMembership', 'chime:DeleteChannelMembership'];

  it('every membership grant on those roles is a classified channel or a classified bot, never the app instance', () => {
    const seen = new Set<string>();
    for (const { stack, tpl } of stacks) {
      for (const [roleId, statements] of statementsByRole(tpl)) {
        const part = MEMBERSHIP_ROLES.find((p) => roleId.startsWith(p));
        if (!part) continue;
        const grantsMembership = statements.filter((s) => s.Effect === 'Allow'
          && asList(s.Action).some((a: string) => MEMBERSHIP.some((m) => glob(a, 'i').test(m))));
        expect([stack, roleId, grantsMembership.length > 0]).toEqual([stack, roleId, true]);
        seen.add(part);
        for (const s of grantsMembership) {
          const where = `${stack}/${roleId} ${s.Sid ?? ''}`;
          const resources = asList(s.Resource).map((r) => flatten(r, tpl.toJSON().Resources));
          // A host's add-member creates and adds as the service admin (step 37), named exactly; its
          // channel leg is checked below like every other. Only remove-member still bears the assistant.
          if (part === 'ConversationMembershipRole' && resources.length === 1 && resources[0] === `${APP}/user/${RES_PREFIX}-admin`) continue;
          expect([where, resources.every((r) => r === `${APP}/channel/*` || r === `${APP}/bot/*`)]).toEqual([where, true]);
          const reach = classificationReachOf(s.Condition);
          // A host's membership change serves one classification, so both legs name exactly it.
          if (part === 'ConversationMembershipRole') {
            expect([where, reach]).toEqual([where, { any: false, values: [CONTEXT_CLASSIFICATION] }]);
            continue;
          }
          // The share and Battle Mode serve every conversation: a channel (and a bot) carrying a classification
          // other than the admin plane's, with no list of classifications to change when one is declared.
          expect([where, reach]).toEqual([where, { any: true, except: profiles.adminPlaneValues() }]);
        }
      }
    }
    expect([...seen].sort()).toEqual([...MEMBERSHIP_ROLES].sort());
  });
});

describe('every membership change is conditioned on the conversation\'s classification (step 31)', () => {
  // A membership or moderator change authorizes against the channel and the bearer; the member is a
  // request parameter IAM never sees. So each resource a grant names must be one of the two legs:
  //   - a channel, with `aws:ResourceTag/classification` naming declared classifications only;
  //   - a bearer: a bot with the same condition, or the service admin by its exact ARN (it carries no
  //     classification tag, and naming it exactly is what keeps the role from acting as any person).
  // Anything else (`${appInstanceArn}/*`, `user/*`, `*`, a `NotResource`) reaches every conversation.
  const CHANGES = [
    'chime:CreateChannelMembership', 'chime:CreateChannelModerator',
    'chime:DeleteChannelMembership', 'chime:DeleteChannelModerator',
  ];
  const SERVICE_ADMIN = `${APP}/user/${RES_PREFIX}-admin`;
  /**
   * THE GRANTS THAT ARE NOT CLASSIFICATION-CONDITIONED, each a decision rather than an oversight. They
   * are a person acting as themselves: the bearer is the caller's own identity, pinned by a policy
   * variable, so the grant cannot reach anyone else's bearer.
   */
  const EXEMPT: Array<{ role: RegExp; why: string }> = [
    {
      role: /^ExchangeRole(?!AdminPlane)/,
      why: 'a person\'s vended session: the bearer is pinned to the caller\'s own identity by a policy '
        + 'variable, so the person leaves (or, on the admin role, moderates) only as themselves, in a '
        + 'conversation Amazon Chime SDK already admits them to; the admin role is narrowed per request by '
        + 'the exchange\'s session policy',
    },
    {
      role: /^ExchangeRoleAdminPlane/,
      why: 'the admin identity\'s `manage-membership` session, pinned to `${sub}-admin` and narrowed to one '
        + 'channel by the exchange\'s session policy (SPEC-CREDENTIAL-EXCHANGE)',
    },
  ];
  /**
   * THE ADMIN-PLANE ROLES. They act across classifications by definition,
   * so their channel leg may name the admin plane's classifications as well as the conversational ones;
   * their bearer is still the service admin by its exact ARN, never `user/*` or the app instance. Each
   * still holds a membership change, so each is checked below rather than skipped.
   */
  const ADMIN_PLANE_ROLES: Array<{ role: RegExp; why: string }> = [
    { role: /^OffboardingRole/, why: 'a deleted person leaves every conversation they are in, of any classification' },
    { role: /^ProvisionFnServiceRole/, why: 'the admin notification channel, an admin-plane channel' },
    { role: /^AdminConversationSyncFunctionServiceRole/, why: 'keeps the admin plane\'s channels, the notification channel among them, to the admins' },
    { role: /^ConversationManagementRole/, why: 'archive, remove and leave serve every conversation' },
    { role: /^MembershipAudit(Admin)?FnServiceRole/, why: 'the audit evicts in any conversation; it is the detection for the member IAM cannot see' },
  ];
  const DECLARED = profiles.classificationValues();

  it('every exemption still names a role holding an unconditioned change, so the list stays the inventory', () => {
    const unexempted = stacks.flatMap(({ stack, tpl }) => offenders(tpl, stack, false));
    const stale = EXEMPT.filter((e) => !unexempted.some((o) => e.role.test(o.split('/')[1] ?? '')));
    expect(stale.map((e) => String(e.role))).toEqual([]);
  });

  it('each admin-plane role holds its membership changes on a classified channel, bearing only the service admin', () => {
    for (const { role } of ADMIN_PLANE_ROLES) {
      const found = stacks.flatMap(({ tpl }) => {
        const resources = tpl.toJSON().Resources as Record<string, any>;
        return [...statementsByRole(tpl)].filter(([id]) => role.test(id)).map(([id, statements]) => {
          const membership = statements.filter((s) => s.Effect === 'Allow'
            && asList(s.Action).some((a: string) => CHANGES.some((c) => glob(a, 'i').test(c))));
          const rs = membership.flatMap((s) => asList(s.Resource).map((r) => flatten(r, resources)));
          return [id, rs.includes(`${APP}/channel/*`), rs.filter((r) => !r.endsWith('/channel/*')).sort()] as const;
        });
      });
      expect([String(role), found.length > 0]).toEqual([String(role), true]);
      for (const [id, channelLeg, bearers] of found) {
        expect([id, channelLeg, bearers]).toEqual([id, true, [SERVICE_ADMIN]]);
      }
    }
  });
  // A role's own values, each one it may act in; or (a shared role) a channel that carries a classification,
  // with the admin plane excluded for a role that is not the admin plane's.
  const conditioned = (s: any, roleId = ''): boolean => {
    const adminPlane = ADMIN_PLANE_ROLES.some((e) => e.role.test(roleId));
    const reach = classificationReachOf(s.Condition);
    if (!reach) return false;
    if (reach.any) return adminPlane || profiles.adminPlaneValues().every((v) => reach.except.includes(v));
    const allowed = adminPlane ? DECLARED : CONVERSATIONAL;
    return reach.values.every((v) => allowed.includes(v));
  };

  function offenders(tpl: Template, stack: string, exempting = true): string[] {
    const resources = tpl.toJSON().Resources as Record<string, any>;
    const out: string[] = [];
    for (const [roleId, statements] of statementsByRole(tpl)) {
      if (exempting && EXEMPT.some((e) => e.role.test(roleId))) continue;
      for (const s of statements) {
        if (s.Effect !== 'Allow') continue;
        const hit = s.NotAction !== undefined
          ? CHANGES.some((a) => !asList(s.NotAction).some((p: string) => glob(p, 'i').test(a)))
          : CHANGES.some((a) => asList(s.Action).some((p: string) => glob(p, 'i').test(a)));
        if (!hit) continue;
        const where = `${stack}/${roleId} ${s.Sid ?? '(no sid)'}`;
        if (s.NotResource !== undefined) { out.push(`${where}: NotResource`); continue; }
        for (const r of asList(s.Resource).map((x) => flatten(x, resources))) {
          const ok = ((r === `${APP}/channel/*` || r === `${APP}/bot/*`) && conditioned(s, roleId)) || r === SERVICE_ADMIN;
          if (!ok) out.push(`${where}: ${r}${conditioned(s, roleId) ? '' : ' (no classification condition)'}`);
        }
      }
    }
    return out;
  }

  it('no role in any template changes membership on an unconditioned resource', () => {
    expect(stacks.flatMap(({ stack, tpl }) => offenders(tpl, stack))).toEqual([]);
  });

  it('the creators that bear the service admin hold the change on both legs, and no bot-bearing create', () => {
    const creators: Array<[string, RegExp]> = [
      ['Assistants-premium', /^ConversationCreatorRole/],
      ['Assistants-premium', /^ConversationSplitRole/],
      ['Assistants-premium', /^TypedConversationFromEventRole/],
      ['Assistants-premium', /^AgentHandlerRole/],
      // Step 37: the proactive briefing and a host's add-member create through the shared creator.
      ['Notifications', /^ProactiveBriefingRole/],
      ['Conversations', /^ConversationMembershipRole/],
    ];
    for (const [stackName, role] of creators) {
      const { tpl } = stacks.find((x) => x.stack === stackName)!;
      const resources = tpl.toJSON().Resources as Record<string, any>;
      const mine = [...statementsByRole(tpl)].filter(([id]) => role.test(id));
      expect([stackName, String(role), mine.length > 0]).toEqual([stackName, String(role), true]);
      for (const [roleId, statements] of mine) {
        const membership = statements.filter((s) => s.Effect === 'Allow'
          && asList(s.Action).some((a: string) => glob(a, 'i').test('chime:CreateChannelMembership')));
        const rs = membership.flatMap((s) => asList(s.Resource).map((r) => flatten(r, resources)));
        expect([roleId, membership.length > 0]).toEqual([roleId, true]);
        expect([roleId, rs.includes(SERVICE_ADMIN), rs.includes(`${APP}/channel/*`)]).toEqual([roleId, true, true]);
        expect([roleId, rs.some((r) => /\/bot\/|\/user\/\*|\/\*$/.test(r) && r !== `${APP}/channel/*`)]).toEqual([roleId, false]);
        const creates = statements.filter((s) => s.Effect === 'Allow' && asList(s.Action).some((a: string) => glob(a, 'i').test('chime:CreateChannel')));
        for (const s of creates) {
          const where = `${roleId} ${s.Sid ?? ''}`;
          expect([where, grants(s, ['chime:CreateChannel'], PROBE.bot, resources)]).toEqual([where, false]);
          expect([where, grants(s, ['chime:CreateChannel'], PROBE.person, resources, 'pinned')]).toEqual([where, false]);
        }
      }
    }
  });

  it('no role in any template can create a conversation bearing an assistant (steps 33, 37 and 38)', () => {
    // A conversation is created only as the service admin, so the flow is attached before any assistant
    // is a member. A `CreateChannel` grant whose resources reach a bot would let a role create as one.
    // The one channel an assistant creates is the admin notification channel, which the admin assistant
    // owns by design (DESIGN-ADMIN-AGENT-NOTIFICATIONS); it is not a conversation, and its grant reaches
    // only a bot carrying an admin-plane classification, which only the admin assistant does.
    const ADMIN_PLANE = profiles.adminPlaneValues();
    const adminAgentOnly = (s: any) => {
      const values = asList<string>(s.Condition?.StringEquals?.['aws:ResourceTag/classification']);
      return values.length > 0 && values.every((v) => ADMIN_PLANE.includes(v));
    };
    const offending = stacks.flatMap(({ stack, tpl }) => {
      const resources = tpl.toJSON().Resources as Record<string, any>;
      return [...statementsByRole(tpl)].flatMap(([roleId, statements]) => statements
        .filter((s) => grants(s, ['chime:CreateChannel'], PROBE.bot, resources) && !adminAgentOnly(s))
        .map((s) => `${stack}/${roleId} ${s.Sid ?? '(no sid)'}`));
    });
    expect(offending).toEqual([]);
  });

  it('every CreateChannel grant requires the classification tag in the request, at declared values (step 39)', () => {
    // An untagged create, or one tagged with a classification the role does not own, is refused at the
    // create itself rather than only at the `TagResource` it also authorizes.
    const offending = stacks.flatMap(({ stack, tpl }) => [...statementsByRole(tpl)].flatMap(([roleId, statements]) => statements
      .filter((s) => s.Effect === 'Allow' && asList(s.Action).some((a: string) => glob(a, 'i').test('chime:CreateChannel')))
      .filter((s) => {
        const requested = asList<string>(s.Condition?.StringEquals?.['aws:RequestTag/classification']);
        const present = String(s.Condition?.Null?.['aws:RequestTag/classification']) === 'false';
        return !(present && requested.length > 0 && requested.every((v) => DECLARED.includes(v)));
      })
      .map((s) => `${stack}/${roleId} ${s.Sid ?? '(no sid)'}`)));
    expect(offending).toEqual([]);
  });

  it('each person-facing creator creates only its own classification, and the API creates nothing (step 39)', () => {
    const { tpl } = stacks.find((x) => x.stack === 'Conversations')!;
    const byRole = statementsByRole(tpl);
    // Each classification's creator is its own stack's.
    const withStacks = CONVERSATIONAL.filter((c) => stacks.some((x) => x.stack === `Assistants-${c}`));
    expect(withStacks.length).toBeGreaterThan(1);
    for (const c of withStacks) {
      const own = statementsByRole(stacks.find((x) => x.stack === `Assistants-${c}`)!.tpl);
      const role = [...own].find(([id]) => /^ConversationCreatorRole[0-9A-F]{8}$/.test(id));
      expect([c, role !== undefined]).toEqual([c, true]);
      const creates = role![1].filter((s) => s.Effect === 'Allow' && asList(s.Action).includes('chime:CreateChannel'));
      expect([c, creates.length > 0]).toEqual([c, true]);
      for (const s of creates) expect([c, s.Condition.StringEquals['aws:RequestTag/classification']]).toEqual([c, [c]]);
    }
    const api = [...byRole].find(([id]) => /^CreateConversationApiRole/.test(id))!;
    // It holds no Amazon Chime SDK action at all: the edge authorizer names its caller, and the
    // creators it invokes do the creating. It writes nothing.
    const chime = api[1].filter((s) => asList(s.Action).some((a: string) => a.startsWith('chime:')));
    expect(chime.flatMap((s) => asList<string>(s.Action))).toEqual([]);
  });

  it('no grant can write an existing conversation\'s classification (step 39)', () => {
    // A `TagResource` reaching a channel either writes no `classification` key at all, or is held only
    // where the channel carries none yet (a create) or already carries the value requested.
    // The one role left out is the deploy-time provider `cdk-amazon-chime-resources` builds for the app
    // instance itself: CloudFormation assumes it to create the instance, and no handler runs on it.
    const DEPLOY_TIME_PROVIDER = /^CustomMessagingResourcesCustomResourceProviderRole/;
    const offending = stacks.flatMap(({ stack, tpl }) => {
      const resources = tpl.toJSON().Resources as Record<string, any>;
      return [...statementsByRole(tpl)].filter(([roleId]) => !DEPLOY_TIME_PROVIDER.test(roleId)).flatMap(([roleId, statements]) => statements
        .filter((s) => grants(s, ['chime:TagResource'], [`${APP}/channel/probe`], resources))
        .filter((s) => {
          const keysOnly = asList<string>(s.Condition?.['ForAllValues:StringEquals']?.['aws:TagKeys']);
          if (keysOnly.length && !keysOnly.includes('classification')) return false;
          const requested = asList<string>(s.Condition?.StringEquals?.['aws:RequestTag/classification']);
          const current = asList<string>(s.Condition?.StringEqualsIfExists?.['aws:ResourceTag/classification'] ?? s.Condition?.StringEquals?.['aws:ResourceTag/classification']);
          return !(requested.length > 0 && current.length > 0 && requested.every((v) => current.includes(v)));
        })
        .map((s) => `${stack}/${roleId} ${s.Sid ?? '(no sid)'}`));
    });
    expect(offending).toEqual([]);
  });

  it('a throwaway role given the old app-instance grant is refused', () => {
    const stack = new cdk.Stack(new cdk.App(), 'ThrowawayMembership', { env });
    new iam.Role(stack, 'ThrowawayMembershipRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: { Members: new iam.PolicyDocument({ statements: [new iam.PolicyStatement({
        actions: ['chime:CreateChannelMembership'], resources: [`${APP}/*`],
      })] }) },
    });
    expect(offenders(Template.fromStack(stack), 'Throwaway').map((o) => o.replace(/[0-9A-F]{8} /, ' '))).toEqual([
      `Throwaway/ThrowawayMembershipRole (no sid): ${APP}/* (no classification condition)`,
    ]);
  });
});

describe('only the handlers the list names import a speaking helper (source)', () => {
  // The helpers that make a component speak: the three that vend for a service, the two the processor
  // and arrival triage vend through, and the one an alert is posted into the admin channel through. Raising
  // an alert (`postAdminNotice`) is an event and speaks as nobody, so it is not guarded.
  const GUARDED = [
    'messagingClientAsAssistant', 'speakAsRoutedAssistant', 'sessionForRoutedAssistant',
    'adoptSessionAsAssistant', 'vendAssistantSession', 'deliverAdminNotice',
  ];
  // Where they are defined, which is not a use.
  const DEFINED_IN = ['lambda/src/lib/assistant-session.ts', 'lambda/src/lib/admin-channel-post.ts'];
  const root = path.join(__dirname, '..');

  function sources(dir: string): string[] {
    return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : sources(rel);
      return /\.(ts|js|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [rel] : [];
    });
  }

  it('a file importing one is a handler of a declared speaker', () => {
    const named = new Set(SPEAKERS.flatMap((s) => s.handlers));
    const importers = sources('lambda').filter((f) => !DEFINED_IN.includes(f)).filter((f) => {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      // An import, a dynamic import or a require that names the helper, whatever the module path.
      const imports = src.match(/(?:import\s*\{[^}]*\}\s*from|const\s*\{[^}]*\}\s*=\s*(?:await\s+import|require)\()[^;]*/g) ?? [];
      return imports.some((stmt) => GUARDED.some((h) => new RegExp(`\\b${h}\\b`).test(stmt)));
    });
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((f) => !named.has(f))).toEqual([]);
  });

  it('every handler the list names exists and imports one', () => {
    for (const f of SPEAKERS.flatMap((s) => s.handlers)) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      expect([f, GUARDED.some((h) => new RegExp(`\\b${h}\\b`).test(src))]).toEqual([f, true]);
    }
  });
});

describe('one classification tag key (step 9)', () => {
  // Channels, identities and sessions carry `classification`; a resource tagged or a condition keyed
  // `Classification` splits cost lines into two keys and leaves a condition whose match depends on how IAM
  // folds case (`scripts/deny-test-tag-key-case.mjs`). EMF dimension names are metrics, not tags, and exempt.
  it('no resource carries a Classification tag and no condition reads one', () => {
    const offenders: string[] = [];
    for (const { stack, tpl } of stacks) {
      for (const [id, r] of Object.entries(tpl.toJSON().Resources as Record<string, any>)) {
        const tags = r.Properties?.Tags;
        const keys = Array.isArray(tags) ? tags.map((t: { Key?: string }) => t.Key) : Object.keys(tags ?? {});
        if (keys.includes('Classification')) offenders.push(`${stack}/${id}: tag`);
        if (/"aws:(Resource|Request|Principal)Tag\/Classification"/.test(JSON.stringify(r.Properties ?? {}))) offenders.push(`${stack}/${id}: condition`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
