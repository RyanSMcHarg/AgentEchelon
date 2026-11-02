import * as cdk from 'aws-cdk-lib';
import { AUDIENCE_TAG } from '../../lambda/src/lib/channel-classification';
import { adminOrigin, chatOrigin, sharedOrigins } from '../config/app-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import {
  SSM_ROOT,
  STACK_PREFIX,
  RES_PREFIX,
  ANALYTICS_PREFIX,
  INSTANCE_SSM,
  SHARED_SSM,
  adminPlaneMembershipStatements,
  serviceAdminArnOf,
  ownInstanceFunctionsOnly,
  INSTANCE_NAME,
  EVERY_CLASSIFICATION,
} from './agent-classification-common';
import { edgeIssuers, edgeVerificationErrors } from '../config/edge-verification';
import { defaultProfileRegistry as profiles } from '../profile-registry';
import { publishRegistryRow, registryBucket, registryHealthAlarms } from '../constructs/registry-row';
import { COGNITO_LIFECYCLE_EVENTS } from '../../lambda/src/lib/issuer-lifecycle';
import { grantAccountStateRead } from '../constructs/directory-access';
import { issuersOf, trustedIssuersJson } from '../constructs/trusted-issuers';
import { PROVISIONERS, SubjectProvisioner, type ProvisionerCaller } from '../constructs/subject-provisioner';
import { contactCopiesDeclared, grantContactCopyParams } from '../constructs/contact-copy';
import type { RouteSource, RouteSpec } from '../constructs/http-api';
import { GuestIssuer } from '../constructs/guest-issuer';
import { GUEST_VISITOR_TYPE, upgradePathsOf } from '../config/conversation-types';
import { grantServerEventAppend } from '../constructs/server-event-writer';
import { InvitationLinkIssuer } from '../constructs/invitation-link-issuer';
import { clearanceGroups } from '../constructs/clearance-groups';
import { MEMBERSHIP_GROUP_PRECEDENCE_BASE } from '../config/profiles';
import {
  ExchangeRole, assumeAnyVendRoleStatements, vendedClassifications, EXCHANGE_ROLE_ARN_PARAM_ROOT, type VendToken,
} from '../constructs/exchange-role';

export interface IdentityStackProps extends cdk.StackProps {
  appInstanceArn: string;
  /** Whether `admin` is declared: the admin console's own app client is created on this deployment's pool. */
  adminConsoleClient?: boolean;
  /**
   * The connector grant revoker's function name, when a declared connector takes per-person grants (K3):
   * offboarding invokes it for the person's grants. The Connectors stack grants the invoke beside it.
   */
  connectorGrantsFunction?: string;
  /**
   * The `provisioned-only` issuers each caller may provision a subject for (P-13, `provisionerIssuers`):
   * the admin backend's, with `admin`, and the connector receiver's, with `connectors`. A caller absent here
   * gets no provisioner.
   */
  subjectProvisioners?: Partial<Record<ProvisionerCaller, string[]>>;
  /**
   * Whether the deployment receives email replies (M-8): `notifications` is declared with a `replyDomain`.
   * The reply poster's role is created here, beside the one-conversation role it assumes.
   */
  emailReplies?: boolean;
  /**
   * Whether `battle` is declared: offboarding is told the parameter the Battle stack publishes its conversation
   * battle-setting table under, and reads it, so a person named on a battle setting is erased with the rest.
   * Absent, offboarding names no battle store and makes no read for one.
   */
  battle?: boolean;
}

/**
 * IDENTITY: who a person is, and what they are vended.
 *
 * The user pool and its groups, the credential exchange (the one AppInstanceUser minter) and the roles it
 * vends, the `Identities` index, the trusted-issuer registry the exchange reads, offboarding, and the
 * platform CloudTrail trail, beside the roles whose use it records. There is no Identity Pool: every
 * credential a person holds is vended by the exchange, bearer-pinned to their own AppInstanceUser.
 *
 * NOTHING HERE IS ADMINISTRATION. The admin console's app client, its credential exchange and roles, user
 * management and the admin-conversation sync are the `AdminServices` stack's, which exists with the `admin`
 * capability and takes what it needs from this stack by reference. Offboarding stays here (D9): it erases
 * a person for every issuer, which is identity, not administration, and the console asks this stack's
 * `OffboardingFunction` to do it (`lib/offboarding-console.ts`).
 */
export class IdentityStack extends cdk.Stack implements RouteSource {
  /** This deployment's own pool, when the trusted-issuer registry declares an issuer on it (L15). */
  public readonly userPool?: cognito.UserPool;
  public readonly userPoolClient?: cognito.UserPoolClient;
  /** The pool's id, or `''` for a deployment with no pool of its own. */
  public readonly selfPoolId: string;
  /** The pool's app clients (the chat app's and the admin console's): the audience its tokens carry. */
  public readonly selfClientIds: string[];
  /** The person credential exchange, on `PersonApi`. */
  public readonly routes: RouteSpec[];
  /**
   * The role offboarding runs on (the issuer-event handler, and the console's delete through it). Exposed
   * so the stacks that own a person's records grant it on those records, with the resource and out of a
   * stack cycle.
   */
  public readonly offboardingRoleArn: string;
  /** The one function offboarding runs in. The admin console's user management invokes it (ADR-058). */
  public readonly offboardingFunction: lambda.IFunction;
  /** (issuer id, subject) -> the person's AppInstanceUser. Written only by the exchange and offboarding. */
  public readonly identitiesTable: dynamodb.ITable;
  /**
   * The access log (ADR-052): written by the exchange (a person's first sign-in), by offboarding (every
   * `Identities` change) and by the admin credential exchange (every operator access); read by the admin
   * console. Kept beside its first writers, which deploy first.
   */
  public readonly accessLogTable: dynamodb.ITable;
  /** The credential exchange's role. Conversations grants it the contact copies' write (C5) and the guest's token kinds and creator, by reference. */
  public readonly credentialExchangeRoleArn: string;
  /** The credential exchange itself: the invitations function (Conversations) asks it to mint an invitee. */
  public readonly credentialExchangeFunction: lambda.IFunction;
  /** The classifications a `link` invitation session may be vended at, when the registry declares an `invitation-link` issuer. */
  public readonly invitationLinkReach?: string[];
  /** The guest issuer's signing keys, KMS key ARN by `kid`, when the registry declares a guest issuer. */
  public readonly guestSigningKeys?: Record<string, string>;
  /** The guest-session role a visitor's credential is on, when the registry declares a guest issuer. */
  public readonly guestSessionRoleArn?: string;
  /** The subject provisioners, by the caller each one serves (P-13). The caller's stack grants itself the invoke. */
  public readonly subjectProvisioners: Partial<Record<ProvisionerCaller, lambda.IFunction>> = {};
  /**
   * The role the email reply poster runs on (M-8), when the deployment receives replies, and the
   * one-conversation role it assumes to post as the person. The Notifications stack builds the function.
   */
  public readonly replyPoster?: { roleArn: string; restrictedRoleArn: string };

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);

    // ── THIS DEPLOYMENT'S OWN POOL, WHEN AN ISSUER IS DECLARED ON IT (L15) ─────────────────────────
    const issuerRegistryOfThis = issuersOf(this);
    const pool = issuerRegistryOfThis.ownsPool() ? this.buildSelfPool(props.adminConsoleClient === true) : undefined;
    this.userPool = pool?.userPool;
    this.userPoolClient = pool?.userPoolClient;
    this.selfPoolId = pool?.userPool.userPoolId ?? '';
    this.selfClientIds = pool ? [
      pool.userPoolClient.userPoolClientId,
      ...(pool.adminClient ? [pool.adminClient.userPoolClientId] : []),
      ...(pool.federatedClient ? [pool.federatedClient.userPoolClientId] : []),
    ] : [];


    // ============================================================
    // Credential Exchange Service (docs/SPEC-CREDENTIAL-EXCHANGE.md — Step One)
    //
    // Backend exchange that vends STS creds with a `person` session tag so the
    // assumed role pins the ChimeBearer to the caller's OWN AppInstanceUser
    // (`…/user/${aws:PrincipalTag/person}`) — closing the impersonation vector and
    // the end-user over-grant cluster, and laying the federation substrate.
    // It is the only way a person obtains AWS credentials: there is no Identity Pool.
    // ============================================================
    // Both consoles sign a person in through this exchange (the admin console resolves its person here
    // before it asks the admin credential exchange for a console session), so its CORS trusts BOTH
    // origins (the exchange echoes the matching request Origin from the comma list).
    const exchangeOrigins = sharedOrigins(this);
    const appUrlForExchange = exchangeOrigins.join(',');
    // A person's vend roles, their bearer-pinned statements and their boundaries are `ExchangeRole`
    // (`lib/constructs/exchange-role.ts`), built here for the one-conversation role and the admin plane, and by
    // each `Assistants-<classification>` stack for its own classification.

    // ── THE TRUSTED-ISSUER REGISTRY (lib/config/issuers.ts) ─────────────────────────────────────────
    //
    // Which issuers a person may sign in through, how each names its subject, and where each one's
    // clearance comes from. The exchange, offboarding and the directory read it as `TRUSTED_ISSUERS`;
    // the exchange's authorizer admits its pools; its other pools' lifecycle events offboard.
    const issuers = issuersOf(this);
    const trustedIssuersJsonValue = trustedIssuersJson(this, this.selfPoolId);
    const lifecyclePoolIds = issuers.lifecyclePoolIds();

    // The exchange Lambda's own execution role (assumes the classification roles + creates
    // AppInstanceUsers). Created first so the classification roles can trust it.
    const credentialExchangeRole = new iam.Role(this, 'CredentialExchangeRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimeIdentity: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            // CreateAppInstanceUser: the person, minted once per (issuer, subject) by lib/person-identity.ts,
            // and nothing else. The admin-plane twin and its app-instance-admin registration are the admin
            // credential exchange's (`AdminServices`), so this role holds no CreateAppInstanceAdmin.
            // chime:TagResource stamps the caller's clearance onto their AppInstanceUser, so
            // the classification is readable on the identity and not only derivable from Cognito.
            // The exchange tags in a SEPARATE call rather than on create - see `ensureAppInstanceUser`
            // for why that distinction is load-bearing here and not for channels or bots.
            // chime:UpdateAppInstanceUser refreshes the caller's cached display name from the verified
            // token's `name` claim. The code writes only the authenticated `sub`; the vended session
            // policy never carries this action, so a client cannot rename itself.
            actions: [
              'chime:CreateAppInstanceUser',
              'chime:DescribeAppInstanceUser',
              'chime:UpdateAppInstanceUser',
              'chime:TagResource',
            ],
            resources: [`${props.appInstanceArn}/user/*`, props.appInstanceArn],
          })],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    // THE ONE-CONVERSATION ROLE (`restricted`), which is not a classification: bounded by the session scope and
    // by membership rather than by a classification tag (SPEC-CONVERSATION-SECURITY section 4a, footnote 1). The
    // same construct as every vend role, on the same path, with the same pins on its trust policy.
    const exchangeRoleRestricted = new ExchangeRole(this, 'ExchangeRoleRestricted', {
      appInstanceArn: props.appInstanceArn, token: 'restricted', exchangeRoleArn: credentialExchangeRole.roleArn,
    }).role;

    // ── THE EMAIL REPLY POSTER (M-8): A PERSON'S REPLY, ON THE PERSON'S OWN ROLE ──────────────────
    //
    // A reply that passes its token, DMARC and From checks is posted as the person, on the session the
    // exchange's one-conversation vend gives them: this role, with the same `person` and `classification`
    // assertions on the assume and on the tagging, so the bearer is pinned exactly as it is for the exchange.
    // Its role holds the assume and nothing else here; the Notifications stack adds what the poster reads.
    if (props.emailReplies) {
      const replyPosterRole = new iam.Role(this, 'EmailReplyPosterRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      });
      const restrictedPin = {
        StringLike: { 'aws:RequestTag/person': '*' },
        StringEquals: { 'aws:RequestTag/classification': 'restricted' },
      };
      exchangeRoleRestricted.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ArnPrincipal(replyPosterRole.roleArn)],
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        conditions: restrictedPin,
      }));
      replyPosterRole.addToPolicy(new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [exchangeRoleRestricted.roleArn],
      }));
      this.replyPoster = { roleArn: replyPosterRole.roleArn, restrictedRoleArn: exchangeRoleRestricted.roleArn };
    }
    // ── THE ADMIN PLANE'S VEND ROLE, HERE; EVERY OTHER CLASSIFICATION'S, IN ITS OWN STACK ─────────────────
    //
    // A conversational classification's vend role is built by its `Assistants-<classification>` stack
    // (`ExchangeRole`, `lib/constructs/exchange-role.ts`), so declaring one changes nothing here. The admin
    // plane is part of every deployment and has no stack of its own, so its chat identity's role is built here,
    // the same construct on the same path.
    vendedClassifications(issuers)
      .filter((value) => profiles.adminPlaneValues().includes(value))
      .forEach((value) => new ExchangeRole(this, `ExchangeRole${value.charAt(0).toUpperCase()}${value.slice(1)}`, {
        appInstanceArn: props.appInstanceArn, token: value as VendToken, exchangeRoleArn: credentialExchangeRole.roleArn,
      }));
    // THE ADMIN PLANE'S ROW OF THE RUNTIME REGISTRY. The admin plane has no stack of its own, so its row is
    // published here, beside its vend role. It names no member classification: the registry reads its grants
    // as every member classification the rows declare (`profilesConfigFromRows`), so a classification added or
    // removed changes nothing here.
    // The registry bucket holds the S3 copy of every row, which the functions in the analytics VPC read; it is
    // created here because this stack deploys before every other stack that writes a row.
    const registryRowsBucket = registryBucket(this);
    for (const value of profiles.adminPlaneValues()) {
      publishRegistryRow(this, `ProfileRegistryRow${value.charAt(0).toUpperCase()}${value.slice(1)}`, value)
        .s3Copy.node.addDependency(registryRowsBucket);
    }
    // The registry's alarms live with the one stack every deployment has, so no classification's stack carries them.
    registryHealthAlarms(this);

    // The exchange may assume a vend role of this instance (with TagSession) and read where each is published:
    // the path and the `Instance` tag, never a list of ARNs, so a classification's role is assumable once its
    // own stack has built it, with no edit here.
    for (const st of assumeAnyVendRoleStatements(this)) credentialExchangeRole.addToPolicy(st);

    const credentialExchangeFn = new lambdaNodeJs.NodejsFunction(this, 'CredentialExchangeFunction', {
      entry: './lambda/src/credential-exchange.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // A path A bind assesses the visit (a model call, bounded at 8 s) before it opens the continuation,
      // inside the HTTP API's 30-second integration limit. Every other exchange finishes in well under 15.
      timeout: cdk.Duration.seconds(28),
      memorySize: 256,
      role: credentialExchangeRole,
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        ALLOWED_ORIGIN: appUrlForExchange,
        // EACH CLASSIFICATION'S VEND ROLE IS FOUND BY NAME AT CALL TIME, under the key its own stack publishes
        // (`exchangeRoleArnKey`), so the exchange's environment names no classification.
        EXCHANGE_ROLE_ARN_PARAM_ROOT,
        EXCHANGE_ROLE_RESTRICTED: exchangeRoleRestricted.roleArn,
        ...(this.selfPoolId ? { USER_POOL_ID: this.selfPoolId } : {}),
        // ONE EXCHANGE FOR EVERY ISSUER: the registry decides the subject, the clearance and the
        // classifications it may grant, admin, and whether a person is vended one conversation.
        TRUSTED_ISSUERS: trustedIssuersJsonValue,
      },
      bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
    });
    // THE CONTACT COPY (C5): an issuer declaring the `claims` directory has its people's contact claims
    // kept at each sign-in, in a table and under a key a later stack owns, found here at run time.
    if (contactCopiesDeclared(this)) grantContactCopyParams(credentialExchangeFn);
    // WHETHER THE ACCOUNT MAY STILL SIGN IN, asked of its pool at every vend before anything is minted
    // (`refuseInactiveAccount`, lib/vend.ts; SPEC-CREDENTIAL-EXCHANGE §4b): AdminGetUser and ListUsers on
    // exactly the registry's Cognito pools, and no write on any of them.
    grantAccountStateRead(this, credentialExchangeRole, this.selfPoolId);

    // ── THE ACCESS LOG (ADR-052, SPEC-ADMIN-CONSOLE FR30) ──────────────────────────────────────────
    //
    // Every operator access the admin credential exchange vends writes a record here BEFORE the credential
    // is returned, and a record that cannot be written withholds the credential (`lib/access-log.ts`); this
    // exchange records each person it mints, and offboarding each `Identities` change. Kept here because
    // those writers are here and this stack deploys first; the admin backend writes and reads it by
    // reference. Retained whatever the stack's data policy: an access record outlives the stack that
    // wrote it. Records expire 400 days after the access (TTL).
    const accessLogTable = new dynamodb.Table(this, 'AccessLogTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    // Who reached this conversation, and what did this person reach. Sparse: a console session names no
    // conversation, so it is in the actor index only.
    accessLogTable.addGlobalSecondaryIndex({
      indexName: 'byConversation',
      partitionKey: { name: 'conversation', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'at', type: dynamodb.AttributeType.STRING },
    });
    accessLogTable.addGlobalSecondaryIndex({
      indexName: 'byActor',
      partitionKey: { name: 'actorPersonId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'at', type: dynamodb.AttributeType.STRING },
    });
    this.accessLogTable = accessLogTable;
    // WRITE ONLY, and only new records: the exchange can add to the log and can never read, change or
    // remove what is there.
    credentialExchangeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem'],
      resources: [accessLogTable.tableArn],
    }));
    credentialExchangeFn.addEnvironment('ACCESS_LOG_TABLE', accessLogTable.tableName);

    // ── IDENTITIES: (ISSUER, SUBJECT) -> THE PERSON'S AppInstanceUser ────────────────────────────────
    //
    // The index the one minter (lambda/src/lib/person-identity.ts) reserves a person in before it creates
    // their AppInstanceUser, with an opaque UUID v7 id. Key `issuerSubject = <issuerId>|<subject>`, the
    // trusted-issuer registry's id and the subject its entry declares (lib/config/issuers.ts); `personArn`,
    // `issuer`, `status` (`active` | `pending`) and `createdAt`; the GSI `byPerson`
    // answers which subjects sign in as one AppInstanceUser. Tenet D8: no existing seam serves - the
    // Amazon Chime SDK has no lookup of an AppInstanceUser by tag or metadata, and Cognito holds only its
    // own pool's subjects.
    //
    // A SUBJECT IS MAPPED TO A PERSON ONLY BY THE EXCHANGE. Its role is the one principal granted an
    // unconditioned write here; one exchange serves every issuer. Every other reader is
    // granted `GetItem`/`Query`. Offboarding, on its own role, may delete a row and put a `revoked`
    // marker, and nothing else (`IdentitiesOffboarding`, below). No row records an identity provider's
    // state: a disabled account is refused at the vend by a live read of its pool.
    // Retained like the access log: losing it re-mints every person under a new id.
    const identitiesTable = new dynamodb.Table(this, 'IdentitiesTable', {
      partitionKey: { name: 'issuerSubject', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    identitiesTable.addGlobalSecondaryIndex({
      indexName: 'byPerson',
      partitionKey: { name: 'personArn', type: dynamodb.AttributeType.STRING },
    });
    this.identitiesTable = identitiesTable;
    // GetItem to resolve and to read a subject's `revoked` marker, PutItem to reserve (conditional). The
    // exchange never remaps or removes a row (offboarding does, on its own role); its one update is below.
    credentialExchangeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
      resources: [identitiesTable.tableArn],
    }));
    // C3: THE EXCHANGE RECORDS ITS CLEARANCE DECISION on the subject's row (`recordClearanceDecision`,
    // `lib/person-identity.ts`), and this update may touch that one attribute and nothing else, so it can
    // never remap a subject, change a status or move a row to another person.
    credentialExchangeRole.addToPolicy(new iam.PolicyStatement({
      sid: 'RecordTheClearanceDecisionOnly',
      actions: ['dynamodb:UpdateItem'],
      resources: [identitiesTable.tableArn],
      conditions: {
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['issuerSubject', 'clearanceDecision'] },
        StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] },
      },
    }));
    credentialExchangeFn.addEnvironment('IDENTITIES_TABLE', identitiesTable.tableName);
    // B7: A SECOND ISSUER IS LINKED to a pinned person (`lib/issuer-link.ts`). The exchange reads which
    // subjects the person already holds (the `byPerson` index) and verifies the second token itself, with
    // the checks the edge applies to every issuer but a guest and a host (`LINK_ISSUERS`). The row is
    // written with the conditional put above.
    credentialExchangeRole.addToPolicy(new iam.PolicyStatement({
      sid: 'LinkReadsThePersonsSubjects',
      actions: ['dynamodb:Query'],
      resources: [`${identitiesTable.tableArn}/index/byPerson`],
    }));
    // A registry the edge cannot verify is refused at synth by PersonApi, which every deployment builds, so
    // no deployed exchange runs with an empty list; Identity alone (a stack test) links nobody with one.
    const linkContext = { deploymentId: INSTANCE_NAME, omitGuest: true };
    credentialExchangeFn.addEnvironment('LINK_ISSUERS', edgeVerificationErrors(issuers, this.selfClientIds, linkContext).length
      ? '[]'
      : this.toJsonString(edgeIssuers(issuers, this.selfPoolId, this.region, this.selfClientIds, linkContext)));
    // A PROVISIONED SUBJECT IS BOUND, ONCE (P-13): `pending` becomes `active` on the rows of the
    // provisioned-only issuers, and on no other key.
    const provisionedOnlyIds = issuers.provisionedOnly().map((e) => e.id);
    if (provisionedOnlyIds.length) {
      credentialExchangeRole.addToPolicy(new iam.PolicyStatement({
        sid: 'BindProvisionedSubject',
        actions: ['dynamodb:UpdateItem'],
        resources: [identitiesTable.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': provisionedOnlyIds.map((i) => `${i}|*`) } },
      }));
    }
    // A HOST ASSERTION'S `jti` IS CONSUMED HERE (A9), in `Tokens`, which Conversations owns and deploys
    // after this stack: its name is read at run time, and the grant on the table is made there.
    if (issuers.hostAssertions().length) {
      credentialExchangeRole.addToPolicy(new iam.PolicyStatement({
        sid: 'HostAssertionTokensName',
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SHARED_SSM.tokensName}`],
      }));
      credentialExchangeFn.addEnvironment('TOKENS_TABLE_PARAMETER', SHARED_SSM.tokensName);
    }
    new ssm.StringParameter(this, 'SharedIdentitiesNameParam', {
      parameterName: SHARED_SSM.identitiesName,
      stringValue: identitiesTable.tableName,
    });
    new ssm.StringParameter(this, 'SharedIdentitiesArnParam', {
      parameterName: SHARED_SSM.identitiesArn,
      stringValue: identitiesTable.tableArn,
    });

    // THE EXCHANGE'S ROUTE, ON `PersonApi`, behind the edge authorizer's UNCACHED attachment: every issuer the
    // registry declares reaches it, the one-conversation ones and a first sign-in included, since it is
    // what mints their person. What a person is vended follows from their issuer's entry
    // (`TRUSTED_ISSUERS`, above), never from a second route. Not throttled: a shared throttle here would
    // throttle sign-in for everyone at once.
    this.routes = [
      { api: 'person', method: 'POST', path: '/exchange-credentials', handler: credentialExchangeFn, capability: 'core' },
    ];
    this.credentialExchangeRoleArn = credentialExchangeRole.roleArn;

    // ── THE GUEST ISSUER (A7, L16), WHEN THE REGISTRY DECLARES ONE ─────────────────────────────────
    //
    // Its signing keys, kill switch, address salt and guest-session role, and its two unauthenticated
    // routes, which run on this exchange: guest start mints a visitor through the same minter as every
    // first sign-in, so `Identities` keeps its one writer.
    const guestEntry = issuers.guest();
    if (guestEntry) {
      const guest = new GuestIssuer(this, 'GuestIssuer', {
        entry: guestEntry,
        appInstanceArn: props.appInstanceArn,
        exchangeRole: credentialExchangeRole,
        exchangeFunction: credentialExchangeFn,
      });
      // THE FUNNEL'S STAGES (B12) recorded on this exchange: guest start and its refusals, and a path A bind.
      grantServerEventAppend(credentialExchangeFn, 'GuestFunnel');
      this.guestSigningKeys = guest.signingKeys;
      this.guestSessionRoleArn = guest.sessionRole.roleArn;
      this.routes.push(...guest.routes);
      // PATH A (`lib/guest-bind.ts`): the bind deletes the visitor's guest-issuer row, in the same
      // transaction that writes the account's, and no other issuer's row.
      credentialExchangeRole.addToPolicy(new iam.PolicyStatement({
        sid: 'BindRemovesTheGuestRow',
        actions: ['dynamodb:DeleteItem'],
        resources: [identitiesTable.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${guestEntry.id}|*`] } },
      }));
      // What the deny-tests, the widget build and the operator's switch read about the guest issuer.
      new cdk.CfnOutput(this, 'GuestSessionRoleArn', { value: guest.sessionRole.roleArn, description: 'The guest-session role a visitor is vended on' });
      new cdk.CfnOutput(this, 'GuestKillSwitchParameter', { value: guest.killSwitchParameter, description: 'The guest kill switch (scripts/guest-switch.mjs)' });
      new cdk.CfnOutput(this, 'GuestNoticeVersion', { value: guest.noticeVersion, description: 'The privacy-notice version guest start records as shown' });
      new cdk.CfnOutput(this, 'GuestCaptchaSiteKey', { value: guest.captchaSiteKey, description: 'The captcha site key the widget loads at guest start' });
      // HOW A VISIT BECOMES AN ACCOUNT, as the widget offers it: the paths the visitor's conversation type
      // declares (`upgrade`, `lib/config/conversation-types.ts`) and the chat app the visitor signs in at.
      new cdk.CfnOutput(this, 'GuestUpgradePaths', { value: upgradePathsOf(GUEST_VISITOR_TYPE).join(',') || 'none', description: 'The upgrade paths the visitor\'s conversation type declares - VITE_GUEST_UPGRADE_PATHS' });
      new cdk.CfnOutput(this, 'GuestSignInUrl', { value: chatOrigin(this), description: 'Where the widget sends a visitor to sign in and keep the visit - VITE_GUEST_SIGN_IN_URL' });
    }

    // ── INVITATIONS (M-10, M-5): THE MINTER'S HALF AND THE REDEMPTIONS ──────────────────────────────
    //
    // The invitations function (Conversations) asks this exchange to mint each invitee (`mint-invitee`),
    // created with its expiration in the one call, and a sign-in redemption removes that expiration. The
    // landing page reads an invitation (`/invitations/peek`, unauthenticated, consuming nothing); the
    // `invitation#` grants on `Tokens` are made in Conversations, which owns the table and deploys after this
    // stack, so its name is read at run time. A declared `invitation-link` issuer adds the `link` redemption.
    this.credentialExchangeFunction = credentialExchangeFn;
    credentialExchangeRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InviteeExpiration',
      actions: ['chime:PutAppInstanceUserExpirationSettings'],
      resources: [`${props.appInstanceArn}/user/*`],
    }));
    credentialExchangeRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvitationTokensName',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SHARED_SSM.tokensName}`],
    }));
    this.routes.push({ api: 'person', method: 'POST', path: '/invitations/peek', handler: credentialExchangeFn, capability: 'core', auth: 'none', throttle: { rate: 10, burst: 20 } });
    const linkEntry = issuers.invitationLink();
    let linkConfig: InvitationLinkIssuer['config'] | undefined;
    if (linkEntry) {
      const link = new InvitationLinkIssuer(this, 'InvitationLinkIssuer', {
        entry: linkEntry,
        appInstanceArn: props.appInstanceArn,
        exchangeRole: credentialExchangeRole,
        exchangeFunction: credentialExchangeFn,
      });
      linkConfig = link.config;
      this.invitationLinkReach = link.config.reach;
      this.routes.push(...link.routes);
      new cdk.CfnOutput(this, 'InvitationLinkSessionRoleArn', { value: link.sessionRole.roleArn, description: 'The role a link invitation session is vended on' });
      new cdk.CfnOutput(this, 'InvitationLinkKillSwitchParameter', { value: link.killSwitchParameter, description: 'Pauses link invitation redemption' });
    }
    credentialExchangeFn.addEnvironment('INVITATION_CONFIG', this.toJsonString({
      tokensTableParameter: SHARED_SSM.tokensName,
      signInUrl: chatOrigin(this),
      ...(linkConfig ? { link: linkConfig } : {}),
    }));

    // ============================================================
    // Offboarding (ADR-058, D9): identity, not administration
    // ============================================================

    // ── THE ONE ROLE OFFBOARDING RUNS ON ──────────────────────────────────────────────────────────
    //
    // A person deleted at their issuer is erased by that event; the admin console's delete, re-admission
    // and export ask the same function
    // (`lib/offboarding-console.ts`). This role holds exactly what erasing one person needs, and nothing
    // that administers the pool: no attribute, group or enable write. Those are the `AdminServices`
    // stack's user management, which invokes the function rather than holding these grants itself.
    const offboardingRole = new iam.Role(this, 'OffboardingRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ...(this.userPool || lifecyclePoolIds.length ? { PoolAccount: new iam.PolicyDocument({
          statements: [
            // THIS DEPLOYMENT'S OWN POOL, when it has one.
            ...(this.userPool ? [new iam.PolicyStatement({
              actions: [
                // Whether a subject's account still exists, and the sweep's listing.
                'cognito-idp:AdminGetUser',
                'cognito-idp:ListUsers',
                // Offboarding removes this pool's account, when one exists: every session signed out,
                // then the account (SPEC-CREDENTIAL-EXCHANGE §5b).
                'cognito-idp:AdminUserGlobalSignOut',
                'cognito-idp:AdminDeleteUser',
              ],
              resources: [this.userPool.userPoolArn],
            })] : []),
            // THE OTHER POOLS WHOSE LIFECYCLE EVENTS OFFBOARD (registry entries declaring lifecycle
            // `cloudtrail-cognito`), READ ONLY: whether a subject's account still exists.
            // Offboarding never deletes an account there.
            ...(lifecyclePoolIds.length ? [new iam.PolicyStatement({
              // ListUsers resolves a federated person's `sub` to their pool username (`bySubjectOrUsername`, cognito-pool-directory.ts).
              actions: ['cognito-idp:AdminGetUser', 'cognito-idp:ListUsers'],
              resources: lifecyclePoolIds.map((id) => `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${id}`),
            })] : []),
          ],
        }) } : {}),
        ChimeIdentity: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'chime:DescribeAppInstanceUser',
                // Delete on offboard: the person, and their admin-plane twin.
                'chime:DeleteAppInstanceUser',
                // The twin is found by its `owner` tag, which offboarding reads before removing it.
                'chime:ListTagsForResource',
              ],
              resources: [`${props.appInstanceArn}/user/*`, props.appInstanceArn],
            }),
            // An offboarded twin's app-instance-admin elevation goes with it.
            new iam.PolicyStatement({
              actions: ['chime:DeleteAppInstanceAdmin'],
              resources: [props.appInstanceArn, `${props.appInstanceArn}/user/*`],
            }),
          ],
        }),
        // Membership cleanup (SPEC-CREDENTIAL-EXCHANGE §5b), bearing the app-instance admin (SPEC-MODERATION).
        ChimeMembership: new iam.PolicyDocument({
          statements: [
            // The deleted person's channels: the person listed, bearing the service admin.
            new iam.PolicyStatement({
              actions: ['chime:ListChannelMembershipsForAppInstanceUser'],
              resources: [`${props.appInstanceArn}/user/*`],
            }),
            // AND THE LEAVE FROM EACH: in a channel of any declared
            // classification, the admin plane's included, because a deleted person leaves every
            // conversation they are in; bearing the service admin by its exact ARN, never any person.
            ...adminPlaneMembershipStatements('UserDeleteLeaves', props.appInstanceArn, {
              bearerArns: [serviceAdminArnOf(props.appInstanceArn)],
              channelClassifications: EVERY_CLASSIFICATION,
              actions: ['chime:DeleteChannelMembership'],
            }),
            // ERASURE FOLLOWS THE UPGRADE TAG (P-12): a channel's tags are read to find a claimed
            // conversation's `upgradedFrom`, and in the visitor's conversation it names the person's and the
            // visitor's messages are listed and deleted, bearing the service admin.
            new iam.PolicyStatement({
              sid: 'UpgradeTagRead',
              actions: ['chime:ListTagsForResource'],
              resources: [`${props.appInstanceArn}/channel/*`],
            }),
            // Present where a guest issuer is declared (there is no visitor's conversation without one), and only
            // in a conversation for outside people: the channel it erases in is the visitor's conversation the
            // claimed conversation's own `upgradedFrom` tag names, which is created with the `audience` tag
            // `outside` (`audienceTagFor`), so the grant names no classification and no conversation of the
            // deployment's own people.
            ...(issuers.guest() ? [
              new iam.PolicyStatement({
                sid: 'UpgradeSourceEraseInOutsideConversations',
                actions: ['chime:ListChannelMessages', 'chime:DeleteChannelMessage'],
                resources: [`${props.appInstanceArn}/channel/*`],
                conditions: {
                  StringEquals: { [`aws:ResourceTag/${AUDIENCE_TAG}`]: 'outside' },
                  Null: { 'aws:ResourceTag/classification': 'false' },
                },
              }),
              new iam.PolicyStatement({
                sid: 'UpgradeSourceEraseAsItsBearer',
                actions: ['chime:ListChannelMessages', 'chime:DeleteChannelMessage'],
                resources: [serviceAdminArnOf(props.appInstanceArn)],
              }),
            ] : []),
          ],
        }),
        SsmRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              // The stores a person's records live in, published by the stacks that own them and read at
              // runtime on an offboarding (those stacks deploy after this one, so no deploy-time reference),
              // and the Aurora data plane the offboarding event is archived through, and the person's own
              // projection rows erased through (`erasePerson`), in Aurora mode.
              resources: [
                INSTANCE_SSM.appInstanceAdminArn,
                SHARED_SSM.userProfileName,
                SHARED_SSM.userTasksName,
                SHARED_SSM.agentTasksName,
                SHARED_SSM.turnStateName,
                SHARED_SSM.channelContextName,
                // The conversation battle-setting table's parameter, which the Battle stack publishes, where `battle` is declared.
                ...(props.battle ? [SHARED_SSM.channelBattleConfigName] : []),
                SHARED_SSM.abuseControlsName,
                SHARED_SSM.auroraDataPlaneArn,
                SHARED_SSM.attachmentsBucketArn,
                SHARED_SSM.tokensName,
              ].map((p) => `arn:aws:ssm:${this.region}:${this.account}:parameter${p}`),
            }),
          ],
        }),
        // ── OFFBOARDING'S READS OF `Identities`: a subject's row and its `revoked` marker by key, and a person's
        // rows through `byPerson` (`rowsOfPerson`, `rowOfSubject`, `isRevoked`), which both an erasure and an
        // export (`lib/person-export.ts`) start from. Reads only; the writes are the next document's.
        IdentitiesRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem', 'dynamodb:Query'],
              resources: [identitiesTable.tableArn, `${identitiesTable.tableArn}/index/byPerson`],
            }),
          ],
        }),
        // ── OFFBOARDING'S WRITES ON `Identities` (ADR-058), AND NOTHING ELSE THERE ──────────────────
        //
        // Delete a row, and put a `revoked` marker, whose key starts `revoked#` and which holds nothing but
        // its key. No update: the role never changes a row. A role holding these can remove a person,
        // never make a subject sign in as anyone: only the exchange writes a row that maps a subject to a
        // person. Scan is the sweep's read over one issuer's rows.
        IdentitiesOffboarding: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['dynamodb:DeleteItem', 'dynamodb:Scan'],
              resources: [identitiesTable.tableArn],
            }),
            new iam.PolicyStatement({
              actions: ['dynamodb:PutItem'],
              resources: [identitiesTable.tableArn],
              conditions: {
                'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['revoked#*'] },
                'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['issuerSubject'] },
              },
            }),
            // Each change is written to the access log.
            new iam.PolicyStatement({
              actions: ['dynamodb:PutItem'],
              resources: [accessLogTable.tableArn],
            }),
          ],
        }),
        // THE `offboarding` EVENT, appended to the archive: the client-events Firehose in Athena mode, the
        // Aurora data plane in Aurora mode. Both are named before they exist, because the Archive stack
        // deploys after this one.
        OffboardingArchive: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['firehose:PutRecordBatch'],
              resources: [`arn:aws:firehose:${this.region}:${this.account}:deliverystream/${ANALYTICS_PREFIX}-client-events`],
            }),
            new iam.PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              // This instance's data plane only: the prefix pattern alone also matches an instance whose
              // prefix starts with this one, so the `Instance` tag bounds it.
              resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${STACK_PREFIX}Archive*DataPlaneLambda*`],
              conditions: ownInstanceFunctionsOnly(),
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    this.offboardingRoleArn = offboardingRole.roleArn;

    // ── WHAT OFFBOARDING NEEDS TO FIND A PERSON'S RECORDS (ADR-058) ─────────────────────────────────
    //
    // The stores live in stacks that deploy after this one, so each is named by the SSM parameter its
    // owner publishes and read at runtime; each owner grants this role on its own store (Conversations on
    // its tables and on `attachments/*`), so the grant sits with the resource. The offboarding event
    // goes to the archive the deployment keeps, and each Identities change to the access log.
    // A daily sweep against each pool is the backstop for a dropped event (tenet D6). The Cognito call
    // reaches EventBridge as the CloudTrail record the platform trail in this stack already writes
    // (`PlatformTrail`, below, every management event), so no second trail exists for it.
    const offboardingFn = new lambdaNodeJs.NodejsFunction(this, 'OffboardingFunction', {
      entry: './lambda/src/offboarding-events.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      role: offboardingRole,
      environment: {
        ...(this.selfPoolId ? { USER_POOL_ID: this.selfPoolId } : {}),
        APP_INSTANCE_ARN: props.appInstanceArn,
        IDENTITIES_TABLE: identitiesTable.tableName,
        ADMIN_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
        ACCESS_LOG_TABLE: accessLogTable.tableName,
        USER_PROFILE_NAME_PARAM: SHARED_SSM.userProfileName,
        USER_TASKS_NAME_PARAM: SHARED_SSM.userTasksName,
        AGENT_TASKS_NAME_PARAM: SHARED_SSM.agentTasksName,
        TURN_STATE_NAME_PARAM: SHARED_SSM.turnStateName,
        CHANNEL_CONTEXT_NAME_PARAM: SHARED_SSM.channelContextName,
        ...(props.battle ? { CHANNEL_BATTLE_CONFIG_NAME_PARAM: SHARED_SSM.channelBattleConfigName } : {}),
        ABUSE_CONTROLS_NAME_PARAM: SHARED_SSM.abuseControlsName,
        ATTACHMENTS_BUCKET_ARN_PARAM: SHARED_SSM.attachmentsBucketArn,
        // `Tokens`: a person's email and claim tokens are deleted with them, and a path B registration record when erasure follows the upgrade tag.
        TOKENS_NAME_PARAM: SHARED_SSM.tokensName,
        CLIENT_EVENTS_DELIVERY_STREAM: `${ANALYTICS_PREFIX}-client-events`,
        AURORA_DATA_PLANE_ARN_PARAM: SHARED_SSM.auroraDataPlaneArn,
        // The registry's other pools whose lifecycle events offboard; their accounts are never deleted.
        ...(lifecyclePoolIds.length ? { OFFBOARDING_OTHER_POOL_IDS: lifecyclePoolIds.join(',') } : {}),
        // Each pool's subjects are keyed by its registry id.
        TRUSTED_ISSUERS: trustedIssuersJsonValue,
        // A person's connector grants are revoked at the vendor through this function (K3).
        ...(props.connectorGrantsFunction ? { CONNECTOR_GRANTS_FUNCTION: props.connectorGrantsFunction } : {}),
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    this.offboardingFunction = offboardingFn;

    // ── THE SUBJECT PROVISIONERS (P-13): one per caller, beside the table they write ─────────────────
    for (const caller of PROVISIONERS) {
      const issuerIds = props.subjectProvisioners?.[caller] ?? [];
      if (!issuerIds.length) continue;
      const provisioner = new SubjectProvisioner(this, `SubjectProvisioner${caller === 'admin' ? 'Admin' : 'Connectors'}`, {
        caller,
        issuerIds,
        identities: identitiesTable,
        accessLog: accessLogTable,
        appInstanceArn: props.appInstanceArn,
        trustedIssuersJson: trustedIssuersJsonValue,
      });
      this.subjectProvisioners[caller] = provisioner.fn;
      // What the pending-row deny-test reads: the function, and the role IAM holds to its issuers.
      const Caller = caller === 'admin' ? 'Admin' : 'Connectors';
      new cdk.CfnOutput(this, `SubjectProvisioner${Caller}FunctionName`, { value: provisioner.fn.functionName, description: `provisionSubject for the ${caller} caller (P-13)` });
      new cdk.CfnOutput(this, `SubjectProvisioner${Caller}RoleArn`, { value: provisioner.role.roleArn, description: `The role the ${caller} subject provisioner writes pending rows on` });
    }
    // Every pool whose delete events offboard: this deployment's own, when it has one, and the others the
    // registry declares. With none, no Cognito event offboards anyone, and no rule listens for one. A
    // disable or an enable is not heard: the exchange asks the pool at every vend.
    const offboardingPoolIds = [...(this.selfPoolId ? [this.selfPoolId] : []), ...lifecyclePoolIds];
    if (offboardingPoolIds.length) {
      new events.Rule(this, 'IssuerLifecycleChanged', {
        description: 'Offboard a person when their pool account is deleted',
        eventPattern: {
          source: ['aws.cognito-idp'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['cognito-idp.amazonaws.com'],
            eventName: [...COGNITO_LIFECYCLE_EVENTS],
            requestParameters: { userPoolId: offboardingPoolIds },
          },
        },
        targets: [new targets.LambdaFunction(offboardingFn)],
      });
    }
    new events.Rule(this, 'OffboardingSweepSchedule', {
      description: 'Backstop: converge every pool subject the platform knows with its pool',
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      targets: [new targets.LambdaFunction(offboardingFn)],
    });

    if (this.userPool && this.userPoolClient) {
      new cdk.CfnOutput(this, 'UserPoolId', {
        value: this.userPool.userPoolId,
        description: 'Cognito User Pool ID',
        exportName: `${this.stackName}-UserPoolId`,
      });

      // Shared SSM contract: the per-classification handlers (router code deployed per-classification)
      // resolve this for message-time classification enforcement (AdminListGroupsForUser).
      // Published here so the per-classification stacks can resolve it without a deploy-order
      // cycle. Absent with the pool: every reader resolves it only when the registry declares the pool.
      new ssm.StringParameter(this, 'SharedCognitoUserPoolIdParam', {
        parameterName: SHARED_SSM.cognitoUserPoolId,
        stringValue: this.userPool.userPoolId,
      });

      new cdk.CfnOutput(this, 'UserPoolClientId', {
        value: this.userPoolClient.userPoolClientId,
        description: 'Cognito User Pool Client ID',
        exportName: `${this.stackName}-UserPoolClientId`,
      });
    }

    // ── THE PLATFORM TRAIL ────────────────────────────────────────────────────────────────────────
    //
    // The platform relies on AWS CloudTrail twice: as the control-plane audit layer (every actor is an
    // AWS identity and every action an IAM-authenticated call, SPEC-ACCESS-AND-CONTROLS-AUDITING), and as
    // the event source a Cognito group change reaches EventBridge through, which keeps group-sourced
    // conversations and the admin conversations in sync without polling (tenet D6), and through which an
    // issuer's lifecycle events offboard (above). Without a trail an account keeps only CloudTrail's
    // 90-day event history, which nothing can subscribe to.
    //
    // IT IS HERE, BESIDE THE ROLES WHOSE USE IT RECORDS. Audit is a property of every deployment, not an
    // optional capability, so it is in the required core and in the stack that vends every credential.
    //
    // ON BY DEFAULT, because a foundation the rest of the platform assumes should not be optional by
    // omission. A deployment whose organization already runs a trail sets `-c platformTrail=false`: its
    // trail already delivers these events, and a second trail would be charged for a second copy.
    // All management events (the first copy is free; the cost is S3 storage) and, unless
    // `trailDataEvents=false`, data events for Lambda, DynamoDB, S3 and Kinesis, which are charged per
    // event and accrue while the deployment sleeps (SPEC-COST-SLEEP-MODE). Log-file validation on,
    // retained for `trailRetentionDays` (default 400).
    if (this.node.tryGetContext('platformTrail') !== 'false' && this.node.tryGetContext('platformTrail') !== false) {
      const retentionDays = Number(this.node.tryGetContext('trailRetentionDays') || 400);
      const trailBucket = new s3.Bucket(this, 'PlatformTrailBucket', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        versioned: false,
        // Scoped to the prefix CloudTrail writes under (tenet D15), not bucket-wide.
        lifecycleRules: [{ id: 'ExpireTrailLogs', prefix: 'AWSLogs/', expiration: cdk.Duration.days(retentionDays) }],
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      const trail = new cloudtrail.Trail(this, 'PlatformTrail', {
        bucket: trailBucket,
        includeGlobalServiceEvents: true,
        isMultiRegionTrail: false,
        enableFileValidation: true,
        sendToCloudWatchLogs: false,
      });
      // EVERY API CALL, NOT ONLY THE CONTROL PLANE. Management events already include the Amazon Chime SDK
      // messaging calls (SendChannelMessage, ListChannelMessages, membership), Bedrock InvokeModel and
      // Converse, Cognito and SSM - measured in this account's event history. Lambda invokes, DynamoDB
      // item reads and writes, S3 object access and Kinesis records are DATA events, recorded only when a
      // trail selects them, so they are selected here. The trail's own bucket is excluded: logging the
      // trail's writes to itself would generate events in a loop. `-c trailDataEvents=false` keeps
      // management events only, for a deployment that does not want the data-event charge.
      //
      // NOT CLOUDTRAIL: requests to the platform's own API Gateway APIs. CloudTrail records changes to an
      // API, never the calls made through it; every API here writes an access log instead
      // (`RouteTableApi`, lib/constructs/http-api.ts), which is where those requests are recorded.
      const dataEvents = this.node.tryGetContext('trailDataEvents') !== 'false' && this.node.tryGetContext('trailDataEvents') !== false;
      const dataSelector = (name: string, type: string, extra: cloudtrail.CfnTrail.AdvancedFieldSelectorProperty[] = []) => ({
        name,
        fieldSelectors: [
          { field: 'eventCategory', equalTo: ['Data'] },
          { field: 'resources.type', equalTo: [type] },
          ...extra,
        ],
      });
      const cfnTrail = trail.node.defaultChild as cloudtrail.CfnTrail;
      cfnTrail.addPropertyDeletionOverride('EventSelectors');
      cfnTrail.advancedEventSelectors = [
        { name: 'All management events', fieldSelectors: [{ field: 'eventCategory', equalTo: ['Management'] }] },
        ...(dataEvents ? [
          dataSelector('Lambda invocations', 'AWS::Lambda::Function'),
          dataSelector('DynamoDB item access', 'AWS::DynamoDB::Table'),
          dataSelector('Kinesis records', 'AWS::Kinesis::Stream'),
          dataSelector('S3 object access, except the trail itself', 'AWS::S3::Object', [
            { field: 'resources.ARN', notStartsWith: [`${trailBucket.bucketArn}/`] },
          ]),
        ] : []),
      ];
    }

    // Project is set once at the app root (derived from the instance); do NOT override it
    // per-stack or every instance mis-attributes. Only add the stack-specific Component.
    cdk.Tags.of(this).add('Component', 'Identity');
  }

  /**
   * THIS DEPLOYMENT'S OWN USER POOL: its groups, its sign-up triggers, the chat app's client, the admin
   * console's client when `admin` is declared, and the managed login domain. Built only when the trusted-
   * issuer registry declares an issuer on it (L15): Cognito is the bundled default issuer, and a
   * deployment whose people sign in elsewhere has no pool at all.
   */
  private buildSelfPool(adminConsoleClient: boolean): { userPool: cognito.UserPool; userPoolClient: cognito.UserPoolClient; adminClient?: cognito.UserPoolClient; federatedClient?: cognito.UserPoolClient } {
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

    // ── WHO THE POOL'S EMAILS COME FROM (code review, 2026-09-09) ────────────────────────────────
    //
    // Left unset, CDK defaults this pool to `UserPoolEmail.withCognito()`, which is
    // `EmailSendingAccount: COGNITO_DEFAULT`: every user-facing message - the admin invitation, the
    // self-signup verification code, a password reset - is sent from `no-reply@verificationemail.com`
    // and the whole account is capped at 50 of them a day.
    //
    // That was surprising in a deployment that had configured `senderEmail`, because `senderEmail` IS
    // wired - to the notification and alert paths, and to the SES IAM scoping in `ses-identity.ts` -
    // just never to the pool. So the deployment's own address sent its alerts while its USERS heard
    // from Cognito, and nothing said so.
    //
    // OPT-IN, AND DELIBERATELY SO. The default stays exactly what every existing deployment already
    // has, because turning this on without SES production access is worse than the unbranded address:
    // in the SES sandbox a send to an unverified recipient FAILS, which for self-signup means the
    // verification code never arrives and the person cannot complete registration. The deployer
    // enabling this is asserting their sending identity is verified and their account is out of the
    // sandbox - a claim only they can make.
    //
    // The address must be one SES resolves to a verified identity: either the address itself or a
    // verified DOMAIN covering it. `sesSenderIdentityArns` documents why both forms matter.
    const cognitoEmailFromSender = this.node.tryGetContext('cognitoEmailFromSender') === true
      || this.node.tryGetContext('cognitoEmailFromSender') === 'true';
    const poolSenderEmail = (this.node.tryGetContext('senderEmail') as string) || '';
    const cognitoEmailVerifiedDomain = (this.node.tryGetContext('cognitoEmailVerifiedDomain') as string) || '';
    if (cognitoEmailFromSender && !poolSenderEmail) {
      // Fail loudly at synth rather than silently falling back: a deployer who asked for their own
      // sender and got Cognito's would have no way to tell from the pool.
      throw new Error(
        'cognitoEmailFromSender=true requires senderEmail. Set senderEmail to a verified SES identity '
        + '(or an address under a verified SES domain), or drop cognitoEmailFromSender.',
      );
    }

    // Create Cognito User Pool for authentication first (no triggers yet)
    const userPool = new cognito.UserPool(this, 'UserPool', {
      // Absent unless opted in, so the property itself - not just its value - matches what every
      // existing pool was created with.
      ...(cognitoEmailFromSender
        ? {
          email: cognito.UserPoolEmail.withSES({
            fromEmail: poolSenderEmail,
            fromName: (this.node.tryGetContext('cognitoEmailFromName') as string) || 'AgentEchelon',
            // The pool and the identity are in this stack's own region; naming it explicitly keeps
            // the reference correct if the pool is ever synthesized from another.
            sesRegion: this.region,
            // ── WHICH IDENTITY SES IS ASKED TO AUTHORIZE AGAINST ──────────────────────────────
            //
            // Without this, CDK scopes the pool's `SourceArn` to the ADDRESS identity
            // (`identity/assistant@example.com`). That is only correct when the deployer verified
            // the ADDRESS. Verifying the DOMAIN is at least as common - it is what covers every
            // address under it - and in that case the address identity does not exist as a verified
            // resource and the send is refused.
            //
            // This is the same distinction `ses-identity.ts` exists for, one layer up: there it
            // decides which ARNs an IAM policy must name, here it decides which one the POOL claims.
            // Both had to be got right independently, and only that file said so.
            //
            // Unset ⇒ CDK's address-identity default, so a deployer who verified the address is
            // unaffected. Set to the verified domain when that is what you verified.
            ...(cognitoEmailVerifiedDomain ? { sesVerifiedDomain: cognitoEmailVerifiedDomain } : {}),
          }),
        }
        : {}),
      userPoolName: `${RES_PREFIX}-users`,
      selfSignUpEnabled: true, // Allow self-registration with admin approval
      signInAliases: {
        email: true,
      },
      // Case-INSENSITIVE usernames/email: `Admin@x.com` and `admin@x.com` resolve to the SAME user,
      // so sign-in never fails on capitalization. Maps to UsernameConfiguration.CaseSensitive=false.
      // IMMUTABLE after pool creation — changing this on an existing pool REPLACES the pool (all users
      // are lost + must be re-provisioned/re-seeded); it applies cleanly only to a fresh deployment.
      signInCaseSensitive: false,
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
        // A PROVIDER'S GROUPS, written only by a provider's attribute mapping at a federated sign-in, and read
        // only from that provider's own ID token (SPEC-CREDENTIAL-EXCHANGE §4b). No client a person signs in
        // with can write it: only `FederatedWebClient` lists it, and its tokens carry no scope that
        // `UpdateUserAttributes` accepts. Cognito's longest custom attribute.
        groups: new cognito.StringAttribute({ mutable: true, maxLen: 2048 }),
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

    // ── THE CLEARANCE GROUPS: THE ADMIN PLANE'S HERE, EVERY OTHER CLASSIFICATION'S IN ITS OWN STACK ─────────
    //
    // A group clears its members for one classification (`groupClearance`, profiles.ts). A conversational
    // classification's groups are built by its `Assistants-<classification>` stack (`clearanceGroups`), with the
    // precedence the classification declares (`groupPrecedence`), so declaring one adds its groups and renumbers
    // none here. The admin plane is part of every deployment and has no stack of its own, so its group
    // (`admins`, or what the deployment names it) is built here, the same way.
    //
    // A fractional precedence is refused by CloudFormation before any resource is touched, as
    // `AWS::EarlyValidation::PropertyValidation` on the change set (measured 2026-09-16), so the declared
    // number is refused at synth unless it is an integer (`validateProfilesConfig`).
    for (const value of profiles.adminPlaneValues()) {
      for (const group of clearanceGroups(this, value, userPool.userPoolId)) {
        group.addDependency(userPool.node.defaultChild as cognito.CfnUserPool);
      }
    }

    // MEMBERSHIP GROUPS (DESIGN-CONVERSATION-TYPES §6): `ops`, which a conversation type adds its people
    // from. Created here so a deployment has it without a hand step, and given NO ROLE: a membership group
    // grants nothing, so it must never take part in choosing a person's role. Its precedence sits after
    // every clearance group's, from a fixed base (`MEMBERSHIP_GROUP_PRECEDENCE_BASE`, above every declared
    // `groupPrecedence`) rather than from how many classifications are declared. Logical id `{name}Group`,
    // matching the clearance groups, so a group that exists keeps its id.
    const membershipGroupNames = Object.keys(profiles.membershipGroups());
    membershipGroupNames.forEach((name, i) => {
      const required = profiles.membershipGroups()[name];
      const groupResource = new cognito.CfnUserPoolGroup(this, `${name}Group`, {
        userPoolId: userPool.userPoolId,
        groupName: name,
        description: `Membership group - its members must already be cleared for ${required}; grants nothing`,
        precedence: MEMBERSHIP_GROUP_PRECEDENCE_BASE + i,
      });
      groupResource.addDependency(userPool.node.defaultChild as cognito.CfnUserPool);
    });


    // Create IAM role for Lambda functions with wildcard permissions to avoid circular dependency
    const lambdaRole = new iam.Role(this, 'CognitoTriggersRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      // NO AMAZON CHIME SDK GRANT. The triggers create no AppInstanceUser: only the credential exchange
      // creates a person (lib/person-identity.ts), at their first sign-in. The Cognito policy is attached
      // AFTER user pool creation to scope it to the pool ARN (see the policy below).
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
      description: 'Sets the approval and clearance attributes of a confirmed sign-up',
      role: lambdaRole,
      logGroup: postConfirmationLogGroup,
      // NO REGISTRY IN ITS ENVIRONMENT: this trigger is `Code.fromAsset` and cannot import the registry, so it reads
      // the deployment's registry rows at runtime (`registry-admission.js`), as every bundled handler does.
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
    const cfnUserPool = userPool.node.defaultChild as cognito.CfnUserPool;
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
            // ListUsers resolves a federated person's `sub` to their pool username (`bySubjectOrUsername`, cognito-pool-directory.ts).
            'cognito-idp:ListUsers',
          ],
          resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${userPool.userPoolId}`],
          effect: iam.Effect.ALLOW,
        }),
      ],
    });

    // Grant Cognito permission to invoke the Lambda functions using L1 construct
    const postConfirmationPermission = new lambda.CfnPermission(this, 'PostConfirmationPermission', {
      action: 'lambda:InvokeFunction',
      functionName: postConfirmationFn.functionArn,
      principal: 'cognito-idp.amazonaws.com',
      sourceArn: userPool.userPoolArn,
    });

    const preAuthenticationPermission = new lambda.CfnPermission(this, 'PreAuthenticationPermission', {
      action: 'lambda:InvokeFunction',
      functionName: preAuthenticationFn.functionArn,
      principal: 'cognito-idp.amazonaws.com',
      sourceArn: userPool.userPoolArn,
    });

    // Hosted-UI callback/logout origins: the real https interface origins (chat +
    // admin), if configured. Localhost is added unconditionally below.
    const oauthOrigins = sharedOrigins(this).filter((o) => o.startsWith('https://'));

    // WHAT A SIGNED-IN USER MAY WRITE ON THEIR OWN PROFILE. With no list, Cognito lets a user rewrite every
    // attribute through UpdateUserAttributes with their own access token. That made `name` self-settable, and
    // the credential exchange copies `name` into the display name every member sees, so a member could take
    // another member's name and have a private `.Name` message resolve to them. It also made
    // `custom:approved` self-settable, which is what the pre-authentication trigger gates sign-in on. So a
    // client writes only what sign-up sends: `email`, and `custom:tier` as a REQUESTED tier (authorization
    // reads groups, which only admins and the post-confirmation trigger set, and the trigger only on a confirmed
    // sign-up: it ran on a password reset too, which let a user write a tier and reset into it). Names are set by
    // admins or the identity provider.
    const selfWritableAttributes = new cognito.ClientAttributes()
      .withStandardAttributes({ email: true })
      .withCustomAttributes('tier');

    // THE PROVIDERS THE CHAT APP OFFERS AT MANAGED LOGIN: the pool's own sign-in, plus every SAML or OIDC
    // provider the trusted-issuer registry declares as federating into this pool (`cognito-federated` on
    // `pool: 'self'`), by the provider name configured on the pool. Derived from the registry, so adding a
    // provider is one registry entry and no client edit.
    const federatedProviders = issuersOf(this).selfFederatedProviders();

    // Create User Pool Client for frontend
    // The pool's own sign-in alone: every federated provider signs in through `FederatedWebClient` below.
    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: 'web-client',
      writeAttributes: selfWritableAttributes,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
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
        // The authorization-code redirect through the pool's managed login (the domain below), beside the
        // password sign-in the Cognito SDK makes (USER_PASSWORD/SRP). Both interface origins are registered
        // so that path works from either app: the chat SPA (appUrl) and the standalone admin console
        // (adminAppUrl). Localhost stays for development. DESIGN-SEPARATE-ADMIN-APP.md.
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

    // THE POOL'S MANAGED LOGIN DOMAIN, which the redirect sign-in (authorization code with PKCE) and a
    // federated provider's sign-in go through. The prefix is the instance name and the account, so two
    // instances, or one instance in two accounts, never ask for the same Cognito domain.
    const managedLoginDomain = userPool.addDomain('ManagedLoginDomain', {
      cognitoDomain: { domainPrefix: `${RES_PREFIX}-${this.account}` },
    });
    new cdk.CfnOutput(this, 'UserPoolDomainUrl', {
      value: managedLoginDomain.baseUrl(),
      description: 'The user pool managed login domain, for the redirect sign-in',
    });

    // THE ADMIN CONSOLE'S OWN APP CLIENT (DESIGN-SEPARATE-ADMIN-APP.md), when `admin` is declared: on the SAME
    // pool as the chat client, a second client and not a second pool. It isolates the admin session from the
    // chat session and scopes its hosted-UI callbacks to the admin origin. It is here, beside the pool, and
    // not in `AdminServices`, because its tokens are an audience the edge authorizer of BOTH APIs checks: the
    // console resolves its person on `PersonApi` before it asks `AdminApi` for a console session. A deployer
    // who prefers reusing the shared client sets `-c adminAppClient=shared`, and the console falls back to
    // VITE_CLIENT_ID.
    let adminClient: cognito.UserPoolClient | undefined;
    if (adminConsoleClient && this.node.tryGetContext('adminAppClient') !== 'shared') {
      const adminOAuthOrigins = [adminOrigin(this)].filter((o) => o.startsWith('https://'));
      adminClient = new cognito.UserPoolClient(this, 'AdminWebClient', {
        userPool,
        userPoolClientName: 'admin-client',
        // A signed-in user writes only what sign-up sends (`selfWritableAttributes` above).
        writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }).withCustomAttributes('tier'),
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
        description: 'Dedicated admin console app-client id - VITE_ADMIN_CLIENT_ID (admin package .env)',
      });
    }
    // THE FEDERATED SIGN-IN'S OWN APP CLIENT (SPEC-CREDENTIAL-EXCHANGE §4b), when the registry federates a
    // provider into this pool. Cognito writes a provider's mapped attributes only through a client that lists
    // them as writable, and a client that lists one lets any holder of its access token rewrite it with
    // UpdateUserAttributes. So the attributes a provider maps (its people's name, address and groups) are
    // writable here and nowhere else, and this client's tokens carry no `aws.cognito.signin.user.admin`, the
    // scope UpdateUserAttributes requires: only the provider writes them. No password, SRP or custom flow: a
    // person reaches this client through their provider alone. Both apps sign in through it.
    let federatedClient: cognito.UserPoolClient | undefined;
    if (federatedProviders.length) {
      const origins = [...new Set([...oauthOrigins, ...[adminOrigin(this)].filter((o) => o.startsWith('https://'))])];
      federatedClient = userPool.addClient('FederatedWebClient', {
        userPoolClientName: 'federated-client',
        authFlows: { userPassword: false, userSrp: false, custom: false },
        writeAttributes: new cognito.ClientAttributes()
          .withStandardAttributes({ email: true, fullname: true, givenName: true, familyName: true })
          .withCustomAttributes('groups'),
        supportedIdentityProviders: federatedProviders.map((name) => cognito.UserPoolClientIdentityProvider.custom(name)),
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
          callbackUrls: ['http://localhost:5173/callback', 'http://localhost:5174/callback', ...origins.map((o) => `${o}/callback`)],
          logoutUrls: ['http://localhost:5173/', 'http://localhost:5174/', ...origins.map((o) => `${o}/`)],
        },
      });
      new cdk.CfnOutput(this, 'UserPoolFederatedClientId', {
        value: federatedClient.userPoolClientId,
        description: 'The app client a federated provider signs in through - VITE_FEDERATED_CLIENT_ID (chat and admin .env)',
      });
    }
    return { userPool, userPoolClient, adminClient, federatedClient };
  }
}
