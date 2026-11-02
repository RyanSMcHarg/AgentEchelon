#!/usr/bin/env node
/**
 * One-time backfill: reconcile the placeholder->final analytics gap for data
 * archived before the archival-time fix shipped.
 *
 * Usage:
 *   AWS_PROFILE=<profile> node backend/scripts/backfill-analytics-placeholders.mjs
 *   AWS_PROFILE=<profile> node backend/scripts/backfill-analytics-placeholders.mjs --reset-evals
 *
 * Aurora lives in isolated subnets, reachable only from the VPC-attached
 * data-plane Lambda, so this invokes that Lambda's `backfillPlaceholders` op
 * (added alongside the archival fix). The data-plane ARN is discovered from a
 * per-tier AgentHandler's AURORA_DATA_PLANE_ARN env; pass --arn=<arn> to skip
 * discovery.
 *
 * Idempotent (every write is COALESCE-guarded). `--reset-evals` additionally
 * clears exchange-type evaluation_results so the eval runner re-scores against
 * the corrected content — destructive + triggers Bedrock re-eval cost, so it is
 * opt-in.
 */

import {
  LambdaClient,
  InvokeCommand,
  GetFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveStackPrefix } = require('./lib/stack-lookup.cjs');
const { listStackNames, classificationStacksAmong, physicalIdsIn } = require('./lib/stack-resources.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const lambda = new LambdaClient({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });

const args = process.argv.slice(2);
const resetEvals = args.includes('--reset-evals');
const arnArg = args.find((a) => a.startsWith('--arn='))?.slice('--arn='.length);

/**
 * Find the data-plane Lambda ARN. Prefer the Archive stack's own data-plane function (Aurora mode); else
 * read it off a classification handler's AURORA_DATA_PLANE_ARN env (the ARN the live request path
 * uses). Both are read from this deployment's stacks, never matched on generated function names
 * (scripts/lib/stack-resources.cjs), so another instance in the account is never picked up.
 */
async function resolveDataPlaneArn() {
  if (arnArg) return arnArg;

  const prefix = resolveStackPrefix(process.env);
  const fnArn = async (name) =>
    (await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }))).FunctionArn;

  const [dataPlane] = await physicalIdsIn(cfn, [`${prefix}Archive`], {
    type: 'AWS::Lambda::Function', logicalId: /^DataPlaneLambda/,
  }).catch(() => []);
  if (dataPlane) return fnArn(dataPlane);

  const stacks = classificationStacksAmong(await listStackNames(cfn), prefix);
  const candidates = await physicalIdsIn(cfn, stacks, { type: 'AWS::Lambda::Function', logicalId: /^AgentHandler/ });
  for (const name of candidates) {
    const cfg = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: name }),
    );
    const arn = cfg.Environment?.Variables?.AURORA_DATA_PLANE_ARN;
    if (arn) return arn;
  }
  throw new Error(
    'Could not resolve the data-plane Lambda ARN. Pass --arn=<arn> explicitly.',
  );
}

async function main() {
  const arn = await resolveDataPlaneArn();
  console.log(`Data-plane Lambda: ${arn}`);
  console.log(`Reset evaluations: ${resetEvals}`);

  const resp = await lambda.send(
    new InvokeCommand({
      FunctionName: arn,
      Payload: Buffer.from(
        JSON.stringify({
          op: 'backfillPlaceholders',
          input: { resetExchangeEvaluations: resetEvals },
        }),
      ),
    }),
  );

  const payload = resp.Payload
    ? JSON.parse(Buffer.from(resp.Payload).toString('utf-8'))
    : null;

  if (resp.FunctionError) {
    console.error('Data-plane invoke FAILED:', resp.FunctionError);
    console.error(payload);
    process.exit(1);
  }

  console.log('Backfill result:', JSON.stringify(payload, null, 2));
  console.log(
    '\nNext: if you did NOT pass --reset-evals, existing eval rows still ' +
      'reflect the old placeholder scores. Re-run with --reset-evals (or ' +
      'invoke the eval runner) to re-score against the corrected content.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
