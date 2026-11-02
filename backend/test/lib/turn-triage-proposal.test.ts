/**
 * THE TRIAGE CONTRACT (ADR-033), and its one rule: an unreadable reply is not a decision.
 *
 * Triage classifies each queued message as amending work in progress or opening new work. The
 * classification is a model's, so the parse is where a wording choice could quietly become control
 * flow - which is why the reply is read from declared markers and why anything short of a complete,
 * well-formed answer produces nothing at all.
 *
 * The direction of every failure here is the same: produce NO work rather than some of it. A queue
 * left untriaged is answered late by the next turn; a queue half-triaged has its remainder cleared
 * with nothing behind it, and those messages become requests that silently never happened.
 */
import { ownWords } from '../helpers/own-templates';
import {
  buildTriagePrompt, parseTriageProposal, buildProposalMessage, triageContractDirective,
  topicsForOffer, IN_FLIGHT_TOPIC_ID,
} from '../../lambda/src/lib/turn-triage-proposal';

const IDS = ['m1', 'm2'];
const good = [
  'TRIAGE: m1 | amends | high | shorten the report to one page',
  'TRIAGE: m2 | new | normal | look up Q3 headcount',
].join('\n');

describe('a well-formed reply', () => {
  it('reads every message with its intent, priority and label', () => {
    const p = parseTriageProposal(good, IDS)!;
    expect(p.items).toHaveLength(2);
    expect(p.items[0]).toEqual({
      messageId: 'm1', intent: 'amends', priority: 'high', label: 'shorten the report to one page',
    });
    expect(p.items[1].intent).toBe('new');
  });

  it('carries the in-flight ambiguity only when the model declared it', () => {
    expect(parseTriageProposal(good, IDS)!.inFlightAmbiguous).toBe(false);
    expect(parseTriageProposal(`${good}\nIN_FLIGHT_UNCLEAR`, IDS)!.inFlightAmbiguous).toBe(true);
  });

  it('keeps a label containing a pipe', () => {
    // The label is the remainder, so a person's own punctuation cannot truncate it.
    const p = parseTriageProposal('TRIAGE: m1 | new | low | compare A | B', ['m1'])!;
    expect(p.items[0].label).toBe('compare A | B');
  });

  it('tolerates surrounding prose, because a model will add some', () => {
    const withProse = `Here is what arrived while I was working:\n${good}\nLet me know.`;
    expect(parseTriageProposal(withProse, IDS)!.items).toHaveLength(2);
  });
});

describe('anything short of a complete answer produces NOTHING', () => {
  it('rejects a reply that covers only some of the queue', () => {
    // The case that matters most: acting on the half that parsed would clear a queue whose remainder
    // was never triaged, and those messages would look like requests that never happened.
    expect(parseTriageProposal('TRIAGE: m1 | amends | high | shorten it', IDS)).toBeNull();
  });

  it('rejects an id that was not queued', () => {
    expect(parseTriageProposal('TRIAGE: m9 | new | low | something', IDS)).toBeNull();
  });

  it('rejects a message classified twice', () => {
    const twice = [
      'TRIAGE: m1 | amends | high | shorten it',
      'TRIAGE: m1 | new | low | something else',
    ].join('\n');
    expect(parseTriageProposal(twice, IDS)).toBeNull();
  });

  it('rejects an intent outside the closed set', () => {
    // Guessing which of the two a novel value meant is how an unrecognized answer becomes a decision.
    const bad = good.replace('| amends |', '| maybe |');
    expect(parseTriageProposal(bad, IDS)).toBeNull();
  });

  it('rejects a priority outside the closed set', () => {
    expect(parseTriageProposal(good.replace('| high |', '| urgent |'), IDS)).toBeNull();
  });

  it('rejects a line missing its label', () => {
    expect(parseTriageProposal('TRIAGE: m1 | new | low |', ['m1'])).toBeNull();
  });

  it('rejects prose that merely mentions the words', () => {
    // Substring inference over prose is what the declared marker exists to avoid.
    expect(parseTriageProposal('I think m1 amends the report and m2 is new work.', IDS)).toBeNull();
  });

  it('rejects an empty reply', () => {
    expect(parseTriageProposal('', IDS)).toBeNull();
    expect(parseTriageProposal('   \n  ', IDS)).toBeNull();
  });
});

describe('the prompt asks for what the parser accepts', () => {
  const prompt = buildTriagePrompt({
    queued: [{ messageId: 'm1', content: 'make it one page' }],
    inFlightLabel: 'Q3 revenue report',
  });

  it('states the exact reply shape, with every intent the parser accepts', () => {
    // A prompt and a parser that drift apart produce a mechanism that never triages anything and
    // never errors, so the shape is asserted from both sides.
    //
    // THE VOCABULARY IS ASSERTED IN FULL, and this line used to name only two of the three. That is
    // not a cosmetic gap: it froze the contract at `amends|new` while `unclear` was added to the
    // parser, the schema and the directive - so the guard against drift was the thing holding the
    // drift in place, and the model read a closing instruction that forbade the value the rest of the
    // system was asking it to use.
    expect(prompt).toContain('TRIAGE: <id> | <amends|new|unclear> | <high|normal|low> |');
  });

  it('says nothing about the line format when the reading is recorded by tool', () => {
    // The system directive owns the contract on that channel. Two prompts describing one answer
    // differently is how the vocabulary above went stale without anything failing.
    const viaTool = buildTriagePrompt({
      queued: [{ messageId: 'm1', content: 'make it one page' }],
      inFlightLabel: 'Q3 revenue report',
      viaTool: true,
    });

    expect(viaTool).not.toContain('TRIAGE: <id>');
    expect(viaTool).toContain('id=m1');
  });

  it('gives the model the ids it must key on', () => {
    expect(prompt).toContain('id=m1');
  });

  it('names the work in flight, and asks about it', () => {
    expect(prompt).toContain('Q3 revenue report');
    expect(prompt).toContain('IN_FLIGHT_UNCLEAR');
  });

  it('does not ask about in-flight work when there is none', () => {
    // Asking whether to continue something that does not exist invites an answer about nothing.
    const noTask = buildTriagePrompt({ queued: [{ messageId: 'm1', content: 'hi' }] });
    expect(noTask).not.toContain('IN_FLIGHT_UNCLEAR');
    expect(noTask).toContain('not working on a named task');
  });

  it('tells it not to answer the messages yet', () => {
    // Triage produces a reading, not an execution. Without this the model answers the queue, which
    // is the behavior this whole design replaces.
    expect(prompt).toContain('Do not answer any of them yet');
  });
});

describe('the proposal a person reads', () => {
  const p = (over: Partial<{ items: unknown[]; inFlightAmbiguous: boolean }> = {}) =>
    buildProposalMessage({
      items: [
        { messageId: 'm1', intent: 'amends', priority: 'normal', label: 'shorten the report' },
        { messageId: 'm2', intent: 'new', priority: 'low', label: 'check the travel policy' },
        { messageId: 'm3', intent: 'new', priority: 'high', label: 'look up Q3 headcount' },
      ],
      inFlightAmbiguous: false,
      ...over,
    } as never);

  it('separates changes to current work from new work', () => {
    const text = p();
    expect(text).toContain('Changes to what I was already doing');
    expect(text).toContain('shorten the report');
    expect(text).toContain('New, which I would take in this order');
  });

  it('shows the new work IN ORDER, highest first', () => {
    // The order is the thing being proposed. A list with no order is not a plan anyone can correct.
    const text = p();
    expect(text).toContain('1. look up Q3 headcount');
    expect(text).toContain('2. check the travel policy');
  });

  it('describes rather than announces', () => {
    // Nothing has been created: this is the reading, and the next thing that happens is their answer.
    // Copy claiming work already exists would make the pause look like a formality.
    const text = p();
    expect(text).toContain('Here is what I understood');
    expect(text).not.toMatch(/I have created|I've created|tasks created/i);
  });

  it('asks about the in-flight work ONLY when triage could not tell', () => {
    expect(p({ inFlightAmbiguous: true })).toContain('do you still want me to finish');
    // A question with an obvious answer teaches people to stop reading the questions.
    expect(p()).not.toContain('do you still want me to finish');
  });

  it('still invites a correction when nothing was ambiguous', () => {
    expect(p()).toContain('different order');
  });

  it('does NOT describe an item whose task could not be recorded', () => {
    // The failure this whole design exists to prevent, in its quietest form: a person told their
    // message was picked up when nothing holds it. Describing it here would be that reassurance,
    // delivered by the mechanism that was meant to make it true.
    const lost = [{ messageId: 'm3', intent: 'new', priority: 'high', label: 'look up Q3 headcount' }];
    const text = buildProposalMessage({
      items: [
        { messageId: 'm2', intent: 'new', priority: 'low', label: 'check the travel policy' },
        ...lost,
      ],
      inFlightAmbiguous: false,
    } as never, lost as never);
    expect(text).toContain('1. check the travel policy');
    expect(text).not.toContain('1. look up Q3 headcount');
  });

  it('names what was lost and says what to do about it', () => {
    const lost = [{ messageId: 'm3', intent: 'new', priority: 'high', label: 'look up Q3 headcount' }];
    const text = buildProposalMessage(
      { items: lost, inFlightAmbiguous: false } as never,
      lost as never,
    );
    // Silence would leave them waiting on work nothing is doing. Named, with the one action that
    // fixes it.
    expect(text).toContain('Requests I could not record: 1.');
    expect(text).toContain('look up Q3 headcount');
    expect(text).toContain('Please send anything listed here again.');
  });

  it('says nothing about losses when there were none', () => {
    expect(p()).not.toContain('could not record');
  });

  it('says each line in the assistant\'s own copy when its profile sets one', () => {
    // Text a person reads is the assistant's own copy, falling back to the catalog per key
    // (tenets P5 and D11): a profile's line replaces the shipped one, and only that one.
    const text = buildProposalMessage({
      items: [
        { messageId: 'm1', intent: 'amends', priority: 'normal', label: 'shorten the report' },
        { messageId: 'm2', intent: 'new', priority: 'low', label: 'check the travel policy' },
      ],
      inFlightAmbiguous: false,
    } as never, [], { copy: ownWords({ triageAmendsHeading: 'Änderungen an der laufenden Arbeit:', triageInviteCorrection: '  Andere Reihenfolge?  ' }) });
    expect(text).toContain('Änderungen an der laufenden Arbeit:');
    expect(text).not.toContain('Changes to what I was already doing');
    expect(text.split('\n').pop()).toBe('Andere Reihenfolge?');
    // Keys the profile did not set keep the shipped default.
    expect(text).toContain('New, which I would take in this order:');
  });

  it('omits a section that has nothing in it', () => {
    const onlyNew = buildProposalMessage({
      items: [{ messageId: 'm1', intent: 'new', priority: 'normal', label: 'one thing' }],
      inFlightAmbiguous: false,
    });
    expect(onlyNew).not.toContain('Changes to what I was already doing');
  });
});

/**
 * THE PROPOSAL IS SPOKEN IN THE ASSISTANT'S OWN VOICE.
 *
 * The triage turn is a MODEL turn: it already runs with the deployment's persona and with the
 * reply-language instruction the host applies to every turn. Asking it for structure and then
 * composing the human-facing sentence here threw both away - a terse assistant, a warm one, and a
 * conversation being held in another language all produced the same flat English, assembled by a
 * string builder that had never heard of any of them.
 *
 * ── THE SPLIT IS A BOUNDARY, NOT TIDINESS ───────────────────────────────────────────────────────
 *
 * The machine contract still fails closed and the prose still cannot touch it. `TRIAGE:` lines are
 * read only from the text BEFORE the marker, so a proposal that quotes a person's message back can
 * say anything at all and change no decision.
 */
describe('the model speaks the proposal', () => {
  const machine = [
    'TRIAGE: m1 | amends | high | shorten the report',
    'TRIAGE: m2 | new | normal | look up Q3 headcount',
  ].join('\n');

  it('uses what the model said, not a composed sentence', () => {
    const reply = `${machine}\nPROPOSAL:\nGot it - I'll trim the report first, then dig out Q3 headcount.`;
    const p = parseTriageProposal(reply, IDS)!;
    expect(p.spoken).toBe("Got it - I'll trim the report first, then dig out Q3 headcount.");
    expect(buildProposalMessage(p)).toBe("Got it - I'll trim the report first, then dig out Q3 headcount.");
  });

  it('keeps the reading intact when the model spoke', () => {
    // The voice is best effort; the DECISION is not. Both come from one reply and the decision is
    // still parsed from the declared markers.
    const p = parseTriageProposal(`${machine}\nPROPOSAL:\nanything at all`, IDS)!;
    expect(p.items).toHaveLength(2);
    expect(p.items[0].intent).toBe('amends');
  });

  it('falls back to the composed text when the model said nothing', () => {
    // A missing paragraph is not a wrong decision, so it must not discard a reading the model got
    // right. This is the one place the two halves fail differently on purpose.
    const p = parseTriageProposal(machine, IDS)!;
    expect(p.spoken).toBeUndefined();
    expect(buildProposalMessage(p)).toContain('Here is what I understood');
  });

  it('treats an empty PROPOSAL block as nothing said', () => {
    const p = parseTriageProposal(`${machine}\nPROPOSAL:\n   \n`, IDS)!;
    expect(p.spoken).toBeUndefined();
  });

  it('a TRIAGE line inside the PROSE cannot become a decision', () => {
    // The boundary. A proposal quoting the person back - "you said TRIAGE: ..." - must not
    // contribute a line, or a model's phrasing choice would edit the work list.
    const reply = `${machine}\nPROPOSAL:\nYou wrote TRIAGE: m9 | new | high | something I invented`;
    const p = parseTriageProposal(reply, IDS)!;
    expect(p.items).toHaveLength(2);
    expect(p.items.some((i) => i.messageId === 'm9')).toBe(false);
  });

  it('still names what could not be recorded, in the platform\'s own words', () => {
    // The one thing that stays fixed, and the reason is not style: the write failed AFTER the reply
    // was generated, so the model could not have known. A voice cannot report a fact it never saw.
    const reply = `${machine}\nPROPOSAL:\nOn it.`;
    const p = parseTriageProposal(reply, IDS)!;
    const lost = [{ messageId: 'm2', intent: 'new', priority: 'normal', label: 'look up Q3 headcount' }];
    const text = buildProposalMessage(p, lost as never);
    expect(text).toContain('On it.');
    expect(text).toContain('Requests I could not record: 1.');
    expect(text).toContain('Please send anything listed here again.');
  });
});

describe('the prompt asks for the voice', () => {
  it('asks for the proposal in the assistant\'s own words and language', () => {
    const prompt = buildTriagePrompt({ queued: [{ messageId: 'm1', content: 'hi' }] });
    expect(prompt).toContain('PROPOSAL:');
    expect(prompt).toMatch(/own voice/);
    expect(prompt).toMatch(/language of the conversation/);
  });

  it('tells it not to paste message ids at the person', () => {
    // A person cannot open one, and it reads as a system leak in a sentence meant for them.
    const prompt = buildTriagePrompt({ queued: [{ messageId: 'm1', content: 'hi' }] });
    expect(prompt).toContain('Do not include the message ids');
  });
});

describe('the work already running is a subject on the queue', () => {
  // A split is a comparison and it needs both sides. Grouping only the QUEUED messages meant a
  // single arriving message could never be one: there was nothing to compare it against. So a
  // person who interrupted a long report with one unrelated question was never asked, and the
  // offer appeared only when two messages happened to land before a reading fired.
  //
  // Measured live, same conversation and same person minutes apart: a reading of two messages
  // named two subjects and offered, a reading of one named none and offered nothing.
  const ONE = ['m1'];

  const withRunningWork = [
    'TRIAGE: m1 | new | normal | look up Q3 headcount',
    `TOPIC: Onboarding report | ${IN_FLIGHT_TOPIC_ID}`,
    'TOPIC: Q3 headcount | m1',
  ].join('\n');

  it('counts the running work as a subject, so one queued message can be a split', () => {
    const p = parseTriageProposal(withRunningWork, ONE)!;
    expect(p.topics).toEqual([
      { label: 'Onboarding report', messageIds: [IN_FLIGHT_TOPIC_ID] },
      { label: 'Q3 headcount', messageIds: ['m1'] },
    ]);
  });

  it('does not require the running work to have a queued id of its own', () => {
    // The coverage rule is about the QUEUE: every queued id in exactly one topic. The running work
    // has no id there, so accepting its line must not make the grouping look incomplete.
    expect(parseTriageProposal(withRunningWork, ONE)).not.toBeNull();
  });

  it('still offers nothing when the queued message continues the running work', () => {
    // One subject, which is the ordinary case: the message joined the running work's topic rather
    // than standing as its own, and there is nothing to separate.
    const sameSubject = [
      'TRIAGE: m1 | amends | normal | shorten the report',
      `TOPIC: Onboarding report | ${IN_FLIGHT_TOPIC_ID},m1`,
    ].join('\n');
    expect(parseTriageProposal(sameSubject, ONE)!.topics).toBeUndefined();
  });

  it('never offers to move the work that is already running', () => {
    // It is the thing being separated FROM, and the conversation it would move to is the one it is
    // already in. It counts as a subject; it is not on the list of things that may move.
    const offerable = topicsForOffer({
      topics: [
        { label: 'Onboarding report', messageIds: [IN_FLIGHT_TOPIC_ID] },
        { label: 'Q3 headcount', messageIds: ['m1'] },
      ],
    });
    expect(offerable).toEqual([{ label: 'Q3 headcount', messageIds: ['m1'] }]);
  });

  it('asks the model for that line when a turn was already running', () => {
    // The parser cannot keep a subject the model was never asked to name.
    const asked = triageContractDirective(ONE, false, true);
    expect(asked).toContain('TOPIC:');
    expect(asked).toContain(IN_FLIGHT_TOPIC_ID);

    // And does not ask when nothing is running: there is no second side, so a lone queued message
    // genuinely has nothing to be separated from.
    expect(triageContractDirective(ONE, false, false)).not.toContain('TOPIC:');
  });
});
