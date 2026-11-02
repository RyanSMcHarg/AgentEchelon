/**
 * A STOP CANCELS THE WORK IN PROGRESS AND LEAVES THE QUEUE (ADR-033, "`/stop` does not touch the
 * queue" and "Completed work is kept; work in progress is cancelled").
 *
 * The queue's rows carry the person as requester and the stopped assistant as `assistantId`, so the
 * selection by requester and assistant picked them up: the drain (the reading of the queue) and every
 * queued request triage had proposed but nobody had begun. A stop then discarded "the headcount
 * question" the ADR names as still a question.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  QueryCommand: class { __t = 'Query'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
  PutCommand: class { __t = 'Put'; constructor(public input: any) {} },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  DeleteCommand: class { __t = 'Delete'; constructor(public input: any) {} },
  ScanCommand: class { __t = 'Scan'; constructor(public input: any) {} },
}));

process.env.TASKS_TABLE = 'tasks';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tasks = require('../../lambda/src/lib/task-tracking');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const drain = require('../../lambda/src/lib/queue-drain-task');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const triage = require('../../lambda/src/lib/turn-triage-proposal');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const ALICE_SUB = 'alice';
const ALICE = `arn:aws:chime:us-east-1:1:app-instance/i/user/${ALICE_SUB}`;
const ASSISTANT = 'assistant-premium';

const row = (taskId: string, taskType: string, taskState?: string) => ({
  taskId,
  channelArn: CHANNEL,
  userArn: ALICE,
  assistantId: ASSISTANT,
  status: 'in_progress',
  taskType,
  ...(taskState ? { taskState } : {}),
  createdAt: '2026-09-15T10:00:00.000Z',
  updatedAt: '2026-09-15T10:00:00.000Z',
});

function serve(rows: Array<ReturnType<typeof row>>) {
  const byId = new Map(rows.map((r) => [r.taskId, r]));
  mockSend.mockImplementation(async (cmd: any) => {
    if (cmd.__t === 'Query') return { Items: rows };
    if (cmd.__t === 'Get') return { Item: byId.get(cmd.input.Key.taskId) };
    return {};
  });
}

beforeEach(() => mockSend.mockReset());

describe('a stop selects the running work and not the queue', () => {
  it('cancels the report and leaves the drain and the proposed headcount question', async () => {
    serve([
      row('report', 'report_generation', 'generating'),
      row('drain', 'queue_drain', 'reviewing'),
      row('headcount', 'queued_request', 'proposed'),
      row('unclear', 'queued_clarification', 'asked'),
      row('combine', 'queued_combination', 'asked'),
    ]);
    const picked = await tasks.selectStoppableTasks(CHANNEL, ALICE_SUB, ASSISTANT);
    expect(picked.map((p: any) => p.full.taskId)).toEqual(['report']);
  });

  it('cancels a queued request the person already accepted, because that is work in progress', async () => {
    // Non-vacuity: a filter on the type alone would pass the test above and never stop accepted work.
    serve([row('accepted', 'queued_request', 'accepted'), row('merging', 'queued_combination', 'merging')]);
    const picked = await tasks.selectStoppableTasks(CHANNEL, ALICE_SUB, ASSISTANT);
    expect(picked.map((p: any) => p.full.taskId)).toEqual(['accepted', 'merging']);
  });

  it('treats a queued row with no recorded state as not yet begun', async () => {
    serve([row('stateless', 'queued_request')]);
    expect(await tasks.selectStoppableTasks(CHANNEL, ALICE_SUB, ASSISTANT)).toEqual([]);
  });

  it('names the same types the queue creates, so a renamed constant cannot reopen this', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../lambda/src/lib/task-tracking.ts'), 'utf8',
    );
    expect(src).toContain(`const QUEUE_DRAIN_TYPE = '${drain.QUEUE_DRAIN_TASK_TYPE}'`);
    for (const t of [triage.QUEUED_REQUEST_TASK_TYPE, triage.QUEUED_CLARIFICATION_TASK_TYPE, drain.QUEUED_COMBINATION_TASK_TYPE]) {
      expect(src).toMatch(new RegExp(`QUEUED_ITEM_TYPES = new Set\\(\\[[^\\]]*'${t}'`));
    }
  });
});
