/**
 * A PRIVATE `/stop` IN A ROOM IS REFUSED, AND NOTHING IS STOPPED.
 *
 * A stop halts the assistant for EVERYBODY in the conversation. Sent privately, the room watches the
 * assistant go quiet with nothing to say why - so the router refuses a private stop before anything
 * is stopped, and the refusal inherits the private message's targeting so it reaches only the sender.
 *
 * WHY THIS SPEC EXISTS RATHER THAN A CASE IN `turn-queue.spec.ts`. The refusal is inert everywhere
 * that suite runs. It fires on two conditions together - the message reached the Lex entry rather
 * than the channel flow (so it carried a Target, which is what makes it private), and the room is
 * not a 1:1 - and `turn-queue` is 1:1 by design. A 1:1 has no room to hide from, so a private stop
 * there PROCEEDS, and asserting the refusal in that shape would assert the opposite of the rule.
 *
 * WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT. The refusal wording is this deployment's configured
 * copy in this conversation's language (`stopMustBePublic`, tenets P5 and D11), so there is no
 * English here to match on that would still hold for a deployment configured with another voice. The
 * three claims are structural instead:
 *
 *   1. a reply came back to the sender, and the turn WAS STILL RUNNING when it did - which is what
 *      "refused before anything is stopped" means, and the only ordering that distinguishes a refusal
 *      from a stop that worked;
 *   2. the room cannot see that reply, read as a different member rather than inferred from metadata;
 *   3. the work went on to finish. A stopped turn posts no answer, so the answer arriving IS the
 *      proof that nothing was stopped - the assertion the other two only set up. Finished is read from
 *      the phase the processor declares on the answer (`respPhase: 'final'`), never from its length.
 */
import { test, expect } from './helpers/fixtures';
import { getTestCredentials, hasTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { openGroupConversation, closeGroup, type GroupConversation } from './helpers/group-conversation';
import { assistantArnIn, messageRowsVisibleTo } from './helpers/third-party-view';
import { holderOf, resolveTurnStateTable, sendTargetedAs } from './helpers/turn-state-record';
import { awsv } from './helpers/aws';

guardConsoleErrors();

const RUN = process.env.PRIVATE_STOP_E2E === '1';

/**
 * The long prompt exists to make the assistant BUSY and to KEEP it busy.
 *
 * Both halves matter here in a way they do not for a queue test. A stop needs work in flight to be
 * refused "before anything is stopped", and the answer arriving afterwards is this spec's central
 * assertion - so a prompt the assistant finishes in a few seconds would leave both unobservable.
 *
 * A QUESTION, NOT A REQUEST FOR A DOCUMENT. A report request opens a task whose first turn asks one
 * clarifying question and ends in seconds, so the long answer never comes. Headings and sections read as
 * a report, and so does "a thorough walkthrough ... in about fifteen paragraphs": measured live, that
 * prompt was classified as a report request, its turn finished on a short clarifying question, and a
 * wait for a long answer could never be met. This one asks why something happens and what each party
 * can do about it, which is answered in the conversation and at length without being asked for a length.
 *
 * AND ON THE DEPLOYMENT'S OWN SUBJECT. The input guardrail of an internal assistant refuses an off-topic
 * request before any model call, which also ends the turn in about a second: a history-of-printing
 * prompt was blocked that way. So is phrasing that instructs the assistant how to respond ("no report or
 * document please"), which the prompt-attack filter scored MEDIUM and blocked. A plain on-topic question
 * passes (checked with ApplyGuardrail against the deployed guardrail).
 */
const LONG_PROMPT =
  'Why do so many new hires at a mid-sized company feel lost during their first few months, and what '
  + 'could their manager, their teammates, IT and HR each do differently at every stage from the signed '
  + 'offer through the end of the first quarter?';

const isBot = (arn: string): boolean => arn.includes('/bot/');

/**
 * The assistant's messages this member can see, with the phase each one declares.
 *
 * `respPhase` is the processor's own statement of where a turn stands: `final` closes it, a clarifying
 * question is `interim`, and a stopped turn is `cancelled`. So `final` on the turn's message is what
 * "the work finished, unstopped" means, and it holds for any answer length and any language.
 *
 * `answersMessageId` is the message the turn declares it answers, so the answer to one prompt is
 * found by that declaration rather than by being the most recent assistant message.
 */
function assistantMessagesWithPhase(channelArn: string, memberArn: string): Array<{
  messageId: string; lastUpdatedAt: string; phase?: string; answersMessageId?: string;
}> {
  try {
    const r = awsv(['chime-sdk-messaging', 'list-channel-messages',
      '--channel-arn', channelArn, '--chime-bearer', memberArn, '--max-results', '50']);
    return (r?.ChannelMessages || [])
      .filter((m: any) => isBot(String(m?.Sender?.Arn || '')))
      .map((m: any) => {
        let phase: string | undefined;
        let answersMessageId: string | undefined;
        try {
          const meta = m?.Metadata ? JSON.parse(String(m.Metadata)) : {};
          phase = typeof meta?.respPhase === 'string' ? meta.respPhase : undefined;
          answersMessageId = typeof meta?.answersMessageId === 'string' ? meta.answersMessageId : undefined;
        } catch {
          phase = undefined;
        }
        return {
          messageId: String(m?.MessageId || ''),
          lastUpdatedAt: String(m?.LastUpdatedTimestamp || m?.CreatedTimestamp || ''),
          phase,
          answersMessageId,
        };
      });
  } catch {
    return [];
  }
}

test.describe.serial('a private /stop in a room', () => {
  guardBackendErrors('private-stop');
  test.skip(!RUN, 'set PRIVATE_STOP_E2E=1 (runs via validate.mjs --only=private-stop)');

  let creds: TestCredentials;
  let group: GroupConversation | null = null;

  test.beforeAll(async () => {
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    creds = await getTestCredentials();
    expect(
      resolveTurnStateTable(),
      'the turn-state table must be resolvable (TURN_STATE_TABLE, or E2E_INSTANCE_NAME plus AWS '
      + 'credentials) - the holder is how this spec knows the turn was still running when the refusal '
      + 'landed, and without it a refusal and a successful stop look identical',
    ).toBeTruthy();
  });

  test.afterAll(async () => { await closeGroup(group); });

  test('is refused before anything is stopped, only the sender sees it, and the work finishes', async ({ page }) => {
    test.setTimeout(420_000);

    // THREE PEOPLE, which is the whole precondition. At two the room is a 1:1, where a private stop
    // is allowed to proceed - the test would then be asserting the rule backwards.
    const second = creds.secondPremiumUser?.password ? creds.secondPremiumUser : creds.standardUser;
    expect(second.email, 'a second distinct person is required').not.toBe(creds.premiumUser.email);

    group = await openGroupConversation({
      page,
      creator: creds.premiumUser,
      others: [second],
      title: `Private stop ${Date.now()}`,
    });
    expect(group, 'the group conversation could not be assembled').toBeTruthy();
    const { channelArn, creator, others } = group!;
    const bystander = others[0];

    // FROM THE MEMBERSHIP, not from a reply. In a group a plain message is not routed to the
    // assistant at all, so waiting for one to learn the address you have to address is circular.
    const botArn = assistantArnIn(channelArn, creator.arn);
    expect(botArn, 'the conversation has no assistant member to address').toBeTruthy();
    const responderId = botArn.split('/').pop() || '';

    // MAKE IT BUSY. Targeted, which is the same wire shape `@<assistant>` produces in a room, without
    // a dropdown interaction in the middle of a timing test. Not waited on, by design.
    const promptId = sendTargetedAs(channelArn, creator.arn, botArn, LONG_PROMPT);
    expect(promptId, 'the long prompt was not sent').toBeTruthy();

    // WAIT FOR THE LOCK, not for a clock. Too early and no turn is running; too late and it has
    // finished. Both leave nothing for the stop to be refused in front of, and both look the same
    // afterwards.
    let held = '';
    for (let i = 0; i < 30 && !held; i += 1) {
      held = holderOf(channelArn, responderId);
      if (!held) await page.waitForTimeout(2_000);
    }
    expect(held, 'the long prompt never took the conversation, so there was no work to refuse to stop').toBeTruthy();

    const before = new Set(messageRowsVisibleTo(channelArn, creator.arn).map((m) => m.messageId));

    // THE PRIVATE STOP. Targeted at the assistant, so it reaches the Lex entry rather than the
    // channel flow - which is exactly what the router reads as "sent privately".
    const stopSentAt = Date.now();
    sendTargetedAs(channelArn, creator.arn, botArn, '/stop');
    console.log(`[private-stop] private /stop sent in ${channelArn} while ${held} held the turn`);

    // The refusal is decided before any model call, so it is fast - but it is polled for rather than
    // timed, because a deployment being slow is not the same as a deployment being wrong.
    let refusal: { messageId: string; content: string; createdAt: string } | null = null;
    let heldAtRefusal = '';
    for (let i = 0; i < 30 && !refusal; i += 1) {
      const fresh = messageRowsVisibleTo(channelArn, creator.arn)
        .filter((m) => !before.has(m.messageId) && isBot(m.senderArn));
      if (fresh.length) {
        refusal = fresh[fresh.length - 1];
        // READ IN THE SAME ITERATION the reply was found, not after the assertions below. The claim
        // is about the ORDER of two events, so a holder read later would be answering a different
        // question - whether the turn had finished by then, which is not in dispute.
        heldAtRefusal = holderOf(channelArn, responderId);
        break;
      }
      await page.waitForTimeout(2_000);
    }
    expect(refusal, 'a private /stop must be answered - silence is indistinguishable from the stop '
      + 'not reaching the assistant at all').toBeTruthy();
    console.log(`[private-stop] reply ${refusal!.messageId} (${refusal!.content.length} chars), holder now "${heldAtRefusal}"`);

    // (1) REFUSED BEFORE ANYTHING IS STOPPED is asserted below, once the answer exists, from recorded
    // instants. The holder read above is logged only: it is taken when this loop happens to OBSERVE the
    // reply, and on a live run the refusal was posted 1.7s before the turn released while the poll saw the
    // conversation already free, which failed a correct refusal as a lost precondition.

    // The refusal is a configured line, so it is asserted as present rather than as wording, which holds
    // for any deployment's copy and any language. It cannot be the answer to the prompt in flight: that
    // answer is the placeholder posted before the stop, and the refusal is a message posted after it.
    expect(refusal!.content.trim().length, 'the refusal must actually say something').toBeGreaterThan(0);

    // (2) THE ROOM CANNOT SEE IT. Read AS the bystander, which is the room's view by construction:
    // Amazon Chime SDK returns a targeted message only to its sender and its target, so if the id
    // comes back from this call it is genuinely in the room, whatever any metadata says.
    const roomSees = messageRowsVisibleTo(channelArn, bystander.arn).map((m) => m.messageId);
    expect(roomSees,
      "the refusal inherits the private stop's targeting, so a third member must not receive it")
      .not.toContain(refusal!.messageId);

    // (3) NOTHING WAS STOPPED - the assertion the other two set up. A stopped turn posts no answer,
    // so the answer to the long prompt arriving is the proof, and it is the only one that does not
    // depend on reading the assistant's words.
    // THE ANSWER IS THE PLACEHOLDER IT WAS POSTED AS, updated in place. That message existed before the
    // stop was sent, so it is found by being FINISHED after the stop rather than by being new, and
    // finished is the `final` phase the processor declares when it closes the turn.
    // IT IS THE ANSWER TO THE LONG PROMPT, by declaration: the turn names the message it answers in
    // `answersMessageId`, and that is the only identity this check accepts. A late welcome, a join recap
    // or any other assistant message finishing after the stop answers something else, so it cannot stand
    // in for the work that had to survive.
    let answer: { messageId: string; lastUpdatedAt: string; phase?: string } | null = null;
    let lastSeen: Array<{ messageId: string; phase?: string; answersMessageId?: string }> = [];
    for (let i = 0; i < 60 && !answer; i += 1) {
      const settled = assistantMessagesWithPhase(channelArn, creator.arn)
        .filter((m) => m.messageId !== refusal!.messageId
          && Date.parse(m.lastUpdatedAt) >= stopSentAt - 1_000);
      lastSeen = settled;
      const finished = settled.filter((m) => m.phase === 'final' && m.answersMessageId === promptId);
      if (finished.length) { answer = finished[finished.length - 1]; break; }
      // A STOPPED TURN IS STAMPED `cancelled`, and that is the failure this spec exists to catch, so it
      // ends the wait rather than running out the clock on an answer that will never come. Only the
      // turn's own message counts: one that declares the prompt, or a placeholder already present
      // before the stop that declares nothing else.
      const ownTurn = (m: { messageId: string; answersMessageId?: string }): boolean =>
        m.answersMessageId === promptId || (before.has(m.messageId) && !m.answersMessageId);
      if (settled.some((m) => m.phase === 'cancelled' && ownTurn(m))) break;
      await page.waitForTimeout(5_000);
    }
    expect(answer,
      `the work in flight must survive a refused stop. No answer to the long prompt (${promptId}) `
      + 'finished after the refusal, which means the private stop cancelled the turn it was supposed to '
      + 'be refused for (assistant messages updated since the stop, with their phases and what each '
      + `answers: ${JSON.stringify(lastSeen)})`)
      .toBeTruthy();
    console.log(`[private-stop] answer ${answer!.messageId} finished (${answer!.phase}); nothing was stopped`);

    // (1) THE REFUSAL CAME WHILE THE WORK WAS STILL RUNNING. The answer's last update is when its text was
    // finished, so a refusal created before it was sent to a turn still in flight - and (3) shows that turn
    // went on to finish. Both instants are Amazon Chime SDK's own, so the order does not depend on when this
    // test looked.
    const refusedAt = Date.parse(refusal!.createdAt);
    const finishedAt = Date.parse(answer!.lastUpdatedAt);
    expect(Number.isFinite(refusedAt) && Number.isFinite(finishedAt), 'both instants must be readable').toBe(true);
    expect(refusedAt,
      'the refusal was created after the answer was finished, so this run cannot tell a refusal apart from '
      + 'a stop that arrived once the work was already done')
      .toBeLessThan(finishedAt);
  });
});
