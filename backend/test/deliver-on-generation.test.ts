/**
 * THE DELIVERY CONTRACT IS DECLARED, NOT INFERRED (maintainer decision 2026-08-18).
 *
 * This file used to pin the opposite: `advanceDeliveredTaskToCompletion` walked a task to its
 * terminal state whenever the OUTPUT looked deliverable-shaped, and `completeOnDelivery` keyed
 * completion on `isDeliverableDocument`. That heuristic kept failing in a new costume each time -
 * a clarifying question attached as a file, a requirements questionnaire attached as a file, and
 * finally a STRUCTURED outline-for-approval attached as the report AND completing the task from
 * `drafting_outline` while it was still asking (found live by the owner; the fixture below is that
 * exact reply). Each patch narrowed the predicate; the next reply found the next gap.
 *
 * The contract now: the model DECLARES delivery by advancing the machine (advance_task_state), the
 * attachment keys on the DECLARED state, and completion has exactly one door - the machine reaching
 * a terminal state (shouldMarkTaskCompleted, invariant AT6). The heuristic survives only as shadow
 * telemetry. These tests hold that shape in place, at three levels: the fixture proves the heuristic
 * NEEDED demoting, the machine gate answers the fixture correctly, and source ratchets fail the
 * commit that reintroduces either removed door.
 */
import * as fs from 'fs';
import { DEFAULT_TASK_STATE_MACHINES } from '../lambda/src/lib/task-state-machines';
import * as path from 'path';
import { stripComments } from './helpers/strip-comments';
import { isDeliverableDocument, solicitsInput } from '../lambda/src/lib/async-processor-core';
import * as taskTracking from '../lambda/src/lib/task-tracking';
import { shouldMarkTaskCompleted } from '../lambda/src/lib/task-tracking';

/**
 * The live reply that forced the decision, verbatim shape: a heading, a table, "I have all the data
 * I need" in the opening - and an approval question at the very end. It was uploaded as the report
 * and the task was completed from `drafting_outline` while it was still asking.
 */
const OUTLINE_FOR_APPROVAL = `Got it — 1–2 page executive summary for the board. I have all the data I need. Here's the proposed outline:

---

## Proposed Outline: Q2 2026 ARR Performance — Board Executive Summary

| # | Section | Content |
|---|---------|---------|
| 1 | **Executive Headline** | Q2 ARR result vs. target, one-line narrative |
| 2 | **Key Metrics at a Glance** | Table: ARR, QoQ/YoY growth, NRR, gross churn, NPS, LTV/CAC |
| 3 | **Revenue Mix by Plan** | Enterprise / Professional / Starter breakdown with customer counts |
| 4 | **Q2 Highlights** | Top wins: Meridian close, Starter→Pro conversions, APAC first revenue |
| 5 | **Churn & Risk** | Gross churn rate, flagged accounts, mitigation actions |
| 6 | **Expansion Pipeline** | Near-term upsell opportunities (Meridian, Apex, Summit) |
| 7 | **Outlook & Board Decisions** | Revised FY target ($5.5M), Series B timing, key hires |

---

Does this structure work for you, or would you like me to add/remove any sections before I draft the full report?`;

describe('why the heuristic was demoted: the live fixture defeats it', () => {
  it('the outline-for-approval reads as a deliverable to the shape heuristic', () => {
    // NOT a bug in this assertion - it is the point. The fixture has a heading, a table and 500+
    // chars, and its approval question sits at the END where solicitsInput's opening window never
    // looks (its two-question signal is disabled by the heading/table on purpose). A predicate this
    // defeatable may observe, but must never decide an attachment or a completion.
    expect(isDeliverableDocument(OUTLINE_FOR_APPROVAL)).toBe(true);
    expect(solicitsInput(OUTLINE_FOR_APPROVAL)).toBe(false);
  });

  it('the machine gate answers the same fixture correctly: drafting_outline does not complete', () => {
    expect(shouldMarkTaskCompleted('report_generation', 'drafting_outline', DEFAULT_TASK_STATE_MACHINES)).toBe(false);
    expect(shouldMarkTaskCompleted('report_generation', 'generating', DEFAULT_TASK_STATE_MACHINES)).toBe(false);
    expect(shouldMarkTaskCompleted('report_generation', 'completed', DEFAULT_TASK_STATE_MACHINES)).toBe(true);
  });
});

describe('the second completion door stays removed (source ratchets)', () => {
  const processorSrc = stripComments(
    fs.readFileSync(path.join(__dirname, '../lambda/src/assistant-async-processor.ts'), 'utf8'),
  );

  it('task-tracking no longer exports the deliverable-walker', () => {
    // The walker force-completed a task the model did not complete. Reintroducing it under the same
    // name fails here; under a different name, the processor ratchets below still hold.
    expect((taskTracking as Record<string, unknown>).advanceDeliveredTaskToCompletion).toBeUndefined();
  });

  it('the processor holds no completeOnDelivery door', () => {
    expect(processorSrc).not.toMatch(/completeOnDelivery/);
    expect(processorSrc).not.toMatch(/advanceDeliveredTaskToCompletion/);
  });

  it('attachment keys on a DECLARED transition: no isDeliverableDocument in the generate decision', () => {
    // The heuristic may appear ONLY in the shadow log. Extract the delivery-decision region (from
    // the machine-derived delivery states to the battle round-1 override) and require every
    // surviving mention to be the shadow call.
    const start = processorSrc.indexOf('const mergedMachines');
    const end = processorSrc.indexOf('battleContext?.round === 1');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const region = processorSrc.slice(start, end);
    const mentions = region.match(/isDeliverableDocument/g) || [];
    const shadowMentions = region.match(/deliverable_shaped_without_declared_state/g) || [];
    expect(mentions.length).toBe(1);
    expect(shadowMentions.length).toBe(1);
    // Two doors, both machine-anchored, and both DECLARED: a transition that hands over a document,
    // or an in-state rewrite inside a delivering step, and in either case the file is the document the
    // turn declared (`document` on the advance, or `deliver_document`), never the reply. Then the
    // minimum artifact size. Nothing reads the reply's shape: the trailing-question veto that guarded
    // the in-state door is gone with the reply-as-document it guarded against. The English-opener
    // phrase list (solicitsInput) stays out of the live gate.
    expect(region).toMatch(/documentText = declaredDelivery \|\| inStateRewrite \? declaredDocument : ''/);
    expect(region).toMatch(/generate = documentText\.length >= 400/);
    expect(region).toMatch(/deliveryStates\.includes\(startState\)/);
    // THE ACTIVE TASK'S transitions. A tagged entry belongs to a task the model redirected to
    // (ADR-024 D7), and counting one here would read another task's movement as this one having
    // delivered.
    expect(region).toMatch(/transitions \?\? \[\]\)\.filter\(\(t\) => !t\.taskId\)\.some/);
    expect(region).not.toMatch(/solicitsInput/);
    expect(region).not.toMatch(/textBesideTaskAdvance/);
  });

  it('which states deliver comes from the MACHINE, not from a hardcoded list', () => {
    // The hardcoded per-taskType list of default-machine state names could never match a renamed
    // state or a new document-producing task type: every such deliverable shipped as unattached chat
    // text, silently. The `delivers` flag is read off the resolved machine instead.
    //
    // THE SOURCE THIS PINS MOVED WITH THE GLOBAL-WORKFLOWS DECISION (2026-09-20). It asserted the
    // literal per-assistant merge of taskStateMachines() with activeProfile.machines - a merge that no
    // longer exists, because a version cannot define a task graph. What the test actually protects is
    // that the flag comes from the MACHINE rather than a list, so it pins the resolver every consumer
    // now goes through.
    expect(processorSrc).not.toMatch(/DOC_DELIVERY_STATES/);
    // PINNED TO THE ONE RESOLUTION (ADR-047). This pinned a per-assistant merge, then a `workflowsFor`
    // narrowing; both are gone. The selection gates what may be OPENED, in the router, so the processor
    // resolves the turn's machines ONCE and every consumer reads that value - which is the property
    // worth holding here, because the defect this file guards is two consumers disagreeing.
    // The version's confirmation setting is applied to that one resolution (ADR-064 decision G), so every consumer still
    // reads the single value `taskStateMachines()` returns, resolved once.
    expect(processorSrc).toMatch(/const turnMachines = withConfirmBrief\(taskStateMachines\(\), activeProfile\.confirmBrief\)/);
    expect(processorSrc.match(/taskStateMachines\(\)/g)).toHaveLength(1);
    expect(processorSrc).toMatch(/mergedMachines = turnMachines/);
    expect(processorSrc).toMatch(/filter\(\(\[, d\]\) => deliversDocument\(d\)\)/);
  });

  it('the default machines declare exactly these delivery states', () => {
    // Exactly these states, no more, carry the flag. The extraction delivers only from `formatting`:
    // its records are shown for checking at `validating`, which awaits the person and so cannot
    // deliver (`validateTaskStateMachine`).
    const { DEFAULT_TASK_STATE_MACHINES } = jest.requireActual('../lambda/src/lib/task-state-machines');
    const flagged: Record<string, string[]> = {};
    for (const [type, machine] of Object.entries(DEFAULT_TASK_STATE_MACHINES) as [string, { states: Record<string, { produces?: string }> }][]) {
      const states = Object.entries(machine.states).filter(([, d]) => d.produces === 'document').map(([n]) => n);
      if (states.length) flagged[type] = states;
    }
    expect(flagged).toEqual({
      report_generation: ['generating', 'revising'],
      data_extraction: ['formatting'],
      // The task-based code deliverable and design intents (SPEC-CONFIGURABLE-INTENT-PACK, Appendix A).
      code_delivery: ['generating', 'revising'],
      technical_design: ['generating', 'revising'],
    });
  });
});

describe('every task-state writer is a DECLARATION (the exclusivity test §8 never had)', () => {
  it('advanceTaskStateTo has exactly the three declared callers, plus transport that proves it is transport', () => {
    // SPEC-TASK-STATE-TRANSITIONS §8's invariant table tests the behavior of the one authorized
    // path, but nothing tested that no OTHER writer exists - which is precisely how the removed
    // walker lived for a month: every hop it took was individually legal, so edge-level tests
    // passed while the one-writer rule was violated wholesale. This pins the caller set:
    //
    //   task-tools.ts x2      the model's advance_task_state tool, and the work-item
    //                         propose-and-confirm advance - both declared by the model
    //
    // `applyUserResponseToTask` USED TO BE A THIRD, on the argument that a user answering the step
    // that awaited them is a declaration too. It is not, and could not be: that function never reads
    // the message, so at `place_item.confirming` it read a correction and a decline as approvals and
    // moved the proposal to its SUCCESS terminal. It now hands the work back and advances nothing, so
    // §8's "state advances ONLY through advance_task_state" is literally true of the code.
    //
    // A new caller must be a DECLARATION by an actor that read what was said, never an inference from
    // structure or from what the output looked like. Add it here with that argument stated, or the
    // commit that adds it fails this test - which is the point.
    //
    //   assistant-async-processor.ts x1   the delivered-step close (maintainer, 2026-08-20)
    //
    // AND IT DOES NOT MEET THE RULE ABOVE, which is stated plainly rather than argued around. It is an
    // inference from structure: the machine declares the state `delivers`, a document was uploaded, so
    // the step is finished. No actor read anything.
    //
    // It is here because the owner ruled on what completion MEANS - "if the report is delivered it is
    // complete, unless the user objects with additional changes required" - and because telling the
    // MODEL that was tried first, deployed, verified present in the running bundle, and did not work:
    // every report afterwards still sat `in_progress` in `generating`, delivered and never advanced.
    // The instruction remains in the prompt; this is what makes the rule true when the model declines
    // to act on it.
    //
    // What keeps it away from the walker that was removed, and what a future reader must preserve if
    // they touch it:
    //   - gated on the machine's own `delivers` flag, NEVER on what the output looked like. That was
    //     the removed walker's defect, and it is the one this file exists to prevent;
    //   - refuses any state that AWAITS a party, so the `drafting_outline` case that walker broke
    //     cannot arise - `data_extraction.validating` delivers a draft AND expects an answer, and
    //     stays open;
    //   - ONE declared edge, and only when the machine names exactly one terminal successor. Two ways
    //     to finish is a choice, and a choice is not the runtime's to make.
    //
    // If that gating is ever loosened, this entry should be removed rather than widened: the value of
    // this test is that a third writer had to argue for itself in writing, and a fourth must too.
    //
    //   lib/queue-drain-task.ts x4        the drain's stage, and its close (maintainer, 2026-09-03)
    //
    // FOUR CALLS, TWO DECISIONS. One mirrors the stage. The other three are the close: it asks for
    // `settled`, and when the machine refuses - a drain that asked something sits in `clarifying` -
    // it walks the declared path `clearing` then `settled` rather than forcing past the refusal.
    // Three writes expressing ONE decision that the queue is empty, not three decisions; if that ever
    // becomes a choice about WHICH ending to take, it stops being covered by the argument below.
    //
    // THE ARGUMENT, since the rule above demands one. The danger this test guards is a workflow
    // advancing on inference while a PERSON's words were the only thing entitled to move it - the
    // removed walker read what the output looked like and closed steps nobody had answered.
    //
    // A drain cannot have that failure mode, and the reason is a property of the machine rather than
    // a promise about the code: `queue_drain` declares no `awaits` at any step (maintainer, 2026-09-03 -
    // a drain that waits is a queue that lives until somebody answers). There is no party whose
    // answer could be annexed, because no step of a drain is ever waiting for one. That is asserted
    // directly, in `a-step-declares-who-it-awaits.test.ts`, which names this machine as the single
    // shipped exception to every-machine-has-a-wait.
    //
    // Neither call is an inference from structure either:
    //   - the stage write MIRRORS a decision already made and validated elsewhere. The conditional
    //     advance on the turn record refuses an illegal predecessor and settles the real race; this
    //     runs only when that write ACCEPTED the move, so it adds no judgement of its own. Asking the
    //     machine a second time here is precisely what it declines to do;
    //   - the close is driven by an observed FACT with no reading in it - the queue is empty - and it
    //     is the same fact, at the same moment, that settles the notice a person is looking at.
    //
    // If a drain ever gains a waiting step, this entry must be removed rather than kept: the whole
    // argument above rests on there being none.
    //
    //   lib/async-processor-core.ts x1   the merge that a combination answered (maintainer, 2026-09-03)
    //
    // THE ARGUMENT. `queued_combination` asks two people whether their requests are one thing and who
    // would own the result. The model declares `merging` on a state that AWAITS a person, having read
    // their answer - so the decision is a person's, relayed by an actor that read what they said,
    // which is exactly what the rule above requires.
    //
    // This call is the step after: it advances `merging -> merged` once the merged item actually
    // exists. That is not an inference about what anybody meant. It is the runtime recording a fact it
    // observed about its OWN work - `mergeCombinedRequests` returned an id - and it is gated on that
    // id, so a failed merge leaves the task in `merging` rather than claiming a success with nothing
    // behind it. Recording it any other way would put the two halves out of step, which is the reason
    // `merging` is a declared state instead of something done quietly inside the transition.
    //
    // The state it advances FROM awaits nobody, so no answer can be annexed here.
    //
    //   lib/state-actions.ts x1           a declared step action's outcome edge (SPEC-TASK-STATE-TRANSITIONS FR29)
    //
    // THE ARGUMENT. A state that declares `action` is the workflow's author saying the step is the
    // platform's: the tool runs on entry, and `onSuccess` or `onFailure`, each a declared transition,
    // is where the task goes on its outcome. The edge is chosen by an observed FACT about the platform's
    // own work (the tool returned a result or an error), never by reading what anybody wrote, and the
    // state it advances FROM awaits nobody: validation refuses an action on a step that awaits somebody,
    // so there is no answer to annex. The entry is logged as `by: 'system'` with the action that caused
    // it, and a turn takes at most MAX_RUNTIME_MOVES_PER_TURN of them.
    //
    //   assistant-async-processor.ts +1    an event step's task, past the first step it ran (ADR-061 decision 8)
    //
    // THE ARGUMENT. An `agent` step that names `workflow:` has the runtime open a task in the room and run
    // its first step as the step's turn. Once that turn POSTED (an observed fact about the platform's own
    // work, the step's claim recorded `posted`, never a reading of what it said), the runtime takes the
    // first step's one declared transition, so the task rests on its next step as the room's work. It is
    // gated on the machine being one an event may open (`EVENT_TASK_MACHINES`), whose first step awaits
    // nobody, so there is no person whose answer could be annexed; on a fallback it advances nothing; and
    // a first step with two ways on is a choice the runtime does not make. Its premise is asserted below.
    const SRC = path.join(__dirname, '../lambda/src');
    const counts: Record<string, number> = {};
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) { walk(path.join(dir, entry.name)); continue; }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
        const full = path.join(dir, entry.name);
        const src = stripComments(fs.readFileSync(full, 'utf8'));
        // The lookbehind alone excludes the definition (`function advanceTaskStateTo(`).
        const calls = (src.match(/(?<!function )advanceTaskStateTo\(/g) || []).length;
        if (calls > 0) counts[path.relative(SRC, full).replace(/\\/g, '/')] = calls;
      }
    };
    walk(SRC);

    // ── TRANSPORT IS NOT A WRITER, AND IS SEPARATED RATHER THAN ADMITTED ────────────────────────
    //
    // The task store seam and the service behind it both name this function, and neither declares
    // anything: the store either forwards to the direct implementation or hands the same call across
    // a Lambda hop, and the service is the far end of that hop, reloading the row and calling the
    // real function. It is ONE declaration traveling, not two more of them.
    //
    // Widening the expected set to four names would be the wrong fix, and precisely the fix this test
    // exists to refuse: a genuine fourth writer added inside either file would then be invisible,
    // hiding behind an entry that was granted for routing. So they are listed apart and each is
    // required to PROVE it is transport - one call, and its arguments passed through rather than
    // constructed. A file that started deciding a target state would fail here even though its call
    // count never changed.
    const TRANSPORT = ['lib/task-store.ts', 'task-service.ts'];
    for (const file of TRANSPORT) {
      expect(counts[file]).toBe(1);
      const src = stripComments(fs.readFileSync(path.join(SRC, file), 'utf8'));
      const call = /(?<!function )advanceTaskStateTo\(([^;]*?)\)/s.exec(src);
      expect(call).not.toBeNull();
      // Forwarded whole (`(args)`) or spread (`{ task, ...rest }`). Either way the caller's own
      // decision arrives intact instead of being remade here.
      expect(call![1]).toMatch(/\.\.\.|^\s*args\s*$/);
      delete counts[file];
    }

    // THE DRAIN'S ENTRY CHECKS ITS OWN PREMISE. Its argument above is that no step of a drain ever
    // waits on anybody, so there is no answer to annex. A comment claiming that would rot the moment
    // somebody added an `awaits`, and the entry would go on being granted for a reason that had
    // stopped being true - so the premise is asserted here, beside the grant that depends on it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DEFAULT_TASK_STATE_MACHINES } = require('../lambda/src/lib/task-state-machines');
    const drainWaits = Object.entries(
      DEFAULT_TASK_STATE_MACHINES.queue_drain.states as Record<string, { awaits?: unknown }>,
    ).filter(([, def]) => def.awaits).map(([name]) => name);
    expect({ premise: 'a drain waits on nobody', waiting: drainWaits })
      .toEqual({ premise: 'a drain waits on nobody', waiting: [] });

    // THE EVENT TASK'S ENTRY CHECKS ITS OWN PREMISE: every machine an event may open starts on a step that awaits
    // nobody and has one way on.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EVENT_TASK_MACHINES } = require('../lambda/src/lib/event-workflow');
    for (const key of EVENT_TASK_MACHINES as string[]) {
      const m = DEFAULT_TASK_STATE_MACHINES[key] as { initial: string; states: Record<string, { awaits?: unknown; transitions: string[] }> };
      expect({ machine: key, awaits: m.states[m.initial].awaits, ways: m.states[m.initial].transitions.length })
        .toEqual({ machine: key, awaits: undefined, ways: 1 });
    }

    // THE CARD PRESS (ADR-063 decision 2) IS A PERSON'S DECISION RELAYED THROUGH THE TRANSPORT, never a new writer: the task
    // service's `advanceAsAssignee` forwards it through `advanceTask`, the one call above, only along a choice the state
    // declares, and a state may declare choices only where it awaits somebody, so the move is the awaited person's own. The
    // premise is asserted here, beside the route that depends on it.
    const service = stripComments(fs.readFileSync(path.join(SRC, 'task-service.ts'), 'utf8'));
    const cardPress = service.slice(service.indexOf('export async function advanceAsAssignee('), service.indexOf('async function cancelForDeadline('));
    expect(cardPress).toMatch(/await advanceTask\(\{/);
    expect(cardPress).not.toMatch(/advanceTaskStateTo\(/);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { awaitedPartyOf } = require('../lambda/src/lib/task-state-machines');
    const unawaitedChoices = Object.entries(DEFAULT_TASK_STATE_MACHINES as Record<string, { states: Record<string, { choices?: string[] }> }>)
      .flatMap(([m, def]) => Object.entries(def.states).filter(([, st]) => st.choices && !awaitedPartyOf(st)).map(([s]) => `${m}.${s}`));
    expect({ premise: 'a choice is put to the party a step awaits', unawaitedChoices }).toEqual({ premise: 'a choice is put to the party a step awaits', unawaitedChoices: [] });

    // What is left is the DECLARED set, unchanged.
    expect(counts).toEqual({
      'lib/task-tools.ts': 2,
      'assistant-async-processor.ts': 2,
      'lib/queue-drain-task.ts': 4,
      'lib/async-processor-core.ts': 1,
      'lib/state-actions.ts': 1,
    });
  });
});

describe('the attachment bytes declare their encoding', () => {
  it('generateAndUploadDocument uploads text/markdown with charset=utf-8', () => {
    // The fixture's own em-dashes rendered as mojibake in the live report because the upload said
    // 'text/markdown' with no charset and the viewer fell back to windows-1252.
    const coreSrc = fs.readFileSync(
      path.join(__dirname, '../lambda/src/lib/async-processor-core.ts'), 'utf8',
    );
    // A code file carries its own type (`fileForAnswer`, also with a charset); the Markdown default keeps one.
    expect(coreSrc).toMatch(/ContentType: file\?\.contentType \|\| 'text\/markdown; charset=utf-8'/);
    expect(coreSrc).not.toMatch(/ContentType: 'text\/markdown',/);
  });
});
