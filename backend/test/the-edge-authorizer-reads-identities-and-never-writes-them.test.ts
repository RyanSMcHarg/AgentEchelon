/**
 * THE EDGE AUTHORIZER CONSTRUCT: what it may touch, and which attachment each route takes.
 *
 * Synthesized in a stack of its own and attached, in this test only, to an HTTP API, so the construct is
 * proven apart from the two API stacks that attach it. It proves the boundary row "Edge authorizer": `Identities` is read (`GetItem`) and
 * never written, and the AppInstanceUser's existence is the only other thing it asks. It proves the
 * two attachments: the credential exchange is never answered from the authorizer cache, and every other
 * route is cached for at most `EDGE_RESULT_TTL_SECONDS`. And it proves the function is handed the
 * registry with each issuer's verification, and the route lists as data.
 */
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Template } from 'aws-cdk-lib/assertions';
import { ADMIN_SESSION_ROUTE, EXCHANGE_ROUTE, EdgeAuthorizer, type EdgePlane } from '../lib/constructs/edge-authorizer';
import { GUEST_ROUTES, ONE_CHANNEL_ROUTES } from '../lib/constructs/trusted-issuers';
import { EDGE_RESULT_TTL_SECONDS } from '../lib/config/edge-verification';

/** A direct OIDC entry is a multi-tenant Entra one: a generic `oidc` entry is refused (it federates into the pool). */
const ENTRA_TENANTS = ['11111111-2222-3333-4444-555555555555', '66666666-7777-8888-9999-000000000000'];
const ENTRA_DISCOVERY = 'https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration';

const env = { account: '111122223333', region: 'us-east-1' };
const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const ALL = ['basic', 'standard', 'premium', 'admin'];
const ISSUERS = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true },
  { id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostApp', audience: 'host-client', clearance: { oneChannel: 'basic', classifications: ['basic'] } },
  { id: 'okta', kind: 'oidc-entra', tenants: ENTRA_TENANTS, tokenVersion: 2, discoveryUrl: ENTRA_DISCOVERY, audience: 'okta-client', clearance: { fixed: ['basic'], classifications: ['basic'] } },
];

const IDENTITIES = { tableName: 'test-identities', tableArn: 'arn:aws:dynamodb:us-east-1:111122223333:table/test-identities' };

function synth(issuers: unknown[] = ISSUERS, plane: EdgePlane = 'person'): { tpl: Template; edge: EdgeAuthorizer; stack: cdk.Stack } {
  const app = new cdk.App({ context: { issuers } });
  const stack = new cdk.Stack(app, 'EdgeTest', { env });
  const edge = new EdgeAuthorizer(stack, 'Edge', {
    appInstanceArn: APP, selfClientIds: ['self-client'], selfPoolId: 'us-east-1_SelfPool', identities: IDENTITIES, plane,
  });
  const api = new apigwv2.HttpApi(stack, 'Api');
  const target = new lambda.Function(stack, 'Target', { runtime: lambda.Runtime.NODEJS_20_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler=async()=>({})') });
  for (const routeKey of [EXCHANGE_ROUTE, 'POST /create-conversation', 'GET /tasks']) {
    const [method, path] = routeKey.split(' ');
    api.addRoutes({
      path,
      methods: [method as apigwv2.HttpMethod],
      integration: new HttpLambdaIntegration(`I${routeKey.replace(/\W/g, '')}`, target),
      authorizer: edge.authorizerFor(routeKey),
    });
  }
  return { tpl: Template.fromStack(stack), edge, stack };
}

const { tpl, stack } = synth();
const resources = tpl.toJSON().Resources as Record<string, any>;
const edgeFn = Object.entries(resources).find(([, r]) => r.Type === 'AWS::Lambda::Function' && r.Properties.Environment?.Variables?.EDGE_ROUTES)!;

describe('the edge authorizer function', () => {
  it('is handed the route lists as data: the exchange, the one-conversation routes and the guest routes', () => {
    expect(JSON.parse(edgeFn[1].Properties.Environment.Variables.EDGE_ROUTES)).toEqual({
      plane: 'person',
      exchange: [EXCHANGE_ROUTE],
      oneChannel: [...ONE_CHANNEL_ROUTES],
      guest: [...GUEST_ROUTES],
      admin: [],
    });
  });

  it('on the admin plane, is handed the console session alone, and no route a person or a first sign-in reaches', () => {
    const resourcesOf = synth(ISSUERS, 'admin').tpl.toJSON().Resources as Record<string, any>;
    const fn = Object.values(resourcesOf).find((r: any) => r.Type === 'AWS::Lambda::Function' && r.Properties.Environment?.Variables?.EDGE_ROUTES) as any;
    expect(JSON.parse(fn.Properties.Environment.Variables.EDGE_ROUTES)).toEqual({
      plane: 'admin',
      exchange: [],
      oneChannel: [],
      guest: [],
      admin: [ADMIN_SESSION_ROUTE],
    });
  });

  it('is handed the registry with each issuer\'s verification', () => {
    const raw = stack.resolve(edgeFn[1].Properties.Environment.Variables.TRUSTED_ISSUERS);
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    for (const fragment of ['"verify"', '"self-client"', '"host-client"', '"okta-client"', '"RS256"', '"tenants"']) {
      expect(text).toContain(fragment);
    }
  });

  it('reads Identities and asks whether an AppInstanceUser exists, and nothing else', () => {
    const roleRef = edgeFn[1].Properties.Role['Fn::GetAtt'][0];
    const policies = Object.values(resources).filter((r: any) => r.Type === 'AWS::IAM::Policy'
      && r.Properties.Roles.some((ref: any) => ref.Ref === roleRef));
    const actions = policies.flatMap((p: any) => p.Properties.PolicyDocument.Statement.flatMap((s: any) => ([] as string[]).concat(s.Action)));
    expect([...new Set(actions)].sort()).toEqual(['chime:DescribeAppInstanceUser', 'dynamodb:GetItem']);
    for (const write of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:*']) {
      expect(actions).not.toContain(write);
    }
    const describe = policies.flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .find((s: any) => ([] as string[]).concat(s.Action).includes('chime:DescribeAppInstanceUser'));
    expect(describe.Resource).toBe(`${APP}/user/*`);
  });
});

describe('the two attachments', () => {
  const authorizers = Object.entries(resources).filter(([, r]) => r.Type === 'AWS::ApiGatewayV2::Authorizer');
  const ttlOf = (routeKey: string): number => {
    const route = Object.values(resources).find((r: any) => r.Type === 'AWS::ApiGatewayV2::Route' && r.Properties.RouteKey === routeKey) as any;
    const auth = resources[route.Properties.AuthorizerId.Ref];
    return auth.Properties.AuthorizerResultTtlInSeconds;
  };

  it('are two authorizers over the one function, answering with IAM policies', () => {
    expect(authorizers).toHaveLength(2);
    for (const [, a] of authorizers) {
      expect(a.Properties.AuthorizerType).toBe('REQUEST');
      expect(a.Properties.IdentitySource).toEqual(['$request.header.Authorization']);
      expect(a.Properties.EnableSimpleResponses).toBeFalsy();
      expect(JSON.stringify(a.Properties.AuthorizerUri)).toContain(edgeFn[0]);
    }
  });

  it('the credential exchange is never answered from the cache', () => {
    expect(ttlOf(EXCHANGE_ROUTE)).toBe(0);
  });

  it('every other route is cached for at most the TTL', () => {
    expect(EDGE_RESULT_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(ttlOf('POST /create-conversation')).toBe(EDGE_RESULT_TTL_SECONDS);
    expect(ttlOf('GET /tasks')).toBe(EDGE_RESULT_TTL_SECONDS);
  });
});

describe('synth refuses a registry the edge cannot verify', () => {
  it('a foreign pool that declares no audience', () => {
    const noAudience = ISSUERS.map((e) => (e.id === 'host' ? { ...e, audience: undefined } : e));
    expect(() => synth(noAudience)).toThrow(/issuer "host": declares no audience/);
  });
});
