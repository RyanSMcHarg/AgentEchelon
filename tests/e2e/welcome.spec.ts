/**
 * Welcome e2e — SPEC-WELCOME-AND-CONTEXT.
 *
 * The spec makes two promises about the first thing a user ever sees, and each fails in a way nobody
 * gets a complaint about:
 *
 *   1. "Welcome always lands. The bot never opens a channel with silence." A DROPPED welcome is the
 *      shipped defect this spec exists to keep out: roughly a THIRD of new conversations rendered
 *      empty while the message sat unread in the sidebar, because the client registered its rendering
 *      consumer per-channel after creation while the bookkeeping consumer was app-level (`d92a86b`).
 *   2. The welcome copy is CONFIG-DRIVEN — a deployment supplies company/access/examples through SSM
 *      (`ASSISTANT_WELCOME_PARAM`) with no code change. The router reads that parameter through
 *      `getSsmParam`, which swallows EVERY error and returns `undefined`, so a missing parameter, a
 *      malformed one, or a revoked `ssm:GetParameter` grant all degrade to the generic platform
 *      greeting with nothing logged as a failure and nothing user-visible except worse copy.
 *
 * WHY THE PREVIOUS VERSION OF THIS FILE WAS NOT ENOUGH. It ran one premium conversation and matched
 * prose in the DOM (`toContain('stratum technologies')`). That is the CONSEQUENCE of the mechanism,
 * and it is weak in three separate directions:
 *
 *   - it passes just as well if the copy were hardcoded in TypeScript, which is precisely the claim
 *     ("config, not code") the spec makes and the test was supposed to be defending;
 *   - a DOM-only check cannot tell "the assistant never posted" from "the client dropped it", and
 *     those have different owners and different fixes;
 *   - a DROP RATE cannot be disproved by one passing run. At the historically observed ~29% a single
 *     conversation is green 71% of the time while the bug is fully present.
 *
 * WHAT THIS ASSERTS INSTEAD.
 *
 *   Test 1 (no browser): the config path is WIRED on every deployed classification — the parameter
 *     name is in the deployed handler env, the parameter resolves, the REAL parser accepts it, the
 *     handler's role is genuinely ALLOWED `ssm:GetParameter` on it, and every configured orientation
 *     is COMPLETE (a partial one degrades one piece of copy per absent field, which the router now
 *     records as an error). This is the half that cannot produce a symptom, so it gets asserted from
 *     the deployment rather than inferred from copy.
 *   Test 2/3/4 (browser, one per classification): the welcome ON THE WIRE is byte-for-byte the string
 *     the deployment's OWN SSM config composes to, computed here by importing the shipped composer.
 *     Not a substring, not the DOM: the exact bytes. Change the parameter and the expectation changes
 *     with it, which is what makes this a test of the config path rather than of a remembered
 *     sentence. Run for EVERY classification, because the orientation is configured per
 *     classification — each has its own parameter and its own access line, so premium passing says
 *     nothing about whether basic's or standard's copy ever reaches a user.
 *   Test 5 (browser): N consecutive fresh conversations, each required to render the welcome the wire
 *     delivered, with the run's detection power against the historical drop rate stated in the
 *     output — because a frequency claim needs a repeat count and an honest statement of what a green
 *     run did and did not rule out.
 *
 * Standard's welcome is a function of PROFILE STATE, not only of config: it has an onboarding intake,
 * which replaces the welcome for a user who has not been onboarded. Its test pins that precondition
 * (the same `if_not_exists` write global setup performs) and FAILS if the profile store is unreachable,
 * rather than asserting orientation copy against the intake's first question. The intake path itself is
 * `onboarding-intake.spec.ts`.
 *
 * WHAT THIS LEAVES BEHIND. Test 4 creates `WELCOME_REPEAT` (default 6) real conversations for the
 * admin test user and does not archive them. They carry no messages beyond the welcome, so they stay
 * titled "New conversation" (the title is auto-derived from a first user message that never comes).
 * Nothing downstream keys on them, but they do accumulate in that user's sidebar across runs.
 */
import { test, expect, Page } from '@playwright/test';
import { execSync, execFileSync } from 'child_process';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getAdminUser, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { ChannelWireRecorder } from './helpers/channel-wire';
// The SHIPPED composer and parser, imported rather than reimplemented. A local copy of the copy
// rules would drift from the handler and the test would keep passing against its own fiction. The
// `.ts` source is imported (not the sibling `.js`) because the compiled output is build-only and
// gitignored, so a fresh checkout has only the source.
import {
  parseWelcomeOrientationDetailed,
  composeWelcome,
  composeWelcomeMessage,
  type WelcomeOrientation,
} from '../../backend/lambda/src/lib/welcome-orientation';

guardConsoleErrors();

const REGION = process.env.AWS_REGION || 'us-east-1';
const E2E_RUNNABLE = hasTestCredentials();

/** The browser tests stay behind the existing validate.mjs phase flag; the deployed-wiring test does
 *  NOT, because it costs a handful of AWS calls and no model turn, and it is the check that catches
 *  the silent degradation. A spec that contributes nothing unless someone remembers a flag is a spec
 *  that reports green while covering nothing. */
const BROWSER_RUN = process.env.WELCOME_E2E === '1';
const browserReason = 'Set WELCOME_E2E=1 to run the browser welcome tests (a validate.mjs phase).';

/**
 * Repeat count for the drop-rate test. The defect was measured at roughly 29% per new conversation,
 * so one conversation is useless as evidence and the count has to be chosen deliberately:
 * P(at least one drop seen) = 1 - (1 - 0.29)^n. n=6 gives 87%, n=8 gives 93%, n=3 gives 64%.
 * Six is the point where the test is worth believing and still under two minutes.
 */
const HISTORICAL_DROP_RATE = 0.29;
const REPEAT = Number(process.env.WELCOME_REPEAT || 6);

function aws(args: string): any {
  const out = execSync(`aws ${args} --region ${REGION} --output json`, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  }).trim();
  return out ? JSON.parse(out) : null;
}

/** `execFileSync`-style call for arguments that must not go through cmd.exe quoting (JSON keys, JMESPath
 *  expressions with spaces and quotes). The handover records those arriving MANGLED through a shell. */
function awsArgv(args: string[]): string {
  return execFileSync('aws', [...args, '--region', REGION], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  }).trim();
}

const USER_POOL_ID = process.env.VITE_USER_POOL_ID || process.env.USER_POOL_ID || '';

/**
 * Make sure the creator is already onboarded before a STANDARD conversation is created.
 *
 * Standard is the one classification with an onboarding intake configured, and the intake REPLACES the
 * welcome for a user who has not been onboarded (`SPEC-USER-PROFILE-AND-ONBOARDING`). So the standard
 * welcome is a function of profile state, and a test that ignored that state would assert the
 * orientation copy on one run and the intake's first question on the next.
 *
 * This is the same `if_not_exists` write `e2e/global-setup.ts` already performs for every demo user, so
 * it changes nothing on a normal run - it exists so this test does not silently depend on global setup
 * having succeeded. A real `onboardedAt` and any collected facts are preserved.
 * Returns false when the profile store cannot be reached, so the caller can say so instead of guessing.
 */
function ensureOnboarded(email: string): boolean {
  try {
    if (!USER_POOL_ID) return false;
    const sub = awsArgv([
      'cognito-idp', 'admin-get-user', '--user-pool-id', USER_POOL_ID, '--username', email,
      '--query', "UserAttributes[?Name=='sub'].Value | [0]", '--output', 'text',
    ]);
    const table = awsArgv([
      'ssm', 'get-parameter', '--name', '/agent-echelon/shared/tables/user-profile-name',
      '--query', 'Parameter.Value', '--output', 'text',
    ]);
    if (!sub || sub === 'None' || !table || table === 'None') return false;

    awsArgv([
      'dynamodb', 'update-item', '--table-name', table,
      '--key', JSON.stringify({ userSub: { S: sub } }),
      '--update-expression', 'SET onboardedAt = if_not_exists(onboardedAt, :now)',
      '--expression-attribute-values', JSON.stringify({ ':now': { S: new Date().toISOString() } }),
    ]);
    const raw = awsArgv([
      'dynamodb', 'get-item', '--table-name', table,
      '--key', JSON.stringify({ userSub: { S: sub } }), '--output', 'json',
    ]);
    return Boolean(raw && JSON.parse(raw)?.Item?.onboardedAt?.S);
  } catch {
    return false;
  }
}

interface WelcomeWiring {
  classification: string;
  fn: string;
  roleArn: string;
  /** The SSM parameter name from the deployed handler env; '' when the config path is not wired. */
  paramName: string;
  /** Raw parameter value, or null when it does not resolve. */
  paramValue: string | null;
  /** What the SHIPPED parser makes of it; null means the router falls back to the generic welcome. */
  orientation: WelcomeOrientation | null;
  /** Fields the shipped parser had to reject. Each is copy the operator wrote and the user never sees. */
  parseIssues: string[];
  /** IAM's own verdict on the handler role reading that parameter. */
  ssmDecision: string;
  /** True when this classification has an onboarding intake schema, which REPLACES the welcome for a
   *  user who has not been onboarded. Discovered rather than hardcoded: which classifications onboard
   *  is a per-deployment choice, and hardcoding "standard" would make this test wrong elsewhere. */
  onboardingConfigured: boolean;
}

/** Discover the deployed per-classification handlers and everything their welcome path depends on.
 *  Projected field-by-field: `lambda list-functions` aborts with a charmap encode error on this
 *  account because one function's Description contains a `->`. */
function discoverWelcomeWiring(accountId: string): WelcomeWiring[] {
  const names: string[] = aws(
    `lambda list-functions --query "Functions[?contains(FunctionName,'AgentEchelonClassification') `
    + `&& contains(FunctionName,'AgentHandler')].FunctionName"`,
  ) || [];

  return names.map((rawName) => {
    const fn = rawName.trim();
    const cfg = aws(`lambda get-function-configuration --function-name ${fn}`);
    const env: Record<string, string> = cfg?.Environment?.Variables ?? {};
    const paramName = env.ASSISTANT_WELCOME_PARAM || '';
    const roleArn: string = cfg?.Role || '';

    let paramValue: string | null = null;
    if (paramName) {
      try {
        paramValue = aws(`ssm get-parameter --name "${paramName}"`)?.Parameter?.Value ?? null;
      } catch {
        paramValue = null;
      }
    }

    // The grant is the part with no symptom. `getSsmParam` catches everything and returns undefined,
    // so a denied read is indistinguishable at runtime from an unconfigured deployment — the user
    // just silently gets the generic greeting. Ask IAM directly instead of inferring it from copy.
    let ssmDecision = 'not evaluated (no parameter configured)';
    if (paramName && roleArn) {
      const paramArn = `arn:aws:ssm:${REGION}:${accountId}:parameter${paramName}`;
      try {
        const sim = aws(
          `iam simulate-principal-policy --policy-source-arn ${roleArn} `
          + `--action-names ssm:GetParameter --resource-arns ${paramArn} `
          + `--query "EvaluationResults[0].EvalDecision"`,
        );
        ssmDecision = typeof sim === 'string' ? sim : 'unknown';
      } catch (err) {
        ssmDecision = `simulation failed: ${(err as Error).message.split('\n')[0]}`;
      }
    }

    const parsed = parseWelcomeOrientationDetailed(paramValue);

    const intakeParam = env.ONBOARDING_INTAKE_PARAM || '';
    let onboardingConfigured = Boolean(env.ONBOARDING_INTAKE);
    if (!onboardingConfigured && intakeParam) {
      try {
        onboardingConfigured = Boolean(aws(`ssm get-parameter --name "${intakeParam}"`)?.Parameter?.Value);
      } catch {
        onboardingConfigured = false;
      }
    }

    return {
      classification: env.CLASSIFICATION || '',
      fn,
      roleArn,
      paramName,
      paramValue,
      orientation: parsed.orientation,
      parseIssues: parsed.issues,
      ssmDecision,
      onboardingConfigured,
    };
  });
}

/** The exact string the deployed router will compose for a fresh conversation with no topic and no
 *  drift carry-over. Orientation is ASSEMBLED, so those would ADD clauses rather than replace the
 *  deployment copy; a UI-created conversation carries neither, so the deployment fields are the whole
 *  assembly here. */
function expectedWelcomeFor(w: WelcomeWiring | undefined): string {
  return composeWelcomeMessage(w?.orientation ?? null);
}

/** Create a conversation and capture the channel ARN the backend assigned it, so the wire recorder
 *  can be asked about THAT channel rather than about whatever happens to be on screen. */
async function createAndCaptureArn(
  page: Page,
  title: string,
  classificationLabel: string,
  assertWelcome: boolean,
): Promise<{ channelArn: string; welcomeRendered: boolean; renderError: string | null }> {
  const createResp = page.waitForResponse(
    (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
    { timeout: 30_000 },
  );

  let renderError: string | null = null;
  let welcomeRendered = true;
  try {
    // The shared helper asserts the welcome renders. For the drop-rate test that assertion has to be
    // CAUGHT rather than thrown, because the whole point is to classify the failure (wire-vs-DOM)
    // instead of just reporting it — and to keep counting across the remaining iterations.
    await createConversation(page, title, classificationLabel);
  } catch (err) {
    if (assertWelcome) throw err;
    welcomeRendered = false;
    renderError = (err as Error).message.split('\n')[0];
  }

  // The response may never arrive if `createConversation` failed BEFORE submitting the modal. Let
  // that surface as an empty ARN rather than as a waitForResponse timeout thrown over the top of the
  // real cause, which reads as a harness fault instead of a product one.
  let channelArn = '';
  try {
    channelArn = (await (await createResp).json())?.conversation?.conversationArn || '';
  } catch {
    channelArn = '';
  }
  return { channelArn, welcomeRendered, renderError };
}

test.describe('Welcome — the deployment\'s configured orientation reaches the user', () => {
  test.skip(!E2E_RUNNABLE, 'Needs AWS credentials to read the deployed handlers and SSM config.');
  guardBackendErrors('welcome');

  let wiring: WelcomeWiring[] = [];
  let accountId = '';

  test.beforeAll(() => {
    if (!E2E_RUNNABLE) return;
    accountId = aws('sts get-caller-identity --query Account') || '';
    wiring = discoverWelcomeWiring(accountId);
  });

  test('the config-driven welcome path is wired and readable on every deployed classification', async () => {
    test.setTimeout(180_000);

    expect(
      wiring.length,
      'no deployed per-classification AgentHandler was found, so nothing about the welcome path was '
      + 'actually checked. Every assertion below would pass vacuously.',
    ).toBeGreaterThan(0);

    console.log(
      '\n--- deployed welcome configuration ---\n'
      + wiring.map((w) => {
        const state = !w.paramName
          ? 'NOT WIRED (no ASSISTANT_WELCOME_PARAM in the handler env)'
          : w.paramValue === null
            ? 'parameter does not resolve -> generic welcome'
            : w.orientation === null
              ? 'parameter resolves but the parser REJECTS it -> generic welcome'
              : `configured (${w.orientation.companyName || 'no company'}, `
                + `${w.orientation.examples?.length ?? 0} example(s))`;
        return `  ${w.classification || '(no CLASSIFICATION)'}: ${state}\n`
          + `      param=${w.paramName || '-'}\n`
          + `      ssm:GetParameter -> ${w.ssmDecision}`;
      }).join('\n'),
    );

    // A deployment MAY legitimately ship no orientation at all — absent config is the documented
    // generic-welcome path, and asserting configuration would fail a correct deployment. What is
    // never legitimate is config that exists and does not reach the user. So: the parameter name must
    // be present (the code path has to be reachable at all), and wherever a parameter resolves, the
    // parser must accept it and IAM must allow the read.
    const problems: string[] = [];
    for (const w of wiring) {
      const cls = w.classification || w.fn;
      if (!w.paramName) {
        problems.push(
          `${cls}: the handler env carries no ASSISTANT_WELCOME_PARAM, so the config-driven welcome `
          + 'is unreachable for this classification no matter what an operator writes to SSM.',
        );
        continue;
      }
      if (w.paramValue !== null && w.orientation === null) {
        problems.push(
          `${cls}: ${w.paramName} resolves but parseWelcomeOrientation REJECTS its value, so the `
          + 'router silently serves the generic welcome. An operator who wrote that parameter has no '
          + 'way to tell — nothing errors.',
        );
      }
      if (w.ssmDecision !== 'allowed') {
        problems.push(
          `${cls}: the handler role is "${w.ssmDecision}" for ssm:GetParameter on ${w.paramName}. `
          + 'getSsmParam swallows the error and returns undefined, so a denied read is invisible at '
          + 'runtime and shows up only as worse copy.',
        );
      }
      // Per-field completeness. A missing field no longer discards the rest of the orientation - it
      // omits its own piece of copy and the router records it - but the omission is still a piece of
      // the welcome this deployment INTENDED and no user ever sees. Asserted here rather than left to
      // the metric, so it fails a run instead of waiting for someone to read a dashboard.
      if (w.orientation) {
        const composed = composeWelcome(w.orientation);
        if (composed.missingFields.length > 0) {
          problems.push(
            `${cls}: ${w.paramName} omits ${composed.missingFields.join(', ')}, so the welcome renders `
            + 'without those pieces. The rest of the orientation is unaffected and the router emits '
            + 'welcome_orientation_incomplete, but the copy the deployment configured is incomplete.',
          );
        }
        if (w.parseIssues.length > 0) {
          problems.push(
            `${cls}: ${w.paramName} parsed with rejections (${w.parseIssues.join('; ')}). Each one is a `
            + 'field the operator wrote and the user will not see.',
          );
        }
      }
    }

    // Vacuity guard, in the shape this suite settled on: if nothing is configured anywhere, every
    // check above is satisfied by an empty deployment and this test proves nothing. Say so.
    const configured = wiring.filter((w) => w.orientation !== null);
    expect(
      configured.length,
      'no classification has a resolvable, parseable welcome orientation, so the config-driven claim '
      + 'was not exercised at all — the checks above only confirmed that an unconfigured deployment '
      + 'is unconfigured. Seed the orientation (backend/scripts/seed-demo.ts) before trusting this.',
    ).toBeGreaterThan(0);

    expect(
      problems,
      'the welcome the user sees is not the welcome this deployment is configured to give:',
    ).toEqual([]);
  });

  // EVERY classification, not just the flagship one. The orientation is configured per classification
  // (each has its own SSM parameter and its own access line), so premium passing says nothing about
  // whether basic's or standard's copy ever reaches a user. A per-classification claim needs a
  // per-classification test.
  for (const [label, classification] of [['Open', 'basic'], ['Standard', 'standard'], ['Premium', 'premium']] as const) {
    test(`[${classification}] the welcome on the wire is byte-for-byte this deployment's configured copy`, async ({ page }) => {
      test.skip(!BROWSER_RUN, browserReason);
      test.setTimeout(180_000);

      const admin = await getAdminUser();
      test.skip(!admin.password, missingUserReason('testAdmin'));

      const w = wiring.find((x) => x.classification === classification);
      expect(w, `no deployed handler carries CLASSIFICATION=${classification}`).toBeDefined();

      // Standard carries an onboarding intake, which REPLACES the welcome for a user who has not been
      // onboarded. Pin that precondition rather than hoping global setup ran, and treat an unreachable
      // profile store as a failure: without it this test would assert the orientation copy against the
      // intake's first question and report a product defect that is really a missing precondition.
      if (w!.onboardingConfigured) {
        expect(
          ensureOnboarded(admin.email),
          `${classification} has an onboarding intake configured, so its welcome depends on whether the `
          + 'creator is already onboarded. The profile store could not be reached to pin that, so this '
          + 'test cannot know which of the two welcomes to expect. Set VITE_USER_POOL_ID and ensure AWS '
          + 'credentials reach Cognito plus the user-profile table.',
        ).toBe(true);
      }

      // Meaningful in EITHER configuration rather than skipping when unconfigured: with orientation
      // the expectation is the composed company copy, without it the expectation is the generic
      // greeting. Both are exact, and the un-configured deployment is the one that ships by default.
      const expected = expectedWelcomeFor(w);
      console.log(
        `\n--- ${classification}: expected welcome (${w!.orientation ? 'configured' : 'generic fallback'}) ---\n`
        + `${expected}\n--- end expected ---`,
      );

      const wire = new ChannelWireRecorder();
      wire.attach(page);
      await signIn(page, admin.email, admin.password);
      await expect(page.locator('.app-header')).toBeVisible({ timeout: 30_000 });

      const { channelArn } = await createAndCaptureArn(page, `Welcome ${classification} ${Date.now()}`, label, true);
      expect(channelArn, 'channelArn from create-conversation').toBeTruthy();

      expect(
        wire.connected,
        'no Chime websocket ever opened, so the recorder saw nothing and "no welcome on the wire" '
        + 'below would be an artifact of the harness rather than a fact about the product.',
      ).toBe(true);

      const delivered = await wire.waitForBotMessage(channelArn, 20_000);
      expect(
        delivered,
        `no assistant message reached the browser for ${channelArn}. The welcome was never posted or `
        + 'never delivered — a silent channel, which the spec\'s "welcome always lands" invariant '
        + 'exists to forbid.',
      ).not.toBeNull();

      // Print the wire bytes BEFORE the compare. A byte-for-byte assertion that fails on an encoding
      // difference (the Lex envelope, URI-encoding of the newlines) looks identical in a diff to one
      // that fails on wrong copy, and only the raw form tells them apart.
      console.log(
        `--- ${classification}: wire content ---\n${delivered!.content}\n`
        + `--- raw (pre-unwrap, first 200 chars) ---\n${delivered!.raw.slice(0, 200)}\n--- end wire ---`,
      );

      // The bytes. Not a substring of the DOM: the exact string the shipped composer produces from
      // THIS deployment's own SSM parameter. Hardcoded copy in the handler fails this the moment the
      // parameter says anything else, which is the config-driven claim stated as an assertion.
      expect(
        delivered!.content,
        `the welcome delivered for a ${classification} conversation is not what this deployment's `
        + `configuration composes to. Parameter: ${w!.paramName || '(none)'}. A mismatch means either `
        + 'the router is not reading the parameter (config-driven in name only) or the copy rules '
        + 'diverged from the shipped composer.',
      ).toBe(expected);

      // And it reached the person, not just the socket. Keeping both halves is what separates
      // "delivered" from "displayed" when this fails.
      const rendered = ((await page.locator('.assistant-message .message-text').first().innerText()) || '').trim();
      expect(
        rendered.length,
        'the welcome arrived on the wire but the conversation rendered nothing — the client dropped '
        + 'it (see ConversationProvider: the single app-level channel handler, d92a86b).',
      ).toBeGreaterThan(0);
    });
  }

  test('a run of new conversations never drops its welcome', async ({ page }) => {
    test.skip(!BROWSER_RUN, browserReason);
    test.setTimeout(60_000 + REPEAT * 45_000);

    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));

    // The property under test is a RATE, so the test has to state what it can and cannot rule out.
    const power = 1 - Math.pow(1 - HISTORICAL_DROP_RATE, REPEAT);
    console.log(
      `\n--- welcome delivery, ${REPEAT} consecutive new conversations ---\n`
      + `at the historically measured ${Math.round(HISTORICAL_DROP_RATE * 100)}% drop rate, this run `
      + `has a ${Math.round(power * 100)}% chance of seeing at least one drop if the defect is back. `
      + 'Raise WELCOME_REPEAT for more power.',
    );

    const wire = new ChannelWireRecorder();
    wire.attach(page);
    await signIn(page, admin.email, admin.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30_000 });

    const droppedByClient: string[] = [];
    const neverDelivered: string[] = [];
    const latencies: number[] = [];

    for (let i = 1; i <= REPEAT; i++) {
      const startedAt = Date.now();
      // assertWelcome=false: catch the render failure so the run can CLASSIFY it and keep going. A
      // throw here would report one failure with no idea which side of the socket it happened on.
      const { channelArn, welcomeRendered, renderError } = await createAndCaptureArn(
        page,
        `Welcome repeat ${i} ${Date.now()}`,
        'Open',
        false,
      );

      const delivered = channelArn ? await wire.waitForBotMessage(channelArn, 20_000) : null;
      if (delivered) latencies.push(delivered.atMs - startedAt);

      if (!welcomeRendered) {
        // This is the whole reason the wire is recorded. Same symptom, two different defects.
        if (delivered) {
          droppedByClient.push(
            `#${i} ${channelArn}: delivered on the wire at +${delivered.atMs - startedAt}ms `
            + `("${delivered.content.slice(0, 60)}...") but never rendered — ${renderError}`,
          );
        } else {
          neverDelivered.push(`#${i} ${channelArn || '(no ARN)'}: nothing on the wire — ${renderError}`);
        }
      }
      console.log(
        `  #${i}: ${welcomeRendered ? 'rendered' : 'MISSING'}`
        + `${delivered ? ` (wire +${delivered.atMs - startedAt}ms)` : ' (nothing on the wire)'}`,
      );
    }

    // Without a socket, "nothing on the wire" says nothing about the product.
    expect(
      wire.connected,
      'no Chime websocket ever opened, so this run cannot distinguish a dropped welcome from an '
      + 'undelivered one and its verdict is meaningless.',
    ).toBe(true);

    if (latencies.length) {
      latencies.sort((a, b) => a - b);
      console.log(
        `--- welcome delivery latency across ${latencies.length} conversation(s): `
        + `min ${latencies[0]}ms, median ${latencies[Math.floor(latencies.length / 2)]}ms, `
        + `max ${latencies[latencies.length - 1]}ms ---`,
      );
    }

    expect(
      droppedByClient,
      'the CLIENT dropped a welcome it had already received. This is the d92a86b regression: the '
      + 'rendering consumer was not registered for the channel when the message arrived, so the '
      + 'conversation opens empty while the sidebar shows an unread. Look at ConversationProvider\'s '
      + 'single app-level channel handler and the active-conversation ref.',
    ).toEqual([]);

    expect(
      neverDelivered,
      'a new conversation received no assistant message at all. Either the WelcomeIntent never fired '
      + '(check the router\'s WelcomeIntent branch and the Lex fulfillment hook) or Chime did not '
      + 'deliver it. The spec\'s "welcome always lands" invariant forbids the silent channel.',
    ).toEqual([]);
  });
});
