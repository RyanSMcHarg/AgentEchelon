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
  ListFunctionsCommand,
  GetFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';

const REGION = process.env.AWS_REGION || 'us-east-1';
const lambda = new LambdaClient({ region: REGION });

const args = process.argv.slice(2);
const resetEvals = args.includes('--reset-evals');
const arnArg = args.find((a) => a.startsWith('--arn='))?.slice('--arn='.length);

/**
 * Find the data-plane Lambda ARN. Prefer reading it off an AgentEchelon tier
 * handler's AURORA_DATA_PLANE_ARN env (authoritative — it is the ARN the live
 * request path uses). Fall back to a name-scoped function scan.
 */
async function resolveDataPlaneArn() {
  if (arnArg) return arnArg;

  let marker;
  const candidates = [];
  do {
    const page = await lambda.send(
      new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }),
    );
    for (const fn of page.Functions || []) {
      const name = fn.FunctionName || '';
      // Multi-project account: scope hard to AgentEchelon to avoid look-alikes.
      if (!name.includes('AgentEchelon')) continue;
      if (/AgentHandler|Tier/.test(name)) candidates.push(name);
      if (/DataPlane/.test(name)) return fn.FunctionArn;
    }
    marker = page.NextMarker;
  } while (marker);

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
