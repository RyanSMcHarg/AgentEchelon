/**
 * CDK Synthesis Tests
 *
 * Validates that the CDK app synthesizes correctly in both analytics modes.
 * Does NOT deploy — only checks that CloudFormation templates are generated.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ChimeMessagingStack } from '../lib/stacks/chime-messaging-stack';
import { AnalyticsStack } from '../lib/stacks/analytics-stack';
import { CognitoAuthStack } from '../lib/stacks/cognito-auth-stack';
import { BasicClassificationStack } from '../lib/stacks/basic-classification-stack';
import { StandardClassificationStack } from '../lib/stacks/standard-classification-stack';
import { PremiumClassificationStack } from '../lib/stacks/premium-classification-stack';
import { BattleStack } from '../lib/stacks/battle-stack';
import { ChannelFlowStack } from '../lib/stacks/channel-flow-stack';
import { DEFAULT_PROFILE_MODEL_SELECTION } from '../lib/config/model-strategy';

describe('CDK Synthesis', () => {
  const env = { account: '123456789012', region: 'us-east-1' };

  describe('Athena mode (default)', () => {
    it('should synthesize the Chime Messaging stack', () => {
      const app = new cdk.App();
      const stack = new ChimeMessagingStack(app, 'TestChime', {
        env,
        appInstanceName: 'test-instance',
      });

      const template = Template.fromStack(stack);
      // Two CloudFormation custom resources: the MessagingAppInstance, and
      // the app-instance-admin (CreateAppInstanceAdminResource — registers
      // the service admin user used by the admin-console moderation surface,
      // published to SSM /agent-echelon/app-instance-admin-arn).
      template.resourceCountIs('AWS::CloudFormation::CustomResource', 2);
    });

    it('should synthesize the Analytics stack with Kinesis and Firehose', () => {
      const app = new cdk.App();
      const chime = new ChimeMessagingStack(app, 'TestChime', {
        env,
        appInstanceName: 'test-instance',
      });
      const stack = new AnalyticsStack(app, 'TestAnalytics', {
        env,
        appInstanceArn: chime.appInstanceArn,
        // /events is fail-closed: the stack requires a user pool to authorize it.
        userPool: cognito.UserPool.fromUserPoolId(chime, 'TestPool', 'us-east-1_TestPool'),
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::Kinesis::Stream', 1);
      // Two Firehose delivery streams:
      // 1. MessageArchiveDelivery  — Chime messages → conversations/ prefix
      // 2. ClientEventsDelivery    — frontend events → client_events/ prefix
      template.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 2);
      template.resourceCountIs('AWS::S3::Bucket', 1);
      template.resourceCountIs('AWS::Athena::WorkGroup', 1);
    });

    // ORPHANED-STREAM REGRESSION. The message stream's name is FIXED (Chime SDK Messaging rejects
    // PutMessagingStreamingConfigurations unless it begins with `chime-messaging-`, so CDK cannot
    // auto-name it). A RETAINed stream therefore survives a teardown under a name the NEXT fresh
    // deploy must reuse, and that deploy fails ResourceExistenceCheck with "resource already exists".
    // Nothing asserted the policy, so the fix could silently regress to CDK's default on any refactor.
    it('the message Kinesis stream is DESTROY, so a teardown cannot orphan it', () => {
      const app = new cdk.App();
      const chime = new ChimeMessagingStack(app, 'TestChime', { env, appInstanceName: 'test-instance' });
      const stack = new AnalyticsStack(app, 'TestAnalytics', {
        env,
        appInstanceArn: chime.appInstanceArn,
        userPool: cognito.UserPool.fromUserPoolId(chime, 'TestPool', 'us-east-1_TestPool'),
      });
      const template = Template.fromStack(stack);
      // Both policies matter: UpdateReplacePolicy governs a REPLACEMENT (a rename/shard change), which
      // orphans the old stream under the same fixed name just as a teardown would.
      template.hasResource('AWS::Kinesis::Stream', {
        DeletionPolicy: 'Delete',
        UpdateReplacePolicy: 'Delete',
      });
    });

    // The SECOND orphan vector: the Chime streaming CONFIGURATION is an app-instance-level binding that
    // lives outside CloudFormation. Deleting the stream without unbinding leaves Chime pointing at a
    // stream that no longer exists. The unbind is an onDelete on the custom resource, and it can only
    // run if the resource's role is actually granted the Delete action - so pin the grant, not just the
    // intent. A missing permission here fails at teardown time, which is the worst time to discover it.
    it('the Chime streaming configuration can be UNBOUND on delete (the onDelete grant exists)', () => {
      const app = new cdk.App();
      const chime = new ChimeMessagingStack(app, 'TestChime', { env, appInstanceName: 'test-instance' });
      const stack = new AnalyticsStack(app, 'TestAnalytics', {
        env,
        appInstanceArn: chime.appInstanceArn,
        userPool: cognito.UserPool.fromUserPoolId(chime, 'TestPool', 'us-east-1_TestPool'),
      });
      Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['chime:DeleteMessagingStreamingConfigurations']),
            }),
          ]),
        }),
      });
    });

    it('should create evaluation runner Lambda with daily schedule + the membership sweep schedule', () => {
      const app = new cdk.App();
      const chime = new ChimeMessagingStack(app, 'TestChime', {
        env,
        appInstanceName: 'test-instance',
      });
      const stack = new AnalyticsStack(app, 'TestAnalytics', {
        env,
        appInstanceArn: chime.appInstanceArn,
        // /events is fail-closed: the stack requires a user pool to authorize it.
        userPool: cognito.UserPool.fromUserPoolId(chime, 'TestPool', 'us-east-1_TestPool'),
      });

      const template = Template.fromStack(stack);
      // Two scheduled rules: the daily evaluation runner + the membership-audit sweep (trigger #2).
      template.resourceCountIs('AWS::Events::Rule', 2);
      // The sweep rule fires the audit Lambda with a { type: 'sweep' } payload.
      template.hasResourceProperties('AWS::Events::Rule', {
        Targets: Match.arrayWith([
          Match.objectLike({ Input: Match.stringLikeRegexp('.*"type":"sweep".*') }),
        ]),
      });
    });

    it('membership audit: fixed fn name + sweep/reeval List* IAM (triggers #2/#3)', () => {
      const app = new cdk.App();
      const chime = new ChimeMessagingStack(app, 'TestChime', { env, appInstanceName: 'test-instance' });
      const stack = new AnalyticsStack(app, 'TestAnalytics', {
        env,
        appInstanceArn: chime.appInstanceArn,
        userPool: cognito.UserPool.fromUserPoolId(chime, 'TestPool', 'us-east-1_TestPool'),
      });
      const template = Template.fromStack(stack);
      // Stable name so user-management (a different stack) can grant invoke without a cross-stack ARN.
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'agent-echelon-membership-audit',
      });
      // The sweep + reeval enumeration grants.
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).toContain('chime:ListChannels');
      expect(policies).toContain('chime:ListChannelMembershipsForAppInstanceUser');
    });

    it('should NOT create VPC or Aurora resources in Athena mode', () => {
      const app = new cdk.App();
      const chime = new ChimeMessagingStack(app, 'TestChime', {
        env,
        appInstanceName: 'test-instance',
      });
      const stack = new AnalyticsStack(app, 'TestAnalytics', {
        env,
        appInstanceArn: chime.appInstanceArn,
        // /events is fail-closed: the stack requires a user pool to authorize it.
        userPool: cognito.UserPool.fromUserPoolId(chime, 'TestPool', 'us-east-1_TestPool'),
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::EC2::VPC', 0);
      template.resourceCountIs('AWS::RDS::DBCluster', 0);
      template.resourceCountIs('AWS::RDS::DBProxy', 0);
    });
  });

  describe('Aurora mode', () => {
    // Note: AnalyticsStackAurora is a heavier stack that requires more setup.
    // These tests verify the stack can be instantiated without errors.
    // Full resource assertions require the Aurora stack import.

    it('should import AnalyticsStackAurora without errors', async () => {
      const { AnalyticsStackAurora } = await import('../lib/stacks/analytics-stack-aurora');
      expect(AnalyticsStackAurora).toBeDefined();
    });

    it('should synthesize the Aurora analytics stack', async () => {
      const { AnalyticsStackAurora } = await import('../lib/stacks/analytics-stack-aurora');
      const app = new cdk.App();
      const stack = new AnalyticsStackAurora(app, 'TestAnalyticsAurora', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        userPoolId: 'us-east-1_TestPoolId',
      });

      const template = Template.fromStack(stack);

      // VPC resources
      template.resourceCountIs('AWS::EC2::VPC', 1);

      // Aurora resources
      template.resourceCountIs('AWS::RDS::DBCluster', 1);

      // Kinesis stream (same as Athena mode)
      template.resourceCountIs('AWS::Kinesis::Stream', 1);
    });

    // Same orphaned-stream regression as the Athena test above, plus the conditional. Aurora keys the
    // policy on `environment` (default 'dev'), so BOTH sides need pinning: a dev teardown must clean the
    // stream up, and prod must still retain it. Asserting only the default would let the prod branch
    // silently invert.
    it('dev: the message Kinesis stream is DESTROY, so a teardown cannot orphan it', async () => {
      const { AnalyticsStackAurora } = await import('../lib/stacks/analytics-stack-aurora');
      const app = new cdk.App();
      const stack = new AnalyticsStackAurora(app, 'TestAuroraStreamDev', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        userPoolId: 'us-east-1_TestPoolId',
        // environment omitted on purpose: 'dev' is the default and the case that bit us.
      });
      Template.fromStack(stack).hasResource('AWS::Kinesis::Stream', {
        DeletionPolicy: 'Delete',
        UpdateReplacePolicy: 'Delete',
      });
    });

    it('prod: the message Kinesis stream is RETAINed (the conditional works both ways)', async () => {
      const { AnalyticsStackAurora } = await import('../lib/stacks/analytics-stack-aurora');
      const app = new cdk.App();
      const stack = new AnalyticsStackAurora(app, 'TestAuroraStreamProd', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        userPoolId: 'us-east-1_TestPoolId',
        environment: 'prod',
      });
      Template.fromStack(stack).hasResource('AWS::Kinesis::Stream', {
        DeletionPolicy: 'Retain',
      });
    });

    it('does not create an RDS Proxy by default (avoids the 8-ACU minimum)', async () => {
      const { AnalyticsStackAurora } = await import('../lib/stacks/analytics-stack-aurora');
      const app = new cdk.App();
      const stack = new AnalyticsStackAurora(app, 'TestAuroraNoProxy', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        userPoolId: 'us-east-1_TestPoolId',
      });
      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::RDS::DBProxy', 0);
    });

    it('creates an RDS Proxy when enableRdsProxy=true', async () => {
      const { AnalyticsStackAurora } = await import('../lib/stacks/analytics-stack-aurora');
      const app = new cdk.App();
      const stack = new AnalyticsStackAurora(app, 'TestAuroraProxy', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        userPoolId: 'us-east-1_TestPoolId',
        enableRdsProxy: true,
      });
      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::RDS::DBProxy', 1);
    });

    it('should create Aurora with IAM authentication enabled', async () => {
      const { AnalyticsStackAurora } = await import('../lib/stacks/analytics-stack-aurora');
      const app = new cdk.App();
      const stack = new AnalyticsStackAurora(app, 'TestAnalyticsAurora', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        userPoolId: 'us-east-1_TestPoolId',
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        EnableIAMDatabaseAuthentication: true,
        StorageEncrypted: true,
      });
    });

    it('should create VPC with no NAT gateways', async () => {
      const { AnalyticsStackAurora } = await import('../lib/stacks/analytics-stack-aurora');
      const app = new cdk.App();
      const stack = new AnalyticsStackAurora(app, 'TestAnalyticsAurora', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        userPoolId: 'us-east-1_TestPoolId',
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
    });

    it('should create VPC endpoints for Kinesis, S3, SecretsManager, and Bedrock', async () => {
      const { AnalyticsStackAurora } = await import('../lib/stacks/analytics-stack-aurora');
      const app = new cdk.App();
      const stack = new AnalyticsStackAurora(app, 'TestAnalyticsAurora', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        userPoolId: 'us-east-1_TestPoolId',
      });

      const template = Template.fromStack(stack);
      // 3 interface endpoints (Kinesis, SecretsManager, Bedrock) + 2 gateways
      // (S3, DynamoDB — the latter lets the in-VPC analytics Lambda Scan the
      // feedback + battle-outcome tables for the per-variant human-signal join)
      template.resourceCountIs('AWS::EC2::VPCEndpoint', 5);
    });

    // BYO existing-VPC: import a VPC instead of creating one.
    // fromLookup is pre-seeded with context so synth stays offline.
    describe('BYO existing VPC', () => {
      const VPC_ID = 'vpc-0byo12345';
      const vpcContext = {
        [`vpc-provider:account=${env.account}:filter.vpc-id=${VPC_ID}:region=${env.region}:returnAsymmetricSubnets=true`]:
          {
            vpcId: VPC_ID,
            vpcCidrBlock: '10.0.0.0/16',
            ownerAccountId: env.account,
            availabilityZones: [],
            subnetGroups: [
              {
                name: 'isolated',
                type: 'Isolated',
                subnets: [
                  {
                    subnetId: 'subnet-iso1',
                    availabilityZone: 'us-east-1a',
                    routeTableId: 'rtb-iso1',
                    cidr: '10.0.0.0/24',
                  },
                  {
                    subnetId: 'subnet-iso2',
                    availabilityZone: 'us-east-1b',
                    routeTableId: 'rtb-iso2',
                    cidr: '10.0.1.0/24',
                  },
                ],
              },
            ],
          },
      };

      const makeStack = async (
        id: string,
        extra: Record<string, unknown>,
      ) => {
        const { AnalyticsStackAurora } = await import(
          '../lib/stacks/analytics-stack-aurora'
        );
        const app = new cdk.App({ context: vpcContext });
        return new AnalyticsStackAurora(app, id, {
          env,
          appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
          userPoolId: 'us-east-1_TestPoolId',
          ...extra,
        });
      };

      it('imports the existing VPC instead of creating one', async () => {
        const stack = await makeStack('TestAuroraByoVpc', { vpcId: VPC_ID });
        const template = Template.fromStack(stack);
        template.resourceCountIs('AWS::EC2::VPC', 0);
        template.resourceCountIs('AWS::EC2::NatGateway', 0);
        template.resourceCountIs('AWS::RDS::DBCluster', 1);
      });

      it('skips endpoint creation when createVpcEndpoints=false', async () => {
        const stack = await makeStack('TestAuroraByoVpcNoEp', {
          vpcId: VPC_ID,
          createVpcEndpoints: false,
        });
        const template = Template.fromStack(stack);
        template.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
      });

      it('rejects createVpcEndpoints=false without an imported VPC', async () => {
        const { AnalyticsStackAurora } = await import(
          '../lib/stacks/analytics-stack-aurora'
        );
        const app = new cdk.App();
        expect(
          () =>
            new AnalyticsStackAurora(app, 'TestAuroraBadEp', {
              env,
              appInstanceArn:
                'arn:aws:chime:us-east-1:123456789012:app-instance/test',
              userPoolId: 'us-east-1_TestPoolId',
              createVpcEndpoints: false,
            }),
        ).toThrow(/only valid with an imported/);
      });
    });
  });

  describe('Cognito stack', () => {
    it('should synthesize with scoped IAM permissions (not wildcard)', () => {
      const app = new cdk.App();
      const chime = new ChimeMessagingStack(app, 'TestChime', {
        env,
        appInstanceName: 'test-instance',
      });
      const stack = new CognitoAuthStack(app, 'TestCognito', {
        env,
        appInstanceArn: chime.appInstanceArn,
      });

      const template = Template.fromStack(stack);

      // The cognito-idp:AdminUpdateUserAttributes statement must be scoped
      // to a Cognito user pool ARN, not '*'. Assert on THAT statement
      // specifically — not the whole concatenated policy blob: other
      // statements legitimately need Resource '*' (e.g.
      // chime:GetMessagingSessionEndpoint, which AWS does not allow to be
      // resource-scoped), so a global regex over all policies would
      // false-fail on a correct policy.
      const policies = template.findResources('AWS::IAM::Policy');
      let assertedAdminUpdate = false;

      for (const policy of Object.values(policies) as Array<{
        Properties: { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } };
      }>) {
        for (const stmt of policy.Properties.PolicyDocument.Statement) {
          const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
          if (actions.includes('cognito-idp:AdminUpdateUserAttributes')) {
            assertedAdminUpdate = true;
            expect(stmt.Resource).not.toBe('*');
            // Resource may be a string or a CFN intrinsic; either way it
            // must reference a Cognito user pool, never an unscoped '*'.
            expect(JSON.stringify(stmt.Resource)).toContain('userpool');
          }
        }
      }

      // Keep the test meaningful: the scoped policy must actually exist.
      expect(assertedAdminUpdate).toBe(true);
    });

    it('user-management can invoke the membership audit for on-downgrade re-eval (trigger #3)', () => {
      const app = new cdk.App();
      const chime = new ChimeMessagingStack(app, 'TestChimeReeval', { env, appInstanceName: 'test-instance' });
      const stack = new CognitoAuthStack(app, 'TestCognitoReeval', { env, appInstanceArn: chime.appInstanceArn });
      const template = Template.fromStack(stack);

      // The invoke grant is scoped to the audit's STABLE function name (not '*'), so the reverse
      // dependency stays name-based, not a cross-stack ARN import. It is an INLINE policy on the
      // user-management role, so assert against the whole template (inline policies live in the Role).
      const whole = JSON.stringify(template.toJSON());
      expect(whole).toContain('lambda:InvokeFunction');
      expect(whole).toContain('function:agent-echelon-membership-audit');

      // The Lambda carries the audit fn name so it knows what to invoke.
      const fns = Object.values(template.findResources('AWS::Lambda::Function')) as Array<{
        Properties?: { Environment?: { Variables?: Record<string, unknown> } };
      }>;
      const withName = fns.filter((f) => f.Properties?.Environment?.Variables?.MEMBERSHIP_AUDIT_FN_NAME !== undefined);
      expect(withName.length).toBeGreaterThanOrEqual(1);
    });

    it('Credential Exchange: bearer-pinned exchange roles + TagSession + API (SPEC-CREDENTIAL-EXCHANGE)', () => {
      const app = new cdk.App();
      const chime = new ChimeMessagingStack(app, 'TestChimeCx', { env, appInstanceName: 'test-instance' });
      const stack = new CognitoAuthStack(app, 'TestCognitoCx', { env, appInstanceArn: chime.appInstanceArn });
      const template = Template.fromStack(stack);

      const policies = Object.values(template.findResources('AWS::IAM::Policy')) as Array<{
        Properties: { Roles?: Array<{ Ref?: string }>; PolicyDocument: { Statement: Array<{ Effect?: string; Action: unknown; Resource: unknown }> } };
      }>;
      // Actions granted to a role whose logical id starts with `prefix`.
      // Actions granted to a role whose logical id starts with `prefix`, with an
      // optional `exclude` prefix. `exclude` matters because the CHAT admin rung
      // `ExchangeRoleAdmin` and the moderation-capable admin-plane role
      // `ExchangeRoleAdminPlane` share the `ExchangeRoleAdmin` prefix.
      const actionsFor = (prefix: string, exclude?: string): string[] => {
        const acts = new Set<string>();
        for (const p of policies) {
          if (!(p.Properties.Roles || []).some((r) => {
            const ref = r.Ref || '';
            return ref.startsWith(prefix) && (!exclude || !ref.startsWith(exclude));
          })) continue;
          for (const st of p.Properties.PolicyDocument.Statement) {
            // Collect GRANTS only. A Deny (e.g. the archived-channel read-only Deny,
            // SPEC-CONVERSATION-ARCHIVE: DenyWriteOnArchivedChannel adds
            // Send/UpdateChannelMessage as a RESTRICTION) is not a grant, so it must
            // not count toward the FORBIDDEN "is this action granted?" checks below.
            if (st.Effect === 'Deny') continue;
            (Array.isArray(st.Action) ? st.Action : [st.Action]).forEach((a) => acts.add(String(a)));
          }
        }
        return [...acts];
      };

      // Every CHAT exchange rung must EXCLUDE the backend/moderator over-grants.
      // (The admin CHAT rung is the admin's own `${sub}` identity - never elevated;
      // moderation lives on the SEPARATE admin-plane role asserted below.)
      //
      // chime:UpdateChannel is deliberately NOT forbidden: it is a base OWNER-RENAME
      // capability granted to every rung (EXCHANGE_MSG_ACTIONS). It is safe because
      // (a) Chime authorizes UpdateChannel on ChannelModerator status, and only a
      // channel's creator is a moderator of their own channel, so a non-moderator
      // member is denied; and (b) tier is tag-authoritative, so a rename that mutates
      // metadata.modelTier cannot escalate. DeleteChannel (destructive) stays forbidden.
      const FORBIDDEN = [
        'chime:CreateChannel', 'chime:CreateChannelMembership', 'chime:CreateAppInstanceUser',
        'chime:RedactChannelMessage', 'chime:UpdateChannelMessage', 'chime:DeleteChannel',
      ];
      for (const rung of ['ExchangeRoleRestricted', 'ExchangeRoleBasic', 'ExchangeRoleStandard', 'ExchangeRolePremium', 'ExchangeRoleAdmin']) {
        // Exclude the admin-plane role from the chat-admin rung lookup.
        const acts = actionsFor(rung, rung === 'ExchangeRoleAdmin' ? 'ExchangeRoleAdminPlane' : undefined);
        expect(acts.length).toBeGreaterThan(0); // role exists + has grants
        for (const f of FORBIDDEN) expect(acts).not.toContain(f);
        // Positive lock: the owner-rename cap must be present on every chat rung (rungs
        // are pinned to the caller's own ${sub}; Chime's moderator check is the real gate).
        expect(acts).toContain('chime:UpdateChannel');
      }

      // Two-plane admin identity (docs/SPEC-ADMIN-IDENTITY.md): the moderation
      // ceiling lives ONLY on the admin-plane role (pinned to `${sub}-admin`,
      // vended per-channel, short-lived, audited). The chat admin rung must NOT
      // carry it; the admin-plane role must.
      const adminPlane = actionsFor('ExchangeRoleAdminPlane');
      expect(adminPlane).toContain('chime:RedactChannelMessage');
      expect(adminPlane).toContain('chime:DeleteChannelMessage');
      expect(adminPlane).toContain('chime:CreateChannelMembership');
      const chatAdmin = actionsFor('ExchangeRoleAdmin', 'ExchangeRoleAdminPlane');
      expect(chatAdmin).not.toContain('chime:RedactChannelMessage');
      expect(chatAdmin).not.toContain('chime:CreateChannelModerator');

      // The restricted/guest rung is the floor: no discovery / self-membership / profile writes.
      const restricted = actionsFor('ExchangeRoleRestricted');
      expect(restricted).not.toContain('chime:ListChannels');
      expect(restricted).not.toContain('chime:DeleteChannelMembership');
      expect(restricted).not.toContain('chime:UpdateAppInstanceUser');
      expect(restricted).toContain('chime:SendChannelMessage');

      // The bearer is pinned to the caller's own AppInstanceUser via the session tag.
      const blob = JSON.stringify(template.toJSON());
      expect(blob).toContain('/user/${aws:PrincipalTag/sub}');
      // The exchange Lambda role may TagSession + AssumeRole the rung roles.
      expect(blob).toContain('sts:TagSession');
      // The endpoint exists.
      template.hasResourceProperties('AWS::ApiGateway::RestApi', { Name: 'agent-echelon-credential-exchange' });
    });
  });

  describe('Per-tier stack (ADR-011)', () => {
    // Plain-string platform inputs (no cross-stack tokens) so the tier stack
    // synthesizes standalone — mirroring the SSM-only/decoupled-deploy goal.
    const appInstanceArn = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';
    const classificationBasicProps = {
      env,
      appInstanceArn,
      attachmentsBucketName: 'agent-echelon-attachments-test',
      attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
      profileModelSelection: DEFAULT_PROFILE_MODEL_SELECTION,
    };

    it('should synthesize AgentEchelonClassification-Basic as an Option-D processor (no Bedrock Agent)', () => {
      const app = new cdk.App();
      const stack = new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', classificationBasicProps);

      const template = Template.fromStack(stack);

      // The assistant is the async-processor, NOT a managed agent.
      template.resourceCountIs('AWS::Bedrock::Agent', 0);
      template.resourceCountIs('AWS::Bedrock::AgentAlias', 0);

      // Two content guardrails (SPEC-CONFIGURABLE-ASSISTANTS 4.6b): the default + one selectable
      // alternate ('strict') from the catalog; basic has no /battle image guardrail.
      template.resourceCountIs('AWS::Bedrock::Guardrail', 2);

      // Lex bot + AppInstanceBot custom resources.
      template.resourceCountIs('AWS::CloudFormation::CustomResource', 2);

      // SSM contract: processor-arn + bot-arn published for the shared router and
      // create-conversation to discover, router-arn (per-classification router
      // Lambda) for the profile infra resolver, the selectable-guardrails catalog
      // (SPEC-CONFIGURABLE-ASSISTANTS 4.6b), and the selectable context-source catalog
      // (SPEC-CONTEXT-SOURCES-AND-STORES). The COUNT is asserted deliberately: this is the
      // published contract other stacks and the admin console read, so a parameter
      // appearing or vanishing should require someone to say so here.
      template.resourceCountIs('AWS::SSM::Parameter', 5);
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/assistant/basic/processor-arn',
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/assistant/basic/bot-arn',
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/assistant/basic/router-arn',
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/assistant/basic/guardrails',
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/assistant/basic/context-sources',
      });
    });

    // Publishing processor-arn is only half the contract: the HANDLER reads it every turn
    // (resolveAsyncProcessorArn). The grant was missing, and nothing caught it because the failure
    // is invisible — the read denies, the code falls back to the *_ASYNC_PROCESSOR_ARN env var, and
    // the turn succeeds. The only symptoms were an AccessDenied stack trace on every request and a
    // dead re-pointing capability. Assert the READ grant, not just the parameter.
    it('the handler is granted ssm:GetParameter on the processor-arn it reads every turn', () => {
      const app = new cdk.App();
      const stack = new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', classificationBasicProps);

      Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'ssm:GetParameter',
              Resource: Match.arrayWith([
                `arn:aws:ssm:${env.region}:${env.account}:parameter/agent-echelon/assistant/basic/processor-arn`,
              ]),
            }),
          ]),
        }),
      });
    });

    // THE HANDOVER'S SELF-INVOKE (MESSAGE-FLOW §3). A message is answered by the assistant whose work
    // it answers, so a handler that receives one it does not own invokes this same function as the
    // owning assistant. Both halves of the grant have a failure mode that deploys clean:
    //   - Referencing the function from the role's DEFAULT policy closes a dependency cycle, which is
    //     caught at synth (the template is simply undeployable).
    //   - A NAME PATTERN is not caught anywhere. CloudFormation truncates the stack name when the
    //     generated physical name would exceed 64 characters, so the handler is really named
    //     `AgentEchelonClassification-Pr-AgentHandler...`; a pattern built from the full stack name
    //     matches nothing, deploys green, and denies at runtime. Found on the deployment, not here.
    it('grants the handler invoke on ITSELF, by ARN and from a policy of its own', () => {
      const app = new cdk.App();
      const stack = new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', classificationBasicProps);
      const template = Template.fromStack(stack);

      const handler = Object.keys(template.findResources('AWS::Lambda::Function'))
        .find((id) => id.startsWith('AgentHandler'));
      // The grant is meaningless without the function it names.
      expect(handler).toBeTruthy();

      // The ARN itself, never a pattern: a pattern is the failure that reaches runtime.
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'lambda:InvokeFunction',
              Resource: { 'Fn::GetAtt': [handler, 'Arn'] },
            }),
          ]),
        }),
      });

      // And NOT on the role's default policy, which is what the function depends on. `Template.fromStack`
      // does not run the cycle check, so assert the placement rather than the symptom.
      const defaultPolicy = Object.entries(template.findResources('AWS::IAM::Policy'))
        .find(([id]) => id.startsWith('AgentHandlerRoleDefaultPolicy'));
      const defaultStatements = JSON.stringify(
        (defaultPolicy?.[1] as any)?.Properties?.PolicyDocument?.Statement ?? [],
      );
      // The default policy must not name the function it is attached to; that IS the deploy cycle.
      expect(defaultStatements.includes(`"${handler}"`)).toBe(false);
    });

    // SPEC-CONTEXT-SOURCES-AND-STORES phase 2. The catalog is published and the read is granted in one
    // construct, because a published key WITHOUT its grant imports cleanly and fails at runtime - an
    // omission that fails OPEN. These assert the pairing and, critically, the RESOURCE SCOPE: a
    // wildcard grant would satisfy "a statement exists" while removing the boundary the catalog is for.
    describe('context source catalog (INV-CTX-CAT-3)', () => {
      const synth = (name: string) =>
        Template.fromStack(
          new StandardClassificationStack(new cdk.App(), `AgentEchelonClassification-${name}`, classificationBasicProps),
        );

      it('publishes the catalog WITH a resolvable locator but WITHOUT the account-qualified arn', () => {
        const template = synth('CtxPublish');
        const params = template.findResources('AWS::SSM::Parameter');
        const entry = Object.values(params).find(
          (p) => String((p.Properties as { Name?: string }).Name || '').endsWith('/context-sources'),
        );
        expect(entry).toBeDefined();
        // The published value is a CFN intrinsic, not a plain string: the bucket LOCATOR is an
        // imported token, so CDK emits Fn::Join. Resolve it the way CloudFormation will, substituting
        // a marker for each unresolved token so the JSON still parses and the shape can be asserted.
        const resolveValue = (v: unknown): string => {
          if (typeof v === 'string') return v;
          const join = (v as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join'];
          if (!join) return JSON.stringify(v);
          const [sep, parts] = join;
          return parts.map((p) => (typeof p === 'string' ? p : 'RESOLVED-AT-DEPLOY')).join(sep);
        };
        const published = JSON.parse(resolveValue((entry!.Properties as { Value: unknown }).Value));
        expect(published.length).toBeGreaterThan(0);
        // The scannable layer must survive publication - it is what the console and the model read.
        for (const source of published) {
          expect(source.key).toBeTruthy();
          expect(source.title).toBeTruthy();
          expect(source.description).toBeTruthy();
          expect(source.useWhen).toBeTruthy();
          // The LOCATOR and PREFIX are published, because the reader resolves them - that is what
          // keeps the read at the same location the IAM grant authorised. Stripping the prefix is
          // what previously forced the reader to hardcode a corpus path.
          expect(source.locator).toBeTruthy();
          // The account-qualified ARN is still dropped: the grant already binds it, and it is the
          // only part that carries an account id.
          expect(source.arn).toBeUndefined();
          expect(JSON.stringify(source)).not.toMatch(/arn:aws:/);
        }
        // The s3 entry must publish the prefix it was granted on, or grant and read can diverge.
        const s3Entry = published.find((s: { type: string }) => s.type === 's3-prefix');
        expect(s3Entry?.prefix).toBe('context/standard/');
      });

      it('grants each source a resource-SCOPED read, never a wildcard', () => {
        const template = synth('CtxGrant');
        const policies = Object.values(template.findResources('AWS::IAM::Policy'));
        const statements = policies.flatMap(
          (p) => ((p.Properties as { PolicyDocument: { Statement: unknown[] } }).PolicyDocument.Statement || []),
        ) as Array<{ Action?: unknown; Resource?: unknown }>;

        // The example catalog's company-docs entry is an s3-prefix; its grant must name the PREFIX.
        const flat = JSON.stringify(statements);
        expect(flat).toContain('context/standard/*');

        // No statement may grant a bare "*" resource. This is the assertion that a permissive grant
        // would otherwise sail past - presence alone proves nothing about the boundary.
        const hasWildcard = (s: { Resource?: unknown }) => {
          const r = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
          return r.some((x) => x === '*');
        };
        expect(statements.filter(hasWildcard)).toEqual([]);

        // Falsification: the detector must actually fire. Without this the assertion above could pass
        // because the predicate is wrong rather than because the policy is clean - which is precisely
        // how a guard in this repo once passed having checked nothing.
        expect(hasWildcard({ Resource: '*' })).toBe(true);
        expect(hasWildcard({ Resource: ['*'] })).toBe(true);
        expect(hasWildcard({ Resource: ['arn:aws:s3:::b/context/standard/*'] })).toBe(false);
      });
    });

    /**
     * The watching half of INV-CTX-CAT-7. The runtime counts every outcome; this asserts the
     * deployment actually looks at those counts, and - just as important - that it does NOT ship an
     * alarm with nowhere to deliver to.
     */
    describe('context source failure-rate alarm and dashboard (INV-CTX-CAT-7)', () => {
      const withAlerting = {
        ...classificationBasicProps,
        adminErrorAlertChannelArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test/channel/admin',
      };
      const alerting = () => Template.fromStack(
        new StandardClassificationStack(new cdk.App(), 'AgentEchelonClassification-CtxAlarm', withAlerting),
      );

      it('alarms on a RATE over five minutes, not on any single failure', () => {
        // Context sources resolve on every turn, so a broken grant fails continuously. An
        // occurrence alarm would notify once per user message - which is how an alert gets muted.
        const alarms = alerting().findResources('AWS::CloudWatch::Alarm');
        const alarm = Object.values(alarms).find(
          (a) => String((a.Properties as { AlarmName?: string }).AlarmName || '').includes('context-source-failure-rate'),
        );
        expect(alarm).toBeDefined();
        const props = alarm!.Properties as {
          Metrics?: Array<{ Expression?: string; MetricStat?: { Period?: number } }>;
          EvaluationPeriods?: number;
          TreatMissingData?: string;
        };
        const expr = props.Metrics?.find((m) => m.Expression)?.Expression || '';
        // A percentage, not a count.
        expect(expr).toContain('100*');
        // Every referenced metric is a five-minute period.
        for (const m of props.Metrics || []) {
          if (m.MetricStat) expect(m.MetricStat.Period).toBe(300);
        }
        expect(props.EvaluationPeriods).toBe(1);
        // No traffic must not page.
        expect(props.TreatMissingData).toBe('notBreaching');
      });

      it('guards against paging on arithmetic when traffic is low', () => {
        // 1 failure in 2 attempts is 50% and means nothing. Without a floor, a quiet deployment
        // alarms on its first hiccup and the alarm is disabled within a week.
        const alarms = alerting().findResources('AWS::CloudWatch::Alarm');
        const expr = Object.values(alarms)
          .flatMap((a) => ((a.Properties as { Metrics?: Array<{ Expression?: string }> }).Metrics || []))
          .map((m) => m.Expression).find(Boolean) || '';
        expect(expr).toMatch(/IF\(/);
        expect(expr).toMatch(/>= ?\d+/);
      });

      it('fills missing datapoints, so a quiet period reads 0% rather than going blind', () => {
        const alarms = alerting().findResources('AWS::CloudWatch::Alarm');
        const expr = Object.values(alarms)
          .flatMap((a) => ((a.Properties as { Metrics?: Array<{ Expression?: string }> }).Metrics || []))
          .map((m) => m.Expression).find(Boolean) || '';
        expect(expr).toContain('FILL(');
      });

      it('notifies on RECOVERY as well as on breaking', () => {
        const alarms = alerting().findResources('AWS::CloudWatch::Alarm');
        const alarm = Object.values(alarms).find(
          (a) => String((a.Properties as { AlarmName?: string }).AlarmName || '').includes('context-source-failure-rate'),
        );
        const props = alarm!.Properties as { AlarmActions?: unknown[]; OKActions?: unknown[] };
        expect(props.AlarmActions?.length).toBeGreaterThan(0);
        expect(props.OKActions?.length).toBeGreaterThan(0);
      });

      it('routes the alarm to the ADMIN CHANNEL, not to an email list', () => {
        // SNS is the transport between CloudWatch and the notifier; the destination is the admin
        // conversation, which fans out to the roster by email through the channel flow.
        const t = alerting();
        t.resourceCountIs('AWS::SNS::Topic', 1);
        const subs = Object.values(t.findResources('AWS::SNS::Subscription'));
        expect(subs.some((s) => (s.Properties as { Protocol?: string }).Protocol === 'lambda')).toBe(true);
      });

      it('builds a dashboard naming THIS deployment\'s sources', () => {
        const boards = Object.values(alerting().findResources('AWS::CloudWatch::Dashboard'));
        expect(boards).toHaveLength(1);
        const body = JSON.stringify((boards[0].Properties as { DashboardBody: unknown }).DashboardBody);
        // The catalog's own keys, so an operator does not have to guess what to look for.
        expect(body).toContain('company-docs');
        // And the failure reasons, with the security one present.
        expect(body).toContain('denied');
      });

      // FALSIFICATION. Without this, the assertions above could all pass while the alarm shipped
      // unconditionally - an alarm with no delivery target is a light nobody sees, and a dashboard is
      // a monthly charge for a page nobody opens.
      it('ships NEITHER when there is no admin channel to deliver to', () => {
        const t = Template.fromStack(
          new StandardClassificationStack(new cdk.App(), 'AgentEchelonClassification-CtxNoAlarm', classificationBasicProps),
        );
        const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm'));
        expect(alarms.filter(
          (a) => String((a.Properties as { AlarmName?: string }).AlarmName || '').includes('context-source'),
        )).toEqual([]);
        t.resourceCountIs('AWS::CloudWatch::Dashboard', 0);
      });
    });

    it('should synthesize AgentEchelonClassification-Standard resolving the shared SSM contract (no Bedrock Agent, no Fn::importValue)', () => {
      const app = new cdk.App();
      const stack = new StandardClassificationStack(app, 'AgentEchelonClassification-Standard', classificationBasicProps);

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::Bedrock::Agent', 0);

      // Shared tables arrive as SSM dynamic refs (CFN parameters of type
      // AWS::SSM::Parameter::Value<String>), NOT as a cross-stack
      // Fn::importValue — the decoupled-deploy invariant.
      const params = (template.toJSON().Parameters || {}) as Record<string, { Type?: string; Default?: string }>;
      const ssmDefaults = Object.values(params)
        .filter((p) => p.Type === 'AWS::SSM::Parameter::Value<String>')
        .map((p) => p.Default);
      expect(ssmDefaults).toContain('/agent-echelon/shared/tables/agent-tasks-arn');
      expect(ssmDefaults).toContain('/agent-echelon/shared/tables/experiments-arn');
      // /battle is opt-in (AgentEchelonBattle): with enableBattle unset, the tier
      // resolves NO battle SSM, so it can deploy with /battle off.
      expect(ssmDefaults).not.toContain('/agent-echelon/shared/battle-orchestrator-arn');

      // Still publishes its own processor ARN for the router to discover.
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/assistant/standard/processor-arn',
      });
    });

    it('should resolve the battle SSM contract ONLY when enableBattle is set (opt-in /battle)', () => {
      const app = new cdk.App();
      const stack = new StandardClassificationStack(app, 'AgentEchelonClassification-Standard', {
        ...classificationBasicProps,
        enableBattle: true,
      });

      const template = Template.fromStack(stack);
      const params = (template.toJSON().Parameters || {}) as Record<string, { Type?: string; Default?: string }>;
      const ssmDefaults = Object.values(params)
        .filter((p) => p.Type === 'AWS::SSM::Parameter::Value<String>')
        .map((p) => p.Default);
      // With battle enabled, the tier resolves the battle SSM AgentEchelonBattle
      // publishes (still SSM dynamic refs, not Fn::importValue).
      expect(ssmDefaults).toContain('/agent-echelon/shared/tables/battle-state-arn');
      expect(ssmDefaults).toContain('/agent-echelon/shared/battle-orchestrator-arn');
    });

    it('should synthesize AgentEchelonClassification-Premium with text + image guardrails (no Bedrock Agent)', () => {
      const app = new cdk.App();
      const stack = new PremiumClassificationStack(app, 'AgentEchelonClassification-Premium', classificationBasicProps);

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::Bedrock::Agent', 0);
      // Premium owns the default content guardrail + the 'strict' selectable alternate (4.6b) + the
      // /battle image guardrail.
      template.resourceCountIs('AWS::Bedrock::Guardrail', 3);
    });
  });

  // ── Live drift re-homing (Aurora mode): the per-tier handler gets VPC +
  //    Aurora/Titan IAM + the drift-confirm create-flow IAM, on ALL tiers.
  describe('Live drift wiring (Aurora hookup)', () => {
    const appInstanceArn = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';
    const classificationBaseProps = {
      env,
      appInstanceArn,
      attachmentsBucketName: 'agent-echelon-attachments-test',
      attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
      profileModelSelection: DEFAULT_PROFILE_MODEL_SELECTION,
    };

    /** Build a synthetic AuroraDriftHookup: just the data-plane Lambda ARN the
     *  tier handler is granted invoke on (project decision 018). The handler is
     *  no longer VPC-attached, so no throwaway VPC / client SG is needed. */
    function makeHookup(_app: cdk.App) {
      return {
        dataPlaneArn:
          'arn:aws:lambda:us-east-1:123456789012:function:AgentEchelon-DataPlane',
      };
    }

    const driftRolePolicyMatches = (template: Template) => {
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      // The handler invokes the data-plane Lambda for retrieval + drift (project
      // decision 018); rds-db:connect + Titan-embed IAM now live on the
      // data-plane Lambda's own role in AnalyticsStackAurora, NOT on the handler.
      expect(policies).toContain('lambda:InvokeFunction');
      expect(policies).not.toContain('rds-db:connect');
      // Drift-confirm create-flow IAM (still on the handler).
      expect(policies).toContain('chime:CreateChannel');
      expect(policies).toContain('chime:TagResource');
      expect(policies).toContain('chime:SendChannelMessage');
      // The channel-flow ARN SSM read for the create path.
      expect(policies).toContain('parameter/agent-echelon/channel-flow-arn');
    };

    /** No Lambda in the tier stack is VPC-attached in the data-plane model. */
    const noHandlerIsVpcAttached = (template: Template) => {
      const fns = template.findResources('AWS::Lambda::Function');
      for (const fn of Object.values(fns)) {
        expect(
          (fn as { Properties?: { VpcConfig?: unknown } }).Properties?.VpcConfig,
        ).toBeUndefined();
      }
    };

    it('wires the basic handler to the data-plane Lambda (NO VPC) + create-flow IAM (drift is all-tier)', () => {
      const app = new cdk.App();
      const stack = new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', {
        ...classificationBaseProps,
        auroraDriftHookup: makeHookup(app),
      });
      const template = Template.fromStack(stack);
      // The handler is NOT VPC-attached; it gets the data-plane ARN + drift on.
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            ENABLE_LIVE_DRIFT: 'true',
            AURORA_DATA_PLANE_ARN: Match.anyValue(),
          }),
        },
      });
      noHandlerIsVpcAttached(template);
      driftRolePolicyMatches(template);
    });

    it('wires the premium handler to the data-plane Lambda (NO VPC) + create-flow IAM', () => {
      const app = new cdk.App();
      const stack = new PremiumClassificationStack(app, 'AgentEchelonClassification-Premium', {
        ...classificationBaseProps,
        auroraDriftHookup: makeHookup(app),
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            ENABLE_LIVE_DRIFT: 'true',
            AURORA_DATA_PLANE_ARN: Match.anyValue(),
          }),
        },
      });
      noHandlerIsVpcAttached(template);
      driftRolePolicyMatches(template);
    });

    it('the SendChannelMessage grant is TAG-GATED on classification (Layer-1 send boundary intact)', () => {
      const app = new cdk.App();
      const stack = new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', {
        ...classificationBaseProps,
        auroraDriftHookup: makeHookup(app),
      });
      const template = Template.fromStack(stack);
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      // The drift create-flow grants SendChannelMessage only alongside the
      // classification ResourceTag condition — never app-wide.
      expect(policies).toContain('aws:ResourceTag/classification');
    });

    it('wires abuse controls (SPEC-ABUSE-CONTROLS): table env + length cap on both Lambdas, DynamoDB grant (rate limit is config-driven)', () => {
      const app = new cdk.App();
      const stack = new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', { ...classificationBaseProps });
      const template = Template.fromStack(stack);
      // Both the processor AND the handler carry the abuse env: the shared table and the length cap.
      // (The rate-limit ceiling moved to the profile config — profiles.ts rateLimitPerHour, read at
      // runtime by the router via the registry — so it is no longer a per-tier env var.)
      const fns = Object.values(template.findResources('AWS::Lambda::Function')) as Array<{
        Properties?: { Environment?: { Variables?: Record<string, unknown> } };
      }>;
      const withAbuse = fns.filter((f) => f.Properties?.Environment?.Variables?.ABUSE_CONTROLS_TABLE !== undefined);
      expect(withAbuse.length).toBeGreaterThanOrEqual(2); // processor + handler
      for (const f of withAbuse) {
        const v = f.Properties!.Environment!.Variables!;
        expect(v.RATE_LIMIT_BASIC).toBeUndefined(); // rate limit is config-driven now, not env
        expect(v.MAX_USER_MESSAGE_LENGTH).toBe('16000'); // AE default (not CH's 2000)
      }
      // The dedup/budget/rate-limit counters need DynamoDB write on the control table.
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).toContain('dynamodb:UpdateItem');
      expect(policies).toContain('dynamodb:PutItem');
    });

    it('abuse budget + circuit are OPT-IN: no spend-budget value or SSM circuit grant unless a global budget is set', () => {
      // Default context (no bedrockGlobalHourlyBudget): budgets are 0/off and the circuit param is
      // NOT wired (no ssm:PutParameter grant for the circuit).
      const app = new cdk.App();
      const stack = new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', { ...classificationBaseProps });
      const template = Template.fromStack(stack);
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).not.toContain('/agent-echelon/abuse/circuit'); // circuit unwired without a global budget

      // With a global budget set, the circuit SSM param + its PutParameter grant appear.
      const app2 = new cdk.App({ context: { bedrockGlobalHourlyBudget: '800' } });
      const stack2 = new BasicClassificationStack(app2, 'AgentEchelonClassification-Basic', { ...classificationBaseProps });
      const template2 = Template.fromStack(stack2);
      const policies2 = JSON.stringify(template2.findResources('AWS::IAM::Policy'));
      expect(policies2).toContain('ssm:PutParameter');
      expect(policies2).toContain('abuse/circuit');
    });

    it('assistant/handler roles bear BOTS only — no /user/* bearer ', () => {
      const app = new cdk.App();
      const stack = new PremiumClassificationStack(app, 'AgentEchelonClassification-Premium', {
        ...classificationBaseProps,
        auroraDriftHookup: makeHookup(app),
        enableBattle: true,
      });
      const template = Template.fromStack(stack);
      // Inspect every channel-action statement: its resources must never include a
      // `…/user/*` (assistants act as the tier bot, never impersonate a user). The
      // `…/bot/*` bearer is retained (the premium processor bears alt-slot bots in /battle).
      const policies = Object.values(template.findResources('AWS::IAM::Policy')) as Array<{
        Properties: { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } };
      }>;
      let sawBotBearer = false;
      for (const p of policies) {
        for (const st of p.Properties.PolicyDocument.Statement) {
          const actions = (Array.isArray(st.Action) ? st.Action : [st.Action]).map(String);
          if (!actions.some((a) => a === 'chime:SendChannelMessage' || a === 'chime:DescribeChannel')) continue;
          const resJson = JSON.stringify(st.Resource);
          // No channel-action statement may grant a user-ARN bearer.
          expect(resJson).not.toContain('/user/*');
          if (resJson.includes('/bot/*')) sawBotBearer = true;
        }
      }
      expect(sawBotBearer).toBe(true); // the bot bearer is present (battle needs it)
    });

    it('Athena mode (no hookup) leaves the handler with NO VPC and NO drift/create IAM', () => {
      const app = new cdk.App();
      const stack = new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', { ...classificationBaseProps });
      const template = Template.fromStack(stack);
      // No Lambda has a VpcConfig.
      const fns = template.findResources('AWS::Lambda::Function');
      for (const fn of Object.values(fns)) {
        expect((fn as { Properties?: { VpcConfig?: unknown } }).Properties?.VpcConfig).toBeUndefined();
      }
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).not.toContain('rds-db:connect');
      expect(policies).not.toContain('chime:CreateChannel');
    });
  });

  // ── AgentEchelonBattle (opt-in /battle stack) ──────────────────────────────────
  describe('Battle stack (AgentEchelonBattle, opt-in /battle)', () => {
    const appInstanceArn = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';
    const battleProps = {
      env,
      appInstanceArn,
      userPoolId: 'us-east-1_testpool',
      appUrl: 'https://app.example.com',
    };

    it('owns the three battle tables + publishes the shared battle SSM contract', () => {
      const app = new cdk.App();
      const stack = new BattleStack(app, 'AgentEchelonBattle', { ...battleProps });
      const template = Template.fromStack(stack);

      // BattleState, ChannelBattleConfig, BattleOutcome.
      template.resourceCountIs('AWS::DynamoDB::Table', 3);

      // Publishes the battle SSM the per-tier stacks resolve.
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/shared/tables/battle-state-arn',
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/shared/battle-orchestrator-arn',
      });
      // Alt-bot roster for channel-flow + admin-experiments.
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/alt-bot-slots/roster',
      });

      // Battle-owned Lex + alt-slots ride a custom resource each (Lex bot + 2
      // alt-slots), plus the channel-battle/outcome RestApi.
      template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    });

    it('does NOT resolve any tier processor at deploy (orchestrator invokes premium at runtime)', () => {
      const app = new cdk.App();
      const stack = new BattleStack(app, 'AgentEchelonBattle', { ...battleProps });
      const template = Template.fromStack(stack);
      // No Bedrock managed agents anywhere in the battle stack.
      template.resourceCountIs('AWS::Bedrock::Agent', 0);
    });

    it('the battle-outcome role grants dynamodb:UpdateItem (votes-map nested writes), not just PutItem', () => {
      // recordBattleOutcome writes the per-user votes map with nested-path UpdateExpressions
      // (`SET votes = if_not_exists(...)` then `SET votes.<sub> = ...`), so the outcome Lambda's role
      // MUST grant UpdateItem - a Put-only grant AccessDenies the pick write and the API returns 503.
      const template = Template.fromStack(new BattleStack(new cdk.App(), 'AgentEchelonBattle', { ...battleProps }));
      const roles = Object.values(template.findResources('AWS::IAM::Role'));
      const statements = roles.flatMap((r: any) =>
        (r.Properties?.Policies ?? []).flatMap((p: any) => p.PolicyDocument?.Statement ?? []));
      const grantsUpdateItem = statements.some((s: any) =>
        (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('dynamodb:UpdateItem'));
      expect(grantsUpdateItem).toBe(true);
    });
  });

  // ── SPEC-ABUSE-CONTROLS: the channel-flow dispatch paths are metered too ──
  // @all/@assistant mentions and /battle fan-outs are dispatched by the channel-flow
  // processor BEFORE the Lex router that gates the 1:1 tier turn. Without an abuse gate
  // here, a group channel is a budget-bypass path to the model. The processor must carry
  // the ABUSE_CONTROLS_TABLE env AND a DynamoDB write grant on the control table so the
  // rate-limit / budget counters can bump. Regression guard for that wiring.
  describe('Channel-flow stack — abuse gate wiring (SPEC-ABUSE-CONTROLS)', () => {
    const channelFlowProps = {
      env,
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
    };

    it('the channel-flow processor carries ABUSE_CONTROLS_TABLE env + a DynamoDB write grant', () => {
      const template = Template.fromStack(
        new ChannelFlowStack(new cdk.App(), 'AgentEchelonChannelFlow', { ...channelFlowProps }));

      // The processor Lambda carries the shared control-table env (enforceAbuseGate reads it).
      const fns = Object.values(template.findResources('AWS::Lambda::Function')) as Array<{
        Properties?: { Environment?: { Variables?: Record<string, unknown> } };
      }>;
      const withAbuse = fns.filter((f) => f.Properties?.Environment?.Variables?.ABUSE_CONTROLS_TABLE !== undefined);
      expect(withAbuse.length).toBeGreaterThanOrEqual(1);

      // The rate-limit / budget counters need DynamoDB UpdateItem on the control table.
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).toContain('dynamodb:UpdateItem');
    });

    it('@all routes by channel classification: processor carries basic + standard + premium ARNs (F1)', () => {
      // @all is generated at the CHANNEL's classification, so the channel-flow processor must be able to
      // invoke the basic, standard, AND premium processors - not just standard. Without BASIC_*, an @all
      // in a basic channel would run on the standard processor and broadcast standard-tier company
      // context into a lower channel.
      const template = Template.fromStack(
        new ChannelFlowStack(new cdk.App(), 'AgentEchelonChannelFlow', { ...channelFlowProps }));
      const fns = Object.values(template.findResources('AWS::Lambda::Function')) as Array<{
        Properties?: { Environment?: { Variables?: Record<string, unknown> } };
      }>;
      const proc = fns.find((f) => f.Properties?.Environment?.Variables?.ASYNC_PROCESSOR_ARN !== undefined);
      expect(proc).toBeDefined();
      const vars = proc!.Properties!.Environment!.Variables!;
      expect(vars.BASIC_ASYNC_PROCESSOR_ARN).toBeDefined();
      expect(vars.ASYNC_PROCESSOR_ARN).toBeDefined();   // standard
      expect(vars.PREMIUM_ASYNC_PROCESSOR_ARN).toBeDefined();
    });

    it('budget + circuit stay OPT-IN on channel-flow: no circuit SSM grant without a global budget', () => {
      const template = Template.fromStack(
        new ChannelFlowStack(new cdk.App(), 'AgentEchelonChannelFlow', { ...channelFlowProps }));
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).not.toContain('/agent-echelon/abuse/circuit');

      const template2 = Template.fromStack(
        new ChannelFlowStack(new cdk.App({ context: { bedrockGlobalHourlyBudget: '800' } }),
          'AgentEchelonChannelFlow', { ...channelFlowProps }));
      const policies2 = JSON.stringify(template2.findResources('AWS::IAM::Policy'));
      expect(policies2).toContain('abuse/circuit');
    });
  });

  // ── SPEC-CONVERSATION-SECURITY Layer 1: channel-tag IAM allow-tests ───────
  // FAIL-CLOSED assertions: the synthesized per-tier role MUST carry an IAM
  // ALLOW on channel actions conditioned (StringEquals aws:ResourceTag/
  // classification) on exactly {its tier and below}. Untagged / higher-tier
  // channels → no Allow → implicit deny. The condition key MUST be the global
  // `aws:ResourceTag` (chime:ResourceTag is a no-op — proven by live deny-test).
  describe('Layer 1 — per-tier fail-closed channel-tag allow (SPEC-CONVERSATION-SECURITY §4)', () => {
    const appInstanceArn = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';
    const props = {
      env,
      appInstanceArn,
      attachmentsBucketName: 'agent-echelon-attachments-test',
      attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
      profileModelSelection: DEFAULT_PROFILE_MODEL_SELECTION,
    };

    // Pull every IAM policy statement out of the synthesized template.
    const allStatements = (template: Template): any[] => {
      const policies = template.findResources('AWS::IAM::Policy');
      const roles = template.findResources('AWS::IAM::Role');
      const out: any[] = [];
      for (const r of [...Object.values(policies), ...Object.values(roles)]) {
        const doc =
          (r as any).Properties?.PolicyDocument ||
          (r as any).Properties?.Policies?.flatMap((p: any) => p.PolicyDocument?.Statement || []);
        const stmts = doc?.Statement || (Array.isArray(doc) ? doc : []);
        if (Array.isArray(stmts)) out.push(...stmts);
      }
      return out;
    };

    // Tier-gated ALLOWs: Effect Allow + a StringEquals on the classification tag.
    const tierGatedAllows = (template: Template): any[] =>
      allStatements(template).filter(
        (s) =>
          s.Effect === 'Allow' &&
          s.Condition?.StringEquals?.['aws:ResourceTag/classification'] !== undefined,
      );
    // Resource ARN suffixes (handles plain strings + Fn::Join tokens).
    const resourceSuffixes = (res: any): string[] => {
      const arr = Array.isArray(res) ? res : [res];
      const out: string[] = [];
      for (const r of arr) {
        if (typeof r === 'string') out.push(r);
        else if (r && r['Fn::Join']) {
          const parts = r['Fn::Join'][1];
          const last = parts[parts.length - 1];
          if (typeof last === 'string') out.push(last);
        }
      }
      return out;
    };
    // An unconditioned SendChannelMessage Allow that reaches CHANNEL resources
    // (suffix `/channel/*` or the bare `/*` wildcard) is a fail-open hole. An
    // unconditioned send on the BEARER resource (`/user/*`, `/bot/*`) is REQUIRED
    // (Chime authorizes channel actions against the bearer too) and is NOT a hole.
    const unconditionedChannelSendAllows = (template: Template): any[] =>
      allStatements(template).filter((s) => {
        if (s.Effect !== 'Allow' || s.Condition) return false;
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (!actions.includes('chime:SendChannelMessage')) return false;
        return resourceSuffixes(s.Resource).some((x) => x === '/channel/*' || x === '/*');
      });

    it('basic assistant: SendChannelMessage allowed ONLY on classification=basic (fail-closed)', () => {
      const app = new cdk.App();
      const template = Template.fromStack(new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', props));
      const allows = tierGatedAllows(template);
      expect(allows.length).toBeGreaterThanOrEqual(1);
      expect(allows[0].Condition.StringEquals['aws:ResourceTag/classification']).toEqual(['basic']);
      expect(allows[0].Action).toContain('chime:SendChannelMessage');
      // No fail-open broad SendChannelMessage allow.
      expect(unconditionedChannelSendAllows(template)).toHaveLength(0);
    });

    it('standard assistant: channel actions allowed on classification ∈ {basic, standard}', () => {
      const app = new cdk.App();
      const template = Template.fromStack(new StandardClassificationStack(app, 'AgentEchelonClassification-Standard', props));
      const allows = tierGatedAllows(template);
      expect(allows.length).toBeGreaterThanOrEqual(1);
      expect(allows[0].Condition.StringEquals['aws:ResourceTag/classification']).toEqual([
        'basic',
        'standard',
      ]);
      expect(unconditionedChannelSendAllows(template)).toHaveLength(0);
    });

    it('premium assistant: channel actions allowed on classification ∈ {basic, standard, premium}, still fail-closed', () => {
      const app = new cdk.App();
      const template = Template.fromStack(new PremiumClassificationStack(app, 'AgentEchelonClassification-Premium', props));
      const allows = tierGatedAllows(template);
      expect(allows.length).toBeGreaterThanOrEqual(1);
      expect(allows[0].Condition.StringEquals['aws:ResourceTag/classification']).toEqual([
        'basic',
        'standard',
        'premium',
      ]);
      // Even the top tier has no unconditioned SendChannelMessage allow (an
      // untagged channel must not be silently reachable).
      expect(unconditionedChannelSendAllows(template)).toHaveLength(0);
    });

    it('user-side: exchange rungs fail-closed (basic→{basic}, standard→{basic,standard}, premium→all); legacy Identity-Pool roles grant NO Chime', () => {
      const app = new cdk.App();
      const chime = new ChimeMessagingStack(app, 'TestChimeL1', { env, appInstanceName: 'test-instance' });
      const template = Template.fromStack(
        new CognitoAuthStack(app, 'TestCognitoL1', { env, appInstanceArn: chime.appInstanceArn }),
      );
      const tierSets = tierGatedAllows(template)
        .map((d) => d.Condition.StringEquals['aws:ResourceTag/classification'])
        .sort((a, b) => a.length - b.length);
      expect(tierSets).toContainEqual(['basic']);
      expect(tierSets).toContainEqual(['basic', 'standard']);
      expect(tierSets).toContainEqual(['basic', 'standard', 'premium']);
      // The Identity-Pool authenticated roles grant no Chime at all. So the ONLY
      // tier-gated allows come from the bearer-pinned Credential-Exchange rungs
      // (SPEC-CREDENTIAL-EXCHANGE): exactly 3, one classification set each.
      // (restricted/guest + admin exchange rungs use UNCONDITIONED channel/* allows.)
      expect(tierSets).toHaveLength(3);
      expect(tierSets.filter((s) => s.length === 1)).toHaveLength(1);       // basic ×1
      expect(tierSets.filter((s) => s.length === 3)).toHaveLength(1);       // premium ×1
      expect(unconditionedChannelSendAllows(template).length).toBeGreaterThanOrEqual(1); // admin(s) + restricted exchange rung
    });

    it('user-side: identity pool uses Token-based role mapping and every tier group has a roleArn', () => {
      const app = new cdk.App();
      const chime = new ChimeMessagingStack(app, 'TestChimeL2', { env, appInstanceName: 'test-instance' });
      const template = Template.fromStack(
        new CognitoAuthStack(app, 'TestCognitoL2', { env, appInstanceArn: chime.appInstanceArn }),
      );
      template.hasResourceProperties('AWS::Cognito::IdentityPoolRoleAttachment', {
        RoleMappings: {
          cognitoProvider: { Type: 'Token', AmbiguousRoleResolution: 'AuthenticatedRole' },
        },
      });
      const groups = template.findResources('AWS::Cognito::UserPoolGroup');
      const withRole = Object.values(groups).filter(
        (g: any) => g.Properties?.RoleArn !== undefined,
      );
      expect(withRole).toHaveLength(4); // basic, standard, premium, admins
    });
  });

  describe('Layer 4 / §7 — IAM resource boundaries (deny-by-absence, SPEC-CONVERSATION-SECURITY §4)', () => {
    const appInstanceArn = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';
    const bucketArn = 'arn:aws:s3:::agent-echelon-attachments-test';
    const props = {
      env,
      appInstanceArn,
      attachmentsBucketName: 'agent-echelon-attachments-test',
      attachmentsBucketArn: bucketArn,
      profileModelSelection: DEFAULT_PROFILE_MODEL_SELECTION,
    };

    // Every IAM statement in the synthesized template (inline role policies + AWS::IAM::Policy).
    const allStatements = (template: Template): any[] => {
      const policies = template.findResources('AWS::IAM::Policy');
      const roles = template.findResources('AWS::IAM::Role');
      const out: any[] = [];
      for (const r of [...Object.values(policies), ...Object.values(roles)]) {
        const doc =
          (r as any).Properties?.PolicyDocument ||
          (r as any).Properties?.Policies?.flatMap((p: any) => p.PolicyDocument?.Statement || []);
        const stmts = doc?.Statement || (Array.isArray(doc) ? doc : []);
        if (Array.isArray(stmts)) out.push(...stmts);
      }
      return out;
    };

    // Flatten an IAM resource / condition entry (plain string OR an Fn::Join token) to one
    // searchable string, so `context/premium/` and the SSM-resolved channel-context ARN match
    // whether CDK emitted a literal or a Join.
    const flat = (r: any): string => {
      if (typeof r === 'string') return r;
      if (r && r['Fn::Join']) return (r['Fn::Join'][1] as any[]).map((p) => (typeof p === 'string' ? p : '')).join('');
      if (r && r.Ref) return String(r.Ref);
      return '';
    };
    const actionsOf = (s: any): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);
    const asArr = (x: any): any[] => (Array.isArray(x) ? x : x === undefined ? [] : [x]);
    // The channel-context resource is an SSM `valueForStringParameter` → a CfnParameter `Ref` whose
    // logical id sanitizes the param name (`…channel-context-arn` → `…channelcontextarn`). Normalize
    // (drop non-alphanumerics, lowercase) so the match holds whether the resource is the param name or
    // the Ref logical id.
    const isChannelContextRes = (r: string): boolean => r.replace(/[^a-z0-9]/gi, '').toLowerCase().includes('channelcontext');

    // Resource strings reachable by an `s3:GetObject` Allow.
    const getObjectResources = (t: Template): string[] =>
      allStatements(t)
        .filter((s) => s.Effect === 'Allow' && actionsOf(s).includes('s3:GetObject'))
        .flatMap((s) => asArr(s.Resource).map(flat));
    // s3:prefix values in a `s3:ListBucket` StringLike condition.
    const listBucketPrefixes = (t: Template): string[] =>
      allStatements(t)
        .filter((s) => s.Effect === 'Allow' && actionsOf(s).includes('s3:ListBucket'))
        .flatMap((s) => asArr(s.Condition?.StringLike?.['s3:prefix']).map(flat));
    const hasContext = (arr: string[], c: string): boolean => arr.some((x) => x.includes(`context/${c}/`));

    // ── S3 context prefix boundary (Layer 4). The single most load-bearing security claim:
    //    a classification's assistant role CANNOT read a higher classification's context/.
    //    Deny-by-absence — widening ContextS3Read to include context/premium/ breaks this. ──
    it('basic assistant: context S3 read includes context/basic/ and EXCLUDES standard + premium', () => {
      const t = Template.fromStack(new BasicClassificationStack(new cdk.App(), 'AgentEchelonClassification-Basic', props));
      const gets = getObjectResources(t);
      const lists = listBucketPrefixes(t);
      expect(hasContext(gets, 'basic')).toBe(true);
      expect(hasContext(gets, 'standard')).toBe(false);
      expect(hasContext(gets, 'premium')).toBe(false);
      expect(hasContext(lists, 'basic')).toBe(true);
      expect(hasContext(lists, 'standard')).toBe(false);
      expect(hasContext(lists, 'premium')).toBe(false);
    });

    it('standard assistant: context S3 read includes basic + standard and EXCLUDES premium', () => {
      const t = Template.fromStack(new StandardClassificationStack(new cdk.App(), 'AgentEchelonClassification-Standard', props));
      const gets = getObjectResources(t);
      expect(hasContext(gets, 'basic')).toBe(true);
      expect(hasContext(gets, 'standard')).toBe(true);
      expect(hasContext(gets, 'premium')).toBe(false);
    });

    it('premium assistant: context S3 read includes basic + standard + premium (top of the ladder)', () => {
      const t = Template.fromStack(new PremiumClassificationStack(new cdk.App(), 'AgentEchelonClassification-Premium', props));
      const gets = getObjectResources(t);
      expect(hasContext(gets, 'basic')).toBe(true);
      expect(hasContext(gets, 'standard')).toBe(true);
      expect(hasContext(gets, 'premium')).toBe(true);
    });

    // ── Channel Context store grant boundary. The assistant role may READ (GetItem) and PATCH
    //    (UpdateItem) and NOTHING ELSE. The private host grounding is never replaceable wholesale,
    //    deletable, or scannable by this role.
    //
    //    UpdateItem is here because the drift-confirm flow CREATES conversations from inside this Lambda
    //    (`lib/channel-creation.ts`) and must record the participant shape before the channel exists, so the
    //    new conversation gets the same composed welcome as any other (SPEC-USER-PROFILE-AND-ONBOARDING §2).
    //    The assertion below is the part that still matters: PutItem would let a turn replace another
    //    conversation's whole grounding item rather than patch the fields this store owns, and Scan/Query
    //    would let it read across conversations. Those stay forbidden. ──
    const channelContextStatements = (t: Template): any[] =>
      allStatements(t).filter(
        (s) => s.Effect === 'Allow' && asArr(s.Resource).map(flat).some(isChannelContextRes),
      );

    it('assistant role holds only GetItem + UpdateItem on the channel-context store (never replace/delete/scan)', () => {
      const t = Template.fromStack(new PremiumClassificationStack(new cdk.App(), 'AgentEchelonClassification-Premium', props));
      const ccStmts = channelContextStatements(t);
      expect(ccStmts.length).toBeGreaterThanOrEqual(1);
      const actions = new Set(ccStmts.flatMap(actionsOf));
      // Read for per-turn grounding; patch for the pre-creation participant write on the drift path.
      expect(actions.has('dynamodb:GetItem')).toBe(true);
      expect(actions.has('dynamodb:UpdateItem')).toBe(true);
      // PutItem is the one that matters most here: UpdateItem patches the fields this store owns, while
      // PutItem would let a single turn REPLACE another conversation's entire grounding item. Scan/Query
      // would let it read across conversations.
      for (const forbidden of ['dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:Query', 'dynamodb:BatchWriteItem']) {
        expect(actions.has(forbidden)).toBe(false);
      }
      expect(actions.has('dynamodb:*')).toBe(false);
    });

    // ── The private host-grounding store is NEVER reachable by an end-user / Identity-Pool
    //    principal — its only readers/writers are server-side Lambda roles. Assert absence in
    //    the Cognito auth stack (which owns the Identity-Pool auth/unauth + per-clearance roles). ──
    it('Cognito / Identity-Pool roles grant NO access to the channel-context store (member-unreadable)', () => {
      const app = new cdk.App();
      const chime = new ChimeMessagingStack(app, 'TestChimeCC', { env, appInstanceName: 'test-instance' });
      const t = Template.fromStack(new CognitoAuthStack(app, 'TestCognitoCC', { env, appInstanceArn: chime.appInstanceArn }));
      const referencesChannelContext = allStatements(t).some((s) =>
        asArr(s.Resource).map(flat).some(isChannelContextRes),
      );
      expect(referencesChannelContext).toBe(false);
    });

    // ── Guardrail selection boundary (§7 / 4.6b). A profile SELECTS a deployment-provisioned
    //    guardrail; it can never point at an arbitrary resource because the ApplyGuardrail grant
    //    is per-provisioned-ARN. Widening the grant to '*' (or a raw/arbitrary ARN) breaks this. ──
    it('assistant role can bedrock:ApplyGuardrail ONLY on in-stack provisioned guardrails, never * / arbitrary', () => {
      const t = Template.fromStack(new PremiumClassificationStack(new cdk.App(), 'AgentEchelonClassification-Premium', props));
      const applyStmts = allStatements(t).filter(
        (s) => s.Effect === 'Allow' && actionsOf(s).includes('bedrock:ApplyGuardrail'),
      );
      expect(applyStmts.length).toBeGreaterThanOrEqual(1);
      for (const s of applyStmts) {
        const resources = asArr(s.Resource);
        expect(resources.length).toBeGreaterThanOrEqual(1);
        for (const r of resources) {
          // Each resource must reference a guardrail provisioned in-stack (GetAtt or a constructed ARN
          // token that names a guardrail) — never a wildcard and never a raw arbitrary ARN a profile
          // could smuggle in. A `*` resource would carry no 'guardrail' token and fail here.
          expect(/guardrail/i.test(JSON.stringify(r))).toBe(true);
          expect(JSON.stringify(r)).not.toContain('*');
        }
      }
    });
  });
});

describe('deploy order honors SSM creator-before-reader (review finding 1)', () => {
  it('analytics depends on foundations, never the reverse', () => {
    // The Aurora stack resolves the shared channel-context SSM parameters at DEPLOY time, and
    // Foundations creates them. The reversed dependency this pins against shipped in the initial
    // commit with no consumer and made every fresh account's first deploy fail with "SSM parameter
    // not available" - while staying green on any account whose parameters already existed, which
    // is why no existing-deployment run could ever catch it.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'backend.ts'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/analyticsStack\.addDependency\(foundationsStack\)/);
    expect(src).not.toMatch(/foundationsStack\.addDependency\(analyticsStack\)/);
  });
});
