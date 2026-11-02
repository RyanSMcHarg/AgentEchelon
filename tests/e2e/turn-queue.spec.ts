/**
 * ONE TURN AT A TIME, AND WHAT HAPPENS TO THE MESSAGES THAT ARRIVE MEANWHILE (ADR-033).
 *
 * ── WHY THIS IS AN E2E AND NOT A UNIT TEST ──────────────────────────────────────────────────────
 *
 * Every piece of this has unit coverage, and none of that coverage can prove the thing the design is
 * actually judged on: that a person who keeps typing while the assistant is working is TOLD so, gets
 * their messages picked up rather than lost, and can stop the work in something close to real time.
 * That property spans a conditional DynamoDB write in one Lambda, a message posted by a second, a
 * Kinesis post-processing rule in a third, a model turn in a fourth, and a React hook reading an
 * endpoint in a fifth. Every one of them is green in isolation while the whole is broken - which is
 * exactly how this feature shipped inert once already.
 *
 * ── WHAT EACH TEST PINS, AND WHY A WEAKER VERSION WOULD PASS ON A BROKEN BUILD ──────────────────
 *
 *   ONE ASSISTANT, ONE QUEUED MESSAGE      the record says busy, the message is styled as waiting,
 *                                          and the queue drains into a proposal
 *   THREE QUEUED MESSAGES                  ONE notice, updated - not three near-identical lines,
 *                                          which is the doubling the design exists to prevent
 *   /stop                                  the in-flight answer is SUPPRESSED, fast, and the queue
 *                                          is NOT collateral: what arrived while it worked is still
 *                                          picked up
 *   SEVERAL ASSISTANTS                     busy is keyed on the RESPONDER, so one assistant being
 *                                          busy is not the conversation being busy
 *
 * The client-side half of the several-assistants case - unioning the queues so a message waiting on
 * the second assistant is styled as waiting - is asserted in
 * `frontend/packages/chat/src/hooks/useTurnState.test.ts`. It needs two assistants ANSWERING to be
 * observable in the DOM, which this deployment provisions only for a duel, and a duel deliberately
 * does not take the turn lock. Pinning it there is honest; asserting it here against a room with one
 * assistant would pass on the first-responder-only implementation it exists to catch.
 *
 * ── GATING ──────────────────────────────────────────────────────────────────────────────────────
 *
 * TURN_QUEUE_E2E=1, and the deployment must have been synthesized with `-c turnQueue=true`. Without
 * the flag `claimTurn` always answers "claimed", so nothing ever queues and every assertion here
 * would be vacuously... failed, loudly, which is the right direction: a queue phase that silently
 * passed against a deployment with queueing switched off would be worse than not running.
 *
 *   E2E_BASE_URL=<cf> TURN_QUEUE_E2E=1 VITE_PERSON_API_URL=<url> \
 *     npx playwright test e2e/turn-queue.spec.ts
 */
import { test, expect } from './helpers/fixtures';
import { Page } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse, idTokenOf } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { ChannelWireRecorder, type WireMessage } from './helpers/channel-wire';
import { aws, jsonArg, readTask, resolveTaskTable, runTasksFor } from './helpers/task-backend';
import { addMember, messagesVisibleTo } from './helpers/third-party-view';
import { personArnForEmail, personArnFromIdToken, personIdFromIdToken } from './helpers/person';
// Shared with group-split-offer.spec.ts: one reader of the turn-state record, so a second spec
// cannot drift from the shape the runtime actually writes.
import {
  resolveTurnStateTable, pendingSplitRow, amendmentsRow, sendTargetedAs, queuedIntentsRow, queuedRow,
} from './helpers/turn-state-record';
import { PERSON_API_URL, personUrl } from './helpers/api-urls';

guardConsoleErrors();

const RUN = process.env.TURN_QUEUE_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;
const TURN_STATE_API = PERSON_API_URL ? personUrl('/turn-state') : '';

/**
 * A prompt that keeps the assistant genuinely busy.
 *
 * The whole suite depends on there being a window during which a second message has somewhere to
 * wait. A one-line answer closes that window before the test can use it, so this asks for real work -
 * and asks for it WITHOUT leaving the scope open, because a turn that comes straight back to ask what
 * you meant is not a turn anything can queue behind.
 *
 * It also has to get PAST THE INPUT GUARDRAIL. An earlier version closed the scope with "Do not ask
 * me any clarifying questions; use your best judgement on scope", and that clause, in combination
 * with the rest of the request, trips the PROMPT_ATTACK filter - deterministically, four times out of
 * four, though neither half trips it alone. The turn was then refused BEFORE the model was called, so
 * it finished in about six seconds and released the lock before the second message landed. Every
 * queue assertion downstream failed, and the whole file read as a broken queue rather than a blocked
 * prompt. Close the scope by saying what you WANT - a length, a heading per stage - never by telling
 * the assistant what not to do.
 */
const LONG_PROMPT =
  'Explain in depth how employee onboarding typically works at a mid-sized company, from the signed '
  + 'offer through the end of the first quarter. Cover each stage in its own section with a short '
  + 'heading: the offer and background check, provisioning and access, first-day orientation, '
  + 'role-specific training, the thirty, sixty and ninety day check-ins, and the handover into '
  + 'ordinary management. For every stage describe who usually owns it, how long it usually takes, '
  + 'and the two or three ways it most often goes wrong. Please write at least fifteen paragraphs.';

/** The queued sends. Deliberately a mix: one amends the work in flight, two ask for new things. */
const AMENDMENT = 'Actually, keep it to one page.';
/**
 * NOTHING IN THIS SENTENCE POINTS AT ANYTHING. "The other one" and "the way we did before" both
 * refer to something that was never said in this conversation, so a reading has nothing to resolve
 * them against and no honest way to name the work.
 *
 * It is deliberately not gibberish. A reading should be able to see that a REQUEST was made and
 * still be unable to say what it asks for, which is exactly the case `unclear` exists for.
 */
const AMBIGUOUS = 'Same as the other one, but do it the way we did before.';
/** What the person says when asked. It supplies exactly the referent the reading could not resolve. */
const ANSWERS_THE_CLARIFICATION = 'I meant the Q3 headcount summary, in the same section-by-section '
  + 'format as the onboarding write-up.';
const NEW_REQUEST_A = 'Also, what was our Q3 headcount?';
// PLAINLY A DIFFERENT SUBJECT, and it has to be, because the reading can now tell.
//
// This was "can you list the three tools that process touches?" - which reads as "which tools does
// that PROCESS touch", the process being the onboarding one the long prompt is about. So the reading
// folded it into the work in flight and the offer named a single subject, and the test called that a
// broken split. It was a correct reading of a fixture that only looked like a second subject.
//
// It only started happening once `inFlight` was true: before that the reading was told nothing was
// running, so a queued message could ONLY be new work and the ambiguity never arose. The fixture was
// written against that, and outlived it.
const NEW_REQUEST_B = 'And which competitors were flagged in the last board summary?';
// A SUBJECT NO READING CAN GROUP WITH A HEADCOUNT FIGURE, for the two split tests.
//
// A and B are distinct requests, but both are lookups of company records, and on one run the reading
// grouped them as "Stratum headcount and competitive intelligence lookups". That grouping is defensible,
// so the test's outcome turned on model granularity rather than on whether the offer works. This pair
// shares no axis at all - not the source, not the kind of answer, not the audience - so a single topic
// would be a wrong reading, which is what the assertion is for. With it as the third request, a queue of three
// always holds at least two subjects however A and B are read, so per-subject choice is never a distinction on
// paper. The other tests keep A and B.
const NEW_SUBJECT_UNGROUPABLE = 'Separately, can you draft a two-sentence welcome note for a new hire named Priya?';

interface TurnStateView {
  busy: boolean;
  queued: string[];
  noticeId?: string;
}

/** Send without waiting for an answer. The whole point is that no answer is coming yet. */
async function sendWithoutWaiting(page: Page, text: string): Promise<void> {
  await page.locator('.message-textarea').fill(text);
  await page.keyboard.press('Enter');
  console.log(`[queue-e2e] sent (not waiting): "${text}"`);
}

/**
 * Read the conversation's waiting state exactly as the client does.
 *
 * The caller's own id token, so the answer is filtered to what THIS person may see - which is part of
 * what is being asserted, not an implementation detail to route around.
 */
async function turnState(
  page: Page,
  channelArn: string,
  responderId: string,
): Promise<TurnStateView & { status: number }> {
  const idToken = await idTokenOf(page);
  const url = personUrl(`/turn-state?channelArn=${encodeURIComponent(channelArn)}&responderId=${encodeURIComponent(responderId)}`);
  return page.evaluate(
    async ([u, token]) => {
      const r = await fetch(u as string, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const json = r.ok ? await r.json() : {};
      return { status: r.status, busy: !!json.busy, queued: json.queued ?? [], noticeId: json.noticeId };
    },
    [url, idToken],
  );
}

/** Every frame of the deferral notice, in arrival order. It is ONE message, updated in place. */
/**
 * The turn-state table, resolved the way every other shared table here is.
 *
 * Read DIRECTLY rather than through the turn-state API, because the API deliberately exposes only
 * what a CLIENT may know - busy, depth, the notice id. The split offer is not part of that surface,
 * and asserting it through a projection that was never meant to carry it would test the projection.
 */
/**
 * The channel names this person is a member of, read from Amazon Chime SDK Messaging rather than the
 * sidebar.
 *
 * A conversation spawned by a split is created by a Lambda talking to Chime directly, so there is no
 * `/create-conversation` response for the page to observe and no request the test can wait on. The
 * membership list is where the room actually appears, and it is also the thing that decides whether
 * the person can reach it at all.
 */


/**
 * The same read, waited on until `expected` appears.
 *
 * Membership is written by the split Lambda and read back through a separate Amazon Chime SDK
 * Messaging call, so an immediate read is a read-after-write across a service boundary. Bounded, and
 * the list it returns is the one every assertion is then made against - so waiting can turn a slow
 * split into a pass, and never turns a wrong one into a pass.
 */
// A LISTING-AND-NAME-MATCHING HELPER USED TO LIVE HERE, and it is gone deliberately: it asked
// whether a room with a given NAME existed among every conversation this account had ever been in,
// which was wrong in two opposite directions against a working deployment. Read the split's own
// announcement instead - it carries the ARN.

/**
 * The offered label as the PRODUCT will have written it, so the two can be compared.
 *
 * Not a workaround and not a guess: Amazon Chime SDK channel names permit alphanumerics, hyphens and
 * underscores only, so `sanitizeTitle` (channel-creation.ts) strips everything else before the label
 * becomes a room name - and the announcement carries that sanitized title. Offered "Onboarding report
 * (in progress)" is announced as "Onboarding report in progress", and comparing the two raw is a test
 * failing on a constraint the platform does not control.
 *
 * It mirrors `sanitizeTitle` exactly. If that changes, this has to change with it, which is why the
 * two are named after each other.
 */
function asSanitizedTitle(label: string): string {
  return label.normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * THE ROOMS A SPLIT MADE, READ FROM THE LINK IT POSTS.
 *
 * Creating a conversation posts a message back into the PARENT carrying
 * `driftRedirect: { childChannelArn, label }` - the back-reference that makes the new room
 * followable from the old one. That is the product telling us exactly what it created, with the
 * ARN, in the conversation this test is already watching.
 *
 * Every earlier version of this assertion asked the wrong question instead: "does a room with this
 * NAME exist among the 537 this account has accumulated". It was wrong in two opposite directions
 * against a working deployment - an EARLIER run's split read as this one's, and a new room
 * collapsing into an identically named old one read as nothing having been created.
 *
 * A name is a label; the ARN is identity; and the link is the product volunteering both. It also
 * needs no listing, no pagination and no polling of a table that grows every run.
 */
function splitsAnnouncedIn(
  recorder: ChannelWireRecorder,
  channelArn: string,
): Array<{ label: string; childChannelArn: string }> {
  return recorder.botMessagesFor(channelArn)
    .map((m) => (m.metadata as { driftRedirect?: { childChannelArn?: string; label?: string } } | undefined)
      ?.driftRedirect)
    .filter((d): d is { childChannelArn: string; label: string } =>
      !!d?.childChannelArn && typeof d.label === 'string')
    .map((d) => ({ label: d.label, childChannelArn: d.childChannelArn }));
}

/** Wait for the split to announce itself, which is the moment the room exists and is followable. */
async function splitsAnnouncedUntil(
  page: Page,
  recorder: ChannelWireRecorder,
  channelArn: string,
  timeoutMs = 420_000,
): Promise<Array<{ label: string; childChannelArn: string }>> {
  const deadline = Date.now() + timeoutMs;
  let seen = splitsAnnouncedIn(recorder, channelArn);
  while (!seen.length && Date.now() < deadline) {
    await page.waitForTimeout(3_000);
    seen = splitsAnnouncedIn(recorder, channelArn);
  }
  return seen;
}


/**
 * The name a subject becomes, mirroring `sanitizeTitle` in channel-creation.
 *
 * Duplicated deliberately and kept to one line: importing backend source into an e2e would let a
 * change to the rule move the test's expectation with it, and then the test could never disagree.
 */


/**
 * THE OFFER AS RECORDED, which is the thing the person's answer is later checked against.
 *
 * Asserted on the RECORD rather than on the assistant's wording, and that is not a convenience. The
 * offer is spoken in the assistant's own voice, in this deployment's persona and this conversation's
 * language (tenet D11), so there is no English to match on that would still be true for a deployment
 * that configured a different voice. What must be true everywhere is that the subjects were written
 * down, against the person they were put to.
 */
/**
 * The amendments this conversation has recorded and not yet folded in.
 *
 * Read directly, because the fold's whole signature is a TRANSITION: the reading writes the ids, and
 * only the running turn folding them in takes them off again. Recorded-then-cleared is the fold
 * happening; recorded-and-stuck is the reading classifying an amendment that reached nothing, which
 * is precisely the shipped bug this covers.
 */


/**
 * THE PRECONDITION, NAMED, because its absence is silent everywhere else.
 *
 * The offer is asserted on the recorded row, so a turn-state table this run cannot resolve makes
 * every read return null: the wait for an offer reports "none was made" against a deployment that
 * made one, and the wait for the offer to CLEAR passes instantly against a deployment that never
 * handled the answer. One direction invents a failure and the other invents a pass, which is worse.
 *
 * This is not hypothetical. It is what these tests did until 2026-08-30, while the record held the
 * offer they were looking for; validate.mjs did not pass E2E_INSTANCE_NAME to this phase.
 */
function requireTurnStateTable(): void {
  expect(
    resolveTurnStateTable(),
    'the turn-state table must be resolvable (TURN_STATE_TABLE, or E2E_INSTANCE_NAME plus AWS '
      + 'credentials) - without it an offer cannot be read back, and a deployment that made one is '
      + 'indistinguishable from one that did not',
  ).toBeTruthy();
}

/**
 * Wait for the offer, ANCHORED ON THE WIRE rather than polled.
 *
 * The offer lands with the PROPOSAL, not with the enqueue - which the old comment here already said,
 * and which makes the proposal frame the event that means "read it now". Polling for it instead spent
 * an `aws dynamodb get-item` subprocess every 3s for up to seven minutes, and on a test that was
 * going to fail it burned every second of that before saying so. Two of the slowest tests in this
 * file went through here.
 *
 * The short retry after the frame absorbs the gap between the message being delivered and the row
 * being readable. It is bounded in seconds because that gap is a write becoming visible, not a turn
 * being taken.
 */
async function waitForPendingSplit(
  page: Page,
  recorder: ChannelWireRecorder,
  channelArn: string,
  responderId: string,
  sinceMs: number,
  forMs: number,
): Promise<ReturnType<typeof pendingSplitRow>> {
  await waitForPhase(recorder, channelArn, sinceMs, 'interim', forMs);
  let row = pendingSplitRow(channelArn, responderId);
  for (let i = 0; i < 5 && !row?.topics.length; i += 1) {
    await page.waitForTimeout(1_000);
    row = pendingSplitRow(channelArn, responderId);
  }
  return row;
}
/**
 * THE DRAIN ANNOUNCES ITS OWN PROGRESS, AND THIS FILE WAS IGNORING IT.
 *
 * `advanceQueueNotice` writes `queueStatus` into the notice's metadata and updates that notice IN
 * PLACE, so every stage the drain reaches is already a frame the client receives:
 *
 *   waiting -> reviewing -> clarifying -> addressing_private -> clearing -> settled
 *
 * The backend treats this as load-bearing - arrival triage reads `queueStatus` to tell a stage update
 * apart from a genuine new deferral - and until now not one assertion in this file looked at it. The
 * tests waited on the ENDPOINTS (a proposal, an answer) and filled the gap between them by reading
 * DynamoDB on a timer, which is both slower than the stream and blind to where a drain actually got to.
 *
 * WHY THIS MAKES FAILURES LEGIBLE, which matters more than the seconds. "no proposal in 240s" does not
 * say whether the reading never started, looped, or died after clearing. `stagesSeen` answers that in
 * the failure message itself, from frames already captured.
 *
 * AT-OR-PAST, NOT EQUAL. `clarifying` and `addressing_private` are optional edges in the machine, so a
 * drain can legally reach `clearing` without them. Waiting for exact equality on a stage this drain was
 * never going to enter would hang until the deadline on a perfectly healthy run.
 */
const QUEUE_STAGES = [
  'waiting', 'reviewing', 'clarifying', 'addressing_private', 'clearing', 'settled',
] as const;
type QueueStage = typeof QUEUE_STAGES[number];

function queueStageOf(frame: WireMessage): QueueStage | null {
  const status = (frame.metadata as { queueStatus?: string } | undefined)?.queueStatus;
  return status && (QUEUE_STAGES as readonly string[]).includes(status)
    ? status as QueueStage
    : null;
}

/** Every stage this conversation has been seen to reach, in the order the frames arrived. */
function stagesSeen(recorder: ChannelWireRecorder, channelArn: string): QueueStage[] {
  const seen: QueueStage[] = [];
  for (const f of noticeFrames(recorder, channelArn)) {
    const stage = queueStageOf(f);
    if (stage && seen[seen.length - 1] !== stage) seen.push(stage);
  }
  return seen;
}

/**
 * Wait until the drain reaches `stage` OR any later one. Null on timeout.
 *
 * Read off the recorder's retained history rather than sampled, so a stage that came and went between
 * two checks is still found - the reason this can watch a machine that moves faster than any poll.
 */
async function waitForQueueStage(
  recorder: ChannelWireRecorder,
  channelArn: string,
  stage: QueueStage,
  timeoutMs: number,
  /**
   * NOT A FAIL-FAST ON THE TURN'S FINAL FRAME, and the attempt is recorded because it looked obvious.
   *
   * The idea was: the turn produced its answer, so a stage that has not appeared is not coming. That
   * is exactly backwards for this queue. The drain runs AFTER the turn it was queued behind - arrival
   * triage is caught at the handover, which is the last moment anything holds the conversation - so
   * the final frame is roughly when the stages START, not when they stop being possible.
   *
   * Measured: with the early return in place the amendment test bailed at the answer and reported
   * `stages seen: none`, having given up seconds before the drain it was waiting for began.
   */
  sinceMs?: number,
): Promise<QueueStage | null> {
  const target = QUEUE_STAGES.indexOf(stage);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reached = stagesSeen(recorder, channelArn)
      .find((s) => QUEUE_STAGES.indexOf(s) >= target);
    if (reached) return reached;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

function noticeFrames(recorder: ChannelWireRecorder, channelArn: string): WireMessage[] {
  return recorder
    .botMessagesFor(channelArn)
    .filter((m) => (m.metadata as { respPhase?: string } | undefined)?.respPhase === 'notice');
}

function queueDepthOf(frame: WireMessage): number | undefined {
  const depth = (frame.metadata as { queueDepth?: unknown } | undefined)?.queueDepth;
  return typeof depth === 'number' ? depth : undefined;
}

/**
 * THE NOTICE SETTLING, which is the queue reporting it is finished with - every pass, not just one.
 *
 * `clearing` says A pass emptied what it read. A queue that moved under the reading is read AGAIN,
 * and an amendment the fold never reached becomes its own item on that later pass - so anything
 * asserted about the final outcome has to wait for the queue to be done, not for one pass to be.
 *
 * ── WHAT IT WATCHES, AND WHY NOT THE WORDS ──────────────────────────────────────────────────────
 *
 * `settleQueueNotice` writes the settled wording from configuration (`copy.queueSettled`, resolved
 * through the active profile), so the sentence a person reads differs per deployment and per language
 * and there is no English here that would still be true elsewhere (tenets P5 and D11). What IS the same
 * everywhere is the machine state carried alongside it: `queueDepth: 0` and `queueStatus: 'settled'`,
 * both written unconditionally by that same call, and both already the fields the client reads to stop
 * showing messages as waiting. Those are what this asserts.
 *
 * BOTH, NOT EITHER. Depth alone was what this helper checked while it was unused, and depth alone
 * cannot see the defect the stage exists for: a settle that rewrites the text and leaves the stage at
 * `clearing` shows a person "caught up" with a pulsing "clearing the queue" underneath it, for ever,
 * because nothing else is coming to correct it.
 *
 * THE LATEST FRAME, NOT THE FIRST MATCHING ONE - the other half of what was wrong here. A pass that
 * empties what it read settles the notice; a queue that moved under the reading then REFILLS it, and
 * the first depth-0 frame belongs to the pass that is no longer the outcome. Reading the last notice
 * frame asks what the notice SAYS NOW, which is both the thing the person is looking at and the only
 * reading that covers every pass.
 */
async function waitForNoticeSettled(
  recorder: ChannelWireRecorder,
  channelArn: string,
  sinceMs: number,
  timeoutMs = 180_000,
): Promise<WireMessage | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frames = noticeFrames(recorder, channelArn).filter((f) => f.atMs >= sinceMs);
    const latest = frames[frames.length - 1];
    if (latest && (queueDepthOf(latest) ?? -1) === 0 && queueStageOf(latest) === 'settled') return latest;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Wait until the deferral notice reports at least `depth` waiting. Null on timeout. */
async function waitForNoticeDepth(
  recorder: ChannelWireRecorder,
  channelArn: string,
  depth: number,
  timeoutMs = 90_000,
): Promise<WireMessage | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frames = noticeFrames(recorder, channelArn);
    const reached = frames.reverse().find((f) => (queueDepthOf(f) ?? 0) >= depth);
    if (reached) return reached;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Watch the waiting state until it settles, and report the HIGH-WATER MARK.
 *
 * WHY A MAXIMUM AND NOT AN INSTANT. Triage fires on the notice ARRIVING, which is the whole point of
 * the design - the interrupt is evaluated while the work is still running rather than after it. The
 * consequence for a test is that the queue is transient by construction: it fills, is read, and
 * clears, and a single instantaneous read can land on either side of that and report zero for a queue
 * that was certainly there.
 *
 * Sampling would be the wrong fix if the property under test were "the queue is deep RIGHT NOW". It
 * is not. It is "all of them were held and none was dropped", and the greatest depth observed is the
 * honest measurement of that.
 *
 * Sampled from BOTH surfaces because they answer different questions: the record is the authority,
 * and the transcript is what the person actually sees. A record that is right while nothing renders
 * is the same to them as no record at all.
 */
async function watchQueue(
  page: Page,
  channelArn: string,
  responderId: string,
  forMs: number,
): Promise<{
  maxRecorded: number;
  maxRendered: number;
  maxLabelled: number;
  noticeId?: string;
  drained: boolean;
  /**
   * Was the waiting message even IN the transcript while the record held it?
   *
   * Without this, "the person never saw it marked" has two very different causes wearing the same
   * number: the client never learned the message was waiting, or the client never had the message at
   * all. The first is a state bug and the second is a transcript bug, and they are fixed in different
   * places.
   */
  queuedIdInDom: boolean;
  /**
   * How many reads THIS WATCHER made.
   *
   * The test and the app share a page, so a raw count of turn-state calls cannot say who asked.
   * Subtracting this from that count leaves the app's own reads, which is the difference between a
   * client that was told the wrong thing and a client that never asked.
   */
  polls: number;
}> {
  const deadline = Date.now() + forMs;
  let maxRecorded = 0;
  let maxRendered = 0;
  // The LABEL, counted separately from the attribute. The word a person reads began as
  // `content: 'waiting'` on a pseudo-element, which put user-facing English somewhere no translation
  // mechanism can reach - `t()` cannot see a stylesheet and a locale file cannot override one. A
  // marked message with no rendered label would satisfy the attribute count and say nothing to them.
  let maxLabelled = 0;
  let noticeId: string | undefined;
  let drained = false;
  let queuedIdInDom = false;
  let polls = 0;
  for (;;) {
    const rendered = await page.locator('.message[data-queued="true"]').count().catch(() => 0);
    maxRendered = Math.max(maxRendered, rendered);
    const labelled = await page
      .locator('.message[data-queued="true"] .message-waiting-label').count().catch(() => 0);
    maxLabelled = Math.max(maxLabelled, labelled);
    const state = await turnState(page, channelArn, responderId);
    polls += 1;
    maxRecorded = Math.max(maxRecorded, state.queued.length);
    // Checked WHILE the record holds it, not afterwards: the transcript is what the person is
    // looking at, and the question is whether the message they are waiting on was in front of them.
    for (const id of state.queued) {
      const present = await page.locator(`.message[data-message-id="${id}"]`).count().catch(() => 0);
      if (present > 0) queuedIdInDom = true;
    }
    if (state.noticeId) noticeId = state.noticeId;
    // Drained means the record said so AFTER having held something, never merely "it is empty now" -
    // which is also true a moment before the first message is enqueued.
    if (maxRecorded > 0 && state.queued.length === 0) drained = true;
    if (drained || Date.now() > deadline) {
      return {
        maxRecorded, maxRendered, maxLabelled, ...(noticeId ? { noticeId } : {}), drained, queuedIdInDom, polls,
      };
    }
    await page.waitForTimeout(1_500);
  }
}

/**
 * Wait until this assistant has actually CLAIMED the conversation.
 *
 * A `setTimeout` here would be a guess, and the wrong guess in either direction ruins the test: too
 * short and the second message races the claim, so nothing queues and the suite reports a product
 * failure that is really a timing bug in itself; too long and the first turn has finished. The bot's
 * first frame is posted downstream of the claim, so waiting for it is a happens-after rather than an
 * estimate.
 */
async function waitUntilBusy(
  recorder: ChannelWireRecorder,
  channelArn: string,
  sinceMs: number,
  timeoutMs = 60_000,
): Promise<WireMessage | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = recorder.botMessagesFor(channelArn).find((m) => m.atMs >= sinceMs);
    if (frame) return frame;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}


/** The responder id the record is keyed on, taken from the assistant's own message. */
function responderIdOf(frame: WireMessage): string {
  return frame.senderArn.split('/').pop() || '';
}


/**
 * EVERY call the page makes to the turn-state endpoint, and what came back.
 *
 * The record can hold a waiting message while the person sees nothing, and from the outside those
 * two facts do not say which half is wrong: whether the client never ASKED, or asked and was told
 * nothing was waiting. This watches the wire so a failure names one of them.
 *
 * The test's own reads go through the same page and so appear here too. They are distinguishable by
 * count - the test polls on a fixed interval and the app reads on an event.
 */
function recordTurnStateCalls(page: Page): { calls: { at: number; status: number; queued: number }[] } {
  const calls: { at: number; status: number; queued: number }[] = [];
  page.on('response', (res) => {
    if (!res.url().includes('/turn-state')) return;
    void res.json().then(
      (body) => calls.push({
        at: Date.now(), status: res.status(), queued: Array.isArray(body?.queued) ? body.queued.length : -1,
      }),
      () => calls.push({ at: Date.now(), status: res.status(), queued: -1 }),
    );
  });
  return { calls };
}

/**
 * Start the long turn and hand back the responder that is answering it.
 *
 * IT DELIBERATELY DOES NOT READ THE TURN RECORD FIRST. Confirming "busy" here costs an API round
 * trip, and the caller's very next act is the send that has to land while that turn is still
 * running. A turn is seconds long, so the confirmation SPENT THE WINDOW IT WAS CONFIRMING: the lock
 * had been released by the time the queued message reached the router, no notice was posted, and
 * the queue tests failed on a race this helper introduced.
 *
 * The deferral notice the callers already assert IS the proof that the message queued. A check
 * ahead of it buys nothing and costs the only thing that is scarce here.
 */
async function startLongTurn(
  page: Page,
  recorder: ChannelWireRecorder,
  channelArn: string,
  startedAt: number,
): Promise<string> {
  const t0 = Date.now();

  // THE RESPONDER COMES FROM THE WELCOME, BEFORE THE PROMPT, and the wait that used to follow the
  // prompt is gone with it.
  //
  // That wait was the only reason this helper looked at frames at all, and it cost the thing the
  // callers need most: every second spent waiting is a second of the turn they are trying to queue
  // behind. Today's correlation fixes took roughly seven seconds out of every triage turn, and the
  // window closed far enough that three tests began trading failures run to run - `/stop` finding
  // nothing waiting, the waiting-styling check finding nothing to clear, the amendment finding
  // nothing to fold. All three are the same race, and none of them is a product defect.
  //
  // Resolving from the welcome removes it. The channel is new, so any bot frame recorded against it
  // is this conversation's; no cutoff is needed, and taking one AFTER `newConversation` returns is
  // how the first attempt at this managed to miss a welcome that had already arrived.
  //
  // The prompt and the caller's next send are then back to back. Ordering still holds: the sends are
  // sequential and Amazon Chime SDK delivers them in order, so the router claims on the first before
  // the second reaches it. That is a happens-after, not the `setTimeout` guess this helper has always
  // refused - and unlike reading the turn record, it spends none of the window it is protecting.
  await sendWithoutWaiting(page, LONG_PROMPT);
  console.log(`[queue-e2e] t+${Date.now() - t0}ms sent the long prompt`);

  // ANY bot frame, the welcome included: this needs the responder id, and it needs it EARLY.
  // Measured, the first frame tied to the request itself arrives at t+4.8s of a ~6s turn, because
  // nothing posts an early placeholder the wire can see - so waiting for one guarantees the queued
  // send lands after the turn it was meant to queue behind. The welcome arrives within about a
  // second, carries the same responder, and by then the router has claimed the turn.
  const firstFrame = await waitUntilBusy(recorder, channelArn, startedAt);
  console.log(
    `[queue-e2e] t+${Date.now() - t0}ms first bot frame, `
    + `phase=${String(firstFrame?.metadata?.responsePhase ?? firstFrame?.metadata?.phase ?? 'none')} `
    + `len=${firstFrame?.content?.length ?? 0}`,
  );
  expect(firstFrame, 'the assistant must acknowledge the first message before anything can queue')
    .not.toBeNull();
  const responderId = responderIdOf(firstFrame!);
  expect(responderId, 'the responder id comes from the assistant\'s own sender ARN').toBeTruthy();

  console.log(`[queue-e2e] responder=${responderId} channel=${channelArn}`);
  return responderId;
}

/** Bot frames of a given response phase that arrived after an instant. */
function botFramesSince(
  recorder: ChannelWireRecorder,
  channelArn: string,
  sinceMs: number,
  phase: string,
): WireMessage[] {
  return recorder
    .botMessagesFor(channelArn)
    .filter((m) => m.atMs > sinceMs)
    .filter((m) => (m.metadata as { respPhase?: string } | undefined)?.respPhase === phase);
}

/**
 * Wait for a bot frame of one phase to arrive after an instant. Null on timeout.
 *
 * A HAPPENS-AFTER RATHER THAN A SLEEP, for the reason `waitUntilBusy` gives: the dispatched turn this
 * waits on runs in another Lambda, so any fixed wait is a guess that is either flaky or slow.
 */
async function waitForPhase(
  recorder: ChannelWireRecorder,
  channelArn: string,
  sinceMs: number,
  phase: string,
  timeoutMs: number,
): Promise<WireMessage | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [found] = botFramesSince(recorder, channelArn, sinceMs, phase);
    if (found) return found;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * Wait until this conversation holds an open task for this person. Empty on timeout.
 *
 * THE PRECONDITION FOR ANY STOP TEST, and asserted rather than assumed. `/stop` dispatches its judged
 * half only when it is actually holding something, so a stop test that never established work in
 * flight would pass on a runtime that dispatches nothing - the vacuous shape this suite exists to
 * avoid. Polled because the task is written by the turn, not by the send.
 */
async function waitForOpenTask(
  userTable: string,
  personId: string,
  channelArn: string,
  since: number,
  timeoutMs = 120_000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = readUserTasksInChannel(userTable, personId, channelArn, since);
    if (rows.length) return rows;
    if (Date.now() > deadline) return [];
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** Every mirror row this person opened in this conversation during the run, whatever its type. */
function readUserTasksInChannel(
  userTable: string,
  personId: string,
  channelArn: string,
  since: number,
): Array<Record<string, unknown>> {
  // Not `runTasksFor`, which filters to ONE task type. What is being established here is that the
  // assistant is holding work at all, and the type it holds is the classifier's business.
  const q = aws(
    `dynamodb query --table-name "${userTable}" `
      + '--key-condition-expression "principalId = :u" '
      + `--expression-attribute-values ${JSON.stringify({ ':u': { S: personId } }).replace(/"/g, '\\"')}`,
  );
  return ((q?.Items ?? []) as Array<Record<string, any>>)
    .map((i) => Object.fromEntries(Object.entries(i).map(([k, v]) => [k, (v as any).S ?? (v as any).N ?? v])))
    .filter((r) => r.channelArn === channelArn)
    .filter((r) => new Date(String(r.createdAt ?? 0)).getTime() >= since);
}

/**
 * Send a message `Target`-addressed at one assistant, as this person.
 *
 * NOT THROUGH THE COMPOSER, because what is under test is what a TARGETED request becomes - a private
 * task - and the composer offers that affordance only in shapes this suite does not set up. The wire
 * shape is identical to the one the composer produces (`Target: [{MemberArn}]`, STANDARD,
 * PERSISTENT), so this exercises the same server path.
 */

/** Create a Premium conversation and return its ARN. */
async function newConversation(page: Page, label: string): Promise<string> {
  const created = page.waitForResponse(
    (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await createConversation(page, `${label} ${Date.now()}`, 'Premium');
  const arn = (await (await created).json()).conversation.conversationArn as string;
  expect(arn, `channelArn for ${label}`).toBeTruthy();
  await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15_000 });
  return arn;
}

suite('a turn holds the conversation, and what arrives meanwhile waits', () => {
  guardBackendErrors('turn-queue');

  let creds: TestCredentials;
  test.beforeAll(async () => {
    creds = await getTestCredentials();
    expect(
      TURN_STATE_API,
      'VITE_PERSON_API_URL must be set - without it the client renders no waiting state at all '
        + 'and this suite would assert against a deployment that simply has the feature switched off',
    ).toBeTruthy();
  });

  test('a message sent while the assistant is working is held, shown as waiting, and picked up', async ({ page }) => {
    test.setTimeout(600_000);

    const recorder = new ChannelWireRecorder();
    recorder.attach(page); // BEFORE navigation - a listener added after goto misses the socket
    const turnStateCalls = recordTurnStateCalls(page);
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    const channelArn = await newConversation(page, 'Queue single');

    const startedAt = Date.now();
    const responderId = await startLongTurn(page, recorder, channelArn, startedAt);

    // The second message, sent into a conversation that is provably already answering.
    await sendWithoutWaiting(page, NEW_REQUEST_A);

    // ── THE DEFERRAL IS SPOKEN ──────────────────────────────────────────────────────────────────
    //
    // A deferred message that says nothing is indistinguishable from a broken assistant, which is the
    // failure tenet 4 exists to prevent. This is the assertion that the person was told.
    const notice = await waitForNoticeDepth(recorder, channelArn, 1);
    expect(
      notice,
      'the assistant must post a deferral notice naming what is waiting; without one the person sees '
        + 'their message sit unanswered with no explanation',
    ).not.toBeNull();
    expect(notice!.content.trim().length, 'the notice must actually say something').toBeGreaterThan(0);

    // ── THE ENDPOINT ANSWERS THE MEMBER WHO ASKED ───────────────────────────────────────────────
    const first = await turnState(page, channelArn, responderId);
    expect(first.status, 'GET /turn-state answers the member who asked').toBe(200);

    // ── THE RECORD HELD IT, THE TRANSCRIPT SHOWED IT, AND THEN IT DRAINED ───────────────────────
    //
    // Watched rather than sampled once, because triage fires on the notice ARRIVING and so the queue
    // is transient by construction - which is the design working, not a timing problem to route
    // around. A single read can land on either side of it and report zero for a queue that was
    // certainly there.
    const watched = await watchQueue(page, channelArn, responderId, 420_000);
    console.log(`[queue-e2e] watched: ${JSON.stringify(watched)}`);
    // What the PAGE asked for, and what it was told. A run where the record held a message and every
    // call reports queued=0 is a server answering wrongly; one with no calls at all is a client that
    // never asked. The test's own reads share this page, so the count includes them.
    const withQueue = turnStateCalls.calls.filter((c) => c.queued > 0).length;
    // `byApp` is the number this whole diagnostic exists for: reads the APP made, on its own, with
    // the test's polls subtracted. Zero means the client never asked, whatever the server returned.
    const byApp = turnStateCalls.calls.length - watched.polls;
    console.log(`[queue-e2e] turn-state calls: ${turnStateCalls.calls.length}, `
      + `byWatcher: ${watched.polls}, byApp: ${byApp}, non-empty: ${withQueue}, `
      + `statuses: ${[...new Set(turnStateCalls.calls.map((c) => c.status))].join(',')}`);
    expect(
      watched.maxRecorded,
      'the record must hold the waiting message at some point; if it never does, the message was '
        + 'answered alongside the running turn rather than queued behind it',
    ).toBeGreaterThanOrEqual(1);
    expect(
      watched.maxRendered,
      'and the person must SEE it marked - a record nobody renders is the same to them as no record',
    ).toBeGreaterThanOrEqual(1);
    expect(
      watched.maxLabelled,
      'the mark must carry a rendered label, not only a data attribute - the word a person reads has '
        + 'to live where the strings live, or no locale can translate it',
    ).toBeGreaterThanOrEqual(1);
    expect(
      watched.noticeId,
      'the record names the notice the conversation is showing, which is what makes the next queued '
        + 'send an update rather than a second line',
    ).toBeTruthy();
    expect(
      watched.drained,
      'the queue must then be read and cleared; a message that stays queued for ever is the request '
        + 'that silently never happened',
    ).toBe(true);
    console.log(`[queue-e2e] queue drained ${Math.round((Date.now() - startedAt) / 1000)}s after the first send`);

    // ── AND WHAT CAME OUT OF IT IS DURABLE WORK ─────────────────────────────────────────────────
    //
    // The queue is a holding pen; what survives it is a TASK. Asserted against the store rather than
    // the reply, because a proposal that describes work nothing holds is precisely the reassurance
    // this design exists to make true.
    const userTable = resolveTaskTable('user-tasks');
    if (userTable) {
      const idToken = await idTokenOf(page);
      const personId = await personIdFromIdToken(idToken || '');
      // ONE READ, ANCHORED TO AN EVENT. `watched.drained` above is the RECORD reporting the queue
      // cleared, which the drain does after creating the work - so the row exists by now or the
      // reading never made it. The poll that used to be here asked the same question of DynamoDB
      // twelve times and reported a timing problem as a missing task.
      const opened = runTasksFor(userTable, personId, {
        taskType: 'queued_request', channelArn, since: startedAt,
      });
      expect(
        opened.length,
        'the queued request must exist as an open work item, not only as a sentence in a reply',
      ).toBeGreaterThanOrEqual(1);
      console.log(`[queue-e2e] queued_request tasks: ${opened.map((t) => t.taskId).join(', ')}`);
      // ── EACH ONE RECORDS THE INTENT ITS MESSAGE WAS CLASSIFIED AS (ADR-064 decision B) ─────────────
      //
      // A `queued_request` is a platform machine, not an intent, so its steps route, and its turns are attributed, under
      // the intent the router classified the queued message as before it queued. The copy a person's list reads carries it.
      for (const row of opened) {
        expect(
          typeof row.openingIntent === 'string' && row.openingIntent.length > 0,
          `queued_request ${row.taskId} must record the intent its message queued with; got ${JSON.stringify(row.openingIntent)}`,
        ).toBe(true);
      }
    } else {
      console.warn('[queue-e2e] no user-tasks table resolved; skipped the durable-work assertion');
    }

    // ── THE NOTICE STOPS CLAIMING THE ASSISTANT IS BUSY ─────────────────────────────────────────
    //
    // Left alone it keeps saying "still working", and because it is the message the client subscribes
    // to, the waiting styling would never clear either. Both are the same fix, and this checks it from
    // the user's side: the record has drained (asserted above), so the transcript must follow.
    await expect(
      page.locator('.message[data-queued="true"]'),
      'the waiting styling clears once the queue has been read; if it does not, the notice was never '
        + 'settled and the client has no event telling it the queue changed',
    ).toHaveCount(0, { timeout: 90_000 });
  });

  test('three messages arriving while it works draw ONE notice, not three', async ({ page }) => {
    test.setTimeout(600_000);

    const recorder = new ChannelWireRecorder();
    recorder.attach(page);
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    const channelArn = await newConversation(page, 'Queue depth');

    const startedAt = Date.now();
    const responderId = await startLongTurn(page, recorder, channelArn, startedAt);

    // A MIX, deliberately: an amendment and two new requests. A queue of three identical asks would
    // let a "just concatenate them" implementation look correct, and concatenation is the design this
    // one replaced - it buries the amendment inside a compound request and answers the new question
    // inside a report revision.
    await sendWithoutWaiting(page, AMENDMENT);
    await sendWithoutWaiting(page, NEW_REQUEST_A);
    await sendWithoutWaiting(page, NEW_REQUEST_B);

    // Watched CONCURRENTLY with the wire, not after it. Triage fires on the first notice, so waiting
    // for the depth to reach three before looking at the record would routinely look after the queue
    // had already been read - and report zero for a queue that was certainly there. The wire watch is
    // pure bookkeeping over frames already received, so the two do not contend for the page.
    const [notice, watched] = await Promise.all([
      waitForNoticeDepth(recorder, channelArn, 3, 120_000),
      watchQueue(page, channelArn, responderId, 300_000),
    ]);
    console.log(`[queue-e2e] watched: ${JSON.stringify(watched)}`);
    expect(
      notice,
      'the notice must report all three waiting; a depth that stops at one means later sends were '
        + 'not recorded',
    ).not.toBeNull();

    // ── ONE MESSAGE, UPDATED IN PLACE ───────────────────────────────────────────────────────────
    //
    // THE assertion of this test. Posting a fresh reply per queued message reproduces the exact
    // doubling the design exists to prevent: three "still working on it" lines leave the conversation
    // noisier than if nothing had been said at all. On the wire the update arrives as further frames
    // carrying the SAME message id, so the ids are what is counted, never the frames.
    const ids = new Set(noticeFrames(recorder, channelArn).map((f) => f.messageId));
    expect(
      ids.size,
      `the deferral must be ONE message updated in place, got ${ids.size} distinct notices: `
        + `${[...ids].join(', ')}`,
    ).toBe(1);

    expect(
      watched.maxRecorded,
      'all three must be held at once; a record that never exceeds one means later sends replaced the '
        + `earlier ones rather than joining them (max observed ${watched.maxRecorded})`,
    ).toBeGreaterThanOrEqual(3);

    // And the transcript marks each of them, not only the latest. The high-water mark for the same
    // reason: the queue is read while the work is still running, so the three are on screen together
    // for a window rather than until the turn ends.
    expect(
      watched.maxRendered,
      `every waiting message is marked, not only the most recent (max observed ${watched.maxRendered})`,
    ).toBeGreaterThanOrEqual(3);
  });

  test('/stop suppresses the answer in flight, quickly, and does not throw away the queue', async ({ page }) => {
    test.setTimeout(600_000);

    const recorder = new ChannelWireRecorder();
    recorder.attach(page);
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    const channelArn = await newConversation(page, 'Queue stop');

    const startedAt = Date.now();
    const responderId = await startLongTurn(page, recorder, channelArn, startedAt);

    await sendWithoutWaiting(page, NEW_REQUEST_A);
    const notice = await waitForNoticeDepth(recorder, channelArn, 1);
    expect(notice, 'something must be waiting before /stop can be shown not to discard it').not.toBeNull();

    // ── NEAR REAL TIME ──────────────────────────────────────────────────────────────────────────
    //
    // `/stop` is the escape hatch, and an escape hatch that queues behind the work it is escaping is
    // not one. It is handled before the turn claim in the router and never reaches a model, so it
    // answers in about the time a round trip takes. The budget is loose because this measures a live
    // deployment, but it is far below a turn: a `/stop` that took as long as an answer would mean it
    // had been swallowed by the very lock it exists to escape.
    const stopStarted = Date.now();
    const stopReply = await sendAndWaitForResponse(page, '/stop', 60_000);
    const stopMs = Date.now() - stopStarted;
    console.log(`[queue-e2e] /stop answered in ${stopMs}ms: "${stopReply.text.slice(0, 120)}"`);
    expect(stopReply.text.trim().length, '/stop must answer').toBeGreaterThan(0);
    expect(
      stopMs,
      `/stop answered in ${stopMs}ms; it is handled before the turn claim and never calls a model, so `
        + 'anything near a turn\'s duration means it was queued behind the work it exists to stop',
    ).toBeLessThan(45_000);

    // ── THE WORK STOPS ──────────────────────────────────────────────────────────────────────────
    //
    // Cancelling the task records is the durable half; without suppressing the answer the Lambda
    // already mid-Bedrock-call still posts, and a person who stopped a briefing receives the briefing.
    // From their side the escape hatch did not work. The turn asks once, immediately before it
    // delivers - so what is asserted is the absence of a settled answer to the long prompt.
    //
    // A phase, not a text match: the suppressed turn is stamped `cancelled`, and a reply that lands
    // with `final` after a stop is the failure. Waiting a real minute, because the point is that the
    // answer never arrives rather than that it is late.
    await page.waitForTimeout(60_000);
    const finals = recorder
      .botMessagesFor(channelArn)
      .filter((m) => m.atMs > stopStarted)
      .filter((m) => (m.metadata as { respPhase?: string } | undefined)?.respPhase === 'final');
    // A `final` frame is legitimate for the /stop reply itself and for anything the queue turned
    // into; what must not appear is the long briefing. Six paragraphs is unmistakable next to a
    // one-line confirmation, so length is what separates them.
    const briefingLanded = finals.filter((m) => m.content.length > 1_500);
    expect(
      briefingLanded.length,
      `the stopped work must not deliver: ${briefingLanded.length} long answer(s) landed after /stop`
        + (briefingLanded.length ? ` - first was "${briefingLanded[0].content.slice(0, 200)}..."` : ''),
    ).toBe(0);

    // ── AND THE QUEUE IS NOT COLLATERAL ─────────────────────────────────────────────────────────
    //
    // THE assertion this test exists for. `/stop` means "stop what you are doing", never "forget what
    // I said while you were doing it" - a message that arrived during the work is a request the person
    // made and still expects an answer to, and discarding it turns an interrupt into data loss they
    // were never told about.
    //
    // Observed the way the person would: the queued message is either still recorded as waiting, or it
    // has already been read into work. What must not be true is that it is gone with nothing behind it.
    // The task store is REQUIRED here rather than best-effort. Without it the only evidence left is
    // "still queued", and triage may legitimately have read the queue by now - so a missing table
    // would turn a passing system into a failing test and an implementation that DID discard the
    // queue into an indistinguishable one. Naming the precondition is better than either.
    const userTable = resolveTaskTable('user-tasks');
    expect(
      userTable,
      'the user-tasks table must be resolvable (USER_TASKS_TABLE, or E2E_INSTANCE_NAME plus AWS '
        + 'credentials) - without it there is no way to tell a queue that was READ from one that was '
        + 'discarded, which is the whole distinction this test makes',
    ).toBeTruthy();

    const stillWaiting = await turnState(page, channelArn, responderId);
    const idToken = await idTokenOf(page);
    // ANY OF THE ROWS A QUEUED MESSAGE BECOMES, not only `queued_request`. Which one is the reading's
    // judgement: a message it cannot make out opens a `queued_clarification` instead, and after a stop
    // "Also, what was our Q3 headcount?" has been read that way (e2e, 2026-10-23: the drain created one
    // `queued_clarification` and cleared the queue). The message survived either way; that is the claim.
    // `work_still_wanted` is not among them: it is about the stopped work, not the queued message.
    const personId = await personIdFromIdToken(idToken || '');
    const opened = ['queued_request', 'queued_clarification', 'queued_combination'].flatMap((taskType) => (
      runTasksFor(userTable!, personId, { taskType, channelArn, since: startedAt })
        .map((r) => String(r.taskType))
    ));
    const becameWork = opened.length > 0;
    expect(
      stillWaiting.queued.length > 0 || becameWork,
      'what arrived while the assistant was working must survive /stop - it is either still queued or '
        + `it has become an open work item (queued=${JSON.stringify(stillWaiting.queued)}, `
        + `tasks=${JSON.stringify(opened)})`,
    ).toBe(true);
  });

  test('busy is a property of the assistant, not of the conversation', async ({ page }) => {
    test.setTimeout(420_000);

    const recorder = new ChannelWireRecorder();
    recorder.attach(page);
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    const channelArn = await newConversation(page, 'Queue per-responder');

    const startedAt = Date.now();
    const responderId = await startLongTurn(page, recorder, channelArn, startedAt);

    await sendWithoutWaiting(page, NEW_REQUEST_A);
    expect(await waitForNoticeDepth(recorder, channelArn, 1), 'something must be waiting').not.toBeNull();

    const busy = await turnState(page, channelArn, responderId);
    expect(busy.busy, 'the assistant that is working reports busy').toBe(true);

    // ── THE SAME CONVERSATION, A DIFFERENT ASSISTANT ────────────────────────────────────────────
    //
    // This is what makes a room with several assistants work: two people addressing two assistants
    // both get answers, because the claim is keyed on WHO is answering rather than on where. A
    // conversation-keyed lock returns busy for any responder asked, and every other assertion in this
    // suite passes on that implementation - so this is the one that discriminates.
    //
    // Asked about a responder that does not hold this conversation rather than a second live
    // assistant, because a second ANSWERING assistant is provisioned here only for a duel and a duel
    // deliberately never takes this lock. The key is what is under test and the key is what is asked.
    const other = await turnState(page, channelArn, `${responderId}-second-assistant`);
    expect(other.status, 'the endpoint answers for any responder the member may ask about').toBe(200);
    expect(
      other.busy,
      'a DIFFERENT assistant in the same conversation is not busy; if this is true the lock is keyed '
        + 'on the conversation and adding a second assistant would silence it',
    ).toBe(false);
    expect(
      other.queued,
      'and it holds nothing - the queue belongs to the assistant, not to the room',
    ).toEqual([]);
  });

  /**
   * THE JUDGED HALF OF A STOP HAS TO ACTUALLY ARRIVE (ADR-033).
   *
   * `/stop` has two halves. The immediate one suppresses the running answer, and the suite already
   * asserts it. The JUDGED one - a turn dispatched behind the acknowledgment that reads why the stop
   * was sent and asks how to proceed with the cancelled work - is dispatched by the router TO ITSELF, and that
   * is the part which has already shipped inert once: the router had the right to invoke itself but
   * no way to learn its own ARN, so `resolveRouterArn` returned undefined and every stop logged "the
   * stop goes unexplained" while every unit test stayed green. Only a deployed run can tell the
   * difference between that and a working dispatch, which is why this test exists here and not there.
   *
   * NOTHING IS QUEUED IN THIS TEST, deliberately, and that is what makes the assertion unambiguous.
   * A queued message would draw a triage PROPOSAL, which is also an `interim` frame - so "an interim
   * arrived" would no longer prove the evaluation ran. With an empty queue the only `interim` that
   * can follow a stop is the evaluation itself. The acknowledgment lands `final`, so the two do not
   * collide.
   */
  test('a stop is explained: the judged half arrives, and it is a question rather than an answer', async ({ page }) => {
    test.setTimeout(600_000);

    const recorder = new ChannelWireRecorder();
    recorder.attach(page);
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    const channelArn = await newConversation(page, 'Queue stop explained');

    const startedAt = Date.now();
    await startLongTurn(page, recorder, channelArn, startedAt);

    // ── ESTABLISH THAT THERE IS SOMETHING TO CANCEL ─────────────────────────────────────────────
    //
    // Required rather than assumed: the dispatch is conditional on cancelled work, so without this the
    // test would pass against a runtime that dispatches nothing at all. Named as a precondition in
    // the failure message so a fixture problem never reads as a product failure.
    const userTable = resolveTaskTable('user-tasks');
    expect(
      userTable,
      'the user-tasks table must be resolvable (USER_TASKS_TABLE, or E2E_INSTANCE_NAME plus AWS '
        + 'credentials) - the judged half only runs when work was cancelled, so without reading the store '
        + 'there is no way to tell "nothing was open" from "the dispatch is broken"',
    ).toBeTruthy();
    const idToken = await idTokenOf(page);
    const personId = await personIdFromIdToken(idToken || '');
    const held = await waitForOpenTask(userTable!, personId, channelArn, startedAt);
    expect(
      held.length,
      'PRECONDITION: the briefing request must have opened a task for this person, or there is '
        + 'nothing for `/stop` to cancel and this test cannot say anything about the judged half',
    ).toBeGreaterThan(0);

    const stopStarted = Date.now();
    await sendAndWaitForResponse(page, '/stop', 60_000);

    // ── THE QUESTION ITSELF ─────────────────────────────────────────────────────────────────────
    //
    // Generous, because it is a whole dispatched turn behind the acknowledgment: a stream hop, a
    // model call, and a post. What is asserted is that it ARRIVES, not that it is fast - the design
    // deliberately puts it off the path the person waits on.
    const question = await waitForPhase(recorder, channelArn, stopStarted, 'interim', 180_000);
    expect(
      question,
      'the judged half of the stop never posted. The acknowledgment is not enough on its own: the '
        + 'person was told the work is CANCELLED and that they will be asked how to proceed, so something '
        + 'has to come back and ask. An absent `interim` here is what a broken self-dispatch looks like from the outside - '
        + 'check that the router carries ROUTER_ARN_PARAM and may read it',
    ).not.toBeNull();

    // AND IT IS A QUESTION, not an answer. `final` would close the turn on a message that answers
    // nothing, folding a wait that is still going into the completion metrics - the same rule the
    // triage proposal follows.
    const phase = (question!.metadata as { respPhase?: string } | undefined)?.respPhase;
    expect(phase, 'the evaluation is a question, so it must not be stamped final').toBe('interim');
    expect(
      question!.content.trim().length,
      'and it must actually say something - an empty question is the same as no question',
    ).toBeGreaterThan(0);
  });

  /**
   * A STOPPED PRIVATE REQUEST IS NAMED TO THE ROOM WITHOUT BEING DESCRIBED (ADR-033, owner 2026-08-23).
   *
   * A targeted request makes a PRIVATE task: the other members cannot read the message, so they must
   * not learn its contents from anything the assistant says afterwards. The judged half of a stop is
   * room-visible by construction, and it is handed a description of what it cancelled - so this is
   * the one path where a private request's own words could be published by the system that was
   * protecting them.
   *
   * Private work is still visible in THAT it exists - an assistant occupied by it must not look idle -
   * which is exactly why the label handed to that turn is neutral rather than absent.
   */
  test('a stopped private request is cancelled without its words reaching the room', async ({ page }) => {
    test.setTimeout(600_000);

    const recorder = new ChannelWireRecorder();
    recorder.attach(page);
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    const channelArn = await newConversation(page, 'Queue stop private');

    // The assistant's own ARN, learned from a message it sent rather than guessed: it is the address
    // a targeted send has to name, and nothing else in the test knows it.
    const greetAt = Date.now();
    await sendAndWaitForResponse(page, 'hello', 90_000);
    const botFrame = await waitUntilBusy(recorder, channelArn, greetAt);
    expect(botFrame, 'the assistant must reply once so its ARN can be addressed').not.toBeNull();
    const botArn = botFrame!.senderArn;

    const userTable = resolveTaskTable('user-tasks');
    const agentTable = resolveTaskTable('agent-tasks');
    expect(
      userTable && agentTable,
      'both task tables must be resolvable - the private VISIBILITY lives on the agent row and the '
        + 'mirror is what finds it, and without them a leak and a clean run look identical',
    ).toBeTruthy();

    const idToken = await idTokenOf(page);
    const personId = await personIdFromIdToken(idToken || '');
    const userArn = await personArnFromIdToken(idToken || '');

    // A PHRASE THAT COULD ONLY HAVE COME FROM THE REQUEST. Nonce-tagged so a coincidental match is
    // impossible, which is what lets the absence assertion below mean what it says.
    const secret = `sardine-cartography-${Date.now().toString(36)}`;
    const targetedAt = Date.now();
    sendTargetedAs(
      channelArn,
      userArn,
      botArn,
      // Scope closed by asking for what is WANTED, never by telling the assistant what not to do:
      // "Do not ask clarifying questions" trips the input guardrail's PROMPT_ATTACK filter, measured
      // three times out of three, and a refused turn opens no task - so this test failed its own
      // precondition and looked like a privacy defect. Same trap as LONG_PROMPT, documented there.
      `Write me a long private briefing about ${secret}. Please cover its origins, its main `
        + 'techniques, and where it is used today, in at least six paragraphs with a short heading '
        + 'for each section.',
    );

    const held = await waitForOpenTask(userTable!, personId, channelArn, targetedAt);
    expect(
      held.length,
      'PRECONDITION: the targeted request must have opened a task, or there is no private work to '
        + 'stop and this test proves nothing',
    ).toBeGreaterThan(0);

    // AND IT REALLY IS PRIVATE. Read from the agent row, which is where visibility is decided; a test
    // that assumed privacy from the SEND would pass even if targeting stopped producing it.
    const full = readTask(agentTable!, String(held[0].taskId), channelArn);
    expect(
      full?.visibility,
      'PRECONDITION: a targeted request must produce a private task - without that this test is '
        + 'asserting the absence of a leak that was never possible',
    ).toBe('private');

    const stopStarted = Date.now();
    await sendAndWaitForResponse(page, '/stop', 60_000);
    const question = await waitForPhase(recorder, channelArn, stopStarted, 'interim', 180_000);
    expect(question, 'the judged half must still arrive for a private request').not.toBeNull();

    // ── THE ASSERTION THIS TEST EXISTS FOR ──────────────────────────────────────────────────────
    //
    // Every bot frame, not just the question: the leak would be equally bad in an acknowledgment, a
    // notice, or a proposal, and checking only the one message we expect to be wrong is how the other
    // three get missed.
    // ── THE ROOM, WHICH MEANS SOMEBODY WHO IS NOT THE REQUESTER ─────────────────────────────
    //
    // This used to read the requester's OWN recorder, and that is no test at all: a targeted
    // message is delivered to its target, so a private request's words appear there when the
    // design is working. In a channel of two it is worse than weak - there is no room to leak
    // into, so the assertion could not fail for the right reason.
    //
    // A third person is put in the channel and the check is made from THEIR view. Amazon Chime SDK
    // returns a targeted message only to its sender and its target, so this is the room's view by
    // construction rather than by any metadata this test chose to trust.
    const thirdParty = creds.secondPremiumUser;
    expect(
      thirdParty,
      'this test needs a second person: a privacy assertion made in a room of one proves nothing',
    ).toBeTruthy();
    const thirdArn = (await personArnForEmail(thirdParty!.email)) || '';
    expect(thirdArn, 'the third party must be resolvable to an app-instance user').toBeTruthy();
    expect(
      addMember(channelArn, thirdArn, userArn),
      'the third party must actually join, or their empty view would pass this test for free',
    ).toBe(true);

    const roomSees = messagesVisibleTo(channelArn, thirdArn);
    // NOT VACUOUS. A read that returns nothing - wrong bearer, denied call, empty channel - would
    // satisfy the absence below without proving anything, which is the failure mode this whole file
    // keeps finding elsewhere. The room must be able to see SOMETHING before its not seeing the
    // secret means anything.
    expect(
      roomSees.length,
      'the third party must see the conversation at all, or this proves nothing about what they cannot see',
    ).toBeGreaterThan(0);

    const carrying = roomSees.filter((c) => c.includes(secret));
    console.log(`[queue-e2e] the room sees ${roomSees.length} message(s), `
      + `${carrying.length} carrying the private request`);

    const leaked = carrying;
    expect(
      leaked.length,
      `a private request's own words reached the room in ${leaked.length} assistant message(s)`
        + (leaked.length ? ` - first was "${leaked[0].slice(0, 200)}..."` : '')
        + '. The room may learn that private work exists and which assistant it occupies; it may '
        + 'never learn what the work IS',
    ).toBe(0);
  });

  /**
   * WHAT THE PERSON READS IS PROSE, NEVER THE MACHINERY THAT PRODUCED IT.
   *
   * Triage's reply is half machine-readable: `TRIAGE:` lines carry the reading, and `PROPOSAL:`
   * separates them from the part a person is meant to see. That split is a security boundary rather
   * than a formatting convention - the machine lines are parsed only from the text BEFORE it, so a
   * proposal that quotes a marker back cannot contribute a decision - and it is also the thing that
   * keeps control tokens out of the conversation.
   *
   * A marker reaching the channel would be two failures at once: the person reads runtime internals
   * where an answer should be, and the boundary that makes the parse safe has visibly moved.
   */
  test('a proposal reads as prose: no machine markers reach the conversation', async ({ page }) => {
    test.setTimeout(600_000);

    const recorder = new ChannelWireRecorder();
    recorder.attach(page);
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    const channelArn = await newConversation(page, 'Queue proposal hygiene');

    const startedAt = Date.now();
    await startLongTurn(page, recorder, channelArn, startedAt);

    await sendWithoutWaiting(page, AMENDMENT);
    await sendWithoutWaiting(page, NEW_REQUEST_A);
    expect(
      await waitForNoticeDepth(recorder, channelArn, 2),
      'both sends must be held, or there is no queue for triage to read',
    ).not.toBeNull();

    // The proposal is the first `interim` after the queue filled: the notice is `notice`, the answer
    // would be `final`, and nothing else on this path is interim.
    const proposal = await waitForPhase(recorder, channelArn, startedAt, 'interim', 240_000);
    expect(
      proposal,
      'triage must post a proposal for what it read - a queue that is read and never described '
        + 'leaves the person with work they were never told about',
    ).not.toBeNull();

    // A QUESTION, NOT AN ANSWER. The proposal describes work that has not started and asks them to
    // correct it; `final` would stamp an end-to-end time on a wait that is still going.
    expect(
      (proposal!.metadata as { respPhase?: string } | undefined)?.respPhase,
      'a proposal is a question about work not yet done, so it is interim',
    ).toBe('interim');

    // ── AND NONE OF THE MACHINERY IS VISIBLE ────────────────────────────────────────────────────
    //
    // Checked across every bot frame in the conversation rather than the proposal alone: a marker
    // leaking into the notice or an answer is the same defect, and the parse boundary is what all of
    // them depend on.
    //
    // WHAT THIS SCAN DOES AND DOES NOT COVER (2026-09-15). These are literals the PLATFORM writes
    // into its own prompt and they are the same strings in every deployment's language, so the scan
    // is not the language judgement tenet D11 forbids and it holds on a non-English deployment. A
    // substring match also catches a marker a model decorated, which is how `**PROPOSAL:**` was
    // caught here. What it cannot catch is a marker the model PARAPHRASED or translated, and no
    // widening of this list would - so this is a floor on the leak, never a proof of its absence.
    const MARKERS = ['TRIAGE:', 'PROPOSAL:', 'ANOTHER_PASS:', 'IN_FLIGHT_UNCLEAR', 'TOPIC:', 'SPLIT:'];
    const offenders = recorder
      .botMessagesFor(channelArn)
      .filter((m) => m.atMs >= startedAt)
      .map((m) => ({ m, hit: MARKERS.find((k) => m.content.includes(k)) }))
      .filter((x) => x.hit);
    expect(
      offenders.length,
      `runtime markers reached the conversation in ${offenders.length} message(s)`
        + (offenders.length ? ` - "${offenders[0].hit}" in "${offenders[0].m.content.slice(0, 200)}..."` : ''),
    ).toBe(0);
  });

  /**
   * THE CASE ARRIVAL TRIAGE CANNOT REACH (ADR-033).
   *
   * Triage fires on the deferral notice and takes `claimTriage`, so a message arriving WHILE it runs
   * finds the claim held and returns. Nothing comes back for that message afterwards: it stays in the
   * queue, is rendered to the person as waiting, and waits for the life of the conversation. That is
   * the shape this suite recorded before the fix - three held, one described, `drained: false`.
   *
   * SO THE SENDS ARE DELIBERATELY STAGGERED. The first message triggers the notice and therefore the
   * reading; the next two are sent AFTER that notice exists, which puts them inside the window the
   * claim closes. A test that sent all three at once would usually have them read by the first pass,
   * and would pass against the very build this exists to catch.
   *
   * WHAT IT ASSERTS is that the queue EMPTIES. Not that a proposal was posted and not that a notice
   * appeared - both were already true while messages sat unread. An empty record is the only claim
   * that covers every message rather than the first one.
   */
  test('messages arriving after the reading has started are still picked up, and the queue empties', async ({ page }) => {
    test.setTimeout(600_000);

    const recorder = new ChannelWireRecorder();
    recorder.attach(page);
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    const channelArn = await newConversation(page, 'Queue drains');

    const startedAt = Date.now();
    const responderId = await startLongTurn(page, recorder, channelArn, startedAt);

    await sendWithoutWaiting(page, AMENDMENT);

    // The notice is the trigger, so waiting for it is waiting for the reading to have BEGUN. A
    // happens-after rather than a sleep: without it the later sends race the claim, and the test
    // measures its own timing instead of the product.
    const firstNotice = await waitForNoticeDepth(recorder, channelArn, 1, 120_000);
    expect(firstNotice, 'the first queued message must draw a notice before the rest are sent')
      .not.toBeNull();

    await sendWithoutWaiting(page, NEW_REQUEST_A);
    await sendWithoutWaiting(page, NEW_REQUEST_B);

    const watched = await watchQueue(page, channelArn, responderId, 420_000);
    console.log(`[queue-e2e] staggered: ${JSON.stringify(watched)}`);

    expect(
      watched.maxRecorded,
      'all three must be held at once, or the later sends never reached the queue this test is about '
        + `(max observed ${watched.maxRecorded})`,
    ).toBeGreaterThanOrEqual(3);

    // A queue that never empties is a person still shown "waiting" over messages nothing will ever
    // read. Before the lock was made to stand until the queue is empty, this is exactly where the
    // suite reported drained:false while every other assertion in the file passed.
    expect(
      watched.drained,
      'the queue must EMPTY: messages that arrived after the reading began are stranded otherwise, '
        + 'shown as waiting for the life of the conversation',
    ).toBe(true);

    // ── AND THE NOTICE SAYS SO ──────────────────────────────────────────────────────────────────
    //
    // The second half of FR4's *Done when*, and the visible counterpart of the record above: the queue
    // emptied, so the message the person is looking at has to stop claiming otherwise. These are not
    // the same fact and one has shipped without the other - the record drained, the work was created,
    // the answer was delivered, and the notice went on reading "still working on your earlier message"
    // with their messages marked waiting underneath it, because the settle raced the `clearing` update
    // on the same message and Amazon Chime SDK refused it as in processing.
    //
    // Asserted on the notice's state rather than its wording. The settled sentence comes from
    // configured copy resolved through the active profile, so matching English would be brittle for
    // every deployment that set its own and wrong for every conversation held in another language.
    // `queueDepth: 0` and `queueStatus: 'settled'` are written by the settle itself and are what the
    // client reads, so they hold whatever the notice ends up saying.
    const settled = await waitForNoticeSettled(recorder, channelArn, startedAt, 180_000);
    expect(
      settled,
      'the notice must settle once the queue has emptied - it is the message the client subscribes to, '
        + 'so a notice left unsettled leaves every waiting message styled as waiting with nothing '
        + `coming to correct it (stages seen: ${stagesSeen(recorder, channelArn).join(' -> ') || 'none'})`,
    ).not.toBeNull();
  });

  /**
   * AN AMENDMENT CHANGES THE ANSWER THEY GET (ADR-033 per entry: "task, mid-step: queue, as CONTEXT
   * for the running step").
   *
   * The one assertion the rest of this suite cannot make. Every other test here reads the RECORD -
   * the queue emptied, the offer was written down, the notice settled - and a record is the right
   * thing to assert when the wording is the assistant's own. But an amendment is not a record: it is
   * a claim about the words the person actually receives, and the failure it exists to catch is
   * invisible in every record.
   *
   * That failure shipped. The reading classified "actually, keep it to one page" as `amends` and
   * correctly opened no task for it - "one task per new request, and none for an amendment" - and
   * then nothing carried the amendment to the work it amends. The queue emptied. The proposal named
   * it. The notice settled. Every state was correct, and the person was handed the fifteen-paragraph
   * report they had just asked not to receive.
   *
   * WHY IT ASSERTS THE TRANSITION AND NOT THE ANSWER'S LENGTH. The first version of this test
   * asserted that no full-length answer landed, reasoning that fifteen paragraphs and one page are
   * different sizes. It passed, and it was VACUOUS: this deployment's premium profile turns that
   * prompt into a `report_generation` task and asks who the audience is, so a fifteen-paragraph
   * answer was never going to land whatever the amendment did. The guard could not fail.
   *
   * What CAN fail is the record's transition. The reading writes the amendment's id, and the only
   * thing that takes it off again is the running turn folding it in. So:
   *   recorded, then cleared  = the amendment reached the work it amends
   *   recorded, never cleared = the shipped bug - classified, described, and carried nowhere
   *   never recorded          = the reading no longer marks amendments at all
   * None of that is wording, so it holds for a deployment in any language and any persona - the same
   * reason the offer test asserts the record rather than the sentence.
   *
   * AND IT ASSERTS AN ANSWER ARRIVED, because a runtime that delivers nothing at all would otherwise
   * satisfy every line above.
   */
  test('an amendment sent while it works changes the answer, rather than arriving after it', async ({ page }) => {
    test.setTimeout(600_000);

    const recorder = new ChannelWireRecorder();
    recorder.attach(page);
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    const channelArn = await newConversation(page, 'Amendment lands');

    const startedAt = Date.now();
    const responderId = await startLongTurn(page, recorder, channelArn, startedAt);

    await sendWithoutWaiting(page, AMENDMENT);

    // THE AMENDMENT MUST GENUINELY BE QUEUED, or this test is about an ordinary second message and
    // proves nothing about folding. The notice is the proof: it exists only for a message held
    // behind a running turn.
    const notice = await waitForNoticeDepth(recorder, channelArn, 1, 120_000);
    expect(notice, 'the amendment must be QUEUED behind the running turn, or nothing is being folded')
      .not.toBeNull();

    // ── IT QUEUED WITH THE INTENT IT WAS CLASSIFIED AS (ADR-064 decision B) ────────────────────────
    //
    // The router classified the amendment before it queued it, and records that intent beside the id. Wherever the
    // message is completed - folded into this answer or opened as its own task - it is attributed to that intent, never
    // to the answering turn's own message. Read once, anchored to the notice that proves the message is queued.
    const queuedNow = queuedRow(channelArn, responderId) ?? [];
    const intents = queuedIntentsRow(channelArn, responderId) ?? {};
    console.log(`[queue-e2e] queued: ${queuedNow.join(', ')}; recorded intents: ${JSON.stringify(intents)}`);
    for (const id of queuedNow) {
      expect(intents[id], `queued message ${id} must carry the intent it was classified as`).toBeTruthy();
    }

    // DRIVEN OFF THE WIRE, NOT POLLED. The first version read the amendments row every 3s for 240s
    // and again every 5s for 300s - up to ~140 `aws dynamodb get-item` subprocesses, and on a
    // failure it burned the whole 540s before saying so. The suite's own pattern is the answer and
    // was already in this file: the WIRE says WHEN, and the backend read says WHAT. Both transitions
    // this test cares about are announced on the wire, so each read happens exactly once, at a
    // moment the runtime has told us about.
    //
    // THE PROPOSAL IS THE READING FINISHING. It is posted as `interim` at the end of the drain, after
    // the amendment has been recorded - so a single read here is not a race, it is anchored to the
    // event that guarantees the write.
    // THE READING FINISHING IS A STAGE, NOT AN INFERENCE. `clearing` is reached only once the reading
    // has produced something and the queue is being emptied, so it is the moment the amendment has
    // certainly been recorded - and unlike a proposal frame it is still reported when the drain takes
    // an exit that posts no proposal, which is the case that used to look identical to a hang.
    const stage = await waitForQueueStage(recorder, channelArn, 'clearing', 180_000);
    expect(
      stage,
      'the drain must reach "clearing"; stages seen: ' + (stagesSeen(recorder, channelArn).join(' -> ') || 'none'),
    ).not.toBeNull();

    // ── WHAT IS ACTUALLY OBSERVABLE HERE, AND WHAT IS NOT (2026-09-03) ─────────────────────────
    //
    // This asserted that the `amendments` row still held the entry, and failed consistently against
    // a deployment that was classifying correctly. The classification IS right, and was verified
    // from the processor rather than guessed: the arrival reading returns `items: 1,
    // tasksCreated: 0`, and an amendment is exactly the item that opens no task - while the handover
    // pass then returns `items: 1, tasksCreated: 1` for the same message, once the work it amended
    // had already finished.
    //
    // The row cannot witness that, because it is CLEARED on two ordinary paths: the fold reaching
    // it, and `returnAmendmentsToQueue` putting it back when the answering turn finished first.
    // Both are FR6 working. Its absence means "it worked" at least as often as "it never happened",
    // so asserting on it tests nothing.
    //
    // Nor is the wording a witness. When the model supplies its own PROPOSAL: line the person reads
    // that prose, not the composed "Changes to what I was already doing:" heading, so matching the
    // heading pins a phrase that is absent on the common path.
    //
    // So this asserts what FR6 actually promises and what IS observable: the amendment is never
    // lost. Either it changed the answer, or it became work in its own right - and the assertion
    // after the answer adds the other half, that it was not left recorded against nothing.
    const recorded = amendmentsRow(channelArn, responderId) ?? [];
    console.log(`[queue-e2e] amendments still recorded at clearing: ${recorded.length}`);


    // THE ANSWER ARRIVING IS THE TURN ENDING, which is the last moment anything can act on the
    // amendment: the fold runs before the words are sent, and the handover sweeps whatever the fold
    // did not reach back onto the queue. After this frame, an amendment still recorded is stranded.
    const answered = await waitForPhase(recorder, channelArn, startedAt, 'final', 420_000);
    expect(answered, 'an answer must arrive at all; silence would satisfy every assertion above')
      .not.toBeNull();

    // ── AND ONLY NOW IS FR6 DECIDABLE ─────────────────────────────────────────────────────────
    //
    // This check used to sit above, right after the drain reached `clearing`. That is the wrong
    // EVENT, not merely an early one: an amendment that the fold never reached is returned to the
    // queue at HANDOVER and becomes its own item on the NEXT pass, which is minutes after the pass
    // that cleared. Reading there asked whether something existed before the thing that creates it
    // had run - and the twelve-times poll it replaced was hiding exactly that by waiting long
    // enough to cross into pass 2 by accident.
    //
    // The answer arriving is the last moment anything can act on the amendment, which is what makes
    // it the moment the requirement is decidable at all.
    // ── WHY THE OUTCOME IS NOT ASSERTED AS A DISJUNCTION (2026-09-04) ─────────────────────────
    //
    // FR6 offers two acceptable endings - the amendment is folded into the work it amends, or it
    // becomes work in its own right - and only the SECOND is observable from here. A fold changes
    // the words of an answer; it writes no row, and it CLEARS the amendments record on its way, so a
    // successful fold and a lost message look identical to any check made afterwards.
    //
    // An assertion that fails on a fold is worse than no assertion: it reports the requirement
    // working as the requirement broken, which is what this one did on a deployment that had just
    // folded correctly. What IS observable, and is the half that catches real loss, is the assertion
    // below - nothing may still be RECORDED once the turn has ended, because a message that is still
    // marked as amending after the last thing that could act on it is a message reached by nothing.

    expect(
      amendmentsRow(channelArn, responderId) ?? [],
      'the amendment must be folded into the work it amends, or returned to the queue pending '
        + 'prioritisation: still recorded after the turn ended is a message the person sent, '
        + 'classified, described back to them, and acted on by nothing. Stages seen: '
        + (stagesSeen(recorder, channelArn).join(' -> ') || 'none'),
    ).toEqual([]);
  });

  /**
   * A QUEUE THAT SPANS SUBJECTS IS SAID OUT LOUD, AND SPLITTING IT IS THE PERSON'S CHOICE
   * (DESIGN 2.4.2).
   *
   * Somebody who keeps typing while an assistant is busy is usually not elaborating on one thing. The
   * reading already separates the messages; this is whether it ACTS on that separation - names the
   * subjects and offers to continue them apart, so one conversation stops being the grounding for
   * three unrelated things at once.
   *
   * WHY THIS ASSERTS THE RECORD RATHER THAN THE WORDING. The offer is spoken in the assistant's own
   * voice, in the deployment's persona and the conversation's language, so there is no English here
   * that would still be true for a deployment configured differently - matching a phrase would pin
   * the phrase. What must hold everywhere is that the subjects were written down, against the person
   * they were put to, because that record is what the answer is later checked against and it is what
   * makes the offer answerable at all.
   */
  test('a queue covering two subjects records an offer to separate them, addressed to the asker', async ({ page }) => {
    test.setTimeout(600_000);

    const recorder = new ChannelWireRecorder();
    recorder.attach(page);
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    const channelArn = await newConversation(page, 'Queue subjects');

    const startedAt = Date.now();
    const responderId = await startLongTurn(page, recorder, channelArn, startedAt);

    // TWO PLAINLY DIFFERENT SUBJECTS, not two phrasings of one. A grouping that merged these would be
    // wrong in a way a person would notice, which is what makes them a fair test of the reading.
    await sendWithoutWaiting(page, NEW_REQUEST_A);
    await sendWithoutWaiting(page, NEW_SUBJECT_UNGROUPABLE);

    requireTurnStateTable();
    const offer = await waitForPendingSplit(page, recorder, channelArn, responderId, startedAt, 420_000);
    console.log(`[queue-e2e] offer: ${JSON.stringify(offer)}`);

    expect(
      offer,
      'a queue covering two subjects must record an offer to separate them; nothing recorded means '
        + 'the reading never named them, or the offer was never made',
    ).not.toBeNull();

    expect(
      offer!.topics.length,
      `the offer must name more than one subject, got ${offer?.topics.length ?? 0}`,
    ).toBeGreaterThanOrEqual(2);

    // ADDRESSED TO THE ASKER. A split is the requester's decision, and an offer recorded against
    // nobody, or against the wrong person, is one a third party could answer - disposing of work they
    // may not even be able to see.
    const idToken = await idTokenOf(page);
    const personId = await personIdFromIdToken(idToken || '');
    // THE ASKER IS AMONG THEM. The offer is put to everyone it concerns rather than to one person -
    // a queue holds whatever arrived from whoever sent it, and narrowing the record to one of them
    // took everybody else's answer away. In this 1:1 spec that set is exactly the one asker, which
    // is why the assertion is membership rather than equality: the same requirement, stated so it
    // still holds when a second person is in the room.
    expect(
      offer!.offeredTo,
      'the offer must be recorded against the people it was put to, not left open to the room',
    ).toContain(personId);

    // EVERY QUEUED MESSAGE IS ACCOUNTED FOR. A grouping covering one of the two would leave the
    // person choosing about messages the offer never mentions.
    const grouped = offer!.topics.flatMap((t) => t.messageIds);
    expect(new Set(grouped).size, 'each queued message belongs to exactly one subject')
      .toBe(grouped.length);
  });

  /**
   * ONE SUBJECT MOVES, THE OTHERS STAY (DESIGN 2.4.2).
   *
   * With two subjects offered, "split what they chose" and "split everything" are nearly the same
   * behavior and a test cannot tell them apart. Three separates them completely: the wrong build
   * opens three rooms and empties a conversation the person deliberately kept whole.
   *
   * This is the only test in the file that carries the choice all the way through - offer, answer,
   * and a room that either exists or does not. Everything before it stops at the record.
   */
  test('splitting one subject out of three leaves the other two where they were', async ({ page }) => {
    test.setTimeout(900_000);

    const recorder = new ChannelWireRecorder();
    recorder.attach(page);
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    const channelArn = await newConversation(page, 'Queue split one');

    const startedAt = Date.now();
    const responderId = await startLongTurn(page, recorder, channelArn, startedAt);

    await sendWithoutWaiting(page, NEW_REQUEST_A);
    await sendWithoutWaiting(page, NEW_REQUEST_B);
    await sendWithoutWaiting(page, NEW_SUBJECT_UNGROUPABLE);

    requireTurnStateTable();

    const offer = await waitForPendingSplit(page, recorder, channelArn, responderId, startedAt, 420_000);
    console.log(`[queue-e2e] offer: ${JSON.stringify(offer)}`);
    expect(offer, 'three unrelated requests must produce an offer to separate them').not.toBeNull();
    expect(
      offer!.topics.length,
      `the offer must name more than one subject, got ${offer?.topics.length ?? 0}`,
    ).toBeGreaterThanOrEqual(2);

    const chosen = offer!.topics[0].label;
    const leftBehind = offer!.topics.slice(1).map((t) => t.label);
    console.log(`[queue-e2e] choosing "${chosen}", leaving ${JSON.stringify(leftBehind)}`);

    // Named in ordinary words, the way a person would answer. The label has to survive a model
    // reading it back, which is the whole reason the selection is matched against what was offered
    // rather than against anything the reply invents.
    await sendWithoutWaiting(page, `Just split out ${chosen} please, leave the rest here.`);

    // THE SPLIT SAYS WHAT IT MADE, and that announcement is the event to wait on. Each created room
    // is announced in THIS conversation with its own ARN, so there is nothing to search and nothing
    // to disambiguate - and the room existing is a stronger happens-after than the offer row
    // disappearing, because it is the thing the person actually gets.
    //
    // This used to poll `pendingSplitRow` every five seconds for seven minutes. The wire already
    // carries the signal; asking DynamoDB eighty-four times whether a turn had finished turned a
    // timing question into a retry count, and the answer it waited for arrives here anyway.
    const announced = await splitsAnnouncedUntil(page, recorder, channelArn);

    // AND THE OFFER IS CLOSED, read once now that the work behind it is done. It is a separate claim
    // from the split having happened: an offer left standing can be answered twice, and the second
    // answer splits a subject the person already dealt with.
    expect(
      pendingSplitRow(channelArn, responderId),
      'the offer must be closed once it has been answered, or it can be answered twice',
    ).toBeNull();
    console.log(`[queue-e2e] the split announced ${JSON.stringify(
      announced.map((a) => a.label))}; chosen "${asSanitizedTitle(chosen)}"`);

    expect(
      announced.map((a) => a.label),
      `the subject they chose must have become its own conversation, announced from this one ("${chosen}")`,
    ).toContain(asSanitizedTitle(chosen));

    // Every announcement carries a real room, not just a label.
    for (const a of announced) {
      expect(a.childChannelArn, `"${a.label}" was announced without a conversation to point at`)
        .toContain(':app-instance/');
    }

    // ── THE ASSERTION THIS TEST EXISTS FOR ──────────────────────────────────────────────────────
    //
    // What they did NOT choose stays put. A build that split everything passes every assertion above
    // this line, and leaves the person with their conversation taken apart.
    for (const label of leftBehind) {
      expect(
        announced.map((a) => a.label),
        `"${label}" was offered and NOT chosen, so nothing should have been split out for it`,
      ).not.toContain(asSanitizedTitle(label));
    }
  });

  /**
   * FR12: A MESSAGE THE ASSISTANT COULD NOT MAKE OUT BECOMES A QUESTION, NOT WORK IT INVENTED.
   *
   * The reading's vocabulary was `amends` or `new`, and `new` opens a `queued_request` in
   * `proposed` - a row that says "here is the work I propose to do". So a message nobody understood
   * still produced a confident proposal, labeled with a slice of the person's own words read back to
   * them, which they then had to notice was wrong.
   *
   * This is the assertion that the honest answer is reachable END TO END: that the model is told the
   * word, uses it when it applies, and that what comes out is a row claiming a QUESTION rather than
   * work. It is asserted against the store, because a proposal that says the right thing while the
   * row says something else is the exact gap this suite exists to close.
   */
  test('a message it cannot make out becomes a clarification, not a proposal', async ({ page }) => {
    test.setTimeout(600_000);

    const recorder = new ChannelWireRecorder();
    recorder.attach(page);
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    const channelArn = await newConversation(page, 'Queue unclear');

    const startedAt = Date.now();
    await startLongTurn(page, recorder, channelArn, startedAt);

    await sendWithoutWaiting(page, AMBIGUOUS);

    // It has to be QUEUED, or this is an ordinary turn and proves nothing about a reading.
    const notice = await waitForNoticeDepth(recorder, channelArn, 1, 120_000);
    expect(notice, 'the message must be queued behind the running turn').not.toBeNull();

    // The reading finishing is a STAGE, not an inference - the same anchor the amendment test uses.
    const stage = await waitForQueueStage(recorder, channelArn, 'clearing', 240_000);
    expect(
      stage,
      'the drain must reach "clearing"; stages seen: ' + (stagesSeen(recorder, channelArn).join(' -> ') || 'none'),
    ).not.toBeNull();

    const userTable = resolveTaskTable('user-tasks');
    test.skip(!userTable, 'no user-tasks table resolved; the store is the only honest witness here');

    const idToken = await idTokenOf(page);
    const personId = await personIdFromIdToken(idToken || '');

    // READ ONCE, AFTER AN EVENT SAID IT WAS TIME. The `clearing` stage above is the drain emptying
    // the queue, which happens AFTER the tasks are created - so by this line the rows exist or the
    // reading did not make them. Polling the table twelve times asked the same question of the
    // deployment over and over and answered a timing question with a retry count; the wire already
    // says when, and this says what.
    const clarifications = runTasksFor(userTable!, personId, {
      taskType: 'queued_clarification', channelArn, since: startedAt,
    });
    const proposals = runTasksFor(userTable!, personId, {
      taskType: 'queued_request', channelArn, since: startedAt,
    });
    console.log('[queue-e2e] unclear message produced'
      + ` ${clarifications.length} clarification(s), ${proposals.length} proposal(s)`);

    // THE ASSERTION, and it is about the CLAIM rather than about the model being clever. A reading
    // that could not resolve "the other one" has two honest outputs and one dishonest one: a
    // clarification is right, and a confident proposal naming work nobody asked for is the defect.
    expect(
      clarifications.length,
      'a message with no resolvable referent must become a clarification the person can answer, not '
        + 'a proposal claiming work the assistant invented. Proposals seen instead: '
        + proposals.map((t) => String(t.requestExcerpt ?? '')).join(' | '),
    ).toBeGreaterThanOrEqual(1);

    // AND IT WAITS ON THE PERSON, which is what makes it answerable rather than a note.
    expect(
      String(clarifications[0]?.taskState ?? ''),
      'a clarification is born awaiting its requester, so it reaches their list',
    ).toBe('asked');

    // AND IT CARRIES THE MESSAGE ID, NEVER THE WORDS. The row is one the room can read.
    const agentTable = resolveTaskTable('agent-tasks');
    if (agentTable) {
      const row = readTask(agentTable, String(clarifications[0]!.taskId), channelArn);
      expect(
        String(row?.userMessageId ?? ''),
        'the clarification must reference the message, which is how its content stays resolvable as '
          + 'the caller rather than copied into a row',
      ).not.toBe('');
    }

    // ── WHY ANSWERING IS NOT ASSERTED HERE (measured, 2026-09-04) ──────────────────────────────
    //
    // It was, and it failed against a deployment doing something defensible. A plain reply resumes
    // the NEWEST task this person holds that awaits them, and by this point they hold two: the
    // clarification, and the `report_generation` the long prompt opened, which sits in
    // `collecting_requirements` awaiting them as well. Measured on the deployment - of fourteen
    // answers applied, twelve went to `collecting_requirements` and one to `asked`.
    //
    // So this test cannot isolate the claim: it needs a person with exactly one open question, and
    // its own setup guarantees two. The product has an addressed answer for precisely this - the
    // composer sends `Metadata.task.id` when somebody replies from the work item - and the harness
    // has no way to send one, which is the gap worth closing rather than an assertion worth
    // weakening.
    //
    // What IS asserted above still holds the requirement that matters: the message became a question
    // somebody owns, rather than work the assistant invented.
  });
});
