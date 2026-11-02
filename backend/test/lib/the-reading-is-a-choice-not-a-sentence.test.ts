/**
 * THE JUDGEMENT IS THE MODEL'S; THE SELECTION THAT DRIVES THE PROCESS IS A CHOICE FROM A SET
 * (maintainer, 2026-09-03).
 *
 * Whether a message amends the work in flight, whether it can be understood at all, how it ranks -
 * none of that is mechanical, and all of it stays with the model. What was also the model's, and
 * should never have been, is the FORM the answer arrives in: a `TRIAGE:` line, matched with a regex,
 * whose fields were then checked against closed sets. The decision was constrained. The channel
 * carrying it was not.
 *
 * The gap is measured, not theoretical. A triage turn is dispatched as an ordinary turn, so it runs
 * the profile's persona and answers in prose - the design records "zero `TRIAGE:` lines, no
 * `PROPOSAL:` marker, and not even the `ANOTHER_PASS:` escape hatch" against a real deployment. The
 * reading was unusable and the derived floor had to carry it. A tool call cannot be answered in
 * prose.
 *
 * ── WHY EVERY FIELD IS STILL CHECKED ────────────────────────────────────────────────────────────
 *
 * A schema is a request to the provider, not a guarantee from it. Providers differ in whether they
 * enforce an enum, a fallback path may not enforce one at all, and this value decides what happens to
 * somebody's message. So the converter applies the same closed sets the text contract used, and these
 * tests hold it to that - a schema is why an invalid value should be impossible, never why it would
 * be safe to accept one.
 */

import {
  readingToolSpec, proposalFromReadingTool, readingToolRefusal, READING_TOOL_NAME,
} from '../../lambda/src/lib/turn-triage-proposal';

const M1 = 'msg-0000-1111';
const M2 = 'msg-0000-2222';

const entry = (over: Record<string, unknown> = {}) => ({
  message_id: M1, intent: 'new', priority: 'normal', label: 'the Q3 headcount', ...over,
});

/** The per-item property schema, which is where the constraints live. */
const itemProps = () => (readingToolSpec([M1, M2]).toolSpec.inputSchema.json as any)
  .properties.items.items.properties;

describe('what the schema makes impossible rather than merely detectable', () => {
  it('offers the three intents and nothing else', () => {
    expect(itemProps().intent.enum).toEqual(['amends', 'new', 'unclear']);
  });

  it('offers the three priorities and nothing else', () => {
    expect(itemProps().priority.enum).toEqual(['high', 'normal', 'low']);
  });

  it('offers exactly the ids of THIS queue', () => {
    // So a reading cannot classify a message that was never queued, quietly rename one that was, or
    // reach back to something earlier in the conversation.
    expect(itemProps().message_id.enum).toEqual([M1, M2]);
  });

  it('requires every field that decides anything', () => {
    const items = (readingToolSpec([M1]).toolSpec.inputSchema.json as any).properties.items;
    expect(items.items.required.sort()).toEqual(['intent', 'label', 'message_id', 'priority']);
  });

  it('tells the model the rule for "unclear", not just the word', () => {
    // The word alone invites it as an escape from a hard message rather than an honest answer about
    // one. The schema is where a model actually reads the contract, so the rule belongs here too.
    expect(String(itemProps().intent.description)).toMatch(/do not\s+guess/i);
    expect(String(itemProps().label.description)).toMatch(/what you would need to know/i);
  });

  it('is one named tool, so the loop can recognise the reading', () => {
    expect(readingToolSpec([M1]).toolSpec.name).toBe(READING_TOOL_NAME);
  });
});

describe('the converter re-checks everything the schema already asked for', () => {
  it('accepts a well-formed reading and keeps its decisions', () => {
    const p = proposalFromReadingTool({
      items: [entry({ message_id: M1, intent: 'amends', priority: 'high' }),
        entry({ message_id: M2, intent: 'unclear', label: 'what "the other one" means' })],
    }, [M1, M2]);

    expect(p?.items.map((i) => [i.messageId, i.intent, i.priority]))
      .toEqual([[M1, 'amends', 'high'], [M2, 'unclear', 'normal']]);
  });

  it('refuses an intent outside the set, even though the schema forbade it', () => {
    expect(proposalFromReadingTool({ items: [entry({ intent: 'maybe' })] }, [M1])).toBeNull();
  });

  it('refuses a priority outside the set', () => {
    expect(proposalFromReadingTool({ items: [entry({ priority: 'urgent' })] }, [M1])).toBeNull();
  });

  it('refuses a message that was never queued', () => {
    expect(proposalFromReadingTool({ items: [entry({ message_id: 'invented' })] }, [M1])).toBeNull();
  });

  it('refuses a message classified twice, because that has no single answer', () => {
    expect(proposalFromReadingTool({ items: [entry(), entry()] }, [M1])).toBeNull();
  });

  it('refuses a reading that accounts for only part of the queue', () => {
    // A partial reading would clear the queue while accounting for some of it, which is the silent
    // loss this whole path exists to prevent.
    expect(proposalFromReadingTool({ items: [entry({ message_id: M1 })] }, [M1, M2])).toBeNull();
  });

  it('refuses an empty label, which names nothing a person could act on', () => {
    expect(proposalFromReadingTool({ items: [entry({ label: '   ' })] }, [M1])).toBeNull();
  });

  it('refuses prose, an absent call, and a shape that is not a reading', () => {
    // Each of these is what "the model answered in its persona instead" looks like by the time it
    // reaches here. All must reach the derived floor rather than half a reading.
    expect(proposalFromReadingTool(undefined, [M1])).toBeNull();
    expect(proposalFromReadingTool({}, [M1])).toBeNull();
    expect(proposalFromReadingTool({ items: [] }, [M1])).toBeNull();
    expect(proposalFromReadingTool({ items: 'TRIAGE: msg | new | normal | thing' }, [M1])).toBeNull();
  });

  it('carries the in-flight question only when it is exactly true', () => {
    // A truthy string is not a decision. This flag opens a task that awaits somebody, so it is taken
    // from a boolean or not at all.
    expect(proposalFromReadingTool({ items: [entry()], in_flight_unclear: true }, [M1])?.inFlightAmbiguous)
      .toBe(true);
    expect(proposalFromReadingTool({ items: [entry()], in_flight_unclear: 'yes' }, [M1])?.inFlightAmbiguous)
      .toBe(false);
    expect(proposalFromReadingTool({ items: [entry()] }, [M1])?.inFlightAmbiguous).toBe(false);
  });
});

/**
 * OFFERING THE TOOL WITHOUT SAYING SO IS WORSE THAN NOT OFFERING IT.
 *
 * Measured, on the deployment, the first time the tool shipped: every triage turn came back
 * `toolCalled: false`. The tool was registered and the directive still described the `TRIAGE:` line
 * format, so the model had two contracts for one answer and followed the prompt - which is the
 * correct thing for it to do. The result was a reading that still arrived as prose, from a turn that
 * had a structured channel available and no idea it was meant to use it.
 *
 * So the directive names the channel. The RULES are identical either way and these tests hold that:
 * what changes is how the answer travels, never what makes it valid.
 */
describe('the directive asks for the channel that is actually offered', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { triageContractDirective } = require('../../lambda/src/lib/turn-triage-proposal');
  const text = (viaTool: boolean) => triageContractDirective([M1, M2], false, false, false, viaTool);

  it('asks for the tool CALL, and stops describing the line format, when the tool is offered', () => {
    const d = text(true);

    expect(d).toMatch(/calling the `record_reading` tool/i);
    expect(d).not.toContain('TRIAGE: <id>');
  });

  it('still asks for the lines when there is no tool to call', () => {
    // The text contract is the fallback, not dead weight: a provider that cannot enforce or does not
    // support a tool schema still needs a way to answer.
    const d = text(false);

    expect(d).toContain('TRIAGE: <id>');
    expect(d).not.toMatch(/calling the `record_reading` tool/i);
  });

  // ── THE FORM IS THE CHANNEL'S; THE RULE IS NOT (owner-reported, 2026-09-05) ──────────────────
  //
  // `TRIAGE: <id>` was gated on the channel and `TOPIC:` was not, so the tool channel carried three
  // instructions where two of them contradict: record by calling the tool, write TOPIC lines in
  // exactly this form, and everything you write is for the person. A `TOPIC: Status / what's
  // happening next | IN_FLIGHT, 60c1373a...` line was spoken to somebody as a result.
  it('does not ask for the TOPIC line format when the tool carries the topics', () => {
    const d = triageContractDirective([M1, M2], false, false, false, true);

    expect(d).not.toContain('TOPIC: <a short name');
    // The JUDGEMENT still has to be asked for, or gating the form would silently end the split offer
    // on the primary channel - and over-merging is the failure that hides, because one subject reads
    // as "no split needed" and nothing looks wrong.
    expect(d).toMatch(/`topics` field/i);
    expect(d).toMatch(/what a request is ABOUT/i);
  });

  it('still asks for the TOPIC line when text is the only channel there is', () => {
    const d = triageContractDirective([M1, M2], false, false, false, false);

    expect(d).toContain('TOPIC: <a short name');
    expect(d).not.toMatch(/`topics` field/i);
  });

  // ── POSITIONS, NOT SUBJECTS (owner-reported, 2026-09-05) ────────────────────────────────────
  //
  // `openWork` hands the reading a type, a priority and whether a task is private - never a label -
  // so a private task can hold its place in the order without its contents reaching the turn. The
  // ranking rule already says not to guess what one is; nothing said not to TALK about them.
  //
  // Measured: a reading told somebody three earlier messages were still open. Two were. The third
  // had been read as an amendment, folded into the work in flight and answered - the conversation's
  // task table holds no row for it. The model had reconstructed the list from history.
  it('forbids narrating work it was given the position of but not the subject', () => {
    for (const d of [
      triageContractDirective([M1, M2], false, false, false, true),
      triageContractDirective([M1, M2], false, false, false, false),
    ]) {
      expect(d).toMatch(/Speak only about the messages listed above/i);
      // The directive is hard-wrapped, so a phrase asserted whole must tolerate the break that
      // falls inside it - otherwise this passes or fails on where the wrapping happens to land.
      expect(d).toMatch(/restate earlier messages as still outstanding/i);
      // The REASON travels with the rule: a model told only "do not" has nothing to reason from
      // when a case arrives that the wording does not literally cover.
      expect(d).toMatch(/POSITION of the other work[\s\S]*never its\s*\n?\s*subject/i);
    }
  });

  it('keeps the rules that decide validity on BOTH channels', () => {
    // Only the channel differs. A rule that survived one and not the other would make the fallback
    // mean something different from the primary, which is how two contracts drift into two behaviors.
    for (const d of [text(true), text(false)]) {
      expect(d).toMatch(/do not\s+guess/i);
      expect(d).toMatch(/must not begin, continue or describe the work/i);
      expect(d).toContain(M1);
      expect(d).toContain(M2);
    }
  });
});

/**
 * THE SPOKEN HALF STILL BELONGS TO THE ASSISTANT.
 *
 * A triage turn produces two things: the reading, which is a decision, and the proposal, which is a
 * person being told what the assistant understood. Moving the reading onto a tool must not cost the
 * second one - the proposal carries the deployment's persona and the conversation's language, and a
 * message composed from the items instead is correct and identical in every deployment (tenet D11).
 *
 * On the text channel `PROPOSAL:` separates the two halves. On the tool channel there is no machine
 * half in the text at all, so the whole reply is the spoken proposal and there is nothing to separate.
 * Told otherwise - "write the marker after those lines" when it had written no lines - the model
 * called the tool and stopped: `stopReason: tool_use`, the loop out of iterations, and the turn
 * logging "the model returned no text; there is nothing to answer with". Measured on the deployment.
 */
describe('the proposal is asked for in terms that make sense on the channel', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { triageContractDirective } = require('../../lambda/src/lib/turn-triage-proposal');

  it('does not ask for a marker after lines that were never written', () => {
    const d = triageContractDirective([M1], false, false, false, true);

    expect(d).not.toMatch(/after those lines/i);
    expect(d).not.toContain('PROPOSAL:');
    expect(d).toMatch(/after you have called the tool/i);
  });

  it('still asks for the marker on the channel that needs it', () => {
    const d = triageContractDirective([M1], false, false, false, false);

    expect(d).toContain('PROPOSAL:');
    expect(d).toMatch(/after those lines/i);
  });

  it('asks for the assistant\'s own voice either way', () => {
    // The half that is the person's experience of this, and the half a schema cannot supply.
    for (const d of [triageContractDirective([M1], false, false, false, true),
      triageContractDirective([M1], false, false, false, false)]) {
      expect(d).toMatch(/in your own voice/i);
      expect(d).toMatch(/language of the conversation/i);
    }
  });
});

/**
 * "UNCLEAR" COVERS AN UNSUPPLIED REFERENT, NOT ONLY AN UNINTELLIGIBLE MESSAGE (maintainer, 2026-09-04).
 *
 * Measured on the deployment. Given "Same as the other one, but do it the way we did before" behind a
 * running onboarding report, the model chose NEW and labeled it "Reformat onboarding report to match
 * a prior style the user references but hasn't specified".
 *
 * It had understood the ambiguity exactly and said so in the label - and still produced a proposal.
 * The old rule is why: it said `unclear` was for a message you cannot make out, and this one could be
 * made out. Knowing the SUBJECT is not knowing the REQUEST.
 *
 * A label that admits the gap does not repair the claim. A proposal says the work is defined enough
 * to begin; queued work begins nothing until the person confirms, so asking costs one answer and a
 * wrong item costs the correction plus whatever was done under it.
 */
describe('the rule for "unclear" reaches the case that was getting through', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { triageContractDirective } = require('../../lambda/src/lib/turn-triage-proposal');
  const schemaIntent = () => String(itemProps().intent.description);

  it('names the unsupplied referent on both channels, not just an unreadable message', () => {
    for (const text of [triageContractDirective([M1], false, false, false, true),
      triageContractDirective([M1], false, false, false, false), schemaIntent()]) {
      // The phrases a person actually uses when they leave the specific out.
      expect(text.toLowerCase()).toContain('the usual');
      expect(text.toLowerCase()).toContain('the other one');
    }
  });

  it('gives a test that can be applied rather than a feeling', () => {
    // "Cannot tell what it asks" is a judgement about comprehension and the model kept passing it.
    // "Would starting mean choosing something they did not say" is a judgement about the WORK.
    for (const text of [triageContractDirective([M1], false, false, false, true), schemaIntent()]) {
      expect(text.toLowerCase()).toMatch(/would mean choosing something (the person|they) did not say/);
    }
  });

  it('closes the escape the model actually took: a NEW item whose label admits the gap', () => {
    const d = triageContractDirective([M1], false, false, false, true);

    expect(d.toLowerCase()).toMatch(/naming your uncertainty in the label/);
    expect(schemaIntent().toLowerCase()).toMatch(/do not use "new" with a label that admits the gap/);
  });

  it('keeps "do not guess", which the earlier rule got right', () => {
    for (const text of [triageContractDirective([M1], false, false, false, true),
      triageContractDirective([M1], false, false, false, false), schemaIntent()]) {
      expect(text.toLowerCase()).toMatch(/do not guess/);
    }
  });
});

/**
 * ONE CONTRACT, IN ONE PLACE (code review, 2026-09-04).
 *
 * A triage turn carries two prompts: the system directive and the user message. The directive was
 * made channel-aware and the user message was not, so it went on saying "Reply with one line per
 * message... TRIAGE: <id> | <amends|new> | ..." while the directive said "do not write the reading as
 * text, call the tool".
 *
 * Two contracts for one answer, and this was the worse half: the user message is read LAST, and its
 * vocabulary had only two values. The one word the whole clarification path turns on was absent from
 * the closest instruction - which is a better explanation of a model choosing `new` than any judgement
 * about the message.
 */
describe('the user prompt does not restate a contract the directive already gave', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildTriagePrompt } = require('../../lambda/src/lib/turn-triage-proposal');
  const prompt = (viaTool: boolean) => buildTriagePrompt({
    queued: [{ messageId: M1, content: 'the usual please' }], viaTool,
  });

  it('says nothing about the line format when the tool is the channel', () => {
    const t = prompt(true);

    expect(t).not.toContain('TRIAGE: <id>');
    expect(t).not.toMatch(/one line per message/i);
  });

  it('never offers a vocabulary that omits "unclear"', () => {
    // The specific shape of the bug: `<amends|new>` in the message the model reads last, while the
    // directive was asking for one of three values.
    for (const t of [prompt(true), prompt(false)]) {
      expect(t).not.toContain('<amends|new>');
    }
  });

  it('still states the format on the channel that has no tool', () => {
    expect(prompt(false)).toContain('TRIAGE: <id> | <amends|new|unclear>');
  });

  it('still asks for the reading either way', () => {
    // Removing the format must not remove the instruction: the turn is a classification step whatever
    // channel carries the answer.
    for (const t of [prompt(true), prompt(false)]) {
      expect(t).toMatch(/CHANGES what you were already working on/);
      expect(t).toMatch(/Do not answer any of them yet/);
      expect(t).toContain(M1);
    }
  });
});

/**
 * THE THINGS THAT CROSS THE BOUNDARY, AND THE TWO THAT DID NOT (code review, 2026-09-04).
 *
 * Both are the same shape, and `parseTriageTurnContext` warns about that shape in its own comment: a
 * field added to the dispatcher and not to the parser is dropped silently, and the feature built on
 * it is inert on the deployed path while every unit test around it passes.
 *
 *   - `inFlightLabel` was sent "so a re-read pass compares against the same work the first pass did"
 *     and never read back, so passes 2 and 3 fell to the literal phrase and could classify one
 *     amendment two ways.
 *   - `IN_FLIGHT` was stripped from a topic's ids on the tool channel, so `topicsForOffer` could no
 *     longer tell which subject was the work being separated FROM, and offered to move it.
 */
describe('what survives the dispatch boundary', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parseTriageTurnContext, IN_FLIGHT_TOPIC_ID, topicsForOffer } =
    require('../../lambda/src/lib/turn-triage-proposal');

  it('carries the description of the work in flight to a re-read pass', () => {
    const ctx = parseTriageTurnContext(JSON.stringify({
      ids: [M1], visibility: 'conversation', inFlight: true, pass: 2,
      inFlightLabel: 'the Q3 revenue report',
    }));

    expect(ctx?.inFlightLabel).toBe('the Q3 revenue report');
  });

  it('treats a blank description as absent, so the caller falls back rather than saying nothing', () => {
    const ctx = parseTriageTurnContext(JSON.stringify({
      ids: [M1], visibility: 'conversation', inFlight: true, pass: 2, inFlightLabel: '   ',
    }));

    expect(ctx).not.toHaveProperty('inFlightLabel');
    expect(ctx?.inFlight).toBe(true);
  });

  it('keeps IN_FLIGHT among a topic\'s ids, which is how the offer knows what may not move', () => {
    const p = proposalFromReadingTool({
      items: [entry({ message_id: M1 }), entry({ message_id: M2 })],
      topics: [
        { label: 'the report already running', message_ids: [IN_FLIGHT_TOPIC_ID, M1] },
        { label: 'headcount', message_ids: [M2] },
      ],
    }, [M1, M2]);

    expect(p?.topics?.[0]?.messageIds).toContain(IN_FLIGHT_TOPIC_ID);
  });

  it('so the work already running is never offered as a subject to move', () => {
    // The assertion that matters to a person: they were being offered the chance to move the thing
    // the assistant was in the middle of, and choosing it moved nothing.
    const p = proposalFromReadingTool({
      items: [entry({ message_id: M1 }), entry({ message_id: M2 })],
      topics: [
        { label: 'the report already running', message_ids: [IN_FLIGHT_TOPIC_ID, M1] },
        { label: 'headcount', message_ids: [M2] },
      ],
    }, [M1, M2]);

    const offerable = topicsForOffer({ topics: p!.topics!, targetedIds: [], sendersById: {} });
    expect(offerable.map((t: { label: string }) => t.label)).toEqual(['headcount']);
  });
});

/**
 * A RUNTIME MARKER NEVER REACHES A PERSON (e2e, 2026-09-04).
 *
 * On the tool channel the whole reply is the spoken proposal - there is no machine half in the text
 * to separate it from - so it is taken whole. A model that still opened with `PROPOSAL:` out of habit
 * therefore printed a runtime marker in front of somebody, which the suite's no-markers guard caught
 * on the first run after the change.
 *
 * The marker is meaningless on this channel rather than load-bearing, so it is stripped rather than
 * required: text after it, or the text itself when there is none.
 */
describe('the spoken half carries no machine marks', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spokenFromReply } = require('../../lambda/src/lib/turn-triage-proposal');

  it('takes what follows the marker when the model writes one', () => {
    expect(spokenFromReply('PROPOSAL:\nHere is what I understood.')).toBe('Here is what I understood.');
  });

  it('takes the whole reply when there is no marker, which is the expected shape', () => {
    expect(spokenFromReply('Here is what I understood.')).toBe('Here is what I understood.');
  });

  it('never leaves the marker at the front, however it is spaced or cased', () => {
    for (const raw of ['proposal:\nx', '  PROPOSAL :  \nx', 'PROPOSAL:\n\n  x  ']) {
      expect(spokenFromReply(raw)).toBe('x');
    }
  });

  it('leaves a mention of the word inside a sentence alone', () => {
    // The marker is a line of its own. A person asking "what is your proposal: the long one?" is not
    // writing a marker, and neither is an assistant quoting them.
    const said = 'You asked about my proposal: here it is.';
    expect(spokenFromReply(said)).toBe(said);
  });

  it('says nothing rather than something empty', () => {
    expect(spokenFromReply('PROPOSAL:\n   ')).toBe('');
    expect(spokenFromReply('')).toBe('');
  });

  // ── THE ONE THAT REACHED A PERSON (owner-reported, 2026-09-05) ───────────────────────────────
  //
  // `PROPOSAL:` was stripped and `TOPIC:` was not, so a reply on the tool channel opened with
  // `TOPIC: Status / what's happening next | IN_FLIGHT, 60c1373a...` in front of somebody. The
  // prompt no longer asks for that line on this channel; these pin the stripper, which is the half
  // that holds when a marker arrives by some other route.
  it('strips a TOPIC line, which is what actually reached a person', () => {
    const raw = 'TOPIC: Status / what is happening next | IN_FLIGHT, 60c1373a\n\n'
      + "It looks like you're wondering what's going on.";
    expect(spokenFromReply(raw)).toBe("It looks like you're wondering what's going on.");
  });

  it('strips every machine form, not only the one at the front', () => {
    const raw = 'TRIAGE: abc | new | normal | a label\n'
      + 'TOPIC: One subject | abc\n'
      + 'PROPOSAL:\n'
      + 'Here is what I understood.';
    expect(spokenFromReply(raw)).toBe('Here is what I understood.');
  });

  // A leading-run strip would have passed the earlier cases and still spoken this one, which is why
  // the strip is not anchored to the top of the reply.
  it('strips a machine line that follows prose rather than preceding it', () => {
    const raw = 'Here is what I understood.\nTOPIC: Something | IN_FLIGHT\nAnd here is the rest.';
    expect(spokenFromReply(raw)).toBe('Here is what I understood.\nAnd here is the rest.');
  });

  it('leaves a sentence mentioning a topic alone', () => {
    // Same rule as the marker above: these are LINES, not words. Prose that happens to contain the
    // word is not a machine line and must survive.
    const said = 'The topic: whether we ship on Friday.';
    expect(spokenFromReply(said)).toBe(said);
  });

  it('does not leave a blank gap where a line was removed', () => {
    expect(spokenFromReply('TOPIC: A | x\n\n\n\nSaid.')).toBe('Said.');
  });

  // ── AND THE ONE THAT DRESSED ITSELF UP (e2e, 2026-09-15) ────────────────────────────────────
  //
  // Every pattern was anchored to a BARE token at the start of a line, so a model that wrote the
  // same token as markdown walked past all of them. Measured live: the proposal posted to a person
  // opened with `**PROPOSAL:**`, on a run where a plain `PROPOSAL:` would have been stripped. The
  // trigger is a model's per-run formatting choice, which is why it is a class and not a string.
  it('strips a marker wearing markdown, in every form a model reaches for', () => {
    for (const decorated of [
      '**PROPOSAL:**', '*PROPOSAL:*', '__PROPOSAL:__', '**PROPOSAL**:',
      '## PROPOSAL:', '### **PROPOSAL:**', '> PROPOSAL:', '> **PROPOSAL:**',
      '`PROPOSAL:`', '  **PROPOSAL :**  ',
    ]) {
      expect(spokenFromReply(`${decorated}\nHere is what I understood.`))
        .toBe('Here is what I understood.');
    }
  });

  it('strips the marker that was never in the list at all', () => {
    // `IN_FLIGHT_UNCLEAR` is the one the prompt asked for on the tool channel and the stripper had
    // no pattern for, bare or decorated.
    expect(spokenFromReply('IN_FLIGHT_UNCLEAR\nHere is what I understood.'))
      .toBe('Here is what I understood.');
    expect(spokenFromReply('**IN_FLIGHT_UNCLEAR**\nHere is what I understood.'))
      .toBe('Here is what I understood.');
    expect(spokenFromReply('Here is what I understood.\n> IN_FLIGHT_UNCLEAR\nAnd the rest.'))
      .toBe('Here is what I understood.\nAnd the rest.');
  });

  it('strips the other markers when they are decorated too', () => {
    for (const decorated of ['**TRIAGE:**', '## TOPIC:', '`ANOTHER_PASS:`']) {
      expect(spokenFromReply(`${decorated}\nSaid.`)).toBe('Said.');
    }
  });

  // ── AND NEVER A PERSON'S SENTENCE, WHICH IS THE WORSE FAILURE OF THE TWO ────────────────────
  //
  // The decorated strip applies to a line that is ONLY the decorated token. A heading with real
  // content after it is the assistant speaking, and eating those words to catch a token would cost
  // more than the leak it prevents - so these must come back whole, to the character.
  it('keeps a real heading that happens to start with one of our words', () => {
    for (const said of [
      '**Proposal:** ship on Friday',
      '## Proposal: ship on Friday',
      '> **Topic:** whether we ship on Friday',
      '**Proposal:** ship on Friday\n\nThe rest of what I think.',
    ]) {
      expect(spokenFromReply(said)).toBe(said);
    }
  });

  it('keeps a decorated line that merely mentions a marker among other words', () => {
    const said = '**On your question:** the proposal: is ready.';
    expect(spokenFromReply(said)).toBe(said);
  });

  it('is not fooled into eating a line of plain decoration', () => {
    // A horizontal rule, an empty emphasis run: nothing is left after the decoration comes off, and
    // an empty remainder is not a marker.
    expect(spokenFromReply('Said.\n***\nAnd the rest.')).toBe('Said.\n***\nAnd the rest.');
  });
});

/**
 * THE LITERALS ARE THE TEXT CHANNEL'S, AND ONLY THE TEXT CHANNEL'S (e2e, 2026-09-15).
 *
 * `TRIAGE:` was gated on the channel from the start; `PROPOSAL:`, `ANOTHER_PASS:` and
 * `IN_FLIGHT_UNCLEAR` were not. On the tool channel the reading is recorded by `record_reading` and
 * nothing parses the model's text, while the directive tells it that everything it writes is for the
 * person - so the prompt handed it two contracts for one answer and it obeyed both. That is the same
 * failure this file records for the `TOPIC:` line, and the prompt is the half that removes the cause.
 *
 * NOTHING IS LOST. `in_flight_unclear` is a field on the reading tool, so the judgement travels as
 * structure; `triageContractDirective` still states the another-pass escape hatch; and the spoken
 * half is still asked for, without a marker separating it from lines that were never written.
 */
describe('the user prompt stops asking for markers the tool channel does not read', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildTriagePrompt } = require('../../lambda/src/lib/turn-triage-proposal');
  const prompt = (viaTool: boolean) => buildTriagePrompt({
    queued: [{ messageId: M1, content: 'make it one page' }],
    inFlightLabel: 'the Q3 revenue report',
    mayAskForAnotherPass: true,
    viaTool,
  });

  it('names none of the three literals when the tool is the channel', () => {
    const t = prompt(true);

    for (const marker of ['PROPOSAL:', 'ANOTHER_PASS:', 'IN_FLIGHT_UNCLEAR']) {
      expect(t).not.toContain(marker);
    }
  });

  it('still names every one of them on the channel that parses them', () => {
    // Each is a parse boundary in the text contract: `parseTriageProposal` splits on `PROPOSAL:` and
    // calls that split a security boundary, `parseAnotherPassRequest` reads its marker from before
    // it, and the in-flight question is declared by its line or not at all.
    const t = prompt(false);

    for (const marker of ['PROPOSAL:', 'ANOTHER_PASS:', 'IN_FLIGHT_UNCLEAR']) {
      expect(t).toContain(marker);
    }
  });

  it('keeps asking the in-flight question on the tool channel, as a field rather than a line', () => {
    // The FORM is the channel's; the judgement is not. Dropping the question with the literal would
    // have quietly ended the in-flight ask on the primary channel, which is the failure that hides.
    expect(prompt(true)).toMatch(/whether the work you were doing is still wanted/);
    expect(prompt(true)).toContain('in_flight_unclear');
  });

  it('still asks for the spoken half on both channels', () => {
    for (const t of [prompt(true), prompt(false)]) {
      expect(t).toMatch(/own voice/);
      expect(t).toMatch(/language of the conversation/);
      expect(t).toMatch(/ask them to\s+correct you/);
    }
  });
});

describe('a refused reading says why, as a shape', () => {
  const both = [M1, M2];
  const ok = { items: [entry(), entry({ message_id: M2 })] };

  it('is null exactly when the converter accepts the call', () => {
    expect(readingToolRefusal(ok, both)).toBeNull();
    expect(proposalFromReadingTool(ok, both)).not.toBeNull();
  });

  it.each([
    ['a stringified array', { items: JSON.stringify(ok.items) }, 'items-not-an-array:string'],
    ['no items at all', {}, 'items-not-an-array:undefined'],
    ['an empty list', { items: [] }, 'items-empty'],
    ['a mistyped id', { items: [entry({ message_id: 'msg-0000-111' }), entry({ message_id: M2 })] }, 'item-0:message-id-not-queued'],
    ['an intent outside the set', { items: [entry(), entry({ message_id: M2, intent: 'later' })] }, 'item-1:intent-outside-the-set'],
    ['a priority outside the set', { items: [entry({ priority: 'urgent' }), entry({ message_id: M2 })] }, 'item-0:priority-outside-the-set'],
    ['an empty label', { items: [entry({ label: '  ' }), entry({ message_id: M2 })] }, 'item-0:label-empty'],
    ['a repeated id', { items: [entry(), entry()] }, 'item-1:message-id-repeated'],
    ['a missing message', { items: [entry()] }, 'ids-missing:1-of-2'],
  ])('names %s, and the converter refuses the same call', (_name, input, reason) => {
    expect(readingToolRefusal(input, both)).toBe(reason);
    expect(proposalFromReadingTool(input, both)).toBeNull();
  });

  it('rides the warning the drain logs when it derives a reading instead', () => {
    const core = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../lambda/src/lib/async-processor-core.ts'), 'utf8',
    ) as string;
    const at = core.indexOf("'[AsyncProcessor][triage] the reply was not a usable reading; deriving one'");
    expect(at).toBeGreaterThan(-1);
    expect(core.slice(at, at + 900)).toContain('toolRefusal: readingToolRefusal(params.reading, event.triage.ids)');
  });
});
