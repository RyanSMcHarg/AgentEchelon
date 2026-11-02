#!/usr/bin/env node
/**
 * Measure the compliance judge against the people who labeled the same exchanges.
 *
 * Pass C, Step 3 (DESIGN-EVALUATION, Pass C). The deterministic half of a compliance verdict is
 * an observation and needs no corroboration. The JUDGED half is a model's opinion about a rule
 * statement, and an opinion nobody has checked is not a measurement - so this is the check, and until
 * it has rows the judged half is an opinion with a citation rather than evidence.
 *
 * WHY A SCRIPT AND NOT A CONSOLE TAB. The number this reports is meaningless until somebody has
 * labeled compliance on a sample, which is deliberate, occasional work - not something an operator
 * watches. Shipping it as a dashboard card would put a permanent "not assessed" on the screen and
 * teach people to ignore it. This is the shape the measurement actually has: run it after a labeling
 * pass, read the two directions, fix the rule statements the disagreements point at.
 *
 * The query runs inside the VPC (it reads Aurora), so this goes through the data-plane seam the other
 * ops scripts use rather than opening a second route to the database.
 *
 * USAGE
 *   node backend/scripts/compliance-judge-agreement.mjs [--days=30] [--json]
 *
 * Reads the deployment context from `backend/deploy.config.json`, like the other ops scripts.
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

const daysArg = process.argv.find((a) => a.startsWith('--days='));
const DAYS = daysArg ? Number(daysArg.split('=')[1]) : 30;
const AS_JSON = process.argv.includes('--json');

if (!Number.isFinite(DAYS) || DAYS <= 0) {
  console.error(`✗ --days must be a positive number (got '${daysArg}')`);
  process.exit(1);
}

function loadConfig() {
  const p = path.join(REPO_ROOT, 'backend', 'deploy.config.json');
  if (!fs.existsSync(p)) {
    console.error(`✗ ${p} not found. This script needs the deployment context (data-plane ARN, region).`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const config = loadConfig();
const REGION = config.region || process.env.AWS_REGION || 'us-east-1';
const DATA_PLANE_ARN = config.dataPlaneArn || process.env.AURORA_DATA_PLANE_ARN;

if (!DATA_PLANE_ARN) {
  console.error(
    '✗ missing context. Need dataPlaneArn in backend/deploy.config.json'
    + ' (or AURORA_DATA_PLANE_ARN in the environment).',
  );
  process.exit(1);
}

const lambda = new LambdaClient({ region: REGION });

async function invokeDataPlane(op, input) {
  const response = await lambda.send(new InvokeCommand({
    FunctionName: DATA_PLANE_ARN,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify({ op, input })),
  }));
  const payload = JSON.parse(Buffer.from(response.Payload).toString('utf8'));
  if (response.FunctionError) {
    throw new Error(`data-plane '${op}' failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function main() {
  const result = await invokeDataPlane('complianceAgreement', { days: DAYS });

  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\nCompliance judge agreement, last ${DAYS} day(s)\n`);

  if (result.agreementRate === null) {
    // NOT A FAILURE, AND SAID SO PLAINLY. Nothing has been labeled, which is the starting state of
    // every deployment. Reporting a confident percentage here would be the exact thing this measures
    // against.
    console.log('  Not measured: no exchange in this window carries both a judge verdict and a human');
    console.log('  compliance label.');
    console.log('\n  To measure it, label compliance on a sample of exchanges (ground_truth_scores.');
    console.log('  human_is_compliant, human_compliance_categories) and run this again. Until then the');
    console.log('  judged half of the compliance verdict is an opinion with a citation, not evidence.');
    return;
  }

  console.log(`  Compared          ${result.compared} exchange(s) with both a verdict and a label`);
  console.log(`  Agreed            ${result.agreed} (${result.agreementRate}%)`);
  // THE TWO DIRECTIONS COST DIFFERENT THINGS, so they are never summed into one number. A missed
  // breach is what makes a compliance report worthless; an over-flag is triage work.
  console.log(`  Judge missed      ${result.judgeMissedBreach} breach(es) a person found`);
  console.log(`  Judge over-flagged ${result.judgeOverflagged} exchange(s) a person cleared`);

  if (result.byRule?.length) {
    console.log('\n  Per rule, worst disagreement first:');
    console.log('    rule                             severity  scope       judge only  human only  both');
    for (const r of result.byRule) {
      // severity/scope say how much the disagreement costs and who owns the statement. Both are null
      // for an id the current rule set no longer declares - a verdict written under an older
      // rule_set_version - and that is shown as `-` rather than quietly omitted.
      console.log(
        `    ${r.ruleId.padEnd(32)} ${String(r.severity ?? '-').padEnd(9)} ${String(r.scope ?? '-').padEnd(11)}`
        + `${String(r.judgeOnly).padStart(10)} ${String(r.humanOnly).padStart(11)} ${String(r.both).padStart(5)}`,
      );
    }
    console.log('\n  A rule the judge and a person consistently read differently is an ambiguous');
    console.log('  STATEMENT, not a model failing. A `platform` rule is the platform\'s to rewrite in');
    console.log('  lib/config/compliance-rules.ts; a `deployment` rule is the business\'s own. Either');
    console.log('  way, bump COMPLIANCE_RULE_SET_VERSION when the meaning changes.');
  }
}

main().catch((err) => {
  console.error('✗ agreement report failed:', err);
  process.exit(1);
});
