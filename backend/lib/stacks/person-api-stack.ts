/**
 * PERSON API (`<prefix>PersonApi`): every route a person calls, on one HTTP API behind the edge authorizer.
 *
 * It holds no handler. Each stack that owns one declares its routes (`routes`, `lib/constructs/http-api.ts`),
 * and this stack serves the person routes of the stacks it is built on: the core's, and those of each
 * declared capability that brings any (`battle`, `notifications`). So a capability that is not declared
 * has no route here, and the API is the only thing that changes when one is.
 *
 * EVERY ROUTE IS AUTHORIZED AT THE EDGE (A3), the credential exchange included: the token is verified
 * against the trusted-issuer registry and resolved through `Identities`, and the answer is a policy naming
 * the routes it may call. A first sign-in reaches the exchange alone, and a one-conversation person
 * `ONE_CHANNEL_ROUTES` alone, and a guest `GUEST_ROUTES` alone, and a host's assertion the exchange alone,
 * once (its `jti` is recorded in `Tokens`). The exchange is never answered from the authorizer cache. The routes with no authorizer are the paused-deployment probe, which names nobody and
 * reads nothing private, and, with a guest issuer, guest start and guest refresh, which take no token and
 * carry their own abuse controls and a route throttle each (L16).
 *
 * CORS: the chat app's and the admin console's origins (the console resolves its person here), and every
 * origin an issuer declares for its clients (the hosts that embed the widget), and the widget frame's own
 * origin (`widgetUrl`) with the `widget` capability.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { sharedOrigins, widgetOrigin } from '../config/app-origins';
import { parseCapabilities } from '../config/capabilities';
import { EdgeAuthorizer } from '../constructs/edge-authorizer';
import { RouteTableApi, type RouteSpec } from '../constructs/http-api';
import { issuersOf } from '../constructs/trusted-issuers';
import { WIDGET_HOST_ORIGIN } from '../config/issuers';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { INSTANCE_NAME, SHARED_SSM } from './agent-classification-common';

export interface PersonApiStackProps extends cdk.StackProps {
  /** Every person route, from the stacks this one is built on. */
  routes: readonly RouteSpec[];
  /** The app instance whose users the edge resolves a token to. */
  appInstanceArn: string;
  /** This deployment's own pool, or `''` when the registry declares none. */
  selfPoolId: string;
  /** The pool's app clients: the audience its tokens carry. */
  selfClientIds: string[];
  /** `Identities` (Identity): the edge reads it, and never writes it. */
  identities: dynamodb.ITable;
  /** The guest issuer's signing keys (Identity), KMS key ARN by `kid`, when the registry declares one. */
  guestSigningKeys?: Record<string, string>;
  /** `Tokens` (Conversations): the edge records a host assertion's `jti` there, when the registry declares a host. */
  tokens?: dynamodb.ITable;
  /**
   * What each conversation type declares that this deployment cannot serve (T4, FR14), one line each
   * (`typeCapabilityGaps`, `lib/config/type-capabilities.ts`). Recorded as the `ConversationTypeGaps` output.
   */
  conversationTypeGaps?: readonly string[];
}

/**
 * The origins a person's browser calls from: both consoles, every host an issuer declares, and, with the
 * `widget` capability, the widget frame's own origin (`widgetUrl`) once the deployer passes it.
 */
export function personApiOrigins(scope: Construct): string[] {
  // The sample host page (`"widget-host"`, `WIDGET_HOST_ORIGIN`) only frames the widget and calls nothing,
  // so it is no origin here (`lib/stacks/widget-host-stack.ts`).
  const hosts = issuersOf(scope).entries.flatMap((e) => e.allowedOrigins ?? []).filter((o) => o !== WIDGET_HOST_ORIGIN);
  const widget = parseCapabilities(scope.node.tryGetContext('capabilities')).includes('widget') ? widgetOrigin(scope) : undefined;
  return [...new Set([...sharedOrigins(scope), ...hosts, ...(widget ? [widget] : [])])];
}

export class PersonApiStack extends cdk.Stack {
  readonly api: RouteTableApi;
  readonly edge: EdgeAuthorizer;

  constructor(scope: Construct, id: string, props: PersonApiStackProps) {
    super(scope, id, props);
    if (props.routes.some((r) => r.api !== 'person')) throw new Error('PersonApi serves person routes only');

    this.edge = new EdgeAuthorizer(this, 'EdgeAuthorizer', {
      appInstanceArn: props.appInstanceArn,
      selfPoolId: props.selfPoolId,
      selfClientIds: props.selfClientIds,
      identities: { tableName: props.identities.tableName, tableArn: props.identities.tableArn },
      plane: 'person',
      guestSigningKeys: props.guestSigningKeys,
      tokens: props.tokens,
    });
    this.api = new RouteTableApi(this, 'PersonApi', {
      apiName: `${INSTANCE_NAME}-person-api`,
      description: 'Every route a person calls, behind the edge authorizer',
      routes: props.routes,
      allowedOrigins: personApiOrigins(this),
      edge: this.edge,
    });

    new cdk.CfnOutput(this, 'PersonApiUrl', {
      value: this.api.url,
      description: 'The person API base URL - VITE_PERSON_API_URL (both console packages)',
    });
    // WHERE A LINK IN AN EMAIL POINTS: the preference page (`/email/preferences`, B9) is a route here, and the
    // Notifications stack that mints those links deploys before this one, so it reads the URL at run time.
    new ssm.StringParameter(this, 'PersonApiUrlParam', { parameterName: SHARED_SSM.personApiUrl, stringValue: this.api.url });
    // WHICH CAPABILITIES' ROUTES ARE SERVED, so a client offers a feature only where its route exists.
    new cdk.CfnOutput(this, 'PersonApiCapabilities', {
      value: [...new Set(props.routes.map((r) => r.capability))].sort().join(','),
      description: 'The capabilities whose person routes this API serves - VITE_PERSON_API_CAPABILITIES',
    });

    // THE DEPLOYMENT'S CLASSIFICATIONS ARE NOT AN OUTPUT: the clients read them at load from `GET /classifications`
    // (Conversations), which answers from the runtime registry, so a classification added later changes nothing here.

    // WHAT A CONVERSATION TYPE DECLARES AND THIS DEPLOYMENT CANNOT SERVE (T4, FR14): each such dimension
    // resolves off and the conversation is created as it always was, so the gap is recorded here rather
    // than discovered in a conversation.
    new cdk.CfnOutput(this, 'ConversationTypeGaps', {
      value: props.conversationTypeGaps?.length ? props.conversationTypeGaps.join('; ') : 'none',
      description: 'Conversation-type transports and capabilities this deployment does not serve, resolved off',
    });

    cdk.Tags.of(this).add('Component', 'PersonApi');
  }
}
