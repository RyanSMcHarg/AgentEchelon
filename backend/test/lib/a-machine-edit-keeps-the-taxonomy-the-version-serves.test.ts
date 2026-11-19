/**
 * EDITING A MACHINE KEEPS THE TAXONOMY THE VERSION SERVES (ADR-067 stage 1).
 *
 * A version's `intentPack` replaces its classification's whole, so a version with no pack of its own that edits a
 * machine in the console needs a pack that says the same intents. On the platform's pack that is
 * `{ extends: 'default', intents: [], machines }`, which the write path accepts and the read path resolves to every
 * platform intent with the machine; on a classification's own pack the console copies the pack as stored, which the
 * catalog now serves.
 */
import { DEFAULT_INTENT_PACK, resolveStoredPack } from '../../lambda/src/lib/intent-pack-taxonomy';
import { parseIntentPack, validateIntentPackBody } from '../../lambda/src/lib/intent-pack';
import { storedPackOf } from '../../lambda/src/lib/classification-catalog';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';

const machine = DEFAULT_TASK_STATE_MACHINES.report_generation;

describe('a pack that inherits the platform taxonomy and adds only a machine', () => {
  const pack = { extends: 'default' as const, intents: [], machines: { report_generation: machine } };

  it('is accepted by the write path', () => {
    expect(validateIntentPackBody(pack)).toEqual([]);
  });

  it('serves every platform intent, with its machine, on both read paths', () => {
    const keys = DEFAULT_INTENT_PACK.intents.map((i) => i.key).sort();
    expect(resolveStoredPack(pack as never).intents.map((i) => i.key).sort()).toEqual(keys);
    const parsed = parseIntentPack(JSON.stringify(pack));
    expect(parsed.intents.map((i) => i.key).sort()).toEqual(keys);
    expect(parsed.machines?.report_generation).toEqual(machine);
  });

  it('is still refused without `extends`, where an empty list would replace the taxonomy with nothing', () => {
    expect(validateIntentPackBody({ intents: [], machines: {} })).toContain('intentPack.intents must declare at least one intent');
  });
});

describe('the classification pack as the catalog serves it for copying', () => {
  it('reads the object form and the older bare list, and nothing it cannot read', () => {
    const stored = { intents: [{ key: 'x', description: 'd', keywords: [], delivery: 'TASK_MULTI_STEP' }], machines: { x: machine } };
    expect(storedPackOf(JSON.stringify(stored))).toEqual(stored);
    expect(storedPackOf(JSON.stringify(stored.intents))).toEqual({ intents: stored.intents });
    expect(storedPackOf('{not json')).toBeUndefined();
    expect(storedPackOf(JSON.stringify({ machines: {} }))).toBeUndefined();
    expect(storedPackOf(undefined)).toBeUndefined();
  });
});
