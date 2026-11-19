/**
 * A CLASSIFICATION'S PACK CANNOT OVERRIDE A PLATFORM MACHINE (ADR-066 decision 2).
 *
 * The queue's machines and the work items every assistant shares are the platform's. A version is refused one by name;
 * a classification's pack is held to the same rule twice: the writer refuses it, and the runtime never reads one.
 */
import { taskStateMachines, writeClassificationPack } from '../../lambda/src/lib/intent-pack';
import { DEFAULT_TASK_STATE_MACHINES, PLATFORM_MACHINE_KEYS } from '../../lambda/src/lib/task-state-machines';

const OWN = { initial: 'start', states: { start: { transitions: { done: 'done' } }, done: { terminal: 'success' } } };

describe('a platform machine in a pack', () => {
  it('is never read at runtime: every platform key resolves to the platform default', () => {
    const shadow = Object.fromEntries(PLATFORM_MACHINE_KEYS.map((k) => [k, OWN]));
    const machines = taskStateMachines({ intents: [], machines: { ...shadow, my_work: OWN } } as never);
    for (const k of PLATFORM_MACHINE_KEYS) {
      if (DEFAULT_TASK_STATE_MACHINES[k]) expect(machines[k]).toBe(DEFAULT_TASK_STATE_MACHINES[k]);
      else expect(machines[k]).toBeUndefined();
    }
    expect(machines.my_work).toBe(OWN);
  });

  it('is refused by the writer, naming the key, and nothing is stored', async () => {
    const send = jest.fn();
    const s3 = { send: jest.fn() };
    const pack = JSON.stringify({ extends: 'default', intents: [], machines: { action_item: OWN } });
    await expect(writeClassificationPack({ send } as never, '/r', 'standard', pack, { s3, bucket: 'b' } as never))
      .rejects.toThrow(/platform machines \(action_item\)/);
    expect(send).not.toHaveBeenCalled();
    expect(s3.send).not.toHaveBeenCalled();
  });
});
