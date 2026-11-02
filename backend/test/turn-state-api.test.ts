import { asPerson, edgeContext } from './helpers/edge-context';
/**
 * THE CLIENT READS WHAT IS WAITING - AND ONLY WHAT IT MAY SEE (ADR-033).
 *
 * The endpoint exists because ordering is not a reliable encoding of set membership: a client that
 * reloaded with partial history, joined the conversation late, or scrolled a window that does not
 * reach the deferral all reconstruct the wrong answer. So the record is read directly.
 *
 * ── THE TWO DISCLOSURES IT MUST NOT MAKE ────────────────────────────────────────────────────────
 *
 * ASKING ABOUT A ROOM YOU ARE NOT IN. The queued ids of a conversation are a fact about who is
 * talking to whom. A Cognito token proves who the caller is, not that they belong here, so
 * membership is checked with the service that owns it and checked BEFORE the record is touched.
 *
 * SEEING A TARGETED MESSAGE QUEUED. A waiting affordance on a message a member cannot open is the
 * same disclosure the private-task rule prevents, arriving through the UI instead of the task list.
 * The filter is performed AS THE CALLER, so the service answers it rather than this code re-deriving
 * who may see what.
 */

const mockChime = jest.fn();
const mockRead = jest.fn();
const mockDispatchFailure = jest.fn().mockResolvedValue(undefined);

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = (...a: unknown[]) => mockChime(...a); },
  DescribeChannelCommand: class { __t = 'Describe'; constructor(public input: any) {} },
  GetChannelMessageCommand: class { __t = 'GetMessage'; constructor(public input: any) {} },
}));
// SPREAD, NOT ENUMERATE. A mock that LISTS a first-party module's exports is a snapshot
// of it: adding one export to `turn-lock` made this file fail at import, in tests that have nothing to
// say about the new function. Worse than a failed assertion, because it reports one error instead of N
// and hides whatever was already broken underneath. Only the reads this file drives are overridden.
jest.mock('../lambda/src/lib/turn-lock.js', () => ({
  ...jest.requireActual('../lambda/src/lib/turn-lock.js'),
  readTurnState: (...a: unknown[]) => mockRead(...a),
  // No dispatch failure unless a test says otherwise; the real one would reach DynamoDB.
  readDispatchFailure: (...a: unknown[]) => mockDispatchFailure(...a),
}));

const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
process.env.APP_INSTANCE_ARN = APP;
process.env.ALLOWED_ORIGIN = 'https://app.example';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require('../lambda/src/turn-state-api');

const CHANNEL = `${APP}/channel/c1`;

const req = (over: Record<string, unknown> = {}) => ({
  httpMethod: 'GET',
  headers: { origin: 'https://app.example' },
  queryStringParameters: { channelArn: CHANNEL, responderId: 'bot1' },
  requestContext: { authorizer: edgeContext({ claims: { sub: 'alice' } }) },
  ...over,
});

const body = (res: { body: string }) => JSON.parse(res.body);

beforeEach(() => {
  mockChime.mockReset();
  mockRead.mockReset();
  mockDispatchFailure.mockReset();
  mockRead.mockResolvedValue({ busy: true, queued: ['m1', 'm2'], noticeId: 'n1' });
  mockChime.mockResolvedValue({});
  // No failure by default, so "did this endpoint ask?" is a real question in every test below.
  mockDispatchFailure.mockResolvedValue(undefined);
});

describe('who may ask', () => {
  it('refuses a request with no identity', async () => {
    const res = await api.handler(req({ requestContext: { authorizer: edgeContext({ claims: {} }) } }));
    expect(res.statusCode).toBe(401);
  });

  it('refuses a caller who is not a member, WITHOUT reading the record', async () => {
    // The order is the point. A 403 that had already read the queue would have loaded a
    // non-member's conversation state into this process to decide not to send it.
    mockChime.mockRejectedValue(new Error('Forbidden'));
    const res = await api.handler(req());
    expect(res.statusCode).toBe(403);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('refuses a channel from another deployment', async () => {
    // Without this the caller names any ARN they like and the membership check runs against somebody
    // else's app instance.
    const res = await api.handler(req({
      queryStringParameters: { channelArn: 'arn:aws:chime:us-east-1:9:app-instance/x/channel/c9', responderId: 'b' },
    }));
    expect(res.statusCode).toBe(400);
    expect(mockChime).not.toHaveBeenCalled();
  });

  it('requires the responder, rather than defaulting to a key that never exists', async () => {
    // Busy is a property of a RESPONDER. A default would read a missing key, return an empty state,
    // and the client would confidently clear its waiting styling - a lie rather than a gap.
    const res = await api.handler(req({ queryStringParameters: { channelArn: CHANNEL } }));
    expect(res.statusCode).toBe(400);
    expect(body(res).error).toContain('responderId');
  });
});

describe('what comes back', () => {
  it('the waiting ids and whether the responder is busy', async () => {
    const res = await api.handler(req());
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ busy: true, queued: ['m1', 'm2'], noticeId: 'n1' });
  });

  it('omits a queued message this caller cannot read', async () => {
    // A targeted message they are not on. Filtered by ASKING the service as the caller, so the
    // answer is the service's rather than this code's reconstruction of it.
    mockChime.mockImplementation((cmd: any) => (
      cmd.__t === 'GetMessage' && cmd.input.MessageId === 'm2'
        ? Promise.reject(new Error('Forbidden'))
        : Promise.resolve({})
    ));
    expect(body(await api.handler(req())).queued).toEqual(['m1']);
  });

  it('still reports BUSY when every queued message is hidden', async () => {
    // The case worth naming rather than hiding: a member can see the assistant is busy without
    // seeing what it is busy WITH. That is what targeting means.
    mockChime.mockImplementation((cmd: any) => (
      cmd.__t === 'GetMessage' ? Promise.reject(new Error('Forbidden')) : Promise.resolve({})
    ));
    const out = body(await api.handler(req()));
    expect(out.busy).toBe(true);
    expect(out.queued).toEqual([]);
  });

  it('reads the caller as the bearer, never the assistant', async () => {
    await api.handler(req());
    const bearers = mockChime.mock.calls.map(([c]: any[]) => c.input.ChimeBearer);
    expect(bearers.every((b: string) => b === `${APP}/user/alice`)).toBe(true);
  });

  it('reads as the PERSON the token resolves to, never the token sub', async () => {
    const PERSON = '0190f5c2-7b3a-7c11-9d2e-5a6b7c8d9e0f';
    await api.handler(asPerson(req(), PERSON));
    const bearers = mockChime.mock.calls.map(([c]: any[]) => c.input.ChimeBearer);
    expect(bearers.length).toBeGreaterThan(0);
    expect(bearers.every((b: string) => b === `${APP}/user/${PERSON}`)).toBe(true);
  });

  it('carries no message CONTENT', async () => {
    // The queue has never held content, and this read holds the same line: the client already has the
    // messages it can see, and what it lacks is which of them are waiting.
    const res = await api.handler(req());
    expect(res.body).not.toMatch(/content|Content/);
  });
});

describe('when the record cannot be read', () => {
  it('errors rather than reporting an empty queue', async () => {
    // "Nothing is waiting" is a CLAIM. A client that believed it would clear the styling on messages
    // that are still queued, so the error lets it keep what it has.
    mockRead.mockRejectedValue(new Error('throttled'));
    const res = await api.handler(req());
    expect(res.statusCode).toBe(500);
    expect(body(res)).not.toHaveProperty('queued');
  });
});

describe('the method surface', () => {
  it('answers preflight and refuses anything but GET', async () => {
    expect((await api.handler(req({ httpMethod: 'OPTIONS' }))).statusCode).toBe(200);
    expect((await api.handler(req({ httpMethod: 'POST' }))).statusCode).toBe(405);
  });
});

/**
 * A TURN THAT NEVER RAN IS STATE THIS CALLER READS, NOT A MESSAGE THE ASSISTANT POSTED.
 *
 * The channel flow used to post these as the assistant. That put an INFRASTRUCTURE failure in the
 * transcript under the assistant's name, showed it to the whole room rather than to the person whose
 * message went unanswered, and was one of the last reasons the flow needs to bear a bot identity.
 */
describe('why this caller\'s turn never ran', () => {
  it('reports the reason CODE and never prose, so the client can render it in the reader\'s language', async () => {
    mockDispatchFailure.mockResolvedValue({ reason: 'assistant_unreachable', failedAt: new Date().toISOString() });
    const out = body(await api.handler(req()));
    expect(out.dispatchFailed).toBe('assistant_unreachable');
    // The contract of this view: ids and flags. A sentence here could not carry the reader's language.
    expect(JSON.stringify(out)).not.toMatch(/administrator|try again|could not/i);
  });

  it('omits the field entirely when nothing failed, rather than reporting a falsy one', async () => {
    mockDispatchFailure.mockResolvedValue(undefined);
    expect(body(await api.handler(req()))).not.toHaveProperty('dispatchFailed');
  });

  it('asks for THIS caller, so one person\'s failure is not shown to the room', async () => {
    mockDispatchFailure.mockResolvedValue(undefined);
    await api.handler(req());
    expect(mockDispatchFailure).toHaveBeenCalledWith(
      expect.objectContaining({ senderSub: 'alice', responderId: 'bot1', channelArn: CHANNEL }),
    );
  });

  it('is read only AFTER membership, so a non-member learns nothing - not even that a dispatch failed', async () => {
    mockChime.mockRejectedValue(new Error('Forbidden'));
    const res = await api.handler(req());
    expect(res.statusCode).toBe(403);
    expect(mockDispatchFailure).not.toHaveBeenCalled();
  });
});
