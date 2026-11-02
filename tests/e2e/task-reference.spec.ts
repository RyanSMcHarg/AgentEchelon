/**
 * A REPLY NAMES THE WORK IT ANSWERS (ADR-035).
 *
 * THE BEHAVIOR THIS PROTECTS, as the person experiences it: they have two things open with an
 * assistant in a shared conversation, and they reply to one of them by starting with its reference,
 * `#2`. That reply reaches the assistant without anyone being addressed, and it moves item 2 and
 * nothing else. The same words from a colleague move nothing, and a reference to nothing of theirs is
 * answered privately with the references they can use.
 *
 * WHY THE ITEMS ARE SEEDED. Two open items for one person, both waiting on them, is the precondition,
 * and reaching it through the product means two task-shaped requests whose second the ranking may
 * read as an answer to the first - the exact ambiguity under test. The rows are written the way
 * `createTask` and `putMirrorRow` write them, references and counter included, so everything this
 * asserts about routing runs through shipped code.
 *
 * WHY A GROUP. In a 1:1 Amazon Chime SDK routes every message to the assistant, so a bare `#2`
 * reaching the assistant would prove nothing about the channel flow's reference routing.
 *
 * Gated by TASK_REFERENCE_E2E=1 (a validate.mjs phase). Runs against the live deployment.
 */
import { test, expect } from './helpers/fixtures';
import { Page } from '@playwright/test';
import { getAdminUser, getSecondPremiumUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { assistantResponseCount } from './helpers/drift-backend';
import { assistantNameIn } from './helpers/third-party-view';
import { openGroupConversation, closeGroup, type GroupConversation } from './helpers/group-conversation';
import {
  aws, jsonArg, readTask, resolveTaskTable, pollFor, deleteSeededTask, REPORT_GENERATION,
} from './helpers/task-backend';
import { randomUUID } from 'crypto';

guardBackendErrors('task-reference');
guardConsoleErrors();

const RUN = process.env.TASK_REFERENCE_E2E === '1';
const suite = RUN ? test.describe.serial : test.describe.skip;

interface Seeded { taskId: string; taskRef: number; updatedAt: string }

/** Write one open report item waiting on `personId`, with its reference, as `createTask` would. */
function seedItem(agentTable: string, userTable: string, channelArn: string, personId: string, taskRef: number, excerpt: string): Seeded {
  const taskId = randomUUID();
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  const userArn = `${channelArn.replace(/\/channel\/.*$/, '')}/user/${personId}`;
  const state = REPORT_GENERATION.initial;
  aws(`dynamodb put-item --table-name "${agentTable}" --item ${jsonArg({
    taskId: { S: taskId }, channelArn: { S: channelArn }, userArn: { S: userArn },
    taskRef: { N: String(taskRef) }, requestExcerpt: { S: excerpt },
    status: { S: 'in_progress' }, deliveryOption: { S: 'TASK_MULTI_STEP' },
    taskType: { S: 'report_generation' }, taskState: { S: state }, details: { M: {} },
    visibility: { S: 'conversation' }, ownerPersonId: { S: personId },
    assigneeId: { S: personId }, assigneeType: { S: 'user' },
    createdAt: { S: now }, updatedAt: { S: now }, ttl: { N: String(ttl) },
  })}`);
  aws(`dynamodb put-item --table-name "${userTable}" --item ${jsonArg({
    principalId: { S: personId }, assigneeType: { S: 'user' }, taskId: { S: taskId }, taskRef: { N: String(taskRef) },
    taskType: { S: 'report_generation' }, channelArn: { S: channelArn }, status: { S: 'in_progress' },
    taskState: { S: state }, requestExcerpt: { S: excerpt }, visibility: { S: 'conversation' },
    ownerPersonId: { S: personId }, details: { M: {} },
    createdAt: { S: now }, updatedAt: { S: now }, ttl: { N: String(ttl) },
  })}`);
  return { taskId, taskRef, updatedAt: now };
}

/** The not-found reply for #99, as the member `bearerArn` can read the channel, or undefined. */
function notFoundReplyVisibleTo(channelArn: string, bearerArn: string): string | undefined {
  const r = aws(`chime-sdk-messaging list-channel-messages --channel-arn "${channelArn}" `
    + `--chime-bearer "${bearerArn}" --sort-order DESCENDING --max-results 20`);
  return ((r?.ChannelMessages || []) as Array<{ Content?: string }>)
    .map((m) => { try { return decodeURIComponent(m.Content || ''); } catch { return m.Content || ''; } })
    .find((c) => c.includes('#99') && /#1\b/.test(c));
}

/** Send a message as typed, without waiting for any reply. */
async function sendRaw(page: Page, text: string): Promise<void> {
  await page.locator('.message-textarea').fill(text);
  await page.keyboard.press('Enter');
}

suite('a reply that starts with a reference answers that item', () => {
  let group: GroupConversation | null = null;
  let agentTable: string | null;
  let userTable: string | null;
  let item1: Seeded;
  let item2: Seeded;
  const title = `Task reference e2e ${Date.now()}`;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const userA = await getAdminUser();
    const userB = await getSecondPremiumUser();
    if (!userA?.password) test.skip(true, missingUserReason('testAdmin'));
    if (!userB?.password) test.skip(true, missingUserReason('secondPremiumUser'));
    agentTable = resolveTaskTable('agent-tasks');
    userTable = resolveTaskTable('user-tasks');
    if (!agentTable || !userTable) test.skip(true, 'task tables not resolvable; set E2E_INSTANCE_NAME');

    const page = await browser.newPage();
    group = await openGroupConversation({ page, creator: userA, others: [userB!], title, withPages: true, browser });
    if (!group) test.skip(true, 'the group conversation could not be assembled');

    const { channelArn, creator } = group!;
    item1 = seedItem(agentTable!, userTable!, channelArn, creator.personId, 1, 'Q2 performance report');
    item2 = seedItem(agentTable!, userTable!, channelArn, creator.personId, 2, 'Hiring pipeline report');
    // THE COUNTER, so an item this run opens gets #3 rather than colliding with a seeded reference.
    aws(`dynamodb put-item --table-name "${agentTable}" --item ${jsonArg({
      taskId: { S: 'counter#taskRef' }, channelArn: { S: channelArn }, refCounter: { N: '2' },
    })}`);

    // Opened BY ID, which also re-reads the open-items list so the seeded items appear. A plain reload
    // lands on the conversation list, not in the conversation.
    await creator.page!.goto(`/?conversation=${channelArn.split('/').pop()}`);
    await expect(creator.page!.locator('.message-textarea')).toBeEnabled({ timeout: 30000 });
    // By id for the same reason: the member's list was loaded before they were added.
    const otherPage = group!.others[0].page!;
    await otherPage.goto(`/?conversation=${channelArn.split('/').pop()}`);
    await expect(otherPage.locator('.message-textarea'), 'the second member opens the room').toBeEnabled({ timeout: 30000 });
  });

  test.afterAll(async () => {
    // The seeded rows are removed so a later run's open-items list is not read against them.
    if (group && agentTable && userTable) {
      for (const item of [item1, item2].filter(Boolean)) {
        deleteSeededTask(agentTable, userTable, { taskId: item.taskId, channelArn: group.channelArn, personId: group.creator.personId });
      }
    }
    await closeGroup(group);
  });

  test('the Answer action names the item beside the composer, not in the message', async () => {
    const page = group!.creator.page!;
    await page.locator('.open-work-items-summary').click();
    // THIS conversation's row: the list spans every conversation, and an earlier run can leave a row elsewhere.
    const row = page.locator('.open-work-items-item', { hasText: 'Hiring pipeline' })
      .filter({ hasText: /in this conversation/i }).first();
    await expect(row, 'the item is listed with its reference').toContainText('#2', { timeout: 60000 });
    await row.getByRole('button', { name: /Answer/i }).click();
    // The item travels in the message Metadata (`{ task: { id } }`), so the person's words stay their
    // own: the chip says what is being answered, and the composer is focused and left empty.
    const chip = page.locator('.message-input-sticky-target', { hasText: /Answering/i });
    await expect(chip, 'the composer says which item is being answered').toContainText('#2', { timeout: 15000 });
    await expect(chip).toContainText('Hiring pipeline report');
    await expect(page.locator('.message-textarea'), 'nothing is typed into the message').toHaveValue('');
    await expect(page.locator('.message-textarea')).toBeFocused();
    await chip.getByRole('button', { name: /Stop answering/i }).click();
    await expect(chip, 'dismissing the chip releases the item').toHaveCount(0);
  });

  test('a colleague typing the same reference starts no turn and moves nothing', async () => {
    test.setTimeout(180_000);
    const { channelArn } = group!;
    const before = await assistantResponseCount(channelArn);
    await sendRaw(group!.others[0].page!, '#1 I think it should cover EMEA');

    // Long enough for a dispatched turn to have posted its acknowledgment several times over.
    await group!.others[0].page!.waitForTimeout(45_000);
    expect(await assistantResponseCount(channelArn), 'no assistant answered a reference to someone else\'s item').toBe(before);
    expect(readTask(agentTable!, item1.taskId, channelArn)?.updatedAt, 'item 1 did not move').toBe(item1.updatedAt);
  });

  test('a bare #2 from the person reaches the assistant and moves item 2 only', async () => {
    test.setTimeout(360_000);
    const { channelArn } = group!;
    const page = group!.creator.page!;
    const before = await assistantResponseCount(channelArn);
    await sendRaw(page, '#2 The audience is engineering leadership, one page is enough.');

    const moved = await pollFor(
      () => readTask(agentTable!, item2.taskId, channelArn),
      (row) => Boolean(row && row.updatedAt !== item2.updatedAt),
      { timeoutMs: 240_000, intervalMs: 5_000 },
    );
    expect(moved?.updatedAt, 'item 2 moved: the reply was applied to the item it named').not.toBe(item2.updatedAt);
    await expect.poll(async () => assistantResponseCount(channelArn), { timeout: 240_000 })
      .toBeGreaterThan(before);
    expect(readTask(agentTable!, item1.taskId, channelArn)?.updatedAt, 'item 1 did not move').toBe(item1.updatedAt);
    await expect(
      page.locator('.user-message .message-answering-label', { hasText: '#2' }).last(),
      'the sent message says what it answers',
    ).toBeVisible({ timeout: 30000 });
  });

  test('a reference to nothing of theirs is answered privately, with the references they can use', async () => {
    test.setTimeout(240_000);
    const { channelArn, creator } = group!;
    // The assistant's name from the live roster: it comes from its profile version and changes at runtime.
    const assistantName = assistantNameIn(channelArn, creator.arn);
    expect(assistantName, 'the conversation has an assistant member to address').toBeTruthy();
    await sendRaw(creator.page!, `@${assistantName} #99 is this one done?`);

    const reply = await pollFor(
      () => notFoundReplyVisibleTo(channelArn, creator.arn),
      (found) => Boolean(found),
      { timeoutMs: 180_000, intervalMs: 5_000 },
    );
    expect(reply, 'the sender is told #99 names nothing and shown #1').toBeTruthy();

    // Only the sender sees it: the colleague's view of the channel does not carry it.
    expect(notFoundReplyVisibleTo(channelArn, group!.others[0].arn), 'the not-found reply is not visible to anyone else')
      .toBeUndefined();
  });
});
