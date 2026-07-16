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
import { BasicTierStack } from '../lib/stacks/basic-tier-stack';
import { StandardTierStack } from '../lib/stacks/standard-tier-stack';
import { PremiumTierStack } from '../lib/stacks/premium-tier-stack';
import { BattleStack } from '../lib/stacks/battle-stack';
import { DEFAULT_TIER_MODEL_SELECTION } from '../lib/config/model-strategy';

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

    it('should create evaluation runner Lambda with daily schedule', () => {
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
      template.resourceCountIs('AWS::Events::Rule', 1);
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
    const tierBasicProps = {
      env,
      appInstanceArn,
      attachmentsBucketName: 'agent-echelon-attachments-test',
      attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
      tierModelSelection: DEFAULT_TIER_MODEL_SELECTION,
    };

    it('should synthesize AgentEchelonTier-Basic as an Option-D processor (no Bedrock Agent)', () => {
      const app = new cdk.App();
      const stack = new BasicTierStack(app, 'AgentEchelonTier-Basic', tierBasicProps);

      const template = Template.fromStack(stack);

      // The assistant is the async-processor, NOT a managed agent.
      template.resourceCountIs('AWS::Bedrock::Agent', 0);
      template.resourceCountIs('AWS::Bedrock::AgentAlias', 0);

      // One tier content guardrail (basic has no /battle image guardrail).
      template.resourceCountIs('AWS::Bedrock::Guardrail', 1);

      // Lex bot + AppInstanceBot custom resources.
      template.resourceCountIs('AWS::CloudFormation::CustomResource', 2);

      // SSM contract: processor-arn + bot-arn published for the shared router
      // and create-conversation to discover.
      template.resourceCountIs('AWS::SSM::Parameter', 2);
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/tier/basic/processor-arn',
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/tier/basic/bot-arn',
      });
    });

    it('should synthesize AgentEchelonTier-Standard resolving the shared SSM contract (no Bedrock Agent, no Fn::importValue)', () => {
      const app = new cdk.App();
      const stack = new StandardTierStack(app, 'AgentEchelonTier-Standard', tierBasicProps);

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
        Name: '/agent-echelon/tier/standard/processor-arn',
      });
    });

    it('should resolve the battle SSM contract ONLY when enableBattle is set (opt-in /battle)', () => {
      const app = new cdk.App();
      const stack = new StandardTierStack(app, 'AgentEchelonTier-Standard', {
        ...tierBasicProps,
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

    it('should synthesize AgentEchelonTier-Premium with text + image guardrails (no Bedrock Agent)', () => {
      const app = new cdk.App();
      const stack = new PremiumTierStack(app, 'AgentEchelonTier-Premium', tierBasicProps);

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::Bedrock::Agent', 0);
      // Premium owns the tier content guardrail + the /battle image guardrail.
      template.resourceCountIs('AWS::Bedrock::Guardrail', 2);
    });
  });

  // ── Live drift re-homing (Aurora mode): the per-tier handler gets VPC +
  //    Aurora/Titan IAM + the drift-confirm create-flow IAM, on ALL tiers.
  describe('Live drift wiring (Aurora hookup)', () => {
    const appInstanceArn = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';
    const tierBaseProps = {
      env,
      appInstanceArn,
      attachmentsBucketName: 'agent-echelon-attachments-test',
      attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
      tierModelSelection: DEFAULT_TIER_MODEL_SELECTION,
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
      const stack = new BasicTierStack(app, 'AgentEchelonTier-Basic', {
        ...tierBaseProps,
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
      const stack = new PremiumTierStack(app, 'AgentEchelonTier-Premium', {
        ...tierBaseProps,
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
      const stack = new BasicTierStack(app, 'AgentEchelonTier-Basic', {
        ...tierBaseProps,
        auroraDriftHookup: makeHookup(app),
      });
      const template = Template.fromStack(stack);
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      // The drift create-flow grants SendChannelMessage only alongside the
      // classification ResourceTag condition — never app-wide.
      expect(policies).toContain('aws:ResourceTag/classification');
    });

    it('wires abuse controls (SPEC-ABUSE-CONTROLS): table env + rate limit + length cap on both Lambdas, DynamoDB grant', () => {
      const app = new cdk.App();
      const stack = new BasicTierStack(app, 'AgentEchelonTier-Basic', { ...tierBaseProps });
      const template = Template.fromStack(stack);
      // Both the processor AND the handler carry the abuse env: the shared table, the tier rate
      // limit (default on), and the length cap. (Two functions match — assert at least the pair.)
      const fns = Object.values(template.findResources('AWS::Lambda::Function')) as Array<{
        Properties?: { Environment?: { Variables?: Record<string, unknown> } };
      }>;
      const withAbuse = fns.filter((f) => f.Properties?.Environment?.Variables?.ABUSE_CONTROLS_TABLE !== undefined);
      expect(withAbuse.length).toBeGreaterThanOrEqual(2); // processor + handler
      for (const f of withAbuse) {
        const v = f.Properties!.Environment!.Variables!;
        expect(v.RATE_LIMIT_BASIC).toBe('60'); // default-on per-tier ceiling
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
      const stack = new BasicTierStack(app, 'AgentEchelonTier-Basic', { ...tierBaseProps });
      const template = Template.fromStack(stack);
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).not.toContain('/agent-echelon/abuse/circuit'); // circuit unwired without a global budget

      // With a global budget set, the circuit SSM param + its PutParameter grant appear.
      const app2 = new cdk.App({ context: { bedrockGlobalHourlyBudget: '800' } });
      const stack2 = new BasicTierStack(app2, 'AgentEchelonTier-Basic', { ...tierBaseProps });
      const template2 = Template.fromStack(stack2);
      const policies2 = JSON.stringify(template2.findResources('AWS::IAM::Policy'));
      expect(policies2).toContain('ssm:PutParameter');
      expect(policies2).toContain('abuse/circuit');
    });

    it('assistant/handler roles bear BOTS only — no /user/* bearer ', () => {
      const app = new cdk.App();
      const stack = new PremiumTierStack(app, 'AgentEchelonTier-Premium', {
        ...tierBaseProps,
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
      const stack = new BasicTierStack(app, 'AgentEchelonTier-Basic', { ...tierBaseProps });
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
      allowedBattleTiers: ['premium' as const],
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
      tierModelSelection: DEFAULT_TIER_MODEL_SELECTION,
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
      const template = Template.fromStack(new BasicTierStack(app, 'AgentEchelonTier-Basic', props));
      const allows = tierGatedAllows(template);
      expect(allows.length).toBeGreaterThanOrEqual(1);
      expect(allows[0].Condition.StringEquals['aws:ResourceTag/classification']).toEqual(['basic']);
      expect(allows[0].Action).toContain('chime:SendChannelMessage');
      // No fail-open broad SendChannelMessage allow.
      expect(unconditionedChannelSendAllows(template)).toHaveLength(0);
    });

    it('standard assistant: channel actions allowed on classification ∈ {basic, standard}', () => {
      const app = new cdk.App();
      const template = Template.fromStack(new StandardTierStack(app, 'AgentEchelonTier-Standard', props));
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
      const template = Template.fromStack(new PremiumTierStack(app, 'AgentEchelonTier-Premium', props));
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
});
