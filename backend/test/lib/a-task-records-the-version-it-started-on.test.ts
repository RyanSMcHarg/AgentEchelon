/**
 * ADR-066 DECISION 5: A TASK RECORDS THE VERSION IT STARTED ON.
 *
 * The configId of the version the opening turn was served is written once at creation, by the platform only, on the task
 * and on its copy, so every reader resolves the task's machine through that version (`machinesForTask`) with no second
 * read, and a caller's `details` cannot choose it.
 */
import { DeliveryOption } from '../../lambda/src/lib/delivery-options';

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn().mockImplementation((a) => ({ __t: 'Put', input: a })),
  GetCommand: jest.fn().mockImplementation((a) => ({ __t: 'Get', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __t: 'Update', input: a })),
  QueryCommand: jest.fn().mockImplementation((a) => ({ __t: 'Query', input: a })),
  DeleteCommand: jest.fn().mockImplementation((a) => ({ __t: 'Delete', input: a })),
  ScanCommand: jest.fn().mockImplementation((a) => ({ __t: 'Scan', input: a })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

const EVENT = {
  inputTranscript: 'write me the quarterly report',
  requestAttributes: {
    'CHIME.channel.arn': 'arn:chan/c1',
    'CHIME.sender.arn': 'arn:aws:chime:..:app-instance/i/user/sub-requester',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.TASKS_TABLE = 'tasks-test';
  process.env.USER_TASKS_TABLE = 'user-tasks-test';
  mockSend.mockResolvedValue({});
});

const putItems = (table: string) => mockSend.mock.calls.map((c) => c[0])
  .filter((c) => c.__t === 'Put' && c.input.TableName === table).map((c) => c.input.Item);

describe('the task records its origin version', () => {
  it('createTask writes it, and the hash of its machine, on the task and on its copy', async () => {
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    const task = await createTask(EVENT, DeliveryOption.TASK_MULTI_STEP, 'report_generation', 'corr-1', {
      openingIntent: 'report_generation', originConfigId: 'cfg-v7', originMachineHash: 'abcdef012345',
    });
    expect(task.originConfigId).toBe('cfg-v7');
    const [row] = putItems('tasks-test');
    expect(row.originConfigId).toBe('cfg-v7');
    const [copy] = putItems('user-tasks-test');
    expect(copy.originConfigId).toBe('cfg-v7');
    expect(row.originMachineHash).toBe('abcdef012345');
    expect(copy.originMachineHash).toBe('abcdef012345');
  });

  it('starts in the initial state of the machine the version declares for it', async () => {
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    const { DEFAULT_TASK_STATE_MACHINES } = await import('../../lambda/src/lib/task-state-machines');
    const edited = JSON.parse(JSON.stringify(DEFAULT_TASK_STATE_MACHINES.report_generation));
    edited.states.confirming_audience = { transitions: [edited.initial], awaits: { party: 'requester' } };
    edited.initial = 'confirming_audience';
    const task = await createTask(EVENT, DeliveryOption.TASK_MULTI_STEP, 'report_generation', 'corr-2', {
      originConfigId: 'cfg-v7', machines: { report_generation: edited },
    });
    expect(task.taskState).toBe('confirming_audience');
  });

  it('a caller\'s details cannot set it, and a task opened with no version records none', async () => {
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    const task = await createTask(EVENT, DeliveryOption.TASK_MULTI_STEP, 'queued_request', 'corr-3', {
      details: { originConfigId: 'cfg-chosen-by-a-person' },
    });
    expect(task.originConfigId).toBeUndefined();
    const { machinesForTask } = await import('../../lambda/src/lib/version-machines');
    const { taskStateMachines } = await import('../../lambda/src/lib/intent-pack');
    expect(machinesForTask(task)).toEqual(taskStateMachines());
  });
});
