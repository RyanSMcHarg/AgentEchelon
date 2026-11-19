/**
 * AN INTENT'S TASK STEP EDITED IN THE CONSOLE IS THE ONE A NEW REQUEST RUNS (ADR-067 stage 1, SPEC-WORKFLOWS-AND-TASKS WT97).
 *
 * What only a deployment shows: on the assistant page, View steps on `report_generation` offers to edit the steps in a
 * draft; the builder's task-machine mode edits the first step's instruction and saves it to the draft as the version's
 * own machine; the draft validates and activates; and a report a person then asks for opens a task that started on the
 * edited machine, which the task row records as the hash of the machine it started on (`originMachineHash`).
 *
 * IT LEAVES THE ASSISTANT AS IT FOUND IT: any draft it started is discarded, and the version active before it is
 * activated again.
 */
import { test, expect } from './helpers/fixtures';
import { signInAsAdmin } from './helpers/agent-helpers';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { aws } from './helpers/aws';
import { channelArnFor } from './helpers/battle-state-backend';
import { signedCall } from './helpers/admin-api';
import { adminUrl } from './helpers/api-urls';
import { PROFILE, activeVersionOf, messagesSeenBy, openConversation, rollBack, sleep } from './helpers/workflow-task';
import { activeBody, adminSessionOrSkip, discardDraft } from './helpers/model-routes';
import { SERVED_VERSION_TTL_MS } from './helpers/version-under-test';
import { channelTasks, reportPromptForClassification, resolveTaskTable } from './helpers/task-backend';
import { contentHash12 } from '../../backend/lambda/src/lib/canonical-json';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

const MARK = `CONSOLEMACHINE-${Date.now().toString(36)}`;
const INTENT = 'report_generation';

test.describe.serial('an intent\'s task step edited in the console is the one a new request runs', () => {
  guardBackendErrors('an-intents-task-step-edited-in-the-console-runs');
  guardConsoleErrors();
  let admin: any;
  let previous: number | undefined;
  let edited = false;

  test.beforeAll(async () => {
    const s = await adminSessionOrSkip();
    test.skip(!!s.skip, s.skip);
    admin = s.admin;
    await discardDraft(admin).catch(() => undefined);
    previous = await activeVersionOf(admin);
    expect(previous, `${PROFILE} has an active version to return to`).toBeDefined();
  });

  test.afterAll(async () => {
    if (!admin) return;
    await discardDraft(admin).catch(() => undefined);
    await rollBack(admin, previous);
  });

  test('the builder edits the first step of report_generation in a draft, which validates and activates', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    await signInAsAdmin(page);
    await page.goto('/?admin=profiles');
    await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 30_000 });
    const row = page.locator(`tr[data-assistant="${PROFILE}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('button.btn-link').first().click();
    await page.getByTestId('assistant-nav-workflows').click();
    await page.getByTestId('field-machines').getByTestId(`assistant-machine-${INTENT}`).click();
    await expect(page.getByTestId('assistant-machine-view')).toBeVisible({ timeout: 20_000 });

    // Outside a draft the page offers to edit the steps in one, which it starts.
    await page.getByTestId('assistant-machine-edit').click();
    const copy = page.getByTestId('assistant-machine-copy');
    const editor = page.getByTestId('assistant-machine-editor');
    await expect(copy.or(editor)).toBeVisible({ timeout: 60_000 });
    if (await copy.isVisible()) await copy.click();
    await expect(editor).toBeVisible({ timeout: 60_000 });

    // The first step drawn is the machine's start; its instruction is edited and saved.
    const first = editor.locator('[data-testid^="mb-node-"]').first();
    await first.click();
    const prompt = editor.getByTestId('mb-prompt');
    const was = await prompt.inputValue();
    await prompt.fill(`${was}${was ? ' ' : ''}Mention the reference ${MARK} once in your reply.`.trim());
    await page.getByTestId('assistant-machine-save').click();

    // The draft holds the edit as the version's own machine. Read until the save lands: the button is disabled while it
    // is in flight as well as after, so its state alone does not say the draft was written.
    const draftMachine = async () => {
      const exported = await signedCall(adminUrl('assistant-admin', '/admin/profiles/export'), admin, 'POST', { profileName: PROFILE, draft: true });
      return exported.body?.manifest?.body?.intentPack?.machines?.[INTENT];
    };
    await expect.poll(async () => JSON.stringify((await draftMachine())?.states ?? {}), {
      message: 'the draft\'s report_generation carries the console edit', timeout: 60_000,
    }).toContain(MARK);
    const machine = await draftMachine();
    expect(JSON.stringify(machine.states[machine.initial]), 'the edit is on the machine\'s first step').toContain(MARK);

    const valid = await signedCall(adminUrl('assistant-admin', '/admin/profiles/validate'), admin, 'POST', { profileName: PROFILE });
    expect(valid.body?.errors ?? [], JSON.stringify(valid.body).slice(0, 600)).toEqual([]);
    const listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), admin);
    const configId = (listing.body?.profiles ?? []).find((p: any) => p.profileName === PROFILE)?.draftConfigId;
    const activated = await signedCall(adminUrl('assistant-admin', '/admin/profiles/activate'), admin, 'POST', { profileName: PROFILE, configId });
    expect(activated.status, JSON.stringify(activated.body).slice(0, 400)).toBe(200);
    edited = true;
  });

  test('a report a person asks for next opens a task on the edited machine', async () => {
    test.setTimeout(10 * 60_000);
    expect(edited, 'the console edit was activated').toBe(true);
    await sleep(SERVED_VERSION_TTL_MS);
    const machine = (await activeBody(admin)).intentPack?.machines?.[INTENT];
    expect(JSON.stringify(machine?.states?.[machine.initial] ?? {}), 'the active version runs the edited first step').toContain(MARK);
    const expected = contentHash12(machine);

    const conv = await openConversation(`Console machine ${MARK}`);
    await sleep(15_000);
    const ask = reportPromptForClassification('premium');
    aws(`chime-sdk-messaging send-channel-message --channel-arn ${channelArnFor(conv.channelId)} --chime-bearer ${conv.personArn} --type STANDARD --persistence PERSISTENT --content "${encodeURIComponent(ask)}"`);

    const table = resolveTaskTable('agent-tasks');
    expect(table, 'the agent tasks table is resolvable').toBeTruthy();
    let task: any;
    for (const deadline = Date.now() + 6 * 60_000; Date.now() < deadline && !task; await sleep(5_000)) {
      task = channelTasks(table!, conv.channelArn).find((t) => t.taskType === INTENT);
    }
    expect(task, `a ${INTENT} task opened for "${ask.slice(0, 40)}"`).toBeDefined();
    expect(task.originMachineHash, 'the task started on the machine the console edited').toBe(expected);

    // And the turn that opened it answers (the room is not left waiting on a step it cannot run).
    let answered = false;
    for (const deadline = Date.now() + 6 * 60_000; Date.now() < deadline && !answered; await sleep(5_000)) {
      answered = messagesSeenBy(conv.channelId, conv.personArn).some((m) => m.sender !== conv.personArn && m.metadata?.respPhase === 'final');
    }
    expect(answered, 'the request was answered').toBe(true);
  });
});
