/**
 * ADR-066, INTENTS IN ANALYTICS: A TASK TURN RECORDS THE VERSION AND THE MACHINE ITS TASK STARTED ON.
 *
 * What it proves:
 *   - the hash of a machine is the content hash of its canonical JSON: a version edit that changes only the persona
 *     keeps it, and an edit to the machine changes it;
 *   - the router records the hash beside the origin version on the task it opens, and the turn's analytics carry both
 *     from the task row;
 *   - the archive record of an assistant's turn carries both, a person's message declares neither, and the `messages`
 *     projection writes them into the columns migration 097 adds.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: jest.fn(async () => null),
  writeMessageAnalytics: jest.fn(async () => undefined),
}));
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  batchInsert: jest.fn(async () => 0),
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  transaction: jest.fn(),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));

import { transformToMessageRecord } from '../../lambda/src/analytics-aurora/kinesis-archival';
import { buildAnalyticsMetadata } from '../../lambda/src/lib/analytics-metadata';
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { machineHashOf, machinesForVersion, __clearVersionMachines } from '../../lambda/src/lib/version-machines';
import { buildDefinition, bodyFrom } from '../../lambda/src/lib/active-profile';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c-premium';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/premium-assistant';
const PERSON = 'arn:aws:chime:us-east-1:1:app-instance/i/user/u1';

const EDITED: TaskStateMachine = (() => {
  const m = JSON.parse(JSON.stringify(DEFAULT_TASK_STATE_MACHINES.report_generation)) as TaskStateMachine;
  m.states.confirming_audience = { transitions: [m.initial], awaits: { party: 'requester' } };
  m.initial = 'confirming_audience';
  return m;
})();
const body = (persona: string, machine: TaskStateMachine) => bodyFrom({
  modelKey: 'sonnet', persona,
  intentPack: { extends: 'default', intents: [{ key: 'report_generation' }], machines: { report_generation: machine } },
} as never);

beforeEach(() => __clearVersionMachines());

describe('the hash of the machine a task starts on', () => {
  it('is kept by an edit that changes only the persona, and changed by an edit to the machine', () => {
    const v1 = buildDefinition('analyst', body('You analyze.', EDITED));
    const v2 = buildDefinition('analyst', body('You analyze, briefly.', EDITED));
    const reordered = JSON.parse(JSON.stringify({ states: EDITED.states, initial: EDITED.initial })) as TaskStateMachine;
    const v3 = buildDefinition('analyst', body('You analyze.', { ...EDITED, states: { ...EDITED.states, confirming_audience: { ...EDITED.states.confirming_audience, prompt: 'Ask who reads it.' } } }));
    // Two versions: their configIds differ, and the machine each runs hashes the same.
    expect(v1.configId).not.toBe(v2.configId);
    const hashOf = (def: typeof v1) => machineHashOf(machinesForVersion({ configId: def.configId, intentPack: def.intentPack as never }).report_generation);
    expect(hashOf(v1)).toBe(hashOf(v2));
    // Key order is not content.
    expect(machineHashOf(reordered)).toBe(machineHashOf(EDITED));
    // An edit to the machine is a different machine.
    expect(hashOf(v3)).not.toBe(hashOf(v1));
    expect(hashOf(v1)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is recorded by the router beside the origin version, and carried onto the turn from the task row', () => {
    const router = read('lambda/src/router-agent-handler.ts');
    expect(router).toContain('const originMachineHash = taskType ? machineHashOf(turnMachines[taskType]) : undefined;');
    const core = read('lambda/src/lib/async-processor-core.ts');
    expect(core).toContain('...(params.taskContext?.task.originConfigId && { taskOriginConfigId: params.taskContext.task.originConfigId }),');
    expect(core).toContain('...(params.taskContext?.task.originMachineHash && { taskOriginMachineHash: params.taskContext.task.originMachineHash }),');
  });

  it('is copied into the analytics metadata', () => {
    const m = buildAnalyticsMetadata({ taskOriginConfigId: 'cfg-v7', taskOriginMachineHash: 'abcdef012345' } as never);
    expect(m.taskOriginConfigId).toBe('cfg-v7');
    expect(m.taskOriginMachineHash).toBe('abcdef012345');
  });
});

describe('the archive record of a task turn', () => {
  const event = (sender: string, analytics: Record<string, unknown>) => ({
    EventType: 'CREATE_CHANNEL_MESSAGE',
    Payload: {
      MessageId: 'm-1', ChannelArn: CHANNEL, Content: 'here is the report', Sender: { Arn: sender, Name: 'Sender' },
      CreatedTimestamp: '2026-11-04T10:00:00.000Z', Persistence: 'PERSISTENT', Metadata: JSON.stringify({ analytics }),
    },
  });
  const DECLARED = { taskType: 'report_generation', taskOriginConfigId: 'cfg-v7', taskOriginMachineHash: 'abcdef012345' };

  it("carries the origin version and machine an assistant's turn declares", async () => {
    const rec = await transformToMessageRecord(event(BOT, DECLARED) as never);
    expect({ c: rec?.task_origin_config_id, h: rec?.task_origin_machine_hash }).toEqual({ c: 'cfg-v7', h: 'abcdef012345' });
  });

  it("files neither from a person's message", async () => {
    const rec = await transformToMessageRecord(event(PERSON, DECLARED) as never);
    expect({ c: rec?.task_origin_config_id, h: rec?.task_origin_machine_hash }).toEqual({ c: null, h: null });
  });

  it('is projected into the messages columns migration 097 adds', () => {
    const archival = read('lambda/src/analytics-aurora/kinesis-archival.ts');
    expect(archival).toContain("'task_origin_config_id',");
    expect(archival).toContain("'task_origin_machine_hash',");
    const migration = read('lambda/src/analytics-aurora/schema/097-a-task-turn-records-the-version-and-machine-its-task-started-on.sql');
    expect(migration).toContain('ALTER TABLE messages ADD COLUMN IF NOT EXISTS task_origin_config_id');
    expect(migration).toContain('ALTER TABLE messages ADD COLUMN IF NOT EXISTS task_origin_machine_hash');
  });
});
