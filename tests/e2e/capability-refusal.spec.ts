/**
 * A REQUEST FOR SOMETHING THE ASSISTANT DOES NOT OFFER IS REFUSED, AND SAYS WHERE TO GET IT
 * (SPEC-CAPABILITY-REFUSAL, DESIGN-CAPABILITY-REFUSAL).
 *
 * One basic conversation, two people: a premium-cleared person who opens it and a basic-only person
 * added to it. Each case is read from EACH member's own view of the channel (`list-channel-messages`
 * with that member as bearer), which is the room's view by construction - no DOM, no heuristic.
 *
 *  1. A PUBLIC request for a report, from the premium-cleared person. The refusal is public (FR16);
 *     the access lines, which list the classifications that person reaches that produce documents,
 *     reach them ALONE (FR17) - the other member reads the refusal and not the list. The refusal
 *     declares the REFUSED delivery (FR11), and no task is opened (FR2).
 *  2. A TARGETED request for an image, from the basic-only person. Refusal and access line are both
 *     private; the access line sends them to an administrator and names no classification (FR4).
 *
 * Gated by CAPABILITY_REFUSAL_E2E=1 (`validate.mjs --only=capability-refusal`). Needs E2E_INSTANCE_NAME
 * for the task tables, and AWS credentials that may read the channel as each member.
 */
import { test, expect } from './helpers/fixtures';
import { getBasicUser, getPremiumUser, missingUserReason } from './helpers/test-credentials';
import { openGroupConversation, closeGroup, type GroupConversation } from './helpers/group-conversation';
import { assistantArnIn, messageRowsVisibleTo, type VisibleMessage } from './helpers/third-party-view';
import { aws, readUserTasks, resolveTaskTable } from './helpers/task-backend';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

guardConsoleErrors();

const RUN = process.env.CAPABILITY_REFUSAL_E2E === '1';

const REPORT_REQUEST = 'Compile a one-page report on the StratumFlow product.';
const IMAGE_REQUEST = 'Generate an image of a mountain lake at sunrise.';
const REFUSED_REPORT = "don't produce report documents";
const REFUSED_IMAGE = "don't produce images";
const HAS_ACCESS = 'You have access to conversations that do:';
const NEEDS_ACCESS = 'ask your administrator for access';

/** Send AS a member through the real channel flow; `target` makes the message private. */
function sendAs(channelArn: string, senderArn: string, content: string, target?: string): void {
  aws(
    `chime-sdk-messaging send-channel-message --channel-arn "${channelArn}" --content "${content.replace(/"/g, '\\"')}" `
      + `--type STANDARD --persistence PERSISTENT --chime-bearer "${senderArn}"`
      + (target ? ` --target MemberArn=${target}` : ''),
  );
}

/** Bot messages this member can see that arrived after `since` (ms). */
function botMessagesSeenBy(channelArn: string, memberArn: string, since: number): VisibleMessage[] {
  return messageRowsVisibleTo(channelArn, memberArn)
    .filter((m) => m.senderArn.includes('/bot/') && new Date(m.createdAt).getTime() >= since);
}

async function waitFor<T>(read: () => T, done: (v: T) => boolean, page: { waitForTimeout(ms: number): Promise<void> }, ms = 120_000): Promise<T> {
  let v = read();
  for (const end = Date.now() + ms; !done(v) && Date.now() < end;) {
    await page.waitForTimeout(3_000);
    v = read();
  }
  return v;
}

test.describe.serial('a request for something the assistant does not offer is refused', () => {
  test.skip(!RUN, 'set CAPABILITY_REFUSAL_E2E=1 (runs via validate.mjs --only=capability-refusal)');
  guardBackendErrors('capability-refusal');

  let group: GroupConversation | null = null;
  let botArn = '';
  test.afterAll(async () => { await closeGroup(group); });

  test('a public report request: the room reads the refusal, only the asker reads where to go', async ({ page }) => {
    test.setTimeout(300_000);
    const premium = await getPremiumUser();
    const basic = await getBasicUser();
    test.skip(!premium.password, missingUserReason('premiumUser'));
    test.skip(!basic.password, missingUserReason('basicUser'));

    // Opened at BASIC, whose assistant offers no report.
    group = await openGroupConversation({ page, creator: premium, others: [basic], classification: 'Basic', title: `Refusal ${Date.now()}` });
    expect(group, 'the two-person basic conversation could not be assembled').toBeTruthy();
    const { channelArn, creator, others } = group!;
    const other = others[0];
    botArn = assistantArnIn(channelArn, creator.arn);
    expect(botArn, 'the conversation has no assistant member to address').toBeTruthy();

    const userTable = resolveTaskTable('user-tasks');
    expect(userTable, 'the user-tasks table must resolve - set E2E_INSTANCE_NAME').toBeTruthy();

    // The welcome lands first; let it, so it is not read as the answer.
    await waitFor(() => botMessagesSeenBy(channelArn, creator.arn, 0), (m) => m.length > 0, page, 60_000);
    const since = Date.now() - 2_000;

    // PUBLIC, addressed by mention, the composer's own grammar (`@<Name|id>`).
    sendAs(channelArn, creator.arn, `@<Concierge|${botArn.split('/').pop()}> ${REPORT_REQUEST}`);

    const askerSees = await waitFor(
      () => botMessagesSeenBy(channelArn, creator.arn, since),
      (m) => m.some((x) => x.content.includes(REFUSED_REPORT)) && m.some((x) => x.content.includes(HAS_ACCESS)),
      page,
    );
    const refusal = askerSees.find((m) => m.content.includes(REFUSED_REPORT));
    expect(refusal, `no refusal reached the asker; bot messages seen: ${JSON.stringify(askerSees.map((m) => m.content.slice(0, 120)))}`).toBeTruthy();
    expect(refusal!.content, 'the refusal declares the REFUSED delivery, which is what makes it countable (FR11)').toMatch(/REFUSED/);

    const access = askerSees.find((m) => m.content.includes(HAS_ACCESS));
    expect(access, 'the asker was not told where reports are produced (FR3)').toBeTruthy();
    expect(access!.content).toContain('- Standard');
    expect(access!.content).toContain('- Premium');

    // THE ROOM: the refusal, and nothing about the asker's clearance (FR16, FR17).
    const roomSees = botMessagesSeenBy(channelArn, other.arn, since);
    expect(roomSees.some((m) => m.content.includes(REFUSED_REPORT)), 'a public request was refused privately (FR16)').toBe(true);
    expect(roomSees.some((m) => m.content.includes(HAS_ACCESS)), 'the other member read the asker\'s access lines (FR17)').toBe(false);

    // NOTHING WAS ANSWERED OR OPENED (FR1, FR2).
    expect(askerSees.length, `more than the refusal and its access lines came back: ${JSON.stringify(askerSees.map((m) => m.content.slice(0, 80)))}`).toBeLessThanOrEqual(2);
    const opened = readUserTasks(userTable!, creator.personId)
      .filter((t) => String(t.taskType) === 'report_generation' && new Date(String(t.createdAt ?? 0)).getTime() >= since);
    expect(opened, 'a refused report request opened a task (FR2)').toEqual([]);
  });

  test('a targeted image request from a basic-only person: private, and points at an administrator', async ({ page }) => {
    test.setTimeout(240_000);
    expect(group, 'the first case must have assembled the conversation').toBeTruthy();
    const { channelArn, creator, others } = group!;
    const asker = others[0];
    const since = Date.now() - 2_000;

    sendAs(channelArn, asker.arn, IMAGE_REQUEST, botArn);

    const askerSees = await waitFor(
      () => botMessagesSeenBy(channelArn, asker.arn, since),
      (m) => m.some((x) => x.content.includes(REFUSED_IMAGE)),
      page,
    );
    const refusal = askerSees.find((m) => m.content.includes(REFUSED_IMAGE));
    expect(refusal, `no refusal reached the asker; bot messages seen: ${JSON.stringify(askerSees.map((m) => m.content.slice(0, 120)))}`).toBeTruthy();
    expect(refusal!.content, 'a basic-only person is sent to an administrator (FR4)').toContain(NEEDS_ACCESS);
    for (const label of ['Basic', 'Standard', 'Premium']) {
      expect(refusal!.content, `the no-access line named a classification (FR4): ${label}`).not.toContain(label);
    }

    // A TARGETED request is answered privately (FR16).
    const roomSees = botMessagesSeenBy(channelArn, creator.arn, since);
    expect(roomSees.some((m) => m.content.includes(REFUSED_IMAGE)), 'a targeted request was refused publicly (FR16)').toBe(false);
  });

  // SUMMARIZING THE CONVERSATION IS THE PLATFORM'S, NOT A REPORT (FR19, owner 2026-10-05). The word
  // "summary" sits in report_generation's description, so before conversation_summary was a universal
  // intent this request could be refused on basic as a report.
  test('a request to summarize the conversation is answered on basic, not refused as a report', async ({ page }) => {
    test.setTimeout(240_000);
    expect(group, 'the first case must have assembled the conversation').toBeTruthy();
    const { channelArn, creator } = group!;
    const since = Date.now() - 2_000;

    sendAs(channelArn, creator.arn, `@<Concierge|${botArn.split('/').pop()}> Summarize what we have discussed in this conversation so far.`);

    const seen = await waitFor(
      () => botMessagesSeenBy(channelArn, creator.arn, since),
      (m) => m.some((x) => !/REFUSED/.test(x.content) && x.content.replace(/<!--[\s\S]*?-->/g, '').trim().length > 40),
      page,
    );
    expect(
      seen.some((m) => /REFUSED/.test(m.content) || m.content.includes(REFUSED_REPORT) || m.content.includes("isn't something I do")),
      `a summary request was refused: ${JSON.stringify(seen.map((m) => m.content.slice(0, 120)))}`,
    ).toBe(false);
    expect(
      seen.some((m) => m.content.replace(/<!--[\s\S]*?-->/g, '').trim().length > 40),
      `no answer to the summary request arrived: ${JSON.stringify(seen.map((m) => m.content.slice(0, 120)))}`,
    ).toBe(true);
  });
});
