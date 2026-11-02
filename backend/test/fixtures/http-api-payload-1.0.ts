/**
 * PAYLOAD FORMAT 1.0 EVENTS, AS AN HTTP API HANDS THEM TO A LAMBDA.
 *
 * Every route on `PersonApi` and `AdminApi` sends payload format 1.0 (`lib/constructs/http-api.ts`), the
 * `APIGatewayProxyEvent` shape every handler reads. Two shapes reach a handler:
 *
 *  - a route behind the edge authorizer, whose policy answer's context arrives as the authorizer's fields
 *    (`requestContext.authorizer`), beside the `principalId` and `integrationLatency` the gateway adds;
 *  - an IAM-signed route, which carries no authorizer context and names the signing principal in
 *    `requestContext.identity`.
 *
 * The edge's context values are strings, so the claims travel as JSON, under `tokenClaims`: an HTTP API
 * reserves the context key `claims` and replaces it. These fixtures follow the shape AWS documents for
 * payload format 1.0 (resource, path, httpMethod, headers, multiValueHeaders, queryStringParameters,
 * pathParameters, requestContext with identity and authorizer, body).
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const API_ID = 'a1b2c3d4e5';
const ACCOUNT = '111122223333';

function base(method: string, resource: string, path: string, requestContext: Record<string, unknown>): APIGatewayProxyEvent {
  return {
    version: '1.0',
    resource,
    path,
    httpMethod: method,
    headers: { 'content-type': 'application/json', host: `${API_ID}.execute-api.us-east-1.amazonaws.com`, origin: 'http://localhost:5173' },
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    body: '{}',
    isBase64Encoded: false,
    requestContext: {
      accountId: ACCOUNT,
      apiId: API_ID,
      domainName: `${API_ID}.execute-api.us-east-1.amazonaws.com`,
      domainPrefix: API_ID,
      extendedRequestId: 'Xx0Yy1Zz2=',
      httpMethod: method,
      path,
      protocol: 'HTTP/1.1',
      requestId: 'Xx0Yy1Zz2=',
      requestTime: '18/Oct/2026:20:35:04 +0000',
      requestTimeEpoch: 1792355704000,
      resourceId: `${method} ${resource}`,
      resourcePath: resource,
      stage: '$default',
      ...requestContext,
    },
  } as unknown as APIGatewayProxyEvent;
}

/** The identity block of a request no IAM principal signed. */
const unsignedIdentity = {
  accessKey: null, accountId: null, caller: null, cognitoAuthenticationProvider: null, cognitoAuthenticationType: null,
  cognitoIdentityId: null, cognitoIdentityPoolId: null, principalOrgId: null, sourceIp: '203.0.113.7', user: null,
  userAgent: 'Mozilla/5.0', userArn: null,
};

export interface EdgeAnswer {
  issuerId: string;
  subject: string;
  personId?: string;
  personArn?: string;
  claims: Record<string, unknown>;
}

/** A person route behind the edge authorizer: its context as the authorizer's fields. */
export function edgeEvent(method: string, resource: string, answer: EdgeAnswer, opts: { nested?: boolean } = {}): APIGatewayProxyEvent {
  const context: Record<string, string> = {
    issuerId: answer.issuerId,
    subject: answer.subject,
    tokenClaims: JSON.stringify(answer.claims),
    ...(answer.personId ? { personId: answer.personId } : {}),
    ...(answer.personArn ? { personArn: answer.personArn } : {}),
  };
  const principalId = answer.personId ?? 'unbound';
  return base(method, resource, resource, {
    identity: unsignedIdentity,
    authorizer: opts.nested
      ? { principalId, integrationLatency: 41, lambda: context }
      : { principalId, integrationLatency: 41, ...context },
  });
}

/** An IAM-signed route: no authorizer context, the signing principal in the identity block. */
export function iamEvent(method: string, resource: string, userArn: string): APIGatewayProxyEvent {
  return base(method, resource, resource, {
    identity: { ...unsignedIdentity, accessKey: 'ASIAEXAMPLE', accountId: ACCOUNT, caller: 'AROAEXAMPLE:console', user: 'AROAEXAMPLE:console', userArn },
  });
}
