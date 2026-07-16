/**
 * Per-turn context framework (lib/context-framework.ts + lib/host-context-resolvers.ts) — P6.
 *
 * The per-turn context contract:
 *  - PRESENT ⇒ the section is rendered into the prompt; its fields surface.
 *  - ABSENT  ⇒ the section is omitted (no empty headers / stray separators).
 *  - The composer is defensive: empty sections dropped, order preserved, a throwing resolver isolated.
 */
import {
  ContextResolverRegistry,
  buildSystemPrompt,
  ContextResolver,
} from '../../lambda/src/lib/context-framework';
import {
  createHostContextRegistry,
  HostContextInput,
} from '../../lambda/src/lib/host-context-resolvers';

const PERSONA = 'You are Aria, a helpful assistant.';

describe('context-framework — buildSystemPrompt (defensive composer)', () => {
  test('drops empty/whitespace sections, keeps persona + non-empty in order', () => {
    const out = buildSystemPrompt(PERSONA, ['', '  ', '\n\nA', undefined, null, '\n\nB']);
    expect(out).toBe(`${PERSONA}\n\nA\n\nB`);
  });

  test('persona-only when every section is empty', () => {
    expect(buildSystemPrompt(PERSONA, ['', undefined, '   '])).toBe(PERSONA);
  });
});

describe('context-framework — ContextResolverRegistry', () => {
  const A: ContextResolver<{ n: number }> = { contextType: 'a', render: (i) => `A${i.n}` };
  const B: ContextResolver<{ n: number }> = { contextType: 'b', render: (i) => `B${i.n}` };

  test('registration order is prompt order; resolveSections renders each', () => {
    const reg = new ContextResolverRegistry<{ n: number }>().register(A).register(B);
    expect(reg.list().map((r) => r.contextType)).toEqual(['a', 'b']);
    expect(reg.resolveSections({ n: 1 })).toEqual(['A1', 'B1']);
  });

  test('re-registering a contextType replaces in place (host override), order unchanged', () => {
    const A2: ContextResolver<{ n: number }> = { contextType: 'a', render: () => 'A-overridden' };
    const reg = new ContextResolverRegistry<{ n: number }>().register(A).register(B).register(A2);
    expect(reg.list().map((r) => r.contextType)).toEqual(['a', 'b']);
    expect(reg.resolveSections({ n: 9 })).toEqual(['A-overridden', 'B9']);
  });

  test('a throwing resolver is isolated to its own empty section', () => {
    const boom: ContextResolver<{ n: number }> = { contextType: 'boom', render: () => { throw new Error('x'); } };
    const reg = new ContextResolverRegistry<{ n: number }>().register(A).register(boom).register(B);
    expect(reg.resolveSections({ n: 2 })).toEqual(['A2', '', 'B2']);
  });
});

describe('host-context-resolvers — domain grounding (present ⇒ rendered)', () => {
  const reg = createHostContextRegistry();
  const compose = (input: HostContextInput) => buildSystemPrompt(PERSONA, reg.resolveSections(input));

  test('domain context present ⇒ rendered with title + items + edit-tool guidance', () => {
    const prompt = compose({
      domainContext: {
        title: 'Hokkaido Loop',
        items: [{ id: 's1', title: 'Otaru Canal', status: 'open', start: 'Sep 2' }],
      },
    });
    expect(prompt).toContain('<work_items>');
    expect(prompt).toContain('Hokkaido Loop');
    expect(prompt).toContain('Otaru Canal');
    expect(prompt).toContain('{id: s1}');
    expect(prompt).toContain('add_item'); // edit-tool affordance surfaces
  });

  test('non-English userLanguage surfaces a reply-language instruction', () => {
    const prompt = compose({ userLanguage: 'zh', domainContext: { title: 'X', items: [] } });
    expect(prompt).toContain('Simplified Chinese');
  });

  test('other contexts surface for disambiguation', () => {
    const prompt = compose({
      domainContext: { title: 'Current', items: [] },
      otherContexts: [{ title: 'Kyoto Spring', slug: 'kyoto-spring' }],
    });
    expect(prompt).toContain('Kyoto Spring');
    expect(prompt).toContain('kyoto-spring');
  });

  test('participant profile present ⇒ rendered and tailored', () => {
    const prompt = compose({ participantProfile: 'Prefers concise updates, async first, avoids meetings.' });
    expect(prompt).toContain('<participant_profile>');
    expect(prompt).toContain('async first');
  });
});

describe('host-context-resolvers — absent ⇒ omitted', () => {
  const reg = createHostContextRegistry();

  test('a generic AE turn (no host fields) ⇒ persona only, no stray sections', () => {
    const prompt = buildSystemPrompt(PERSONA, reg.resolveSections({}));
    expect(prompt).toBe(PERSONA);
    expect(prompt).not.toContain('<work_items>');
    expect(prompt).not.toContain('<participant_profile>');
  });

  test('empty participantProfile omits the profile section', () => {
    const prompt = buildSystemPrompt(PERSONA, reg.resolveSections({ participantProfile: '   ' }));
    expect(prompt).not.toContain('<participant_profile>');
  });
});
