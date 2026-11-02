/**
 * ASSISTANT ADMINISTRATION: profiles, ownership, the runtime roster, and (with `experiments`) experiment
 * administration. Part of the `AdminServices` stack, its routes on `AdminApi` behind IAM (`assistant-admin` in
 * the capability catalog), as a nested stack of it: one deployable unit, whose resources count against
 * their own template's limit rather than the parent's.
 *
 * PROFILES ARE ADMINISTRATION, NOT AN EXPERIMENT. Versioning, activating and rolling back a profile, an
 * assistant's owning team and the runtime roster exist whenever `admin` is declared; the experiment routes
 * join them only when `experiments` is declared, on the Experiments stack's table by reference. A
 * deployment with `admin` and no `experiments` manages its assistants and runs no experiment.
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { createHash } from 'crypto';
import { Construct } from 'constructs';
import { adminAuthEnv } from './admin-auth-mode';
import { adminOrigin } from '../config/app-origins';
import { adminRoute } from './admin-role-grants';
import { grantAssistantScopeCheck } from './assistant-scope-grants';
import { CLASSIFICATION_PACK_PREFIX } from '../../lambda/src/lib/profile-bodies';
import { TEMPLATES_PREFIX } from '../../lambda/src/lib/template-store';
import type { RouteMethod, RouteSpec } from './http-api';
import {
  SSM_ROOT, STACK_PREFIX, ASSISTANT_OWNERSHIP_FUNCTION_NAME, ASSISTANT_PROVISIONER_FUNCTION_NAME, OWNER_TEAM_TAG,
  assistantRolePath, alertEmitterWiring,
} from '../stacks/agent-classification-common';
import { invokeTheProvisioner, claimWriteFor } from './assistant-provisioner';
import { defaultProfileRegistry } from '../profile-registry';
import { goldenRunInvoke, CLASSIFIER_REPLAY_PARAM_ROOT } from './classification-archive-functions';

export interface AdminAssistantAdministrationProps extends cdk.NestedStackProps {
  appInstanceArn: string;
  userPoolId: string;
  /** The Identity stack's table, by reference, for the team-scope check (`grantAssistantScopeCheck`). */
  identities?: { tableName: string; tableArn: string };
  /**
   * The attachments bucket ARN, which doubles as the profile BODY store (SPEC-PORTABLE-PROFILES, "Bodies
   * are S3"). A construct reference from the Conversations stack.
   */
  attachmentsBucketArn: string;
  /** The Experiments stack's table, when `experiments` is declared. Absent: no experiment routes. */
  experimentsTable?: dynamodb.ITable;
}

export class AdminAssistantAdministration extends cdk.NestedStack {
  /** The profile, ownership, roster and experiment routes, on `AdminApi`. */
  public readonly routes: RouteSpec[] = [];

  constructor(scope: Construct, id: string, props: AdminAssistantAdministrationProps) {
    super(scope, id, { description: props.description });
    const stack = cdk.Stack.of(this);
    const region = stack.region;
    const account = stack.account;
    const adminAppUrl = adminOrigin(this);
    const experimentsTable = props.experimentsTable;

    // Every route is AWS_IAM (SigV4): the console signs them, and a role is refused at the gateway on a
    // capability it does not hold.
    const route = (method: RouteMethod, path: string, handler: lambda.IFunction, capability = 'admin'): void => {
      this.routes.push(adminRoute('assistant-admin', method, path, handler, { capability }));
    };

    // ── manage-profiles (SPEC-PORTABLE-PROFILES P1/P3) ─────────────────────────────────────────────
    //
    // The versioning + import/export lifecycle for assistant profiles. This role is the ONLY sanctioned
    // WRITE path to the profile SSM namespace (§7): the async-processor role stays read-only on
    // /assistant/*; here we grant read + write + label, scoped to this instance's assistant namespace.
    // The profile BODY store: personas live in S3 under `profiles/*` and the SSM definition carries a
    // pointer, so a persona is bounded by MAX_PERSONA_LENGTH rather than by the 4096-character parameter.
    const profileBodyBucketArn = props.attachmentsBucketArn;
    const profileBodyBucketName = cdk.Fn.select(5, cdk.Fn.split(':', profileBodyBucketArn));
    const manageProfilesRole = new iam.Role(this, 'ManageProfilesRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ProfileDefinitionsSSM: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter', 'ssm:GetParameterHistory', 'ssm:PutParameter', 'ssm:LabelParameterVersion'],
              resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant/*`],
            }),
            // Activation consumes the draft it promoted. Delete is scoped to DRAFTS ONLY: a definition
            // parameter is the served version history, and deleting it would erase every rollback target.
            new iam.PolicyStatement({
              actions: ['ssm:DeleteParameter'],
              resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant/*/draft`],
            }),
            // A definition and its bodies are ONE artifact, so this role is the only sanctioned writer to
            // both. GetObject too: editing a draft, cloning the active version and exporting all read back.
            new iam.PolicyStatement({
              actions: ['s3:PutObject', 's3:GetObject'],
              resources: [`${profileBodyBucketArn}/profiles/*`],
            }),
            // An upload's checked entries, handed to the classification's GoldenRun function as an object rather than in
            // the event, whose record its async destination repeats (ADR-065 decision 7). Write only.
            new iam.PolicyStatement({
              actions: ['s3:PutObject'],
              resources: [`${profileBodyBucketArn}/golden-uploads/*`],
            }),
            // READ-ONLY on every classification's pack body: a version's routes and workflow selection
            // are checked against its classification's pack, whose parameter holds a pointer. The pack's
            // writer is that classification's deploy, never this role.
            new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: [`${profileBodyBucketArn}/${CLASSIFICATION_PACK_PREFIX}/*`],
            }),
            // READ-ONLY on each classification's template pointers, so an assistant's page lists the
            // templates its classification holds and the version each points at. The writer is the
            // operator's `npm run template`, never this role.
            new iam.PolicyStatement({
              actions: ['ssm:GetParametersByPath'],
              resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant/*/templates`],
            }),
            // Read-only: the shared channel-flow ARN param (classification-level infra deep link).
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/channel-flow-arn`],
            }),
            // Read-only: each profile's live processor and router configuration, so the console can deep-link
            // to the guardrail, role and function (`lib/profile-infra.ts`). SCOPED TO THIS DEPLOYMENT:
            // `GetFunctionConfiguration` returns the environment, so `function:*` would expose every
            // unrelated function's configuration in a multi-product account.
            new iam.PolicyStatement({
              actions: ['lambda:GetFunctionConfiguration'],
              resources: [`arn:aws:lambda:${region}:${account}:function:${STACK_PREFIX}*`],
            }),
            // ── FINDING A RUNTIME ASSISTANT BY NAME, READ ONLY (ADR-048) ─────────────────────────
            new iam.PolicyStatement({
              sid: 'FindARuntimeAssistantByName',
              actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
              resources: [
                `arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant-directory`,
                `arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant-directory/*`,
                `arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant-assignments/*/*/assistants/*`,
              ],
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
        ADMIN_IAM_ENFORCEMENT: 'true',
        SSM_ROOT,
        AWS_ACCOUNT_ID: account,
        ALLOWED_ORIGIN: adminAppUrl,
        // Without this the lifecycle keeps personas INLINE and silently re-imposes the 4096-character
        // definition cap (profile-body-store-grant.test.ts).
        PROFILE_BODY_BUCKET: profileBodyBucketName,
        // The experiment a variant-version candidate is derived for, when experiments are declared.
        ...(experimentsTable ? { EXPERIMENTS_TABLE: experimentsTable.tableName } : {}),
        // WHETHER AN IDLE ASSISTANT TAKES UP ITS TASKS HERE (ADR-063 decision H1): a version whose workflow assigns work to
        // an assistant validates with a warning where the turn queue is off. The same context flag the runtime reads.
        TURN_QUEUE_ENABLED: ((f) => (f === true || f === 'true' ? '1' : '0'))(this.node.tryGetContext('turnQueue')),
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    grantAssistantScopeCheck(manageProfilesFn, props.appInstanceArn, props.userPoolId, props.identities);
    // A DRAFT ANSWERS THE GOLDEN SET BEFORE IT IS ACTIVATED (ADR-065): start a run on the draft's classification's
    // GoldenRun function, and read the latest run for the draft at Activate and when the console opens it.
    for (const st of goldenRunInvoke(cdk.Stack.of(this))) manageProfilesFn.addToRolePolicy(st);
    manageProfilesFn.addEnvironment('GOLDEN_RUN_PARAM_ROOT', CLASSIFIER_REPLAY_PARAM_ROOT);
    // An activation past the gate is announced in the admin channel, as an `ae.alert` on the default bus.
    const alerts = alertEmitterWiring(this);
    for (const [k, v] of Object.entries(alerts.env)) manageProfilesFn.addEnvironment(k, v);
    alerts.grant(manageProfilesRole);
    // ── WHERE AN ASSISTANT LIVES, READ ONLY (`lib/profile-infra.ts`) ─────────────────────────────
    //
    // The console's links name the live resource rather than a list page: the identity's Lex alias, the
    // alias's conversation log group, the acting role's boundary, and the channel flow's own processor.
    // Each is a describe on this deployment's own resources; none changes anything.
    manageProfilesFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadAnAssistantsIdentityAndFlow',
      actions: ['chime:DescribeAppInstanceBot', 'chime:DescribeChannelFlow'],
      resources: [`${props.appInstanceArn}/bot/*`, `${props.appInstanceArn}/channel-flow/*`],
    }));
    manageProfilesFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadAnAssistantsLexAlias',
      actions: ['lex:DescribeBotAlias'],
      resources: [`arn:aws:lex:${region}:${account}:bot-alias/*`],
    }));
    manageProfilesFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadTheActingRolesBoundary',
      actions: ['iam:GetRole'],
      resources: [`arn:aws:iam::${account}:role${assistantRolePath()}*`],
    }));

    // ── EVERY ASSISTANT'S RENAME REACHES ITS IDENTITY, THROUGH ONE APPLIER ─────────────────────────────
    //
    // A display name rides a profile version. Only `UpdateAppInstanceBot` changes the bot's name, and it takes
    // the bot's whole Lex configuration, so `manage-profiles` invokes a function that takes a name and nothing
    // else. Every identity is the provisioner's (ADR-048, amended 2026-10-23), so this one applier serves every
    // assistant, declared, created in the console, or a duel's alt: it finds the identity through the directory
    // entry the provisioner writes, and IAM reaches only identities stamped `provisioner = runtime`. It
    // re-sends the configuration the identity already has.
    const runtimeNameApplier = new lambdaNodeJs.NodejsFunction(this, 'RuntimeApplyAssistantNameFunction', {
      entry: './lambda/src/apply-assistant-name.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { SSM_ROOT },
      bundling: { minify: false, forceDockerBundling: false },
    });
    runtimeNameApplier.addToRolePolicy(new iam.PolicyStatement({
      sid: 'FindARuntimeAssistantsIdentity',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant-directory/*`],
    }));
    runtimeNameApplier.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RenameRuntimeAssistantsOnly',
      actions: ['chime:DescribeAppInstanceBot', 'chime:UpdateAppInstanceBot'],
      resources: [`${props.appInstanceArn}/bot/*`],
      conditions: { StringEquals: { 'aws:ResourceTag/provisioner': 'runtime' } },
    }));
    runtimeNameApplier.grantInvoke(manageProfilesRole);
    manageProfilesFn.addEnvironment('RUNTIME_NAME_APPLIER_ARN', runtimeNameApplier.functionArn);
    // `variant-version` publishes the UNLABELLED candidate a battle variant runs (§3.7): an experiment's,
    // so it exists with the experiments.
    // `preview-run` walks one draft workflow with sample values and writes nothing (ADR-061 decision 7).
    // `discard` deletes the draft the caller saw, by its configId (SPEC-PORTABLE-PROFILES FR18).
    // `golden-run` starts a draft's run against the golden set and `golden-gate` reads its result (ADR-065).
    // `golden-set-import` adds a deployment's own entries and `golden-set-retire-upload` retires one upload (decision 7);
    // `golden-set-generate` writes entries from the draft's intent pack and `golden-set-retire-generation` retires one (decision 8).
    const profileActions = ['version', 'draft', 'validate', 'preview-run', 'activate', 'rollback', 'export', 'import', 'discard', 'golden-run', 'golden-gate', 'golden-set-import', 'golden-set-retire-upload', 'golden-set-generate', 'golden-set-retire-generation', 'golden-set-batch'];
    route('GET', '/admin/profiles', manageProfilesFn);
    for (const action of profileActions) route('POST', `/admin/profiles/${action}`, manageProfilesFn);
    if (experimentsTable) route('POST', '/admin/profiles/variant-version', manageProfilesFn, 'experiments');
    // ACTIVATING PAST THE GOLDEN GATE (ADR-065 decision 5): the admin route only. It is not in `profileActions`, so no team
    // route names it.
    route('POST', '/admin/profiles/activate-past-golden-gate', manageProfilesFn);
    // TEAM ROUTES: ONE ASSISTANT IN THE PATH (SPEC-ADMIN-CONSOLE FR48, FR50), so a team member's console
    // session can name exactly the assistants their team owns and IAM refuses the rest.
    route('GET', '/admin/assistants/{assistant}/profiles', manageProfilesFn);
    for (const action of profileActions) route('POST', `/admin/assistants/{assistant}/profiles/${action}`, manageProfilesFn);
    if (experimentsTable) route('POST', '/admin/assistants/{assistant}/profiles/variant-version', manageProfilesFn, 'experiments');

    // ── AN ASSISTANT'S OWN MESSAGE TEMPLATES (ADR-062 decision 2) ──────────────────────────────────
    //
    // The console's writer of `templates/<classification>/_assistants/<assistant>/` and its pointers, and of
    // nothing else under `templates/`: the classification's family is the operator's (`npm run template`) and
    // the `_shipped` family the platform's. Reads reach every family, so the console shows what the
    // classification and the platform say beside the assistant's own. Which assistant is written is the
    // route's, checked against the caller's team (`requireOwnedAssistant`) behind the session that names only
    // owned assistants.
    const messageTemplatesFn = new lambdaNodeJs.NodejsFunction(this, 'ManageMessageTemplatesFunction', {
      entry: './lambda/src/manage-message-templates.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(20),
      memorySize: 256,
      environment: {
        ...adminAuthEnv(this),
        ADMIN_IAM_ENFORCEMENT: 'true',
        SSM_ROOT,
        ALLOWED_ORIGIN: adminAppUrl,
        TEMPLATE_BUCKET: profileBodyBucketName,
        APP_INSTANCE_ARN: props.appInstanceArn,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    grantAssistantScopeCheck(messageTemplatesFn, props.appInstanceArn, props.userPoolId, props.identities);
    messageTemplatesFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'WriteAnAssistantsOwnTemplates',
      actions: ['s3:PutObject'],
      resources: [`${profileBodyBucketArn}/${TEMPLATES_PREFIX}/*/_assistants/*`],
    }));
    messageTemplatesFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ActivateAnAssistantsOwnTemplates',
      actions: ['ssm:PutParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant/*/templates/_assistants/*`],
    }));
    messageTemplatesFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadEveryFamilysTemplates',
      actions: ['s3:GetObject'],
      resources: [`${profileBodyBucketArn}/${TEMPLATES_PREFIX}/*`],
    }));
    messageTemplatesFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ListEveryFamilysTemplates',
      actions: ['s3:ListBucket'],
      resources: [profileBodyBucketArn],
      conditions: { StringLike: { 's3:prefix': [`${TEMPLATES_PREFIX}/*`] } },
    }));
    messageTemplatesFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadEveryFamilysPointers',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant/*/templates/*`],
    }));
    // A VERSION'S `messages` NAMES TEMPLATES IN THE ASSISTANT'S FAMILY, and validation reads each to check it is
    // there and fits (`messageTemplateErrors`). Read-only; its pointers are under `/assistant/*`, already read.
    manageProfilesRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadTheTemplatesAVersionNames',
      actions: ['s3:GetObject'],
      resources: [`${profileBodyBucketArn}/${TEMPLATES_PREFIX}/*`],
    }));
    // `manage-profiles` writes `/assistant/*` for versions; a template's pointer is not a version, so that
    // role is refused every template pointer and the assistant's family has this one writer.
    manageProfilesRole.addToPolicy(new iam.PolicyStatement({
      sid: 'NoTemplatePointerWrites',
      effect: iam.Effect.DENY,
      actions: ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:LabelParameterVersion'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant/*/templates/*`],
    }));
    route('GET', '/admin/templates', messageTemplatesFn);
    route('POST', '/admin/templates/save', messageTemplatesFn);
    route('POST', '/admin/templates/rollback', messageTemplatesFn);
    route('GET', '/admin/assistants/{assistant}/templates', messageTemplatesFn);
    route('POST', '/admin/assistants/{assistant}/templates/save', messageTemplatesFn);
    route('POST', '/admin/assistants/{assistant}/templates/rollback', messageTemplatesFn);

    // ── ASSISTANT OWNERSHIP (SPEC-ADMIN-CONSOLE FR47, `manage-ownership`) ─────────────────────────
    //
    // The one principal permitted to write an assistant's `owner-team` tag. Its TagResource grant is
    // limited to that key, and every other TagResource grant in the deployment excludes it.
    const ownershipRole = new iam.Role(this, 'AssistantOwnershipRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      inlinePolicies: {
        Ownership: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // Authorized against the bots, not the app instance (measured: refused on the app instance alone).
              actions: ['chime:ListAppInstanceBots'],
              resources: [props.appInstanceArn, `${props.appInstanceArn}/bot/*`],
            }),
            new iam.PolicyStatement({
              actions: ['chime:ListTagsForResource'],
              resources: [`${props.appInstanceArn}/bot/*`],
            }),
            new iam.PolicyStatement({
              sid: 'OwnerTeamTagOnly',
              actions: ['chime:TagResource', 'chime:UntagResource'],
              resources: [`${props.appInstanceArn}/bot/*`],
              conditions: { 'ForAllValues:StringEquals': { 'aws:TagKeys': [OWNER_TEAM_TAG] } },
            }),
            // A runtime assistant's declared team is on its assignment record (ADR-048). Read only.
            new iam.PolicyStatement({
              sid: 'ReadARuntimeAssistantsDeclaredTeam',
              actions: ['ssm:GetParameter'],
              resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant-assignments/*/*/assistants/*`],
            }),
            // The teams are this deployment's own pool's groups, when it has one (L15).
            ...(props.userPoolId ? [new iam.PolicyStatement({
              actions: ['cognito-idp:ListGroups', 'cognito-idp:GetGroup'],
              resources: [`arn:aws:cognito-idp:${region}:${account}:userpool/${props.userPoolId}`],
            })] : []),
          ],
        }),
      },
    });
    const ownershipFn = new lambdaNodeJs.NodejsFunction(this, 'AssistantOwnershipFunction', {
      functionName: ASSISTANT_OWNERSHIP_FUNCTION_NAME,
      entry: './lambda/src/assistant-ownership.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      role: ownershipRole,
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        USER_POOL_ID: props.userPoolId,
        ALLOWED_ORIGIN: adminAppUrl,
        SSM_ROOT,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    route('GET', '/admin/ownership', ownershipFn);
    route('POST', '/admin/ownership', ownershipFn);
    // A TEAM MOVES AN ASSISTANT IT OWNS TO ANOTHER OF ITS OWN TEAMS, on that assistant's route; the handler
    // re-reads ownership and the caller's groups (`requireOwnedAssistant`), so it reads both.
    route('POST', '/admin/assistants/{assistant}/ownership', ownershipFn);
    grantAssistantScopeCheck(ownershipFn, props.appInstanceArn, props.userPoolId, props.identities);

    // SEEDED ON EVERY CHANGE TO WHAT THE PROFILES DECLARE. A bot provisioned before this function existed
    // has no owner; this copies each declared `ownerTeam` onto a bot that has none and never overwrites
    // one. A bot created later is seeded as it is built (by the provisioner for a declared one, by `manage-assistants` for the console's).
    const declaredOwners = defaultProfileRegistry.profileNames().map((n) => defaultProfileRegistry.profileByName(n)!)
      .filter((p) => p.ownerTeam)
      .map((p) => `${p.name}=${p.ownerTeam}`)
      .sort()
      .join(',');
    const seedCall: cr.AwsSdkCall = {
      service: 'Lambda',
      action: 'invoke',
      parameters: { FunctionName: ownershipFn.functionName, Payload: JSON.stringify({ op: 'seed' }) },
      physicalResourceId: cr.PhysicalResourceId.of(`owners-${createHash('sha256').update(declaredOwners).digest('hex').slice(0, 16)}`),
    };
    new cr.AwsCustomResource(this, 'SeedAssistantOwnership', {
      onCreate: seedCall,
      onUpdate: seedCall,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [ownershipFn.functionArn] }),
      ]),
      installLatestAwsSdk: false,
    });

    // ── RUNTIME ASSISTANTS (ADR-048, `manage-assistants`) ─────────────────────────────────────────
    //
    // Creates an assistant without a deploy: an Amazon Lex bot of its own, a tagged identity and an
    // assignment record. It mints no boundary: the assistant acts through its classification's acting role
    // (ADR-054). Administration is cross-classification and the runtime bots it reaches hold no conversation data.
    //
    // ONE PRINCIPAL BUILDS AND RETIRES EVERY ASSISTANT (ADR-048, amended 2026-10-24): the provisioner, in the core
    // (`lib/constructs/assistant-provisioner.ts`), on a session of `RuntimeAssistantProvisionerRole` tagged with the
    // classification. This function validates a create, takes the name and writes the directory entry and the
    // assignment record, and asks the provisioner for the identity work (`op: 'build'`, `op: 'remove'`); its role
    // holds that invoke and the console's claim path, which proves each request is the console's
    // (`lambda/src/lib/provisioner-claim.ts`), and no identity, Amazon Lex or session-role grant.
    //
    // THE DEPLOYMENT'S OWN CLASSIFICATIONS ONLY, by the handler (`createErrors`), and again by the provisioner,
    // which builds only a console entry at a conversational classification other than the admin plane: an outside
    // classification (the guest's) is served by the assistant its stack declares, and adding a runtime assistant to
    // anonymous visitors' conversations is **NOT BUILT**.
    const ssmArn = (p: string) => `arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/${p}`;
    const manageAssistantsRole = new iam.Role(this, 'ManageAssistantsRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      inlinePolicies: {
        ProvisionRuntimeAssistants: new iam.PolicyDocument({
          statements: [
            // THE NAME LOCK AND THE RECORD, and nothing else under either tree. A declared assistant's records
            // (`.../alt`, and its own under `assistants/`) are written by the provisioner.
            new iam.PolicyStatement({
              sid: 'WriteTheDirectoryAndRuntimeRecordsOnly',
              actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
              resources: [ssmArn('assistant-directory/*'), ssmArn('assistant-assignments/*/*/assistants/*')],
            }),
            // A team's own listing reads the directory by path.
            new iam.PolicyStatement({
              sid: 'ListTheDirectory',
              actions: ['ssm:GetParametersByPath'],
              resources: [ssmArn('assistant-directory')],
            }),
            new iam.PolicyStatement({
              sid: 'ReadTheAssignmentRecords',
              actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
              resources: [ssmArn('assistant-assignments/*')],
            }),
            // THE PROVISIONER builds and removes the identity and its Amazon Lex bot; this role asks it.
            invokeTheProvisioner(this, 'AskTheProvisioner'),
            // AND PROVES EACH REQUEST IS THE CONSOLE'S, with a claim under the console's path, which no other role may write.
            claimWriteFor(this, 'console'),
            // The ownership function seeds a new assistant's owner, and answers whether a team route's caller
            // is in its team: it holds the directory reads, so this role holds none.
            new iam.PolicyStatement({
              sid: 'AskTheOwnershipFunction',
              actions: ['lambda:InvokeFunction'],
              resources: [ownershipFn.functionArn],
            }),
            // A NEW ASSISTANT'S FIRST DRAFT is written by `manage-profiles`, the one writer of the profile
            // namespace (SPEC-PORTABLE-PROFILES §7): this role asks it, naming the assistant and nothing else,
            // and holds no write under `/assistant/*` itself.
            new iam.PolicyStatement({
              sid: 'AskForTheFirstDraft',
              actions: ['lambda:InvokeFunction'],
              resources: [manageProfilesFn.functionArn],
            }),
            // The names assistants show, for a create's uniqueness check: an active version may have renamed
            // one. Read only, the definitions alone.
            new iam.PolicyStatement({
              sid: 'ReadTheNamesVersionsShow',
              actions: ['ssm:GetParameter'],
              resources: [ssmArn('assistant/*/definition')],
            }),
          ],
        }),
      },
    });
    const manageAssistantsFn = new lambdaNodeJs.NodejsFunction(this, 'ManageAssistantsFunction', {
      entry: './lambda/src/manage-assistants.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // The API half answers in a second; the build half waits on the provisioner, which waits on Amazon Lex.
      timeout: cdk.Duration.minutes(10),
      memorySize: 256,
      role: manageAssistantsRole,
      environment: {
        ...adminAuthEnv(this),
        SSM_ROOT,
        AWS_ACCOUNT_ID: account,
        ALLOWED_ORIGIN: adminAppUrl,
        APP_INSTANCE_ARN: props.appInstanceArn,
        PROVISIONER_FUNCTION_NAME: ASSISTANT_PROVISIONER_FUNCTION_NAME,
        OWNERSHIP_FUNCTION_NAME: ownershipFn.functionName,
        MANAGE_PROFILES_FUNCTION_NAME: manageProfilesFn.functionName,
        ADMIN_IAM_ENFORCEMENT: 'true',
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    // THE BUILD IS NEVER RETRIED AND NEVER STARTS LATE: a retry would race the remains of the first.
    manageAssistantsFn.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: cdk.Duration.minutes(5) });
    // The build runs asynchronously in this same function. A separate policy rather than the role's own,
    // so the function does not depend on a policy that names it.
    new iam.Policy(this, 'ManageAssistantsHandsOffItsBuild', {
      roles: [manageAssistantsRole],
      statements: [new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [manageAssistantsFn.functionArn] })],
    });
    route('POST', '/admin/roster', manageAssistantsFn);
    route('POST', '/admin/roster/{assistantId}/retire', manageAssistantsFn);
    route('POST', '/admin/roster/{assistantId}/limits', manageAssistantsFn);
    // A TEAM CREATES FOR ITSELF on its own route, and lists what it created. The handler re-checks the
    // caller's groups by asking the ownership function (`op: 'in-team'`) and lists its own directory
    // entries, so this role holds no identity read: every build is the provisioner's.
    route('GET', '/admin/teams/{team}/roster', manageAssistantsFn);
    route('POST', '/admin/teams/{team}/roster', manageAssistantsFn);
    route('POST', '/admin/teams/{team}/roster/{assistantId}/limits', manageAssistantsFn);

    // ── EXPERIMENT ADMINISTRATION, ONLY WITH THE `experiments` CAPABILITY ──────────────────────────
    if (experimentsTable) {
      this.experimentRoutes(route, experimentsTable, manageProfilesFn, props, adminAppUrl);
    }
  }

  private experimentRoutes(
    route: (method: RouteMethod, path: string, handler: lambda.IFunction, capability?: string) => void,
    experimentsTable: dynamodb.ITable,
    manageProfilesFn: lambda.Function,
    props: AdminAssistantAdministrationProps,
    adminAppUrl: string,
  ): void {
    const stack = cdk.Stack.of(this);
    const region = stack.region;
    const account = stack.account;
    const adminExperimentsRole = new iam.Role(this, 'AdminExperimentsRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ExperimentsDdb: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // DeleteItem: the DELETE route hard-removes a never-started draft (a test that ran is
              // soft-tombstoned via UpdateItem).
              actions: ['dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:DeleteItem'],
              resources: [experimentsTable.tableArn],
            }),
          ],
        }),
        AltAssignmentSSM: new iam.PolicyDocument({
          statements: [
            // THE ALT'S RECORD, READ TO BIND IT AND WRITTEN FOR THE LIFE OF THE EXPERIMENT, scoped to the
            // `alt` occupancy leaf: the `live` record is the classification stack's to own (tenet P4).
            new iam.PolicyStatement({
              sid: 'AssignTheAltForAnArmedExperiment',
              actions: ['ssm:GetParameter', 'ssm:PutParameter'],
              resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant-assignments/*/*/alt`],
            }),
            // READ BOTH SIDES' PINNED VERSIONS BEFORE ARMING (ADR-050, §3.7). READ ONLY: the writer of
            // every profile stays manage-profiles (§7).
            new iam.PolicyStatement({
              sid: 'ReadTheDuelSidesPinnedVersions',
              actions: ['ssm:GetParameter'],
              resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant/*/definition`],
            }),
            // TURN BATTLE ON OR OFF FOR A CLASSIFICATION (ADR-049): the POLICY half only. Capability stays
            // compiled classification config, and the handler refuses one that lacks it.
            new iam.PolicyStatement({
              sid: 'SetBattlePolicyForAClassification',
              actions: ['ssm:PutParameter', 'ssm:GetParameter'],
              resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/battle/*/enabled`],
            }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
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
        ADMIN_IAM_ENFORCEMENT: 'true',
        EXPERIMENTS_TABLE: experimentsTable.tableName,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ALLOWED_ORIGIN: adminAppUrl,
        // REQUIRED: the handler and `lib/battle-enablement.ts` resolve the instance root from it.
        SSM_ROOT,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    grantAssistantScopeCheck(adminExperimentsFn, props.appInstanceArn, props.userPoolId, props.identities);
    // READ ONE ITEM, NOTHING ELSE: the candidate route checks the experiment it derives for.
    manageProfilesFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [experimentsTable.tableArn] }));
    // ARMING A BATTLE DERIVES BOTH SIDES' VERSIONS: the experiments handler asks the profile writer to
    // derive them (`deriveBattleSides`), so manage-profiles stays the only writer to the profile namespace.
    manageProfilesFn.grantInvoke(adminExperimentsFn);
    adminExperimentsFn.addEnvironment('MANAGE_PROFILES_FUNCTION_NAME', manageProfilesFn.functionName);

    const fn = adminExperimentsFn;
    const e = (method: RouteMethod, path: string): void => route(method, path, fn, 'experiments');
    e('GET', '/admin/experiments');
    e('POST', '/admin/experiments');
    // Battle on/off per classification (ADR-049).
    e('GET', '/admin/experiments/battle-settings');
    e('POST', '/admin/experiments/battle-settings');
    // The challengers a battle can name: each classification's alt, read from its assignment record.
    e('GET', '/admin/experiments/challengers');
    e('POST', '/admin/experiments/{experimentId}/status');
    // Copy the measured candidate into the live assistant (an activation: `activate-profiles`).
    e('POST', '/admin/experiments/{experimentId}/promote');
    // Hard-remove a never-started draft, else soft-tombstone a test that ran.
    e('DELETE', '/admin/experiments/{experimentId}');
    // The team routes: battle settings have none, since they are set for a whole classification.
    e('GET', '/admin/assistants/{assistant}/experiments');
    e('POST', '/admin/assistants/{assistant}/experiments');
    e('POST', '/admin/assistants/{assistant}/experiments/{experimentId}/status');
    e('POST', '/admin/assistants/{assistant}/experiments/{experimentId}/promote');
    e('DELETE', '/admin/assistants/{assistant}/experiments/{experimentId}');
  }
}
