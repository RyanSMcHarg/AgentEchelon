/**
 * NO `lambda:InvokeFunction` GRANT MAY REACH OUTSIDE THIS DEPLOYMENT.
 *
 * `battle-stack.ts` granted the alt-slot handler
 * `arn:aws:lambda:<region>:<account>:function:*AgentHandler*`. The LEADING wildcard is the whole
 * defect: it makes the grant account-wide, and this account hosts several products. Measured live, it
 * matched four handlers belonging to two unrelated deployments - their per-tier agent handlers and
 * their guest and admin handlers - none of which this deployment has any business invoking.
 *
 * WHY THIS IS WORSE THAN AN ORDINARY OVER-GRANT. Our identity guard, `isSanctionedBattleBot`, runs
 * INSIDE our handler. Another product's handler never runs it, so nothing on the far side of that
 * grant applied our sanction model, our loop guard or our budget - the blast radius of a compromised
 * or merely buggy alt-slot handler crossed a product boundary.
 *
 * A SWEEP, NOT A PIN. Pinning the one corrected line would let the next stack reintroduce the shape
 * somewhere else, which is how this one survived beside three sibling grants that already did it
 * correctly. The rule is structural and cheap to state: after `:function:`, a resource pattern may
 * not START with a wildcard. A trailing wildcard is fine and is what the deployment relies on -
 * `${STACK_PREFIX}Classification-*` is a prefix, so it is also safe against the CloudFormation name
 * truncation ADR-030 records, since truncation removes characters from the end.
 *
 * Asserted on the SYNTHESIZED template, for the reason the sibling Lex-permission test gives: a grant
 * added by `grantInvoke()` never appears in a source scan, and a construct that fails to render is
 * invisible to one.
 *
 * SCOPE (widened 2026-08-17). This now sweeps EVERY `lambda:` action, not
 * `InvokeFunction` alone, across every stack that grants one - including `experiments-stack.ts`.
 *
 * The earlier version said, in this comment, that it deliberately did not fail the account-wide
 * `lambda:GetFunctionConfiguration` on `function:*` held by `experiments-stack.ts`, on the grounds
 * that a metadata read was a different exposure. That reasoning was wrong in the way that matters:
 * the call returns `Environment.Variables`, so the grant read every other product's configuration in
 * this account, and the guard was green beside it. **A guard that names an ACTION gets the scope of
 * that action; the rule it should have named is that no grant here may reach another product's
 * functions.** Row 96 was fixed and swept, and its sibling one action along survived for that reason.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BattleStack } from '../lib/stacks/battle-stack';
import { ChannelFlowStack } from '../lib/stacks/channel-flow-stack';
import { PostProcessingStack } from '../lib/stacks/post-processing-stack';
import { BasicClassificationStack } from '../lib/stacks/basic-classification-stack';
import { StandardClassificationStack } from '../lib/stacks/standard-classification-stack';
import { PremiumClassificationStack } from '../lib/stacks/premium-classification-stack';
import { ExperimentsStack } from '../lib/stacks/experiments-stack';
import { DEFAULT_PROFILE_MODEL_SELECTION } from '../lib/config/model-strategy';

const env = { account: '123456789012', region: 'us-east-1' };
const appInstanceArn = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';

const classificationProps = {
  env,
  appInstanceArn,
  attachmentsBucketName: 'agent-echelon-attachments-test',
  attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
  profileModelSelection: DEFAULT_PROFILE_MODEL_SELECTION,
};

/** Every stack that grants an invoke, each synthesized in its own app. */
function stacksThatGrantInvoke(): Array<{ name: string; template: Template }> {
  const out: Array<{ name: string; template: Template }> = [];
  const add = (name: string, build: (app: cdk.App) => cdk.Stack) => {
    const app = new cdk.App();
    out.push({ name, template: Template.fromStack(build(app)) });
  };

  add('Battle', (app) => new BattleStack(app, 'AgentEchelonBattle', {
    env, appInstanceArn, userPoolId: 'us-east-1_testpool', appUrl: 'https://app.example.com',
  }));
  add('ChannelFlow', (app) => new ChannelFlowStack(app, 'AgentEchelonChannelFlow', { env, appInstanceArn }));
  add('PostProcessing', (app) => new PostProcessingStack(app, 'AgentEchelonPostProcessing', {
    env, appInstanceArn, kinesisStreamArn: `arn:aws:kinesis:${env.region}:${env.account}:stream/test`,
  }));
  add('Classification-Basic', (app) => new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', classificationProps));
  add('Classification-Standard', (app) => new StandardClassificationStack(app, 'AgentEchelonClassification-Standard', classificationProps));
  add('Classification-Premium', (app) => new PremiumClassificationStack(app, 'AgentEchelonClassification-Premium', classificationProps));
  // Row 101: this stack grants a lambda READ, not an invoke, which is exactly why it was absent while
  // the sweep named a single action.
  add('Experiments', (app) => new ExperimentsStack(app, 'AgentEchelonExperiments', {
    env, appInstanceArn, userPoolId: 'us-east-1_TESTPOOL',
  }));

  return out;
}

interface Statement { Action?: unknown; Resource?: unknown }

/**
 * Every IAM statement in a template that grants ANY `lambda:` action, from roles and policies alike.
 *
 * WIDENED FROM `InvokeFunction` ALONE. The narrow sweep passed while
 * `experiments-stack.ts` held `lambda:GetFunctionConfiguration` on `function:*` - account-wide, in a
 * multi-product account, on a call that returns `Environment.Variables`. So the narrow version was
 * green beside a live cross-product READ of every other product's configuration.
 *
 * The lesson is the one this repo keeps relearning: **the scope of a guard becomes the scope of the
 * fix.** Row 96 was found, fixed and swept for `InvokeFunction`, and the sibling exposure one action
 * along survived precisely because the sweep named an action instead of naming the RULE. The rule was
 * never about invoking - it is that no grant in this deployment may name another product's functions.
 */
function invokeStatements(template: Template): Statement[] {
  const found: Statement[] = [];
  const grantsInvoke = (action: unknown): boolean => {
    const actions = Array.isArray(action) ? action : [action];
    return actions.some((a) => typeof a === 'string' && /^lambda:/.test(a));
  };

  const scanDocument = (doc: unknown) => {
    const statements = (doc as { Statement?: unknown })?.Statement;
    if (!Array.isArray(statements)) return;
    for (const s of statements as Statement[]) if (grantsInvoke(s.Action)) found.push(s);
  };

  for (const res of Object.values(template.findResources('AWS::IAM::Policy'))) {
    scanDocument((res as { Properties?: { PolicyDocument?: unknown } }).Properties?.PolicyDocument);
  }
  for (const res of Object.values(template.findResources('AWS::IAM::Role'))) {
    const policies = (res as { Properties?: { Policies?: unknown } }).Properties?.Policies;
    if (Array.isArray(policies)) for (const p of policies) scanDocument((p as { PolicyDocument?: unknown }).PolicyDocument);
  }
  return found;
}

/**
 * A resource pattern whose function-name segment starts with `*`.
 *
 * Matched against the SERIALIZED resource because an ARN built from `this.region`/`this.account`
 * renders as an `Fn::Join`, not a string - the literal `":function:*..."` segment survives inside it,
 * and a naive `typeof === 'string'` check would skip every real grant in this codebase and pass
 * vacuously.
 */
function reachesBeyondThisDeployment(resource: unknown): boolean {
  return /:function:\*/.test(JSON.stringify(resource));
}

describe('invoke grants name this deployment', () => {
  const stacks = stacksThatGrantInvoke();

  it('finds invoke grants to check, so the sweep cannot pass vacuously', () => {
    const total = stacks.reduce((n, s) => n + invokeStatements(s.template).length, 0);
    // Battle alone holds three (alt-slot -> router, orchestrator -> processor, the Lex bot role).
    expect(total).toBeGreaterThanOrEqual(4);
  });

  it('none may invoke a function whose name pattern starts with a wildcard', () => {
    const offenders: string[] = [];
    for (const { name, template } of stacks) {
      for (const s of invokeStatements(template)) {
        const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
        for (const r of resources) {
          if (reachesBeyondThisDeployment(r)) offenders.push(`${name}: ${JSON.stringify(r)}`);
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        'lambda:InvokeFunction granted on a function pattern with a LEADING wildcard, which reaches '
          + 'every product in this account rather than this deployment:\n  '
          + offenders.join('\n  ')
          + '\n\nScope it to `${STACK_PREFIX}...` as the sibling grants do, or to a resolved ARN. Our '
          + 'identity guards run INSIDE our handlers, so nothing beyond this deployment applies them.',
      );
    }
  });

  it('the alt-slot handler names this deployment specifically', () => {
    // Named as well as swept: this is the grant row 96 was filed against, and it is the one that can
    // reach another product's agent handler. A future stack losing scope should fail the sweep; this
    // one regressing should be unmistakable.
    const battle = stacks.find((s) => s.name === 'Battle')!.template;
    const patterns = invokeStatements(battle)
      .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]))
      .map((r) => JSON.stringify(r))
      .filter((r) => /:function:/.test(r));
    expect(patterns.length).toBeGreaterThan(0);
    // Every function-scoped invoke in this stack is prefixed by the deployment's own stack prefix.
    for (const p of patterns) expect(p).toMatch(/:function:[A-Za-z0-9]/);
    // And the specific target the alt-slot handler resolves at runtime is reachable.
    expect(patterns.some((p) => /Classification-\*/.test(p))).toBe(true);
  });
});
