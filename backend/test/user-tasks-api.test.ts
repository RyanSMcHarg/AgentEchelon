/**
 * GET /tasks/mine — the caller's own open work items.
 *
 * The access-control story is the whole story: the owner comes from the Cognito token and there is no
 * parameter naming whose queue to read, so one user cannot ask for another's. These tests pin that
 * there is no such input rather than merely that the happy path works, because a queue endpoint that
 * accepted a `userSub` would leak every person's outstanding obligations to any signed-in caller.
 */
const mockGetActiveTasksForUser = jest.fn();

jest.mock('../lambda/src/lib/task-tracking.js', () => ({
  getActiveTasksForUser: (...args: unknown[]) => mockGetActiveTasksForUser(...args),
}));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler, titleOf, toOpenWorkItem } from '../lambda/src/user-tasks-api';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';

function event(overrides: Partial<APIGatewayProxyEvent> = {}, sub?: string): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    headers: { origin: 'http://localhost:5173' },
    requestContext: { authorizer: sub ? { claims: { sub } } : {} },
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

const row = (over: Record<string, unknown> = {}) => ({
  userSub: 'me',
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
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
});

describe('GET /tasks/mine', () => {
  it('reads the queue for the SUB ON THE TOKEN, never a caller-supplied one', async () => {
    mockGetActiveTasksForUser.mockResolvedValue([row()]);

    // A query string that names someone else must change nothing.
    const res = await handler(
      event({ queryStringParameters: { userSub: 'someone-else' } } as Partial<APIGatewayProxyEvent>, 'me'),
    );

    expect(res.statusCode).toBe(200);
    expect(mockGetActiveTasksForUser).toHaveBeenCalledWith('me', expect.anything());
    // Mutation guard: if the handler ever read the query string, this is the assertion that fails.
    expect(mockGetActiveTasksForUser).not.toHaveBeenCalledWith('someone-else', expect.anything());
  });

  it('401s without a Cognito sub', async () => {
    const res = await handler(event({}, undefined));
    expect(res.statusCode).toBe(401);
    expect(mockGetActiveTasksForUser).not.toHaveBeenCalled();
  });

  it('rejects anything but GET', async () => {
    const res = await handler(event({ httpMethod: 'POST' }, 'me'));
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
});
