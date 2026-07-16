/**
 * user-feedback rollup: count only the LATEST vote per (user, message).
 * The store appends every vote (change/clear) for the audit trail; a 'clear' or a
 * superseded up/down must not be counted.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  ScanCommand: jest.fn((input) => ({ __scan: input })),
  PutCommand: jest.fn((input) => ({ __put: input })),
  DeleteCommand: jest.fn((input) => ({ __del: input })),
}));

process.env.FEEDBACK_TABLE = 'test-feedback';
import { handler } from '../lambda/src/user-feedback';

const ev = (): any => ({
  httpMethod: 'GET',
  queryStringParameters: { days: '30' },
  headers: {},
  requestContext: { authorizer: { claims: { sub: 'admin1', 'cognito:groups': 'admins' } } },
});

describe('user-feedback rollup — latest vote wins', () => {
  beforeEach(() => jest.clearAllMocks());

  it('counts the latest vote per (user,message); clear un-counts; superseded ignored', async () => {
    const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    mockSend.mockResolvedValueOnce({
      Items: [
        // user u1 / message m1: up → down → clear (latest = clear → NOT counted)
        { userSub: 'u1', messageId: 'm1', feedback: 'up', modelId: 'haiku', intent: 'general', createdAt: t(30) },
        { userSub: 'u1', messageId: 'm1', feedback: 'down', modelId: 'haiku', intent: 'general', createdAt: t(20) },
        { userSub: 'u1', messageId: 'm1', feedback: 'clear', modelId: 'haiku', intent: 'general', createdAt: t(10) },
        // user u2 / message m2: down → up (latest = up → counts as ONE up)
        { userSub: 'u2', messageId: 'm2', feedback: 'down', modelId: 'haiku', intent: 'general', createdAt: t(15) },
        { userSub: 'u2', messageId: 'm2', feedback: 'up', modelId: 'haiku', intent: 'general', createdAt: t(5) },
        // user u3 / message m3: single down (counts as ONE down)
        { userSub: 'u3', messageId: 'm3', feedback: 'down', modelId: 'sonnet', intent: 'code', createdAt: t(8) },
      ],
    });

    const res = await handler(ev());
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);

    const haiku = data.find((r: any) => r.model_name === 'haiku' && r.intent === 'general');
    expect(haiku).toMatchObject({ thumbs_up: 1, thumbs_down: 0, feedback_count: 1 }); // only m2's latest (up); m1 cleared
    const sonnet = data.find((r: any) => r.model_name === 'sonnet');
    expect(sonnet).toMatchObject({ thumbs_up: 0, thumbs_down: 1, feedback_count: 1 });
  });
});
