/**
 * A TURN THAT CHANGED SOMETHING SAYS SO, AND DOES NOT INVITE A RETRY (maintainer, 2026-09-02).
 *
 * When the model ends on a tool block with no text, the loop still has to say something. That line
 * has now been wrong in both directions:
 *
 *   1. "I processed your request but got an unexpected response format" - claimed something happened
 *      when nothing had.
 *   2. "nothing was changed. Please try again" - the correction, which is equally false the moment a
 *      tool that persists has already run.
 *
 * Measured live on the split-answer turn: `advance_task_state` at 19:59:13.113, the no-text line at
 * 19:59:15.676, and `[split] the offer was answered` at 19:59:15.893. The split was applied and the
 * task advanced; the person was told nothing had changed and invited to redo it. "Please try again"
 * is the harm, not the wording: the retry re-runs work that already ran.
 *
 * The owner's rule: state what it CAN, not what it cannot, and never apologise for the summary it
 * could not produce.
 *
 * WHY THE FACT LIVES IN THE REGISTRY. Whether anything changed is a property of the TOOL, and the
 * next tool is added to the registry rather than to a list in this consumer.
 */
import {
  TOOL_REGISTRY,
  anyToolChangedState,
} from '../../lambda/src/lib/tool-registry';
import { DEFAULT_NOTICE_COPY } from '../../lambda/src/lib/assistant-notice';

describe('which tools actually change something', () => {
  it('advance_task_state changes state; it is the only one that persists in-loop', () => {
    expect(anyToolChangedState(['advance_task_state'])).toBe(true);
  });

  it('A PROPOSAL IS NOT A CHANGE: every work-item tool is proposal-and-confirm', () => {
    // These emit a proposal the person still has to confirm. Counting them as changes would tell
    // somebody their plan was edited when it was only suggested - the same over-claim, reversed.
    for (const t of TOOL_REGISTRY.filter((x) => x.category === 'work-item')) {
      expect(`${t.name}:${t.changesState}`).toBe(`${t.name}:false`);
    }
    expect(anyToolChangedState(['add_item', 'update_item', 'assign_item'])).toBe(false);
  });

  it('reads change nothing', () => {
    expect(anyToolChangedState(['load_company_context', 'load_platform_info'])).toBe(false);
  });

  it('the live sequence that shipped the bug is recognised as a change', () => {
    // Two reads then the advance, exactly as logged on the failing turn.
    expect(anyToolChangedState(['load_company_context', 'load_company_context', 'advance_task_state']))
      .toBe(true);
  });

  it('an unknown tool is NOT assumed to change anything', () => {
    // Claiming a change on the strength of a name nobody declared is the over-claim this prevents.
    expect(anyToolChangedState(['some_tool_added_later'])).toBe(false);
  });

  it('no tools at all is not a change', () => {
    expect(anyToolChangedState([])).toBe(false);
  });

  it('every registry entry declares the field, so a new tool cannot be silently absent', () => {
    for (const t of TOOL_REGISTRY) {
      expect(typeof t.changesState).toBe('boolean');
    }
  });
});

/**
 * The message itself, pinned as a source guard: `invokeBedrock` takes a live Bedrock client and is
 * not invocable from a unit test, so what is held here is the DECISION - which line is used when,
 * and the two things it must never do.
 */
describe('what the no-text turn says', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const core: string = fs.readFileSync(
    path.resolve(__dirname, '../..', 'lambda/src/lib/async-processor-core.ts'),
    'utf8',
  );
  const branch = core.slice(
    core.indexOf('WHAT IT SAYS DEPENDS ON WHETHER ANYTHING CHANGED'),
    core.indexOf('// Guardrail parity (ADR-011)'),
  );

  it('decides from the registry, not from a list kept here', () => {
    expect(branch).toContain('anyToolChangedState(toolsThatRan)');
  });

  it('counts only tools that SUCCEEDED, because a failed tool changed nothing', () => {
    expect(branch).toContain('.filter((t) => t.ok)');
  });

  // THE WORDS LIVE IN THE NOTICE CATALOG (2026-10-16), resolved against the assistant's own copy, so the
  // shipped defaults are checked there and the branch is checked for resolving both lines through it.
  it('the changed line does not apologise and does not invite a retry', () => {
    const changed = DEFAULT_NOTICE_COPY.completedWithoutSummary;
    expect(changed).not.toMatch(/try again/i);
    expect(changed).not.toMatch(/sorry|apolog|unable|not able|could not|couldn't/i);
  });

  it('the unchanged line DOES still tell them nothing happened, so they know to ask again', () => {
    expect(DEFAULT_NOTICE_COPY.nothingChanged).toMatch(/nothing was changed/);
  });

  it('both lines can carry the deployment\'s own words (tenet D11)', () => {
    expect(branch).toContain("noticeLine(config.copy, 'completedWithoutSummary')");
    expect(branch).toContain("noticeLine(config.copy, 'nothingChanged')");
  });
});

/**
 * AND THE COPY ACTUALLY REACHES THE LOOP.
 *
 * A `copy` field on the config that no caller populates is a switch that looks wired and is not -
 * the console would show the deployment had configured a line while the loop kept emitting English.
 * That failure has shipped here before, which is why it is asserted rather than assumed.
 */
describe('the profile copy is threaded into the loop', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const processor: string = fs.readFileSync(
    path.resolve(__dirname, '../..', 'lambda/src/assistant-async-processor.ts'),
    'utf8',
  );

  it('the bedrock invoke config carries the profile copy', () => {
    // FROM THE RESOLVED PROFILE, NOT THE VARIANT FIELD (code review, 2026-09-04).
    //
    // This asserted `event.variantProfile?.copy`, which is what the code said and was the defect the
    // block above describes: `variantProfile` is populated only on a battle or experiment VARIANT
    // turn, so on an ordinary deployment it was always undefined and the loop went on emitting
    // hardcoded English. The test passed throughout, because it checked that the wire was connected
    // to the wrong terminal rather than that anything came down it.
    //
    // `activeProfile` resolves the variant when there is one and the active version otherwise, so it
    // is the value that is populated on both paths.
    // The turn's words object, carrying the stored message templates its version's `messages` and family name (ADR-062).
    expect(processor).toContain('let versionCopy = withMessageTemplates<AssistantCopy>(await loadMessageTemplateSet({');
    expect(processor).toContain('copy: versionCopy,');
  });

  it('and does not reach for the variant field, which is empty on an ordinary turn', () => {
    // The guard for the regression rather than for the line: re-reading `variantProfile` here would
    // restore a switch that looks wired to everyone who is not running a battle.
    expect(processor).not.toContain('{ copy: event.variantProfile.copy }');
  });

  it('the fallback model path does not drop it', () => {
    const resilience: string = fs.readFileSync(
      path.resolve(__dirname, '../..', 'lambda/src/lib/bedrock-resilience.ts'),
      'utf8',
    );
    // Spread, so every field including `copy` survives the switch to the fallback model. A hand-built
    // object here would silently lose the deployment's words exactly when a turn is already degraded.
    expect(resilience).toContain('const fallbackConfig = { ...primaryConfig, model: fallbackModelId }');
  });
});
