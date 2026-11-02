/**
 * WATCH A DRAIN HAPPEN, in a browser you are driving.
 *
 * This is not a test and it asserts almost nothing. It exists so a person can SEE the behavior the
 * turn-queue specs assert: a long answer starts, three messages arrive behind it, one notice appears
 * and counts up, the drain reads them, and an offer to split the subjects is put to you - which you
 * then answer yourself, in your own words, in the browser.
 *
 * WHY IT IS SEPARATE FROM turn-queue.spec.ts. That spec is machine-verified and must stay silent and
 * fast; this one is slow ON PURPOSE, prints what to look for, and hands you the browser at the end.
 * Mixing the two would make the assertions wait on a human.
 *
 * IT NEVER RUNS IN THE SUITE. `QUEUE_DEMO=1` gates it (the same shape the other opt-in specs use),
 * and validate.mjs marks its phase `manualOnly`, so a full validate run skips it entirely.
 *
 * RUN IT:
 *
 *   AWS_PROFILE=<profile> node backend/scripts/validate.mjs --only=queue-demo
 *
 * The runner resolves the live chat URL, the pools and the turn-state table from CloudFormation, so
 * there is nothing to assemble by hand - which is the same reason the e2e recipe says to go through
 * validate rather than calling playwright directly.
 *
 * OR RUN IT AS YOURSELF, in the browser you are already signed into:
 *
 *   # PowerShell. `chrome` is not on PATH on Windows, so give the full path.
 *   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 `
 *       --user-data-dir="$env:TEMP\ae-demo-profile"
 *   # then sign in once in that window, and:
 *   AWS_PROFILE=<profile> QUEUE_DEMO_USE_MY_SESSION=1 node backend/scripts/validate.mjs --only=queue-demo
 *
 * It opens a new tab in that browser and runs there, so the conversation is yours, at your own
 * classification, and you watch the drain as the person whose work it is. See `CDP_ENDPOINT` below.
 */
import { test } from './helpers/fixtures';
import { chromium, type Page } from '@playwright/test';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';

const RUN = process.env.QUEUE_DEMO === '1';
const suite = RUN ? test.describe : test.describe.skip;

/**
 * ATTACH TO THE BROWSER YOU ARE ALREADY SIGNED INTO, instead of signing in as the test user.
 *
 * Set `QUEUE_DEMO_CDP` to a Chrome DevTools endpoint (default `http://localhost:9222` when
 * `QUEUE_DEMO_USE_MY_SESSION=1`). The demo then opens a NEW TAB in that browser and runs there, so
 * the conversation is created by YOU, in your own tenant, with your own classification - which is the
 * only way to watch the queue as the person whose work it is.
 *
 * WHY CDP RATHER THAN A SAVED SESSION. The alternative is exporting a `storageState`, which writes a
 * live id token to a file on disk and leaves it there. Attaching to the running browser reads
 * nothing, copies nothing, and expires exactly when your session does.
 *
 * Start Chrome with the port open, then sign in as usual in that window:
 *
 *   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 `
 *       --user-data-dir="$env:TEMP\ae-demo-profile"
 *
 * A separate `--user-data-dir` is deliberate, and it has a cost worth stating: Chrome refuses the
 * debugging port on a profile that is ALREADY RUNNING, so this cannot attach to your everyday window
 * - you sign in once in the new one. Pointing it at your normal profile would also expose every tab
 * in it to the connection, not just this app. The profile persists, so the sign-in is one-time.
 */
const CDP_ENDPOINT = process.env.QUEUE_DEMO_CDP
  || (process.env.QUEUE_DEMO_USE_MY_SESSION === '1' ? 'http://localhost:9222' : '');

/**
 * Long enough that the assistant is still writing when the next messages land, which is the whole
 * precondition. A short prompt answers before anything can queue behind it and demonstrates nothing.
 */
const LONG_PROMPT = 'Explain in depth how employee onboarding typically works at a mid-sized company, '
  + 'from the signed offer through the end of the first quarter. Cover each stage in its own section '
  + 'with a short heading: the offer and background check, provisioning and access, first-day '
  + 'orientation, role-specific training, the thirty, sixty and ninety day check-ins, and the handover '
  + 'into ordinary management. For every stage describe who usually owns it, how long it usually takes, '
  + 'and the two or three ways it most often goes wrong. Please write at least fifteen paragraphs.';

/**
 * Three plainly different subjects, so a grouping that merges them is visibly wrong.
 *
 * The second one used to be "the three tools that process touches", which reads as "which tools does
 * that PROCESS touch" - the onboarding process the long prompt is about. Now that the reading is told
 * work is in flight, it correctly folds that into the running work and the demo shows two subjects
 * while narrating three. A demo whose fixture is ambiguous teaches the wrong lesson about the feature.
 */
const FOLLOW_UPS = [
  'Also, what was our Q3 headcount?',
  'And which competitors were flagged in the last board summary?',
  'One more thing, is the pricing page copy still accurate?',
];

/** Seconds to let the long answer get under way before the burst lands. */
const HEAD_START_MS = Number(process.env.QUEUE_DEMO_HEAD_START_MS) || 8_000;
/** Gap between the queued messages, so the notice is seen counting up rather than jumping. */
const GAP_MS = Number(process.env.QUEUE_DEMO_GAP_MS) || 1_500;

function say(line: string): void {
  console.log('\n  ' + line);
}

suite('queue demo - a burst arrives while the assistant is working', () => {
  let creds: TestCredentials;

  test.beforeAll(async () => {
    // Only needed when this signs in itself. Attached to your browser there is nobody to authenticate,
    // and demanding provisioned test credentials to watch your OWN conversation would be absurd.
    if (!CDP_ENDPOINT) creds = await getTestCredentials();
  });

  // A person drives the rest of this demo from the paused browser, so the stall detector has nothing to watch.
  test.use({ stallWindowMs: 0 });

  test('send a long request, queue three behind it, then answer the offer yourself', async ({ page: fixturePage }) => {
    // No timeout: the last step hands you the browser and waits for you, not the other way round.
    test.setTimeout(0);

    let page: Page = fixturePage;

    if (CDP_ENDPOINT) {
      // YOUR BROWSER, YOUR SESSION. The context already carries the sign-in, so there is nothing to
      // authenticate and nothing to store - a new tab in it is already you.
      const attached = await chromium.connectOverCDP(CDP_ENDPOINT);
      const context = attached.contexts()[0];
      if (!context) {
        throw new Error(
          `[queue-demo] connected to ${CDP_ENDPOINT} but it has no browser context. Start Chrome with `
          + '--remote-debugging-port=9222 and sign in to the app in that window first.',
        );
      }
      page = await context.newPage();
      const appUrl = process.env.E2E_BASE_URL;
      if (!appUrl) throw new Error('[queue-demo] E2E_BASE_URL is not set; run through validate.mjs.');
      await page.goto(appUrl);
      say('Attached to your browser at ' + CDP_ENDPOINT + ' - running as YOUR signed-in user.');
      say('NOT closing it at the end: it is yours, and the session in it is not this test\'s to end.');
    } else {
      await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
      say('Signed in as ' + creds.premiumUser.email + '. Open the same app in your own browser to watch');
      say('from a second session if you want to see it as another member would.');
    }

    const title = 'Queue demo ' + new Date().toISOString().slice(11, 19);
    await createConversation(page, title);

    say('Conversation: "' + title + '"');

    say('1/4  Sending the long request. The assistant should start answering within a few seconds.');
    await page.locator('.message-textarea').fill(LONG_PROMPT);
    await page.keyboard.press('Enter');

    await page.waitForTimeout(HEAD_START_MS);

    say('2/4  Now the burst. WATCH FOR: one notice message - not three - counting up as each lands.');
    for (const text of FOLLOW_UPS) {
      await page.locator('.message-textarea').fill(text);
      await page.keyboard.press('Enter');
      say('     sent: "' + text + '"');
      await page.waitForTimeout(GAP_MS);
    }

    say('3/4  WATCH FOR, in order:');
    say('     - the three messages styled as waiting while the long answer finishes');
    say('     - the notice settling once the queue has actually been read (not before)');
    say('     - a proposal naming each subject it found');
    say('     - an offer to split them into separate conversations, addressed to you');

    say('4/4  The browser is yours. Answer the offer in your own words - try');
    say('     "just split out Q3 headcount, leave the rest here" - and watch the offer close.');
    say('     Press Resume in the Playwright Inspector when you are done.');

    // Hands control over. Headed only; in headless this returns immediately, which is why the phase
    // runs --headed.
    await page.pause();
  });
});
