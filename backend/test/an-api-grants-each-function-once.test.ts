/**
 * AN HTTP API GRANTS EACH FUNCTION IT SERVES ONCE, NOT ONCE PER ROUTE (`lib/constructs/http-api.ts`).
 *
 * A Lambda function's resource policy is capped at 20 KB. One API Gateway statement per route puts that cap within reach
 * of a function serving many routes, and a deploy that renumbers the integrations creates the new statements before it
 * deletes the old ones, so it fails at about half the routes. One statement per function, scoped to the API, holds for any
 * number of routes.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import { RouteTableApi, type RouteSpec } from '../lib/constructs/http-api';

describe('an HTTP API grants each function it serves once', () => {
  it('two functions behind five routes hold two API Gateway permissions, each for the whole API', () => {
    const stack = new cdk.Stack(new cdk.App(), 'Api', { env: { account: '111111111111', region: 'us-east-1' } });
    const fn = (id: string) => new lambda.Function(stack, id, { runtime: lambda.Runtime.NODEJS_20_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler=async()=>({})') });
    const a = fn('A');
    const b = fn('B');
    const route = (method: RouteSpec['method'], path: string, handler: lambda.IFunction): RouteSpec => ({ api: 'admin', method, path, handler, capability: 'admin', auth: 'iam' });
    new RouteTableApi(stack, 'Api', {
      apiName: 'api', description: 'api', allowedOrigins: ['https://example.com'],
      routes: [route('GET', '/a', a), route('POST', '/a', a), route('GET', '/a/{id}', a), route('GET', '/b', b), route('POST', '/b', b)],
    });
    const permissions = Object.values(Template.fromStack(stack).findResources('AWS::Lambda::Permission'))
      .map((r) => (r as { Properties: { Principal: string; SourceArn: unknown } }).Properties)
      .filter((p) => p.Principal === 'apigateway.amazonaws.com');
    expect(permissions).toHaveLength(2);
    for (const p of permissions) expect(JSON.stringify(p.SourceArn)).toMatch(/\/\*\/\*\/\*"/);
  });
});
