/**
 * THE DELIVERY CONTRACT IS DECLARED, NOT INFERRED (owner decision 2026-08-18).
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
    expect(shouldMarkTaskCompleted('report_generation', 'drafting_outline')).toBe(false);
    expect(shouldMarkTaskCompleted('report_generation', 'generating')).toBe(false);
    expect(shouldMarkTaskCompleted('report_generation', 'completed')).toBe(true);
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
    // Two doors, both machine-anchored, plus the minimum artifact size: a DECLARED transition, or
    // an in-state rewrite - a follow-up inside a delivering state has no legal transition to
    // declare, and requiring one posted whole rewritten reports as chat walls. The in-state door
    // carries the trailing-question veto, the one language-neutral structural residue of the
    // retired heuristic (the live incident that demoted it ended with exactly such a question).
    // The English-opener phrase list (solicitsInput) stays out of the live gate.
    expect(region).toMatch(/generate = \(declaredDelivery \|\| inStateRewrite\) && trimmedResponse\.length >= 400/);
    expect(region).toMatch(/deliveryStates\.includes\(startState\)/);
    expect(region).toMatch(/transitions \?\? \[\]\)\.length === 0/);
    expect(region).not.toMatch(/solicitsInput/);
  });

  it('which states deliver comes from the MACHINE, so per-profile machines can declare their own', () => {
    // The hardcoded per-taskType list of default-machine state names could never match a renamed
    // state or a new document-producing task type: every such deliverable shipped as unattached chat
    // text, silently. The machines are merged the same way the advance tool's authorization merges
    // them, and the `delivers` flag is read off the merged machine.
    expect(processorSrc).not.toMatch(/DOC_DELIVERY_STATES/);
    expect(processorSrc).toMatch(/\{ \.\.\.taskStateMachines\(\), \.\.\.\(activeProfile\.machines \?\? \{\}\) \}/);
    expect(processorSrc).toMatch(/filter\(\(\[, d\]\) => d\.delivers\)/);
  });

  it('the default machines declare the same delivery states the retired list named', () => {
    // The refactor must be behavior-preserving for the default deployment: exactly these states, no
    // more, carry the flag.
    const { DEFAULT_TASK_STATE_MACHINES } = jest.requireActual('../lambda/src/lib/task-state-machines');
    const flagged: Record<string, string[]> = {};
    for (const [type, machine] of Object.entries(DEFAULT_TASK_STATE_MACHINES) as [string, { states: Record<string, { delivers?: boolean }> }][]) {
      const states = Object.entries(machine.states).filter(([, d]) => d.delivers).map(([n]) => n);
      if (states.length) flagged[type] = states;
    }
    expect(flagged).toEqual({
      report_generation: ['generating', 'revising'],
      data_extraction: ['extracting', 'validating', 'formatting'],
    });
  });
});

describe('every task-state writer is a DECLARATION (the exclusivity test §8 never had)', () => {
  it('advanceTaskStateTo has exactly the three declared callers', () => {
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
    //   assistant-async-processor.ts x1   the delivered-step close (owner, 2026-08-20)
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
    expect(counts).toEqual({
      'lib/task-tools.ts': 2,
      'assistant-async-processor.ts': 1,
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
    expect(coreSrc).toMatch(/ContentType: 'text\/markdown; charset=utf-8'/);
    expect(coreSrc).not.toMatch(/ContentType: 'text\/markdown',/);
  });
});
