/**
 * Every Lambda that BUNDLES the schema must also APPLY it.
 *
 * THE DEFECT THIS PINS, observed 2026-08-09. `schema/019-turn-audit.sql` was written, committed,
 * tested and deployed. The stack reported complete success. The first data-plane op that used the new
 * table then failed with `relation "turn_events" does not exist`, because the migration had never been
 * applied anywhere.
 *
 * WHY IT LOOKED FINE. Three separate things all have to line up, and only two of them did:
 *   1. `schema-init` (the CDK Custom Resource) bootstraps on CREATE only. It runs with password auth,
 *      and `IamAuthSetup` then grants `rds_iam`, which disables password auth - so it can never
 *      reconnect. On every later deploy it fires as an Update and no-ops, BY DESIGN.
 *   2. `dbLambdaCommandHooks()` copies `schema/*.sql` into the bundle of every DB Lambda. That is what
 *      makes runtime application POSSIBLE.
 *   3. `ensureSchema()` is what makes it HAPPEN - and it was called by only 3 of the 8 Lambdas that
 *      bundled the files.
 *
 * Bundling the schema reads as "this Lambda can apply migrations" and is not the same claim. The
 * system stayed apparently healthy because `kinesis-archival` calls `ensureSchema` and runs on every
 * message, so migrations always landed a moment later via a path nobody was watching - until a Lambda
 * that runs FIRST needed a new table.
 *
 * SOURCE-LEVEL, like `control-parity.test.ts`: it asserts the entry module references `ensureSchema`.
 * It cannot prove the call is reached on every branch - that is what the behavioural tests cover - but
 * it does catch the failure that actually happened, which was no call at all.
 *
 * ADDING A DB LAMBDA? Add its entry file here. The list is derived from the stack below, so a new one
 * that bundles the schema fails this test until it is listed AND calls `ensureSchema`.
 */
import { stripComments } from '../helpers/strip-comments';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora');
const STACK = path.join(__dirname, '..', '..', 'lib', 'stacks', 'analytics-stack-aurora.ts');

/**
 * The entry modules of every Lambda the Aurora stack builds with `dbLambdaCommandHooks()`.
 *
 * `schema-init.ts` is deliberately ABSENT: it is the bootstrap itself, applies the files directly,
 * and must not call `ensureSchema` (which runs on the IAM connection it does not have).
 */
const DB_LAMBDA_ENTRIES = [
  'kinesis-archival.ts',
  'evaluation-runner.ts',
  'summary-updater.ts',
  'abandonment-detector.ts',
  'document-ingestion.ts',
  'data-plane-handler.ts',
  'classifier-replay-handler.ts',
  'analytics-query.ts',
];

describe('every schema-bundling Lambda applies pending migrations', () => {
  it.each(DB_LAMBDA_ENTRIES)('%s calls ensureSchema()', (entry) => {
    const src = fs.readFileSync(path.join(SRC, entry), 'utf8');
    // Strip comments so this file's own rationale, quoted in the handlers, cannot satisfy the check.
    const code = stripComments(src);
    expect(code).toContain('ensureSchema(');
  });

  it('lists every Lambda the stack builds with dbLambdaCommandHooks()', () => {
    // The list above is hand-maintained, which is exactly how the original gap survived: someone adds
    // a ninth DB Lambda and nothing notices. Count the real uses in the stack and hold the list to it,
    // so a new one fails HERE rather than silently inheriting the defect.
    const stack = fs.readFileSync(STACK, 'utf8');
    const uses = (stack.match(/commandHooks:\s*dbLambdaCommandHooks\(\)/g) || []).length;
    expect(uses).toBe(DB_LAMBDA_ENTRIES.length);
  });
});
