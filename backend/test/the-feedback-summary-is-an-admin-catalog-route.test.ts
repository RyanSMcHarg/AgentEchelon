/**
 * THE FEEDBACK SUMMARY IS AN ORDINARY ADMIN CATALOG ROUTE (SPEC-ADMIN-CONSOLE FR43).
 *
 * `GET /feedback` is the thumbs-up/down summary the console's Models tab shows. It sat outside the
 * catalog on a Cognito authorizer while the console signs every admin call with its console session, so
 * the console's request was the odd one out: refused outright under `adminAuthMode=service`, and the
 * tab caught the refusal and rendered an empty table, which reads as "nobody has voted".
 *
 * It is the admin backend's: the handler in AdminServices over the Conversations stack's table, the route
 * on `AdminApi`. The person's `POST /feedback` is on `PersonApi`, which carries nothing an administrator
 * calls.
 *
 * Pinned here from both sides of the seam:
 *  - the stacks: GET is AWS_IAM on AdminApi, the admin console role is granted it and the team console
 *    role is not, the function behind it is told IAM is enforced, and the preflight admits the SigV4
 *    headers;
 *  - the handler: an admin console session is answered, and it refuses on its own (tenet D3) a team
 *    console session, an Identity-Pool principal and a request with no signed principal, so a gateway
 *    grant that admits one of them still reads nothing.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  ScanCommand: jest.fn((input) => ({ __scan: input })),
  PutCommand: jest.fn((input) => ({ __put: input })),
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: jest.fn() })),
  DescribeChannelMembershipCommand: jest.fn(),
}));

import { Template } from 'aws-cdk-lib/assertions';
import { ADMIN_CONSOLE_ROLE_NAME } from '../lib/constructs/admin-role-grants';

process.env.FEEDBACK_TABLE = 'test-feedback';
import { handler } from '../lambda/src/user-feedback';
import { adminApiTemplate, adminServicesTemplate, conversationsStacks } from './helpers/synth';
import { edgeContext } from './helpers/edge-context';


type Resource = { Type?: string; Properties?: Record<string, any> };

/** The route `GET /feedback` on AdminApi. */
function adminFeedbackRoute(): Resource {
  const routes = Object.values(adminApiTemplate().findResources('AWS::ApiGatewayV2::Route') as Record<string, Resource>)
    .filter((r) => r.Properties?.RouteKey === 'GET /feedback');
  expect(routes).toHaveLength(1);
  return routes[0];
}

/** The `execute-api:Invoke` resources AdminApi grants the console role with this name, as JSON text to search. */
function invokeGrantsTo(roleName: string): string[] {
  const out: string[] = [];
  const [roleId] = Object.entries(adminServicesTemplate().findResources('AWS::IAM::Role') as Record<string, Resource>)
    .find(([, r]) => r.Properties?.RoleName === roleName) ?? [];
  expect(roleId).toBeDefined();
  // The role is AdminServices'; AdminApi attaches its grants to it by reference, through the export.
  for (const p of Object.values(adminApiTemplate().findResources('AWS::IAM::ManagedPolicy') as Record<string, Resource>)) {
    if (!JSON.stringify(p.Properties?.Roles ?? []).includes(roleId!)) continue;
    for (const s of p.Properties?.PolicyDocument?.Statement ?? []) {
      const actions = [].concat(s.Action);
      if (actions.includes('execute-api:Invoke' as never)) out.push(JSON.stringify(s.Resource));
    }
  }
  return out;
}

describe('GET /feedback on AdminApi', () => {
  it('is AWS_IAM, while the person POST is a person route on PersonApi', () => {
    expect(adminFeedbackRoute().Properties?.AuthorizationType).toBe('AWS_IAM');
    expect(adminFeedbackRoute().Properties?.AuthorizerId).toBeUndefined();
    // The core declares the person's POST for PersonApi, and no GET at all.
    const core = conversationsStacks().conversations.routes.filter((r) => r.path === '/feedback');
    expect(core.map((r) => [r.api, r.method, r.auth ?? 'person'])).toEqual([['person', 'POST', 'person']]);
  });

  it('grants the admin console role execute-api on it, by name', () => {
    const grants = invokeGrantsTo(ADMIN_CONSOLE_ROLE_NAME.admins);
    expect(grants.some((g) => g.includes('/GET/feedback'))).toBe(true);
  });

  it('grants the team console role nothing on it, because the summary counts every assistant', () => {
    const grants = invokeGrantsTo(ADMIN_CONSOLE_ROLE_NAME['team-members']);
    expect(grants.filter((g) => g.includes('feedback'))).toEqual([]);
  });

  it('tells the function behind it that IAM is enforced, or the handler refuses every signed call', () => {
    const target = JSON.stringify(adminFeedbackRoute().Properties?.Target);
    const integrationId = /"Ref":"([A-Za-z0-9]+)"/.exec(target)![1];
    const handlerName = (adminApiTemplate().findResources('AWS::ApiGatewayV2::Integration')[integrationId].Properties as Record<string, any>).Description;
    expect(handlerName).toBe('FeedbackSummaryFunction');
    const fns = Object.entries(adminServicesTemplate().findResources('AWS::Lambda::Function') as Record<string, Resource>)
      .filter(([id]) => new RegExp(`^${handlerName}[0-9A-F]{8}$`).test(id));
    expect(fns).toHaveLength(1);
    expect(fns[0][1].Properties?.Environment?.Variables?.ADMIN_IAM_ENFORCEMENT).toBe('true');
  });

  it('admits the SigV4 signing headers on the preflight, or the browser blocks the signed GET', () => {
    const api = Object.values(adminApiTemplate().findResources('AWS::ApiGatewayV2::Api') as Record<string, Resource>)[0];
    for (const h of ['X-Amz-Date', 'X-Amz-Security-Token', 'X-Amz-Content-Sha256']) {
      expect(api.Properties?.CorsConfiguration?.AllowHeaders).toContain(h);
    }
  });
});

describe('the summary handler', () => {
  const SUB = '11111111-2222-3333-4444-555555555555';
  const get = (identity: Record<string, unknown>, claims?: Record<string, unknown>): any => ({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: { days: '30' },
    requestContext: { identity, ...(claims ? { authorizer: edgeContext({ claims }) } : {}) },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({
      Items: [{ userSub: 'u1', messageId: 'm1', modelId: 'model-a', intent: 'general', feedback: 'up', createdAt: new Date().toISOString() }],
    });
    process.env.ADMIN_IAM_ENFORCEMENT = 'true';
  });
  afterAll(() => { delete process.env.ADMIN_IAM_ENFORCEMENT; });

  it('answers the admin console session the gateway admitted', async () => {
    const res = await handler(get({ userArn: `arn:aws:sts::123456789012:assumed-role/agent-echelon-admin-console/console-${SUB}` }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual([
      expect.objectContaining({ model_name: 'model-a', intent: 'general', thumbs_up: 1, feedback_count: 1 }),
    ]);
  });

  it('refuses a team console session, because the summary counts every assistant and has no team route', async () => {
    const res = await handler(get({ userArn: `arn:aws:sts::123456789012:assumed-role/agent-echelon-team-console/console-${SUB}` }));
    expect(res.statusCode).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a team console session that carries a clearance in its session name', async () => {
    const res = await handler(get({ userArn: `arn:aws:sts::123456789012:assumed-role/agent-echelon-team-console/console-${SUB}@premium` }));
    expect(res.statusCode).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses an Identity-Pool principal, which is signed but is not an admin console session', async () => {
    const res = await handler(get({
      userArn: 'arn:aws:sts::123456789012:assumed-role/agent-echelon-admins-identity-role/CognitoIdentityCredentials',
      cognitoAuthenticationProvider: `cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool,cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool:CognitoSignIn:${SUB}`,
    }));
    expect(res.statusCode).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  describe('under adminAuthMode=service', () => {
    beforeEach(() => { process.env.ADMIN_AUTH_MODE = 'service'; });
    afterEach(() => { delete process.env.ADMIN_AUTH_MODE; });

    it("answers the deployer's trusted proxy, a signed principal that names no person", async () => {
      const res = await handler(get({ userArn: 'arn:aws:sts::123456789012:assumed-role/host-admin-proxy/session-1' }));
      expect(res.statusCode).toBe(200);
    });

    it('still refuses a team console session', async () => {
      const res = await handler(get({ userArn: `arn:aws:sts::123456789012:assumed-role/agent-echelon-team-console/console-${SUB}` }));
      expect(res.statusCode).toBe(403);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  it('refuses a request that carries no signed principal and no admin claim', async () => {
    const res = await handler(get({}, { sub: 'u1', 'cognito:groups': 'premium' }));
    expect(res.statusCode).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a signed call on a function that was not told IAM is enforced', async () => {
    delete process.env.ADMIN_IAM_ENFORCEMENT;
    const res = await handler(get({ userArn: `arn:aws:sts::123456789012:assumed-role/agent-echelon-admin-console/console-${SUB}` }));
    expect(res.statusCode).toBe(403);
  });
});
