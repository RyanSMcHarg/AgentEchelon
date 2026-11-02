#!/usr/bin/env node
/**
 * Pair the answers the sweep never went back for.
 *
 * The mention-marker clause pairs a flow turn on the correlation id, which IS the user's message id.
 * It only reaches turns that arrive after it shipped, because the pass that runs it is scoped to the
 * channels in the current Kinesis batch and to the last 24 hours, so a quiet channel is never
 * revisited. This re-runs the same statement over a window an operator chooses.
 *
 * WHAT IT IS NOT FOR. The unpaired count on this deployment is dominated by round-2 duel rebuttals,
 * which declare no answered message deliberately, and this pass correctly mints nothing for them.
 * A zero here is not evidence that nothing is unpaired - see the note it prints.
 *
 * An unpaired answer is not visibly missing: `v_turn_latency` LEFT JOINs, so the turn survives with
 * `anchor_source`, `ttff_ms` and `e2e_ms` all NULL. It stops voting in every latency figure instead
 * of showing up as a gap somebody would chase.
 *
 * Usage:
 *   AWS_PROFILE=<profile> node backend/scripts/backfill-exchange-pairings.mjs
 *   AWS_PROFILE=<profile> node backend/scripts/backfill-exchange-pairings.mjs --days=30
 *   AWS_PROFILE=<profile> node backend/scripts/backfill-exchange-pairings.mjs --arn=<arn>
 *
 * Aurora lives in isolated subnets, reachable only from the VPC-attached data-plane Lambda, so this
 * invokes that Lambda's `backfillExchangePairings` op.
 *
 * SAFE TO RE-RUN, and safe over a wide window. The `e.id IS NULL` anti-join plus `ON CONFLICT DO
 * NOTHING` make it converge, and every pairing clause is bounded relative to the PAIR rather than to
 * now - exact id matches for declared and mention, and a REPLY_BOUND_MINUTES bound plus a
 * no-intervening-user-message test for the inferred branch. Widening the window admits older rows to
 * the same tests, never to looser ones.
 *
 * It mints EXCHANGES ONLY. Do not follow it with the turn-events backfill: an exchange is enough for
 * v_turn_latency to anchor the turn, while a minted turn_events row would stamp
 * `turn_id_source = 'paired'` and present a derived anchor as a measured one.
 *
 * Start narrow. `--days=7` first tells you the shape of what it finds before a 90-day pass commits
 * to it, and because the pass is idempotent the narrow run costs nothing against the wide one.
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
const arnArg = args.find((a) => a.startsWith('--arn='))?.slice('--arn='.length);
const daysArg = args.find((a) => a.startsWith('--days='))?.slice('--days='.length);
const days = daysArg ? Number(daysArg) : undefined;

if (daysArg && (!Number.isFinite(days) || days < 1)) {
  console.error(`--days must be a positive number, got "${daysArg}"`);
  process.exit(1);
}

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
    const cfg = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
    const arn = cfg.Environment?.Variables?.AURORA_DATA_PLANE_ARN;
    if (arn) return arn;
  }
  throw new Error('Could not resolve the data-plane Lambda ARN. Pass --arn=<arn> explicitly.');
}

async function main() {
  const arn = await resolveDataPlaneArn();
  console.log(`Data-plane Lambda: ${arn}`);
  console.log(`Window: ${days ?? 90} days (default 90, clamped to 365 server-side)`);

  const resp = await lambda.send(
    new InvokeCommand({
      FunctionName: arn,
      Payload: Buffer.from(
        JSON.stringify({ op: 'backfillExchangePairings', input: days ? { days } : {} })
      ),
    })
  );

  const payload = resp.Payload ? JSON.parse(Buffer.from(resp.Payload).toString('utf-8')) : null;

  if (resp.FunctionError) {
    console.error('Data-plane invoke FAILED:', resp.FunctionError);
    console.error(payload);
    process.exit(1);
  }

  console.log('Backfill result:', JSON.stringify(payload, null, 2));

  const created = payload?.exchangesCreated;
  if (created === 0) {
    // NOT "all clear". The first version of this line said the run was clean, and a zero was read as
    // success while 84 rows sat unpaired - the reading cost two investigations. Zero means this pass
    // found nothing it could pair, which is the expected answer on a healthy deployment AND the
    // expected answer when the unpaired rows are ones it was never able to pair. Say which.
    console.log(
      '\nNothing this pass can pair in this window, which is a no-op rather than a failure.\n' +
        'It does NOT mean nothing is unpaired. The pass only mints an exchange where the turn\n' +
        'declared what it answered, or where the correlation id names the inbound message.\n' +
        'Round-2 duel rebuttals declare neither, by design, and are the bulk of the unpaired count\n' +
        'on a deployment running battle traffic. Read unpaired_bot_messages and segregate on\n' +
        'is_rebuttal before concluding anything from this zero.'
    );
  } else if (typeof created === 'number') {
    console.log(
      `\n${created} exchange(s) minted. Those turns now carry ttff_ms and e2e_ms in v_turn_latency ` +
        'and will start voting in the Latency figures.\n' +
        'Do NOT follow this with the turn-events backfill: it would flip anchor_source to "ledger" ' +
        'and present these derived bindings as measured ones.'
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
