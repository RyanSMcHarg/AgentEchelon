/**
 * A WORKFLOW STARTS A MEETING AND RINGS THE ROOM (SPEC-ASSISTANT-MEETINGS FR35 to FR39), against the deployed meetings
 * capability, router, person API and chat app.
 *
 * The workflow: a version whose welcome opens the room and then starts its meeting (`start_meeting`) validates and
 * activates. A new conversation's run starts the meeting once, tells the room with a link into the meeting window, and asks
 * the notification bridge to email that link (`notifyLink: meeting`); the meeting is then running, and its member joins it.
 *
 * The window: two people in one conversation. One starts the meeting from its window; the other, with the app open, hears
 * the ring, answers in the meeting window, and both are in the meeting, in the grid and in the speaker layout, with the
 * conversation's chat in the right column.
 *
 * GATED: the workflow part changes a deployed assistant's active version for its duration, so it runs only with
 * `E2E_WORKFLOW_TASKS=1`. Both parts need the deployment to declare `meetings` (`VITE_PERSON_API_CAPABILITIES`).
 *
 * **Coverage:** `e2e/a-workflow-starts-a-meeting-and-rings-the-room.spec.ts`
 */
import { execSync } from 'child_process';
import { test, expect } from './helpers/fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { getAdminUser, getPremiumUser, getSecondPremiumUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange } from './helpers/admin-api';
import { idTokenFor, personArnOf } from './helpers/person';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { ADMIN_API_URL, PERSON_API_URL, personApiServes, personUrl } from './helpers/api-urls';
import { activate, activeVersionOf, draftWith, messagesSeenBy, openConversation, rollBack, sleep, waitFor } from './helpers/workflow-task';
import { signIn, createConversation } from './helpers/agent-helpers';
import { addMember } from './helpers/third-party-view';
import { physicalIdsIn, stackName, type ResourceMatch } from './helpers/stack-prefix';

guardBackendErrors('a-workflow-starts-a-meeting-and-rings-the-room');
guardConsoleErrors();

// A fake camera and microphone, granted without a prompt, so a meeting connects in a headless browser.
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio'] },
  permissions: ['camera', 'microphone'],
});

const MARK = `MEET-${Date.now().toString(36)}`;
const WORKFLOW = 'e2e-meeting-welcome';

const welcome = (meet: Record<string, unknown> = { tool: 'start_meeting', ringSeconds: 15, email: true }) => ({
  [WORKFLOW]: {
    on: 'assistant-joined', initial: 'opening',
    states: {
      opening: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'meet', onFailure: 'meet' },
      meet: { action: meet, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  },
});

/** The meeting API function in a Meetings stack (`meetings-stack.ts`). */
const MEETING_API_FUNCTION: ResourceMatch = { type: 'AWS::Lambda::Function', logicalId: /^MeetingApiFunction/ };

/**
 * WHAT THIS DEPLOYMENT TURNS ON FOR A MEETING, read from the deployed meeting API's own environment, so a run asserts that a
 * meeting is transcribed and recorded wherever the deployment says it is, rather than passing when the service refused it.
 */
function deployedMeetingSetting(name: 'MEETING_TRANSCRIPTION' | 'MEETING_RECORDING' | 'MEETING_MEDIA_RECORDING'): boolean {
  const profile = process.env.AWS_PROFILE ? `--profile ${process.env.AWS_PROFILE}` : '';
  // THIS INSTANCE'S meeting API: the function its own Meetings stack holds, never another instance's in the same account.
  const [fn] = physicalIdsIn([stackName('Meetings')], MEETING_API_FUNCTION);
  if (!fn) throw new Error(`${stackName('Meetings')} has no meeting API function to read its settings from`);
  const value = execSync(`aws lambda get-function-configuration --function-name ${fn} --query "Environment.Variables.${name}" --output text ${profile}`,
    { encoding: 'utf-8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
  return name === 'MEETING_RECORDING' ? value !== 'false' : value === 'true';
}

/** POST a meeting route as the person the token names. */
async function meetingRoute(token: string, url: string, channelArn: string) {
  const resp = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ channelArn }),
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) as Record<string, any> };
}

test.describe.serial('a workflow step starts a meeting, rings the room and emails the join link', () => {
  let admin: any;
  let previousVersion: number | undefined;
  let conv: Awaited<ReturnType<typeof openConversation>> | undefined;
  // The meeting's own conversation (FR27), which the room's notice links to.
  let meetingConversationId = '';

  test.beforeAll(async () => {
    test.skip(process.env.E2E_WORKFLOW_TASKS !== '1', 'changes a deployed assistant\'s active version; set E2E_WORKFLOW_TASKS=1 to run it');
    test.skip(!personApiServes('meetings'), 'the deployment does not declare the meetings capability');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL || !PERSON_API_URL, 'VITE_ADMIN_API_URL and VITE_PERSON_API_URL are needed');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const creds = await getTestCredentials();
    const session = await exchange(idTokenFor(adminUser.email, adminUser.password, creds.cognitoClientId), { identity: 'console' });
    expect(session.status).toBe(200);
    admin = session.body.credentials;
    previousVersion = await activeVersionOf(admin);
  });

  test.afterAll(async () => {
    if (conv) await meetingRoute(conv.token, personUrl('/meetings/end'), conv.channelArn).catch(() => undefined);
    if (admin) await rollBack(admin, previousVersion);
  });

  test('a ring outside its bounds is refused with its reason, and the step validates and activates', async () => {
    test.setTimeout(180_000);
    const tooShort = await draftWith(admin, welcome({ tool: 'start_meeting', ringSeconds: 2 }));
    expect(JSON.stringify(tooShort.errors)).toContain('ringSeconds');
    const valid = await draftWith(admin, welcome());
    expect(valid.errors ?? [], JSON.stringify(valid).slice(0, 600)).toEqual([]);
    await activate(admin);
  });

  test('a new conversation\'s run starts its meeting, tells the room with the window link, and asks for the email', async () => {
    test.setTimeout(300_000);
    await sleep(35_000); // the served version is cached for 30 seconds
    conv = await openConversation(`Meeting ${MARK}`);
    const { hit, seen } = await waitFor(conv.channelId, conv.personArn, (m) => m.metadata?.eventStep?.step === 'meet');
    expect(hit, `no meeting notice; seen ${JSON.stringify(seen.slice(0, 5).map((m) => m.metadata?.eventStep))}`).toBeDefined();
    // The notice links to the meeting's own conversation, never to the room it was started from.
    meetingConversationId = /\?meeting=([A-Za-z0-9_-]+)/.exec(hit!.content)?.[1] ?? '';
    expect(meetingConversationId, hit!.content).toBeTruthy();
    expect(meetingConversationId).not.toBe(conv.channelId);
    expect(hit!.metadata.notifyLink).toBe('meeting');
    expect(hit!.metadata.notify).toEqual({ email: true });
    // Once, however the run is redelivered: read again after a redelivery has had time to land, not on the first sight of it.
    await sleep(45_000);
    expect(messagesSeenBy(conv.channelId, conv.personArn).filter((m) => m.metadata?.eventStep?.step === 'meet')).toHaveLength(1);
  });

  test('the meeting the run started is running, and its member joins it as themselves', async () => {
    test.skip(!conv, 'no conversation');
    const joined = await meetingRoute(conv!.token, personUrl('/meetings/join'), conv!.channelArn);
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body.attendee?.ExternalUserId).toBe(conv!.personArn.split('/').pop());
    // Joined from the room, they are in the meeting's own conversation, the one the notice linked to.
    expect(joined.body.conversationId).toBe(meetingConversationId);
    const status = await meetingRoute(conv!.token, personUrl('/meetings/status'), conv!.channelArn);
    expect(status.body).toMatchObject({ running: true, conversationId: meetingConversationId });
  });
});

test.describe.serial('a person starts a meeting, the room rings, and the other person joins in the meeting window', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let channelArn = '';

  test.beforeAll(async ({ browser }) => {
    test.skip(!personApiServes('meetings'), 'the deployment does not declare the meetings capability');
    const a = await getPremiumUser();
    const b = await getSecondPremiumUser();
    test.skip(!a.password, missingUserReason('premiumUser'));
    test.skip(!b?.password, 'Needs a second premium test user: a premium conversation admits only people cleared for it.');
    const arnA = await personArnOf(a);
    const arnB = await personArnOf(b!);
    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();
    await signIn(pageA, a.email, a.password);
    await signIn(pageB, b!.email, b!.password);
    const created = pageA.waitForResponse((r) => r.url().includes('/create-conversation') && r.request().method() === 'POST', { timeout: 30000 });
    await createConversation(pageA, `Meeting room ${MARK}`, 'Premium');
    channelArn = (await (await created).json())?.conversation?.conversationArn || '';
    expect(channelArn, 'the conversation was created').toBeTruthy();
    expect(addMember(channelArn, arnB, arnA), 'the second person is added').toBe(true);
    await pageB.goto(`/?conversation=${channelArn.split('/').pop()}`);
    await pageB.waitForLoadState('networkidle');
  });

  test.afterAll(async () => {
    // NO MEETING OUTLIVES THE RUN: whatever a failed test left running in this conversation is ended, so a meeting (and any
    // recording it carries) is never left billing.
    if (channelArn) {
      const a = await getPremiumUser().catch(() => undefined);
      const creds = await getTestCredentials().catch(() => undefined);
      if (a?.password && creds) {
        await meetingRoute(idTokenFor(a.email, a.password, creds.cognitoClientId), personUrl('/meetings/end'), channelArn).catch(() => undefined);
      }
    }
    await ctxA?.close();
    await ctxB?.close();
  });

  test('the starter\'s window starts the meeting, and the other person hears the ring and joins with the chat beside them', async () => {
    test.setTimeout(180_000);
    // A opens the conversation's meeting window and starts the meeting.
    await pageA.goto(`/?conversation=${channelArn.split('/').pop()}`);
    const [windowA] = await Promise.all([
      ctxA.waitForEvent('page'),
      pageA.getByTestId('open-meeting-window').click(),
    ]);
    await expect(windowA.getByTestId('meeting-window')).toBeVisible({ timeout: 30_000 });
    await windowA.getByRole('button', { name: 'Start meeting' }).click();
    await expect(windowA.getByRole('button', { name: 'Leave' })).toBeVisible({ timeout: 30_000 });

    // B, with the app open, hears the ring and answers.
    const ring = pageB.getByTestId('meeting-ring');
    await expect(ring).toBeVisible({ timeout: 20_000 });
    const [windowB] = await Promise.all([
      ctxB.waitForEvent('page'),
      ring.getByRole('button', { name: 'Join meeting' }).click(),
    ]);
    await expect(windowB.getByTestId('meeting-window')).toBeVisible({ timeout: 30_000 });
    const joinedB = windowB.waitForResponse((r) => r.url().includes('/meetings/join') && r.request().method() === 'POST', { timeout: 30_000 });
    await windowB.getByRole('button', { name: 'Join meeting' }).click();
    // B is joined into the meeting's own conversation (FR27), not the room.
    const meetingConversationId = ((await (await joinedB).json()) as { conversationId?: string }).conversationId ?? '';
    expect(meetingConversationId).toBeTruthy();
    expect(meetingConversationId).not.toBe(channelArn.split('/').pop());

    // Both are in the meeting, each with a tile, and the chat is beside it.
    await expect(windowB.getByTestId('meeting-tile')).toHaveCount(2, { timeout: 30_000 });
    await expect(windowA.getByTestId('meeting-tile')).toHaveCount(2, { timeout: 30_000 });
    await expect(windowB.locator('.ae-meeting-chat .message-textarea')).toBeVisible();

    // The chat beside the meeting is the meeting's: what is said there is not said in the room.
    const said = `From the meeting ${MARK}`;
    await windowB.locator('.ae-meeting-chat .message-textarea').fill(said);
    await windowB.locator('.ae-meeting-chat .message-textarea').press('Enter');
    await expect(windowA.getByText(said).first()).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByText(said)).toHaveCount(0);

    // The speaker layout (FR61) puts the other person on the stage and the viewer in a self view
    // over it, so with two people there is no strip.
    await windowB.getByRole('button', { name: 'Speaker' }).click();
    const stage = windowB.locator('[data-layout="speaker"] .ae-video-stage');
    await expect(stage.locator('[data-testid="meeting-self-view"]')).toHaveCount(1);
    await expect(stage.locator('[data-testid="meeting-tile"]:not([data-testid="meeting-self-view"] *)')).toHaveCount(1);
    await expect(windowB.locator('[data-layout="speaker"] .ae-video-strip')).toHaveCount(0);

    // The ring has stopped for B once answered.
    await expect(ring).toBeHidden();

    // The room is told the meeting started, and nobody already in it is offered Join.
    await expect(pageB.getByText('A meeting has started in this conversation').first()).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByTestId('meeting-in-progress')).toBeHidden();
    await expect(pageA.getByTestId('meeting-in-progress')).toBeHidden();

    // Ending it for everyone frees the conversation. A host in the meeting chooses it from the leave dialog,
    // where leaving alone is the other choice.
    await windowA.getByRole('button', { name: 'Leave' }).click();
    await windowA.getByRole('alertdialog').getByRole('button', { name: 'End for everyone' }).click();
  });

  test('the ended card says how long it ran, then gains who joined, their connected time and the drops', async () => {
    test.setTimeout(420_000);
    // The ended card names its length, how it ended and who was in it, and links the meeting's own conversation.
    await expect(pageB.getByText('Meeting ended', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    await expect(pageB.getByText('A host ended it for everyone.').first()).toBeVisible();
    await expect(pageB.getByRole('link', { name: 'Meeting conversation' }).first()).toBeVisible();
    await expect(pageB.getByTestId('meeting-in-progress')).toBeHidden();
    // About two minutes after the end, once the meeting's last events are filed, the same card is rewritten in place.
    await expect(pageB.getByText(/Joined: 2 · People:/).first()).toBeVisible({ timeout: 300_000 });
    await expect(pageB.getByText(/Connected time: \d+ min · Drops: \d+/).first()).toBeVisible();
    await expect(pageB.getByText('Meeting ended', { exact: true })).toHaveCount(1);
  });

  test('a person who arrives after the ring sees the meeting in progress, and joins it from there', async () => {
    test.setTimeout(180_000);
    const a = await getPremiumUser();
    const creds = await getTestCredentials();
    const token = idTokenFor(a.email, a.password, creds.cognitoClientId);
    // B is away: the app and its meeting window are closed while A's start rings. (A conversation has one meeting window,
    // which a second Join brings forward rather than opening another, so the earlier one is closed here.)
    for (const p of ctxB.pages()) if (p !== pageB) await p.close();
    await pageB.goto('about:blank');
    const started = await meetingRoute(token, personUrl('/meetings'), channelArn);
    expect([200, 201], JSON.stringify(started.body)).toContain(started.status);
    try {
      const status = await meetingRoute(token, personUrl('/meetings/status'), channelArn);
      expect(status.body).toMatchObject({ running: true, startedByYou: true });
      // TRANSCRIBED AND RECORDED WHERE THE DEPLOYMENT SAYS SO: the status reports what the service actually started, so a
      // refused start (an IAM denial the meeting API only logs) fails here rather than surfacing as a card with no links.
      if (deployedMeetingSetting('MEETING_TRANSCRIPTION')) {
        expect(status.body.transcribing, 'the deployment transcribes its meetings, so this one is transcribed').toBe(true);
        if (deployedMeetingSetting('MEETING_RECORDING')) expect(status.body.recording, 'and recorded').toBe(true);
      }
      await sleep(65_000); // past the longest ring
      // B comes back well after the ring: the read on load shows the meeting, with Join.
      await pageB.goto(`/?conversation=${channelArn.split('/').pop()}`);
      const banner = pageB.getByTestId('meeting-in-progress');
      await expect(banner).toBeVisible({ timeout: 30_000 });
      // Opening the app rings once for a running meeting the person is not in (FR37), for the deployment's ring length, and
      // the ring stops on its own; the banner stays.
      const ring = pageB.getByTestId('meeting-ring');
      await expect(ring).toBeVisible({ timeout: 30_000 });
      await expect(ring).toBeHidden({ timeout: 70_000 });
      await expect(banner).toBeVisible();
      const [windowB] = await Promise.all([ctxB.waitForEvent('page'), banner.getByRole('button', { name: 'Join meeting' }).click()]);
      await expect(windowB.getByTestId('meeting-window')).toBeVisible({ timeout: 30_000 });
      await windowB.getByRole('button', { name: 'Join meeting' }).click();
      await expect(windowB.getByRole('button', { name: 'Leave' })).toBeVisible({ timeout: 30_000 });
      // In the meeting in its own window, B's app no longer offers Join.
      await expect(banner).toBeHidden({ timeout: 15_000 });
      // Left while it still runs, Join is offered again: the banner the end must take away is on screen.
      await windowB.close();
      await expect(banner).toBeVisible({ timeout: 30_000 });
    } finally {
      await meetingRoute(token, personUrl('/meetings/end'), channelArn).catch(() => undefined);
    }
    // Ended, the room carries this meeting's ended card too, and the conversation offers nothing to join.
    await expect(pageB.getByText('Meeting ended', { exact: true })).toHaveCount(2, { timeout: 90_000 });
    await expect(pageB.getByTestId('meeting-in-progress')).toBeHidden({ timeout: 30_000 });
    // A RECORDED MEETING'S CARD SAYS SO: where audio and video are captured, the ended card carries the recording, either
    // its link or that it is still being joined into one file, never nothing.
    if (deployedMeetingSetting('MEETING_TRANSCRIPTION') && deployedMeetingSetting('MEETING_RECORDING') && deployedMeetingSetting('MEETING_MEDIA_RECORDING')) {
      // A host reads its link ("Recording"); anyone else reads that it is the hosts' to open ("Recording (available to ...").
      await expect(pageB.getByText(/The recording is processing|^Recording( \(|$)/).last()).toBeVisible({ timeout: 90_000 });
    }
  });
});
