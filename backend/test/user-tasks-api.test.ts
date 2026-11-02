/**
 * GET /tasks/mine — the caller's own open work items.
 *
 * The access-control story is the whole story: the owner is the person the edge authorizer resolved the token to and there is no
 * parameter naming whose queue to read, so one user cannot ask for another's. These tests pin that
 * there is no such input rather than merely that the happy path works, because a queue endpoint that
 * accepted a `personId` would leak every person's outstanding obligations to any signed-in caller.
 */
const mockGetActiveTasksForUser = jest.fn();

const mockSsmSend = jest.fn();

jest.mock('../lambda/src/lib/task-tracking.js', () => ({
  getActiveTasksForUser: (...args: unknown[]) => mockGetActiveTasksForUser(...args),
  principalIdFromArn: (arn: string | undefined) => arn?.split('/').pop() || '',
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = (...a: unknown[]) => mockSsmSend(...a); },
  GetParameterCommand: class { constructor(public input: { Name: string }) {} },
}));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler, titleOf, toOpenWorkItem, _resetMachinesCache } from '../lambda/src/user-tasks-api';
import { asPerson, edgeContext } from './helpers/edge-context';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';

function event(overrides: Partial<APIGatewayProxyEvent> = {}, sub?: string): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    headers: { origin: 'http://localhost:5173' },
    requestContext: { authorizer: sub ? edgeContext({ claims: { sub } }) : {} },
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

const row = (over: Record<string, unknown> = {}) => ({
  personId: 'me',
  taskId: 't1',
  taskType: 'report_generation',
  channelArn: CHANNEL,
  status: 'in_progress',
  updatedAt: '2026-08-13T10:00:00.000Z',
  details: {},
  ...over,
});

beforeEach(() => {
  mockGetActiveTasksForUser.mockReset();
  _resetMachinesCache();
  mockSsmSend.mockReset().mockRejectedValue(Object.assign(new Error('none'), { name: 'ParameterNotFound' }));
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
});

describe('GET /tasks/mine', () => {
  it('reads the queue for the SUB ON THE TOKEN, never a caller-supplied one', async () => {
    mockGetActiveTasksForUser.mockResolvedValue([row()]);

    // A query string that names someone else must change nothing.
    const res = await handler(
      event({ queryStringParameters: { personId: 'someone-else' } } as Partial<APIGatewayProxyEvent>, 'me'),
    );

    expect(res.statusCode).toBe(200);
    expect(mockGetActiveTasksForUser).toHaveBeenCalledWith('me', expect.anything());
    // Mutation guard: if the handler ever read the query string, this is the assertion that fails.
    expect(mockGetActiveTasksForUser).not.toHaveBeenCalledWith('someone-else', expect.anything());
  });

  it('reads the queue of the PERSON the token resolves to, not the token sub', async () => {
    // The exchange mints a person id that is not the sub; the queue is keyed on the person.
    const PERSON = '0190f5c2-7b3a-7c11-9d2e-5a6b7c8d9e0f';
    mockGetActiveTasksForUser.mockResolvedValue([]);
    const res = await handler(asPerson(event({}, 'token-sub'), PERSON));
    expect(res.statusCode).toBe(200);
    expect(mockGetActiveTasksForUser).toHaveBeenCalledWith(PERSON, expect.anything());
    expect(mockGetActiveTasksForUser).not.toHaveBeenCalledWith('token-sub', expect.anything());
  });

  it('401s without a Cognito sub', async () => {
    const res = await handler(event({}, undefined));
    expect(res.statusCode).toBe(401);
    expect(mockGetActiveTasksForUser).not.toHaveBeenCalled();
  });

  // POST is a route of its own (open a work item, POST /tasks); the gateway sends no POST to /tasks/mine.
  // So what this function refuses is every OTHER method.
  it.each(['PUT', 'DELETE', 'PATCH'])('rejects %s', async (method) => {
    const res = await handler(event({ httpMethod: method }, 'me'));
    expect(res.statusCode).toBe(405);
  });

  it('500s rather than reporting an empty queue when the read fails', async () => {
    mockGetActiveTasksForUser.mockRejectedValue(new Error('throttled'));

    const res = await handler(event({}, 'me'));

    // "You owe nothing" is a worse lie than an error: the user acts on it by doing nothing.
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).items).toBeUndefined();
  });

  it('returns an empty list when the user genuinely owes nothing', async () => {
    mockGetActiveTasksForUser.mockResolvedValue([]);
    const res = await handler(event({}, 'me'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [], count: 0 });
  });
});

describe('titleOf', () => {
  it('prefers what the assistant recorded', () => {
    expect(titleOf(row({ details: { title: 'Q3 revenue report' } }) as never)).toBe('Q3 revenue report');
    expect(titleOf(row({ details: { summary: 'Pick the columns' } }) as never)).toBe('Pick the columns');
  });

  it('never returns empty — an unnamed item cannot be acted on', () => {
    expect(titleOf(row({ details: {} }) as never)).toBe('Report generation');
    expect(titleOf(row({ details: { title: '   ' }, taskType: 'data_extraction' }) as never))
      .toBe('Data extraction');
  });
});

describe('toOpenWorkItem', () => {
  it('carries where the item lives, so the queue can take the user there', () => {
    const item = toOpenWorkItem(row({ details: { title: 'Scope the report' } }) as never);
    expect(item.channelArn).toBe(CHANNEL);
    expect(item.title).toBe('Scope the report');
  });

  it('sends the visibility as read: a row with none is private, a shared row stays shared', () => {
    // The server applies the one rule, so the composer never decides what a
    // missing value means.
    expect(toOpenWorkItem(row() as never).visibility).toBe('private');
    expect(toOpenWorkItem(row({ visibility: 'private' }) as never).visibility).toBe('private');
    expect(toOpenWorkItem(row({ visibility: 'conversation' }) as never).visibility).toBe('conversation');
  });
});

/**
 * WHAT A STEP NEEDS IS THE DEPLOYMENT'S DECLARATION, read per assistant.
 *
 * `needsOf` read the machines of a pack this function never hydrated, so a pack-declared state fell
 * back to the platform defaults: no `awaits`, no `requires`, and the item said nothing about what the
 * person owed. Each classification declares its own pack, so the row is read against the pack of the
 * assistant whose work it is.
 */
describe('needs are read from the owning assistant\'s declared pack', () => {
  const PREMIUM_BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/bot-premium';
  const pack = JSON.stringify({
    extends: 'default',
    intents: [{ key: 'vendor_onboarding', description: 'Onboard a vendor', keywords: ['vendor'], delivery: 'TASK_MULTI_STEP' }],
    machines: {
      vendor_onboarding: {
        initial: 'collecting_documents',
        states: {
          collecting_documents: {
            transitions: ['done'], awaits: { party: 'requester' }, requires: ['the W-9', 'a signed contract'],
          },
          done: { transitions: [], terminal: 'success' },
        },
      },
    },
  });
  const notFound = () => Object.assign(new Error('none'), { name: 'ParameterNotFound' });

  it('renders a pack-declared requirement for the assistant that declared it, and not for another', async () => {
    mockSsmSend.mockImplementation(async (cmd: { input: { Name: string } }) => {
      if (cmd.input.Name.endsWith('/premium/bot-arn')) return { Parameter: { Value: PREMIUM_BOT } };
      if (cmd.input.Name.endsWith('/premium/assistant-intent-pack')) return { Parameter: { Value: pack } };
      throw notFound();
    });
    const pending = { taskType: 'vendor_onboarding', taskState: 'collecting_documents' };
    mockGetActiveTasksForUser.mockResolvedValue([
      row({ taskId: 'mine', assistantId: 'bot-premium', ...pending }),
      row({ taskId: 'other', assistantId: 'bot-basic', ...pending }),
    ]);

    const res = await handler(event({}, 'me'));
    const items = JSON.parse(res.body).items as Array<{ taskId: string; needs?: string[] }>;

    expect(items.find((i) => i.taskId === 'mine')?.needs).toEqual(['the W-9', 'a signed contract']);
    // Positive control: the same state under an assistant with no such pack is not given its needs.
    expect(items.find((i) => i.taskId === 'other')?.needs).toBeUndefined();
  });

  it('does not cache a throttled read as "no pack declared"', async () => {
    mockSsmSend.mockRejectedValue(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    mockGetActiveTasksForUser.mockResolvedValue([]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await handler(event({}, 'me'));
    const callsAfterFirst = mockSsmSend.mock.calls.length;

    await handler(event({}, 'me'));

    expect(mockSsmSend.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    warn.mockRestore();
  });
});
