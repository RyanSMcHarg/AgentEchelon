/**
 * A PLAIN REPLY GOES TO THE WORK IT IS ABOUT, NOT THE NEWEST (maintainer, 2026-09-04; ADR-024 D7).
 *
 * The router resumed `getAssigneeChannelTasks(...).live[0]`, which is newest-first. Holding more than one
 * open piece of work is ordinary rather than exotic - a long request opens a `report_generation` in
 * `collecting_requirements` while a queued message opens a `queued_clarification` in `asked` - so an
 * unaddressed reply went to whichever happened to be newer.
 *
 * Measured on the turn-queue e2e: of fourteen answers applied, TWELVE went to
 * `collecting_requirements` and one to `asked`. The clarification the assistant had just asked about
 * stayed open while the person believed they had answered it.
 *
 * Two rules are pinned here, and they are different in kind:
 *
 *   - RANKING is deterministic and testable: this assistant's own chain first, then work in flight
 *     ahead of a question parked awaiting a reply, and recency only as a tiebreak between things the
 *     first two cannot separate.
 *   - DECIDING is the model's, because it needs the message, and the runtime never has it here. What
 *     a test can pin is that the choice is OFFERED - a closed set, a tool that can name one of them,
 *     and permission to ask instead.
 */
import {
  rankReferentCandidates,
  buildReferentHint,
  MAX_REFERENT_CANDIDATES,
  type ReferentCandidate,
} from '../../lambda/src/lib/task-referent';
import { taskToolSpecsFor } from '../../lambda/src/lib/task-tools';
import type { TaskStateMachine } from '../../lambda/src/lib/task-state-machines';

const ATLAS = 'atlas-principal-id';
const NOVA = 'nova-principal-id';

/** Two states, one parked on the person and one the assistant still owes. */
const MACHINES: Record<string, TaskStateMachine> = {
  report_generation: {
    initial: 'collecting_requirements',
    states: {
      collecting_requirements: { transitions: ['drafting'], awaits: { party: 'requester' } },
      drafting: { transitions: ['done'] },
      done: { transitions: [], terminal: 'success' },
    },
  },
  queued_clarification: {
    initial: 'asked',
    states: {
      asked: { transitions: ['answered'], awaits: { party: 'requester' } },
      answered: { transitions: [], terminal: 'success' },
    },
  },
};

const candidate = (over: Partial<ReferentCandidate>): ReferentCandidate => ({
  taskId: 't1',
  taskType: 'report_generation',
  taskState: 'collecting_requirements',
  assistantId: ATLAS,
  // Shared explicitly: an absent visibility reads as private.
  visibility: 'conversation',
  updatedAt: '2026-09-04T10:00:00.000Z',
  ...over,
});

const rank = (cs: ReferentCandidate[]) =>
  rankReferentCandidates(cs, { assistantId: ATLAS, machines: MACHINES }).map((c) => c.taskId);

describe('which of their open items a reply is ranked against', () => {
  it('puts work IN FLIGHT ahead of a question parked awaiting them', () => {
    // The owner's rule, and the inversion that matters: `awaits` had become the strongest signal
    // available, because it was the license to read a message as an answer at all. A question parked
    // a while is one they may have moved on from; work in flight is the live thread between them.
    expect(rank([
      candidate({ taskId: 'parked', taskState: 'asked', taskType: 'queued_clarification' }),
      candidate({ taskId: 'in-flight', taskState: 'drafting' }),
    ])).toEqual(['in-flight', 'parked']);
  });

  it('does not decide on recency, which is a fact about the work and not about the message', () => {
    // The defect exactly: the newer row won regardless. Here the newer one is parked and the older is
    // in flight, so a recency-first ordering returns the opposite of this.
    expect(rank([
      candidate({ taskId: 'newer-parked', taskState: 'asked', taskType: 'queued_clarification', updatedAt: '2026-09-04T12:00:00.000Z' }),
      candidate({ taskId: 'older-live', taskState: 'drafting', updatedAt: '2026-09-04T09:00:00.000Z' }),
    ])).toEqual(['older-live', 'newer-parked']);
  });

  it('still uses recency to break a tie the rules cannot', () => {
    // Kept, because an unstable order would make the assumed pick flap between turns for no reason.
    expect(rank([
      candidate({ taskId: 'older', updatedAt: '2026-09-04T09:00:00.000Z' }),
      candidate({ taskId: 'newer', updatedAt: '2026-09-04T12:00:00.000Z' }),
    ])).toEqual(['newer', 'older']);
  });

  it("puts this assistant's own chain first, ahead of even that", () => {
    // An OWNERSHIP rule, not a likelihood one, which is why it outranks the others: two duel sides can
    // wait on the same person at once, and a side reading its rival's question as the one it just got
    // answered is not a worse guess but a different assistant's work.
    expect(rank([
      candidate({ taskId: 'theirs-live', assistantId: NOVA, taskState: 'drafting' }),
      candidate({ taskId: 'mine-parked', assistantId: ATLAS, taskState: 'asked', taskType: 'queued_clarification' }),
    ])).toEqual(['mine-parked', 'theirs-live']);
  });
});

describe('the choice is offered to the turn, which is the only thing holding the message', () => {
  const two = [
    candidate({ taskId: 'report-1', requestExcerpt: 'a headcount report for Q3' }),
    candidate({ taskId: 'clarify-1', taskType: 'queued_clarification', taskState: 'asked', requestExcerpt: 'the onboarding one' }),
  ];

  it('names each option so the assistant can ask in words rather than ids', () => {
    const hint = buildReferentHint(two, { provisionalTaskId: 'report-1', machines: MACHINES });
    expect(hint).toContain('a headcount report for Q3');
    expect(hint).toContain('the onboarding one');
    expect(hint).toContain('report-1');
    expect(hint).toContain('clarify-1');
  });

  it('tells it that asking is the right answer when it cannot tell', () => {
    // The whole point. A model told only "pick one" picks one; the instruction that makes this an
    // improvement rather than a differently-ranked guess is the permission not to.
    const hint = buildReferentHint(two, { provisionalTaskId: 'report-1', machines: MACHINES });
    expect(hint).toMatch(/ASK them which they meant/);
    expect(hint).toMatch(/do not advance anything/i);
  });

  it('marks the runtime ordering as an assumption, not an answer', () => {
    const hint = buildReferentHint(two, { provisionalTaskId: 'report-1', machines: MACHINES });
    expect(hint).toContain('[assumed]');
    expect(hint).toMatch(/starting point, not an answer/);
  });

  it('says nothing at all when there is nothing to choose between', () => {
    // A hint on every turn teaches the model to ask on turns where nothing was ambiguous, which is
    // this defect pointing the other way.
    expect(buildReferentHint([two[0]!], { machines: MACHINES })).toBe('');
    expect(buildReferentHint([], { machines: MACHINES })).toBe('');
  });

  it('never puts a private request\'s words in a prompt whose reply the room reads', () => {
    const hint = buildReferentHint([
      candidate({ taskId: 'open-1', requestExcerpt: 'the Q3 headcount' }),
      candidate({ taskId: 'private-1', visibility: 'private', requestExcerpt: 'my salary band review' }),
    ], { machines: MACHINES });
    expect(hint).not.toContain('salary band');
    // Still listed, because it is still something their message might be about - counted, not described.
    expect(hint).toContain('private-1');
    expect(hint).toContain('a private request of theirs');
  });

  it('reads a candidate with no visibility as private, and names it without its words', () => {
    // Absent fails closed: a task written before its targeting was known must not
    // put the person's words in a prompt whose reply the room reads.
    const hint = buildReferentHint([
      candidate({ taskId: 'open-1', requestExcerpt: 'the Q3 headcount' }),
      candidate({ taskId: 'unknown-1', visibility: undefined, requestExcerpt: 'my salary band review' }),
    ], { machines: MACHINES });
    expect(hint).toContain('the Q3 headcount');
    expect(hint).not.toContain('salary band');
    expect(hint).toContain('a private request of theirs');
  });

  it('is bounded, so a person with a long backlog does not fill the prompt with it', () => {
    const many = Array.from({ length: MAX_REFERENT_CANDIDATES + 3 }, (_, i) =>
      candidate({ taskId: `t${i}`, requestExcerpt: `request number ${i}` }));
    const hint = buildReferentHint(many, { machines: MACHINES });
    expect(hint).toContain('request number 0');
    expect(hint).not.toContain(`request number ${MAX_REFERENT_CANDIDATES + 2}`);
  });
});

describe('and it can act on what it decided', () => {
  const idsOf = (spec: ReturnType<typeof taskToolSpecsFor>[number]) =>
    (spec.toolSpec.inputSchema.json.properties as Record<string, { enum?: string[] }>).task_id?.enum;

  it('offers task_id as a CLOSED set when several are open', () => {
    // An enum rather than a free string: the value drives a write to a named row, so the outcomes are
    // closed and every member is work the router found in this person's own partition. A free field
    // would let an id the model composed - or one somebody typed into a message - reach a task lookup.
    const [spec] = taskToolSpecsFor('report_generation', MACHINES, 'collecting_requirements', ['a', 'b']);
    expect(idsOf(spec!)).toEqual(['a', 'b']);
  });

  it('offers NO task_id at all on an ordinary single-task turn', () => {
    // The single-task turn's tool must be exactly what it always was: an optional redirect offered
    // where there is nowhere to redirect to is an invitation to redirect for no reason.
    const [one] = taskToolSpecsFor('report_generation', MACHINES, 'collecting_requirements', ['only-one']);
    expect(idsOf(one!)).toBeUndefined();
    const [none] = taskToolSpecsFor('report_generation', MACHINES, 'collecting_requirements');
    expect(idsOf(none!)).toBeUndefined();
  });

  it('keeps the choice on the variant that also collects requirements', () => {
    // Two return paths build this tool - with and without a step's declared `requires` - and only one
    // of them being able to name a task would make the redirect available on some steps and not
    // others, for a reason nobody could see from the prompt.
    const withRequires: Record<string, TaskStateMachine> = {
      report_generation: {
        initial: 'collecting_requirements',
        states: {
          collecting_requirements: {
            transitions: ['drafting'],
            awaits: { party: 'requester' },
            requires: ['the audience'],
          },
          drafting: { transitions: [] },
        },
      },
    };
    const [spec] = taskToolSpecsFor('report_generation', withRequires, 'collecting_requirements', ['a', 'b']);
    expect(idsOf(spec!)).toEqual(['a', 'b']);
    expect(spec!.toolSpec.description).toContain('the audience');
  });
});

/**
 * ── AND THE REDIRECT ACTUALLY MOVES THE NAMED TASK ───────────────────────────────────────────────
 *
 * A SOURCE GUARD, for the reason the neighbouring queue rules are pinned the same way: the branch
 * lives inside the Converse tool loop, which takes a live Bedrock result and is not invocable from a
 * unit test. What a source guard can still pin is what was decided - that the id is checked against
 * the router's allowlist rather than trusted, and that the write lands on the task the model named
 * rather than on the one the router assumed.
 *
 * Both are silent when broken. Trusting the id turns a model's output into a row selector; writing to
 * the assumed task anyway makes the whole choice cosmetic - the model names one, the runtime moves the
 * other, and the reply says the right thing happened.
 */
describe('the task the model named is the one that moves', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const core: string = fs.readFileSync(
    path.resolve(__dirname, '../..', 'lambda/src/lib/async-processor-core.ts'),
    'utf8',
  );

  const check = core.indexOf('(taskContext.referentCandidateIds ?? []).includes(named)');
  const advance = core.indexOf('await handleAdvanceTaskStateTool({');

  it('checks the named id against the router\'s allowlist', () => {
    // Non-vacuity for the ordering assertion below, and the rule itself: the enum in the tool schema
    // constrains a model, which is not a boundary. What makes this safe is that the id came from the
    // ROUTER's read of this person's own partition in this conversation.
    expect(check).toBeGreaterThan(-1);
    expect(advance).toBeGreaterThan(-1);
  });

  it('checks BEFORE it advances anything', () => {
    expect(check).toBeLessThan(advance);
  });

  it('advances the target rather than the assumed task', () => {
    // `targetTask` is `taskContext.task` whenever the model named nothing, so the ordinary turn is
    // unchanged - but the write, the details and the merge must all follow the redirect when there is
    // one. Advancing `taskContext.task` here would make the redirect a log line.
    expect(core).toContain('const targetTask = redirected ?? taskContext.task;');
    expect(core).toContain('task: targetTask,');
    expect(core).toContain('targetTask.taskState = result.to;');
  });

  it('falls back to the assumed task when the named row cannot be read', () => {
    // Not to "advance nothing": a redirect that silently became a no-op would leave the model
    // believing it had moved something, and the reply saying so.
    expect(core).toContain('? await getTask(named, taskContext.task.channelArn).catch(() => null)');
  });
});

/**
 * ── AND IT KNOWS WHERE THE ONE IT NAMES CAN GO (live evidence, 2026-09-04) ───────────────────────
 *
 * The first build of this offered the redirect without saying anything about the named item's
 * machine. Observed on the turn-queue e2e: the model correctly determined the message was about a
 * different piece of work, named it, and asked for a `to_state` belonging to the machine of the task
 * the turn STARTED on. The two are different types, so the transition was refused.
 *
 * The tool already echoes `legal_transitions` on a refusal so a model can self-correct in the same
 * loop. It had no iteration left to do it in - that call was the last of three - so the turn produced
 * no text and the person got the generic fallback line rather than the assistant's answer.
 *
 * The determination was RIGHT and the turn was still degraded, which is the worst shape a fix can
 * take: the new capability firing exactly as designed and costing the reply. Hence the states are
 * named up front, where they cost no iteration, rather than only in the error that follows a wasted one.
 */
describe('a candidate says where it can go', () => {
  it('names the legal next states of EACH item, from its own machine', () => {
    const hint = buildReferentHint([
      candidate({ taskId: 'report-1', requestExcerpt: 'the Q3 report' }),
      candidate({
        taskId: 'clarify-1',
        taskType: 'queued_clarification',
        taskState: 'asked',
        requestExcerpt: 'the onboarding one',
      }),
    ], { provisionalTaskId: 'report-1', machines: MACHINES });

    // `report_generation.collecting_requirements -> drafting`, and the clarification's own exit.
    expect(hint).toContain('drafting');
    expect(hint).toContain('answered');
  });

  it('tells it not to reuse the assumed task\'s states, which is the mistake that was made', () => {
    const hint = buildReferentHint([
      candidate({ taskId: 'report-1' }),
      candidate({ taskId: 'clarify-1', taskType: 'queued_clarification', taskState: 'asked' }),
    ], { provisionalTaskId: 'report-1', machines: MACHINES });
    expect(hint).toMatch(/never from the one the turn started on/);
  });

  it('says nothing about transitions for a terminal item, rather than inventing one', () => {
    const hint = buildReferentHint([
      candidate({ taskId: 'done-1', taskState: 'done' }),
      candidate({ taskId: 'open-1', taskState: 'drafting' }),
    ], { machines: MACHINES });
    // `done` declares no transitions, so it gets no "can move to" clause at all.
    expect(hint).toMatch(/`done-1`[^\n]*\(done\)[^\n]*$/m);
    expect(hint).not.toMatch(/`done-1`[^\n]*can move to/);
  });
});

/**
 * ── THE LIST HAS SOMETHING TO RANK (maintainer, 2026-09-04) ───────────────────────────────────────────
 *
 * The ranking rule above is only worth anything if the list it sorts can contain both kinds of work.
 * The first build fed it `heldByPerson` alone - and a task is owned by the person ONLY when its state
 * awaits them, so every candidate was parked by construction and "active outranks awaiting" could
 * never fire. The rule was inert, and every test of it passed, because they build their candidates by
 * hand.
 *
 * This is the guard that a hand-built fixture cannot give: the ROUTER's list is assembled from both
 * the person-held rows and the work this assistant is running here.
 *
 * A SOURCE GUARD because the router is not invocable from a unit test, same as the neighbouring queue
 * rules. What it pins is the composition and the scoping, which are the two decisions.
 */
describe('the router builds the list from both kinds of work', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const router: string = fs.readFileSync(
    path.resolve(__dirname, '../..', 'lambda/src/router-agent-handler.ts'),
    'utf8',
  );

  it('combines the assignee-held rows with the ones this person OWNS here', () => {
    // The fix for the inert rule. `heldByPerson` is the assignee partition, and a person is the
    // assignee only while a step awaits them, so on its own it can only ever offer parked work.
    // The owner-scoped read is what puts work in flight in the set (ADR-024 D8).
    expect(router).toContain('...ownedHere.filter((o) => !heldByPerson.some((h) => h.taskId === o.taskId))');
    expect(router).toContain('candidateRows.map((t) => ({');
  });

  it('asks through the service, where the classification boundary is applied first', () => {
    // Not the table. The service refuses a conversation above its own classification BEFORE reading,
    // which is the layer that makes the owner narrowing a second check rather than the only one
    // (tenet D3). Reaching around it would leave one layer where the tenet asks for two.
    expect(router).toContain('referentCandidatesFor({');
    expect(router).toContain("import { referentCandidates as referentCandidatesFor } from './lib/task-store.js';");
  });

  it('carries the owner from the speaker rather than composing one', () => {
    // `personId` is derived from the message sender, which Amazon Chime SDK stamps - never from
    // anything the person typed. An actor is only ever asked about as itself.
    expect(router).toContain('ownerPersonId: personId,');
  });
  it('reads them only when the person already holds something, named an item, or the turn declared one', () => {
    // With nothing held there is nothing to be ambiguous WITH, so this must not become a read on
    // every turn in the deployment. Two other cases qualify:
    //   - a message starting with `#<n>` (ADR-035): an item the person owns while the assistant
    //     holds the step is answerable by reference too;
    //   - a turn carrying a declared task id, which the flow resolved and handed over. That is NOT
    //     a second permission path - it is intersected with what the person holds or owns here, so
    //     an id naming anything else finds nothing, exactly as a reference to anything else does.
    //
    // The third condition arrived with the attribution work and this guard was not updated with it,
    // so it pinned a two-condition string that no longer existed and failed on a change that was
    // correct. The assertion below names the three triggers rather than one exact spelling.
    expect(router).toContain('(heldByPerson.length || reference || declaredTaskId) && channelArn && personId');
  });

  it('does not fail the turn when that read fails', () => {
    // A referent hint is an improvement to a turn, never a precondition for one.
    expect(router).toContain('.catch(() => null)');
  });
});

/**
 * A SET THE MODEL MAY WRITE THROUGH EXCLUDES OTHER ASSISTANTS' WORK (code review, 2026-09-04).
 *
 * Ranking rule 1 puts this assistant's chains first, and for a while that was all that happened to a
 * rival's chain: it was demoted, not removed. The candidate ids become the `task_id` enum, and
 * `advance_task_state` validates transition legality rather than whose work it is - so a model naming
 * a rival id would have moved another assistant's task.
 *
 * Demoting is right for an ORDERING and wrong for an ALLOWLIST. The two duel sides that rule 1 cites
 * are the case: both wait on the same person at once, and one side must not be able to advance the
 * other's chain because a message was ambiguous.
 *
 * Routing is unaffected: a foreign chain is still handed to the assistant that owns it, on the branch
 * above this filter.
 */
describe('the writable candidate set', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const router: string = fs.readFileSync(
    path.resolve(__dirname, '../..', 'lambda/src/router-agent-handler.ts'),
    'utf8',
  );

  it('excludes chains belonging to another assistant, rather than only ranking them lower', () => {
    expect(router).toContain('.filter((t) => !t.assistantId || t.assistantId === self);');
  });

  it('keeps a row that predates `assistantId`, so the set is not narrower than what it replaced', () => {
    // Absent means the field did not exist when the row was written, not that it belongs to somebody
    // else. Dropping those would lose live work from the set the moment the migration began.
    expect(router).toContain('!t.assistantId ||');
  });

  it('and the ranking still only ORDERS, which is why the filter had to exist', () => {
    // Pinning the division of labor: `rankReferentCandidates` returns everything it is given, in an
    // order. If it ever started dropping candidates, this test and the filter above would both be
    // describing a rule that had moved somewhere else.
    const ranked = rankReferentCandidates([
      candidate({ taskId: 'mine', assistantId: ATLAS }),
      candidate({ taskId: 'theirs', assistantId: NOVA }),
    ], { assistantId: ATLAS, machines: MACHINES });
    expect(ranked.map((c) => c.taskId)).toEqual(['mine', 'theirs']);
  });
});
