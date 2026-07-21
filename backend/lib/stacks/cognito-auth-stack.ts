import * as cdk from 'aws-cdk-lib';
import { apiAccessLogConfig } from '../constructs/api-access-logging';
import { adminApiMethodOptions, adminAuthEnv } from '../constructs/admin-auth-mode';
import { adminOrigin, sharedOrigins } from '../config/app-origins';
import {
  ADMIN_PERSONAS,
  ADMIN_PERSONA_GROUP,
} from '../config/admin-capabilities';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import {
  classificationChannelScopedAllow,
  archivedChannelReadOnlyDeny,
  Classification,
  SSM_ROOT,
  STACK_PREFIX,
  RES_PREFIX,
  ANALYTICS_PREFIX,
  ATHENA_WORKGROUP_NAME,
  ANALYTICS_DB_NAME,
  INSTANCE_SSM,
  SHARED_SSM,
} from './agent-classification-common';
import { defaultProfileRegistry as profiles } from '../profile-registry';

export interface CognitoAuthStackProps extends cdk.StackProps {
  appInstanceArn: string;
  /**
   * SSM parameter NAME (a plain string, so no circular stack dep) that the S3 storage
   * stack publishes the attachments-bucket ARN to. The credential exchange resolves it at
   * cold start to build the S3 attachment session policy (admin conversation attachment
   * review). Absent ⇒ the S3 attachment vend is unavailable.
   */
  attachmentsBucketArnParam?: string;
}

export class CognitoAuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly authenticatedRole: iam.Role;
  /**
   * The `admins` group's sign-on Identity-Pool role (A14). Exposed so cross-stack
   * admin APIs (analytics, experiments) can attach `execute-api:Invoke` teeth for
   * their capabilities onto it (SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md section 6).
   */
  public readonly adminSignOnRoleArn: string;
  /**
   * The admin-PLANE exchange role ARN (`${sub}-admin`, standing app-instance-admin). Exposed
   * so the S3 storage stack can grant it `s3:GetObject` on the attachments bucket (the ceiling
   * the exchange's per-channel session policy intersects), keeping the bucket grant with the
   * bucket and out of a circular stack dependency.
   */
  public readonly exchangeRoleAdminPlaneArn: string;
  /**
   * A14 persona sign-on role ARNs by persona key, populated only when
   * `-c enableAdminPersonas=true`. Passed to the analytics + experiments stacks
   * so each persona role gets execute-api teeth for exactly its capability set.
   */
  public readonly adminPersonaRoleArns: Record<string, string> = {};
  /**
   * A14 Scoped: the caller's classification ceiling is resolved from their assumed-role ARN
   * (`lib/caller-scope.ts`), so the analytics + admin-conversations Lambdas need a role -> ceiling
   * map. A JSON array of `{ role: <arn>, ceiling: <classification | 'full'> }` built from the
   * per-clearance Identity-Pool roles, passed to those stacks as the `CLASSIFICATION_ROLE_CEILINGS`
   * env. No Cognito call is made at read time, so the VPC-attached analytics Lambda needs no path
   * to the Cognito API.
   */
  public readonly classificationRoleCeilings: string;
  /**
   * UserFeedback (thumbs) table. Exposed so the Aurora analytics stack can
   * read it for the per-variant thumbs join.
   * CognitoAuth is created before AnalyticsAurora in bin/backend.ts, so this is
   * a clean synth-time reference (no SSM indirection needed).
   */
  public readonly feedbackTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: CognitoAuthStackProps) {
    super(scope, id, props);

    // ============================================================
    // Clearance groups (basic / standard / premium / admins)
    //
    // The app treats Cognito group membership — NOT the custom:tier
    // attribute — as the authoritative signal for what a user is
    // allowed to do. custom:tier is set by the admin UI as a hint,
    // and a sync step (post-confirmation + user-management) mirrors
    // it into the matching group. Defense in depth: clearance checks in
    // create-conversation, share-conversation, and router-agent-
    // handler all look up groups, not the attribute.
    //
    // Precedence (lower number = higher priority) decides which group
    // wins in cognito:groups claims when a user is in multiple groups.
    // ============================================================

    // Create Cognito User Pool for authentication first (no triggers yet)
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${RES_PREFIX}-users`,
      selfSignUpEnabled: true, // Allow self-registration with admin approval
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true, // Auto-verify email addresses
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
        givenName: {
          required: false,
          mutable: true,
        },
        familyName: {
          required: false,
          mutable: true,
        },
      },
      customAttributes: {
        tier: new cognito.StringAttribute({ mutable: true }), // basic, standard, premium
        approved: new cognito.StringAttribute({ mutable: true }), // admin approval flag
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userVerification: {
        emailSubject: 'Verify your email for AgentEchelon',
        emailBody: 'Thank you for signing up! Your verification code is {####}',
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      // MFA opt-in for the user pool. Users can enable TOTP (authenticator
      // apps) on their own. Production deployers wanting `Mfa.REQUIRED` should
      // override via CDK context.
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Protect user data in production
    });

    // Groups: 'admins' (the app-admin identity, not a classification) + one per clearance group from
    // config. Precedence derives from the group's classification rank (higher rank -> lower precedence
    // number -> wins the cognito:groups claim); admins always wins. Group names are a deployment
    // choice (profiles.ts groupClearance) — an enterprise deploy names them after its directory groups.
    const clearance = profiles.groupClearance;
    const maxRank = Math.max(...profiles.classificationValues().map((c) => profiles.rank(c)));
    const groupDefinitions: Array<{ name: string; description: string; precedence: number }> = [
      { name: 'admins', description: 'Administrators with access to user management and moderation', precedence: 0 },
      ...Object.entries(clearance).map(([group, classification]) => ({
        name: group,
        description: `${classification} classification — ${profiles.profileFor(classification).modelKey}`,
        precedence: maxRank - profiles.rank(classification) + 1,
      })),
    ];

    // Captured so the per-classification authenticated IAM roles (created after the
    // Identity Pool below) can be attached to each group via `roleArn` —
    // Token-based role selection then hands each user their clearance group's role.
    const clearanceGroupResources: Record<string, cognito.CfnUserPoolGroup> = {};
    for (const g of groupDefinitions) {
      // Logical ID must match the deployed name ({name}Group) so
      // CloudFormation adopts existing resources in place instead of trying
      // to delete and recreate them.
      const groupResource = new cognito.CfnUserPoolGroup(this, `${g.name}Group`, {
        userPoolId: this.userPool.userPoolId,
        groupName: g.name,
        description: g.description,
        precedence: g.precedence,
      });
      // Groups must be created after the user pool itself
      groupResource.addDependency(this.userPool.node.defaultChild as cognito.CfnUserPool);
      clearanceGroupResources[g.name] = groupResource;
    }

    // Create IAM role for Lambda functions with wildcard permissions to avoid circular dependency
    const lambdaRole = new iam.Role(this, 'CognitoTriggersRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        // Cognito policy is attached AFTER user pool creation to scope to the specific pool ARN
        // (see lambdaRole.addToPrincipalPolicy below after userPool is created)
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'chime:CreateAppInstanceUser',
                'chime:DescribeAppInstanceUser',
                'chime:UpdateAppInstanceUser',
              ],
              resources: [
                `${props.appInstanceArn}/user/*`,
                props.appInstanceArn,
              ],
              effect: iam.Effect.ALLOW,
            }),
          ],
        }),
      },
    });

    // Create LogGroups first with known names, then pass to Lambdas to prevent
    // CDK from auto-creating child LogGroups that introduce circular dependencies.
    const postConfirmationLogGroup = new logs.LogGroup(this, 'PostConfirmationLogGroup', {
      logGroupName: `/aws/lambda/${RES_PREFIX}-post-confirmation`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const preAuthenticationLogGroup = new logs.LogGroup(this, 'PreAuthenticationLogGroup', {
      logGroupName: `/aws/lambda/${RES_PREFIX}-pre-authentication`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const postConfirmationFn = new lambda.Function(this, 'PostConfirmationFn', {
      functionName: `${RES_PREFIX}-post-confirmation`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'post-confirmation.handler',
      code: lambda.Code.fromAsset('lambda/cognito-triggers'),
      timeout: cdk.Duration.seconds(10),
      description: 'Sets user attributes and creates Chime App Instance User',
      role: lambdaRole,
      logGroup: postConfirmationLogGroup,
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
      },
    });

    const preAuthenticationFn = new lambda.Function(this, 'PreAuthenticationFn', {
      functionName: `${RES_PREFIX}-pre-authentication`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'pre-authentication.handler',
      code: lambda.Code.fromAsset('lambda/cognito-triggers'),
      timeout: cdk.Duration.seconds(10),
      description: 'Checks if user is approved before allowing login',
      role: lambdaRole,
      logGroup: preAuthenticationLogGroup,
    });

    // Attach triggers using L1 construct to avoid circular dependency
    const cfnUserPool = this.userPool.node.defaultChild as cognito.CfnUserPool;
    cfnUserPool.lambdaConfig = {
      postConfirmation: postConfirmationFn.functionArn,
      preAuthentication: preAuthenticationFn.functionArn,
    };

    // Scope these group-modifying admin actions to THIS pool only. A
    // `userpool/*` wildcard would let the trigger add any user to any group
    // (incl. `admins`) on EVERY pool in the account — a privilege-escalation
    // primitive.
    //
    // This must live in a STANDALONE iam.Policy, NOT addToPrincipalPolicy
    // (which targets the role's *default* policy): CDK makes each trigger
    // Function implicitly depend on its role's default policy, and the
    // UserPool depends on the Functions (lambdaConfig), so a pool reference in
    // the default policy closes the loop UserPool → Function → DefaultPolicy →
    // UserPool. A separate Policy resource is a graph sink (nothing depends on
    // it), so it can reference the pool without cycling. The group-mgmt
    // permission is only exercised at user-confirmation time, long after
    // deploy, so the Function not depending on it is fine.
    new iam.Policy(this, 'CognitoTriggerGroupManagement', {
      roles: [lambdaRole],
      statements: [
        new iam.PolicyStatement({
          actions: [
            'cognito-idp:AdminUpdateUserAttributes',
            'cognito-idp:AdminAddUserToGroup',
            'cognito-idp:AdminRemoveUserFromGroup',
            'cognito-idp:AdminListGroupsForUser',
          ],
          resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${this.userPool.userPoolId}`],
          effect: iam.Effect.ALLOW,
        }),
      ],
    });

    // Grant Cognito permission to invoke the Lambda functions using L1 construct
    const postConfirmationPermission = new lambda.CfnPermission(this, 'PostConfirmationPermission', {
      action: 'lambda:InvokeFunction',
      functionName: postConfirmationFn.functionArn,
      principal: 'cognito-idp.amazonaws.com',
      sourceArn: this.userPool.userPoolArn,
    });

    const preAuthenticationPermission = new lambda.CfnPermission(this, 'PreAuthenticationPermission', {
      action: 'lambda:InvokeFunction',
      functionName: preAuthenticationFn.functionArn,
      principal: 'cognito-idp.amazonaws.com',
      sourceArn: this.userPool.userPoolArn,
    });

    // Hosted-UI callback/logout origins: the real https interface origins (chat +
    // admin), if configured. Localhost is added unconditionally below.
    const oauthOrigins = sharedOrigins(this).filter((o) => o.startsWith('https://'));

    // Create User Pool Client for frontend
    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'web-client',
      authFlows: {
        userPassword: true,
        userSrp: true,
        custom: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
        ],
        // The app authenticates with the raw Cognito SDK (USER_PASSWORD/SRP), not
        // the hosted-UI authorization-code redirect, so these are only used if a
        // deployer adopts the hosted UI. Both interface origins are registered so
        // that path works from either app: the chat SPA (appUrl) and the standalone
        // admin console (adminAppUrl). Localhost stays for development.
        // SPEC-SEPARATE-ADMIN-APP.md.
        callbackUrls: [
          'http://localhost:5173/callback',
          ...oauthOrigins.map((o) => `${o}/callback`),
        ],
        logoutUrls: [
          'http://localhost:5173/',
          ...oauthOrigins.map((o) => `${o}/`),
        ],
      },
    });

    // Dedicated ADMIN app-client (P3, SPEC-SEPARATE-ADMIN-APP.md). On the SAME
    // user pool as the chat client — one pool, authority = `admins` group; this
    // is a second CLIENT, NOT a second pool. It isolates the admin session/token
    // from the chat session and scopes its hosted-UI callbacks to the admin
    // origin only. Opt-in with the admin app (`-c enableAdminApp=true`); a
    // deployer who prefers REUSING the shared client sets `-c adminAppClient=shared`
    // to skip it — the admin app then falls back to VITE_CLIENT_ID (one code path,
    // no extra test matrix).
    const enableAdminApp = this.node.tryGetContext('enableAdminApp') === true
      || this.node.tryGetContext('enableAdminApp') === 'true';
    const useDedicatedAdminClient = enableAdminApp
      && this.node.tryGetContext('adminAppClient') !== 'shared';
    if (useDedicatedAdminClient) {
      const adminAppUrl = adminOrigin(this);
      const adminOAuthOrigins = [adminAppUrl].filter((o) => o.startsWith('https://'));
      const adminClient = this.userPool.addClient('AdminWebClient', {
        userPoolClientName: 'admin-client',
        authFlows: { userPassword: true, userSrp: true, custom: true },
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
          callbackUrls: ['http://localhost:5174/callback', ...adminOAuthOrigins.map((o) => `${o}/callback`)],
          logoutUrls: ['http://localhost:5174/', ...adminOAuthOrigins.map((o) => `${o}/`)],
        },
      });
      new cdk.CfnOutput(this, 'AdminUserPoolClientId', {
        value: adminClient.userPoolClientId,
        description: 'Dedicated admin console app-client id — VITE_ADMIN_CLIENT_ID (admin package .env)',
        exportName: `${this.stackName}-AdminUserPoolClientId`,
      });
    }

    // Create Cognito Identity Pool for AWS credentials
    this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: `${STACK_PREFIX}IdentityPool`,
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: this.userPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
        },
      ],
    });

    // ============================================================
    // Per-classification authenticated IAM roles (SPEC-CONVERSATION-SECURITY Layer 1,
    // user-side). One IAM role per classification (attached to its Cognito group), selected by
    // Cognito Token-based role mapping on the authoritative `cognito:groups`
    // claim (NOT the user-writable `custom:tier` attribute). Each role grants
    // the SAME Chime base permissions (classification isolation is NOT achieved by
    // withholding base messaging — it's achieved by the channel-tag Deny
    // below + the app-layer create/share gates), then layers a pure-IAM Deny
    // on channels tagged with a HIGHER `classification`. So a basic
    // user's own credentials physically cannot SendChannelMessage / join /
    // read a premium-tagged channel — enforced by IAM before any app logic.
    //
    // Safe-by-construction: legitimate same-or-lower-classification access is a strict
    // superset of the old single-role behaviour; the only new restriction is
    // cross-classification, which the live app layer (Layers 2-3) already blocked.
    // ============================================================
    const authTrust = new iam.FederatedPrincipal(
      'cognito-identity.amazonaws.com',
      {
        StringEquals: {
          'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
        },
        'ForAnyValue:StringLike': {
          'cognito-identity.amazonaws.com:amr': 'authenticated',
        },
      },
      'sts:AssumeRoleWithWebIdentity'
    );

    // The Identity-Pool authenticated roles are granted NO Chime access
    // (docs/SPEC-CREDENTIAL-EXCHANGE.md §10). Authenticated users obtain
    // bearer-pinned, classification-capped Chime credentials from the backend
    // Credential Exchange (the per-rung ExchangeRole* above). Granting nothing
    // here keeps the end-user permission set minimal: no unpinned `…/user/*`
    // bearer, no CreateChannel / CreateChannelMembership /
    // DeleteChannelMembership, no CreateAppInstanceUser / UpdateAppInstanceUser,
    // and no moderator actions (Update/Redact/Delete).
    //
    // The roles + the Identity-Pool role mapping are KEPT (so the pool still
    // resolves a principal and `cognito:preferred_role` still flows) but are
    // powerless for Chime. The frontend reaches Chime ONLY via the exchange, so
    // `VITE_CREDENTIAL_EXCHANGE_API_URL` is REQUIRED — there is no Identity-Pool
    // Chime fallback. `AuthenticatedRole` keeps its logical id (adopted in place)
    // and doubles as the ambiguous-role fallback.
    const makeClassificationRole = (logicalId: string): iam.Role =>
      new iam.Role(this, logicalId, { assumedBy: authTrust });

    // One Identity-Pool role per classification (+ admin). They are structurally identical (auth
    // trust only, Chime-powerless — real authority is the credential-exchange), so they are generated
    // from config. The FLOOR classification's role keeps the 'AuthenticatedRole' logical id: it is
    // public and doubles as the ambiguous-role default.
    const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
    const classificationRoles: Record<string, iam.Role> = {};
    for (const c of profiles.classificationValues()) {
      const logicalId = c === profiles.failClosedValue ? 'AuthenticatedRole' : `${capitalize(c)}AuthenticatedRole`;
      classificationRoles[c] = makeClassificationRole(logicalId);
    }
    this.authenticatedRole = classificationRoles[profiles.failClosedValue];
    const adminAuthRole = makeClassificationRole('AdminAuthenticatedRole');
    this.adminSignOnRoleArn = adminAuthRole.roleArn;

    // Attach each group to its classification's role so the ID token carries `cognito:preferred_role`
    // (lowest-precedence group with a roleArn wins); admins -> the admin role.
    for (const [group, classification] of Object.entries(clearance)) {
      clearanceGroupResources[group].roleArn = classificationRoles[classification].roleArn;
    }
    clearanceGroupResources['admins'].roleArn = adminAuthRole.roleArn;

    // A14 Scoped: `this.classificationRoleCeilings` (the role -> ceiling map the analytics +
    // admin-conversations handlers use) is assembled LATER in this constructor — it must also include
    // the credential-exchange ADMIN + ADMIN-PLANE roles, which aren't created until below. See the
    // assignment after the exchange roles are defined.

    // Token-based role selection: the Identity Pool hands each authenticated
    // user the role from their group's roleArn; ambiguous/absent → the default
    // `authenticated` role (basic, most-restrictive).
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: this.authenticatedRole.roleArn,
      },
      roleMappings: {
        cognitoProvider: {
          type: 'Token',
          ambiguousRoleResolution: 'AuthenticatedRole',
          identityProvider: `cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}:${this.userPoolClient.userPoolClientId}`,
        },
      },
    });

    // ============================================================
    // Credential Exchange Service (docs/SPEC-CREDENTIAL-EXCHANGE.md — Step One)
    //
    // Backend exchange that vends STS creds with a `sub` session tag so the
    // assumed role pins the ChimeBearer to the caller's OWN AppInstanceUser
    // (`…/user/${aws:PrincipalTag/sub}`) — closing the impersonation vector and
    // the end-user over-grant cluster, and laying the federation substrate.
    // These are separate roles from the Identity-Pool roles above.
    // ============================================================
    // Credential-exchange is dual-plane: the chat SPA vends chat creds and the
    // admin console vends `${sub}-admin` creds, both against this one endpoint. So
    // its CORS must trust BOTH origins (credential-exchange.ts echoes the matching
    // request Origin from the comma list). SPEC-SEPARATE-ADMIN-APP.md.
    const exchangeOrigins = sharedOrigins(this);
    const appUrlForExchange = exchangeOrigins.join(',');
    // The bearer pinned to the caller's own AppInstanceUser via the session tag.
    // NOTE: built by concatenation so the `${aws:PrincipalTag/sub}` IAM policy
    // variable is emitted literally (a template literal would try to interpolate it).
    const PINNED_USER_ARN = `${props.appInstanceArn}/user/` + '${aws:PrincipalTag/sub}';
    // The admin PLANE identity: the caller's OWN `${sub}-admin` app-instance-user (a
    // standing app-instance-admin). Same session `sub` tag; `-admin` appended in-policy.
    const PINNED_ADMIN_USER_ARN = `${props.appInstanceArn}/user/` + '${aws:PrincipalTag/sub}-admin';
    // The minimal channel actions the frontend uses. UpdateChannel is included
    // for OWNER RENAME only — Chime authorizes it on ChannelModerator status, and a
    // conversation's creator is a moderator of their own channel, so a non-moderator
    // member is denied. Redact/Delete (message or channel) stay moderator/backend-only.
    const EXCHANGE_MSG_ACTIONS = [
      'chime:SendChannelMessage',
      'chime:GetChannelMessage',
      'chime:ListChannelMessages',
      'chime:DescribeChannel',
      'chime:ListChannelMemberships',
      // Read the channel's live moderator list so the client can determine
      // "am I currently a moderator" from the authoritative Chime source
      // (not inferred from createdBy). Tag-gated read; discloses only who moderates.
      'chime:ListChannelModerators',
      'chime:UpdateChannelReadMarker',
      'chime:UpdateChannel',
    ];
    // Moderation actions vended ONLY to the admin rung (its ceiling); each request
    // narrows to the specific action via an STS session policy in the exchange.
    const EXCHANGE_MODERATION_ACTIONS = [
      'chime:RedactChannelMessage', 'chime:DeleteChannelMessage',
      'chime:CreateChannelMembership', 'chime:DeleteChannelMembership', 'chime:CreateChannelModerator',
      'chime:UpdateChannel', 'chime:DeleteChannel',
    ];
    type Rung = 'restricted' | Classification | 'admin';

    // Grant the bearer-PINNED, minimal permission set for a rung
    // (docs/SPEC-CREDENTIAL-EXCHANGE.md §5a restriction spectrum). Every rung is
    // pinned to PINNED_USER_ARN; action set + channel scope grow with trust.
    const grantPinnedExchangePermissions = (role: iam.Role, rung: Rung): void => {
      // Session — endpoint is identity-less; Connect bears the pinned user only.
      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['chime:GetMessagingSessionEndpoint'],
        resources: ['*'],
      }));
      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['chime:Connect'],
        resources: [PINNED_USER_ARN],
      }));
      // Channel messaging — bearer pinned in both halves.
      if (rung === 'restricted' || rung === 'admin') {
        // restricted: scoped by ADMISSION (member of one channel; Chime enforces
        // membership). admin: cross-classification. Both: no classification tag condition.
        role.addToPolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: EXCHANGE_MSG_ACTIONS,
          resources: [`${props.appInstanceArn}/channel/*`],
        }));
        role.addToPolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: EXCHANGE_MSG_ACTIONS,
          resources: [PINNED_USER_ARN],
        }));
        // SPEC-CONVERSATION-ARCHIVE (ADR-017): archived channels are read-only for
        // every CHAT-plane identity — including the admin's own chat identity here
        // (the classification rungs get this Deny via classificationChannelScopedAllow). The exemption is
        // the SEPARATE admin-PLANE role (`exchangeRoleAdminPlane`, built directly, not
        // via this helper) + the app-instance-admin bearer the archive Lambda uses; a
        // Deny is global for the principal, so scoping it to `archived=true` leaves
        // every non-archived channel untouched.
        role.addToPolicy(archivedChannelReadOnlyDeny(props.appInstanceArn));
        // NOTE: the admin rung is the admin's CHAT identity — cross-classification messaging pinned
        // to `${sub}`, and NEVER an app-instance-admin. The moderation ceiling lives on the
        // SEPARATE admin-plane role (pinned to `${sub}-admin`) below, so a chat cred can
        // never carry moderation authority nor read a channel the admin is not a member of.
      } else {
        // basic/standard/premium: tag-gated channel (≤ classification) + pinned bearer —
        // the SAME fail-closed boundary, with the bearer now pinned.
        for (const s of classificationChannelScopedAllow(rung, props.appInstanceArn, EXCHANGE_MSG_ACTIONS, {
          bearerResources: [PINNED_USER_ARN],
        })) role.addToPolicy(s);
      }
      // restricted-external/guest stops here: no discovery, no self-membership
      // management, no profile writes (SPEC §5a). Higher rungs get those, pinned.
      if (rung !== 'restricted') {
        role.addToPolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['chime:DescribeAppInstanceUser', 'chime:UpdateAppInstanceUser'],
          resources: [PINNED_USER_ARN],
        }));
        role.addToPolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['chime:ListChannelMembershipsForAppInstanceUser', 'chime:DescribeChannelMembership'],
          resources: [PINNED_USER_ARN],
        }));
        // Leave a channel: remove OWN membership only (member = pinned user) on a
        // channel they're in (Chime membership-gates). NOT add/remove others.
        role.addToPolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['chime:DeleteChannelMembership'],
          resources: [PINNED_USER_ARN, `${props.appInstanceArn}/channel/*`],
        }));
        role.addToPolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['chime:ListChannels'],
          resources: [props.appInstanceArn],
        }));
      }
    };

    // The exchange Lambda's own execution role (assumes the rung roles + creates
    // AppInstanceUsers). Created first so the rung roles can trust it.
    const credentialExchangeRole = new iam.Role(this, 'CredentialExchangeRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimeIdentity: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            // CreateAppInstanceUser: the chat identity `${sub}` AND the admin identity
            // `${sub}-admin`. CreateAppInstanceAdmin: register `${sub}-admin` as a standing
            // app-instance-admin. De-provisioning on demotion is the reconcile sweep's job,
            // not the exchange's, so no DeleteAppInstanceAdmin here.
            actions: ['chime:CreateAppInstanceUser', 'chime:DescribeAppInstanceUser', 'chime:CreateAppInstanceAdmin'],
            resources: [`${props.appInstanceArn}/user/*`, props.appInstanceArn],
          })],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    // One bearer-pinned exchange role per rung, assumed-by the exchange Lambda
    // WITH the `sub` session tag (sts:TagSession). Require the tag so the role is
    // never assumed un-pinned.
    const makeExchangeRole = (logicalId: string, rung: Rung): iam.Role => {
      const role = new iam.Role(this, logicalId, {
        assumedBy: new iam.ArnPrincipal(credentialExchangeRole.roleArn),
      });
      grantPinnedExchangePermissions(role, rung);
      // Allow the exchange Lambda to pass the `sub` session tag, and require it.
      role.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ArnPrincipal(credentialExchangeRole.roleArn)],
        actions: ['sts:TagSession'],
        conditions: { StringLike: { 'aws:RequestTag/sub': '*' } },
      }));
      return role;
    };
    const exchangeRoleRestricted = makeExchangeRole('ExchangeRoleRestricted', 'restricted');
    const exchangeRoleBasic = makeExchangeRole('ExchangeRoleBasic', 'basic');
    const exchangeRoleStandard = makeExchangeRole('ExchangeRoleStandard', 'standard');
    const exchangeRolePremium = makeExchangeRole('ExchangeRolePremium', 'premium');
    const exchangeRoleAdmin = makeExchangeRole('ExchangeRoleAdmin', 'admin');

    // The admin-PLANE role: pinned to the admin's SEPARATE `${sub}-admin` identity (a
    // standing app-instance-admin), it carries the view + moderation ceiling on any channel.
    // Assumed ONLY for a channel-scoped, short-lived, audited admin vend
    // (credential-exchange.ts, plane:'admin'); the STS session policy narrows it to the one
    // target channel + the requested capabilities. Because this authority lives on an
    // identity that never holds a `channel/*` chat cred, a chatting admin can never wield it.
    const exchangeRoleAdminPlane = new iam.Role(this, 'ExchangeRoleAdminPlane', {
      assumedBy: new iam.ArnPrincipal(credentialExchangeRole.roleArn),
    });
    exchangeRoleAdminPlane.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['chime:GetMessagingSessionEndpoint'],
      resources: ['*'],
    }));
    exchangeRoleAdminPlane.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['chime:Connect'],
      resources: [PINNED_ADMIN_USER_ARN],
    }));
    exchangeRoleAdminPlane.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [...EXCHANGE_MSG_ACTIONS, ...EXCHANGE_MODERATION_ACTIONS],
      resources: [`${props.appInstanceArn}/channel/*`, PINNED_ADMIN_USER_ARN],
    }));
    exchangeRoleAdminPlane.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ArnPrincipal(credentialExchangeRole.roleArn)],
      actions: ['sts:TagSession'],
      conditions: { StringLike: { 'aws:RequestTag/sub': '*' } },
    }));
    // Exposed for the S3 storage stack's attachment-read grant (see props docs).
    this.exchangeRoleAdminPlaneArn = exchangeRoleAdminPlane.roleArn;

    // The exchange Lambda may assume those rung roles (with TagSession).
    credentialExchangeRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [
        exchangeRoleRestricted.roleArn, exchangeRoleBasic.roleArn, exchangeRoleStandard.roleArn,
        exchangeRolePremium.roleArn, exchangeRoleAdmin.roleArn, exchangeRoleAdminPlane.roleArn,
      ],
    }));

    // A14 Scoped: the role -> ceiling map the analytics + admin-conversations handlers use to resolve
    // the caller's classification ceiling from their assumed-role ARN (no Cognito call, so it works from
    // an isolated VPC). Admin Identity-Pool role -> Full; each per-classification role -> its tier. CRUCIALLY
    // it must ALSO include the credential-exchange ADMIN + ADMIN-PLANE roles: admin conversation/archive
    // reads deliberately run under the elevated admin-plane exchange identity (read ANY channel without
    // membership), so requests arrive bearing `ExchangeRoleAdminPlane`, NOT the Identity-Pool admin role.
    // Omitting them made a full admin's conversation read fail-closed to the floor ("outside your
    // classification scope"). Both elevated admin identities -> Full (they are only ever vended to admins).
    this.classificationRoleCeilings = this.toJsonString([
      { role: adminAuthRole.roleArn, ceiling: 'full' },
      { role: exchangeRoleAdmin.roleArn, ceiling: 'full' },
      { role: exchangeRoleAdminPlane.roleArn, ceiling: 'full' },
      ...Object.entries(classificationRoles).map(([classification, role]) => ({
        role: role.roleArn,
        ceiling: classification,
      })),
    ]);

    const credentialExchangeFn = new lambdaNodeJs.NodejsFunction(this, 'CredentialExchangeFunction', {
      entry: './lambda/src/credential-exchange.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      role: credentialExchangeRole,
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        ALLOWED_ORIGIN: appUrlForExchange,
        EXCHANGE_ROLE_BASIC: exchangeRoleBasic.roleArn,
        EXCHANGE_ROLE_STANDARD: exchangeRoleStandard.roleArn,
        EXCHANGE_ROLE_PREMIUM: exchangeRolePremium.roleArn,
        EXCHANGE_ROLE_ADMIN: exchangeRoleAdmin.roleArn,
        EXCHANGE_ROLE_ADMIN_PLANE: exchangeRoleAdminPlane.roleArn,
        EXCHANGE_ROLE_RESTRICTED: exchangeRoleRestricted.roleArn,
      },
      bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
    });

    const exchangeAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CredentialExchangeAuthorizer', {
      cognitoUserPools: [this.userPool],
    });
    const credentialExchangeApi = new apigateway.RestApi(this, 'CredentialExchangeApi', {
      restApiName: `${RES_PREFIX}-credential-exchange`,
      description: 'Vends bearer-pinned, classification-capped Chime creds (SPEC-CREDENTIAL-EXCHANGE)',
      defaultCorsPreflightOptions: {
        allowOrigins: exchangeOrigins,
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
      deployOptions: apiAccessLogConfig(this, 'CredentialExchangeAccessLogs'),
    });
    const exchangeResource = credentialExchangeApi.root.addResource('exchange-credentials');
    exchangeResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(credentialExchangeFn),
      { authorizer: exchangeAuthorizer, authorizationType: apigateway.AuthorizationType.COGNITO },
    );

    // --- Federated exchange (a host app's OWN Cognito pool) — additive, opt-in ---
    // A host user, validated against THEIR pool, gets bearer-pinned creds capped at
    // the 'restricted' rung (federated-credential-exchange.ts derives a disjoint
    // `fed_` AppInstanceUser id). Enable with `-c federatedUserPoolId=us-east-1_xxx`.
    const federatedPoolId = this.node.tryGetContext('federatedUserPoolId') as string | undefined;
    if (federatedPoolId) {
      const federatedPool = cognito.UserPool.fromUserPoolId(this, 'FederatedHostPool', federatedPoolId);
      const federatedAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'FederatedExchangeAuthorizer', {
        cognitoUserPools: [federatedPool],
      });
      const federatedExchangeFn = new lambdaNodeJs.NodejsFunction(this, 'FederatedCredentialExchangeFunction', {
        entry: './lambda/src/federated-credential-exchange.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        role: credentialExchangeRole, // reuse: can AssumeRole(restricted)+TagSession+CreateAppInstanceUser
        environment: {
          APP_INSTANCE_ARN: props.appInstanceArn,
          ALLOWED_ORIGIN: '*',
          EXCHANGE_ROLE_RESTRICTED: exchangeRoleRestricted.roleArn,
        },
        bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
      });
      exchangeResource.addResource('federated').addMethod(
        'POST',
        new apigateway.LambdaIntegration(federatedExchangeFn),
        { authorizer: federatedAuthorizer, authorizationType: apigateway.AuthorizationType.COGNITO },
      );
      new cdk.CfnOutput(this, 'FederatedExchangeApiUrl', {
        value: `${credentialExchangeApi.url}exchange-credentials/federated`,
        description: 'Federated credential exchange (host-pool token → capped creds)',
      });
    }

    new cdk.CfnOutput(this, 'CredentialExchangeApiUrl', {
      value: credentialExchangeApi.url,
      description: 'Credential Exchange endpoint (POST /exchange-credentials) — VITE_CREDENTIAL_EXCHANGE_API_URL',
      exportName: `${this.stackName}-CredentialExchangeApiUrl`,
    });

    // ============================================================
    // User Management API (admin-only)
    // ============================================================

    // CORS origins for this stack's admin-plane APIs after the console split
    // (SPEC-SEPARATE-ADMIN-APP.md). User-management + admin-conversations are
    // admin-only → the admin console origin. Feedback is dual-plane (chat POSTs
    // thumbs, admin GETs the summary) → both origins (user-feedback.ts echoes the
    // matching request Origin from the comma list).
    const adminAppUrl = adminOrigin(this);
    const feedbackOrigins = sharedOrigins(this);

    const userMgmtRole = new iam.Role(this, 'UserManagementRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        CognitoAdmin: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'cognito-idp:ListUsers',
                'cognito-idp:AdminUpdateUserAttributes',
                'cognito-idp:AdminDisableUser',
                'cognito-idp:AdminEnableUser',
                'cognito-idp:AdminGetUser',
                'cognito-idp:AdminAddUserToGroup',
                'cognito-idp:AdminRemoveUserFromGroup',
                'cognito-idp:AdminListGroupsForUser',
                // Full-lifecycle delete (SPEC-CREDENTIAL-EXCHANGE §5b).
                'cognito-idp:AdminDeleteUser',
              ],
              resources: [this.userPool.userPoolArn],
            }),
          ],
        }),
        ChimeIdentity: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'chime:CreateAppInstanceUser',
                'chime:DescribeAppInstanceUser',
                // Refresh the display Name on reconnect (backfills users created before names were set).
                'chime:UpdateAppInstanceUser',
                // Delete on offboard — neutralizes the …/user/<sub> ARN.
                'chime:DeleteAppInstanceUser',
              ],
              resources: [
                `${props.appInstanceArn}/user/*`,
                props.appInstanceArn,
              ],
            }),
          ],
        }),
        // Membership cleanup on delete (SPEC-CREDENTIAL-EXCHANGE §5b) — acts as the
        // app-instance admin (SPEC-MODERATION), same as admin-conversations.
        ChimeMembership: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['chime:ListChannelMembershipsForAppInstanceUser', 'chime:DeleteChannelMembership'],
              resources: [`${props.appInstanceArn}/*`],
            }),
          ],
        }),
        SsmRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${INSTANCE_SSM.appInstanceAdminArn}`],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const userMgmtFn = new lambdaNodeJs.NodejsFunction(this, 'UserManagementFunction', {
      entry: './lambda/src/user-management.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      role: userMgmtRole,
      environment: {
        ...adminAuthEnv(this),
        SSM_ROOT,
        USER_POOL_ID: this.userPool.userPoolId,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ALLOWED_ORIGIN: adminAppUrl,
        ADMIN_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    // Admin-plane auth mode (ae-cognito default / federated / service) — see
    // docs/ADMIN-INTEGRATION-GUIDE.md. ae-cognito uses a Cognito authorizer on AE's own pool.
    const userMgmtAuthOptions = adminApiMethodOptions(this, 'UserMgmtAuthorizer', {
      userPool: this.userPool,
    });

    const userMgmtApi = new apigateway.RestApi(this, 'UserManagementApi', {
      restApiName: 'Agent Echelon User Management',
      defaultCorsPreflightOptions: {
        allowOrigins: [adminAppUrl],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        throttlingBurstLimit: 20,
        throttlingRateLimit: 10,
        // Access logging.
        ...apiAccessLogConfig(this, 'UserManagementApiAccessLogs'),
      },
    });

    const usersResource = userMgmtApi.root.addResource('users');
    const userMgmtIntegration = new apigateway.LambdaIntegration(userMgmtFn);

    usersResource.addMethod('GET', userMgmtIntegration, userMgmtAuthOptions);

    for (const action of ['approve', 'reject', 'tier', 'enable']) {
      usersResource.addResource(action).addMethod('POST', userMgmtIntegration, userMgmtAuthOptions);
    }

    // Outputs
    new cdk.CfnOutput(this, 'UserManagementApiUrl', {
      value: `${userMgmtApi.url}users`,
      description: 'User Management API URL (admin only)',
      exportName: `${this.stackName}-UserManagementApiUrl`,
    });

    // A14 personas (opt-in, SPEC section 2): four example admin roles, each a
    // group -> sign-on role holding execute-api teeth for EXACTLY its capability
    // set — so a persona that omits a capability is denied that resource at the
    // gateway (real fine-grained denial, not just admins-Full). Off by default
    // (`-c enableAdminPersonas=true`); the spec ships them as a reviewable
    // starting point, not enabled infra. Their analytics + profile teeth are
    // granted cross-stack (those stacks read `adminPersonaRoleArns`). Message
    // content (view-messages, A2) is exchange-vended (admins-only) and not part
    // of these standing grants.
    const enableAdminPersonas = this.node.tryGetContext('enableAdminPersonas') === true
      || this.node.tryGetContext('enableAdminPersonas') === 'true';
    if (enableAdminPersonas) {
      for (const persona of ADMIN_PERSONAS) {
        const groupName = ADMIN_PERSONA_GROUP[persona];
        const pascal = groupName.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
        const personaRole = makeClassificationRole(`${pascal}PersonaRole`);
        this.adminPersonaRoleArns[persona] = personaRole.roleArn;
        new cognito.CfnUserPoolGroup(this, `${pascal}Group`, {
          userPoolId: this.userPool.userPoolId,
          groupName,
          description: `A14 admin persona (${persona}) — execute-api teeth for its capability set`,
          precedence: 1,
          roleArn: personaRole.roleArn,
        }).addDependency(this.userPool.node.defaultChild as cognito.CfnUserPool);
        // The admin-conversations execute-api teeth for this persona are granted in AdminPlaneStack (D1):
        // it imports this role by ARN (via adminPersonaRoleArns) and attaches the teeth there, so the API
        // can live outside the IdP stack with no circular dependency — the same cross-stack teeth pattern
        // already used for the analytics + profile grants.
      }
    }

    // A14 exchange-vend plane (view-messages / A2, customer message content): the
    // admin-plane exchange role's CEILING includes execute-api:Invoke on the
    // messages resource, so the exchange can assume it with a session policy scoped
    // to exactly that resource (short-lived, audited). The resource ARN is handed to
    // the exchange Lambda so it can build that session policy.
    // The admin-conversations API now lives in AdminPlaneStack (D1); to avoid a circular stack dep back
    // to it, scope by a wildcard-api-id ARN with the EXACT method+path — the vended cred can reach only
    // GET /admin/conversations/messages (the only API exposing that path), staying scoped + audited.
    const messagesExecuteApiArn = `arn:aws:execute-api:${this.region}:${this.account}:*/*/GET/admin/conversations/messages`;
    exchangeRoleAdminPlane.addToPolicy(new iam.PolicyStatement({
      actions: ['execute-api:Invoke'],
      resources: [messagesExecuteApiArn],
    }));
    credentialExchangeFn.addEnvironment('EXCHANGE_EXECUTE_API_MESSAGES_ARN', messagesExecuteApiArn);
    // Live-Chime actions (members list, add-self/add-member, redact, delete) are NOT
    // here: they run client-side as the admin's own `${sub}-admin` identity
    // (docs/SPEC-ADMIN-IDENTITY.md). This API is read-only over the archive.

    // S3 attachment vend (admin conversation attachment review). The exchange resolves the
    // attachments-bucket ARN from this SSM param at cold start (the S3 stack publishes it; a
    // CDK prop would be circular), then vends an `s3:GetObject` session policy scoped to the
    // named channel's keys. Grant the exchange Lambda read on ONLY that param. The bucket-key
    // ceiling itself is granted onto exchangeRoleAdminPlane by the S3 stack.
    if (props.attachmentsBucketArnParam) {
      credentialExchangeFn.addEnvironment('EXCHANGE_ATTACHMENTS_BUCKET_ARN_PARAM', props.attachmentsBucketArnParam);
      credentialExchangeRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${props.attachmentsBucketArnParam}`],
      }));
    }

    // ============================================================
    // User Feedback API
    // ============================================================

    const isProduction = this.node.tryGetContext('environment') === 'production';

    const feedbackTable = this.feedbackTable = new dynamodb.Table(this, 'UserFeedbackTable', {
      partitionKey: { name: 'feedbackId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    const feedbackRole = new iam.Role(this, 'UserFeedbackRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        FeedbackDdb: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'dynamodb:PutItem',
                'dynamodb:Scan',
              ],
              resources: [feedbackTable.tableArn],
            }),
          ],
        }),
        // Caller-membership check uses the caller's own AppInstanceUser ARN as
        // ChimeBearer (allowed for self-membership-lookup by Chime); no bot SSM
        // lookup needed.
        FeedbackChime: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['chime:DescribeChannelMembership'],
              resources: [`${props.appInstanceArn}/*`],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const feedbackFn = new lambdaNodeJs.NodejsFunction(this, 'UserFeedbackFunction', {
      entry: './lambda/src/user-feedback.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      role: feedbackRole,
      environment: {
        FEEDBACK_TABLE: feedbackTable.tableName,
        ALLOWED_ORIGIN: feedbackOrigins.join(','),
        // M4: needed for the channel-membership check before recording feedback.
        APP_INSTANCE_ARN: props.appInstanceArn,
        // The GET summary is admin-gated via callerIsAdmin; give the handler the
        // admin-auth mode/env so it honors ADMIN_GROUP_NAMES / service mode.
        ...adminAuthEnv(this),
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    const feedbackAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'FeedbackAuthorizer', {
      cognitoUserPools: [this.userPool],
    });

    const feedbackApi = new apigateway.RestApi(this, 'UserFeedbackApi', {
      restApiName: 'Agent Echelon User Feedback',
      defaultCorsPreflightOptions: {
        allowOrigins: feedbackOrigins,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        throttlingBurstLimit: 30,
        throttlingRateLimit: 15,
        // Access logging.
        ...apiAccessLogConfig(this, 'UserFeedbackApiAccessLogs'),
      },
    });

    const feedbackIntegration = new apigateway.LambdaIntegration(feedbackFn);
    const feedbackResource = feedbackApi.root.addResource('feedback');
    // POST is user-level: any authenticated user submits feedback (plain Cognito
    // authorizer). GET is the admin summary and gates on admin authority via the
    // mode-aware options (Cognito admins group / federated host pool / IAM service).
    feedbackResource.addMethod('POST', feedbackIntegration, {
      authorizer: feedbackAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    const feedbackAdminAuthOptions = adminApiMethodOptions(this, 'FeedbackAdminAuthorizer', {
      userPool: this.userPool,
    });
    feedbackResource.addMethod('GET', feedbackIntegration, feedbackAdminAuthOptions);

    // ── Admin conversation membership sync (SPEC-ADMIN-IDENTITY section 8) ───────
    // Scheduled reconcile: resolves the `admins` group and syncs each configured
    // admin conversation's Chime membership + Metadata participants[]; also
    // de-provisions app-instance-admin for humans no longer in the group. Runs as
    // the service app-instance-admin. Configure channels with -c adminConversationArns.
    const adminConversationArns = (this.node.tryGetContext('adminConversationArns') as string) || '';
    const adminGroupNamesCtx = (this.node.tryGetContext('adminGroupNames') as string) || '';
    const adminConvSyncFn = new lambdaNodeJs.NodejsFunction(this, 'AdminConversationSyncFunction', {
      entry: './lambda/src/admin-conversation-sync.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        USER_POOL_ID: this.userPool.userPoolId,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ADMIN_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
        ADMIN_CONVERSATION_ARNS: adminConversationArns,
        ...(adminGroupNamesCtx ? { ADMIN_GROUP_NAME: adminGroupNamesCtx.split(',')[0].trim() } : {}),
      },
      bundling: { externalModules: ['@aws-sdk/*'], minify: true },
    });
    adminConvSyncFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsersInGroup'],
      resources: [this.userPool.userPoolArn],
    }));
    adminConvSyncFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'chime:ListChannelMemberships', 'chime:CreateChannelMembership', 'chime:DeleteChannelMembership',
        'chime:DescribeChannel', 'chime:UpdateChannel',
        // DeleteAppInstanceUser: clean up a demoted admin's orphaned `${sub}-admin` identity.
        'chime:ListAppInstanceAdmins', 'chime:DeleteAppInstanceAdmin', 'chime:DeleteAppInstanceUser',
      ],
      resources: [props.appInstanceArn, `${props.appInstanceArn}/*`],
    }));
    adminConvSyncFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${INSTANCE_SSM.appInstanceAdminArn}`],
    }));
    new events.Rule(this, 'AdminConversationSyncSchedule', {
      schedule: events.Schedule.expression((this.node.tryGetContext('adminSyncRate') as string) || 'rate(15 minutes)'),
      targets: [new targets.LambdaFunction(adminConvSyncFn)],
    });

    // AdminConversationApiUrl output moved to AdminPlaneStack (D1).

    new cdk.CfnOutput(this, 'UserFeedbackApiUrl', {
      value: `${feedbackApi.url}feedback`,
      description: 'User feedback API URL',
      exportName: `${this.stackName}-UserFeedbackApiUrl`,
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: `${this.stackName}-UserPoolId`,
    });

    // Shared SSM contract: the per-classification handlers (router code deployed per-classification)
    // resolve this for message-time classification enforcement (AdminListGroupsForUser).
    // Published here so the per-classification stacks can resolve it without a deploy-order
    // cycle.
    new ssm.StringParameter(this, 'SharedCognitoUserPoolIdParam', {
      parameterName: SHARED_SSM.cognitoUserPoolId,
      stringValue: this.userPool.userPoolId,
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
      exportName: `${this.stackName}-UserPoolClientId`,
    });

    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: this.identityPool.ref,
      description: 'Cognito Identity Pool ID',
      exportName: `${this.stackName}-IdentityPoolId`,
    });

    // Project is set once at the app root (derived from the instance); do NOT override it
    // per-stack or every instance mis-attributes. Only add the stack-specific Component.
    cdk.Tags.of(this).add('Component', 'Authentication');
  }
}
