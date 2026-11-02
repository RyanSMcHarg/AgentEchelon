/**
 * CLOUDWATCH IS READ BY AN OPS SESSION OR BY NO ASSISTANT AT ALL, AND THE BOUNDARY IS WHAT HOLDS IT.
 *
 * DESIGN-SEPARATE-ASSISTANTS 3.6 and Phase 1b. Every assistant of a classification acts through one
 * acting role, and the classification's permissions boundary caps whatever that role's own policies
 * grow to hold. That argument is only worth anything if the boundary actually caps, so this asks AWS
 * rather than reading the policy.
 *
 * ── WHY CLOUDWATCH IS THE RIGHT PROBE ───────────────────────────────────────────────────────────
 *
 * An operator's first questions are dashboards and log queries, so telemetry is the most plausible
 * thing for a future grant to reach for. `logs:FilterLogEvents` also reaches log CONTENT, which on this
 * platform can carry conversation text, so its denial matters for confidentiality and not only scope.
 *
 * ── THE SHAPE OF THE BOUNDARY ───────────────────────────────────────────────────────────────────
 *
 * The boundary allows the services a turn uses (`BoundaryTheServicesATurnUses`) and then DENIES:
 * telemetry reads to any session whose `role` tag is not an observability role
 * (`BoundaryTelemetryOnlyForObservabilityRoles`), and any IAM edit or role chaining
 * (`AnAssistantNeverEditsIdentityOrChains`). A Deny keyed on a negated condition also denies when the
 * key is absent, so a session with no role tag is refused rather than let through.
 *
 * ── TWO INSTRUMENTS, TWO QUESTIONS ──────────────────────────────────────────────────────────────
 *
 * `simulate-principal-policy` against the DEPLOYED acting role answers "what may a session do today",
 * and it evaluates the boundary along with the role's own grants. `simulate-custom-policy` with a
 * MAXIMALLY PERMISSIVE identity policy (`Allow *` on `*`) under the deployed boundary answers the
 * question a boundary exists for: *if the role's own grant were written as wide as it could possibly be,
 * by mistake or by an attacker, what would this classification still refuse?* A boundary caps and
 * never grants, so the second answer is the boundary itself.
 *
 * ── THE POSITIVE CONTROL IS HALF OF IT ──────────────────────────────────────────────────────────
 *
 * An ops session must come back ALLOWED the metric read. Without it, a boundary narrowed into
 * uselessness - or a condition key that matches nothing - reads exactly like success.
 *
 * IT FAILS UNTIL A DEPLOYMENT CARRIES THE ACTING ROLE, AND THAT IS DELIBERATE: a boundary that passes
 * before it is deployed is testing the tree rather than the account.
 */

import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { stackName, physicalIdsIn } from './helpers/stack-prefix';
import {
  STACK_PREFIX, TAG, CLASSIFICATIONS, NO_AWS_REASON, awsJson, awsReachable, actingRole, decide, ctx,
  sessionContext, processorRoleArn, handlerRoleArn,
} from './helpers/assistant-acting-role';

/**
 * A JSON DOCUMENT AS ONE SHELL ARGUMENT, QUOTED SO IT SURVIVES BOTH SHELLS.
 *
 * `execSync` runs through `cmd.exe` on Windows, where a single quote is an ORDINARY CHARACTER and not
 * a quoting one. Wrapping a policy document in single quotes therefore hands AWS a string that begins
 * and ends with a literal `'`, and the service rejects it as "Policy input list item N has invalid
 * content" - which reads like the POLICY is malformed. Escaped double quotes are understood by
 * `cmd.exe` and by POSIX shells alike.
 */
function jsonArg(value: unknown): string {
  return `"${JSON.stringify(value).replace(/"/g, '\\"')}"`;
}

/** The telemetry reads an ops assistant would actually call, not a token sample. */
const OPS_READS = [
  'cloudwatch:GetMetricData',
  'cloudwatch:GetMetricStatistics',
];

/**
 * Telemetry WRITES, and LOG READS. No assistant session may hold any of them, an ops one included. Log reads
 * were part of the ops grant and nothing ever called them, while they reached every log group in the account;
 * `logs:FilterLogEvents` also reaches conversation text.
 */
const WRITES = [
  'logs:StartQuery',
  'logs:FilterLogEvents',
  'cloudwatch:PutDashboard',
  'cloudwatch:DeleteDashboards',
  'cloudwatch:PutMetricAlarm',
  'cloudwatch:DeleteAlarms',
  'logs:DeleteLogGroup',
  'logs:PutRetentionPolicy',
  'logs:CreateLogGroup',
];

/** Every deployed role a PERSON acts through, for this instance only (other instances share the account). */
function userRoleArns(): Array<{ name: string; arn: string }> {
  // The roles the credential exchange vends a person (`ExchangeRole<Classification>`, the one-conversation
  // `ExchangeRoleRestricted` and the admin plane's), read from the Identity stack by construct id rather than
  // matched on the generated name: see helpers/stack-prefix.ts. There is no other way a person holds AWS
  // credentials.
  const names = physicalIdsIn([stackName('Identity')], { type: 'AWS::IAM::Role', logicalId: /^ExchangeRole/ });
  return names.map((name) => ({ name, arn: awsJson(`iam get-role --role-name ${name} --query "Role.Arn"`) as string }));
}

/** The deployed boundary's policy document for one classification, or null if it is not deployed. */
function boundaryDocument(classification: string): any | null {
  const name = `${STACK_PREFIX}AssistantActingBoundary-${classification}`;
  const arn: string | null = awsJson(
    `iam list-policies --scope Local --query "Policies[?PolicyName=='${name}'].Arn | [0]"`,
  );
  if (!arn) return null;
  const versionId: string = awsJson(`iam get-policy --policy-arn ${arn} --query "Policy.DefaultVersionId"`);
  return awsJson(
    `iam get-policy-version --policy-arn ${arn} --version-id ${versionId} --query "PolicyVersion.Document"`,
  );
}

/**
 * AWS's decision for each action under a maximally permissive identity policy capped by `boundary`.
 * Anything not allowed came back denied because the boundary refused it.
 */
function decideUnderBoundary(boundary: any, actions: string[], context: string[] = []): Record<string, string> {
  const allowEverything = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
  };
  const entries = context.length ? `--context-entries ${context.join(' ')} ` : '';
  const results: Array<{ EvalActionName: string; EvalDecision: string }> = awsJson(
    'iam simulate-custom-policy '
    + `--policy-input-list ${jsonArg(allowEverything)} `
    + `--permissions-boundary-policy-input-list ${jsonArg(boundary)} `
    + `--action-names ${actions.join(' ')} `
    + '--resource-arns "*" '
    + entries
    + '--query "EvaluationResults[].{EvalActionName:EvalActionName,EvalDecision:EvalDecision}"',
  ) || [];
  return Object.fromEntries(results.map((r) => [r.EvalActionName, r.EvalDecision]));
}

/** AWS's decision for each action on a DEPLOYED principal with no session tags. */
function decideForPrincipal(roleArn: string, actions: string[]): Record<string, string> {
  return Object.fromEntries(actions.map((a) => [a, decide(roleArn, a, '*')]));
}

test.describe('an assistant reads CloudWatch only as an ops session, and never writes it', () => {
  // The suite rule: every spec carries the guard. A boundary test that passed while the deployment was
  // throwing is exactly the shape it refuses.
  guardBackendErrors('an-assistant-boundary-refuses-cloudwatch');
  test.skip(!awsReachable(), NO_AWS_REASON);

  test('the deployed acting role allows telemetry reads to an ops session only, never a primary or an untagged one', async () => {
    test.setTimeout(240_000);

    const violations: string[] = [];
    let opsCheckedAnywhere = false;

    for (const classification of CLASSIFICATIONS) {
      const role = actingRole(classification);
      expect(role, `no deployed ${classification} acting role - deploy before running this`).toBeTruthy();
      const hasOps = role!.declaredRoles.includes('ops');

      for (const action of OPS_READS) {
        // THE POSITIVE CONTROL, where the classification declares ops. A wrong condition key denies
        // every session, ops included, and would otherwise satisfy every denial below.
        const asOps = decide(role!.arn, action, '*', sessionContext(classification, 'ops', 'probe-bot'));
        if (hasOps && asOps !== 'allowed') {
          violations.push(`${classification}: an ops session is ${asOps} for ${action}; the role cut denies the one role it exists to admit`);
        }
        // A classification that declares no ops role grants no telemetry to anyone, even to a session
        // carrying the tag: the boundary's Deny is unconditioned there.
        if (!hasOps && asOps === 'allowed') {
          violations.push(`${classification}: declares no ops role, yet a session tagged role=ops is ALLOWED ${action}`);
        }
        const asPrimary = decide(role!.arn, action, '*', sessionContext(classification, 'primary', 'probe-bot'));
        if (asPrimary === 'allowed') {
          violations.push(`${classification}: a PRIMARY session is ALLOWED ${action}; every assistant in the classification reads operational data`);
        }
        // NO ROLE TAG AT ALL. The trust policy refuses to mint such a session, but the boundary must
        // not depend on that: the negated Deny matches an absent key.
        const untagged = decide(role!.arn, action, '*', [ctx(TAG.classification, classification), ctx(TAG.bot, 'probe-bot')]);
        if (untagged === 'allowed') {
          violations.push(`${classification}: a session with NO role tag is ALLOWED ${action}; the cut does not fail closed`);
        }
      }
      if (hasOps) opsCheckedAnywhere = true;
      console.log(`[cw-role-cut] ${classification}: ${hasOps ? 'ops allowed, ' : 'no ops role, '}primary denied, untagged denied`);
    }

    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
    // The ops role is declared per deployment (`ops-premium` in `profiles`). Without it, the positive control never ran and
    // the denials above are the whole of what this test proved, which the run summary should say.
    if (!opsCheckedAnywhere) {
      test.info().annotations.push({ type: 'note', description: 'no classification declares ops; the allowed half was not exercised' });
    }
  });

  test('the boundary refuses telemetry to a non-ops session however wide the role\'s own grant, and refuses IAM and chaining to all', async () => {
    test.setTimeout(240_000);

    const violations: string[] = [];
    for (const classification of CLASSIFICATIONS) {
      const doc = boundaryDocument(classification);
      expect(doc, `no deployed AssistantActingBoundary for ${classification}`).toBeTruthy();

      // An `Allow *` identity policy under the deployed boundary: what comes back denied is denied by
      // the boundary, so this holds on the day someone widens the acting role for an unrelated reason.
      for (const [label, context] of [
        ['a primary session', [ctx(TAG.role, 'primary')]],
        ['an untagged session', [] as string[]],
      ] as Array<[string, string[]]>) {
        const decisions = decideUnderBoundary(doc, OPS_READS, context);
        for (const action of OPS_READS) {
          if (decisions[action] !== 'explicitDeny') {
            violations.push(
              `${classification}: ${label} under an Allow-everything grant is ${decisions[action]} for ${action}; `
              + 'expected the boundary\'s explicit Deny. A runtime grant could hand it telemetry, and '
              + '`logs:FilterLogEvents` reaches conversation text.',
            );
          }
        }
      }

      // THE LEAF: an assistant never edits IAM and never chains into another role. Explicit, so it is
      // the Deny that refuses and not the absence of an Allow, which a future widening would remove.
      const leaf = decideUnderBoundary(doc, ['iam:PutRolePolicy', 'sts:AssumeRole', 'sts:TagSession'], [ctx(TAG.role, 'ops')]);
      for (const [action, decision] of Object.entries(leaf)) {
        if (decision !== 'explicitDeny') {
          violations.push(`${classification}: ${action} came back ${decision} under an Allow-everything grant; the leaf Deny is not holding`);
        }
      }

      // NEVER A TELEMETRY WRITE, EVEN AS OPS. The reads and the writes share a namespace, so the
      // fastest way to "make ops work" is a wildcard, and a wildcard would pass every read assertion.
      const writes = decideUnderBoundary(doc, WRITES, [ctx(TAG.role, 'ops')]);
      for (const action of WRITES) {
        if (writes[action] === 'allowed') {
          violations.push(`${classification}: the boundary PERMITS ${action} to an ops session; it grants a telemetry write`);
        }
      }

      // THE POSITIVE CONTROL: a model invoke is inside the boundary. A boundary that permits nothing
      // would pass every denial above.
      const control = decideUnderBoundary(doc, ['bedrock:InvokeModel'], [ctx(TAG.role, 'primary')]);
      if (control['bedrock:InvokeModel'] !== 'allowed') {
        violations.push(`${classification}: the boundary refuses bedrock:InvokeModel (${control['bedrock:InvokeModel']}); it is broken, not narrow`);
      }
      console.log(`[assistant-boundary] ${classification}: telemetry denied to primary and untagged, leaf Deny held, no write, bedrock control allowed`);
    }
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  test('the deployed acting role grants no telemetry write to any session, an ops one included', async () => {
    test.setTimeout(240_000);

    const violations: string[] = [];
    for (const classification of CLASSIFICATIONS) {
      const role = actingRole(classification);
      expect(role, `no deployed ${classification} acting role`).toBeTruthy();
      for (const roleTag of role!.declaredRoles) {
        for (const action of WRITES) {
          const d = decide(role!.arn, action, '*', sessionContext(classification, roleTag, 'probe-bot'));
          if (d === 'allowed') violations.push(`${classification}: a ${roleTag} session is ALLOWED ${action}`);
        }
      }
    }
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  /**
   * THE ROLES AROUND THE ASSISTANT READ NO TELEMETRY EITHER.
   *
   * The processor's own role is bootstrap only, and the router handler's role routes; neither acts as
   * an assistant, so a CloudWatch read on either would be a reach no session tag cuts. A person's reach
   * is their Cognito authenticated role. All are asserted against the real deployed principals.
   */
  test('the processor, the handler and a person\'s role cannot read CloudWatch', async () => {
    test.setTimeout(240_000);

    const principals: Array<{ name: string; arn: string }> = [...userRoleArns()];
    for (const classification of CLASSIFICATIONS) {
      const processor = processorRoleArn(classification);
      const handler = handlerRoleArn(classification);
      expect(processor, `no deployed ${classification} processor role`).toBeTruthy();
      expect(handler, `no deployed ${classification} handler role`).toBeTruthy();
      principals.push({ name: `${classification} processor`, arn: processor! }, { name: `${classification} handler`, arn: handler! });
    }

    const violations: string[] = [];
    for (const { name, arn } of principals) {
      const decisions = decideForPrincipal(arn, OPS_READS);
      const allowed = Object.entries(decisions).filter(([, d]) => d === 'allowed').map(([a]) => a);
      if (allowed.length) {
        violations.push(
          `${name} is ALLOWED ${allowed.join(', ')}. No session tag cuts this role, so the reach is not `
          + 'scoped to an ops assistant.',
        );
      }
      console.log(`[cw-today] ${name}: ${OPS_READS.length} reads, ${allowed.length} allowed`);
    }
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });
});
