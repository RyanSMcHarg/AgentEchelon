/**
 * A VALUE PUT INTO A PROMPT IS TEXT, NOT A PATTERN.
 *
 * Every judge prompt in the evaluation runner was assembled by chaining
 * `.replace('{{field}}', value)`, and that shape has two defects an ordinary member can reach by
 * typing a message. Neither is an access break. What they corrupt is the VERDICT, and the verdict is
 * what every quality rate, the blocking-breach alert and any future calibration are computed from. A
 * measurement the measured party can steer is not a measurement.
 *
 * The two defects have one cause - a value being treated as a pattern - and `renderPrompt` closes
 * both with one global pass through a replacer function.
 */
import { renderPrompt } from '../../lambda/src/lib/render-prompt';

describe('a substituted value cannot rewrite the prompt around it', () => {
  it('does not expand $-sequences in the value', () => {
    // `String.prototype.replace` with a STRING replacement expands `$&`, `` $` ``, `$'` and `$$`.
    // `` $` `` is the dangerous one: it inserts everything BEFORE the match, so a message containing
    // it splices the whole preceding rubric into the middle of the evidence and the judge scores a
    // prompt nobody wrote. A shell snippet or a price list triggers it without anyone attacking.
    const template = 'RUBRIC: score it.\nUser message: {{userMessage}}\nEND';

    const out = renderPrompt(template, { userMessage: 'what does $` do, or $& and $\'?' });

    expect(out).toBe('RUBRIC: score it.\nUser message: what does $` do, or $& and $\'?\nEND');
    // The rubric appears once. If `$\`` had expanded, it would appear twice.
    expect(out.match(/RUBRIC: score it\./g)).toHaveLength(1);
  });

  it('does not let one value fill another field\'s placeholder', () => {
    // The transcript is substituted BEFORE the turn's own fields, and each `.replace` takes the
    // FIRST match. So a prior message containing the literal `{{userMessage}}` received the real
    // user message, and the "Current Exchange" field two sections lower was left holding a bare
    // placeholder - the evidence relocated to a position of the writer's choosing, and the field the
    // rubric tells the judge to score left empty.
    const template = 'Transcript:\n{{conversationContext}}\n\nCurrent user message: {{userMessage}}';

    const out = renderPrompt(template, {
      conversationContext: 'User: here is my message {{userMessage}} ok',
      userMessage: 'THE REAL QUESTION',
    });

    // The planted placeholder stays inert text inside the transcript.
    expect(out).toContain('here is my message {{userMessage}} ok');
    // And the real field is filled, once, where the template put it.
    expect(out).toContain('Current user message: THE REAL QUESTION');
    expect(out.match(/THE REAL QUESTION/g)).toHaveLength(1);
  });

  it('substitutes every placeholder exactly once, whatever the values contain', () => {
    const template = '{{a}} | {{b}} | {{c}}';
    const out = renderPrompt(template, { a: '{{b}}', b: '{{c}}', c: 'z' });
    // Each is filled from the map, and no inserted value is re-scanned as a placeholder.
    expect(out).toBe('{{b}} | {{c}} | z');
  });

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    // A typo in a template should be legible in the prompt a person inspects. Blanking it produces
    // an empty section that reads as missing evidence, which is the harder bug to find.
    const out = renderPrompt('{{known}} and {{typo}}', { known: 'here' });
    expect(out).toBe('here and {{typo}}');
  });

  it('renders an absent optional field as empty, not as the word undefined', () => {
    // `taskContext` is absent on most turns. The old chain passed `''`; a map-based renderer must
    // not start printing "undefined" into a rubric.
    expect(renderPrompt('a{{gap}}b', { gap: undefined })).toBe('ab');
    expect(renderPrompt('a{{gap}}b', { gap: null })).toBe('ab');
  });
});

describe('no judge prompt is assembled by chained replace any more', () => {
  it('the evaluation runner builds every prompt through the renderer', () => {
    // A source guard, because the defect is a SHAPE rather than a value: a new prompt added with the
    // old chain would pass every behavioral test in this file while carrying both defects back in.
    // Five prompts are built in that file (relevance, image relevance, groundedness, flow, drift).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'evaluation-runner.ts'),
      'utf8',
    );
    expect(src.match(/replace\('\{\{/g)).toBeNull();
    expect((src.match(/renderPrompt\(/g) || []).length).toBeGreaterThanOrEqual(5);
  });
});
