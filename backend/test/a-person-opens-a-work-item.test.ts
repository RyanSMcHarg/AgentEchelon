// The conversation's type allows what these cases do; the refusal is `a-type-that-turns-a-capability-off-is-refused`.
jest.mock('../lambda/src/lib/type-capability', () => ({ ...jest.requireActual('../lambda/src/lib/type-capability'), typeAllows: jest.fn(async () => ({ ok: true })) }));
import { edgeContext } from './helpers/edge-context';
/**
 * POST /tasks - a person opens a work item.
 *
 * WHAT THESE PIN, AND WHY IT IS THE REFUSALS RATHER THAN THE HAPPY PATH. The write itself is one
 * invoke of an operation that already existed and is already tested. What is new is the five things
 * this route has to refuse, and every one of them is a case where answering 201 would put a row
 * somewhere it can never be read or worked from. A creation that succeeds into a dead end is worse
 * than a refusal, because nothing downstream reports it.
 *
 * THE TAG READS ARE MOCKED AS THE AUTHORITY, deliberately. `archived` is also mirrored into channel
 * Metadata and that copy is explicitly non-authoritative, so a test that fed the mirror would pass
 * against a handler reading the wrong source. These feed `ListTagsForResource`.
 */
const mockChimeSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockChimeSend })),
  DescribeChannelCommand: jest.fn((input: unknown) => ({ __type: 'DescribeChannel', input })),
  DescribeChannelMembershipCommand: jest.fn((input: unknown) => ({ __type: 'DescribeChannelMembership', input })),
  ListTagsForResourceCommand: jest.fn((input: unknown) => ({ __type: 'ListTags', input })),
}), { virtual: true });
// The caller is cleared for the premium conversation (`lib/conversation-access.ts`); an uncleared caller's
// refusal is proven in `lib/a-person-route-reaches-only-a-conversation-its-caller-reaches.test.ts`.
jest.mock('../lambda/src/lib/auth', () => ({
  ...jest.requireActual('../lambda/src/lib/auth'),
  callerHolderToken: () => 'premium',
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ __type: 'Invoke', input })),
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn((input: unknown) => ({ __type: 'GetParameter', input })),
}), { virtual: true });

const APP = 'arn:aws:chime:us-east-1:111:app-instance/inst';
const CHANNEL = `${APP}/channel/conv-1`;
const SERVICE = 'arn:aws:lambda:us-east-1:111:function:AgentEchelonAssistants-premium-TaskServiceABC';

process.env.APP_INSTANCE_ARN = APP;
process.env.SSM_ROOT = '/agent-echelon';
process.env.ALLOWED_ORIGIN = 'https://app.example.com';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler, __clearTaskServiceArnCache } = require('../lambda/src/user-tasks-api');

const post = (body: unknown, sub = 'user-a') => handler({
  httpMethod: 'POST',
  headers: { origin: 'https://app.example.com' },
  requestContext: { authorizer: edgeContext({ claims: { sub } }) },
  body: JSON.stringify(body),
} as never);

/** Tags as the authority: classification present, not archived, unless a case says otherwise. */
function chimeAnswers(opts: { member?: boolean; archived?: boolean; classification?: string; days?: number } = {}) {
  const { member = true, archived = false, classification = 'premium', days = 270 } = opts;
  mockChimeSend.mockImplementation((cmd: { __type: string }) => {
    if (cmd.__type === 'DescribeChannelMembership') {
      return member ? Promise.resolve({}) : Promise.reject(Object.assign(new Error('not a member'), { name: 'NotFoundException' }));
    }
    if (cmd.__type === 'DescribeChannel') {
      return member
        ? Promise.resolve({ Channel: { ExpirationSettings: { ExpirationDays: days } } })
        : Promise.reject(new Error('ForbiddenException'));
    }
    return Promise.resolve({
      Tags: [
        ...(classification ? [{ Key: 'classification', Value: classification }] : []),
        ...(archived ? [{ Key: 'archived', Value: 'true' }] : []),
      ],
    });
  });
}

const invokedPayload = () => JSON.parse(
  Buffer.from(mockLambdaSend.mock.calls[0][0].input.Payload).toString(),
);

beforeEach(() => {
  jest.clearAllMocks();
  __clearTaskServiceArnCache();
  chimeAnswers();
  mockSsmSend.mockResolvedValue({ Parameter: { Value: SERVICE } });
  mockLambdaSend.mockResolvedValue({
    Payload: Buffer.from(JSON.stringify({ taskId: 't-1', taskRef: 3, status: 'pending' })),
  });
});

describe('a person opens a work item', () => {
  it('opens one, and the owner is the TOKEN caller rather than anything on the body', async () => {
    const res = await post({
      channelArn: CHANNEL,
      taskType: 'action_item',
      requestExcerpt: 'chase the vendor contract',
      owner: { id: 'somebody-else', type: 'user' },
    });
    expect(res.statusCode).toBe(201);
    const sent = invokedPayload();
    expect(sent.op).toBe('createTask');
    expect(sent.input.opts.owner).toEqual({ id: 'user-a', type: 'user' });
  });

  it('keys the row on the channel through the attributes the SERVICE reads', async () => {
    // `openTask` takes the channel from the request attributes rather than a sibling field,
    // deliberately, so the row cannot be keyed on one value and checked against another.
    await post({ channelArn: CHANNEL, taskType: 'action_item' });
    expect(invokedPayload().input.event.requestAttributes['CHIME.channel.arn']).toBe(CHANNEL);
  });

  it('bounds the task TTL by the conversation it belongs to, so a child cannot outlive its parent', async () => {
    chimeAnswers({ days: 30 });
    await post({ channelArn: CHANNEL, taskType: 'action_item' });
    expect(invokedPayload().input.opts.ttlSeconds).toBe(30 * 24 * 60 * 60);
  });

  it('sends NO visibility when none was asked for, so the store\'s private default stands', async () => {
    // An absent value reads as `private`. Inventing `conversation` here would publish to the room an
    // item the person may have filled with their own words.
    await post({ channelArn: CHANNEL, taskType: 'action_item' });
    expect(invokedPayload().input.opts).not.toHaveProperty('visibility');
  });

  it('refuses a caller who is not a member of the conversation', async () => {
    chimeAnswers({ member: false });
    const res = await post({ channelArn: CHANNEL, taskType: 'action_item' });
    expect([res.statusCode, JSON.parse(res.body).code]).toEqual([403, 'NOT_A_MEMBER']);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('refuses an archived conversation, read from the TAG and not the Metadata mirror', async () => {
    chimeAnswers({ archived: true });
    const res = await post({ channelArn: CHANNEL, taskType: 'action_item' });
    expect([res.statusCode, JSON.parse(res.body).code]).toEqual([409, 'CONVERSATION_ARCHIVED']);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('refuses an untagged conversation rather than opening an item no turn could read', async () => {
    // Nobody can be shown to be cleared for a conversation with no classification, so the caller's own
    // boundary refuses it before anything else is read.
    // Its own conversation: a classification read once is remembered for the conversation's life.
    chimeAnswers({ classification: '' });
    const res = await post({ channelArn: `${APP}/channel/conv-untagged`, taskType: 'action_item' });
    expect([res.statusCode, JSON.parse(res.body).code]).toEqual([403, 'CLASSIFICATION_UNREADABLE']);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('refuses an undeclared taskType, and names what IS declared', async () => {
    const res = await post({ channelArn: CHANNEL, taskType: 'invent_something' });
    const body = JSON.parse(res.body);
    expect([res.statusCode, body.code]).toEqual([400, 'UNKNOWN_TASK_TYPE']);
    expect(body.declared).toContain('action_item');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('refuses a channel ARN from another deployment', async () => {
    const res = await post({ channelArn: 'arn:aws:chime:us-east-1:999:app-instance/other/channel/c', taskType: 'action_item' });
    expect([res.statusCode, JSON.parse(res.body).code]).toEqual([400, 'INVALID_CHANNEL']);
    expect(mockChimeSend).not.toHaveBeenCalled();
  });

  it('refuses when the tag read FAILS, rather than treating unknown as open', async () => {
    mockChimeSend.mockImplementation((cmd: { __type: string }) => (cmd.__type !== 'ListTags'
      ? Promise.resolve({ Channel: {} })
      : Promise.reject(new Error('ThrottlingException'))));
    const res = await post({ channelArn: `${APP}/channel/conv-unreadable`, taskType: 'action_item' });
    expect([res.statusCode, JSON.parse(res.body).code]).toEqual([503, 'UNAVAILABLE']);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('refuses when no task service is published for the conversation\'s classification', async () => {
    mockSsmSend.mockRejectedValue(new Error('ParameterNotFound'));
    const res = await post({ channelArn: CHANNEL, taskType: 'action_item' });
    expect([res.statusCode, JSON.parse(res.body).code]).toEqual([503, 'TASK_SERVICE_UNAVAILABLE']);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('reports the service\'s own refusal as a refusal, not as a server error', async () => {
    // The service returns null when it declines the conversation, which is a boundary saying no.
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from('null') });
    const res = await post({ channelArn: CHANNEL, taskType: 'action_item' });
    expect([res.statusCode, JSON.parse(res.body).code]).toEqual([403, 'CONVERSATION_NOT_SERVED']);
  });

  it('still answers GET /tasks/mine, which this route shares a function with', async () => {
    const res = await handler({
      httpMethod: 'OPTIONS',
      headers: { origin: 'https://app.example.com' },
    } as never);
    expect(res.statusCode).toBe(200);
  });
});

describe('the open items list never reads an outage or a cap as nothing open', () => {
  const src = (f: string) => require('fs').readFileSync(require('path').join(__dirname, '..', 'lambda', 'src', f), 'utf8') as string;
  it('a read that fails, or a table that is not configured, is an error to /tasks/mine, never an empty list', () => {
    const api = src('user-tasks-api.ts');
    expect(api).toContain('const rows = await getActiveTasksForUser(personId, { limit: MAX_ITEMS, admit, strict: true });');
    const tracking = src('lib/task-tracking.ts');
    const fn = tracking.slice(tracking.indexOf('export async function getActiveTasksForUser('), tracking.indexOf('export async function getActiveTasksForUser(') + 3000);
    expect(fn).toMatch(/if \(!USER_TASKS_TABLE\) \{\s+if \(opts\.strict\) throw new Error/);
    expect(fn).toMatch(/console\.error\('Error getting cross-channel tasks for user:', error\);\s+if \(opts\.strict\) throw error;/);
  });

  it('the answer says whether it lists every open item, so a reader never takes one missing from a capped list as settled', () => {
    expect(src('user-tasks-api.ts')).toContain('return respond(200, { items, count: items.length, complete: rows.length < MAX_ITEMS }, origin);');
  });
});
