/**
 * Run the DEPLOYED evaluation runner on demand, the same way `validate.mjs` already does.
 *
 * The runner is on a 30-minute schedule, which is far longer than an e2e is willing to wait, so
 * `backend/scripts/validate.mjs` has an `evaluate` phase that invokes it synchronously. This is that
 * same invocation and deliberately not a second one: the SAME environment variable
 * (`EVAL_LAMBDA_NAME`, resolved by validate from the `EvaluationLambdaName` output of
 * `<prefix>Archive` in Aurora mode, with an instance-anchored function-name fallback) and the SAME payload
 * (`{ action: 'post-e2e' }`, which the handler ignores - it always scores the unscored backlog).
 *
 * WHY THE FUNCTION NAME IS NOT RESOLVED HERE. Resolving it a second way is how two callers come to
 * invoke two different Lambdas, and validate's own comment records the near-miss that shape produced:
 * an unanchored `contains('AnalyticsAuro')` matched ANOTHER project's evaluation Lambda in this shared
 * account. A spec that scored another deployment's data would still have gone green. So the name
 * arrives from the environment or the caller states the precondition is missing and stops.
 *
 * WHY THE CLI RATHER THAN THE SDK. Every other backend read in this suite goes through the AWS CLI
 * with the run's `AWS_PROFILE` (`helpers/test-credentials.ts`, `helpers/task-backend.ts`,
 * `helpers/signed-analytics.ts`), and `tests/` has no AWS SDK dependency beyond Secrets Manager.
 * `task-backend.aws()` is not reused for the invoke itself because it pins a 30-second timeout: the
 * runner scores up to `EVAL_MAX_PER_RUN` (200) exchanges with a Bedrock call each, so a synchronous
 * invoke legitimately runs for minutes. `--cli-read-timeout 0` is what keeps the CLI from giving up on
 * a run that is still working, which would otherwise read as a broken runner.
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { jsonArg } from './task-backend';

const AWS_PROFILE = process.env.AWS_PROFILE || 'default';
const REGION = process.env.AWS_REGION || 'us-east-1';

/** What the runner's handler returns in its body. All counts; `runId` names the pass. */
export interface EvaluationRunResult {
  /** Exchanges WRITTEN by this pass. Zero is normal when the backlog is already scored. */
  evaluated: number;
  errors: number;
  imageSkipped: number;
  flowsScored: number;
  flowErrors: number;
  driftOffersScored: number;
  driftOfferErrors: number;
  runId: string;
}

/** The runner's deployed function name, as validate.mjs resolved it. Null means it was not resolved. */
export function evaluationLambdaName(): string | null {
  return process.env.EVAL_LAMBDA_NAME || null;
}

/**
 * The reason a caller must state when the runner cannot be reached, so a gated test says WHICH
 * precondition is missing rather than opting out silently. Mirrors `missingUserReason` in
 * `helpers/test-credentials.ts` - same gate, with the why attached, which
 * `e2e/reporters/skip-visibility.ts` then groups and prints.
 */
export const MISSING_RUNNER_REASON =
  'EVAL_LAMBDA_NAME is not set, so the deployed evaluation runner cannot be invoked. It is resolved '
  + 'by backend/scripts/validate.mjs from the EvaluationLambdaName output of <prefix>Archive, '
  + 'which exists only in AURORA analytics mode - Athena mode deploys a different and much smaller '
  + 'runner and has no evaluation_results table to read. Run this through '
  + '`node backend/scripts/validate.mjs --only=evaluation-verdicts`, or export EVAL_LAMBDA_NAME.';

/**
 * Invoke the runner and return its parsed body.
 *
 * Throws on anything that is not a clean 200 with a parseable body - a `FunctionError` (the handler
 * threw), a non-200 `StatusCode`, or a 500 body (the handler's own catch). Each of those is a
 * deployment fault and must fail the test that asked for a run, never be read as "nothing to score".
 */
export function invokeEvaluationRunner(): EvaluationRunResult {
  const name = evaluationLambdaName();
  if (!name) throw new Error(MISSING_RUNNER_REASON);

  const payload = jsonArg({ action: 'post-e2e' });
  // `aws lambda invoke` writes the response payload to a FILE rather than to stdout, so it needs a
  // writable path. `jsonArg` already owns a per-run temp directory and hands back a fresh path in it;
  // the placeholder JSON it writes there is overwritten by the CLI. Reusing it keeps one temp-directory
  // policy in the suite rather than a second one here.
  const outFile = jsonArg({}).replace(/^file:\/\//, '');

  const meta = execSync(
    `aws lambda invoke --function-name "${name}" --payload ${payload}`
    + ` --cli-binary-format raw-in-base64-out --cli-read-timeout 0 --cli-connect-timeout 20`
    + ` --region ${REGION} --output json "${outFile}"`,
    {
      encoding: 'utf8',
      // Generous, because a full backlog pass is a Bedrock call per exchange. The CLI has no read
      // timeout of its own (above), so this is the only limit; a runner still working at 13 minutes
      // is a finding rather than something to wait longer for.
      timeout: 13 * 60_000,
      env: { ...process.env, AWS_PROFILE, MSYS_NO_PATHCONV: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    },
  ).trim();

  const invokeMeta = meta ? JSON.parse(meta) : {};
  if (invokeMeta.FunctionError) {
    throw new Error(
      `the evaluation runner returned a FunctionError (${invokeMeta.FunctionError}). `
      + `Payload: ${readOutFile(outFile).slice(0, 500)}`,
    );
  }
  if (invokeMeta.StatusCode !== 200) {
    throw new Error(`lambda invoke answered StatusCode ${invokeMeta.StatusCode} for ${name}`);
  }

  const raw = readOutFile(outFile);
  let envelope: { statusCode?: number; body?: string };
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error(`the evaluation runner's response was not JSON: ${raw.slice(0, 500)}`);
  }
  if (envelope.statusCode !== 200) {
    // The handler catches its own errors and answers 500 with `{error}`. A caller that read only the
    // invoke's StatusCode would call that a successful run of zero exchanges.
    throw new Error(`the evaluation runner answered ${envelope.statusCode}: ${String(envelope.body).slice(0, 500)}`);
  }
  const body = JSON.parse(String(envelope.body || '{}'));
  return {
    evaluated: Number(body.evaluated || 0),
    errors: Number(body.errors || 0),
    imageSkipped: Number(body.imageSkipped || 0),
    flowsScored: Number(body.flowsScored || 0),
    flowErrors: Number(body.flowErrors || 0),
    driftOffersScored: Number(body.driftOffersScored || 0),
    driftOfferErrors: Number(body.driftOfferErrors || 0),
    runId: String(body.runId || ''),
  };
}

function readOutFile(file: string): string {
  try {
    return String(readFileSync(file, 'utf8'));
  } catch (err) {
    return `(could not read the invoke output file ${file}: ${String(err)})`;
  }
}
