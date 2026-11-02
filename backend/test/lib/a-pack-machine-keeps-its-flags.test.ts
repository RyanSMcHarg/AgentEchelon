/**
 * A DEPLOYMENT PACK'S MACHINE KEEPS THE FLAGS IT DECLARED (maintainer decision: carry all
 * three and let validation see them).
 *
 * `coerceMachinesConfig` rebuilds every state field by field, and it named only `transitions`,
 * `terminal`, the two wait forms, `prompt` and `placeholder`. So a pack that declared `delivers`,
 * `resolvedByOneResponse` or `requires` got a DIFFERENT machine than its author wrote, silently:
 *
 *  - `delivers` decides whether a deliverable is packaged as a downloadable file, so a pack-declared
 *    document workflow shipped every report as chat text. That is the exact defect `delivers` was
 *    introduced to remove - a hardcoded per-taskType list a custom machine could never match -
 *    reappearing one layer up in the coercion.
 *  - `resolvedByOneResponse` and `requires` are rendered into the turn's prompt, so a pack lost the
 *    "one answer completes this step" and "this step needs" instructions it had declared.
 *
 * AND THE VALIDATOR WAS JUDGING THE STRIPPED OBJECT, which is why no existing test caught any of it.
 * `validateTaskStateMachines` refuses `requires` on a state that awaits nobody, and refuses `requires`
 * beside `resolvedByOneResponse`. Both rules ran over a state that no longer declared the field they
 * check, so for a pack they passed VACUOUSLY - a rule that cannot fire is worse than one that was
 * never written, because the machine it was protecting still looks checked.
 *
 * These tests are written against the MERGED view (`taskStateMachines()`), which is what every
 * consumer reads.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { awaitedPartyOf } from '../../lambda/src/lib/task-state-machines';

/** A pack declaring one document-producing machine, with whatever state flags the case is about. */
const packWith = (working: Record<string, unknown>, waiting: Record<string, unknown> = {}) => JSON.stringify({
  intents: [{ key: 'reporting', description: 'a report request', keywords: ['report'] }],
  machines: {
    pack_flow: {
      initial: 'waiting',
      states: {
        waiting: { transitions: ['working'], ...waiting },
        working: { transitions: ['done'], ...working },
        done: { transitions: [], terminal: 'success' },
      },
    },
  },
});

/** Hydrate a fresh pack. The module caches, so every case resets it. */
async function mergedMachines(pack: string) {
  process.env.ASSISTANT_INTENT_PACK = pack;
  const { taskStateMachines, _resetIntentPackCache } = await import('../../lambda/src/lib/intent-pack');
  _resetIntentPackCache();
  return taskStateMachines();
}

describe('a pack-declared machine keeps the flags that change behaviour', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.ASSISTANT_INTENT_PACK;
  });

  afterEach(() => {
    delete process.env.ASSISTANT_INTENT_PACK;
  });

  it('carries `delivers`, so a pack-declared document state reaches the attachment gate', async () => {
    const merged = await mergedMachines(packWith({ produces: 'document' as const }));

    expect(merged.pack_flow?.states?.working?.produces).toBe('document');

    // The gate derives its delivering states with exactly this expression over the merged machines
    // (the expression itself is source-ratcheted in deliver-on-generation.test.ts). Stripped, this
    // list was empty for every pack, and a declared deliverable shipped as chat text.
    const delivering = Object.entries(merged.pack_flow!.states)
      .filter(([, d]) => d.produces === 'document')
      .map(([name]) => name);
    expect(delivering).toEqual(['working']);
  });

  it('carries `label`, which is the only one of these a person actually reads', async () => {
    const merged = await mergedMachines(packWith({ label: 'Drafting your report' }));

    expect(merged.pack_flow?.states?.working?.label).toBe('Drafting your report');

    // `getTaskLabel` step 1 reads exactly this path. Stripped, a pack that named its own states never
    // reached step 1, so the person saw step 3's reshaping of the state KEY - and that reshaping is
    // English-derived, so a deployment writing in another language showed a mangled English key.
    const { getTaskLabel } = await import('../../lambda/src/lib/async-processor-core');
    expect(getTaskLabel('pack_flow', 'working', merged)).toBe('Drafting your report');
  });

  it('ignores a blank or non-string `label` rather than shadowing the fallback with it', async () => {
    const blank = await mergedMachines(packWith({ label: '   ' }));
    expect(blank.pack_flow?.states?.working?.label).toBeUndefined();

    const wrongType = await mergedMachines(packWith({ label: 42 }));
    expect(wrongType.pack_flow?.states?.working?.label).toBeUndefined();
  });

  /**
   * THE LIST-SHAPED BUG, CLOSED AS A SHAPE RATHER THAN AS ANOTHER ENTRY.
   *
   * `label` was dropped for the same reason `delivers` was: the coercion names fields one by one, and
   * whoever adds a field to `TaskStateDef` has to remember to add it here too. The previous fix scoped
   * itself to the FLAGS - this file is still named for them - so `label`, which is not a flag, was
   * missed and a person saw a raw state key for another five weeks.
   *
   * So this asserts over the DECLARED SURFACE instead of a remembered list: every optional field on
   * `TaskStateDef` must survive a round trip through the coercion. A new field fails here until it is
   * carried, which is the only version of this guard that does not rot.
   */
  it('carries every field a state may declare, so the next one added cannot be dropped quietly', async () => {
    const declared = {
      label: 'Drafting',
      prompt: 'Write the thing',
      placeholder: 'Working on it',
      produces: 'document' as const,
      resolvedByOneResponse: false,
      requires: ['a subject'],
      awaits: { party: 'requester' as const },
      terminal: undefined,
    };
    // `requires` needs an awaited party and cannot sit beside `resolvedByOneResponse`, so the valid
    // combination goes on the waiting state; `terminal` is exercised by the `done` state below.
    const merged = await mergedMachines(packWith(
      { label: declared.label, prompt: declared.prompt, placeholder: declared.placeholder, produces: 'document' as const },
      { requires: declared.requires, awaits: declared.awaits, presented: true },
    ));

    const working = merged.pack_flow?.states?.working;
    expect(working?.label).toBe(declared.label);
    expect(working?.prompt).toBe(declared.prompt);
    expect(working?.placeholder).toBe(declared.placeholder);
    expect(working?.produces).toBe('document');
    // `presented` is enforced by the runtime, so a pack that declares it must keep it.
    expect(merged.pack_flow?.states?.waiting?.presented).toBe(true);
    expect(merged.pack_flow?.states?.waiting?.requires).toEqual(declared.requires);
    expect(awaitedPartyOf(merged.pack_flow?.states?.waiting)).toEqual(declared.awaits);
    expect(merged.pack_flow?.states?.done?.terminal).toBe('success');

    // The ratchet: every optional key on TaskStateDef is either asserted above or listed here as
    // deliberately not carried, with a reason. An unlisted new field fails this test.
    // `reopens` is asserted in its own case below: it is declared on a terminal state, which `packWith`
    // fixes.
    // `template`, `templates` and `defaultTemplate` are asserted in their own case below: a choice needs a
    // requirements step, which the waiting state here does not declare in every case.
    // `tools`, `action`, `onSuccess` and `onFailure` are asserted in their own case below: an action needs
    // its outcome edges among the state's transitions.
    // `when` and `edgeWhen` are asserted in their own case below (ADR-060 decision 6).
    // `choices` and `rests` are asserted in their own case below (ADR-063 decisions 2 and 5).
    // `confirm` and `brief` are asserted in their own case below (ADR-064 decision G).
    const ASSERTED = ['label', 'prompt', 'placeholder', 'produces', 'delivers', 'requiresTool', 'presented', 'resolvedByOneResponse', 'requires', 'awaits', 'awaitsUser', 'terminal', 'transitions', 'reopens', 'template', 'templates', 'defaultTemplate', 'tools', 'action', 'onSuccess', 'onFailure', 'when', 'edgeWhen', 'choices', 'rests', 'confirm', 'brief'];
    const src = readFileSync(join(__dirname, '..', '..', 'lambda', 'src', 'lib', 'task-state-machines.ts'), 'utf-8');
    const defBlock = src.slice(src.indexOf('export interface TaskStateDef'));
    const fields = [...defBlock.slice(0, defBlock.indexOf('\n}')).matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(5); // the scrape found the block, not nothing
    expect(fields.filter((f) => !ASSERTED.includes(f))).toEqual([]);
  });

  it('carries `confirm` and `brief` on a presented step, so a complete brief is drawn as the pack declared (ADR-064 decision G)', async () => {
    const merged = await mergedMachines(packWith({}, { presented: true, awaits: { party: 'requester' }, confirm: 'when-incomplete', brief: ['the subject', 'the style'] }));
    expect(merged.pack_flow?.states?.waiting?.confirm).toBe('when-incomplete');
    expect(merged.pack_flow?.states?.waiting?.brief).toEqual(['the subject', 'the style']);
    const always = await mergedMachines(packWith({}, { presented: true, awaits: { party: 'requester' }, confirm: 'always' }));
    expect(always.pack_flow?.states?.waiting?.confirm).toBe('always');
  });

  it('carries `template`, and `templates` with `defaultTemplate`, on a delivering state (SPEC-DOCUMENT-TEMPLATES FR3)', async () => {
    const single = await mergedMachines(packWith({ produces: 'document' as const, template: 'quarterly-account-review' }));
    expect(single.pack_flow?.states?.working?.template).toBe('quarterly-account-review');

    const choice = await mergedMachines(packWith(
      { produces: 'document' as const, templates: ['full-review', 'one-page'], defaultTemplate: 'one-page' },
      { awaits: { party: 'requester' }, requires: ['the subject'] },
    ));
    expect(choice.pack_flow?.states?.working?.templates).toEqual(['full-review', 'one-page']);
    expect(choice.pack_flow?.states?.working?.defaultTemplate).toBe('one-page');

    // Carried as written, so an invalid declaration is REFUSED loudly rather than dropped: a template
    // on a step that does not deliver reverts the block to the defaults, which the operator can see.
    const refused = await mergedMachines(packWith({ template: 'quarterly-account-review' }));
    expect(refused.pack_flow).toBeUndefined();
  });

  it('carries a step\'s `tools` and its `action` with the outcome edges (SPEC-TASK-STATE-TRANSITIONS FR28, FR29)', async () => {
    const pack = (working: Record<string, unknown>) => JSON.stringify({
      intents: [{ key: 'reporting', description: 'a report request', keywords: ['report'] }],
      machines: {
        pack_flow: {
          initial: 'waiting',
          states: {
            waiting: { transitions: ['working'], awaits: { party: 'requester' }, requires: ['the window'], tools: ['load_company_context'] },
            working: { transitions: ['done', 'failed'], ...working },
            done: { transitions: [], terminal: 'success' },
            failed: { transitions: [], terminal: 'failure' },
          },
        },
      },
    });
    const merged = await mergedMachines(pack({
      action: { tool: 'read_deployment_health', args: { windowMinutes: 'requirement:the window' } },
      onSuccess: 'done',
      onFailure: 'failed',
    }));
    expect(merged.pack_flow?.states?.waiting?.tools).toEqual(['load_company_context']);
    expect(merged.pack_flow?.states?.working?.action).toEqual({ tool: 'read_deployment_health', args: { windowMinutes: 'requirement:the window' } });
    expect(merged.pack_flow?.states?.working?.onSuccess).toBe('done');
    expect(merged.pack_flow?.states?.working?.onFailure).toBe('failed');

    // Carried as written, so an action whose outcome edge is not a transition is refused whole-block.
    jest.resetModules();
    const refused = await mergedMachines(pack({ action: { tool: 'read_deployment_health' }, onSuccess: 'nowhere' }));
    expect(refused.pack_flow).toBeUndefined();
  });

  it('carries the card choices, on a waiting state, and `rests` on a working one (ADR-063)', async () => {
    const merged = await mergedMachines(packWith({ rests: true }, { awaits: { party: 'worker' }, choices: ['working'] }));
    expect(merged.pack_flow?.states?.working?.rests).toBe(true);
    expect(merged.pack_flow?.states?.waiting?.choices).toEqual(['working']);
  });

  it("carries a step's `when` and an edge's `edgeWhen`, and refuses one on member text (ADR-060 decision 6)", async () => {
    const merged = await mergedMachines(packWith(
      { when: { 'conversation:type': 'ops' } },
      { edgeWhen: { working: { 'signal:userLanguage': 'en' } } },
    ));
    expect(merged.pack_flow?.states?.working?.when).toEqual({ 'conversation:type': 'ops' });
    expect(merged.pack_flow?.states?.waiting?.edgeWhen).toEqual({ working: { 'signal:userLanguage': 'en' } });

    // Carried as written, so a condition on member text is refused whole-block rather than dropped.
    jest.resetModules();
    const refused = await mergedMachines(packWith({ when: { 'conversation:topic': 'x' } }));
    expect(refused.pack_flow).toBeUndefined();
  });

  it('carries `reopens` on a terminal state, and refuses a reopen into an ending', async () => {
    const pack = (reopens: unknown) => JSON.stringify({
      intents: [{ key: 'reporting', description: 'a report request', keywords: ['report'] }],
      machines: {
        pack_flow: {
          initial: 'working',
          states: {
            working: { transitions: ['done'] },
            done: { transitions: [], terminal: 'success', reopens },
          },
        },
      },
    });

    const merged = await mergedMachines(pack(['working']));
    expect(merged.pack_flow?.states?.done?.reopens).toEqual(['working']);

    // A reopen into the terminal itself is refused whole-block, so the pack machine is absent.
    jest.resetModules();
    const refused = await mergedMachines(pack(['done']));
    expect(refused.pack_flow).toBeUndefined();
  });

  it('carries `resolvedByOneResponse`, which is the prompt rule for a step that IS the answer', async () => {
    const merged = await mergedMachines(packWith({}, { resolvedByOneResponse: true, awaits: { party: 'requester' } }));

    expect(merged.pack_flow?.states?.waiting?.resolvedByOneResponse).toBe(true);
    expect(awaitedPartyOf(merged.pack_flow?.states?.waiting)).toEqual({ party: 'requester' });
  });

  it('carries `requires`, so a pack can state what its step needs', async () => {
    const merged = await mergedMachines(
      packWith({}, { awaits: { party: 'requester' }, requires: ['audience', 'format'] }),
    );

    expect(merged.pack_flow?.states?.waiting?.requires).toEqual(['audience', 'format']);
  });

  it('drops a `requires` entry that is not a string rather than admitting it', async () => {
    const merged = await mergedMachines(
      packWith({}, { awaits: { party: 'requester' }, requires: ['audience', 42, null] }),
    );

    expect(merged.pack_flow?.states?.waiting?.requires).toEqual(['audience']);
  });
});

describe('carrying the flags is what lets validation refuse a pack (it used to pass vacuously)', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.ASSISTANT_INTENT_PACK;
  });

  afterEach(() => {
    delete process.env.ASSISTANT_INTENT_PACK;
  });

  // Falling back to the platform defaults whole-block is the declared behavior for a malformed
  // `machines` block, and it is the right trade here: a deployment running the reference workflows is
  // one an operator can diagnose, while a block quietly missing the field that decides delivery is not.
  it('refuses a pack whose step declares `requires` while awaiting nobody', async () => {
    const merged = await mergedMachines(packWith({ requires: ['audience'] }));

    expect(merged.pack_flow).toBeUndefined();
    // The platform defaults are still there, so the deployment still runs.
    expect(merged.report_generation).toBeDefined();
  });

  it('refuses a pack that declares `requires` beside `resolvedByOneResponse`', async () => {
    const merged = await mergedMachines(
      packWith({}, { awaits: { party: 'requester' }, requires: ['audience'], resolvedByOneResponse: true }),
    );

    expect(merged.pack_flow).toBeUndefined();
    expect(merged.report_generation).toBeDefined();
  });

  it('still accepts the same pack once the contradiction is removed', async () => {
    // The refusals above have to be about the declaration, not about packs carrying these fields at
    // all - otherwise this suite would pass with the fields dropped again.
    const merged = await mergedMachines(packWith({}, { awaits: { party: 'requester' }, requires: ['audience'] }));

    expect(merged.pack_flow).toBeDefined();
    expect(merged.pack_flow?.states?.waiting?.requires).toEqual(['audience']);
  });
});
