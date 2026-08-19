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
import { buildTaskContextForPrompt, type Task } from '../../lambda/src/lib/task-tracking';
import { type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';

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
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'generating'));

    expect(prompt).toContain('DELIVERING THIS STEP');
    expect(prompt).toMatch(/do not say you have saved, attached, created, uploaded or exported a file/i);
    expect(prompt).toMatch(/download link/i);
  });

  it('renders it on every default delivering state, revisions and extractions included', () => {
    // The person is just as misled by a revision or an extraction that invents a file.
    for (const [taskType, state] of [
      ['report_generation', 'revising'],
      ['data_extraction', 'extracting'],
      ['data_extraction', 'validating'],
      ['data_extraction', 'formatting'],
    ] as const) {
      expect(buildTaskContextForPrompt(taskIn(taskType, state))).toContain('DELIVERING THIS STEP');
    }
  });

  it('says nothing on a step that delivers nothing', () => {
    // Collecting requirements produces no artifact, so a rule about packaging one is noise that
    // invites the model to talk about files at the exact moment it should be asking a question.
    expect(buildTaskContextForPrompt(taskIn('report_generation', 'collecting_requirements')))
      .not.toContain('DELIVERING THIS STEP');
    expect(buildTaskContextForPrompt(taskIn('report_generation', 'drafting_outline')))
      .not.toContain('DELIVERING THIS STEP');
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
          writing_it_up: { transitions: ['done'], delivers: true },
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
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'generating'));
    expect(prompt).toContain('ACTIVE TASK');
    expect(prompt).toContain('condense the Q2 report');
  });
});
