/**
 * A REQUEST IS NEVER THE ANSWER TO THE TASK IT OPENED.
 *
 * Amazon Chime SDK delivers at least once. A redelivered targeted request reached the router's
 * waiting-task step before the duplicate check, and by then the task its first delivery opened was
 * waiting on the person (a report's first step asks a clarifying question). The step found that task,
 * read the redelivery as the person's answer, and handed it back to the assistant, which moved it out of
 * the person's own queue while they still owed it an answer. Traced from the archive and the router logs.
 *
 * The refusal lives in `applyUserResponseToTask`, the one place both router call sites go through, and
 * reads the row it already fetched: the mirror the router ranks candidates on does not carry the
 * opening message id. The router then treats the refusal as "nothing resumed".
 *
 * The same delivery's drift offer is covered here too, because it is the other half of what that
 * targeted request produced: an offer to a targeted request is targeted (DESIGN-TASK-ACCESS 2.4).
 */
const mockSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  GetCommand: class { constructor(public input: unknown) { (this as { __type?: string }).__type = 'Get'; } },
  PutCommand: class { constructor(public input: unknown) { (this as { __type?: string }).__type = 'Put'; } },
  UpdateCommand: class { constructor(public input: unknown) { (this as { __type?: string }).__type = 'Update'; } },
  DeleteCommand: class { constructor(public input: unknown) { (this as { __type?: string }).__type = 'Delete'; } },
  QueryCommand: class { constructor(public input: unknown) { (this as { __type?: string }).__type = 'Query'; } },
  ScanCommand: class { constructor(public input: unknown) { (this as { __type?: string }).__type = 'Scan'; } },
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));

import * as fs from 'fs';
import * as path from 'path';
import type { TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { DeliveryOption } from '../../lambda/src/lib/delivery-options';
import type { Task } from '../../lambda/src/lib/task-tracking';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const REQUESTER = 'sub-requester';
const BOT_ID = 'AltSlot0';
const OPENING_MESSAGE = 'msg-opening';

type Cmd = { __type: string; input: Record<string, unknown> };
const ownerWrites = () => mockSend.mock.calls
  .map((c) => c[0] as Cmd)
  .filter((c) => c.__type === 'Update')
  .map((c) => String(c.input.UpdateExpression ?? ''))
  .filter((e) => e.includes('assigneeId'));

/** A report-shaped machine whose first step asks the requester a question. */
const MACHINES: Record<string, TaskStateMachine> = {
  asks_first: {
    initial: 'clarifying',
    states: {
      clarifying: { transitions: ['working'], awaits: { party: 'requester' } },
      working: { transitions: ['done'] },
      done: { transitions: [], terminal: 'success' },
    },
  },
};

/** The task as the first delivery left it: waiting on the person, opened by `OPENING_MESSAGE`. */
const waitingTask = (over: Partial<Task> = {}): Task => ({
  taskId: 't1',
  channelArn: CHANNEL,
  taskType: 'asks_first',
  taskState: 'clarifying',
  status: 'in_progress' as const,
  userArn: `arn:aws:chime:us-east-1:111:app-instance/i/user/${REQUESTER}`,
  assigneeId: REQUESTER,
  assigneeType: 'user' as const,
  userMessageId: OPENING_MESSAGE,
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
  deliveryOption: DeliveryOption.TASK_MULTI_STEP,
  ttl: 0,
  ...over,
} as Task);

beforeEach(() => {
  jest.resetModules();
  mockSend.mockReset();
  process.env.TASKS_TABLE = 'tasks';
  process.env.USER_TASKS_TABLE = 'user-tasks';
});

const serving = (task: Task) => mockSend.mockImplementation((cmd: Cmd) =>
  cmd.__type === 'Get' ? Promise.resolve({ Item: task }) : Promise.resolve({}));

describe('the waiting task is not answered by the message that opened it', () => {
  it('refuses a redelivery of the opening message and hands nothing back', async () => {
    const { applyUserResponseToTask } = await import('../../lambda/src/lib/task-tracking');
    serving(waitingTask());

    const r = await applyUserResponseToTask({
      taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID, machines: MACHINES, messageId: OPENING_MESSAGE,
    });

    expect(r).toEqual({ applied: false, reason: 'opened_by_this_message', from: 'clarifying' });
    // The task stays in the person's queue: no owner write at all.
    expect(ownerWrites()).toHaveLength(0);
  });

  it('still hands the work back for a different message, which is the actual answer', async () => {
    const { applyUserResponseToTask } = await import('../../lambda/src/lib/task-tracking');
    serving(waitingTask());

    const r = await applyUserResponseToTask({
      taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID, machines: MACHINES, messageId: 'msg-answer',
    });

    expect(r.reason).toBe('deferred_to_model');
    expect(ownerWrites().length).toBeGreaterThan(0);
  });

  it('does not treat an unknown id on either side as a match', async () => {
    // The Lex path cannot resolve the inbound id, and older rows carry none. Absent is not equal.
    const { applyUserResponseToTask } = await import('../../lambda/src/lib/task-tracking');
    serving(waitingTask({ userMessageId: undefined }));
    const noRowId = await applyUserResponseToTask({
      taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID, machines: MACHINES, messageId: OPENING_MESSAGE,
    });
    expect(noRowId.reason).toBe('deferred_to_model');

    mockSend.mockReset();
    serving(waitingTask());
    const noInboundId = await applyUserResponseToTask({
      taskId: 't1', channelArn: CHANNEL, assistantId: BOT_ID, machines: MACHINES,
    });
    expect(noInboundId.reason).toBe('deferred_to_model');
  });
});

describe('the router reads the refusal as nothing resumed', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');

  it('passes the inbound message id at both call sites', () => {
    const calls = SRC.split('await applyUserResponseToTask({').slice(1);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.slice(0, 1200)).toContain('messageId: inboundMessageId(event)');
    }
  });

  it('resumes nothing on the person-held branch when the message opened the task', () => {
    // The task is not made this turn's active task, so neither the resume nor the decline guard reads it.
    expect(SRC).toMatch(
      /if \(applied\.reason === 'opened_by_this_message'\) \{[\s\S]{0,300}\} else \{[\s\S]{0,700}activeTask = answered;/,
    );
  });

  it('resumes nothing on the assistant-held branch either', () => {
    expect(SRC).toMatch(
      /if \(applied\.reason === 'opened_by_this_message'\) \{[\s\S]{0,300}\} else \{\s*activeTask = mine;/,
    );
  });
});

describe('a drift offer on a targeted request is targeted', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');
  const at = SRC.indexOf('if (driftResponse) {');
  const branch = SRC.slice(at, SRC.indexOf('return formatLexResponse(event, driftResponse.messages);', at));

  it('the drift branch exists, so the assertions below are not vacuous', () => {
    expect(at).toBeGreaterThan(-1);
    expect(branch.length).toBeGreaterThan(200);
  });

  it('checks the stored message, because the flow declaration speaks only for the text', () => {
    expect(branch).toContain("event.requestAttributes?.[BYPASS_TARGETED_ATTR] !== '1'");
    // Fails toward PRIVATE: anything short of a proven public request targets the offer.
    expect(branch).toMatch(/inboundTarget\(chimeClient, channelArn, offeredFor, await getBotArn\(\)\) !== 'public'/);
  });

  it('declares the turn targeted, which is what makes the flow entry post it to the sender alone', () => {
    expect(branch).toContain("[BYPASS_TARGETED_ATTR]: '1'");
    // `postAsAssistant` is the poster for a flow entry and targets exactly what this attribute declares.
    const poster = SRC.slice(SRC.indexOf('async function postAsAssistant('), SRC.indexOf('const runTurn = async'));
    expect(poster).toContain("event.requestAttributes?.[BYPASS_TARGETED_ATTR] === '1' && !!senderArn");
    expect(poster).toContain('Target: [{ MemberArn: senderArn }]');
  });
});
