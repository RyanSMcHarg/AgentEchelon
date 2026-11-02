/**
 * THE EDGE AUTHORIZER, AS THE STACKS WIRE IT: one Lambda, two attachments, one per HTTP API.
 *
 * The function (`lambda/src/edge-authorizer.ts`) checks a token against the trusted-issuer registry,
 * resolves its subject through `Identities`, and answers with an IAM policy naming the routes the token
 * may call. It is attached to an HTTP API route through one of two authorizers over the same function:
 *
 *  - `cached`: the gateway reuses an answer for the same token for `EDGE_RESULT_TTL_SECONDS`. Every
 *    ordinary person-facing route. The TTL bounds how long a removed issuer or a deleted row keeps
 *    resolving.
 *  - `uncached`: every request is decided afresh. The credential exchange, and every route that consumes
 *    a single-use value (`UNCACHED_ROUTES`), so no single-use check is ever answered from a cache.
 *
 * `authorizerFor(routeKey)` picks between them, so a route cannot be given the wrong one by hand.
 *
 * ── TWO PLANES ───────────────────────────────────────────────────────────────────────────────────
 *
 * Each HTTP API has its own edge authorizer, because an authorizer belongs to one API.
 *
 *  - `person` (`PersonApi`): a person reaches every route; a one-conversation person `ONE_CHANNEL_ROUTES`;
 *    a guest `GUEST_ROUTES`; a first sign-in the exchange alone.
 *  - `admin` (`AdminApi`): the one route there a token reaches, the console session, and only for an
 *    issuer that declares `admin: true`. Every other admin route is IAM. The admin exchange refuses again
 *    on the registry entry the token resolves to (tenet D3: two layers).
 *
 * ── WHAT IT MAY TOUCH ────────────────────────────────────────────────────────────────────────────
 *
 * `dynamodb:GetItem` on `Identities` (the subject's row, and the revocation marker on a miss),
 * `chime:DescribeAppInstanceUser` on this instance's users (existence, on a cache miss),
 * `kms:GetPublicKey` on the guest issuer's signing keys when one is declared, and, when the registry
 * declares a `host-assertion` issuer, `dynamodb:PutItem` on `Tokens` under `assertion-jti#*` and no other
 * kind (`grantTokenKinds`), to record each assertion's `jti` once. Nothing that writes `Identities`.
 * Outbound HTTPS to each issuer's published keys.
 *
 * ── WHAT THE ROUTES ARE ──────────────────────────────────────────────────────────────────────────
 *
 * The route lists the function admits a caller to without full reach travel as data (`EDGE_ROUTES`).
 * Changing one is a change here, and never a branch in the function.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { Construct } from 'constructs';
import * as path from 'path';
import { EDGE_RESULT_TTL_SECONDS, edgeIssuers } from '../config/edge-verification';
import { GUEST_ROUTES, ONE_CHANNEL_ROUTES, issuersOf } from './trusted-issuers';
import { INSTANCE_NAME } from '../stacks/agent-classification-common';
import { grantTokenKinds } from './token-store';
import { boundRole, functionLogsBoundary, permissionsBoundary } from './permissions-boundary';

/** The credential exchange route, the one route a subject with no person yet is admitted to. */
export const EXCHANGE_ROUTE = 'POST /exchange-credentials';

/** The admin console session, on `AdminApi`: the one admin route a token reaches. */
export const ADMIN_SESSION_ROUTE = 'POST /exchange-credentials';

/** Path B's claim redemption, which consumes a single-use `claim` token (`guest-upgrade.ts`). */
export const CLAIM_ROUTE = 'POST /upgrade/claim';

/** The routes never answered from the authorizer cache: the exchange, and each single-use redemption. */
export const UNCACHED_ROUTES: readonly string[] = [EXCHANGE_ROUTE, CLAIM_ROUTE];

/** Where the token is read from. The gateway refuses a request without it (401) before invoking anything. */
const IDENTITY_SOURCE = ['$request.header.Authorization'];

export type EdgePlane = 'person' | 'admin';

/** The route lists one plane's function is handed, as `METHOD /path`. */
export function edgeRoutesFor(plane: EdgePlane): { plane: EdgePlane; exchange: string[]; oneChannel: string[]; guest: string[]; admin: string[] } {
  return plane === 'admin'
    ? { plane, exchange: [], oneChannel: [], guest: [], admin: [ADMIN_SESSION_ROUTE] }
    : { plane, exchange: [EXCHANGE_ROUTE], oneChannel: [...ONE_CHANNEL_ROUTES], guest: [...GUEST_ROUTES], admin: [] };
}

export interface EdgeAuthorizerProps {
  /** The app instance whose users are the people the edge resolves to. */
  readonly appInstanceArn: string;
  /**
   * The app client ids of this deployment's own pool: the audience its tokens must carry. Required when
   * the registry trusts that pool and its entry declares no `audience` of its own.
   */
  readonly selfClientIds: string[];
  /** This deployment's own pool, or `''` when the registry declares none (L15). */
  readonly selfPoolId: string;
  /** `Identities` (Identity): read, never written. */
  readonly identities: { tableName: string; tableArn: string };
  /** Which API this authorizer answers for. Default `person`. */
  readonly plane?: EdgePlane;
  /**
   * The guest issuer's signing keys, KMS key ARN by `kid` (Identity), when the registry declares a guest
   * issuer. The edge reads each one's public key and verifies guest tokens against them.
   */
  readonly guestSigningKeys?: Record<string, string>;
  /**
   * `Tokens` (Conversations), when the registry declares a `host-assertion` issuer: the edge records each
   * assertion's `jti` there, once. Required then on the person plane; never used on the admin plane.
   */
  readonly tokens?: dynamodb.ITable;
}

export class EdgeAuthorizer extends Construct {
  readonly fn: lambdaNodeJs.NodejsFunction;
  /** The function role's permissions boundary. */
  readonly boundary: iam.ManagedPolicy;
  /** For every ordinary person-facing route. */
  readonly cached: HttpLambdaAuthorizer;
  /** For the exchange and every single-use route. */
  readonly uncached: HttpLambdaAuthorizer;

  constructor(scope: Construct, id: string, props: EdgeAuthorizerProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    // Refused at synth, naming each issuer the edge could not verify (an issuer with no audience first).
    const issuers = edgeIssuers(issuersOf(this), props.selfPoolId, stack.region, props.selfClientIds, {
      deploymentId: INSTANCE_NAME,
      guestKeys: props.guestSigningKeys,
      omitGuest: (props.plane ?? 'person') === 'admin',
    });

    this.fn = new lambdaNodeJs.NodejsFunction(this, 'Fn', {
      entry: path.join(__dirname, '../../lambda/src/edge-authorizer.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // A cold path fetches each issuer's keys once; a warm one does no I/O but the `Identities` read.
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        TRUSTED_ISSUERS: stack.toJsonString(issuers),
        EDGE_ROUTES: JSON.stringify(edgeRoutesFor(props.plane ?? 'person')),
        IDENTITIES_TABLE: props.identities.tableName,
        APP_INSTANCE_ARN: props.appInstanceArn,
      },
      bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
    });
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [props.identities.tableArn],
    }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['chime:DescribeAppInstanceUser'],
      resources: [`${props.appInstanceArn}/user/*`],
    }));
    // THE GUEST ISSUER'S PUBLIC KEYS, read and never used to sign: this function holds no kms:Sign.
    const guestKeyArns = Object.values(props.guestSigningKeys ?? {});
    if (guestKeyArns.length) {
      this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:GetPublicKey'], resources: guestKeyArns }));
    }
    // A HOST ASSERTION'S `jti`, recorded once, on its own kind's keys and no other (A8, A9).
    const recordsJti = (props.plane ?? 'person') === 'person' && issuersOf(this).hostAssertions().length > 0;
    if (recordsJti) {
      if (!props.tokens) throw new Error('EdgeAuthorizer: a host-assertion issuer is declared, and the edge was given no Tokens table to record its jti in');
      grantTokenKinds(props.tokens, this.fn.role!, ['assertion-jti'], ['dynamodb:PutItem']);
      this.fn.addEnvironment('TOKENS_TABLE', props.tokens.tableName);
    }

    // ── THE BOUNDARY (STACKS.md "Permissions boundaries") ────────────────────────────────────────────
    //
    // Reads of `Identities`, a person's existence, the guest keys' public halves, and an assertion's `jti`
    // under its own kind's keys: whatever is attached to this role later, it never writes `Identities`,
    // never writes another kind of token, never signs, and reaches no other service.
    this.boundary = permissionsBoundary(this, 'Boundary', `The boundary of the ${props.plane ?? 'person'} edge authorizer: it reads Identities and never writes them`, [
      functionLogsBoundary(),
      new iam.PolicyStatement({
        sid: 'BoundaryReadIdentities',
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [props.identities.tableArn, `${props.identities.tableArn}/index/*`],
      }),
      new iam.PolicyStatement({
        sid: 'BoundaryAPersonsExistence',
        actions: ['chime:DescribeAppInstanceUser'],
        resources: [`${props.appInstanceArn}/user/*`],
      }),
      ...(guestKeyArns.length ? [new iam.PolicyStatement({ sid: 'BoundaryGuestPublicKeys', actions: ['kms:GetPublicKey'], resources: guestKeyArns })] : []),
      ...(recordsJti ? [new iam.PolicyStatement({
        sid: 'BoundaryAnAssertionsJtiOnly',
        actions: ['dynamodb:PutItem'],
        resources: [props.tokens!.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['assertion-jti#*'] } },
      })] : []),
    ]);
    boundRole(this.fn.role, this.boundary);

    // IAM-policy responses, so a cached answer is evaluated against each request's own route.
    this.cached = new HttpLambdaAuthorizer('EdgeAuthorizerCached', this.fn, {
      identitySource: IDENTITY_SOURCE,
      responseTypes: [HttpLambdaResponseType.IAM],
      resultsCacheTtl: cdk.Duration.seconds(EDGE_RESULT_TTL_SECONDS),
    });
    this.uncached = new HttpLambdaAuthorizer('EdgeAuthorizerUncached', this.fn, {
      identitySource: IDENTITY_SOURCE,
      responseTypes: [HttpLambdaResponseType.IAM],
      resultsCacheTtl: cdk.Duration.seconds(0),
    });
  }

  /** The attachment a route takes: uncached for the exchange and single-use routes, cached otherwise. */
  authorizerFor(routeKey: string): HttpLambdaAuthorizer {
    return UNCACHED_ROUTES.includes(routeKey) ? this.uncached : this.cached;
  }
}
