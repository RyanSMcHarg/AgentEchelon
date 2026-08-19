/**
 * Per-assistant task machines take effect AT LOOP TIME (SPEC-CONFIGURABLE-ASSISTANTS 4.5, runtime
 * precedence). active-profile.test.ts asserts a version's `machines` SURFACE on the resolved profile
 * and fail closed on an invalid graph; profile-config.spec.ts asserts they SURVIVE export/import. The
 * missing assertion is that they actually OVERRIDE the deployment intent-pack inside the task loop —
 * buildTaskLoopContext merges `{ ...deploymentPack, ...profileMachines }` per taskType. This guards
 * that merge: override the same taskType, inherit the rest, and no-op when the profile carries none.
 */
import type { TaskStateMachine } from '../../lambda/src/lib/task-state-machines';

// getTask is the only task-tracking call buildTaskLoopContext makes; stub it so the loop context builds
// without DynamoDB. requireActual keeps every other export async-processor-core imports from the module.
jest.mock('../../lambda/src/lib/task-tracking', () => ({
  __esModule: true,
  ...jest.requireActual('../../lambda/src/lib/task-tracking'),
  getTask: jest.fn(),
}));

import { buildTaskLoopContext } from '../../lambda/src/lib/async-processor-core';
import { getTask } from '../../lambda/src/lib/task-tracking';

const mockGetTask = getTask as jest.MockedFunction<typeof getTask>;

// A custom report_generation machine with a state the deployment default lacks (`legal_review`), so a
// single key-check discriminates "profile machine won" from "deployment pack won".
const CUSTOM_MACHINES: Record<string, TaskStateMachine> = {
  report_generation: {
    initial: 'collecting_requirements',
    states: {
      collecting_requirements: { transitions: ['drafting_outline'] },
      drafting_outline: { transitions: ['legal_review'] },
      legal_review: { transitions: ['generating'] },
      generating: { transitions: ['completed'] },
      completed: { transitions: [], terminal: 'success' },
    },
  },
};

const taskRow = (taskType: string) => ({
  taskId: 't1',
  channelArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/x/channel/c',
  taskType,
  taskState: 'collecting_requirements',
});

describe('buildTaskLoopContext — per-assistant machines override the deployment pack (4.5 runtime precedence)', () => {
  beforeEach(() => mockGetTask.mockReset());

  it('a profile machine OVERRIDES the deployment-pack machine for the same taskType', async () => {
    mockGetTask.mockResolvedValue(taskRow('report_generation') as any);
    const ctx = await buildTaskLoopContext({
      taskId: 't1',
      taskType: 'report_generation',
      channelArn: taskRow('report_generation').channelArn,
      machines: CUSTOM_MACHINES,
    });
    expect(ctx).toBeDefined();
    // The custom graph (with the extra legal_review state) is what the loop runs — not the default.
    expect(Object.keys(ctx!.machines!.report_generation!.states)).toContain('legal_review');
  });

  it('INHERITS the deployment pack for taskTypes the profile does not override', async () => {
    mockGetTask.mockResolvedValue(taskRow('data_extraction') as any);
    const ctx = await buildTaskLoopContext({
      taskId: 't1',
      taskType: 'data_extraction',
      channelArn: taskRow('data_extraction').channelArn,
      machines: CUSTOM_MACHINES, // overrides only report_generation
    });
    expect(ctx).toBeDefined();
    // data_extraction was not in the override → it comes straight from the deployment pack.
    expect(Object.keys(ctx!.machines!.data_extraction!.states)).not.toContain('legal_review');
    expect(ctx!.machines!.data_extraction!.states.completed).toBeDefined();
  });

  it('with NO profile machines, runs the deployment pack unchanged (byte-identical to pre-4.5)', async () => {
    mockGetTask.mockResolvedValue(taskRow('report_generation') as any);
    const ctx = await buildTaskLoopContext({
      taskId: 't1',
      taskType: 'report_generation',
      channelArn: taskRow('report_generation').channelArn,
    });
    expect(ctx).toBeDefined();
    expect(Object.keys(ctx!.machines!.report_generation!.states)).not.toContain('legal_review');
  });
});
