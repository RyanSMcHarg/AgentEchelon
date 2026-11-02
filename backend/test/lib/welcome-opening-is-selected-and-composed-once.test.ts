/**
 * THE OPENING IS SELECTED AND COMPOSED BY ONE PAIR OF FUNCTIONS, which the router posts from and the console
 * previews from (`frontend/packages/admin/src/components/admin/WelcomeEditorGuide.tsx`).
 *
 * What it proves: `selectOpening` reads a welcome's template step (W1): its own text, and its orientation fields parsed
 * as the deployment parameter is, and nothing when the step carries nothing of its own; `composeOpening` posts the
 * template's render, or the built-in assembly when no template applies or every line of it is dropped; and
 * `welcomeConfigDefects` records the assembly's shortfalls only when the assembly is what the room read.
 */
import {
  selectOpening,
  composeOpening,
  composeWelcome,
  type WelcomeOpeningStep,
} from '../../lambda/src/lib/welcome-orientation';
import { welcomeConfigDefects } from '../../lambda/src/lib/welcome-metrics';

describe('selectOpening', () => {
  it('reads the step\'s own text, with its orientation fields beside it', () => {
    expect(selectOpening({ text: 'An alert opened this: {{eventSummary}}', examples: ['How did Q3 close?'] })).toEqual({
      template: 'An alert opened this: {{eventSummary}}',
      orientation: { examples: ['How did Q3 close?'] },
      issues: [],
    });
  });

  it('reads orientation fields alone when the step carries no text', () => {
    expect(selectOpening({ accessBlurb: 'You can see alarms.' })).toEqual({ orientation: { accessBlurb: 'You can see alarms.' }, issues: [] });
  });

  it('selects nothing when the step says nothing of its own, so the classification copy applies', () => {
    expect(selectOpening({})).toBeNull();
    expect(selectOpening({ text: '   ' })).toBeNull();
    expect(selectOpening(undefined)).toBeNull();
  });

  it('parses the step\'s fields as the deployment parameter is, so a conversation field cannot be set', () => {
    const own = selectOpening({ companyName: 'Stratum', topic: 'set by a version' } as WelcomeOpeningStep);
    expect(own?.orientation).toEqual({ companyName: 'Stratum' });
    expect(own?.issues.join(' ')).toContain('topic');
  });

  it('reads its text as the opening, not as orientation it failed to carry', () => {
    expect(selectOpening({ text: 'This is a {{kind}} conversation.' })).toEqual({ template: 'This is a {{kind}} conversation.', orientation: null, issues: [] });
  });
});

describe('welcomeConfigDefects', () => {
  const generic = composeWelcome({});
  const base = { classification: 'premium', param: '/p/welcome-orientation' };

  it('records nothing when the assistant\'s own template rendered and carried no orientation fields', () => {
    const loaded = { orientation: null, expected: true, issues: [] };
    expect(welcomeConfigDefects({ ...base, loaded, usedTemplate: true, composition: generic })).toEqual([]);
  });

  it('records nothing of the assembly when the template is the copy, even an assembly missing deployment fields', () => {
    const partial = composeWelcome({ companyName: 'Stratum' });
    expect(partial.missingFields.length).toBeGreaterThan(0);
    const loaded = { orientation: { companyName: 'Stratum' }, expected: true, issues: [] };
    expect(welcomeConfigDefects({ ...base, loaded, usedTemplate: true, composition: partial })).toEqual([]);
  });

  it('still records a parameter that read cleanly yet oriented nothing, when the assembly is what was posted', () => {
    const loaded = { orientation: null, expected: true, issues: [] };
    expect(welcomeConfigDefects({ ...base, loaded, usedTemplate: false, composition: generic })).toEqual([
      { classification: 'premium', reason: 'unusable', detail: ['/p/welcome-orientation yielded no orientation, so the generic welcome was served'] },
    ]);
  });

  it('still records an unusable parameter and an assembly that left a deployment field out', () => {
    const unusable = { orientation: null, expected: true, issues: ['the parameter carried no usable orientation field'] };
    expect(welcomeConfigDefects({ ...base, loaded: unusable, usedTemplate: false, composition: generic }))
      .toEqual([{ classification: 'premium', reason: 'unusable', detail: unusable.issues }]);
    const partial = composeWelcome({ companyName: 'Stratum' });
    const loaded = { orientation: { companyName: 'Stratum' }, expected: true, issues: [] };
    expect(welcomeConfigDefects({ ...base, loaded, usedTemplate: false, composition: partial }).map((d) => d.reason)).toEqual(['incomplete']);
  });

  it('records a version field the template cannot set as incomplete, never as an unusable parameter', () => {
    const loaded = { orientation: null, expected: true, issues: ['topic is carried per conversation and cannot be set from the deployment parameter - ignored'] };
    expect(welcomeConfigDefects({ ...base, loaded, usedTemplate: true, composition: generic }).map((d) => d.reason)).toEqual(['incomplete']);
  });

  it('records nothing for a deployment that declares no parameter', () => {
    const loaded = { orientation: null, expected: false, issues: [] };
    expect(welcomeConfigDefects({ ...base, loaded, usedTemplate: false, composition: generic })).toEqual([]);
  });
});

describe('composeOpening', () => {
  it('posts the template\'s render when it says anything', () => {
    const opening = composeOpening('Hello about {topic}.', { topic: 'the board deck' }, { role: 'primary' });
    expect(opening).toMatchObject({ content: 'Hello about the board deck.', usedTemplate: true });
    expect(opening.composition).toEqual(composeWelcome({ topic: 'the board deck' }));
  });

  it('posts the built-in assembly when no template applies or every line is dropped', () => {
    const o = { examples: ['How did Q3 close?'], topic: 'the board deck' };
    expect(composeOpening(undefined, o).content).toBe(composeWelcome(o).content);
    const dropped = composeOpening('An alert: {eventSummary}', o);
    expect(dropped.usedTemplate).toBe(false);
    expect(dropped.content).toBe(composeWelcome(o).content);
  });
});
