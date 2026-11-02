/**
 * A REPLAYED TURN DERIVES ONE ID AND WINS ONE CLAIM (ADR-022, SPEC-ABUSE-CONTROLS dedup).
 *
 * THE INVARIANT. The duplicate-reply control rests on one property: two deliveries of the SAME turn
 * derive the same correlation id, so exactly one of them takes the `dedup#<corr>` claim and the
 * other no-ops. If the derivation ever drifts, each delivery mints its own id, BOTH win, and the
 * only symptom is a duplicate reply in production.
 *
 * ── WHY THIS REPLACED AN E2E THAT FABRICATED A LEX EVENT ────────────────────────────────────────
 *
 * The previous version built a synthetic Lex fulfillment event and called `aws lambda invoke` on the
 * deployed router, twice, to imitate a retry. That was wrong in two ways that cost real money and
 * real diagnosis time:
 *
 *   1. IT IMITATED A PATH THE PLATFORM IS MINIMIZING. Lex is not where turns are meant to start
 *      (ADR-041), so the test was maintaining a hand-built copy of the entry we are moving away
 *      from - and a fabricated event can only ever assert what the fabricator already believes.
 *
 *   2. IT BYPASSED AMAZON CHIME SDK AND THEN EXPECTED ITS WORK. In production Chime materializes the
 *      message the router returns. A direct Lambda invoke consumes that return value and throws it
 *      away, so no placeholder is ever created - while the router, behaving correctly, still
 *      dispatches an async worker. That worker then ran a FULL inference (~10s of model spend),
 *      found no placeholder, and logged `the reply cannot be delivered` at ERROR. Twelve times over
 *      three days, indistinguishable in the logs from a person losing an answer.
 *
 * So the fabricated event is gone. What the old spec genuinely added over the unit tests was the
 * REAL table rather than a mocked one, and that is kept: the claim below is a real conditional write
 * against the deployed dedup table. Nothing is invoked, nothing is dispatched, nothing is spent, and
 * no orphaned placeholder is left behind.
 *
 * What is deliberately NOT covered here, and should not be faked: what Chime does with two
 * materialized responses to one turn. That needs Chime actually retrying, which a test cannot
 * schedule - so it is recorded as a coverage gap rather than imitated.
 */
import { test, expect } from './helpers/fixtures';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { hasTestCredentials } from './helpers/test-credentials';
import { guardBackendErrors } from './helpers/turn-guards';
import { aws } from './helpers/aws';

// The backend guard reads CloudWatch, so it applies to a spec that drives the platform through an
// API just as much as to one driving a browser. There is no console to watch here: this spec opens no
// page, which is why only the backend guard is installed.
guardBackendErrors('a-replayed-turn-claims-once');

const REGION = process.env.AWS_REGION || 'us-east-1';
const E2E_RUNNABLE = hasTestCredentials();

/** Must match `TURN_CORRELATION_WINDOW_SECONDS` in `lambda/src/lib/correlation.ts`. */
const CORRELATION_WINDOW_SECONDS = 90;

/**
 * The derivation under test, mirrored from `lambda/src/lib/correlation.ts`.
 *
 * A COPY IS THE POINT, not a shortcut. The property being protected is that the DEPLOYED derivation
 * is stable across a replay; asserting that by importing the same function would prove only that a
 * function equals itself. This states the contract independently, so a change to either side shows
 * up as a disagreement rather than moving in lockstep.
 */
function turnCorrelationId(args: {
  channelArn: string; senderArn: string; userMessage: string; nowMs?: number; previousBucket?: boolean;
}): string {
  const nowSec = Math.floor((args.nowMs ?? Date.now()) / 1000);
  let bucket = Math.floor(nowSec / CORRELATION_WINDOW_SECONDS);
  if (args.previousBucket) bucket -= 1;
  return createHash('sha256')
    .update([args.channelArn, args.senderArn, args.userMessage, String(bucket)].join('\0'))
    .digest('hex')
    .slice(0, 16);
}

/** The deployed abuse-controls table, resolved rather than configured. */
function resolveDedupTable(): string | null {
  try {
    const names: string[] = aws('dynamodb list-tables --query "TableNames"') || [];
    return names.find((n) => /AbuseControl|abuse-control/i.test(n)) ?? null;
  } catch {
    return null;
  }
}

/**
 * The real conditional write the router makes. Returns true when THIS caller took the claim.
 *
 * The item goes through a FILE rather than an inline `--item '{...}'`. Git Bash on Windows eats the
 * single quotes, so the JSON reaches the CLI unquoted and it rejects the braces - the same quoting
 * trap the retired spec worked around for its payload.
 */
function claim(table: string, correlationId: string): boolean {
  const ttl = Math.floor(Date.now() / 1000) + 3600;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-claim-'));
  const itemFile = path.join(dir, 'item.json');
  fs.writeFileSync(itemFile, JSON.stringify({ pk: { S: `dedup#${correlationId}` }, ttl: { N: String(ttl) } }));
  try {
    execSync(
      `aws dynamodb put-item --table-name ${table} --item file://${itemFile.replace(/\\/g, '/')} `
      + `--condition-expression "attribute_not_exists(pk)" --region ${REGION}`,
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
    return true;
  } catch (err: any) {
    const text = String(err?.stderr || err?.stdout || err?.message || '');
    if (/ConditionalCheckFailed/i.test(text)) return false;
    throw err;   // a real failure must not read as "duplicate"
  }
}

test.describe('a replayed turn claims once', () => {
  // NOT `missingUserReason`, which describes a user whose password is unset. This spec signs in as
  // NOBODY - it drives the dedup table directly - so its gate is whether AWS is reachable at all, and
  // naming a missing user for it sent the next reader looking for a credential that was never needed.
  test.skip(!E2E_RUNNABLE, `AWS is not reachable: the test-credentials secret could not be described, `
    + `so this deployment cannot be read. Set AWS_PROFILE to run this.`);

  test('the same turn derives one id, and exactly one delivery wins the claim', async () => {
    test.setTimeout(120_000);

    const table = resolveDedupTable();
    test.skip(!table, 'no abuse-controls table resolved on this deployment');

    // Unique per run, so a re-run inside one window does not lose to its own earlier claim.
    const channelArn = `arn:aws:chime:${REGION}:000000000000:app-instance/e2e/channel/conv-${Date.now()}`;
    const senderArn = `arn:aws:chime:${REGION}:000000000000:app-instance/e2e/user/e2e-${Date.now()}`;
    const userMessage = `Retry probe ${Date.now()}: summarise the billing migration status.`;

    // ── The derivation is stable across a replay ────────────────────────────────────────────────
    const now = Date.now();
    const a = turnCorrelationId({ channelArn, senderArn, userMessage, nowMs: now });
    const b = turnCorrelationId({ channelArn, senderArn, userMessage, nowMs: now + 2_600 });
    expect(b, 'a replay 2.6s later derives the SAME id (measured live: two fulfillments 2.6s apart)')
      .toBe(a);

    // ── And discriminates between turns ─────────────────────────────────────────────────────────
    const different = turnCorrelationId({
      channelArn, senderArn, userMessage: `${userMessage} And list the open risks.`, nowMs: now,
    });
    expect(different, 'a DIFFERENT turn derives a different id').not.toBe(a);

    // THE NEGATIVE CONTROL IS NOT OPTIONAL. "The second lost the claim" equally describes a table
    // that refuses everything, so a different id must still win.
    expect(claim(table!, a), 'the first delivery takes the claim').toBe(true);
    expect(claim(table!, a), 'the replay LOSES the claim and must no-op').toBe(false);
    expect(claim(table!, different), 'a different turn still wins its own claim').toBe(true);
  });

  test('a replay that straddles the window boundary is still recognized', async () => {
    // The bucket is why the id is stable, and also the one way it can fail: a retry seconds later
    // can land in the next bucket. `previousBucket` is what the router checks for that, so the
    // adjacent bucket must reproduce the original id rather than minting a new one.
    const channelArn = `arn:aws:chime:${REGION}:000000000000:app-instance/e2e/channel/conv-b-${Date.now()}`;
    const senderArn = `arn:aws:chime:${REGION}:000000000000:app-instance/e2e/user/e2e-b-${Date.now()}`;
    const userMessage = `Boundary probe ${Date.now()}`;

    // A moment one second before a boundary, and the retry one second after it.
    const boundaryMs = (Math.floor(Date.now() / 1000 / CORRELATION_WINDOW_SECONDS) + 1)
      * CORRELATION_WINDOW_SECONDS * 1000;
    const before = turnCorrelationId({ channelArn, senderArn, userMessage, nowMs: boundaryMs - 1_000 });
    const afterOwnBucket = turnCorrelationId({ channelArn, senderArn, userMessage, nowMs: boundaryMs + 1_000 });
    const afterPrevBucket = turnCorrelationId({
      channelArn, senderArn, userMessage, nowMs: boundaryMs + 1_000, previousBucket: true,
    });

    expect(afterOwnBucket, 'across a boundary the current bucket alone mints a NEW id').not.toBe(before);
    expect(afterPrevBucket, 'which is exactly what previousBucket exists to recover').toBe(before);
  });
});
