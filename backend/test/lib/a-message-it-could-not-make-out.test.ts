/**
 * "I HAVE IT, AND I CANNOT TELL WHAT IT ASKS FOR" (maintainer, 2026-09-03).
 *
 * The reading's vocabulary was `amends` or `new`, and nothing else. Every queued message was forced
 * to be one of them - and `new` opens a `queued_request` in `proposed`, which is a row that says
 * "here is the work I propose to do".
 *
 * So a message nobody understood produced a CONFIDENT PROPOSAL, labeled with a slice of the person's
 * own words read back to them. They had to notice it was wrong, and until they did, a task nobody
 * could act on sat in their list looking like agreed work. A clear "I could not make this out" placeholder
 * needs a word in the vocabulary to exist.
 *
 * `unclear` is that word, and `queued_clarification` is what it opens. The distinction is not
 * cosmetic: one machine starts by proposing WORK, the other starts by asking a QUESTION, and which
 * one a person sees decides whether they are correcting a wrong guess or answering a straight ask.
 */

const mockCreateTask = jest.fn();

jest.mock('../../lambda/src/lib/task-store.js', () => ({
  createTask: (...a: unknown[]) => mockCreateTask(...a),
}));

import {
  parseTriageProposal, createTasksFromProposal, buildProposalMessage,
  QUEUED_REQUEST_TASK_TYPE, QUEUED_CLARIFICATION_TASK_TYPE, triageContractDirective, deriveTriageProposal,
  type ProposedItem,
} from '../../lambda/src/lib/turn-triage-proposal';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { ownWords } from '../helpers/own-templates';

const CHANNEL = 'arn:aws:chime:us-east-1:123456789012:app-instance/i/channel/c1';
const SENDER = 'arn:aws:chime:us-east-1:123456789012:app-instance/i/user/u1';
const M1 = 'msg-0000-1111';
const M2 = 'msg-0000-2222';

const item = (over: Partial<ProposedItem>): ProposedItem => ({
  messageId: M1, intent: 'new', label: 'a thing', priority: 'normal', ...over,
} as ProposedItem);

/** The task types created, in order. */
const typesCreated = () => mockCreateTask.mock.calls.map((c) => c[2]);

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateTask.mockResolvedValue({ taskId: 't' });
});

describe('the reading can say it could not tell', () => {
  it('accepts "unclear" as an intent, alongside amends and new', () => {
    const parsed = parseTriageProposal(
      `TRIAGE: ${M1} | unclear | normal | what "the usual" refers to\nPROPOSAL: ok`,
      [M1],
    );

    expect(parsed?.items[0]?.intent).toBe('unclear');
  });

  it('offers the word to the model, with the rule for using it', () => {
    // A vocabulary the model is never TOLD about is one it never uses, and that failure looks exactly
    // like the model choosing not to use it - so the contract handed to the model is asserted, not
    // just the parser that would accept the answer.
    const directive = triageContractDirective([M1]);

    expect(directive).toContain('<amends|new|unclear>');
    // And the rule, because the word alone invites it as a way out of a hard message rather than an
    // honest answer about one.
    expect(directive).toMatch(/do not\s+guess/i);
  });
});

describe('what an unclear message becomes', () => {
  it('opens a CLARIFICATION, not a proposal', async () => {
    // The whole point. `proposed` claims the work is understood and agreed enough to name.
    await createTasksFromProposal({
      proposal: { items: [item({ intent: 'unclear' })], inFlightAmbiguous: false },
      channelArn: CHANNEL, senderArn: SENDER, assistantId: 'bot', hasWorkInFlight: false,
    } as never);

    expect(typesCreated()).toEqual([QUEUED_CLARIFICATION_TASK_TYPE]);
  });

  it('leaves an understood message as an ordinary queued request', async () => {
    await createTasksFromProposal({
      proposal: { items: [item({ intent: 'new' })], inFlightAmbiguous: false },
      channelArn: CHANNEL, senderArn: SENDER, assistantId: 'bot', hasWorkInFlight: false,
    } as never);

    expect(typesCreated()).toEqual([QUEUED_REQUEST_TASK_TYPE]);
  });

  it('gets a task even while work is in flight, when an ordinary amendment would not', async () => {
    // `amends` folds into the running work and opens nothing. An unclear message cannot fold into
    // anything - nobody knows what it is - so it must not be swallowed by that rule and lost.
    await createTasksFromProposal({
      proposal: {
        items: [item({ messageId: M1, intent: 'amends' }), item({ messageId: M2, intent: 'unclear' })],
        inFlightAmbiguous: false,
      },
      channelArn: CHANNEL, senderArn: SENDER, assistantId: 'bot', hasWorkInFlight: true,
    } as never);

    expect(typesCreated()).toEqual([QUEUED_CLARIFICATION_TASK_TYPE]);
  });
});

describe('what the person is told', () => {
  it('lists the unclear messages APART from the work it understood', async () => {
    // Mixed into the proposed list they would read as agreed work nobody agreed, which is the
    // confident guess this exists to end.
    const message = buildProposalMessage({
      items: [item({ messageId: M1, intent: 'new', label: 'the Q3 headcount' }),
        item({ messageId: M2, intent: 'unclear', label: 'which report "the usual" means' })],
      inFlightAmbiguous: false,
    } as never, []);

    expect(message).toContain('the Q3 headcount');
    expect(message).toContain('which report "the usual" means');
    // The unclear line is introduced by its own heading rather than appearing in the numbered plan.
    expect(message).toMatch(/could not tell what they are asking for/i);
  });

  it('lets a deployment word that heading itself', () => {
    // MIXED DELIBERATELY. A proposal whose items are ALL unclear is a whole-reading failure, and that
    // says so in its opening line instead - so a single unclear item cannot exercise this heading at
    // all. The first version of this test used one and passed against the wrong string.
    const message = buildProposalMessage({
      items: [item({ messageId: M1, intent: 'new', label: 'the Q3 headcount' }),
        item({ messageId: M2, intent: 'unclear', label: 'x' })],
      inFlightAmbiguous: false,
    } as never, [], { copy: ownWords({ queuedUnclear: 'Ich verstehe diese nicht:' }) } as never);

    expect(message).toContain('Ich verstehe diese nicht:');
  });
});

describe('the clarification machine', () => {
  it('starts by awaiting the person, because the answer is the whole task', () => {
    const m = DEFAULT_TASK_STATE_MACHINES.queued_clarification;

    expect(m.initial).toBe('asked');
    expect(m.states.asked.awaits).toEqual({ party: 'requester' });
  });

  it('treats both endings as real, so dropping is a decision and not a fault', () => {
    const m = DEFAULT_TASK_STATE_MACHINES.queued_clarification;

    expect(m.states.answered.terminal).toBe('success');
    expect(m.states.dropped.terminal).toBe('handoff');
  });
});

/**
 * A WHOLE READING THAT FAILED SAYS SO (maintainer, 2026-09-03).
 *
 * The derived floor runs when the judged reading was UNUSABLE - nothing was understood about any of
 * these messages. It marked every one `new` anyway, so a reading that understood nothing produced the
 * most confident output this path can make: one "here is the work I propose to do" per message,
 * labeled with a slice of the person's own words.
 *
 * FR10 is unchanged by this and still satisfied. The queue still always drains and every message
 * still becomes a durable owned item. What changed is what that item CLAIMS.
 */
describe('when the whole reading failed', () => {
  it('marks every derived item unclear, never new', () => {
    const derived = deriveTriageProposal([
      { messageId: M1, content: 'the usual please' },
      { messageId: M2, content: 'and the other thing' },
    ]);

    expect(derived?.items.map((i) => i.intent)).toEqual(['unclear', 'unclear']);
  });

  it('opens by stating it could not work them out, not by claiming it understood', async () => {
    // The most damaging place to say "here is what I understood" is in front of a list of things it
    // did not: the person trusts the opening, reads the list, and finds out later.
    const derived = deriveTriageProposal([{ messageId: M1, content: 'the usual please' }]);

    const message = buildProposalMessage(derived as never, []);

    expect(message).not.toMatch(/here is what I understood/i);
    expect(message).toMatch(/could not work out what they are asking for/i);
  });

  it('does not say it twice', () => {
    // The section heading exists to separate unclear messages from work that WAS understood. With no
    // such work in the message there is nothing to separate them from, and repeating the admission
    // three lines later reads as a stutter rather than as care.
    const derived = deriveTriageProposal([{ messageId: M1, content: 'the usual please' }]);

    const message = buildProposalMessage(derived as never, []);

    expect(message.match(/could not/gi)?.length).toBe(1);
  });

  it('still keeps the honest opening when SOME of the reading worked', () => {
    // A mixed reading did understand something, so it says so and lists the rest apart.
    const message = buildProposalMessage({
      items: [item({ messageId: M1, intent: 'new', label: 'the Q3 headcount' }),
        item({ messageId: M2, intent: 'unclear', label: 'what "the usual" means' })],
      inFlightAmbiguous: false,
    } as never, []);

    expect(message).toMatch(/here is what I understood/i);
    expect(message).toMatch(/could not tell what they are asking for/i);
  });

  it('lets a deployment word the whole-reading failure itself', () => {
    const derived = deriveTriageProposal([{ messageId: M1, content: 'x' }]);

    const message = buildProposalMessage(derived as never, [],
      { copy: ownWords({ triageUnclear: 'Welche davon zuerst?' }) } as never);

    expect(message).toContain('Welche davon zuerst?');
  });
});
