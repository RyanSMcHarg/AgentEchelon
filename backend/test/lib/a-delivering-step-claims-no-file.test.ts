/**
 * A DELIVERING STEP DOES NOT KNOW WHETHER IT PRODUCED A FILE, SO IT MUST NOT CLAIM ONE.
 *
 * Live: the assistant posted a full condensed board report as chat text and closed with "I've saved
 * this as a Markdown file that you can download or reference as needed." No attachment existed. The
 * person asked "Where is the file?" and got nothing useful.
 *
 * The claim can never be safe, because packaging is decided AFTER the text exists
 * (SPEC-TASK-STATE-TRANSITIONS §4): the attachment gate keys on the transition the turn DECLARED, or
 * an in-state rewrite, and then on the 400-character minimum artifact size. The model writing the
 * reply has none of those answers, so a sentence about a saved file is a guess.
 *
 * WHY A PROMPT RULE AND NOT A CHECK ON THE FINISHED REPLY. Inspecting the output for a file claim is
 * an output-shape heuristic, and this codebase has retired that predicate twice after it attached a
 * clarifying question, a requirements questionnaire, and an outline-for-approval as deliverables
 * (see deliver-on-generation.test.ts and the delivery gate's own comment). A phrase list would also
 * be English-only, in a product with bilingual conversations. The rule is therefore stated to the
 * model, and it is derived from the SAME `delivers` flag the attachment gate reads, so a
 * per-deployment machine that renames or adds a delivering state carries the rule with it.
 */
const mockAdvance = jest.fn();
jest.mock('../../lambda/src/lib/task-store', () => ({
  ...jest.requireActual('../../lambda/src/lib/task-store'),
  advanceTaskStateTo: (...args: unknown[]) => mockAdvance(...args),
}));

import { buildTaskContextForPrompt, type Task } from '../../lambda/src/lib/task-tracking';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { handleAdvanceTaskStateTool, handleDeliverDocumentTool } from '../../lambda/src/lib/task-tools';
import { SHIPPED_TURN_TEMPLATES } from '../helpers/shipped-templates';

const taskIn = (taskType: string, taskState: string): Task => ({
  taskId: 't-1',
  channelArn: 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1',
  taskType,
  taskState,
  status: 'in_progress',
  userMessage: 'condense the Q2 report to 1-2 pages for the board',
} as Task);

describe('a step that delivers is told not to claim a saved file', () => {
  it('renders the rule on the report_generation delivering state', () => {
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'generating'), DEFAULT_TASK_STATE_MACHINES);

    expect(prompt).toContain('DELIVERING THIS STEP');
    expect(prompt).toMatch(/do not say you have saved, attached, created, uploaded or exported a file/i);
    expect(prompt).toMatch(/download link/i);
  });

  it('renders it on every default delivering state, revisions and extractions included', () => {
    // The person is just as misled by a revision or an extraction that invents a file.
    for (const [taskType, state] of [
      ['report_generation', 'revising'],
      ['data_extraction', 'formatting'],
      ['code_delivery', 'generating'],
      ['technical_design', 'revising'],
    ] as const) {
      expect(buildTaskContextForPrompt(taskIn(taskType, state), DEFAULT_TASK_STATE_MACHINES)).toContain('DELIVERING THIS STEP');
    }
  });

  it('says nothing on a step that delivers nothing', () => {
    // Collecting requirements produces no artifact, so a rule about packaging one is noise that
    // invites the model to talk about files at the exact moment it should be asking a question.
    expect(buildTaskContextForPrompt(taskIn('report_generation', 'collecting_requirements'), DEFAULT_TASK_STATE_MACHINES))
      .not.toContain('DELIVERING THIS STEP');
    expect(buildTaskContextForPrompt(taskIn('report_generation', 'drafting_outline'), DEFAULT_TASK_STATE_MACHINES))
      .not.toContain('DELIVERING THIS STEP');
    // The extraction's working and checking steps hand nothing over: the records are shown for checking
    // at `validating`, and only `formatting` produces the file.
    expect(buildTaskContextForPrompt(taskIn('data_extraction', 'extracting'), DEFAULT_TASK_STATE_MACHINES))
      .not.toContain('DELIVERING THIS STEP');
    expect(buildTaskContextForPrompt(taskIn('data_extraction', 'validating'), DEFAULT_TASK_STATE_MACHINES))
      .not.toContain('DELIVERING THIS STEP');
  });

  it('says the document is declared separately from the reply', () => {
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'generating'), DEFAULT_TASK_STATE_MACHINES);
    expect(prompt).toContain('Pass it\n  whole as `document`');
    expect(prompt).toMatch(/YOUR REPLY is what you say to the person/);
    expect(prompt).not.toContain('YOUR WHOLE REPLY BECOMES THE DOCUMENT');
  });

  it('reads `delivers` from the machine it is GIVEN, like the attachment gate does', () => {
    // A hardcoded list of default state names could never match a renamed state, which is the exact
    // failure the attachment gate was refactored to remove. A profile's own delivering step gets the
    // rule; a step it does not flag does not.
    const custom: Record<string, TaskStateMachine> = {
      report_generation: {
        initial: 'gathering',
        states: {
          gathering: { transitions: ['writing_it_up'], awaitsUser: true },
          writing_it_up: { transitions: ['done'], produces: 'document' as const },
          done: { transitions: [], terminal: 'success' },
        },
      },
    };

    expect(buildTaskContextForPrompt(taskIn('report_generation', 'writing_it_up'), custom))
      .toContain('DELIVERING THIS STEP');
    expect(buildTaskContextForPrompt(taskIn('report_generation', 'gathering'), custom))
      .not.toContain('DELIVERING THIS STEP');
  });

  it('leaves the rest of the task grounding intact (this adds a section, it replaces none)', () => {
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'generating'), DEFAULT_TASK_STATE_MACHINES);
    expect(prompt).toContain('ACTIVE TASK');
    expect(prompt).toContain('condense the Q2 report');
  });
});

/**
 * THE DOCUMENT IS DECLARED, AND THE NEW STEP'S CONTRACT ARRIVES WITH THE MOVE.
 *
 * The prompt above renders for the state a turn STARTS in. Measured live: an extraction moved into a
 * delivering step in the middle of one model call, never saw that step's instructions, and its reply -
 * a greeting, a narration, the table and an apology about files - was packaged as the document. So a
 * move that hands over a document must carry the document as an argument, and the answer to a move
 * into a delivering step carries that step's guidance and says, positively, that it delivers.
 */
describe('a move that hands over a document declares it', () => {
  const at = (taskType: string, taskState: string, over: Partial<Task> = {}): Task =>
    ({ ...taskIn(taskType, taskState), details: {}, ...over } as Task);

  beforeEach(() => {
    mockAdvance.mockReset();
    mockAdvance.mockImplementation(async (a: { task: Task; toState: string }) => ({
      ok: true, from: a.task.taskState, to: a.toState,
      ...(DEFAULT_TASK_STATE_MACHINES[a.task.taskType ?? '']?.states[a.toState]?.transitions.length === 0
        ? { terminal: 'success' } : {}),
    }));
  });

  it('refuses a move into a delivering step with no document, and changes nothing', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: at('report_generation', 'drafting_outline'),
      input: { to_state: 'generating', reason: 'outline approved', collected: [
        { need: 'approval of the outline, or what to change about it', value: 'approved', source: 'message', evidence: 'looks good' },
      ] },
      machines: DEFAULT_TASK_STATE_MACHINES, templates: SHIPPED_TURN_TEMPLATES,
    });
    expect(out.result).toEqual({ ok: false, error: 'document_required', from: 'drafting_outline' });
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('refuses finishing from a delivering step that has handed nothing over', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: at('data_extraction', 'formatting'),
      input: { to_state: 'completed', reason: 'done' },
      machines: DEFAULT_TASK_STATE_MACHINES, templates: SHIPPED_TURN_TEMPLATES,
    });
    expect((out.result as { error?: string }).error).toBe('document_required');
  });

  it('lets a delivered step finish without a second document', async () => {
    const delivered = await handleAdvanceTaskStateTool({
      task: at('report_generation', 'generating', { deliveries: [{ name: 'report.md', at: 'x', fromState: 'generating' }] }),
      input: { to_state: 'completed', reason: 'they said it is right' },
      machines: DEFAULT_TASK_STATE_MACHINES, templates: SHIPPED_TURN_TEMPLATES,
    });
    expect(delivered.result.ok).toBe(true);

    const declaredThisTurn = await handleAdvanceTaskStateTool({
      task: at('report_generation', 'generating'),
      input: { to_state: 'completed', reason: 'rewritten and delivered' },
      machines: DEFAULT_TASK_STATE_MACHINES, templates: SHIPPED_TURN_TEMPLATES,
      documentAlreadyDeclared: true,
    });
    expect(declaredThisTurn.result.ok).toBe(true);
  });

  it('returns the declared document, and the landed step\'s guidance that delivers', async () => {
    const DOC = '# Board report\n\nThe findings.';
    const out = await handleAdvanceTaskStateTool({
      task: at('data_extraction', 'validating'),
      input: { to_state: 'formatting', reason: 'they confirmed the records', document: DOC },
      machines: DEFAULT_TASK_STATE_MACHINES, templates: SHIPPED_TURN_TEMPLATES,
      stateEnteredThisTurn: false,
      guidanceFor: (type, state) => `guidance for ${type}.${state}`,
    });
    expect(out.result.ok).toBe(true);
    expect(out.document).toBe(DOC);
    expect(out.payload).toMatchObject({
      ok: true, to: 'formatting', delivers: true, document_received: true,
      guidance: 'guidance for data_extraction.formatting',
    });
  });

  it('falls back to the state\'s declared prompt and the delivering contract when the loop renders none', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: at('code_delivery', 'collecting_requirements'),
      input: { to_state: 'generating', reason: 'confirmed', document: '```ts\nexport {};\n```', collected: [
        { need: 'the language and runtime', value: 'TypeScript', source: 'message', evidence: 'in TypeScript' },
        { need: 'what it must do', value: 'nothing', source: 'message', evidence: 'an empty module' },
        { need: 'where it will run or plug in', value: 'Node', source: 'message', evidence: 'on Node' },
      ] },
      machines: DEFAULT_TASK_STATE_MACHINES, templates: SHIPPED_TURN_TEMPLATES,
    });
    expect(out.payload.delivers).toBe(true);
    expect(String(out.payload.guidance)).toContain(DEFAULT_TASK_STATE_MACHINES.code_delivery.states.generating.prompt);
    expect(String(out.payload.guidance)).toContain('DELIVERING THIS STEP');
  });

  it('carries no `delivers` on a move into a step that hands nothing over', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: at('data_extraction', 'extracting'),
      input: { to_state: 'validating', reason: 'records pulled' },
      machines: DEFAULT_TASK_STATE_MACHINES, templates: SHIPPED_TURN_TEMPLATES,
    });
    expect(out.payload.delivers).toBeUndefined();
    expect(out.document).toBeUndefined();
  });

  it('declares a rewrite only from a delivering step', () => {
    const ok = handleDeliverDocumentTool({
      task: at('report_generation', 'generating'), input: { document: '# Revised' }, machines: DEFAULT_TASK_STATE_MACHINES, templates: SHIPPED_TURN_TEMPLATES,
    });
    expect(ok).toMatchObject({ document: '# Revised', payload: { ok: true } });

    const refused = handleDeliverDocumentTool({
      task: at('report_generation', 'drafting_outline'), input: { document: '# Draft' }, machines: DEFAULT_TASK_STATE_MACHINES, templates: SHIPPED_TURN_TEMPLATES,
    });
    expect(refused.document).toBeUndefined();
    expect(refused.payload).toMatchObject({ ok: false, error: 'not_a_delivering_step' });
  });
});
