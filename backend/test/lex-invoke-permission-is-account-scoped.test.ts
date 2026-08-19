/**
 * Every Lambda permission granted to a SERVICE principal carries a source condition.
 *
 * WHY THIS IS NOT HYGIENE. `lambda:InvokeFunction` granted to `lexv2.amazonaws.com` with no
 * `SourceAccount` accepts an invoke the Lex service makes ON BEHALF OF ANY ACCOUNT - the confused-deputy
 * shape these conditions exist for. What made it load-bearing here is ADR-025: a Lex fulfillment code
 * hook controls the request attributes it sends, and `isFlowEntry(event)` reads one of them
 * (`AE.entry`) to decide whether the handler POSTS A MESSAGE ITSELF, as a resolved bot identity
 * (`postAsAssistant`). Before ADR-025 that flag only chose a response SHAPE and the handler held no
 * `chime:SendChannelMessage` at all; after it, the flag gates message AUTHORSHIP. So an unconditioned
 * service grant became the one route into the authorship path from outside the two sanctioned callers
 * (the channel flow and the battle orchestrator, both identity-based grants).
 *
 * Asserted on the SYNTHESIZED template, not the source: the condition only means something if it
 * survives synth, and a source scan would pass on a construct that never rendered it.
 *
 * `SourceArn` satisfies this too (Cognito's trigger permissions use it, which is tighter than an
 * account). The requirement is A source condition, not a specific one.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BattleStack } from '../lib/stacks/battle-stack';
import { BasicClassificationStack } from '../lib/stacks/basic-classification-stack';
import { StandardClassificationStack } from '../lib/stacks/standard-classification-stack';
import { PremiumClassificationStack } from '../lib/stacks/premium-classification-stack';
import { CognitoAuthStack } from '../lib/stacks/cognito-auth-stack';
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

/** Every stack that creates an `AWS::Lambda::Permission`, each synthesized in its own app. */
function stacksWithLambdaPermissions(): Array<{ name: string; template: Template }> {
  const out: Array<{ name: string; template: Template }> = [];

  const add = (name: string, build: (app: cdk.App) => cdk.Stack) => {
    const app = new cdk.App();
    out.push({ name, template: Template.fromStack(build(app)) });
  };

  add('AgentEchelonBattle', (app) => new BattleStack(app, 'AgentEchelonBattle', {
    env, appInstanceArn, userPoolId: 'us-east-1_testpool', appUrl: 'https://app.example.com',
  }));
  add('Classification-Basic', (app) => new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', classificationProps));
  add('Classification-Standard', (app) => new StandardClassificationStack(app, 'AgentEchelonClassification-Standard', classificationProps));
  add('Classification-Premium', (app) => new PremiumClassificationStack(app, 'AgentEchelonClassification-Premium', classificationProps));
  add('CognitoAuth', (app) => new CognitoAuthStack(app, 'AgentEchelonCognitoAuth', { env, appInstanceArn }));

  return out;
}

describe('service-principal Lambda permissions are source-scoped', () => {
  const stacks = stacksWithLambdaPermissions();

  it('at least one Lambda permission exists to check, so this cannot pass vacuously', () => {
    const total = stacks.reduce((n, s) => n + Object.keys(s.template.findResources('AWS::Lambda::Permission')).length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('none grants a service principal without SourceAccount or SourceArn', () => {
    const offenders: string[] = [];

    for (const { name, template } of stacks) {
      for (const [logicalId, res] of Object.entries(template.findResources('AWS::Lambda::Permission'))) {
        const props = (res as { Properties?: Record<string, unknown> }).Properties ?? {};
        const principal = props.Principal;
        // Only SERVICE principals are at issue: an account or role principal is already specific.
        if (typeof principal !== 'string' || !principal.endsWith('.amazonaws.com')) continue;
        if (props.SourceAccount === undefined && props.SourceArn === undefined) {
          offenders.push(`${name} / ${logicalId} -> Principal ${principal}`);
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        'Lambda permission(s) grant a service principal with NO SourceAccount/SourceArn, so that service '
          + 'may invoke the function on behalf of any account:\n  '
          + offenders.join('\n  ')
          + '\n\nAdd `sourceAccount: cdk.Stack.of(this).account`, or a tighter `sourceArn`. If a grant must '
          + 'genuinely stay open, record why at the call site rather than leaving it to be re-found.',
      );
    }
  });

  it('both Lex-invoked handlers specifically carry the account condition', () => {
    // Named rather than left to the sweep above: these two are the ones that reach a turn, and the
    // handler one gates message authorship. A future stack losing its condition should fail the sweep;
    // these two failing should be unmistakable.
    for (const name of ['AgentEchelonBattle', 'Classification-Premium']) {
      const template = stacks.find((s) => s.name === name)!.template;
      const lex = Object.values(template.findResources('AWS::Lambda::Permission'))
        .map((r) => (r as { Properties?: Record<string, unknown> }).Properties ?? {})
        .filter((p) => p.Principal === 'lexv2.amazonaws.com');
      expect(lex.length).toBeGreaterThan(0);
      for (const p of lex) expect(p.SourceAccount).toBeDefined();
    }
  });
});
