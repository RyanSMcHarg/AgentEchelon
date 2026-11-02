/**
 * A QUEUE COVERING TWO PEOPLE IS PUT TO BOTH OF THEM (maintainer, 2026-09-05).
 *
 * WHY THIS SPEC EXISTS, AND WHY IT COULD NOT LIVE IN `turn-queue.spec.ts`. That suite is 1:1 by
 * design and that is right for what it asserts - but the rule under test here is inert below three
 * members, so asserting it there would have proved nothing:
 *
 *   - a room of two is no room, so nothing about what OTHER people can see is observable;
 *   - `resolveTaskAnswer` returns null at two members or fewer, so the addressed path does not exist;
 *   - and an offer cannot hold two people's subjects when only one person can speak into it.
 *
 * THE DEFECT IT COVERS. A queue holds whatever arrived while the assistant was working, from whoever
 * sent it, and the subjects read out of it belong to all of them. The offer that followed was
 * addressed to a SINGLE principal - whoever happened to trigger the drain - and that dropped work
 * two ways, neither of which produced an error:
 *
 *   1. the whole offer, when that one id could not be derived, because `savePendingSplit` refused an
 *      offer with no `offeredTo` - every subject belonging to everybody discarded for one empty
 *      field, after the assistant had already told them about it;
 *   2. everybody else's answer, because the recorded name is the lock BYPASS. Only the named person
 *      could reply without queueing behind the conversation, while the paragraph they had all just
 *      read said the decision was theirs.
 *
 * TWO PRIVATE SUBJECTS, ONE PER PERSON, is the shape that tells this apart. A shared subject is
 * answerable by anybody and settled by the first answer, by design - so a test built on shared
 * subjects would pass whether or not the offer remembered more than one person. Only a subject
 * PRIVATE to its requester survives somebody else answering, and only a targeted message makes one.
 *
 * Asserted on the RECORD, not on the assistant's wording: the offer is spoken in this deployment's
 * persona and this conversation's language (tenet D11), so there is no English to match on that would
 * still hold for a deployment configured with a different voice.
 */
import { test, expect } from './helpers/fixtures';
import { getTestCredentials, hasTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { openGroupConversation, closeGroup, type GroupConversation } from './helpers/group-conversation';
import { assistantArnIn } from './helpers/third-party-view';
import {
  holderOf, pendingSplitRow, resolveTurnStateTable, sendTargetedAs,
} from './helpers/turn-state-record';

guardConsoleErrors();

const RUN = process.env.GROUP_SPLIT_E2E === '1';

/** The long prompt exists to make the assistant BUSY, which is the precondition for a queue at all. */
const LONG_PROMPT =
  'Explain in depth how employee onboarding typically works at a mid-sized company, from the signed '
  + 'offer through the end of the first quarter. Cover each stage in its own section with a short '
  + 'heading, and for every stage describe who owns it, how long it takes, and the two or three ways '
  + 'it most often goes wrong. Please write at least fifteen paragraphs.';

test.describe.serial('a split offer covering two people', () => {
  guardBackendErrors('group-split-offer');
  test.skip(!RUN, 'set GROUP_SPLIT_E2E=1 (runs via validate.mjs --only=group-split)');

  let creds: TestCredentials;
  let group: GroupConversation | null = null;
  let responderId = '';
  /** The assistant's ARN, learned in the first test and addressed by the second. */
  let botArn = '';

  test.beforeAll(async () => {
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    creds = await getTestCredentials();
    expect(
      resolveTurnStateTable(),
      'the turn-state table must be resolvable (TURN_STATE_TABLE, or E2E_INSTANCE_NAME plus AWS '
      + 'credentials) - without it the offer cannot be read back, and a deployment that recorded one '
      + 'is indistinguishable from one that did not',
    ).toBeTruthy();
  });

  test.afterAll(async () => { await closeGroup(group); });

  test('records both people, and each keeps their own subject', async ({ page }) => {
    test.setTimeout(300_000);

    // THREE PEOPLE. The second premium account is optional in an older deployment's secret, and a
    // standard user stands in - what matters is that they are three DISTINCT principals, because two
    // of the three roles here would collapse otherwise.
    const second = creds.secondPremiumUser?.password ? creds.secondPremiumUser : creds.standardUser;
    expect(second.email, 'a second distinct person is required').not.toBe(creds.premiumUser.email);

    group = await openGroupConversation({
      page,
      creator: creds.premiumUser,
      others: [second, creds.basicUser],
      title: `Group split ${Date.now()}`,
    });
    expect(group, 'the group conversation could not be assembled').toBeTruthy();
    const { channelArn, others } = group!;

    // THE ASSISTANT'S ARN FROM THE MEMBERSHIP, not from a reply it sent. In a group a plain message
    // is not routed to the assistant at all, so waiting for one to learn the address you have to
    // address is circular - it fails as a timeout that reads like a broken assistant.
    botArn = assistantArnIn(channelArn, group!.creator.arn);
    expect(botArn, 'the conversation has no assistant member to address').toBeTruthy();
    responderId = botArn.split('/').pop() || '';

    // EVERY SEND IS TARGETED, AND ON THE WIRE RATHER THAN THROUGH THE COMPOSER. `@<assistant>` in a
    // group produces exactly this - a message targeted at the bot - so this is the same path a person
    // takes, without a dropdown interaction in the middle of a timing test.
    //
    // MAKE IT BUSY FIRST. Not waited on: the point is that what follows arrives while it works.
    sendTargetedAs(channelArn, group!.creator.arn, botArn, LONG_PROMPT);

    // WAIT FOR THE LOCK, not for a clock. A queue forms only while a turn is running, and a fixed
    // sleep gets this wrong in both directions - too early and nothing is held, too late and the turn
    // is done. Both look identical afterwards: no queue, no offer.
    let held = '';
    for (let i = 0; i < 30 && !held; i += 1) {
      held = holderOf(channelArn, responderId);
      if (!held) await page.waitForTimeout(2_000);
    }
    expect(held, 'the long prompt never took the conversation, so nothing could queue behind it').toBeTruthy();

    // TWO PEOPLE, TWO PRIVATE SUBJECTS. Targeted, so each becomes a topic the OTHER cannot see -
    // which is what makes one survive the other being answered.
    sendTargetedAs(channelArn, others[0].arn, botArn, 'Also, what was our Q3 headcount?');
    sendTargetedAs(channelArn, others[1].arn, botArn, 'And is the pricing page copy still accurate?');
    console.log(`[group-split] asked by ${others[0].personId} and ${others[1].personId} in ${channelArn}`);

    // The offer lands with the proposal, so wait for the record rather than for wording.
    let offer = pendingSplitRow(channelArn, responderId);
    for (let i = 0; i < 40 && !offer?.topics.length; i += 1) {
      await page.waitForTimeout(5_000);
      offer = pendingSplitRow(channelArn, responderId);
    }
    console.log(`[group-split] offer: ${JSON.stringify(offer)}`);

    expect(offer?.topics.length, 'no offer was recorded for a queue covering two subjects').toBeTruthy();

    // ── THE ASSERTION THAT WAS FALSE ────────────────────────────────────────────────────────────
    //
    // Before the fix this held exactly ONE id, the drain's trigger, whatever the queue covered.
    expect(
      offer!.offeredTo,
      'the offer names only some of the people it concerns. A queue is the conversation\'s, not one '
      + 'member\'s: the recorded set is the lock bypass, so anybody left out of it has their answer '
      + 'queued behind the conversation instead of ending the question they were asked.',
    ).toEqual(expect.arrayContaining([others[0].personId, others[1].personId]));

    // And each private subject is attributed to the person whose it is - without that, "two people
    // were asked" would be true and "each was asked about their own" would not.
    const privateTopics = offer!.topics.filter((t) => t.private);
    console.log(`[group-split] private topics: ${JSON.stringify(privateTopics)}`);
    expect(
      privateTopics.map((t) => t.requestorId).sort(),
      'each targeted request must be its own private subject, attributed to its requester',
    ).toEqual([others[0].personId, others[1].personId].sort());
  });

  test('one person answering leaves the other still asked', async ({ page }) => {
    test.setTimeout(300_000);
    test.skip(!group || !responderId, 'the offer was not recorded');
    const { channelArn, others } = group!;

    const before = pendingSplitRow(channelArn, responderId);
    test.skip(!before?.topics.some((t) => t.private), 'no private subject to settle');

    // The FIRST person answers, naming their own subject. Targeted at the assistant, exactly as
    // their request was: a private subject is answered on the channel it was offered on, or the
    // room reads a subject it was never shown.
    sendTargetedAs(
      channelArn,
      others[0].arn,
      botArn,
      'Yes, please move the Q3 headcount question into its own conversation.',
    );

    // Wait for THEIR subject to leave the record.
    let after = pendingSplitRow(channelArn, responderId);
    for (let i = 0; i < 40; i += 1) {
      after = pendingSplitRow(channelArn, responderId);
      if (!after?.topics.some((t) => t.requestorId === others[0].personId)) break;
      await page.waitForTimeout(5_000);
    }
    console.log(`[group-split] after one answer: ${JSON.stringify(after)}`);

    // ── THE SAME DEFECT, FROM THE OTHER SIDE ────────────────────────────────────────────────────────────
    //
    // `clearPendingSplit` removed the WHOLE field, so the first answer erased everybody else's
    // outstanding offer and the second person's reply then did nothing at all, silently.
    expect(
      after?.topics.some((t) => t.requestorId === others[1].personId),
      'one person answering removed somebody else\'s subject. An offer deliberately carries several '
      + 'people\'s subjects at once, and a subject private to somebody else is not the answering '
      + 'person\'s to dispose of - when it goes, their reply reaches nothing and nothing says so.',
    ).toBe(true);

    // And they are still able to answer it: the bypass is spent per person, not for the room.
    expect(
      after?.offeredTo,
      'the second person is no longer recorded as asked, so their answer will queue behind the '
      + 'conversation rather than end the question',
    ).toEqual(expect.arrayContaining([others[1].personId]));
  });
});
