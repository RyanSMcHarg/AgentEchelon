/**
 * ExperimentsStack (`AgentEchelonExperiments`) — the A/B experiments feature, an
 * independently-deployable stack.
 *
 * Owns:
 *   - The `experiments` DynamoDB table (all-classification A/B DATA — shared, carries no
 *     agent identity, so a shared table is consistent with the separation posture).
 *   - The `admin-experiments` API (`/admin/experiments` GET/POST + `{id}/status`)
 *     behind a Cognito authorizer; the handler additionally requires the `admins`
 *     group. Output `ExperimentsApiUrl` → frontend `VITE_EXPERIMENTS_API_URL`.
 *   - Publishes the shared SSM contract `/agent-echelon/shared/tables/experiments-{arn,name}`
 *     that the per-classification processors/handlers resolve for runtime A/B variant lookup.
 *
 * A deployer who doesn't want A/B experiments can still deploy it (cheap: one
 * on-demand table + one Lambda); battle-enabled experiments additionally require
 * AgentEchelonBattle (the handler resolves the alt-bot roster it publishes).
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { apiAccessLogConfig } from '../constructs/api-access-logging';
import { adminApiMethodOptions, adminAuthEnv } from '../constructs/admin-auth-mode';
import { adminOrigin, sharedOrigins } from '../config/app-origins';
import { personaExecuteApiResources, AdminPersona } from '../config/admin-capabilities';
import { SHARED_SSM, INSTANCE_SSM, SSM_ROOT, STACK_PREFIX } from './agent-classification-common';

export interface ExperimentsStackProps extends cdk.StackProps {
  appInstanceArn: string;
  userPoolId: string;
  /** Frontend URL for CORS (defaults to the `appUrl` context / localhost). */
  appUrl?: string;
  /** A14: the `admins` sign-on role ARN (execute-api teeth on the profile routes under adminIamEnforcement). */
  adminSignOnRoleArn?: string;
  /** A14 personas (opt-in): persona key -> sign-on role ARN. Personas holding manage-profiles get its teeth. */
  adminPersonaRoleArns?: Record<string, string>;
  /**
   * SSM parameter holding the attachments-bucket ARN, which doubles as the profile BODY store
   * (SPEC-PORTABLE-PROFILES, "Bodies are S3"). Resolved at deploy rather than taken as a direct bucket
   * reference, matching how the other consumers of this bucket reach it - a plain-string contract
   * between stacks, so neither takes a dependency on the other's deploy order.
   */
  attachmentsBucketArnParam?: string;
}

export class ExperimentsStack extends cdk.Stack {
  public readonly experimentsTableName: string;
  public readonly experimentsTableArn: string;
  public readonly experimentsApiUrl: string;
  public readonly manageProfilesApiUrl: string;

  constructor(scope: Construct, id: string, props: ExperimentsStackProps) {
    super(scope, id, props);

    const isProduction = this.node.tryGetContext('isProduction') === 'true';
    const dataRemovalPolicy = isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    // Experiments is dual-plane: the admin console does CRUD and the chat client
    // reads a channel's assignment (ChannelMembersPanel), so its API + Lambda
    // trust BOTH origins (admin-experiments.ts echoes the matching request Origin
    // from the comma list). manage-profiles (/admin/profiles) is admin-only.
    // DESIGN-SEPARATE-ADMIN-APP.md.
    const experimentsOrigins = sharedOrigins(this);
    const adminAppUrl = adminOrigin(this);
    // AgentEchelonBattle owns + publishes this roster; admin-experiments only READS it
    // (by name) to denormalize altBotSlotId → altBotSlotArn for battle experiments.
    const altBotRosterParamName = INSTANCE_SSM.altBotSlotsRoster;

    const experimentsTable = new dynamodb.Table(this, 'ExperimentsTable', {
      partitionKey: { name: 'experimentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.experimentsTableName = experimentsTable.tableName;
    this.experimentsTableArn = experimentsTable.tableArn;

    // Shared SSM contract — the per-classification processors/handlers resolve these at
    // deploy time for runtime A/B variant lookup.
    new ssm.StringParameter(this, 'SharedExperimentsArnParam', {
      parameterName: SHARED_SSM.experimentsArn,
      stringValue: experimentsTable.tableArn,
    });
    new ssm.StringParameter(this, 'SharedExperimentsNameParam', {
      parameterName: SHARED_SSM.experimentsName,
      stringValue: experimentsTable.tableName,
    });

    // ── admin-experiments API ──────────────────────────────────────────────
    const adminExperimentsRole = new iam.Role(this, 'AdminExperimentsRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ExperimentsDdb: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // DeleteItem: the DELETE route hard-removes a never-started draft (a test that ran is
              // soft-tombstoned via UpdateItem). Without it the hard-delete path throws AccessDenied → 500.
              actions: ['dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:DeleteItem'],
              resources: [experimentsTable.tableArn],
            }),
          ],
        }),
        RosterSSM: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${altBotRosterParamName}`],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const adminExperimentsFn = new lambdaNodeJs.NodejsFunction(this, 'AdminExperimentsFunction', {
      entry: './lambda/src/admin-experiments.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(20),
      memorySize: 256,
      role: adminExperimentsRole,
      environment: {
        ...adminAuthEnv(this),
        EXPERIMENTS_TABLE: experimentsTable.tableName,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ALT_BOT_SLOTS_ROSTER_PARAM: altBotRosterParamName,
        ALLOWED_ORIGIN: experimentsOrigins.join(','),
        // Battle eligibility is per-profile config now (AssistantProfile.battleEligible), read by
        // experiment-manager.ts via the registry — no longer an ALLOWED_BATTLE_TIERS env var.
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    const api = new apigateway.RestApi(this, 'ExperimentsApi', {
      restApiName: 'AI Agent Experiments API',
      description: 'Admin A/B experiments CRUD',
      defaultCorsPreflightOptions: {
        allowOrigins: experimentsOrigins,
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        // The manage-profiles routes (/admin/profiles) are AWS_IAM (SigV4) under adminIamEnforcement, so
        // the console SIGNS them — the browser preflight must allow the X-Amz-* signing headers or the
        // signed request is CORS-blocked (net::ERR_FAILED → "Failed to fetch"). Experiments' own routes
        // stay Cognito-Bearer; the extra allowed headers are harmless there. Mirrors the analytics API.
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Amz-Security-Token', 'X-Amz-Content-Sha256'],
      },
      deployOptions: {
        throttlingBurstLimit: 50,
        throttlingRateLimit: 25,
        ...apiAccessLogConfig(this, 'ExperimentsApiAccessLogs'),
      },
    });

    // Admin-plane auth mode (ae-cognito default / federated / service) — see
    // docs/ADMIN-INTEGRATION-GUIDE.md. ae-cognito uses a Cognito authorizer on AE's own pool.
    const experimentsAuthOptions = adminApiMethodOptions(this, 'ExperimentsAuthorizer', {
      userPoolId: props.userPoolId,
    });

    const integration = new apigateway.LambdaIntegration(adminExperimentsFn);
    const adminRoot = api.root.addResource('admin');
    const experimentsResource = adminRoot.addResource('experiments');
    for (const m of ['GET', 'POST']) {
      experimentsResource.addMethod(m, integration, experimentsAuthOptions);
    }
    const experimentIdResource = experimentsResource.addResource('{experimentId}');
    // POST /admin/experiments/{id}/status — lifecycle transitions (pause/resume/complete + decision).
    experimentIdResource.addResource('status').addMethod('POST', integration, experimentsAuthOptions);
    // DELETE /admin/experiments/{id} — hard-remove a never-started draft, else soft-tombstone a test
    // that ran (the handler decides the mode); frees the classification. Same admin authorizer.
    experimentIdResource.addMethod('DELETE', integration, experimentsAuthOptions);

    this.experimentsApiUrl = `${api.url}admin/experiments`;

    // ── manage-profiles API (SPEC-PORTABLE-PROFILES P1/P3) ────────────
    // The versioning + import/export lifecycle for assistant profiles, on the SAME admin API (no new
    // gateway, §3). This role is the ONLY sanctioned WRITE path to the profile SSM namespace (§7): the
    // async-processor role stays read-only on /assistant/*; here we grant read + write + label, scoped
    // to this instance's assistant namespace. The handler additionally gates on the `manage-profiles`
    // capability (distinct from view-*, A14).
    // The profile BODY store: personas live in S3 under `profiles/*` and the SSM definition carries a
    // pointer, so a persona is bounded by MAX_PERSONA_LENGTH rather than by the 4096-character
    // parameter (SPEC-PORTABLE-PROFILES, "Bodies are S3"). Same bucket as attachments, separate prefix.
    const profileBodyBucketArn = props.attachmentsBucketArnParam
      ? ssm.StringParameter.valueForStringParameter(this, props.attachmentsBucketArnParam)
      : undefined;
    const profileBodyBucketName = profileBodyBucketArn
      ? cdk.Fn.select(5, cdk.Fn.split(':', profileBodyBucketArn))
      : undefined;

    const manageProfilesRole = new iam.Role(this, 'ManageProfilesRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ProfileDefinitionsSSM: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter', 'ssm:GetParameterHistory', 'ssm:PutParameter', 'ssm:LabelParameterVersion'],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*`],
            }),
            // A definition and its bodies are ONE artifact, so this role is the only sanctioned writer to
            // both - the same rule the SSM namespace already follows (§7). A second writer to either half
            // would be a second source of truth. GetObject is needed too, not just Put: editing a draft,
            // cloning the active version and exporting all read the persona back.
            ...(profileBodyBucketArn ? [new iam.PolicyStatement({
              actions: ['s3:PutObject', 's3:GetObject'],
              resources: [`${profileBodyBucketArn}/profiles/*`],
            })] : []),
            // Read-only: the shared channel-flow ARN param (classification-level infra deep link). It lives
            // outside /assistant/*, so it needs its own read grant.
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/channel-flow-arn`],
            }),
            // Read-only: resolve each profile's live processor and router Lambda config (its execution
            // role + the GUARDRAIL_ID it applies) so the admin console can deep-link to the actual
            // guardrail / IAM role / function for troubleshooting (`lib/profile-infra.ts`).
            //
            // SCOPED TO THIS DEPLOYMENT. This previously read `function:*`, which in a
            // MULTI-PRODUCT account granted a read of every other product's Lambdas. "Metadata-only" is
            // not harmless here: `GetFunctionConfiguration` returns `Environment.Variables`, so the grant
            // exposed the table names, ARNs and configuration of every unrelated function in the account.
            //
            // Weaker than the row 96 invoke over-grant in one respect, and worth stating: the holder is
            // admin-gated, so reaching it already requires the admin plane. It amplifies an admin
            // compromise rather than opening a new front door.
            //
            // Every legitimate target is our own: `profile-infra.ts` resolves the ARNs from this
            // deployment's own SSM parameters (`{SSM_ROOT}/assistant/{profile}/processor-arn` and
            // `/router-arn`), which name the classification stacks' functions. The read is best-effort
            // and drops a console link rather than failing, so a future function outside this prefix
            // degrades a deep link instead of breaking the list.
            new iam.PolicyStatement({
              actions: ['lambda:GetFunctionConfiguration'],
              resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${STACK_PREFIX}*`],
            }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    const manageProfilesFn = new lambdaNodeJs.NodejsFunction(this, 'ManageProfilesFunction', {
      entry: './lambda/src/manage-profiles.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(20),
      memorySize: 256,
      role: manageProfilesRole,
      environment: {
        ...adminAuthEnv(this),
        SSM_ROOT,
        AWS_ACCOUNT_ID: this.account,
        ALLOWED_ORIGIN: adminAppUrl,
        // Without this the lifecycle keeps personas INLINE and silently re-imposes the 4096-character
        // definition cap - the grant above would be present and unused, which is the shape a synth
        // assertion exists to catch (profile-body-store-grant.test.ts).
        ...(profileBodyBucketName ? { PROFILE_BODY_BUCKET: profileBodyBucketName } : {}),
        // MANAGE_PROFILES_GROUP_NAMES (optional) narrows who holds the capability; defaults to admins.
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    // A14 (DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md): manage-profiles is an
    // IAM-enforceable capability. Under adminIamEnforcement the profile routes are
    // AWS_IAM-authorized (the console SigV4-signs) and the `admins` sign-on role
    // gets execute-api teeth on them; a finer role that omits manage-profiles is
    // denied at the gateway. Only the /admin/profiles routes flip — /admin/experiments
    // stays on the Cognito authorizer. Default ON; opt out with `-c adminIamEnforcement=false`.
    const adminIamEnforcement = this.node.tryGetContext('adminIamEnforcement') !== false
      && this.node.tryGetContext('adminIamEnforcement') !== 'false';
    const manageProfilesAuthOptions: apigateway.MethodOptions = adminIamEnforcement
      ? { authorizationType: apigateway.AuthorizationType.IAM }
      : experimentsAuthOptions;
    if (adminIamEnforcement) {
      manageProfilesFn.addEnvironment('ADMIN_IAM_ENFORCEMENT', 'true');
    }

    const manageProfilesIntegration = new apigateway.LambdaIntegration(manageProfilesFn);
    const profilesResource = adminRoot.addResource('profiles');
    profilesResource.addMethod('GET', manageProfilesIntegration, manageProfilesAuthOptions); // list
    for (const action of ['version', 'draft', 'validate', 'activate', 'rollback', 'export', 'import']) {
      profilesResource.addResource(action).addMethod('POST', manageProfilesIntegration, manageProfilesAuthOptions);
    }
    this.manageProfilesApiUrl = `${api.url}admin/profiles`;

    const profileTeeth = [
      api.arnForExecuteApi('GET', '/admin/profiles'),
      api.arnForExecuteApi('POST', '/admin/profiles/*'),
    ];
    if (adminIamEnforcement && props.adminSignOnRoleArn) {
      const adminRole = iam.Role.fromRoleArn(this, 'ImportedAdminSignOnRole', props.adminSignOnRoleArn, { mutable: true });
      adminRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['execute-api:Invoke'], resources: profileTeeth }));
    }
    // A14 persona teeth: a persona that holds manage-profiles (platform-admin,
    // platform-dev, ai-dev) gets execute-api on the profile routes; a manager role
    // (no manage-profiles) is denied at the gateway.
    if (adminIamEnforcement && props.adminPersonaRoleArns) {
      for (const [persona, roleArn] of Object.entries(props.adminPersonaRoleArns)) {
        if (!personaExecuteApiResources(persona as AdminPersona, 'experiments').length) continue;
        iam.Role.fromRoleArn(this, `ImportedPersonaRole-${persona}`, roleArn, { mutable: true })
          .addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['execute-api:Invoke'], resources: profileTeeth }));
      }
    }
    new cdk.CfnOutput(this, 'ManageProfilesApiUrl', {
      value: this.manageProfilesApiUrl,
      description: 'Profile versioning admin API (VITE_MANAGE_PROFILES_API_URL)',
      exportName: `${this.stackName}-ManageProfilesApiUrl`,
    });

    new cdk.CfnOutput(this, 'ExperimentsApiUrl', {
      value: this.experimentsApiUrl,
      description: 'Experiments admin API URL (frontend Experiments tab — VITE_EXPERIMENTS_API_URL)',
      exportName: `${this.stackName}-ExperimentsApiUrl`,
    });
    new cdk.CfnOutput(this, 'ExperimentsTableName', {
      value: experimentsTable.tableName,
      description: 'DynamoDB table for A/B test experiments',
    });

    cdk.Tags.of(this).add('Component', 'Experiments');
  }
}
