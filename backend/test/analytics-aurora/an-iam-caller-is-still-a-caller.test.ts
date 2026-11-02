/**
 * ON AN IAM-AUTHORIZED ROUTE THERE ARE NO JWT CLAIMS, AND THE ADMIN IS STILL A NAMED PERSON.
 *
 * The analytics API is AWS_IAM authorized in every deployment: the admin console SigV4-signs with its
 * console session and a Bearer JWT is rejected outright. So
 * `requestContext.authorizer.claims` is empty on every real request, and `callerSub` - which read
 * only those claims - was the empty string.
 *
 * NOTHING FAILED ON THE WAY IN, which is why this survived. A service-mode admin legitimately has no
 * JWT sub, so the 401 gate lets the request through. The cost landed on the two paths that ATTRIBUTE
 * rather than authorize:
 *
 *   - `classifier_replay_adjudicate` refuses outright: "an adjudication must be attributable to a
 *     caller". The classification shadow gate cannot be adjudicated at all.
 *   - the MODERATION AUDIT records its actor as blank. That one is worse, because it succeeds: a
 *     redaction is performed and written with nobody's name against it.
 *
 * `callerPersonId`, the one resolver, recovers the person from the console session's role-session name,
 * or resolves the request identity's Cognito authentication provider (the shape these tests send). It is a different ROUTE to the same fact, not a weaker one - and it is
 * emphatically not a body-supplied value, which is what the last test here pins.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

const mockAdjudicate = jest.fn().mockResolvedValue({ updated: true });
jest.mock('../../lambda/src/analytics-aurora/classifier-replay', () => ({
  listReplayRuns: jest.fn().mockResolvedValue([]),
  listReplayLabels: jest.fn().mockResolvedValue([]),
  getReplayRun: jest.fn().mockResolvedValue(null),
  adjudicateReplayLabel: (...a: unknown[]) => mockAdjudicate(...a),
}));

import { handler } from '../../lambda/src/analytics-aurora/analytics-query';
import { edgeContext } from '../helpers/edge-context';

// The pool is this deployment's own: the trusted-issuer registry a function with no TRUSTED_ISSUERS reads.
process.env.USER_POOL_ID = 'us-east-1_pool';

const SUB = '7f1c2a44-0000-4000-8000-abcdefabcdef';

/** A SigV4 request as API Gateway presents it under AWS_IAM: no authorizer, an identity instead. */
function iamEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/ground-truth', // an adjudication is a label-ground-truth write, on its own resource
    body: JSON.stringify(body),
    requestContext: {
      // No `authorizer` at all - this is the shape the defect was invisible in.
      identity: {
        // `iamPrincipal` reads userArn/caller/accountId - this is what makes the call
        // recognisably IAM-signed, and therefore admin under enforcement.
        // The admin console's session, which the exchange names after the person.
        userArn: `arn:aws:sts::123456789012:assumed-role/agent-echelon-admin-console/console-${SUB}`,
      },
    },
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ADMIN_IAM_ENFORCEMENT = 'true';
  mockDbQuery.mockResolvedValue({ rows: [] });
});

describe('an adjudication by an IAM-authenticated admin is attributable', () => {
  it('does not refuse a SigV4 caller for being anonymous', async () => {
    const res = await handler(iamEvent({
      queryType: 'classifier_replay_adjudicate',
      labelId: 'lbl-1',
      trueLabel: 'report_generation',
    }));
    // The defect returned 401 with "must be attributable to a caller" on every enforced request.
    expect(res.statusCode).not.toBe(401);
    expect(res.body).not.toMatch(/attributable to a caller/i);
  });

  it('writes the IAM caller as the adjudicator, not a blank', async () => {
    await handler(iamEvent({
      queryType: 'classifier_replay_adjudicate',
      labelId: 'lbl-1',
      trueLabel: 'report_generation',
    }));
    expect(mockAdjudicate).toHaveBeenCalledWith(expect.objectContaining({ adjudicatedBy: SUB }));
  });
});

describe('the caller is server-verified, whichever route names them', () => {
  it('a body-supplied callerSub cannot attribute the write to someone else', async () => {
    // The security property this fix must not weaken. `buildParamsFromBody` omits `callerSub` from
    // its allowlist precisely so a caller cannot sign as themselves and write under another name;
    // recovering the sub from the IAM identity has to leave that intact.
    await handler(iamEvent({
      queryType: 'classifier_replay_adjudicate',
      labelId: 'lbl-1',
      trueLabel: 'report_generation',
      callerSub: 'somebody-else',
    }));
    expect(mockAdjudicate).toHaveBeenCalledWith(expect.objectContaining({ adjudicatedBy: SUB }));
    expect(mockAdjudicate).not.toHaveBeenCalledWith(expect.objectContaining({ adjudicatedBy: 'somebody-else' }));
  });

  it('a Cognito-authorized call resolves through its token, so the unenforced path still names its caller', async () => {
    // One resolver for both shapes: with no signed identity, the token's subject resolves to the person.
    // No deployed analytics route carries a Cognito authorizer (every one is AWS_IAM), so this is
    // handler-level only.
    const jwtEvent = {
      httpMethod: 'POST',
      path: '/ground-truth',
      body: JSON.stringify({ queryType: 'classifier_replay_adjudicate', labelId: 'lbl-1', status: 'agreed' }),
      requestContext: {
        authorizer: edgeContext({ claims: { sub: 'jwt-sub', iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool', 'cognito:groups': 'admins' } }),
      },
    } as unknown as APIGatewayProxyEvent;
    await handler(jwtEvent);
    expect(mockAdjudicate).toHaveBeenCalledWith(expect.objectContaining({ adjudicatedBy: 'jwt-sub' }));
  });
});
