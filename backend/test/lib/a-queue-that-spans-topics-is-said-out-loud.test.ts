/**
 * A QUEUE THAT SPANS SUBJECTS IS SAID OUT LOUD, AND SPLITTING IT IS THE PERSON'S CHOICE
 * (DESIGN 2.4.2).
 *
 * The queue makes this ordinary rather than rare. Somebody who keeps typing while an assistant is
 * busy is usually not elaborating on one thing - they are adding the next thing, and the one after
 * that. The reading already separates them, because that is what produces one task per request. What
 * it does not do on its own is act on the separation.
 *
 * It matters because a conversation is the unit of grounding: everything in the room is context for
 * every later answer, so three unrelated subjects in one conversation make each subsequent answer
 * worse. Retrieval pulls from all of it and the summary describes none of it.
 *
 * THE DIVISION IS THE ONE SECTION 2.3.1 SETS FOR THE DRAIN. Naming the subjects is judged, because
 * there is no mechanical test for two requests being about the same thing. Making the offer once the
 * reading names more than one is deterministic. MOVING anything is neither: it is confirmed, and the
 * choice is per subject rather than all-or-nothing.
 */

import {
  parseTopicLines,
  parseTriageProposal,
  triageContractDirective,
} from '../../lambda/src/lib/turn-triage-proposal';

const IDS = ['m1', 'm2', 'm3'];

describe('reading the subjects a queue covers', () => {
  it('names each subject and the messages that belong to it', () => {
    const topics = parseTopicLines(
      'TOPIC: the billing question | m1, m3\nTOPIC: the deploy that failed | m2\n',
      IDS,
    );

    expect(topics).toEqual([
      { label: 'the billing question', messageIds: ['m1', 'm3'] },
      { label: 'the deploy that failed', messageIds: ['m2'] },
    ]);
  });

  it('offers nothing when the queue is all one subject', () => {
    // The ordinary case. An offer to separate a subject from itself is noise on almost every turn
    // that queues anything, and a person who is offered a pointless split stops reading the offers.
    expect(parseTopicLines('TOPIC: the billing question | m1,m2,m3', IDS)).toBeUndefined();
  });

  it('says nothing rather than something partial when the grouping misses a message', () => {
    // Offering to split "these two of your five" leaves the person deciding about messages the offer
    // never mentions, which is worse than not offering.
    expect(parseTopicLines('TOPIC: billing | m1\nTOPIC: deploys | m2', IDS)).toBeUndefined();
  });

  it('refuses a grouping that puts one message in two subjects', () => {
    expect(parseTopicLines('TOPIC: billing | m1,m2\nTOPIC: deploys | m2,m3', IDS)).toBeUndefined();
  });

  it('refuses a grouping naming a message that was never queued', () => {
    expect(parseTopicLines('TOPIC: billing | m1,m2\nTOPIC: deploys | m3,m9', IDS)).toBeUndefined();
  });

  it('refuses an unnamed subject, which a person cannot choose between', () => {
    expect(parseTopicLines('TOPIC:  | m1,m2\nTOPIC: deploys | m3', IDS)).toBeUndefined();
  });
});

describe('the subjects ride the reading without being able to break it', () => {
  const reading = [
    'TRIAGE: m1 | new | normal | the invoice total',
    'TRIAGE: m2 | new | high | the failed deploy',
    'TRIAGE: m3 | new | normal | last month is wrong too',
  ].join('\n');

  it('carries the subjects through when the grouping is usable', () => {
    const proposal = parseTriageProposal(
      `${reading}\nTOPIC: billing | m1,m3\nTOPIC: deploys | m2\nPROPOSAL:\nHere is what I understood.`,
      IDS,
    );

    expect(proposal?.topics).toEqual([
      { label: 'billing', messageIds: ['m1', 'm3'] },
      { label: 'deploys', messageIds: ['m2'] },
    ]);
    expect(proposal?.items).toHaveLength(3);
  });

  it('keeps the reading when the grouping is unusable, and drops only the offer', () => {
    // THE ITEMS FAIL CLOSED, THE SUBJECTS FAIL SOFT, and the asymmetry is deliberate. A partial
    // reading would have the caller clear a queue whose remainder was never triaged - a lost
    // message. A partial grouping costs an offer, which is neither a decision nor a lost message.
    const proposal = parseTriageProposal(
      `${reading}\nTOPIC: billing | m1\nPROPOSAL:\nHere is what I understood.`,
      IDS,
    );

    expect(proposal).not.toBeNull();
    expect(proposal?.items).toHaveLength(3);
    expect(proposal?.topics).toBeUndefined();
  });

  it('reads no subject out of the part the person is spoken to in', () => {
    // The same security boundary the TRIAGE lines have. A proposal that quotes somebody's message
    // back must not be able to contribute a grouping to the decision by containing the word.
    const proposal = parseTriageProposal(
      `${reading}\nPROPOSAL:\nyou asked me to TOPIC: billing | m1,m3 and I did not`,
      IDS,
    );

    expect(proposal?.topics).toBeUndefined();
  });
});

describe('what the assistant is told to do about it', () => {
  const SPLIT_FN = process.env.CONVERSATION_SPLIT_FUNCTION_ARN;
  const QUEUE = process.env.TURN_QUEUE_ENABLED;
  const TABLE = process.env.TURN_STATE_TABLE;
  const restore = (key: string, was: string | undefined) => {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  };
  afterEach(() => {
    restore('CONVERSATION_SPLIT_FUNCTION_ARN', SPLIT_FN);
    restore('TURN_QUEUE_ENABLED', QUEUE);
    restore('TURN_STATE_TABLE', TABLE);
  });

  // ON BY DEFAULT WHEREVER BOTH ALREADY ARE. Drift is what can spawn a conversation from a parent
  // one, and the queue is what produces a reading covering several subjects at all. Neither is a new
  // decision for an operator, which is what makes this a default rather than a third unused switch.
  const bothWired = () => {
    process.env.CONVERSATION_SPLIT_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:1:function:split';
    process.env.TURN_QUEUE_ENABLED = '1';
    process.env.TURN_STATE_TABLE = 'turn-state';
  };

  /**
   * THE FLAG IS CAPTURED WHEN THE MODULE LOADS, which is the same thing a Lambda does: changing the
   * environment replaces the execution environment. So a test that changes it has to read the
   * contract behind the new environment rather than mutating it underneath an already-loaded one.
   */
  const directiveUnderCurrentEnv = (ids: string[]): string => {
    let built = '';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      built = require('../../lambda/src/lib/turn-triage-proposal').triageContractDirective(ids);
    });
    return built;
  };

  it('asks for the grouping, and for the offer in the assistant own voice', () => {
    bothWired();
    const directive = directiveUnderCurrentEnv(IDS);

    expect(directive).toContain('TOPIC: <a short name for the subject>');
    // THE RULE IS STATED, NOT THE WORDS (tenet D11). A sentence composed in the runtime would be the
    // same flat English in every deployment and every language the product is used in.
    expect(directive).toContain('ASK WHICH ONES they want separated');
    expect(directive).toMatch(/Nothing moves unless they say so/);
  });

  it('never offers to move anything the deployment has no way to move', () => {
    bothWired();
    delete process.env.CONVERSATION_SPLIT_FUNCTION_ARN;
    const directive = directiveUnderCurrentEnv(IDS);

    // An option the runtime would then refuse teaches the model to ask for something that silently
    // does not happen, and leaves a person answering a question nobody can act on. Naming the
    // subjects is useful on its own, so that half stays.
    expect(directive).toContain('TOPIC: <a short name for the subject>');
    expect(directive).not.toContain('separate conversation');
    expect(directive).not.toContain('ASK WHICH ONES');
  });

  it('offers nothing where the queue itself is switched off', () => {
    bothWired();
    process.env.TURN_QUEUE_ENABLED = '0';

    // Read at CALL time rather than baked in at synth, for the reason turnQueueWiring gives about
    // its own grant: enabling the queue is a config change, not a redeploy.
    expect(directiveUnderCurrentEnv(IDS)).not.toContain('ASK WHICH ONES');
  });

  it('does not ask a single queued message which subjects it covers', () => {
    // One message cannot cover two subjects, so the question has one answer, and asking it invites
    // a division that is not there.
    const directive = directiveUnderCurrentEnv(['m1']);

    expect(directive).not.toContain('TOPIC:');
    expect(directive).toContain('TRIAGE: <id>');
  });
});

/**
 * A FOLLOW-UP BELONGS WITH WHAT IT FOLLOWS UP ON.
 *
 * The commonest shape of a real queue is not N unrelated requests. It is one subject the person kept
 * adding to, sometimes with an unrelated thing dropped in the middle - "actually make it one page",
 * then "and what was Q3 headcount", then "sorry, half a page". Grouping by ARRIVAL would put the two
 * billing messages in different subjects because something else landed between them, and then offer
 * to split a thread down the middle: the worst possible outcome, since the person would end up with
 * half a conversation in each room.
 *
 * The grouping is therefore by subject and independent of order, and it is independent of the
 * per-message triage decision too: a message can AMEND work already in flight and still be part of a
 * subject that gets offered a room of its own.
 */
describe('follow-ups group with what they follow up on', () => {
  const FOUR = ['m1', 'm2', 'm3', 'm4'];

  it('keeps non-adjacent messages about one subject together', () => {
    const topics = parseTopicLines(
      'TOPIC: the one-page report | m1, m3\nTOPIC: Q3 headcount | m2, m4\n',
      FOUR,
    );

    expect(topics).toEqual([
      { label: 'the one-page report', messageIds: ['m1', 'm3'] },
      { label: 'Q3 headcount', messageIds: ['m2', 'm4'] },
    ]);
  });

  it('offers nothing when every follow-up is about the same thing', () => {
    // Four messages and still one subject. This is the ordinary busy-typist case, and an offer here
    // would ask a person to split a single train of thought away from itself.
    expect(parseTopicLines('TOPIC: the one-page report | m1,m2,m3,m4', FOUR)).toBeUndefined();
  });

  it('lets a message amend work in flight and still belong to an offered subject', () => {
    // The two decisions are about different things: `amends` says what this message DOES to work
    // already running, and the subject says what it is ABOUT. Collapsing them would mean any queue
    // containing an amendment could never be offered a split.
    const proposal = parseTriageProposal([
      'TRIAGE: m1 | amends | normal | keep the report to one page',
      'TRIAGE: m2 | new | normal | Q3 headcount',
      'TRIAGE: m3 | amends | low | make it half a page',
      'TRIAGE: m4 | new | normal | headcount by team',
      'TOPIC: the report | m1,m3',
      'TOPIC: headcount | m2,m4',
      'PROPOSAL:',
      'Here is what I understood.',
    ].join('\n'), FOUR);

    expect(proposal?.topics).toEqual([
      { label: 'the report', messageIds: ['m1', 'm3'] },
      { label: 'headcount', messageIds: ['m2', 'm4'] },
    ]);
    expect(proposal?.items.filter((i: { intent: string }) => i.intent === 'amends')).toHaveLength(2);
  });
});

/**
 * THE GROUPING INSTRUCTION GUARDS BOTH DIRECTIONS, and it used to guard one.
 *
 * It cautioned against inventing a division and said nothing against collapsing real ones. A
 * one-sided caution biases the way one-sided cautions do, and the bias here is the direction that
 * disables the feature: one topic is not an error, it is "no split needed", so the offer never
 * appears and nothing looks wrong.
 *
 * Observed live (2026-08-30, premium): a headcount figure, which tools a process touches, and
 * whether the pricing page copy is accurate came back as ONE topic, reasoned as "all three are quick
 * lookups from Stratum's internal context". That is a fact about how the assistant would ANSWER
 * rather than about what was ASKED - and it is true of nearly every request in this deployment, so
 * as an axis it collapses every queue into a single subject.
 *
 * Asserted on the CONTRACT rather than on a model's reply, because a reply is one sample and the
 * instruction is the thing that can be wrong on every sample.
 */
describe('the grouping instruction cautions in both directions', () => {
  // Normalized, because the directive is line-wrapped for prompt readability and a guard on its
  // MEANING must not break when someone re-wraps a line.
  const directive = triageContractDirective(['m1', 'm2']).split(String.fromCharCode(10)).join(' ');

  it('names the axis: what a request is about, not how it would be answered', () => {
    expect(directive).toContain('what a request is ABOUT, not how you would answer it');
  });

  it('warns against collapsing distinct subjects', () => {
    expect(directive).toMatch(/separate conversations, they are separate subjects/);
    expect(directive).toMatch(/merge distinct requests to be tidy/);
  });

  it('still warns against inventing a division', () => {
    // The half that was already there, kept: the two failures are symmetric and both cost the person.
    expect(directive).toMatch(/invent a division that is not there/);
  });
});
