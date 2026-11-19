/**
 * ADR-067 STAGE 2: A TASK CARRIES THE MACHINE IT STARTED ON, AND A RUN CONTINUES ON THE VERSION IT STARTED ON.
 *
 * What it proves: a task opened from a version's own machine records that machine on its row and on its copy, beside its
 * configId and hash; every reader moves it on that machine (`machinesOfTask`, `machinesForTask`), so a state only its
 * version declares is one a card press, a deadline and `/tasks/mine` read, whatever the classification's set says; and a
 * task with none moves on the set it was given. A run records its origin version, which its task and its agent hand-off
 * carry back.
 */
import { DeliveryOption } from '../../lambda/src/lib/delivery-options';
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';

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
  requestAttributes: { 'CHIME.channel.arn': 'arn:chan/c1', 'CHIME.sender.arn': 'arn:aws:chime:..:app-instance/i/user/sub-requester' },
};

/** A version's own report machine, with a state the classification's set does not have. */
function editedReport(): TaskStateMachine {
  const m = JSON.parse(JSON.stringify(DEFAULT_TASK_STATE_MACHINES.report_generation)) as TaskStateMachine;
  m.states.sign_off = { transitions: [m.initial], awaits: { party: 'requester' }, choices: [m.initial], requires: ['the sign-off'] };
  m.states[m.initial] = { ...m.states[m.initial], transitions: [...m.states[m.initial].transitions, 'sign_off'] };
  return m;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.TASKS_TABLE = 'tasks-test';
  process.env.USER_TASKS_TABLE = 'user-tasks-test';
  mockSend.mockResolvedValue({});
});

const putItems = (table: string) => mockSend.mock.calls.map((c) => c[0])
  .filter((c) => c.__t === 'Put' && c.input.TableName === table).map((c) => c.input.Item);

describe('the task carries the machine it started on', () => {
  it('createTask writes it on the task and on its copy, beside its configId and hash', async () => {
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    const { machineHashOf } = await import('../../lambda/src/lib/version-machines');
    const m = editedReport();
    await createTask(EVENT, DeliveryOption.TASK_MULTI_STEP, 'report_generation', 'corr-1', {
      originConfigId: 'cfg-v8', originMachineHash: machineHashOf(m), originMachine: m, machines: { report_generation: m },
    });
    const [row] = putItems('tasks-test');
    const [copy] = putItems('user-tasks-test');
    expect(row.originMachine).toEqual(m);
    expect(copy.originMachine).toEqual(m);
    expect(row.originMachineHash).toBe(machineHashOf(m));
  });

  it('every reader moves it on that machine, and a task with none on the set it was given', async () => {
    const { machinesOfTask, machinesForTask } = await import('../../lambda/src/lib/version-machines');
    const { taskStateMachines } = await import('../../lambda/src/lib/intent-pack');
    const m = editedReport();
    const task = { taskType: 'report_generation', taskState: 'sign_off', originConfigId: 'cfg-v8', originMachine: m };
    expect(machinesOfTask(task, taskStateMachines()).report_generation.states.sign_off).toBeDefined();
    expect(machinesForTask(task).report_generation).toEqual(m);
    // The classification's set is untouched for every other type.
    expect(machinesForTask(task).image_generation).toEqual(taskStateMachines().image_generation);
    const plain = { taskType: 'report_generation', taskState: 'gathering' };
    expect(machinesOfTask(plain, taskStateMachines())).toEqual(taskStateMachines());
  });

  it('a card press on a state only its version declares is that state\'s to take', async () => {
    const { assigneeAdvanceRefusal } = await import('../../lambda/src/lib/workflow-task');
    const { machinesOfTask } = await import('../../lambda/src/lib/version-machines');
    const { taskStateMachines } = await import('../../lambda/src/lib/intent-pack');
    const m = editedReport();
    const task = {
      taskId: 't1', channelArn: 'arn:chan/c1', taskType: 'report_generation', taskState: 'sign_off', status: 'in_progress',
      assigneeId: 'sub-requester', assigneeType: 'user', requesterId: 'sub-requester', originMachine: m,
    } as never;
    const press = { callerPersonId: 'sub-requester', state: 'sign_off', choice: m.initial, taskId: 't1', channelArn: 'arn:chan/c1' };
    // On the classification's set the state does not exist, so the press is refused; on the task's own it is taken.
    expect(assigneeAdvanceRefusal(task, taskStateMachines(), press)).toBeTruthy();
    expect(assigneeAdvanceRefusal(task, machinesOfTask(task, taskStateMachines()), press)).toBeUndefined();
  });

  it('what /tasks/mine says a step needs is read from the task\'s own machine', async () => {
    const { toOpenWorkItem } = await import('../../lambda/src/user-tasks-api');
    const { machinesOfTask } = await import('../../lambda/src/lib/version-machines');
    const { taskStateMachines } = await import('../../lambda/src/lib/intent-pack');
    const m = editedReport();
    const row = { taskId: 't1', channelArn: 'arn:chan/c1', taskType: 'report_generation', taskState: 'sign_off', status: 'in_progress', originMachine: m } as never;
    expect(toOpenWorkItem(row, machinesOfTask(row, taskStateMachines())).needs).toEqual(['the sign-off']);
    expect(toOpenWorkItem(row, taskStateMachines()).needs).toBeUndefined();
  });
});

describe('the run records where it started', () => {
  it('the task step opens on the run version\'s machine and records the run\'s origin, and the hand-off carries it back', () => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const path = jest.requireActual('path') as typeof import('path');
    const router = fs.readFileSync(path.resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    // The run's own version's machine; a request to another assistant's role is that assistant's own run (WT118).
    expect(router).toMatch(/const machineVersion: WorkflowRunner\['version'\] = who\.version;/);
    expect(router).toMatch(/const machineDef = versionDeclaredMachines\(machineVersion\?\.intentPack\)\?\.\[def\.machine\];/);
    // The run's origin, computed once in its edition and carried on every run reference.
    expect(router).toMatch(/const origin = runOriginOf\(who\.version\);/);
    expect(router).toMatch(/\.\.\.\(e\.origin \? \{ origin: e\.origin \} : \{\}\)/);
    expect(router).toMatch(/const served = await runOriginVersion\(assistant\.profile\.name, channelArn, req\.origin\);/);
    const processor = fs.readFileSync(path.resolve(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
    expect(processor).toContain('...(req.origin ? { origin: req.origin } : {}),');
  });
});
