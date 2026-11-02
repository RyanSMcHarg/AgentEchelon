/**
 * THE ROLE THAT REACHES SOMETHING ITS SIBLINGS DO NOT, PROVEN NOT TO REACH ANYTHING ELSE.
 *
 * `(premium, ops)` is the first assistant role granted a reach its classification's primary is
 * refused: this deployment's own Amazon CloudWatch metrics and logs. A new reach is exactly the
 * situation tenet P4 wants proven by a DENY-TEST rather than by reading a policy.
 *
 * ── ONE ACTING ROLE, CUT BY THE SESSION'S TAGS ──────────────────────────────────────────────────
 *
 * Every premium assistant acts through the same acting role. What separates an ops session from a
 * primary one is the `role` tag the vend stamps on the session, and what separates one assistant from
 * another is the `bot` tag, which the bearer grant uses as an ARN variable
 * (`…/bot/${aws:PrincipalTag/bot}`). So every question here is asked of the one deployed role, with
 * the tags a real session would carry, and the answers differ only because the tags do.
 *
 * ── WHY BOTH DIRECTIONS, IN ONE FILE ────────────────────────────────────────────────────────────
 *
 * A denial-only file passes just as well when the grant is broken, and this grant has two independent
 * ways to be broken that both LOOK like success: a wrong condition key matches nothing and denies
 * every session including the ops one, and an absent condition grants the reach to every assistant in
 * the classification. So the positive control - ops IS allowed the metric read - sits beside the
 * denials, and neither is meaningful without the other.
 *
 * ── WHAT IT SIMULATES, AND WHY THAT IS THE RIGHT INSTRUMENT ─────────────────────────────────────
 *
 * `iam simulate-principal-policy` against the DEPLOYED acting role, which evaluates its permissions
 * boundary as well as its own policies. The role trusts only its classification's vend, so this test
 * cannot assume it, and should not: an entitlement question is answered by IAM, not by trying.
 *
 * Resource tags are SUPPLIED rather than looked up, because the simulator cannot fetch Amazon Chime SDK
 * resource tags and a condition on an absent key changes the answer - which would make an assertion
 * here pass for the wrong reason. Each bot is simulated with the tag it actually carries, read from
 * the deployment first.
 *
 * **Coverage:** `e2e/an-ops-role-reaches-only-its-own-classification.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import {
  REGION, TAG, NO_AWS_REASON, awsReachable, awsOrNull, actingRole, botFor, appInstanceArn,
  decide, ctx, sessionContext, processorRoleArn, contextBucket, awsJson, SSM_ROOT,
} from './helpers/assistant-acting-role';

// THE SUITE-WIDE BACKEND GUARD, INSTALLED EVEN THOUGH THIS FILE DRIVES NO TURN. Every spec installs
// it, and the guard test enforces that rather than trusting each author to judge whether their file
// needs one - which is right: a file that starts out only reading IAM and later grows a turn would
// otherwise be the single spec silently not watching for handler errors.
//
// The CONSOLE guard is deliberately absent: it is required only of browser-driving specs, and this one
// opens no page.
guardBackendErrors('ops-role-cut');

/** The observability reads the ops grant names. */
const OPS_READS = ['cloudwatch:GetMetricData', 'cloudwatch:DescribeAlarms'];

/** What an assistant does in a conversation, which is what must stay inside its own classification. */
const CHANNEL_ACTIONS = ['chime:SendChannelMessage', 'chime:ListChannelMessages'];

/**
 * IS THE ROLE DECLARED AT ALL? The `ops` role is declared per deployment (`ops-premium` in `profiles`), and the acting
 * role's trust policy names every assistant role the vend may mint (`aws:RequestTag/role`). A
 * deployment that never asked for ops has no ops session to simulate.
 *
 * SKIPPED BY NAME rather than failed, and that distinction is the whole reason this is a function: a
 * deployment without the role and a deployment whose role is broken must not look the same in a run
 * summary.
 */
function opsMissingReason(): string | null {
  if (!awsReachable()) return NO_AWS_REASON;
  const role = actingRole('premium');
  if (!role) return null; // Not a skip: a reachable deployment with no premium acting role is a failure below.
  return role.declaredRoles.includes('ops')
    ? null
    : 'the premium acting role does not declare an ops role; declare it with npm run add-assistant-role (ops-premium in profiles)';
}

/** The premium acting role, asserted present. */
function premiumActingRole(): string {
  const role = actingRole('premium');
  expect(role, 'no deployed premium acting role under the assistant IAM path').toBeTruthy();
  return role!.arn;
}

/**
 * PRINT THE DOCUMENTS THE DECISIONS CAME FROM.
 *
 * A demo that says "the primary is denied" is asking to be believed. A demo that shows the statement
 * doing the denying, read back out of the deployment, can be checked by the person watching - and the
 * whole claim of this platform is that access is decided by policy somebody can read rather than by
 * code somebody has to trust.
 *
 * READ BACK FROM AWS, NOT FROM THE REPOSITORY. What matters is what is deployed.
 */
function printDeployedPolicies(roleArn: string): void {
  const name = roleArn.split('/').pop() || '';
  const inline: string[] = awsOrNull(`iam list-role-policies --role-name ${name} --query "PolicyNames"`) || [];

  console.log('\n──────── THE PREMIUM ACTING ROLE, AS DEPLOYED ────────');
  console.log(`role: ${name}`);

  // THE GRANTS: what the role itself allows, each conditioned on the session's tags where it varies.
  for (const policyName of inline) {
    const doc = awsOrNull(`iam get-role-policy --role-name ${name} --policy-name ${policyName} --query "PolicyDocument"`);
    for (const st of (doc?.Statement ?? [])) {
      if (!/^(RoleObservability|RoleContext|ActOnly)/.test(st.Sid || '')) continue;
      const actions = ([] as string[]).concat(st.Action || []);
      console.log(`  [grant] ${st.Sid} ${st.Effect} ${actions.length} action(s)`);
      console.log(`          resource : ${JSON.stringify(st.Resource)}`);
      if (st.Condition) console.log(`          condition: ${JSON.stringify(st.Condition)}`);
    }
  }

  // THE BOUNDARY: everything the classification permits, and the Denies that cut it.
  const boundaryArn = awsOrNull(`iam get-role --role-name ${name} --query "Role.PermissionsBoundary.PermissionsBoundaryArn"`);
  if (typeof boundaryArn === 'string') {
    const version = awsOrNull(`iam get-policy --policy-arn ${boundaryArn} --query "Policy.DefaultVersionId"`);
    const doc = awsOrNull(`iam get-policy-version --policy-arn ${boundaryArn} --version-id ${version} --query "PolicyVersion.Document"`);
    console.log(`  boundary: ${String(boundaryArn).split('/').pop()}`);
    for (const st of (doc?.Statement ?? [])) {
      const actions = ([] as string[]).concat(st.Action || []);
      const cond = st.Condition ? ` when ${JSON.stringify(st.Condition)}` : ' (unconditioned)';
      console.log(`  [boundary] ${st.Sid || '(no sid)'} ${st.Effect} ${actions.length} action(s)${cond}`);
    }
  }
  console.log('──────────────────────────────────────────────────────\n');
}

/** An alarm this deployment publishes by name (`lib/constructs/alarm-names.ts`), as an ARN. */
function deploymentAlarmArn(): string | null {
  const params = awsJson(`ssm get-parameters-by-path --path ${SSM_ROOT}/alarms --recursive --region ${REGION}`)?.Parameters || [];
  const name = params.map((p: any) => String(p.Value).split(',')[0]).find(Boolean);
  const account = appInstanceArn()?.split(':')[4];
  return name && account ? `arn:aws:cloudwatch:${REGION}:${account}:alarm:${name}` : null;
}

test.describe('an ops role reaches its own classification and nothing else', () => {
  test('an ops session is allowed the observability reads, and a primary or untagged session is not', async () => {
    test.setTimeout(180_000);
    test.skip(!!opsMissingReason(), opsMissingReason() || '');
    const role = premiumActingRole();
    const ops = botFor('premium', 'ops');
    const primary = botFor('premium', 'primary');
    // A missing bot is not fatal for a telemetry read, which is not bound to a bot; a placeholder id
    // keeps the session's tag set the same shape a real turn carries.
    const opsBot = ops?.botId || 'ops-probe-bot';
    const primaryBot = primary?.botId || 'primary-probe-bot';

    // SHOWN BEFORE THE ASSERTIONS, so a demo viewer reads the policy and then watches it decide,
    // rather than being told the outcome and asked to take the policy on faith.
    printDeployedPolicies(role);

    // THE RESOURCE EACH READ IS ASKED ABOUT. Metric reads have no resource type and are granted on `*`;
    // `DescribeAlarms` is granted on this deployment's alarm ARNs, so it is simulated against an alarm
    // the deployment publishes, which is what the tool's by-name call is authorized against.
    const alarmArn = deploymentAlarmArn();
    expect(alarmArn, 'the deployment publishes no alarm names under its alarms path').toBeTruthy();
    const resourceOf = (action: string) => (action === 'cloudwatch:DescribeAlarms' ? alarmArn! : '*');

    const violations: string[] = [];
    for (const action of OPS_READS) {
      const resource = resourceOf(action);
      // THE POSITIVE CONTROL. Without it a broken condition key - which denies everyone, including
      // ops - would satisfy every denial below and this file would report a working boundary.
      const asOps = decide(role, action, resource, sessionContext('premium', 'ops', opsBot));
      if (asOps !== 'allowed') {
        violations.push(`an ops session is ${asOps} for ${action}; the grant is not reaching the role tag`);
      }
      // THE CUT ITSELF: the same role, the same classification, a different role tag, refused.
      const asPrimary = decide(role, action, resource, sessionContext('premium', 'primary', primaryBot));
      if (asPrimary === 'allowed') {
        violations.push(`a premium PRIMARY session is allowed ${action}; the grant is not role-conditioned`);
      }
      // AND A SESSION WITH NO ROLE TAG. The trust policy refuses to mint one, but the grant must not
      // depend on that: an Allow conditioned on the tag, and the boundary's Deny on its absence, both
      // fail closed for such a session.
      const untagged = decide(role, action, resource, [ctx(TAG.classification, 'premium'), ctx(TAG.bot, opsBot)]);
      if (untagged === 'allowed') {
        violations.push(`a session with NO role tag is allowed ${action}; the condition is not gating`);
      }
    }
    // AND ONLY THIS DEPLOYMENT'S ALARMS: another application's alarm in the same account, and the
    // listing scope (`alarm:*`), are refused to the same ops session that reads its own.
    for (const other of [':alarm:another-application-alarm', ':alarm:*']) {
      const resource = alarmArn!.replace(/:alarm:.*$/, other);
      if (decide(role, 'cloudwatch:DescribeAlarms', resource, sessionContext('premium', 'ops', opsBot)) === 'allowed') {
        violations.push(`an ops session is allowed DescribeAlarms on ${resource}; the alarm grant is not scoped to this deployment`);
      }
    }
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  test('an ops session acts only as its own bot: never its classification\'s primary, never another classification\'s', async () => {
    test.setTimeout(180_000);
    test.skip(!!opsMissingReason(), opsMissingReason() || '');
    const role = premiumActingRole();

    const own = botFor('premium', 'ops');
    const premiumPrimary = botFor('premium', 'primary');
    const standardPrimary = botFor('standard', 'primary');
    expect(own?.botArn, 'no assistant is assigned to (premium, ops)').toBeTruthy();
    expect(premiumPrimary?.botArn, 'no assistant is assigned to (premium, primary)').toBeTruthy();
    expect(standardPrimary?.botArn, 'no assistant is assigned to (standard, primary)').toBeTruthy();

    const session = sessionContext('premium', 'ops', own!.botId);
    const violations: string[] = [];
    for (const action of CHANNEL_ACTIONS) {
      // POSITIVE: it may act as the bot its session was minted for.
      const ownDecision = decide(role, action, own!.botArn, [...session, ctx(TAG.resourceClassification, own!.classificationTag)]);
      if (ownDecision !== 'allowed') {
        violations.push(`an ops session cannot act as its OWN bot for ${action} (${ownDecision}); it can do nothing`);
      }
      // DENY, SAME CLASSIFICATION: the one a classification tag alone cannot catch, because both bots
      // carry `premium`. Only the `${aws:PrincipalTag/bot}` variable in the bearer grant refuses it.
      const sibling = decide(role, action, premiumPrimary!.botArn, [...session, ctx(TAG.resourceClassification, premiumPrimary!.classificationTag)]);
      if (sibling === 'allowed') {
        violations.push(`an ops session is allowed to act as the premium PRIMARY's bot for ${action}; it could post as the advisor`);
      }
      // DENY, ACROSS CLASSIFICATIONS: the boundary ADR-042 binds.
      const cross = decide(role, action, standardPrimary!.botArn, [...session, ctx(TAG.resourceClassification, standardPrimary!.classificationTag)]);
      if (cross === 'allowed') {
        violations.push(`an ops session is allowed to act as a STANDARD bot for ${action}; an assistant reached another classification`);
      }
    }
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  test('an ops session cannot act in another classification\'s conversations', async () => {
    test.setTimeout(180_000);
    test.skip(!!opsMissingReason(), opsMissingReason() || '');
    const role = premiumActingRole();

    // A CHANNEL ARN PATTERN RATHER THAN A REAL CHANNEL, because the question is about the tag and not
    // about a particular room: the grant is `…/channel/*` conditioned on `aws:ResourceTag/classification`,
    // so simulating one arbitrary channel arn with each tag value asks exactly the right question and
    // creates nothing that has to be cleaned up.
    const appInstance = appInstanceArn();
    expect(appInstance, 'no assigned bot to read the app instance from').toBeTruthy();
    const channel = `${appInstance}/channel/00000000-0000-0000-0000-000000000000`;
    const opsBot = botFor('premium', 'ops')?.botId || 'ops-probe-bot';
    const session = sessionContext('premium', 'ops', opsBot);

    const violations: string[] = [];
    for (const action of CHANNEL_ACTIONS) {
      const inOwn = decide(role, action, channel, [...session, ctx(TAG.resourceClassification, 'premium')]);
      if (inOwn !== 'allowed') {
        violations.push(`an ops session cannot act in a PREMIUM conversation for ${action} (${inOwn}); it could not answer at all`);
      }
      for (const other of ['standard', 'basic']) {
        const decision = decide(role, action, channel, [...session, ctx(TAG.resourceClassification, other)]);
        if (decision === 'allowed') {
          violations.push(`an ops session is allowed ${action} in a ${other.toUpperCase()} conversation; ADR-042 is not holding`);
        }
      }
    }
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
    console.log(`[ops-cut] region ${REGION}: an ops session acts in premium only, as its own bot only`);
  });

  // ── COMPANY CONTEXT IS READ PER ROLE (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION Phase 1b, the S3 edge) ──
  //
  // The gate the design states: a session is DENIED a context/ prefix its classification grants but its
  // role does not. Premium grants basic, standard and premium context; the ops role is scoped to basic and
  // standard (`roleContext` in profiles.ts), so an ops session must be refused premium's financials. The
  // positive controls beside it are what keep a broken grant - which would deny everything - from reading
  // as a working boundary: ops still reads standard context, and the primary still reads premium's.
  test('company context is read per role: ops is refused premium context, the primary keeps it, the processor reads none', async () => {
    test.setTimeout(180_000);
    test.skip(!!opsMissingReason(), opsMissingReason() || '');
    const role = premiumActingRole();
    const processorRole = processorRoleArn('premium');
    const bucket = contextBucket('premium');
    expect(processorRole && bucket, 'could not read the premium processor role and context bucket').toBeTruthy();
    const doc = (key: string) => `arn:aws:s3:::${bucket}/${key}`;
    const premiumDoc = doc('context/premium/financial-data.json');
    const standardDoc = doc('context/standard/internal-processes.json');
    const opsSession = sessionContext('premium', 'ops', botFor('premium', 'ops')?.botId || 'ops-probe-bot');
    const primarySession = sessionContext('premium', 'primary', botFor('premium', 'primary')?.botId || 'primary-probe-bot');

    const violations: string[] = [];
    const expectDecision = (who: string, principal: string, context: string[], resource: string, want: 'allowed' | 'denied') => {
      const got = decide(principal, 's3:GetObject', resource, context);
      const ok = want === 'allowed' ? got === 'allowed' : got !== 'allowed';
      if (!ok) violations.push(`${who} is ${got} for s3:GetObject on ${resource.split(':::')[1]}; expected ${want}`);
    };
    // THE CUT: same role, same classification, ops refused what the primary reads.
    expectDecision('an ops session', role, opsSession, premiumDoc, 'denied');
    // Positive controls.
    expectDecision('an ops session', role, opsSession, standardDoc, 'allowed');
    expectDecision('a primary session', role, primarySession, premiumDoc, 'allowed');
    // THE PROCESSOR'S OWN ROLE is bootstrap only and holds no context/ grant at all.
    expectDecision('the processor role', processorRole!, [], premiumDoc, 'denied');
    expectDecision('the processor role', processorRole!, [], standardDoc, 'denied');

    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
    console.log('[ops-cut] company context: ops reads basic + standard, the primary reads premium, the processor reads none');
  });
});
