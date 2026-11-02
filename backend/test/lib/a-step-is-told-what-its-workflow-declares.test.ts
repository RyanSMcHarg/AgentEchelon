/**
 * A STEP IS TOLD WHAT ITS WORKFLOW DECLARES (SPEC-TASK-STATE-TRANSITIONS section 9).
 *
 * A state's `prompt` is the only source of the step's instructions, for every machine. Five of the
 * platform's own task types used to be rendered from prose functions the processor chose by task-type
 * name, so a manager could not change one of their steps without a code change, and a pack that
 * redeclared one of those types had its declared prompts ignored in favor of the platform's text.
 *
 * These cases hold the as-built rule: every default step renders its declared prompt; a pack-declared
 * machine for a default task type renders ITS prompts, through the same merge every consumer reads;
 * and the renderer names no task type.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { buildTaskSystemPrompt } from '../../lambda/src/lib/task-step-prompt';
import { stripComments } from '../helpers/strip-comments';

/** The task types whose step text used to live in the processor as prose functions. */
const FORMERLY_IN_CODE = [
  'guided_troubleshooting',
  'data_extraction',
  'report_generation',
  'place_item',
  'action_item',
] as const;

describe('every default step renders its declared prompt', () => {
  for (const taskType of FORMERLY_IN_CODE) {
    const machine = DEFAULT_TASK_STATE_MACHINES[taskType];

    it(`${taskType}: every non-terminal state declares a prompt, and the rendered step carries it`, () => {
      for (const [state, def] of Object.entries(machine.states)) {
        if (def.transitions.length > 0) expect({ state, prompt: def.prompt?.trim() }).toEqual({ state, prompt: expect.any(String) });
        const rendered = buildTaskSystemPrompt(taskType, state, DEFAULT_TASK_STATE_MACHINES);
        expect(rendered).toContain(`## CURRENT TASK: ${taskType.replace(/_/g, ' ')} - ${state.replace(/_/g, ' ')}`);
        if (def.prompt) expect(rendered).toContain(def.prompt.trim());
        // The legal next states follow the declared prompt, so the step's text never displaces them.
        for (const next of def.transitions) expect(rendered).toContain(`\`${next}\``);
        if (def.prompt && def.transitions.length > 0) {
          expect(rendered.indexOf(def.prompt.trim())).toBeLessThan(rendered.indexOf('**Task state machine:**'));
        }
      }
    });
  }

  it('a task type the turn has no machine for renders nothing', () => {
    expect(buildTaskSystemPrompt('no_such_workflow', 'anywhere', DEFAULT_TASK_STATE_MACHINES)).toBe('');
  });
});

describe('a pack-declared machine for a default task type renders its own prompts', () => {
  const PACK_PROMPT = 'Ask which quarter the figures cover, and nothing else.';

  beforeEach(() => {
    jest.resetModules();
    delete process.env.ASSISTANT_INTENT_PACK;
  });

  afterEach(() => {
    delete process.env.ASSISTANT_INTENT_PACK;
  });

  it('report_generation redeclared by a pack: its prompt is rendered, and the platform text is not', async () => {
    process.env.ASSISTANT_INTENT_PACK = JSON.stringify({
      intents: [{ key: 'reporting', description: 'a report request', keywords: ['report'] }],
      machines: {
        report_generation: {
          initial: 'collecting_requirements',
          states: {
            collecting_requirements: {
              transitions: ['generating'],
              awaits: { party: 'requester' },
              prompt: PACK_PROMPT,
            },
            generating: { transitions: ['completed'], produces: 'document' as const, prompt: 'Write it.' },
            completed: { transitions: [], terminal: 'success' },
          },
        },
      },
    });
    const { taskStateMachines, _resetIntentPackCache } = await import('../../lambda/src/lib/intent-pack');
    _resetIntentPackCache();
    const merged = taskStateMachines();
    const { buildTaskSystemPrompt: render } = await import('../../lambda/src/lib/task-step-prompt');

    const rendered = render('report_generation', 'collecting_requirements', merged);
    const platformText = DEFAULT_TASK_STATE_MACHINES.report_generation.states.collecting_requirements.prompt!;

    expect(rendered).toContain(PACK_PROMPT);
    expect(rendered).not.toContain(platformText.trim());
    // The pack's graph, not the platform's: its only exit is `generating`, so `drafting_outline` is
    // not offered.
    expect(rendered).toContain('`generating`');
    expect(rendered).not.toContain('drafting_outline');
  });
});

describe('the renderer names no task type', () => {
  it('neither the step renderer nor the processor switches on a task type to supply step text', () => {
    const SRC = join(__dirname, '../../lambda/src');
    const renderer = stripComments(readFileSync(join(SRC, 'lib/task-step-prompt.ts'), 'utf8'));
    const processor = stripComments(readFileSync(join(SRC, 'assistant-async-processor.ts'), 'utf8'));

    for (const src of [renderer, processor]) {
      expect(src).not.toMatch(/switch\s*\(\s*taskType\s*\)/);
      for (const taskType of FORMERLY_IN_CODE) {
        expect(src).not.toContain(`case '${taskType}'`);
      }
    }
    for (const fn of [
      'getGuidedTroubleshootingPrompt',
      'getDataExtractionPrompt',
      'getReportGenerationPrompt',
      'getPlaceItemPrompt',
      'getActionItemPrompt',
    ]) {
      expect(processor).not.toContain(fn);
    }
    // The renderer reads the state's declared prompt from the machine it is handed.
    expect(renderer).toMatch(/\.prompt\b/);
  });
});
