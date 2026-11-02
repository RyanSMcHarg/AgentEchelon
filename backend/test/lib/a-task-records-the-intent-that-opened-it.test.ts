/**
 * ADR-064 DECISION B: A TASK RECORDS THE INTENT THAT OPENED IT.
 *
 * A task whose type the pack declares as an intent is configured under that intent. A platform machine
 * (`queued_request`, `queue_drain`, ...) is not an intent, so its steps route, and its turns are attributed, under the
 * intent the request that opened it was classified as. That intent is written once at creation, by the platform only, on
 * the task and on its copy, so the turn that resumes the task reads it with no second read, and Effectiveness counts the
 * turn under `COALESCE(task_type, intent)` as the work it carries.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DeliveryOption } from '../../lambda/src/lib/delivery-options';
import { taskIntentOf } from '../../lambda/src/lib/step-models';
import { routedModel } from '../../lambda/src/lib/resolve-model-plan';
import { buildIntentStrategy } from '../../lambda/src/lib/active-profile';
import { getModelCatalog, type BackendModelDefinition, type BackendModelKey } from '../../lib/config/model-strategy';

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

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
const EVENT = {
  inputTranscript: 'take this off the queue',
  requestAttributes: {
    'CHIME.channel.arn': 'arn:chan/c1',
    'CHIME.sender.arn': 'arn:aws:chime:..:app-instance/i/user/sub-requester',
  },
};
const DECLARED = new Set(['general', 'report_generation', 'image_generation', 'acknowledgment']);

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.TASKS_TABLE = 'tasks-test';
  process.env.USER_TASKS_TABLE = 'user-tasks-test';
  mockSend.mockResolvedValue({});
});

const putItems = (table: string) => mockSend.mock.calls.map((c) => c[0])
  .filter((c) => c.__t === 'Put' && c.input.TableName === table).map((c) => c.input.Item);

describe('the task intent', () => {
  it('is the type where the type is an intent, whatever opened it', () => {
    expect(taskIntentOf('report_generation', DECLARED, 'general', 'acknowledgment')).toBe('report_generation');
  });

  it('is the opening intent for a platform machine, not the message the turn is answering', () => {
    expect(taskIntentOf('queued_request', DECLARED, 'report_generation', 'acknowledgment')).toBe('report_generation');
    expect(taskIntentOf('queue_drain', DECLARED, 'image_generation', 'general')).toBe('image_generation');
  });

  it('falls to the classified intent only for a task no classified request opened', () => {
    expect(taskIntentOf('queued_request', DECLARED, undefined, 'general')).toBe('general');
  });

  it('routes a platform machine\'s delivering step on the opening intent\'s route', () => {
    // A queued report request's turn that runs a delivering step: the step runs on the report route, where the message
    // the turn answers ("looks good") would have put it on the general route.
    const catalog = getModelCatalog('us-east-1', '111122223333') as Record<BackendModelKey, BackendModelDefinition>;
    const routes = { general: { primary: 'haiku' }, acknowledgment: { primary: 'haiku' }, report_generation: { primary: 'sonnet' } };
    const deps = { catalog, strategy: buildIntentStrategy({ byIntent: routes })!, models: { selected: ['haiku', 'sonnet', 'opus'], default: 'opus' }, routes };
    const turn = (opening: string | undefined) => routedModel({
      classification: 'premium', intent: 'acknowledgment', continuesActiveWork: true,
      task: { intent: taskIntentOf('queued_request', DECLARED, opening, 'acknowledgment'), step: 'generating', produces: 'document' },
    }, deps);
    expect(turn('report_generation').primaryModelKey).toBe('sonnet');
    // Without the recorded intent the delivering step ran on the message's own route.
    expect(turn(undefined).primaryModelKey).toBe('haiku');
  });
});

describe('the task records it, once, from the platform only', () => {
  it('createTask writes the opening intent and the arm on the task and on its copy', async () => {
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    const task = await createTask(EVENT, DeliveryOption.TASK_MULTI_STEP, 'queued_request', 'corr-1', {
      openingIntent: 'report_generation',
      experimentArm: { experimentId: 'e1', variantId: 'treatment', configId: 'cfg' },
    });
    expect(task.openingIntent).toBe('report_generation');
    expect(task.experimentArm).toEqual({ experimentId: 'e1', variantId: 'treatment', configId: 'cfg' });
    const [row] = putItems('tasks-test');
    expect(row.openingIntent).toBe('report_generation');
    const [copy] = putItems('user-tasks-test');
    expect(copy.openingIntent).toBe('report_generation');
    expect(copy.experimentArm).toEqual({ experimentId: 'e1', variantId: 'treatment', configId: 'cfg' });
  });

  it('a caller\'s details cannot set either field', async () => {
    // A person's own work item passes `details` through (user-tasks-api.ts); a field there is not the platform's record.
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    const { experimentArmOf } = await import('../../lambda/src/lib/experiment-manager');
    const task = await createTask(EVENT, DeliveryOption.TASK_MULTI_STEP, 'queued_request', 'corr-2', {
      details: { openingIntent: 'report_generation', experimentArm: { experimentId: 'e1', variantId: 'treatment' } },
    });
    expect(task.openingIntent).toBeUndefined();
    expect(experimentArmOf(task)).toBeNull();
  });

  it('the person-facing create route builds its options field by field and names neither', () => {
    const api = read('lambda/src/user-tasks-api.ts');
    const opts = api.slice(api.indexOf("invokeTaskService(serviceArn, 'createTask'"), api.indexOf('if (!created?.taskId)'));
    expect(opts).not.toMatch(/openingIntent|experimentArm/);
  });
});

describe('every door that opens a task for a classified request records its intent', () => {
  const router = read('lambda/src/router-agent-handler.ts');
  it('the router, on the ordinary and the duel branch, and the drain it opens for a queued message', () => {
    expect(router.match(/openingIntent: classification\.intent,/g)?.length).toBe(3);
    expect(router).toContain('enqueueMessage({ channelArn, responderId, messageId: queuedMessageId, intent: classification.intent })');
  });

  it('a reading opens each queued request under the intent its message queued with', () => {
    const proposal = read('lambda/src/lib/turn-triage-proposal.ts');
    expect(proposal).toContain('...(args.intentsById?.[item.messageId] ? { openingIntent: args.intentsById[item.messageId] } : {}),');
    const core = read('lambda/src/lib/async-processor-core.ts');
    expect(core).toContain('intentsById: stageState.queuedIntents,');
  });

  it('a merged request carries on the intent its combination question was opened under', () => {
    expect(read('lambda/src/lib/queue-drain-task.ts')).toContain('...(task.openingIntent ? { openingIntent: task.openingIntent } : {}),');
  });
});

describe('the turn routes and is attributed under it', () => {
  const processor = read('lambda/src/assistant-async-processor.ts');
  it('reads the opening intent off the task row the turn already reads', () => {
    expect(processor).toContain('turnTaskOpeningIntent = task.openingIntent || undefined;');
    expect(processor).toContain('taskIntentOf(event.taskType, knownIntentKeys(turnPack), turnTaskOpeningIntent, event.intent)');
  });

  it('records the task intent as the turn\'s task_type, and the platform machine beside it', () => {
    expect(processor).toContain('{ taskType: turnTaskIntent || event.taskType }');
    expect(processor).toContain('{ taskMachine: event.taskType }');
    expect(read('lambda/src/lib/analytics-metadata.ts')).toContain('metadata.taskMachine = context.modelChoice.taskMachine;');
  });

  it('counts a task turn toward an intent experiment by the task intent', () => {
    expect(read('lambda/src/router-agent-handler.ts'))
      .toContain('countsTowardExperiment(enrolledResolution, classification.intent, !!classification.classifierModelId, activeTaskIntent)');
  });
});
