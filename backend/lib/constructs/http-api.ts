/**
 * THE HTTP APIS, AND THE ROUTE TABLE THEY ARE BUILT FROM.
 *
 * A deployment serves two APIs (D11): `PersonApi`, every route a person calls, behind the edge authorizer,
 * and `AdminApi`, every admin route, behind IAM. Neither holds a handler. No vendor calls either: a
 * connector's vendor events arrive through the vendor's EventBridge partner event source (K5), and an
 * HTTP API for a vendor with no EventBridge integration (`IngressApi`) is **NOT BUILT**. Each stack that
 * owns a handler says which routes reach it, as data (`RouteSpec`), and an API stack aggregates the routes of the stacks
 * it is built on. So a capability that is not declared has no stack, and so no route; adding a route is
 * one entry beside its handler; and a route cannot be served by the wrong API or the wrong authorizer,
 * because the API decides that from the entry, never the stack.
 *
 * ── PAYLOAD FORMAT 1.0 ───────────────────────────────────────────────────────────────────────────
 *
 * Every integration sends payload format 1.0, the `APIGatewayProxyEvent` shape every handler was written
 * against: `httpMethod`, `path`, `resource` (the route path), `pathParameters`, `requestContext.identity`
 * for an IAM-signed caller and `requestContext.authorizer` for the edge authorizer's context. Who called
 * is read in one place (`callerPersonId`, `lambda/src/lib/auth.ts`).
 *
 * ── ONE INVOKE PERMISSION PER FUNCTION PER API ───────────────────────────────────────────────────
 *
 * The handler is in its own stack and the API in this one, so the integration is bound to a handle that
 * grants nothing, and one permission naming the API is added here for each function. The authorizer on
 * each route is what decides who reaches which route, so one permission per function is the same reach
 * as one per route with a fraction of the resources.
 *
 * ── CORS ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Configured on the API, so the gateway answers every preflight and adds the configured headers to the
 * responses it returns, echoing the one allowed origin a request names. A handler's own CORS headers are
 * not what a browser sees on these APIs. Whether a refusal the gateway answers itself (an authorizer's
 * 401 or 403) carries them is checked against the deployed APIs, not assumed here.
 */
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { EdgeAuthorizer } from './edge-authorizer';

/** Which API a route is served on. */
export type RouteApi = 'person' | 'admin';

/**
 * How a route is authorized.
 *  - `person`: the edge authorizer (cached, or uncached for the exchange and every single-use route).
 *  - `iam`: SigV4, refused at the gateway for a principal without `execute-api:Invoke` on the route.
 *  - `none`: no authorizer. A route that names nobody and reads nothing private (the paused-deployment
 *    probe), and the unauthenticated routes that carry their own abuse controls.
 */
export type RouteAuth = 'person' | 'iam' | 'none';

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The most requests per second a route serves, and the burst. Shared by every caller of the route. */
export interface RouteThrottle {
  rate: number;
  burst: number;
}

/** One route, declared by the stack that owns its handler. */
export interface RouteSpec {
  api: RouteApi;
  method: RouteMethod;
  /** From the API root, with a leading slash: `/admin/conversations/{channelId}/messages`. */
  path: string;
  handler: lambda.IFunction;
  /** The capability that brings the route: `core` for the required core, else the capability's name. */
  capability: string;
  /** Default: `person` on PersonApi, `iam` on AdminApi. */
  auth?: RouteAuth;
  throttle?: RouteThrottle;
}

/** A stack that owns handlers a route reaches. */
export interface RouteSource {
  readonly routes: readonly RouteSpec[];
}

/** `METHOD /path`, the key a route is named by on the gateway and in the edge authorizer's route lists. */
export const routeKeyOf = (r: Pick<RouteSpec, 'method' | 'path'>): string => `${r.method} ${r.path}`;

/** Whether a stack declares routes. */
export function isRouteSource(stack: unknown): stack is RouteSource {
  return Array.isArray((stack as Partial<RouteSource> | undefined)?.routes);
}

/** The routes every given stack declares for one API, in declaration order. */
export function routesFor(api: RouteApi, stacks: readonly unknown[]): RouteSpec[] {
  return stacks.filter(isRouteSource).flatMap((s) => s.routes.filter((r) => r.api === api));
}

/** The default auth of a route on its API. */
export const authOf = (r: RouteSpec): RouteAuth => r.auth ?? (r.api === 'admin' ? 'iam' : 'person');

export interface HttpApiProps {
  /** The API's name, as the console and the route reference show it. */
  apiName: string;
  description: string;
  routes: readonly RouteSpec[];
  /** The origins a browser may call from. Empty: no browser calls the API, and it answers no preflight. */
  allowedOrigins: readonly string[];
  /**
   * The stage-wide limit every route without its own shares. Absent, such a route has the account's own
   * limit: the person credential exchange, since a shared throttle there would throttle sign-in for everyone.
   */
  defaultThrottle?: RouteThrottle;
  /** The edge authorizer, for a `person` route. Required when any route is `person`. */
  edge?: EdgeAuthorizer;
}

/**
 * One HTTP API with a `$default` stage that deploys its routes on every change, an access log, the
 * route table's throttles and the API's CORS.
 */
export class RouteTableApi extends Construct {
  readonly api: apigwv2.HttpApi;
  readonly stage: apigwv2.HttpStage;
  /** The invoke URL, with no trailing slash. */
  readonly url: string;

  constructor(scope: Construct, id: string, props: HttpApiProps) {
    super(scope, id);
    const seen = new Set<string>();
    for (const r of props.routes) {
      const key = routeKeyOf(r);
      if (seen.has(key)) throw new Error(`${props.apiName}: the route ${key} is declared twice; a route is served by one handler`);
      if (!r.path.startsWith('/')) throw new Error(`${props.apiName}: the route ${key} is not a path from the API root`);
      seen.add(key);
    }
    if (props.routes.some((r) => authOf(r) === 'person') && !props.edge) {
      throw new Error(`${props.apiName}: a person route needs the edge authorizer`);
    }

    this.api = new apigwv2.HttpApi(this, 'Api', {
      apiName: props.apiName,
      description: props.description,
      createDefaultStage: false,
      ...(props.allowedOrigins.length ? {
        corsPreflight: {
          allowOrigins: [...new Set(props.allowedOrigins)],
          allowMethods: [...new Set(props.routes.map((r) => r.method as string)), 'OPTIONS']
            .map((m) => m as apigwv2.CorsHttpMethod),
          // The consoles SigV4-sign the admin routes, so the preflight allows the signing headers.
          allowHeaders: ['Authorization', 'Content-Type', 'X-Amz-Date', 'X-Amz-Security-Token', 'X-Amz-Content-Sha256'],
          maxAge: cdk.Duration.minutes(10),
        },
      } : {}),
    });

    const logGroup = new logs.LogGroup(this, 'AccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.stage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: this.api,
      stageName: '$default',
      autoDeploy: true,
      ...(props.defaultThrottle ? { throttle: { rateLimit: props.defaultThrottle.rate, burstLimit: props.defaultThrottle.burst } } : {}),
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(logGroup),
        format: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
      },
    });
    // A route's own throttle, keyed by its route key on the stage. `RouteSettings` is a map CloudFormation
    // reads as written, so its keys are the template's own names rather than CDK's camel case.
    const routeSettings: Record<string, { ThrottlingRateLimit: number; ThrottlingBurstLimit: number }> = {};
    for (const r of props.routes) {
      if (r.throttle) routeSettings[routeKeyOf(r)] = { ThrottlingRateLimit: r.throttle.rate, ThrottlingBurstLimit: r.throttle.burst };
    }
    if (Object.keys(routeSettings).length) {
      (this.stage.node.defaultChild as apigwv2.CfnStage).routeSettings = routeSettings;
    }
    this.url = this.api.apiEndpoint;

    const iam = new HttpIamAuthorizer();
    const none = new apigwv2.HttpNoneAuthorizer();
    const integrations = new Map<lambda.IFunction, HttpLambdaIntegration>();
    for (const r of props.routes) {
      let integration = integrations.get(r.handler);
      const first = !integration;
      const n = integrations.size;
      if (!integration) {
        // A handle that grants nothing: the one permission for this function is added below.
        const handle = lambda.Function.fromFunctionAttributes(this, `Handler${n}`, {
          functionArn: r.handler.functionArn,
          sameEnvironment: true,
          skipPermissions: true,
        });
        integration = new HttpLambdaIntegration(`Integration${n}`, handle, {
          payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_1_0,
        });
        integrations.set(r.handler, integration);
        new lambda.CfnPermission(this, `Invoke${n}`, {
          action: 'lambda:InvokeFunction',
          functionName: r.handler.functionArn,
          principal: 'apigateway.amazonaws.com',
          sourceArn: this.api.arnForExecuteApi(),
        });
      }
      const auth = authOf(r);
      const key = routeKeyOf(r);
      const route = new apigwv2.HttpRoute(this, routeConstructId(key), {
        httpApi: this.api,
        routeKey: apigwv2.HttpRouteKey.with(r.path, r.method as apigwv2.HttpMethod),
        integration,
        authorizer: auth === 'iam' ? iam : auth === 'none' ? none : props.edge!.authorizerFor(key),
      });
      // THE STAGE NAMES A THROTTLED ROUTE BY ITS KEY, which CloudFormation does not read as a reference: without
      // this the stage can be created before the route, and a fresh deploy fails with "Unable to find Route".
      if (r.throttle) this.stage.node.addDependency(route);
      if (first) {
        // The integration is created under the first route bound to it. It names the handler's construct, so
        // the route reference and an operator reading the API find the function behind each route.
        const created = route.node.tryFindChild(`Integration${n}`) as apigwv2.HttpIntegration | undefined;
        const cfn = created?.node.defaultChild as apigwv2.CfnIntegration | undefined;
        if (cfn) cfn.description = r.handler.node.id;
      }
    }
  }

  /** The `execute-api` ARN of one route (a `*` for each path parameter), on any stage, for an IAM grant. */
  arnFor(method: string, path: string): string {
    return this.api.arnForExecuteApi(method, path.replace(/\{[^}]+\}/g, '*'));
  }
}

/** A construct id for a route key: `POST /a/{id}` -> `Route-POST-a-_id_`. One key, one id. */
export function routeConstructId(key: string): string {
  return `Route-${key.replace(' ', '').replace(/\//g, '-').replace(/[{}]/g, '_')}`;
}
