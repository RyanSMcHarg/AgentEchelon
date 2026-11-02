/**
 * AN ITEM THAT DID NOT FINISH SAYS SO, WHATEVER THE REPLY CLAIMED.
 *
 * ── WHY THIS IS NOT A PROMPT RULE ───────────────────────────────────────────────────────────────
 *
 * Measured live on `conv-1790010890868-807ae3b58087`: a `data_extraction` task was reported to the
 * person as closed twice while its row sat at `formatting`, one step short of `completed`. Its own
 * `stateHistory` shows `advance_task_state` called three times, every call succeeding and every call
 * moving ONE step. Nothing failed, and the tool answered truthfully every time.
 *
 * The turn that believes it has finished the work is exactly the turn that will not say otherwise, so
 * the prompt and the tool's `finished` field are mitigations. This is the guarantee: the platform
 * states the fact, from the transition that was WRITTEN.
 *
 * ── WHAT IT MUST NOT DO ─────────────────────────────────────────────────────────────────────────
 *
 * It must not read the reply. Scanning for "closed" or "done" is the output-shape heuristic this
 * codebase has retired twice: it misses every phrasing nobody anticipated and fires on quotes and
 * questions. Every case below is decided by the row and the machine, which is why the line is
 * identical whether the reply claimed completion or said nothing at all.
 */
import { ownWords } from '../helpers/own-templates';
import {
  taskStillOpenLine,
  DEFAULT_TASK_STILL_OPEN,
} from '../../lambda/src/lib/task-reference';

describe('a turn that advanced an item without finishing it', () => {
  it('says where the item stands and what comes next', () => {
    const line = taskStillOpenLine({
      advanced: true,
      state: 'formatting',
      nextStates: ['completed'],
    });
    // The exact live case: three advances, each reported as closed, none terminal.
    expect(line).toContain('formatting');
    expect(line).toContain('completed');
  });

  it('reads in the person\'s words rather than the schema\'s', () => {
    // `collecting_requirements` is a key, not a sentence. A line a person reads should not make them
    // parse an identifier to learn their work is unfinished.
    const line = taskStillOpenLine({
      advanced: true,
      state: 'collecting_requirements',
      nextStates: ['extracting'],
    });
    expect(line).toContain('collecting requirements');
    expect(line).not.toContain('collecting_requirements');
  });

  it('names every next step when the machine offers more than one', () => {
    // `extracting` can go forward to `validating` or back to `collecting_requirements`. Naming one
    // would tell the person the work is further along than the machine says it is.
    const line = taskStillOpenLine({
      advanced: true,
      state: 'extracting',
      nextStates: ['validating', 'collecting_requirements'],
    });
    expect(line).toContain('validating');
    expect(line).toContain('collecting requirements');
  });

  it('is the same line whatever the reply said, because it never reads the reply', () => {
    // NON-VACUITY FOR THE WHOLE DESIGN. The function takes no response text at all, so a turn that
    // claimed completion and one that said nothing produce identical output. A future change that
    // started consulting the reply would have to alter this signature to do it.
    const args = { advanced: true, state: 'formatting', nextStates: ['completed'] };
    expect(taskStillOpenLine(args)).toBe(taskStillOpenLine({ ...args }));
    expect(DEFAULT_TASK_STILL_OPEN).not.toMatch(/closed|done|complete\b/i);
  });
});

describe('and a turn that did not', () => {
  it('adds nothing when the item actually finished', () => {
    // The work IS done, so saying it is open would be the same defect pointing the other way.
    expect(taskStillOpenLine({
      advanced: true,
      state: 'completed',
      nextStates: [],
      terminal: 'success',
    })).toBe('');
  });

  it('adds nothing when the turn advanced nothing', () => {
    // An ordinary conversational turn on a conversation that happens to hold open work.
    expect(taskStillOpenLine({
      advanced: false,
      state: 'formatting',
      nextStates: ['completed'],
    })).toBe('');
  });

  it('adds nothing when the machine says there is nowhere to go', () => {
    // A state with no transitions and no terminal flag is a machine defect, not a person's problem.
    // Saying "and comes next" with nothing after it would read as a truncated sentence.
    expect(taskStillOpenLine({ advanced: true, state: 'stuck', nextStates: [] })).toBe('');
  });

  it('adds nothing when the state is unknown', () => {
    expect(taskStillOpenLine({ advanced: true, nextStates: ['completed'] })).toBe('');
  });
});

describe('the words belong to the deployment', () => {
  it('says the assistant\'s own template, so the line carries the deployment\'s voice', () => {
    // Tenets P5 and D11: user-facing copy is configured, never fixed English in a code path.
    const line = taskStillOpenLine({
      advanced: true,
      state: 'formatting',
      nextStates: ['completed'],
      copy: ownWords({ taskStillOpen: 'Not done yet - at {state}, next is {next}.' }),
    });
    expect(line).toBe('Not done yet - at formatting, next is completed.');
  });

  it('falls back to a default that states the fact plainly', () => {
    expect(taskStillOpenLine({ advanced: true, state: 'formatting', nextStates: ['completed'] }))
      .toBe(DEFAULT_TASK_STILL_OPEN.replace('{state}', 'formatting').replace('{next}', 'completed'));
  });
});
