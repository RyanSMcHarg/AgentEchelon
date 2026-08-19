/**
 * The non-VPC starter for a classifier replay (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §5.2).
 *
 * This function exists because the in-VPC analytics handler CANNOT invoke the replay Lambda: the
 * isolated subnets have no route to the Lambda control plane, so the call hung until the function
 * timed out and the batch job was never invoked once. The previous version passed 14 unit tests on a
 * mocked Lambda client, which is precisely why the tests here are about the shape of the contract
 * across the network boundary — what is returned, what is invoked, and what is NOT left behind on a
 * failure — rather than about the invoke "succeeding".
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockLambdaSend = jest.fn();

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = mockLambdaSend;
  },
  InvokeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

process.env.CLASSIFIER_REPLAY_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:ClassifierReplay';
process.env.ALLOWED_ORIGINS = 'https://admin.example.com';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../lambda/src/classifier-replay-start');

const BODY = { incumbentModel: 'haiku', challengerModel: 'sonnet', windowDays: 30, limit: 50 };

function postEvent(body: unknown, over: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/classifier-replay-start',
    headers: { origin: 'https://admin.example.com' },
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub: 'admin-sub-1', 'cognito:groups': 'admins' } } },
    ...over,
  } as unknown as APIGatewayProxyEvent;
}

const call = async (body: unknown, over?: Partial<APIGatewayProxyEvent>) => {
  const res = await handler(postEvent(body, over) as any);
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

const invokePayload = () => JSON.parse(Buffer.from(mockLambdaSend.mock.calls[0][0].input.Payload).toString());

beforeEach(() => {
  jest.clearAllMocks();
  mockLambdaSend.mockReset();
  mockLambdaSend.mockResolvedValue({});
  process.env.CLASSIFIER_REPLAY_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:ClassifierReplay';
});

describe('starting a replay from outside the VPC', () => {
  it('mints the run id, returns it, and asks the batch Lambda to open the row under that same id', async () => {
    // The whole point of the split: the id is the ONLY thing the operator's click can be given
    // synchronously, because the row it names can only be written from inside the VPC.
    const { status, body } = await call(BODY);

    expect(status).toBe(202);
    expect(body.started).toBe(true);
    expect(body.run.runId).toMatch(/^[0-9a-f-]{36}$/);

    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    const input = mockLambdaSend.mock.calls[0][0].input;
    expect(input.InvocationType).toBe('Event');
    const payload = invokePayload();
    expect(payload.runId).toBe(body.run.runId);
    expect(payload.open.incumbentModel).toBe('haiku');
    expect(payload.open.challengerModel).toBe('sonnet');
  });

  it('does not claim a window in the reply', async () => {
    // The authoritative window is the row the batch Lambda writes; a window echoed from here would be
    // derived from a different `now` and could disagree with what was actually replayed. The window
    // IS part of the result (§5.2), so an approximate one is worse than none.
    const { body } = await call(BODY);
    expect(body.run.windowStart).toBeUndefined();
    expect(body.run.windowEnd).toBeUndefined();
  });

  it('attributes the run to the VERIFIED caller, never the body', async () => {
    await call({ ...BODY, startedBy: 'someone-else' });
    expect(invokePayload().open.startedBy).toBe('admin-sub-1');
  });

  it('prefers the signed IAM caller when the deployment enforces IAM', async () => {
    // Under A14 there are no Cognito authorizer claims; the operator's sub rides the signed
    // principal. Falling back to the synthesized 'iam-principal' would attribute every replay on the
    // deployment to the same non-person.
    process.env.ADMIN_IAM_ENFORCEMENT = 'true';
    await call(BODY, {
      requestContext: {
        identity: {
          userArn: 'arn:aws:sts::123456789012:assumed-role/AdminSignOn/operator',
          cognitoAuthenticationProvider:
            'cognito-idp.us-east-1.amazonaws.com/us-east-1_pool:CognitoSignIn:real-operator',
        },
      },
    } as unknown as Partial<APIGatewayProxyEvent>);
    expect(invokePayload().open.startedBy).toBe('real-operator');
    delete process.env.ADMIN_IAM_ENFORCEMENT;
  });

  it('refuses a model against itself, and a missing model, WITHOUT invoking anything', async () => {
    // Rejected synchronously because an Event invocation cannot report a rejection back: a request
    // that can never be valid must be refused while the caller is still listening, or the console
    // polls an id whose row is never written.
    expect((await call({ ...BODY, challengerModel: 'haiku' })).status).toBe(400);
    expect((await call({ ...BODY, challengerModel: '' })).status).toBe(400);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('refuses when no batch function is configured, and opens nothing', async () => {
    // Nothing is opened, deliberately: a run row with no function to execute it is the "ships inert
    // but reports success" failure the gate exists to make impossible.
    delete process.env.CLASSIFIER_REPLAY_ARN;
    const { status } = await call(BODY);
    expect(status).toBe(503);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('reports an invoke failure and leaves NOTHING behind', async () => {
    // The old shape had to close a half-open run here. This one has no row to strand, because the row
    // is only ever written by the function that also does the work.
    mockLambdaSend.mockRejectedValueOnce(new Error('throttled'));
    const { status } = await call(BODY);
    expect(status).toBe(502);
  });

  it('denies a caller who is not an admin', async () => {
    const { status } = await call(BODY, {
      requestContext: { authorizer: { claims: { sub: 'user-1', 'cognito:groups': 'premium' } } },
    } as unknown as Partial<APIGatewayProxyEvent>);
    expect(status).toBe(403);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});
