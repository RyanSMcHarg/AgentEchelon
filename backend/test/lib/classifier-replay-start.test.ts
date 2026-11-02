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
import { edgeContext } from '../helpers/edge-context';

const mockLambdaSend = jest.fn();

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = mockLambdaSend;
  },
  InvokeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

// The assistant's served pack: its active version's when it has one, else its classification's
// deployment pack (an SSM parameter), else the platform's.
const mockResolveActive = jest.fn();
jest.mock('../../lambda/src/lib/active-profile', () => ({
  resolveActiveProfile: (...args: unknown[]) => mockResolveActive(...args),
}));
const mockSsmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = mockSsmSend;
  },
  GetParameterCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));
const VERSION_PACK = { intents: [{ key: 'quarterly_close', description: 'closing the quarter', keywords: ['close'], delivery: 'PLACEHOLDER_UPDATE' }] };

process.env.CLASSIFIER_REPLAY_ARN_STANDARD = 'arn:aws:lambda:us-east-1:123456789012:function:ClassifierReplay-standard';
process.env.ALLOWED_ORIGINS = 'https://admin.example.com';
// The Identity Pool's pool is this deployment's own: the registry a function with no TRUSTED_ISSUERS reads.
process.env.USER_POOL_ID = 'us-east-1_pool';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler, forgetReplayFunctions } = require('../../lambda/src/classifier-replay-start');

const BODY = { incumbentModel: 'haiku', challengerModel: 'sonnet', classification: 'standard', windowDays: 30, limit: 50 };

function postEvent(body: unknown, over: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/classifier-replay-start',
    headers: { origin: 'https://admin.example.com' },
    body: JSON.stringify(body),
    requestContext: { authorizer: edgeContext({ claims: { sub: 'admin-sub-1', 'cognito:groups': 'admins' } }) },
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
  mockResolveActive.mockReset();
  mockResolveActive.mockResolvedValue({ intentPack: VERSION_PACK });
  mockSsmSend.mockReset();
  process.env.CLASSIFIER_REPLAY_ARN_STANDARD = 'arn:aws:lambda:us-east-1:123456789012:function:ClassifierReplay-standard';
});

describe('finding the replay function', () => {
  it('reads the classification\'s own key when no variable names it, and invokes what it finds', async () => {
    // Premium, which no variable names here: a found ARN is kept for the container, so the standard cases below
    // keep the variable they set.
    process.env.CLASSIFIER_REPLAY_PARAM_ROOT = '/agent-echelon/assistant';
    const FOUND = 'arn:aws:lambda:us-east-1:123456789012:function:AgentEchelonAssistants-premium-ClassifierReplay';
    mockSsmSend.mockImplementation(async (cmd: { input: { Name: string } }) => (
      cmd.input.Name === '/agent-echelon/assistant/premium/classifier-replay-arn' ? { Parameter: { Value: FOUND } } : { Parameter: undefined }
    ));
    const { status } = await call({ ...BODY, classification: 'premium' });
    expect(status).toBe(202);
    expect(mockSsmSend.mock.calls.map((c) => c[0].input.Name)).toContain('/agent-echelon/assistant/premium/classifier-replay-arn');
    expect(mockLambdaSend.mock.calls[0][0].input.FunctionName).toBe(FOUND);
    delete process.env.CLASSIFIER_REPLAY_PARAM_ROOT;
    forgetReplayFunctions();
  });
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
          // The console session the exchange vends, named after the person.
          userArn: 'arn:aws:sts::123456789012:assumed-role/agent-echelon-admin-console/console-real-operator',
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
    delete process.env.CLASSIFIER_REPLAY_ARN_STANDARD;
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
      requestContext: { authorizer: edgeContext({ claims: { sub: 'user-1', 'cognito:groups': 'premium' } }) },
    } as unknown as Partial<APIGatewayProxyEvent>);
    expect(status).toBe(403);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});

describe('a run goes to its own classification, with its assistant\'s pack (tenet D12)', () => {
  it("invokes the replay function of the run's classification, and names the classification and assistant", async () => {
    const { body } = await call(BODY);
    expect(mockLambdaSend.mock.calls[0][0].input.FunctionName).toBe(process.env.CLASSIFIER_REPLAY_ARN_STANDARD);
    const payload = invokePayload();
    expect(payload.open.classification).toBe('standard');
    expect(payload.open.assistant).toBeTruthy();
    expect(body.run.classification).toBe('standard');
  });

  it('refuses a run with no classification, and opens nothing', async () => {
    const { status } = await call({ ...BODY, classification: undefined });
    expect(status).toBe(400);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it("refuses a model the classification does not allow (opus is premium only)", async () => {
    const { status, body } = await call({ ...BODY, challengerModel: 'opus' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not selected by the standard classification/);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it("refuses a classification whose replay function is not deployed; there is no shared one", async () => {
    const { status } = await call({ ...BODY, classification: 'premium', challengerModel: 'opus' });
    expect(status).toBe(503);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it("carries the assistant's active version pack to the run", async () => {
    await call(BODY);
    expect(invokePayload().open.intentPack).toEqual(VERSION_PACK);
  });

  it("falls back to the classification's deployment pack when the version carries none", async () => {
    mockResolveActive.mockResolvedValueOnce({});
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(VERSION_PACK) } });
    await call(BODY);
    expect(mockSsmSend.mock.calls[0][0].input.Name).toMatch(/\/assistant\/standard\/assistant-intent-pack$/);
    expect(invokePayload().open.intentPack.intents.map((i: { key: string }) => i.key)).toContain('quarterly_close');
  });

  it('refuses when the pack cannot be read, rather than replaying against a taxonomy the assistant does not serve', async () => {
    mockResolveActive.mockRejectedValueOnce(new Error('throttled'));
    const { status } = await call(BODY);
    expect(status).toBe(503);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});
