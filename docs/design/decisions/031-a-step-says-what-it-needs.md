---
title: "ADR-031: A step says what it needs, and an answer is checked against it"
status: Accepted 2026-08-14 (owner). Built and deployed; not verified live.
date: 2026-08-14
related:
  - "./024-task-ownership.md"
  - "./026-task-shaped-battle-rounds.md"
  - "./030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md"
  - "../../../backend/lambda/src/lib/task-state-machines.ts"
  - "../../../backend/lambda/src/lib/task-tracking.ts"
  - "../../../backend/lambda/src/lib/task-tools.ts"
  - "../../../backend/lambda/src/assistant-async-processor.ts"
tracking: |
  Adds the SEMANTIC half of answering a waiting step. `applyUserResponseToTask` stays structural and
  unchanged; this decision does not move the judgement into it. The check is a model instruction
  carried in the task grounding, so it is shaped by the prompt and is not a guarantee the machine
  enforces - stated plainly in "What is enforced and what is instructed" below.
---

# ADR-031: A step says what it needs, and an answer is checked against it

## Status

**Accepted (owner, 2026-08-14). Built and deployed to the dev deployment. NOT verified live.**

`Verified by:` `test/lib/step-needs-are-checked.test.ts` (12 tests). Those assert the declarations, the
validation, and that the rule reaches the model. They cannot assert that a model follows it, and no
live e2e exercises a partial answer yet.

## Problem and who it's for

Someone asks for a report, is asked what they want, gives part of an answer, and gets a finished report
that is not for them.

They said "make it about our Q3 numbers". Nobody asked who it was for or how long it should be, and the
report was written anyway: to no particular audience, in no particular shape. From their side the
assistant asked a question, received a partial answer, and ploughed on as though it had everything.
It reads as not having been listened to.

The mirror of it is as bad and comes from the same gap. An assistant that re-asks the whole question
after a partial answer has also not listened, and one that keeps asking after the person has said "you
choose" will not take yes for an answer.

## Context

A state that declares `awaits` says the machine is blocked on a party. It has never said what would
unblock it. So nothing anywhere could tell a complete answer from a partial one, and a step with a
single exit advanced on whatever arrived first. `report_generation.collecting_requirements` is that
step, and it is the common case rather than a corner.

`applyUserResponseToTask` is explicit that its own check is STRUCTURAL and cannot read content:

> a state with several exits is a decision the ANSWER's content settles, which this cannot read.

That is correct and stays correct. Only the answer's content can say whether it named an audience, and
a keyword test for that is the sort of thing that passes on "no particular audience".

## Decision

**A state declares what it needs, and the person's answer is reviewed against that. Everything there,
the workflow moves on. Something missing, the assistant asks for THAT and only that.**

### `requires`

A new optional field on a state definition: what the person still owes before the step can move on.

```ts
collecting_requirements: {
  transitions: ['drafting_outline'],
  awaits: { party: 'requester' },
  requires: ['the subject', 'the audience', 'the length or format'],
},
```

Written in the PERSON's vocabulary, not the schema's, because it is read back to them when something
is missing. `'the audience'` is a sentence; `'audienceType'` is a field name.

Declared on the three requirements-gathering steps that the problem above describes:

| Machine | State | Needs |
|---|---|---|
| `report_generation` | `collecting_requirements` | the subject, the audience, the length or format |
| `data_extraction` | `collecting_requirements` | what data to pull, where it comes from, the output format |
| `guided_troubleshooting` | `collecting_symptoms` | what is going wrong, when it started, what they have already tried |

Absent everywhere else, deliberately. `awaiting_result` ("did that fix it?") declares nothing, because
the outcome IS the answer and asking someone to elaborate on "that worked" is the assistant not
listening in the other direction. A confirmation step is the same.

### The three branches

Rendered into the task grounding, so the model applies them on the turn that has the person's text:

1. **Everything there** ⇒ call `advance_task_state` and get on with the work. Do not ask them to
   confirm what they have already said.
2. **Something missing** ⇒ ask for ONLY the missing part, in one short question, and do NOT advance.
   Do not re-ask for anything already given, and do not restate the whole list back at them.
3. **They decline to specify, or tell you to choose** ⇒ **that is an answer.** Say what you are
   assuming and move on. Do not ask again.

Branch 3 is not a refinement of branch 2; without it the rule becomes a loop. "You pick" leaves the
item unfilled, so a model applying branch 2 faithfully asks again, and again. An assistant that will
not take yes for an answer is worse than one that advanced too early, because the person cannot get
past it. Saying the assumption out loud is what keeps it recoverable: they can correct a stated
assumption, and cannot correct a silent one.

## What is enforced and what is instructed

This distinction is the whole reason to read this section, because the two are easy to conflate and
they fail differently.

**Enforced, in code:**

- `requires` is only rendered for a state that awaits somebody AND declares one. A step the workflow is
  getting on with by itself never produces a checklist.
- Machine validation REJECTS `requires` on a state that awaits nobody (there would be no one holding
  what it asks for) and on a state marked `resolvedByOneResponse` (the two flags contradict: advance on
  any answer, and withhold until the list is satisfied).
- The needs are read from the machines the turn is actually running, so a profile that declares its own
  step is grounded from its own declaration rather than the deployment pack's.
- The tool name in the instruction comes from the same constant the loop dispatches, so the prompt
  cannot tell a model to call a tool by a name that no longer exists.

**Instructed, to the model:** the judgement itself, and all three branches. Whether an answer satisfies
the list, what counts as missing, and whether "you pick" was said, are read by the model from the
person's text. There is no structural gate behind it. `applyUserResponseToTask` is UNCHANGED, so a
state that is `resolvedByOneResponse` still advances on any reply and a state with several exits still
defers to the model exactly as before.

The practical consequence: a model that ignores the instruction advances early, which is the behaviour
this replaces, rather than a new failure. The decision buys a strong default, not a guarantee, and a
test asserting "an incomplete answer never advances the workflow" would be asserting something the
system does not promise.

## Alternatives considered

**Judge sufficiency in the router, before the turn is dispatched.** Cheaper when an answer is plainly
incomplete, and it could short-circuit without a full turn. Rejected: the router has not resolved the
profile or its model at that point, so the judgement would be weaker than the one the worker is about
to make anyway, and it would put a second semantic reader on the path with no way to keep the two
agreeing.

**Structural completion, by matching `requires` against collected `details`.** Rejected: it moves the
judgement to whatever populates `details`, which is the same model, one step removed, and it would
report a step complete because a field is non-empty. "No particular audience" fills the field.

**Accept partial answers and flag gaps in the output.** Rejected by the owner: it is what currently
produces a report written to nobody.

## Consequences

- Every workflow gets this from one declaration. There is no per-feature sufficiency check, and adding
  a step's needs is a data change rather than code.
- A step with no `requires` behaves exactly as it does today, so this is opt-in per state and the
  default is unchanged.
- A profile author writing a custom machine can declare needs for their own steps and gets the same
  behaviour, because the grounding follows the machines the turn runs.
- `ADVANCE_TASK_STATE_TOOL_NAME` moves to `task-state-machines.ts`, which imports nothing, so both the
  prompt builder and the tool loop can read one constant without a module cycle.

## How this gets proven

| Invariant | The test that can fail |
|---|---|
| A waiting step's needs reach the model | Assert the rendered grounding names each declared need |
| A step that awaits nobody has no checklist | A mid-flow state; assert no needs section |
| A step with no needs is unchanged | A confirmation step; assert no needs section and the rest of the grounding intact |
| The tool is named from the constant | Assert the grounding contains `ADVANCE_TASK_STATE_TOOL_NAME`, not a literal |
| Only the missing part is asked for | Assert the instruction says so and forbids re-asking |
| A refusal is an answer | Assert the instruction covers "tell you to choose" and forbids asking again |
| Needs follow the profile's machine | Ground with a custom machine; assert its needs appear and the pack's do not |
| Needs cannot be unmeetable | Validate a machine declaring needs on a state that awaits nobody, and one marked `resolvedByOneResponse`; assert both are rejected |
| The shipped machines are valid, and populated | Validate every default machine, and assert the requirements-gathering steps declare something |
