/**
 * Backend error listening for e2e.
 *
 * The suite is otherwise entirely client-side: it watches the DOM, the websocket, and the browser
 * console. That leaves the whole server side unobserved, and the failure mode is bad - when a
 * handler errors, the test simply waits until its timeout and then reports `locator.fill: Target
 * page closed`, naming the teardown instead of the cause, minutes after the fact.
 *
 * Worse, a handler can fail on EVERY turn without any test noticing at all. That is not
 * hypothetical: the classification handler was denied `ssm:GetParameter` on its own
 * `processor-arn` on every single request for an unknown period (fixed 2026-07-31). It logged an
 * AccessDenied stack trace every time, the code fell back to an environment variable, the turn
 * succeeded, and nothing in 1700+ unit tests or the e2e suite looked at the logs. This helper is
 * the check that would have caught it on day one.
 *
 * Shells out to the AWS CLI rather than adding an SDK dependency - `test-credentials.ts` already
 * establishes that convention in this package.
 */
import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const AWS_PROFILE = process.env.AWS_PROFILE || '';

/**
 * Resolved once per process. The set of log groups cannot change during a run, and re-listing it per
 * test cost a full CLI round-trip each time.
 */
let cachedGroups: string[] | null = null;

/**
 * Opt-out rather than opt-in: this only runs when the suite already has AWS credentials (which is
 * how `validate.mjs` runs it), so a developer running Playwright bare is unaffected. Set
 * `SKIP_BACKEND_ERROR_CHECK=1` to silence it deliberately.
 */
export function backendErrorCheckEnabled(): boolean {
  if (process.env.SKIP_BACKEND_ERROR_CHECK === '1') return false;
  // A profile is one way to hold credentials, not the only one. CI (and any run using
  // `aws configure export-credentials`) supplies them as AWS_ACCESS_KEY_ID/AWS_SESSION_TOKEN with no
  // profile set - and the earlier `Boolean(AWS_PROFILE)` test read that as "no credentials" and
  // disabled every backend guard in the suite. The CLI calls below work fine in that shape.
  return Boolean(AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
}

/** Warn once per process rather than per test, so the notice is visible without being noise. */
let announcedDisabled = false;

/**
 * Log lines that are real, but are NOT a failure of the turn under test.
 *
 * Kept deliberately short and each one justified. This list is exactly the mechanism that let the
 * console monitor hide real React defects, so the bar is "cannot possibly indicate a broken turn",
 * not "noisy".
 */
const NOT_A_TURN_FAILURE: { pattern: string; why: string }[] = [
  {
    pattern: 'NodeVersionSupportWarning',
    why: 'AWS SDK v3 deprecation notice logged at ERROR level by the Aurora Lambdas. Real '
      + 'forward-looking work (runtime is node20, SDK wants >=22 after early 2027), but it is '
      + 'emitted on every cold start regardless of the turn and says nothing about this request.',
  },
  {
    pattern: 'No placeholder for correlationId after the answer was ready',
    why: 'Expected whenever a fulfillment response is never materialised into a channel message, '
      + 'which `fulfillment-retry.spec.ts` induces DELIBERATELY by invoking the Lex handler directly '
      + '(bypassing Amazon Chime SDK, so nothing creates a placeholder). The winning invocation still '
      + 'dispatches a processor, which now runs inference before discovering it cannot deliver - the '
      + 'trade for resolving the placeholder at answer time instead of giving up before the model '
      + 'call. NOTE THE COST OF THIS ENTRY: a REAL undeliverable answer logs the same line and is no '
      + 'longer caught here. It is still caught by the turn assertions (the reply never arrives) and '
      + 'by the task being marked failed, so this is not the only net - but if that changes, this '
      + 'entry is the first thing to remove.',
  },
];

function isTurnFailure(line: string): boolean {
  return !NOT_A_TURN_FAILURE.some((e) => line.includes(e.pattern));
}

/**
 * Handler log groups, resolved once and cached for the process.
 *
 * Every deploy mints a new physical function name, so this prefix also matches groups from earlier
 * deploys (9 groups where 3 are live). They are kept anyway: a time-bounded query returns nothing
 * from a dead group, and since the queries run in parallel the extra ones cost no wall clock.
 *
 * An earlier version filtered on `lastEventTimestamp` to skip them. That field comes back as `None`
 * from this query, so `Number('None')` was NaN, EVERY group was filtered out, and the guard silently
 * checked nothing while still passing - it stopped detecting a window it had previously found 73
 * errors in. Filtering here is not worth the risk of a check that cannot fail.
 */
/**
 * The function families a turn actually runs through.
 *
 * `DataPlaneLambda` is here because the earlier prefix (`AgentEchelonClassification`) could not
 * reach it: the data plane ships with the AnalyticsAurora stack, and drift, retrieval and the
 * summary updater all execute there. That is not a hypothetical blind spot - a drift fix was
 * deployed to the Classification stacks, ran nowhere, and stayed green, because the code that
 * would have logged the failure lives in a log group nothing was reading.
 *
 * `ChannelFlowProcessor` is here for the SAME reason, found the same way on 2026-08-07: every inbound
 * message passes through the flow, and it was throwing `Invoke Error` on redelivered messages 9 times
 * in 24 hours - across five conversations, during runs this suite reported green. The turn "passed"
 * because the answer still reached the DOM; only the flow's own log group knew. A family missing from
 * this list is not a smaller check, it is no check at all for everything that runs there.
 *
 * Each family is asserted to resolve at least one group below. A CDK construct rename silently
 * empties one of these filters otherwise, which is the same class of bug as the `lastEventTimestamp`
 * regression described below: the check keeps passing, having stopped checking.
 */
const TURN_PATH_FAMILIES = ['AgentHandler', 'AsyncProcessor', 'DataPlaneLambda', 'ChannelFlowProcessor'];

function handlerLogGroups(): string[] {
  if (cachedGroups) return cachedGroups;

  const out = execSync(
    'aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/AgentEchelon" '
      + `--query "logGroups[].logGroupName" --output text ${AWS_PROFILE ? `--profile ${AWS_PROFILE}` : ''}`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );

  const all = out.split(/\s+/).filter((g) => g.length > 0);
  cachedGroups = all.filter((g) => TURN_PATH_FAMILIES.some((f) => g.includes(f)));

  // A guard that checks nothing must not pass quietly - that is the failure mode above.
  if (cachedGroups.length === 0) {
    console.warn('[backend-errors] resolved NO handler log groups; the backend check is inert this run');
  }
  for (const family of TURN_PATH_FAMILIES) {
    if (!cachedGroups.some((g) => g.includes(family))) {
      console.warn(
        `[backend-errors] no log group matched "${family}" (${all.length} AgentEchelon groups seen). `
          + 'That half of the turn path is UNWATCHED this run - check for a construct rename.',
      );
    }
  }
  return cachedGroups;
}

/**
 * Fail if any handler logged an error in the window.
 *
 * `sinceEpochMs` should be captured BEFORE the turn. CloudWatch ingestion is eventually consistent,
 * so callers that assert immediately after a reply may miss the tail; `settleMs` covers that.
 */
export async function assertNoBackendErrors(
  sinceEpochMs: number,
  context: string,
  opts: { settleMs?: number } = {},
): Promise<void> {
  if (!backendErrorCheckEnabled()) {
    // Say so. A guard that turns itself off without a word is the failure mode this whole file
    // exists to catch: the suite goes green having checked nothing, and the run reads identically
    // to one where the backend was clean.
    if (!announcedDisabled) {
      announcedDisabled = true;
      console.warn(
        '[backend-errors] DISABLED for this run - '
          + (process.env.SKIP_BACKEND_ERROR_CHECK === '1'
            ? 'SKIP_BACKEND_ERROR_CHECK=1 was set.'
            : 'no AWS credentials found (set AWS_PROFILE, or AWS_ACCESS_KEY_ID/AWS_SESSION_TOKEN).')
          + ' Handler errors will NOT fail this suite.',
      );
    }
    return;
  }

  await new Promise((r) => setTimeout(r, opts.settleMs ?? 2000));

  const found = await scanBackendErrors(sinceEpochMs);
  if (found.length > 0) throw new Error(formatBackendFailure(found, context));
}

/**
 * Collect turn-failure log lines since `sinceEpochMs`. Returns them; throws nothing.
 *
 * Extracted so the fail-fast racer and the afterAll sweep share ONE scanner. Two copies of this would
 * be two chances for the exclusion list, the parsing, or the window semantics to drift apart, and a
 * fast check that disagreed with the sweep would be worse than no fast check - it would fail runs the
 * authoritative guard considers clean.
 */
async function scanBackendErrors(sinceEpochMs: number): Promise<string[]> {
  const found: string[] = [];
  let groups: string[];
  try {
    groups = handlerLogGroups();
  } catch (err) {
    // Never fail a product test because the log query itself broke - that would turn a tooling or
    // permissions problem into a phantom product failure. Say so loudly instead.
    console.warn(`[backend-errors] could not list log groups (check skipped): ${err}`);
    return [];
  }

  // In PARALLEL. Sequentially this was one CLI round-trip per group per test, which dominated the
  // suite's wall clock - pure-JSON tests that touch no backend at all were taking ~53s each.
  await Promise.all(groups.map(async (group) => {
    try {
      // JSON, not text. `--output text` joins the messages with TABS, and a Lambda log line is
      // ITSELF `<timestamp>\t<requestId>\t<LEVEL>\t<message>` - so `split('\t')` shattered every log
      // line into four fragments. Only the message fragment could ever match NOT_A_TURN_FAILURE; the
      // timestamp, request id and bare "ERROR" fragments always survived the filter and always failed
      // the guard. That defeated EVERY exclusion in the list, not just one: a fully-excluded error
      // still reported three phantom "error lines".
      //
      // Observed 2026-08-07: `fulfillment-retry.spec.ts` failed with "logged 6 error line(s)" from
      // exactly 2 log lines, both of which the list already excludes by name.
      //
      // JSON gives one discrete string per message, so an exclusion matches the whole line.
      const { stdout } = await execAsync(
        `aws logs filter-log-events --log-group-name "${group}" --start-time ${sinceEpochMs} `
          + `--filter-pattern "?ERROR ?Exception ?AccessDenied ?Denied" `
          + `--query "events[].message" --output json ${AWS_PROFILE ? `--profile ${AWS_PROFILE}` : ''}`,
        { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, maxBuffer: 8 * 1024 * 1024 },
      );
      let messages: string[] = [];
      try {
        const parsed = JSON.parse(stdout || '[]');
        messages = Array.isArray(parsed) ? parsed.map((m) => String(m)) : [];
      } catch {
        // Malformed output must not read as "no errors" — that is the silent-pass failure mode this
        // file exists to prevent. Surface it as a finding so the run cannot go green on a parse bug.
        found.push(`${group.split('/').pop()}: [backend-errors] could not parse log output for this group`);
      }
      messages
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && isTurnFailure(l))
        .forEach((l) => found.push(`${group.split('/').pop()}: ${l.slice(0, 400)}`));
    } catch {
      // One unreadable group must not mask the others.
    }
  }));

  return found;
}

/** The shared failure text, so the fail-fast path and the afterAll sweep read identically. */
function formatBackendFailure(found: string[], context: string): string {
  const unique = [...new Set(found)].slice(0, 5);
  return (
    `[backend failure] ${context}: the handler logged ${found.length} error line(s) during this turn. `
    + `The turn may still have "passed" in the UI - a handler that fails open still logs here.\n`
    + unique.join('\n')
  );
}

/**
 * Fail a long UI wait AS SOON AS the backend logs a turn failure, instead of after the timeout.
 *
 * The afterAll sweep is the safety net, not the fast path: it runs once per FILE, so a handler that
 * crashed on the first turn was only reported after every remaining test in that file had also burned
 * its own timeout. On the battle suite that is `fireBattle`'s 260s wait, several times over, to learn
 * something CloudWatch already knew in the first few seconds. The failure was also the WRONG one - a
 * UI timeout ("expected >= 2 battle messages") names the symptom, while the handler log names the
 * cause.
 *
 * Same predicate as the sweep (`isTurnFailure`, same exclusions, same window), so this can only ever
 * report what the sweep would have reported later. It does not replace the sweep, which still catches
 * anything logged after the UI settled.
 *
 * Cost is bounded: polling only runs WHILE the wait is pending, so a healthy turn pays one or two
 * extra CloudWatch queries and a fast one pays none.
 */
export async function raceBackendErrors<T>(
  work: () => Promise<T>,
  sinceEpochMs: number,
  context: string,
  opts: { pollMs?: number; firstPollDelayMs?: number } = {},
): Promise<T> {
  if (!backendErrorCheckEnabled()) return work();

  const pollMs = opts.pollMs ?? 10_000;
  let settled = false;
  let cancel: (() => void) | undefined;

  const watcher = new Promise<never>((_resolve, reject) => {
    let timer: NodeJS.Timeout;
    const tick = async () => {
      if (settled) return;
      let found: string[] = [];
      try {
        found = await scanBackendErrors(sinceEpochMs);
      } catch {
        // A broken log query must never fail a product test - the sweep makes the same choice.
        return schedule();
      }
      if (settled) return;
      if (found.length > 0) {
        reject(new Error(`${formatBackendFailure(found, context)}\n`
          + '(failed FAST: the backend logged this while the UI wait was still pending)'));
        return;
      }
      schedule();
    };
    const schedule = () => {
      timer = setTimeout(tick, pollMs);
      // Do not hold the process open on this timer.
      if (typeof timer.unref === 'function') timer.unref();
    };
    cancel = () => clearTimeout(timer);
    // Lead-in before the first poll: a log line needs a moment to reach CloudWatch, and querying
    // instantly would mostly just cost a round-trip per wait for nothing.
    timer = setTimeout(tick, opts.firstPollDelayMs ?? pollMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

  try {
    return await Promise.race([work(), watcher]);
  } finally {
    settled = true;
    cancel?.();
  }
}
