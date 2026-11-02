/**
 * Abuse controls E2E — the rate limit refuses a turn on the DEPLOYED path.
 *
 * WHY THIS SPEC EXISTS. `SPEC-ABUSE-CONTROLS.md` says "Implemented (all phases)" and its unit tests
 * assert the control-plane logic against a mocked table. Nothing asserted that the controls are
 * WIRED on the deployed handler. Every limit fails closed, so a handler whose table env is empty or
 * whose grant was dropped refuses every turn, and synthesis refuses a wiring with no table name; a
 * limiter that was never wired at all, or whose limit is 0, is still off, which this spec reports.
 *
 * DESIGN: SEED THE COUNTER, DON'T DRIVE 61 TURNS. The basic limit is 60 requests/hour
 * (`profiles.ts` rateLimitPerHour). Driving the limit organically would mean 61 live model calls,
 * ten-plus minutes, and real spend, for one assertion. `checkRateLimit` increments
 * `ratelimit#<personId>#<hour>` with `ADD #c :one` and blocks once the count EXCEEDS the limit, so
 * seeding that row to the limit and sending one message exercises the identical deployed code
 * path - same table, same handler, same refusal - in one turn. This mirrors how
 * `drift-detection.spec.ts` seeds ChannelBattleConfig to test battle suppression.
 *
 * WHAT IT DOES NOT COVER. The spend budgets and the SSM circuit breaker are opt-in and currently
 * unset on this deployment (`BEDROCK_USER_HOURLY_BUDGET` / `BEDROCK_GLOBAL_HOURLY_BUDGET` are 0,
 * `ABUSE_CIRCUIT_PARAM` is empty). The first test REPORTS that rather than asserting it, because
 * opt-in is the documented design - but it does fail when the shared table is missing, since
 * without it every control silently no-ops.
 */
import { test, expect } from './helpers/fixtures';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { signIn, createConversation, sendAndWaitForResponse, idTokenOf } from './helpers/agent-helpers';
import { WebSocketMonitor } from './helpers/websocket-monitor';
import { getBasicUser, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { personIdFromIdToken } from './helpers/person';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { STACK_PREFIX, AGENT_HANDLER, physicalIdsInClassificationStacks } from './helpers/stack-prefix';
import { aws } from './helpers/aws';

guardConsoleErrors();

const E2E_RUNNABLE = hasTestCredentials();
const REGION = process.env.AWS_REGION || 'us-east-1';

/** The classification handler that runs `evaluateAbuseGate` before dispatching to Bedrock. */
function resolveAgentHandler(): string | null {
  // RETRIES, because an empty result here reads as "classification stack not deployed" - which gates
  // the rate-limit test with a reason that looks like a deployment choice - and a name scan of
  // `list-functions` in this many-function account returned nothing during a run and all three
  // handlers seconds later (observed live 2026-08-18). The handler is read from the classification
  // stacks, not matched on its generated name: see helpers/stack-prefix.ts.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fns = physicalIdsInClassificationStacks(AGENT_HANDLER);
      if (fns?.[0]) return fns[0];
    } catch {
      /* retry */
    }
  }
  return null;
}

function handlerEnv(fn: string): Record<string, string> {
  const cfg = aws(`lambda get-function-configuration --function-name ${fn}`);
  return (cfg?.Environment?.Variables ?? {}) as Record<string, string>;
}

/** Same UTC hour bucket `abuse-controls.ts` uses: `new Date().toISOString().slice(0, 13)`. */
function hourKey(): string {
  return new Date().toISOString().slice(0, 13);
}

/** DDB write with the payload in a temp file, so JSON survives Windows shell quoting. */
function ddbWrite(kind: 'put-item' | 'delete-item', table: string, flag: string, payload: unknown): void {
  const file = path.join(os.tmpdir(), `abuse-e2e-${kind}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  try {
    execSync(
      `aws dynamodb ${kind} --region ${REGION} --table-name ${table} ${flag} file://${file.replace(/\\/g, '/')}`,
      { encoding: 'utf8', timeout: 30000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** The person id the exchange names for the page's token: the key `checkRateLimit` counts against. */
async function personIdFrom(page: import('@playwright/test').Page): Promise<string> {
  const idToken = await idTokenOf(page);
  expect(idToken, 'idToken in localStorage after sign-in').toBeTruthy();
  return personIdFromIdToken(idToken);
}

test.describe('Abuse controls — deployed wiring', () => {
  test.skip(!E2E_RUNNABLE, 'Needs provisioned test users + AWS credentials for the Lambda read.');
  guardBackendErrors('abuse-controls-wiring');

  test('the shared control table is wired to the handler that gates dispatch', async () => {
    const fn = resolveAgentHandler();
    expect(fn, `a ${STACK_PREFIX}Classification AgentHandler function`).toBeTruthy();

    const env = handlerEnv(fn!);

    // The one hard requirement. Every limit in abuse-controls.ts refuses when ABUSE_CONTROLS_TABLE is
    // empty, and dedup is off without it, so an unset table is a handler that refuses every turn.
    expect(
      env.ABUSE_CONTROLS_TABLE || '',
      'ABUSE_CONTROLS_TABLE is empty on the deployed handler. Every limit (rate limit, spend budget) '
      + 'refuses without it and dedup is off, so the deployment refuses every turn it meters.',
    ).not.toBe('');

    // Opt-in controls: reported, not asserted. Their being off is a deployment choice the spec
    // documents; their being off SILENTLY is what this line exists to prevent.
    const optIn = {
      userSpendBudget: Number(env.BEDROCK_USER_HOURLY_BUDGET || '0') > 0,
      globalSpendBudget: Number(env.BEDROCK_GLOBAL_HOURLY_BUDGET || '0') > 0,
      circuitBreaker: Boolean(env.ABUSE_CIRCUIT_PARAM),
      inboundLengthCap: Number(env.MAX_USER_MESSAGE_LENGTH || '0') > 0,
    };
    console.log(`\n--- abuse controls, deployed state ---\n${JSON.stringify(optIn, null, 2)}`);
    console.log(
      'Rate limits come from profiles.ts (basic 60 / standard 120 / premium 240 per hour), '
      + 'not from an env var, so they are always configured for a known classification.',
    );
  });
});

test.describe('Abuse controls — the rate limit actually refuses a turn', () => {
  test.skip(!E2E_RUNNABLE, 'Needs provisioned test users + AWS credentials for the DynamoDB seed.');
  guardBackendErrors('abuse-controls-rate-limit');

  test('a user at the limit gets the notice, and no model answer', async ({ page }) => {
    test.setTimeout(180_000);

    const user = await getBasicUser();
    test.skip(!user.password, missingUserReason('basicUser'));

    const fn = resolveAgentHandler();
    test.skip(!fn, `No ${STACK_PREFIX}Classification AgentHandler found (classification stack not deployed).`);
    const table = handlerEnv(fn!).ABUSE_CONTROLS_TABLE;
    test.skip(!table, 'ABUSE_CONTROLS_TABLE is unset — covered as a failure by the wiring test above.');

    const wsMonitor = new WebSocketMonitor();
    await signIn(page, user.email, user.password, wsMonitor);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    const personId = await personIdFrom(page);

    await createConversation(page, `Abuse controls e2e ${Date.now()}`, 'Basic');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // Seed AFTER sign-in and conversation setup, so the least possible time passes between writing
    // the row and the turn that must read it — the counter is bucketed by UTC hour, and a seed
    // written at :59 would be read in the next bucket and silently not apply.
    const minute = new Date().getUTCMinutes();
    test.skip(
      minute >= 58,
      'Within 2 minutes of the UTC hour boundary; the seeded counter would land in the previous '
      + 'hour bucket and the turn would not be limited. Re-run shortly.',
    );

    const LIMIT = 60; // profiles.ts -> basic.rateLimitPerHour
    const pk = `ratelimit#${personId}#${hourKey()}`;
    const ttl = Math.floor(Date.now() / 1000) + 7200;

    ddbWrite('put-item', table!, '--item', {
      pk: { S: pk },
      count: { N: String(LIMIT) },
      ttl: { N: String(ttl) },
    });

    try {
      const reply = await sendAndWaitForResponse(page, 'What is our refund policy?', 90_000, wsMonitor);
      console.log(`\n--- reply at the rate limit ---\n${reply.text}`);

      // The refusal copy from rateLimitMessage(). Matched on the stable prefix rather than the
      // whole string, because the reset-minutes count varies with when the test runs.
      expect(
        reply.text,
        'the user was at the hourly limit, so the deployed handler should have served the '
        + 'rate-limit notice WITHOUT dispatching to Bedrock. A normal answer here means the limiter '
        + 'did not fire: check that the handler role still has the DynamoDB grant on the abuse '
        + 'table (checkRateLimit FAILS OPEN, so a denied UpdateItem is indistinguishable from '
        + 'being under the limit).',
      ).toContain("reached your message limit for this hour");

      // Falsification of the assertion above: the notice must be the WHOLE reply, not a phrase the
      // model happened to echo. A model answer would carry the refund-policy content too.
      expect(
        reply.text.toLowerCase(),
        'the reply contains the notice AND substantive content, which means a model call was made '
        + 'anyway - the notice is supposed to replace dispatch, not accompany it.',
      ).not.toContain('refund');
    } finally {
      // Always remove the seed. Without this the user stays blocked for the remainder of the UTC
      // hour and every later spec that signs in as basicUser fails for an unrelated reason.
      ddbWrite('delete-item', table!, '--key', { pk: { S: pk } });
    }
  });
});
