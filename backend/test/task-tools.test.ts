/**
 * In-Lambda task tools (SPEC-TASK-STATE-TRANSITIONS §3). Verifies which specs get registered for a
 * task type and the advance_task_state dispatch: a legal call is authorized, an illegal one echoes
 * the legal set for self-correction, and a missing target is rejected — all without a persistence
 * backend (TASKS_TABLE unset).
 */
import {
  ADVANCE_TASK_STATE_TOOL_NAME,
  ADVANCE_TASK_STATE_TOOL_SPEC,
  taskHasMachine,
  taskToolSpecsFor,
  handleAdvanceTaskStateTool,
  handleDeliverDocumentTool,
  DELIVER_DOCUMENT_TOOL_NAME,
  proposalAdvancesPlaceItem,
  advancePlaceItemOnProposal,
  type TaskLoopContext,
} from '../lambda/src/lib/task-tools.js';
import { toolStepOutcome } from '../lambda/src/lib/analytics-metadata.js';
import { type Task } from '../lambda/src/lib/task-tracking.js';
import { DEFAULT_TASK_STATE_MACHINES, deliversDocument } from '../lambda/src/lib/task-state-machines';
import { DeliveryOption } from '../lambda/src/lib/delivery-options.js';

const baseTask = (over: Partial<Task> = {}): Task => ({
  taskId: 't1',
  channelArn: 'arn:chan',
  userArn: 'arn:user',
  userMessage: 'help',
  status: 'in_progress',
  deliveryOption: DeliveryOption.TASK_MULTI_STEP,
  taskType: 'guided_troubleshooting',
  taskState: 'collecting_symptoms',
  details: {},
  createdAt: 'x',
  updatedAt: 'x',
  ttl: 0,
  ...over,
});

describe('task tool registration', () => {
  it('registers advance_task_state only for a machine-backed task', () => {
    expect(taskHasMachine('guided_troubleshooting', DEFAULT_TASK_STATE_MACHINES)).toBe(true);
    expect(taskHasMachine('nope', DEFAULT_TASK_STATE_MACHINES)).toBe(false);
    expect(taskHasMachine(undefined, DEFAULT_TASK_STATE_MACHINES)).toBe(false);

    expect(taskToolSpecsFor('guided_troubleshooting', DEFAULT_TASK_STATE_MACHINES)).toEqual([ADVANCE_TASK_STATE_TOOL_SPEC]);
    expect(taskToolSpecsFor(undefined, DEFAULT_TASK_STATE_MACHINES)).toEqual([]);
    expect(ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec.name).toBe(ADVANCE_TASK_STATE_TOOL_NAME);
  });
});

describe('handleAdvanceTaskStateTool dispatch', () => {
  it('authorizes a legal transition and reports from/to', async () => {
    // The step declares needs, so each is accounted for with where it came from.
    const { payload, result } = await handleAdvanceTaskStateTool({
      task: baseTask({ taskState: 'collecting_symptoms' }),
      input: {
        to_state: 'diagnosing',
        reason: 'enough symptoms gathered',
        collected: [
          { need: 'what is going wrong', value: 'login fails', source: 'message', evidence: 'I cannot log in' },
          { need: 'when it started', value: 'this morning', source: 'message', evidence: 'since this morning' },
          { need: 'what they have already tried', value: 'a password reset', source: 'message', evidence: 'reset my password' },
        ],
      },
    });
    expect(result.ok).toBe(true);
    // THE WHOLE PAYLOAD, because this is the contract the MODEL reads. It gained `finished` and
    // `next_states` and this assertion still named the three fields it had before, so an addition
    // the model depends on failed a test that was not about it. Asserted in full rather than
    // loosened to toMatchObject: a field silently disappearing from what the model is told is
    // exactly the regression worth catching here.
    expect(payload).toEqual({
      ok: true,
      from: 'collecting_symptoms',
      to: 'diagnosing',
      finished: false,
      next_states: ['proposing_solutions', 'collecting_symptoms'],
      // The landed state's own instructions, so a turn that advances mid-loop writes for the step it
      // is now on. The text is the machine's, asserted by its opening rather than restated here.
      guidance: expect.stringContaining('analyze the problem'),
    });
  });

  it('reports the terminal disposition when reaching a terminal state', async () => {
    const { payload } = await handleAdvanceTaskStateTool({
      task: baseTask({ taskState: 'awaiting_result' }),
      input: { to_state: 'resolved', reason: 'user confirmed the fix worked' },
    });
    // A terminal state reports `finished: true` and OMITS `next_states` entirely rather than
    // sending an empty array - the two facts that tell the model to stop rather than look for
    // another move. The omission is the stronger signal: an empty list still invites a search.
    expect(payload).toEqual({
      ok: true,
      from: 'awaiting_result',
      to: 'resolved',
      terminal: 'success',
      finished: true,
    });
  });

  it('rejects an illegal transition and echoes the legal set for self-correction', async () => {
    const { payload, result } = await handleAdvanceTaskStateTool({
      task: baseTask({ taskState: 'collecting_symptoms' }),
      input: { to_state: 'resolved', reason: 'skip ahead' },
    });
    expect(result.ok).toBe(false);
    expect(payload).toMatchObject({ ok: false, error: 'illegal_transition', from: 'collecting_symptoms', legal_transitions: ['diagnosing'] });
  });

  it('rejects a missing to_state', async () => {
    const { payload } = await handleAdvanceTaskStateTool({
      task: baseTask(),
      input: { reason: 'no target given' },
    });
    expect(payload).toMatchObject({ ok: false, error: 'unknown_state' });
  });
});

describe('a refusal by a declared rule carries a structured marker, and records as workflow_refusal', () => {
  it('an illegal edge and an undeclared target are refusals', async () => {
    for (const to_state of ['resolved', 'no_such_state']) {
      const { payload } = await handleAdvanceTaskStateTool({
        task: baseTask({ taskState: 'collecting_symptoms' }),
        input: { to_state },
      });
      expect(payload.refusal).toBe(payload.error);
      expect(toolStepOutcome(ADVANCE_TASK_STATE_TOOL_NAME, payload)).toEqual({
        name: ADVANCE_TASK_STATE_TOOL_NAME, ok: false, errorClass: 'workflow_refusal', refusal: payload.error,
      });
    }
  });

  it('a declared precondition is a refusal', async () => {
    // `collecting_symptoms` declares needs; advancing with none accounted for is refused by that declaration.
    const { payload } = await handleAdvanceTaskStateTool({
      task: baseTask({ taskState: 'collecting_symptoms' }),
      input: { to_state: 'diagnosing' },
    });
    expect(payload).toMatchObject({ ok: false, error: 'requirement_unsourced', refusal: 'requirement_unsourced' });
    expect(toolStepOutcome(ADVANCE_TASK_STATE_TOOL_NAME, payload).errorClass).toBe('workflow_refusal');
  });

  it('a call missing its target is bad input, not a refusal', async () => {
    const { payload } = await handleAdvanceTaskStateTool({ task: baseTask(), input: {} });
    expect(payload).not.toHaveProperty('refusal');
    expect(toolStepOutcome(ADVANCE_TASK_STATE_TOOL_NAME, payload).errorClass).not.toBe('workflow_refusal');
  });

  it('deliver_document from a step that does not deliver is a refusal; an empty document is not', () => {
    const notDelivering = handleDeliverDocumentTool({
      task: baseTask({ taskState: 'collecting_symptoms' }),
      input: { document: 'x' },
      machines: DEFAULT_TASK_STATE_MACHINES,
    });
    expect(notDelivering.payload).toMatchObject({ error: 'not_a_delivering_step', refusal: 'not_a_delivering_step' });

    const delivering = Object.entries(DEFAULT_TASK_STATE_MACHINES)
      .flatMap(([taskType, m]) => Object.entries(m.states).filter(([, d]) => deliversDocument(d)).map(([state]) => ({ taskType, state })))[0];
    const empty = handleDeliverDocumentTool({
      task: baseTask({ taskType: delivering.taskType, taskState: delivering.state }),
      input: {},
      machines: DEFAULT_TASK_STATE_MACHINES,
    });
    expect(empty.payload).toMatchObject({ error: 'document_required' });
    expect(empty.payload).not.toHaveProperty('refusal');
    expect(toolStepOutcome(DELIVER_DOCUMENT_TOOL_NAME, empty.payload).errorClass).toBe('bad_input');
  });
});

describe('place_item proposal coupling (§5)', () => {
  const ctxFor = (over: Partial<Task> = {}): TaskLoopContext => ({
    task: baseTask({ taskType: 'place_item', taskState: 'collecting', ...over }),
    transitions: [],
    machines: DEFAULT_TASK_STATE_MACHINES,
  });

  it('proposalAdvancesPlaceItem is true only for a place_item task in collecting', () => {
    expect(proposalAdvancesPlaceItem(ctxFor())).toBe(true);
    expect(proposalAdvancesPlaceItem(ctxFor({ taskState: 'confirming' }))).toBe(false);
    expect(proposalAdvancesPlaceItem(ctxFor({ taskType: 'guided_troubleshooting', taskState: 'collecting_symptoms' }))).toBe(false);
    expect(proposalAdvancesPlaceItem(undefined)).toBe(false);
  });

  it('advances place_item collecting->confirming and records the transition on the context', async () => {
    const ctx = ctxFor();
    const result = await advancePlaceItemOnProposal(ctx);
    expect(result).toMatchObject({ ok: true, from: 'collecting', to: 'confirming' });
    expect(ctx.task.taskState).toBe('confirming');
    expect(ctx.transitions).toEqual([{ from: 'collecting', to: 'confirming' }]);
  });

  it('is a no-op (null, no state change) when the task is not a collecting place_item', async () => {
    const ctx = ctxFor({ taskType: 'guided_troubleshooting', taskState: 'collecting_symptoms' });
    const result = await advancePlaceItemOnProposal(ctx);
    expect(result).toBeNull();
    expect(ctx.task.taskState).toBe('collecting_symptoms');
    expect(ctx.transitions).toEqual([]);
  });
});

describe('a delivering step on a model of its own writes its own document (ADR-064 decision B)', () => {
  // A report in small: a confirming step that produces text, and a step that delivers the document.
  const REPORT = {
    initial: 'confirming',
    states: {
      confirming: { transitions: ['writing'] },
      writing: { transitions: ['done'], produces: 'document' },
      done: { transitions: [], terminal: 'success' },
    },
  } as unknown as typeof DEFAULT_TASK_STATE_MACHINES[string];
  const machines = { report: REPORT };
  const confirming = () => baseTask({ taskType: 'report', taskState: 'confirming' });
  const writtenThere = (state: string) => state === 'writing';

  it('different model: the move is accepted without the document, says the step writes it, and declares none', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: confirming(), input: { to_state: 'writing', reason: 'approved' }, machines, documentWrittenOnStep: writtenThere,
    });
    expect(out.result.ok).toBe(true);
    expect(out.payload).toMatchObject({ ok: true, to: 'writing', delivers: true, writes_document: true });
    expect(String(out.payload.next)).toContain(DELIVER_DOCUMENT_TOOL_NAME);
    expect(out.document).toBeUndefined();
  });

  it('different model: a document the moving model passes anyway is not declared', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: confirming(), input: { to_state: 'writing', reason: 'approved', document: '# Draft' }, machines, documentWrittenOnStep: writtenThere,
    });
    expect(out.result.ok).toBe(true);
    expect(out.document).toBeUndefined();
    expect(out.payload).not.toHaveProperty('document_received');
  });

  it('same model: the document is still required on the move', async () => {
    const refused = await handleAdvanceTaskStateTool({
      task: confirming(), input: { to_state: 'writing', reason: 'approved' }, machines, documentWrittenOnStep: () => false,
    });
    expect(refused.payload).toMatchObject({ ok: false, error: 'document_required', refusal: 'document_required' });
    const moved = await handleAdvanceTaskStateTool({
      task: confirming(), input: { to_state: 'writing', reason: 'approved', document: '# Report' }, machines, documentWrittenOnStep: () => false,
    });
    expect(moved.document).toBe('# Report');
    expect(moved.payload).toMatchObject({ ok: true, document_received: true });
    expect(moved.payload).not.toHaveProperty('writes_document');
  });

  it('a finishing move out of the step still hands over the document: the deferral is only on the way in', async () => {
    const refused = await handleAdvanceTaskStateTool({
      task: baseTask({ taskType: 'report', taskState: 'writing' }), input: { to_state: 'done', reason: 'right' }, machines, documentWrittenOnStep: () => true,
    });
    expect(refused.payload).toMatchObject({ ok: false, error: 'document_required' });
  });

  it('the tools say which contract applies: the move names the step that writes its document, and the declaration is offered', () => {
    const [advanceSpec, ...rest] = taskToolSpecsFor('report', machines, 'confirming', undefined, writtenThere);
    expect(advanceSpec.toolSpec.description).toContain('Moving to "writing" starts the step that writes the document, on a model of its own: make the move without `document`.');
    expect(advanceSpec.toolSpec.description).not.toContain('hands over the finished document');
    expect(rest.map((s) => s.toolSpec.name)).toEqual([DELIVER_DOCUMENT_TOOL_NAME]);
    const [onTheMove, ...none] = taskToolSpecsFor('report', machines, 'confirming', undefined, () => false);
    expect(onTheMove.toolSpec.description).toContain('Moving to "writing" hands over the finished document: pass it whole in `document`.');
    expect(none).toEqual([]);
  });

  it('the step writes the document with deliver_document once the task is there', () => {
    const declared = handleDeliverDocumentTool({
      task: baseTask({ taskType: 'report', taskState: 'writing' }), input: { document: '# Report' }, machines,
    });
    expect(declared.document).toBe('# Report');
    expect(declared.payload).toMatchObject({ ok: true, document_received: true });
  });
});
