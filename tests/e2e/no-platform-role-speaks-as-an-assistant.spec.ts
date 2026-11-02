/**
 * NO PLATFORM SERVICE CAN POST AS AN ASSISTANT ON ITS OWN ROLE, AND ONLY A DECLARED ONE CAN ASK FOR A SESSION.
 *
 * Amazon Chime SDK does not bind the `ChimeBearer` to the caller: whoever holds
 * `chime:SendChannelMessage` on a bot resource can post as that bot. So every service that speaks as an
 * assistant outside a user turn - the scheduled briefing, a federated join notice, Battle Mode's on and
 * off notices, a share's announcement, arrival triage - asks the classification's vend for that one
 * assistant's session instead (`messagingClientAsAssistant`, `speakAsAssistantStatements`). Its own role
 * holds no send bearing a bot.
 *
 * DEFAULT-REFUSE, ACROSS EVERY ROLE THE DEPLOYMENT OWNS. This used to check
 * the roles a list here named, so a new role that spoke was unchecked until someone remembered to add it.
 * It now enumerates every IAM role carrying the stack prefix and asks AWS, for each one whose policies
 * could grant it at all:
 *
 * - may it invoke a classification's vend? Only a role declared in `backend/lib/config/speakers.ts` may,
 *   the same list `backend/test/only-declared-speakers-can-speak.test.ts` holds the templates to;
 * - may it send bearing a classification's assistant? Only the acting role may;
 * - may it send bearing a person? None may. The membership audit's role once held exactly that.
 *
 * Roles are traced to their construct ids through CloudFormation, so a deployed role and a synthesized one
 * are matched by the same rule. Which roles were checked is printed, so a run that checked nothing shows it.
 *
 * AND MEMBERSHIP CHANGES BEARING AN ASSISTANT STAY INSIDE A CONVERSATION OF THIS DEPLOYMENT (step 24). The
 * share, Battle Mode and federated sharing roles add and remove members bearing a bot. Each must be
 * refused on an untagged or admin-plane channel, bearing an untagged or admin-plane bot, and bearing a
 * person. The share and Battle Mode roles serve every conversation, so they reach a channel and a bot by
 * the `classification` tag being present, never by a listed set (ADR-057 decision 6); what keeps them off
 * an outside conversation is the channel's `audience` tag, so they must also be refused on a channel whose
 * audience is `outside` or absent. The federated role names its one classification, so it alone is also
 * refused on any other classification's conversation and bearing a bot of an undeclared one. For a
 * presence-scoped role, a bot of an undeclared classification cannot exist in this app instance: every
 * provisioner may stamp only a declared value (`assistantProvisioningAllow`). The member being added is a
 * request parameter IAM never sees, which `membershipAsAssistantStatements` records.
 *
 * A role that is not deployed (a feature left off) is reported and skipped, never counted as a pass.
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import {
  TAG, CLASSIFICATIONS, NO_AWS_REASON, STACK_PREFIX, SSM_ROOT,
  awsReachable, awsOrNull, botFor, decide, ctx, appInstanceArn, actingRole,
} from './helpers/assistant-acting-role';
import { speakerFor } from '../../backend/lib/config/speakers';
import { instanceStacks, classificationStacks, resourcesIn, physicalIdsIn, ANY_ROLE, type StackResource } from './helpers/stack-prefix';
import { aws } from './helpers/aws';

const awsLarge = (args: string): any => aws(args, { timeoutMs: 300_000, maxBufferMb: 256, quiet: true });

guardBackendErrors('no-platform-role-speaks-as-an-assistant');

/**
 * Every IAM role in this deployment's stacks, with its logical id. Read from the stacks rather than
 * matched on the generated role names (helpers/stack-prefix.ts), once per run: several tests ask.
 */
let instanceRoleRows: StackResource[] | null = null;
function instanceRoles(): StackResource[] {
  if (!instanceRoleRows) {
    try {
      instanceRoleRows = resourcesIn(instanceStacks(), ANY_ROLE);
    } catch {
      instanceRoleRows = [];
    }
  }
  return instanceRoleRows;
}

/** The deployed roles whose construct id carries `part`, in this deployment's stacks. */
function rolesNamed(part: string): Array<{ RoleName: string; Arn: string }> {
  return instanceRoles()
    .filter((r) => r.LogicalResourceId.includes(part))
    .map((r) => ({ RoleName: r.PhysicalResourceId, Arn: awsOrNull(`iam get-role --role-name ${r.PhysicalResourceId} --query "Role.Arn"`) }))
    .filter((r): r is { RoleName: string; Arn: string } => typeof r.Arn === 'string' && r.Arn.startsWith('arn:'));
}

const asList = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : ([] as T[]).concat(v));
const docOf = (d: unknown): any => (typeof d === 'string' ? JSON.parse(decodeURIComponent(d)) : d);
const glob = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

/** The actions a role is simulated for. A role whose policies cannot name any of them is not simulated. */
const PROBED_ACTIONS = ['lambda:InvokeFunction', 'chime:SendChannelMessage'];
/** AWS managed policies that grant neither, so attaching one does not make a role worth simulating. */
const INERT_AWS_MANAGED = /:policy\/service-role\/AWSLambda(Basic|VPCAccess|Kinesis)ExecutionRole$/;

interface PrefixedRole { name: string; arn: string; logicalId: string | null; mayGrant: boolean }

/**
 * Every role in this deployment's stacks, with the construct id CloudFormation knows it by and whether any
 * of its policies could grant a probed action. The second is a filter for cost only and errs wide: an
 * AWS managed policy, an attached policy this read could not see, or any wildcard counts as could.
 */
function prefixedRoles(): PrefixedRole[] {
  const details = awsLarge(
    'iam get-account-authorization-details --filter Role LocalManagedPolicy '
    + `--query "{R: RoleDetailList[].{N: RoleName, A: Arn, I: RolePolicyList[].PolicyDocument, M: AttachedManagedPolicies[].PolicyArn}, `
    + 'P: Policies[].{Arn: Arn, D: PolicyVersionList[?IsDefaultVersion].Document}}"',
  ) || { R: [], P: [] };
  const managed = new Map<string, any>((details.P || []).map((p: any) => [p.Arn, docOf(asList(p.D)[0])]));
  const couldGrant = (doc: any) => asList(doc?.Statement).some((s: any) => s.Effect === 'Allow' && (
    s.NotAction !== undefined || asList(s.Action).some((a: string) => PROBED_ACTIONS.some((p) => glob(a).test(p)))));

  // Logical ids, from every stack this deployment owns. Membership in those stacks is what makes a role
  // this deployment's: another instance in the account can share any name prefix.
  const logical = new Map<string, string>(instanceRoles().map((r) => [r.PhysicalResourceId, r.LogicalResourceId]));

  return (details.R || []).filter((r: any) => logical.has(r.N)).map((r: any) => ({
    name: r.N,
    arn: r.A,
    logicalId: logical.get(r.N) ?? null,
    mayGrant: asList(r.I).map(docOf).some(couldGrant)
      || asList<string>(r.M).some((arn) => (arn.startsWith('arn:aws:iam::aws:') ? !INERT_AWS_MANAGED.test(arn) : !managed.has(arn) || couldGrant(managed.get(arn)))),
  }));
}

test.describe('no platform service posts as an assistant on its own role', () => {
  test.skip(!awsReachable(), NO_AWS_REASON);

  test('only a declared speaker may ask a vend for a session, only the acting role may send as an assistant, and no role as a person', async () => {
    test.setTimeout(1_200_000);
    const bots = CLASSIFICATIONS.map((c) => botFor(c, 'primary')).filter((b): b is NonNullable<typeof b> => !!b);
    expect(bots.length, 'no assigned assistant bots to simulate a send as').toBeGreaterThan(0);
    const vends = CLASSIFICATIONS.map((c) => ({
      classification: c,
      arn: awsOrNull(`ssm get-parameter --name "${SSM_ROOT}/assistant/${c}/vend-arn" --query "Parameter.Value"`) as string | null,
    })).filter((v): v is { classification: typeof CLASSIFICATIONS[number]; arn: string } => typeof v.arn === 'string');
    expect(vends.length, 'no classification vend to simulate an invoke on').toBeGreaterThan(0);
    const instance = appInstanceArn();
    expect(instance, 'the app instance ARN is unreadable').toBeTruthy();
    // A person nobody is: the policy decision does not depend on the user existing.
    const personBearer = `${instance}/user/deny-test-probe-person`;
    const actingArns = new Set(CLASSIFICATIONS.map((c) => actingRole(c)?.arn).filter(Boolean));

    const roles = prefixedRoles();
    expect(roles.length, `no role is in this deployment's stacks (prefix ${STACK_PREFIX})`).toBeGreaterThan(0);
    const simulated = roles.filter((r) => r.mayGrant);
    const violations: string[] = [];
    const speakers: string[] = [];
    for (const role of simulated) {
      const label = `${role.name} (${role.logicalId ?? 'no CloudFormation logical id'})`;
      const declared = role.logicalId ? speakerFor(role.logicalId) : undefined;
      const vendsReached = vends.filter((v) => decide(role.arn, 'lambda:InvokeFunction', v.arn, [
        // ONE SPELLING. IAM context keys are case-insensitive, so passing `Classification` beside
        // `classification` is refused by the simulator as a duplicate key; the deployment carries the one
        // lowercase key (`d38387e5`), and that is the key every grant conditions on.
        ctx(TAG.resourceClassification, v.classification),
      ]) === 'allowed');
      if (vendsReached.length) {
        if (declared) speakers.push(`${label}: ${declared.kind}`);
        else violations.push(`${label} may invoke the ${vendsReached.map((v) => v.classification).join(', ')} vend and is not a declared speaker`);
      }
      if (!actingArns.has(role.arn)) {
        for (const bot of bots) {
          const asBot = decide(role.arn, 'chime:SendChannelMessage', bot.botArn, [ctx(TAG.resourceClassification, bot.classificationTag)]);
          if (asBot === 'allowed') violations.push(`${label} may post as the ${bot.classificationTag} assistant (${bot.botArn})`);
        }
      }
      // AND NEVER AS A PERSON. Amazon Chime SDK authorizes a send against its bearer, so a send on
      // `user/*` is posting as anyone. A person's own credential is pinned by a policy variable this
      // probe never satisfies.
      if (decide(role.arn, 'chime:SendChannelMessage', personBearer) === 'allowed') violations.push(`${label} may post as a person (${personBearer})`);
    }
    console.log(`[no-speaking-role] ${roles.length} prefixed roles; ${simulated.length} could grant a probed action and were simulated`);
    console.log(`[no-speaking-role] declared speakers that reach a vend: ${speakers.join('; ') || 'none'}`);
    expect(simulated.length, 'no role was simulated, so nothing was checked').toBeGreaterThan(0);
    expect(speakers.length, 'no role reaches a vend, so the vend probe proves nothing').toBeGreaterThan(0);
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });
});

test.describe('a membership change bearing an assistant stays inside a declared classification', () => {
  test.skip(!awsReachable(), NO_AWS_REASON);

  /** The roles step 24 conditions, and the membership changes each makes. */
  // `listed`: the role's grant names its classifications, so a value outside them is refusable in IAM. The
  // others serve every conversation by tag presence (`EVERY_CLASSIFICATION`) and carry the audience denies.
  const MEMBERSHIP_ROLES: Array<{ part: string; actions: string[]; listed: boolean }> = [
    { part: 'ShareConversationRole', actions: ['chime:CreateChannelMembership'], listed: false },
    { part: 'ChannelBattleRole', actions: ['chime:CreateChannelMembership', 'chime:DeleteChannelMembership'], listed: false },
    { part: 'FederatedShareMemberRole', actions: ['chime:CreateChannelMembership', 'chime:DeleteChannelMembership'], listed: true },
  ];

  test('each is refused outside the declared classifications and allowed inside one', async () => {
    test.setTimeout(600_000);
    const instance = appInstanceArn();
    expect(instance, 'the app instance ARN is unreadable').toBeTruthy();
    const channel = `${instance}/channel/deny-test-probe-channel`;
    const bot = `${instance}/bot/deny-test-probe-bot`;
    const person = `${instance}/user/deny-test-probe-person`;
    const UNDECLARED = 'deny-test-undeclared';
    const ADMIN_PLANE = 'admin';
    const AUDIENCE = 'aws:ResourceTag/audience';
    const tagged = (value: string) => [ctx(TAG.resourceClassification, value)];
    // A member conversation as its creator stamps it: the classification and its declared audience, both in
    // the one `CreateChannel` (`createOwnClassificationOnly`). The probed classifications are member ones.
    const conversation = (value: string, audience = 'members') => [ctx(TAG.resourceClassification, value), ctx(AUDIENCE, audience)];

    const violations: string[] = [];
    const checked: string[] = [];
    for (const { part, actions, listed } of MEMBERSHIP_ROLES) {
      const roles = rolesNamed(part);
      if (!roles.length) {
        console.log(`[membership-as-assistant] ${part}: not deployed here; not checked`);
        continue;
      }
      for (const role of roles) {
        for (const action of actions) {
          const refused = (what: string, resource: string, context: string[] = []) => {
            if (decide(role.Arn, action, resource, context) === 'allowed') violations.push(`${role.RoleName} may ${action} ${what}`);
          };
          refused('in an untagged channel', channel);
          refused('in an untagged channel carrying an audience', channel, [ctx(AUDIENCE, 'members')]);
          refused('in an admin-plane channel', channel, conversation(ADMIN_PLANE));
          refused('bearing an untagged bot', bot);
          refused('bearing an admin-plane bot', bot, tagged(ADMIN_PLANE));
          refused('bearing a person', person);
          if (listed) {
            refused('in a channel of an undeclared classification', channel, conversation(UNDECLARED));
            refused('bearing a bot of an undeclared classification', bot, tagged(UNDECLARED));
          } else {
            // The second layer on a presence-scoped role, each probe on a conversation it would otherwise reach.
            for (const c of CLASSIFICATIONS) {
              refused(`in an outside conversation (${c})`, channel, conversation(c, 'outside'));
              refused(`in a conversation carrying no audience (${c})`, channel, tagged(c));
            }
          }
          // NOT INERT: some declared classification's conversation, bearing its assistant, is allowed.
          // The federated role serves exactly one, so every other is a violation for it.
          const inside = CLASSIFICATIONS.filter((c) => decide(role.Arn, action, channel, conversation(c)) === 'allowed'
            && decide(role.Arn, action, bot, tagged(c)) === 'allowed');
          if (!inside.length) violations.push(`${role.RoleName} may not ${action} in any classification's conversation, so the refusals above prove nothing`);
          if (part === 'FederatedShareMemberRole' && inside.length > 1) {
            violations.push(`${role.RoleName} may ${action} in ${inside.join(', ')}; it serves one classification`);
          }
        }
        checked.push(role.RoleName);
      }
    }
    console.log(`[membership-as-assistant] checked: ${checked.join(', ') || 'none'}`);
    expect(checked.length, 'no membership role was found to check').toBeGreaterThan(0);
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });
});

test.describe('post-processing reaches the routers and nothing else in the classification stacks', () => {
  test.skip(!awsReachable(), NO_AWS_REASON);

  test('it cannot invoke a classification processor', async () => {
    // Its rules dispatch through the routers. An invoke pattern over a whole assistant stack also reaches each
    // classification's processor and vend, outside the tag-conditioned vend grant.
    const roles = rolesNamed('PostProcessingRole');
    test.skip(!roles.length, 'post-processing is not deployed here');
    // Read from the classification stacks by construct id, not matched on the generated name.
    let processorNames: string[] = [];
    try {
      processorNames = physicalIdsIn(classificationStacks(), { type: 'AWS::Lambda::Function', logicalId: /^AsyncProcessor/ });
    } catch {
      processorNames = [];
    }
    const processors: string[] = processorNames
      .map((fn) => awsOrNull(`lambda get-function-configuration --function-name ${fn} --query "FunctionArn"`))
      .filter((arn: unknown): arn is string => typeof arn === 'string' && arn.startsWith('arn:'));
    expect(processors.length, 'no classification processor to simulate an invoke on').toBeGreaterThan(0);
    const allowed = roles.flatMap((role) => processors
      .filter((fn) => decide(role.Arn, 'lambda:InvokeFunction', fn) === 'allowed')
      .map((fn) => `${role.RoleName} may invoke ${fn}`));
    expect(allowed, `\n${allowed.join('\n')}\n`).toEqual([]);
  });
});
