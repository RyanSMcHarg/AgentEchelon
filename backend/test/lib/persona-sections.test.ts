/**
 * MOVING A TESTED INSTRUCTION INTO THE PERSONA (`persona-sections.ts`).
 *
 * What it proves:
 *   - the instruction becomes one new item at the end of the "How to answer:" section, in the style of the item it follows;
 *   - a persona without the section gains it at its end, holding the one item;
 *   - the text after the section, and everything before it, is kept word for word;
 *   - a version with no persona, no instruction, or a result over the length cap is refused with the reason;
 *   - the shipped personas open their section with the platform's marker, so the move lands in it.
 */
import { HOW_TO_ANSWER_HEADING, movedIntoPersona } from '../../lambda/src/lib/persona-sections';
import { BASIC_PERSONA, STANDARD_PERSONA, PREMIUM_PERSONA, OPS_PERSONA } from '../../demo/personas';

const MAX = 20000;

describe('movedIntoPersona', () => {
  it('adds the instruction as the last item of the How to answer section, matching its bullets', () => {
    const persona = 'You are the advisor.\n\nHow to answer:\n- Be specific.\n- Cite the source.';
    const r = movedIntoPersona(persona, 'Lead with the answer in one sentence.', MAX);
    expect(r).toEqual({ ok: true, persona: `${persona}\n- Lead with the answer in one sentence.` });
  });

  it('keeps the paragraph after the section, and puts the item before it', () => {
    const persona = 'Intro.\n\nHow to answer:\n* One.\n* Two.\n\nEscalation: name the owner.';
    const r = movedIntoPersona(persona, 'Three.', MAX);
    expect(r).toEqual({ ok: true, persona: 'Intro.\n\nHow to answer:\n* One.\n* Two.\n* Three.\n\nEscalation: name the owner.' });
  });

  it('continues a numbered list with the next number', () => {
    const r = movedIntoPersona('How to answer:\n1. One.\n2. Two.', 'Three.', MAX);
    expect(r).toEqual({ ok: true, persona: 'How to answer:\n1. One.\n2. Two.\n3. Three.' });
  });

  it('places the item after an item that runs onto a second line', () => {
    const r = movedIntoPersona('How to answer:\n- One,\n  continued.', 'Two.', MAX);
    expect(r).toEqual({ ok: true, persona: 'How to answer:\n- One,\n  continued.\n- Two.' });
  });

  it('adds the section at the end of a persona that has none', () => {
    const r = movedIntoPersona('You are the advisor.\n', 'Lead with the answer.', MAX);
    expect(r).toEqual({ ok: true, persona: `You are the advisor.\n\n${HOW_TO_ANSWER_HEADING}\n- Lead with the answer.` });
  });

  it('joins an instruction written over several lines into one item', () => {
    const r = movedIntoPersona('How to answer:\n- One.', 'Lead with the answer.\n  Then the detail.', MAX);
    expect(r).toEqual({ ok: true, persona: 'How to answer:\n- One.\n- Lead with the answer. Then the detail.' });
  });

  it('refuses a result longer than the cap, naming both lengths', () => {
    const persona = `How to answer:\n- ${'x'.repeat(90)}`;
    const r = movedIntoPersona(persona, 'Lead with the answer.', 100);
    expect(r).toEqual({ ok: false, reason: 'too-long', length: persona.length + '\n- Lead with the answer.'.length, max: 100 });
  });

  it('refuses a version with no persona of its own, which answers from the deployment persona', () => {
    expect(movedIntoPersona(undefined, 'Lead with the answer.', MAX)).toEqual({ ok: false, reason: 'no-persona' });
    expect(movedIntoPersona('  ', 'Lead with the answer.', MAX)).toEqual({ ok: false, reason: 'no-persona' });
  });

  it('refuses a version with no instruction to move', () => {
    expect(movedIntoPersona('How to answer:\n- One.', '  ', MAX)).toEqual({ ok: false, reason: 'no-addendum' });
  });

  it.each([
    ['basic', BASIC_PERSONA], ['standard', STANDARD_PERSONA], ['premium', PREMIUM_PERSONA], ['ops', OPS_PERSONA],
  ])('lands inside the shipped %s persona, at the end of its section', (_name, persona) => {
    expect(persona.split('\n')).toContain(HOW_TO_ANSWER_HEADING);
    const r = movedIntoPersona(persona, 'Lead with the answer.', MAX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = r.persona.split('\n');
    const at = lines.indexOf('- Lead with the answer.');
    expect(at).toBeGreaterThan(lines.indexOf(HOW_TO_ANSWER_HEADING));
    expect(lines.filter((l) => l !== '- Lead with the answer.').join('\n')).toBe(persona);
  });
});
