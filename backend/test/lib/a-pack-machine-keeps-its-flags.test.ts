/**
 * A DEPLOYMENT PACK'S MACHINE KEEPS THE FLAGS IT DECLARED (tracker row 225, owner decision: carry all
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
    const merged = await mergedMachines(packWith({ delivers: true }));

    expect(merged.pack_flow?.states?.working?.delivers).toBe(true);

    // The gate derives its delivering states with exactly this expression over the merged machines
    // (the expression itself is source-ratcheted in deliver-on-generation.test.ts). Stripped, this
    // list was empty for every pack, and a declared deliverable shipped as chat text.
    const delivering = Object.entries(merged.pack_flow!.states)
      .filter(([, d]) => d.delivers)
      .map(([name]) => name);
    expect(delivering).toEqual(['working']);
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

  // Falling back to the platform defaults whole-block is the declared behaviour for a malformed
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
