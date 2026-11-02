/**
 * THE MODEL BOUNDARY, PROVEN BY DENIAL RATHER THAN BY READING THE SYNTHESIZED TEMPLATE.
 *
 * ADR-054 rests on one claim that has to be checked against AWS rather than against the tree: a
 * per-classification acting role is DENIED what it does not declare. That claim had exactly one
 * deny-test behind it, on the S3 context prefixes (`classification-context.spec.ts`), and none on
 * the model list - so "a classification that does not grant `premium` cannot reach a premium model
 * even through a direct API call" (tenet D3, stated in those words) was proven for the corpus and
 * asserted from CDK output for the model. `cdk-synth.test.ts` checks what CloudFormation was handed.
 * This checks what IAM decides.
 *
 * ── WHY THE EXPECTATION IS DERIVED FROM THE CATALOG AND NOT WRITTEN DOWN HERE ───────────────────
 *
 * Each classification's selection (`models.selected` on its registry entry, read through
 * `ProfileRegistry.selectsModel`) IS the declaration the deployed policy is supposed to match. A spec that restated the pairs would pass whenever the restatement and the
 * stack drifted together, which is the failure mode a hardcoded expectation always has. Reading the
 * selection means adding a model to one, or removing it, changes what this spec demands with no edit here.
 *
 * ── THE POSITIVE CONTROL IS HALF THE TEST ───────────────────────────────────────────────────────
 *
 * A role that permits nothing passes every denial ever written. So each classification is also
 * asserted ALLOWED on every model it does declare, in the same loop. A boundary narrowed into
 * uselessness fails here rather than looking like success - the same pairing
 * `assistant-classification-boundary.spec.ts` uses, and for the same reason.
 *
 * ── WHAT THIS SPEC DOES NOT PROVE, SAID PLAINLY ─────────────────────────────────────────────────
 *
 * A classification that selects every model the spec checks has no denial to check and contributes only
 * a positive control. Nothing below is evidence about its model boundary, and the summary line says so
 * rather than counting it as a pass. The denials that carry weight are `basic`, which must
 * be refused every model but `haiku`, and `standard`, which must be refused the premium-only ones.
 *
 * IT RUNS AGAINST A DEPLOYMENT AND FAILS UNTIL ONE CARRIES THE POLICY. That is deliberate: a
 * boundary that passes before it is deployed is testing the tree rather than the account.
 */
import { test, expect } from './helpers/fixtures';
import { getModelCatalog, type Classification } from '../../backend/lib/config/model-strategy';
import { defaultProfileRegistry } from '../../backend/lib/profile-registry';
import { IMAGE_GEN_MODELS } from '../../backend/lambda/src/lib/image-gen-models';
import { guardBackendErrors } from './helpers/turn-guards';
import {
  NO_AWS_REASON, awsReachable, actingRole, botFor, sessionContext, processorRoleArn,
} from './helpers/assistant-acting-role';
import { aws as awsJson } from './helpers/aws';
import { adminSessionOrSkip, draftModels, discardDraft } from './helpers/model-routes';

const REGION = process.env.AWS_REGION || 'us-east-1';

/**
 * THE ACTING ROLE IS WHAT DECIDES AN ASSISTANT'S MODEL REACH. Every call a turn makes, Bedrock
 * included, goes out on the session the vend mints from the classification's acting role, so the model
 * grant lives there (`BedrockPolicy` in `assistant-profile-stack.ts`), bounded by the classification's
 * boundary, which the simulator evaluates too. The processor's own role is bootstrap only and is
 * asserted to reach no model at all: if it could, a turn could call a model without ever becoming an
 * assistant, and no session tag or classification pin would apply.
 *
 * The model grant compares no session tag, so the simulation passes the tags of a primary session
 * only to keep the request shaped like a real one; they do not change the answer.
 */

/** Every ARN a catalog model can be invoked through: its foundation models and its inference profiles. */
function arnsOf(model: { foundationModelArns: string[]; inferenceProfileArns?: string[] }): string[] {
  return [...model.foundationModelArns, ...(model.inferenceProfileArns ?? [])];
}

/**
 * ONE SIMULATION PER ARN, AND BATCHING IS NOT AN OPTIMIZATION HERE - IT IS A WRONG ANSWER.
 *
 * Passing several `--resource-arns` for one action does not return one result per resource. IAM
 * COLLAPSES them into a single `EvaluationResult` whose `EvalResourceName` is a TEMPLATE -
 * `arn:aws:bedrock:${Region}:${Account}:${ResourceType}/${ResourceId}` - carrying one aggregate
 * decision for the action. Measured, not assumed: four sonnet ARNs came back as exactly one result
 * reading `allowed`.
 *
 * So a batched spec that read results by index would have reported `allowed` for every ARN in the
 * batch, including ARNs the role is denied, and the denial half of this file would have been
 * decorative while printing a pass. Keying on `EvalResourceName` is what surfaced it, because every
 * lookup missed. The fix is one call per resource, which is also what the S3 prefix deny-test does.
 */
function decide(roleArn: string, action: string, resourceArn: string, context: string[] = []): string {
  const entries = context.length ? `--context-entries ${context.join(' ')} ` : '';
  const results: Array<{ EvalResourceName: string; EvalDecision: string }> = awsJson(
    `iam simulate-principal-policy --policy-source-arn ${roleArn} --action-names ${action} `
    + `--resource-arns "${resourceArn}" ${entries}`
    + '--query "EvaluationResults[].{EvalResourceName:EvalResourceName,EvalDecision:EvalDecision}"',
  ) || [];
  // The single-resource call names the resource it was asked about. A templated name here means the
  // collapse above has started happening for one resource too, and a decision read anyway would be
  // about the action rather than the model.
  const hit = results.find((r) => r.EvalResourceName === resourceArn);
  if (!hit) {
    throw new Error(
      `simulate-principal-policy did not answer about ${resourceArn}. It returned `
      + `${JSON.stringify(results)}, so the decision below would not be about this model.`,
    );
  }
  return hit.EvalDecision;
}

test.describe('a classification is denied a model it does not declare (ADR-054)', () => {
  // The suite rule: every spec carries the backend guard, IAM-only ones included.
  guardBackendErrors('model-boundary');
  test.skip(!awsReachable(), NO_AWS_REASON);

  test('each classification is allowed every model it declares and DENIED every model it does not', async () => {
    test.setTimeout(240_000);

    const account = String(awsJson('sts get-caller-identity --query Account'));
    expect(account, 'no AWS account from sts get-caller-identity').toMatch(/^\d{12}$/);

    // ONE RULE FOR EVERY MODEL (`backend/lib/config/model-availability.ts`): the Bedrock image models are
    // checked by the same loop as the text models, from the same selection, at the
    // foundation-model ARN in the region the model is invoked in.
    const imageEntries = Object.fromEntries(Object.values(IMAGE_GEN_MODELS)
      .filter((m) => m.hosting === 'aws-bedrock')
      .map((m) => [`image:${m.key}`, {
        key: `image:${m.key}`,
        selectionKey: m.key,
        foundationModelArns: [`arn:aws:bedrock:${m.region ?? REGION}::foundation-model/${m.bedrockModelId}`],
      }]));
    const catalog = { ...getModelCatalog(REGION, account), ...imageEntries } as Record<string, {
      key: string; selectionKey?: string; foundationModelArns: string[]; inferenceProfileArns?: string[];
    }>;
    const selects = (classification: string, model: { key: string; selectionKey?: string }) =>
      defaultProfileRegistry.selectsModel(classification, model.selectionKey ?? model.key);
    const classifications: Classification[] = ['basic', 'standard', 'premium'];

    const violations: string[] = [];
    let allowChecks = 0;
    let denyChecks = 0;
    const deniedPerClassification: Record<string, number> = {};

    for (const classification of classifications) {
      const acting = actingRole(classification);
      expect(acting, `no deployed ${classification} acting role`).toBeTruthy();
      const roleArn = acting!.arn;
      const session = sessionContext(classification, 'primary', botFor(classification, 'primary')?.botId || 'primary-probe-bot');
      const processor = processorRoleArn(classification);
      expect(processor, `no deployed ${classification} processor role`).toBeTruthy();

      const declared = Object.values(catalog).filter((m) => selects(classification, m));
      const undeclared = Object.values(catalog).filter((m) => !selects(classification, m));
      deniedPerClassification[classification] = undeclared.length;

      // ── THE POSITIVE CONTROL: what it declares, it can reach ──────────────────────────────────
      //
      // Per MODEL rather than per ARN. A model's ARNs are its cross-region variants, and the grant
      // names the ones the deployment's own region resolution produced, so demanding every variant
      // be allowed would fail on a correct policy. What has to hold is that a declared model is
      // reachable through at least one of its ARNs.
      for (const model of declared) {
        const arns = arnsOf(model);
        const reachable = arns.filter((a) => {
          allowChecks += 1;
          return decide(roleArn, 'bedrock:InvokeModel', a, session) === 'allowed';
        });
        if (reachable.length === 0) {
          violations.push(
            `${classification}: DECLARES model '${model.key}' and is allowed NONE of its ${arns.length} ARNs. `
            + 'The boundary is not narrow, it is broken, and every denial below would pass against a '
            + 'role that permits nothing at all.',
          );
        }
      }

      // ── THE DENIAL: what it does not declare, it cannot reach, through ANY of that model's ARNs ─
      for (const model of undeclared) {
        for (const arn of arnsOf(model)) {
          denyChecks += 1;
          const d = decide(roleArn, 'bedrock:InvokeModel', arn, session);
          if (d === 'allowed') {
            violations.push(
              `${classification}: is ALLOWED bedrock:InvokeModel on '${model.key}' (${arn}), which it does `
              + `not select - the model boundary is OPEN. '${model.key}' is selected by `
              + `[${classifications.filter((c) => selects(c, model)).join(', ')}]. Tenet D3 requires that a classification `
              + 'cannot reach a model it does not grant even through a direct API call.',
            );
          }
        }
      }

      // ── THE PROCESSOR'S OWN ROLE REACHES NO MODEL, DECLARED OR NOT ─────────────────────────────
      //
      // Every catalog ARN, because "no model" is the claim: a single allowed ARN here is a model call
      // a turn could make without becoming an assistant.
      for (const model of Object.values(catalog)) {
        for (const arn of arnsOf(model)) {
          denyChecks += 1;
          const d = decide(processor!, 'bedrock:InvokeModel', arn);
          if (d === 'allowed') {
            violations.push(
              `${classification}: the processor role is ALLOWED bedrock:InvokeModel on '${model.key}' (${arn}). `
              + 'It is bootstrap only; a model grant there bypasses the acting role and its boundary.',
            );
          }
        }
      }

      const verdict = undeclared.length === 0
        ? 'declares every catalog model, so it contributes a positive control and no denial'
        : `denied ${undeclared.length} model(s): ${undeclared.map((m) => m.key).join(', ')}`;
      console.log(`[model-boundary] ${classification}: allowed ${declared.length} declared model(s), ${verdict}`);
    }

    // ── NON-VACUITY, BOTH HALVES ──────────────────────────────────────────────────────────────────
    //
    // A spec that evaluated nothing reports exactly like a clean deployment. Two separate floors,
    // because they fail for different reasons: zero simulations means the catalog or the role lookup
    // came back empty, and zero DENIALS to check means every classification declares every model, at
    // which point this file proves nothing whatever it prints.
    expect(allowChecks, 'no model ARNs were evaluated for the positive control').toBeGreaterThan(0);
    expect(denyChecks, 'no model ARNs were evaluated for a denial').toBeGreaterThan(0);
    expect(
      deniedPerClassification.basic,
      'basic declares every model in the catalog, so the denial half of this spec is vacuous',
    ).toBeGreaterThan(0);

    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  // ADR-064: a route's step override is a model the version selects like any other, so one naming a model the
  // classification does not select is refused at write; the vend and IAM above are the two layers behind it.
  test('a step override naming a model the classification does not select is refused at write', async () => {
    test.setTimeout(120_000);
    const session = await adminSessionOrSkip();
    test.skip(!!session.skip, session.skip);
    test.skip(defaultProfileRegistry.selectsModel('basic', 'opus'), 'basic selects opus on this deployment, so there is nothing to refuse');
    const basicPrimary = 'concierge';
    try {
      const valid = await draftModels(session.admin, { byIntent: { report_generation: { primary: 'haiku', steps: { generating: { primary: 'opus' } } } } }, {}, basicPrimary);
      const errors: string[] = valid.errors ?? [];
      expect(errors.join(' '), JSON.stringify(valid).slice(0, 600)).toContain("models.byIntent['report_generation'].steps['generating'].primary");
    } finally {
      await discardDraft(session.admin, basicPrimary);
    }
  });
});
