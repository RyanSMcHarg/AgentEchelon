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
import { MessagingStack } from '../lib/stacks/messaging-stack';
import { ArchiveStack } from '../lib/stacks/archive-stack';
import { IdentityStack } from '../lib/stacks/identity-stack';
import { DEFAULT_PROFILES_CONFIG, assistantClassifications } from '../lib/config/profiles';
import { ProfileRegistry, defaultProfileRegistry } from '../lib/profile-registry';
import { scopeFunctionSql } from '../lambda/src/analytics-aurora/classification-boundary-sql';
import { BattleStack } from '../lib/stacks/battle-stack';
import { ChannelFlowStack } from '../lib/stacks/channel-flow-stack';
import { MESSAGE_RETENTION_DAYS } from '../lib/config/conversation-types';
import { STACK_PREFIX } from '../lib/stacks/agent-classification-common';
import { assistantsOf } from './helpers/assistants';
import { adminServicesTemplate, testMessageStream } from './helpers/synth';

describe('CDK Synthesis', () => {
  const env = { account: '123456789012', region: 'us-east-1' };

  /**
   * IDENTITY AND EVERY CONVERSATIONAL MEMBER CLASSIFICATION'S OWN STACK, as bin builds them. A person's vend roles
   * are Identity's (the one-conversation role and the admin plane's chat identity) and each classification
   * stack's own (`ExchangeRole`, `lib/constructs/exchange-role.ts`), and so are the clearance groups. Built once.
   */
  type VendRole = { token: string; id: string; template: Template };
  let vendCache: { identityStack: IdentityStack; identity: Template; classifications: Template[]; roles: VendRole[] } | undefined;
  const vendApp = () => (vendCache ??= (() => {
    const app = new cdk.App();
    const chime = new MessagingStack(app, 'TestChimeVend', { env, appInstanceName: 'test-instance' });
    const identityStack = new IdentityStack(app, 'TestCognitoVend', { env, appInstanceArn: chime.appInstanceArn });
    const conversational = defaultProfileRegistry.memberClassificationValues().filter((c) => defaultProfileRegistry.isConversational(c));
    const stacks = conversational.map((c) => assistantsOf(c)(app, `TestAssistantsVend-${c}`, {
      env, appInstanceArn: chime.appInstanceArn, attachmentsBucketName: 'test-bucket', attachmentsBucketArn: 'arn:aws:s3:::test-bucket',
      credentialExchangeRoleArn: identityStack.credentialExchangeRoleArn,
    } as never));
    const identity = Template.fromStack(identityStack);
    const classifications = stacks.map((st) => Template.fromStack(st));
    const roles: VendRole[] = [];
    for (const template of [identity, ...classifications]) {
      for (const [id, role] of Object.entries(template.findResources('AWS::IAM::Role')) as Array<[string, any]>) {
        const m = /-exchange-(.+)$/.exec(String(role.Properties?.RoleName ?? ''));
        if (m) roles.push({ token: m[1], id, template });
      }
    }
    return { identityStack, identity, classifications, roles };
  })());
  /** Only the vend roles' own resources (each role, its policies and its boundary), as one template. */
  const vendTemplate = (): Template => {
    const resources: Record<string, unknown> = {};
    const { identity, classifications } = vendApp();
    [identity, ...classifications].forEach((t, i) => {
      for (const [id, res] of Object.entries((t.toJSON() as { Resources: Record<string, unknown> }).Resources)) {
        if (id.startsWith('ExchangeRole')) resources[`S${i}${id}`] = res;
      }
    });
    return Template.fromJSON({ Resources: resources });
  };
  /** Every identity-policy statement of one vend role: inline, and each `AWS::IAM::Policy` naming it. */
  const vendStatements = (r: VendRole): Array<{ Effect?: string; Action: unknown; Resource?: unknown; Condition?: any }> => {
    const role = r.template.findResources('AWS::IAM::Role')[r.id] as any;
    const inline = (role.Properties.Policies ?? []).flatMap((x: any) => x.PolicyDocument.Statement);
    const attached = (Object.values(r.template.findResources('AWS::IAM::Policy')) as any[])
      .filter((x) => (x.Properties.Roles ?? []).some((ref: any) => ref.Ref === r.id))
      .flatMap((x) => x.Properties.PolicyDocument.Statement);
    return [...inline, ...attached];
  };
  const vendRole = (token: string): VendRole => {
    const found = vendApp().roles.filter((r) => r.token === token);
    expect(found).toHaveLength(1);
    return found[0];
  };

  describe('Athena mode (default)', () => {
    it('should synthesize the Chime Messaging stack', () => {
      const app = new cdk.App();
      const stack = new MessagingStack(app, 'TestChime', {
        env,
        appInstanceName: 'test-instance',
      });

      const template = Template.fromStack(stack);
      // Three CloudFormation custom resources: the MessagingAppInstance; the
      // app-instance-admin (CreateAppInstanceAdminResource — registers the
      // service admin user used by the admin-console moderation surface,
      // published to SSM /agent-echelon/app-instance-admin-arn); and the
      // retention limit (SetAppInstanceRetentionResource — sets the
      // app-instance message retention that binds EVERY channel, so the bound
      // does not depend on which of the creation paths checked it).
      template.resourceCountIs('AWS::CloudFormation::CustomResource', 3);

      // The limit is the declared constant, not a literal, and it is a resource
      // property so lowering it triggers the resource rather than leaving the
      // deployed limit behind the declared one.
      template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
        RetentionDays: MESSAGE_RETENTION_DAYS,
      });
    });

    it("should synthesize the Archive stack with Firehose, on the Messaging stack's stream", () => {
      const app = new cdk.App();
      const chime = new MessagingStack(app, 'TestChime', {
        env,
        appInstanceName: 'test-instance',
      });
      const stack = new ArchiveStack(app, 'TestArchive', {
        env,
        appInstanceArn: chime.appInstanceArn,
        messageStream: chime.messageStream,
        // /events is fail-closed: the stack requires a user pool to authorize it.
        userPool: cognito.UserPool.fromUserPoolId(chime, 'TestPool', 'us-east-1_TestPool'),
      });

      const template = Template.fromStack(stack);
      // The stream is the Messaging stack's: the archive consumes it and creates none.
      template.resourceCountIs('AWS::Kinesis::Stream', 0);
      Template.fromStack(chime).resourceCountIs('AWS::Kinesis::Stream', 1);
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
    it('the message Kinesis stream is DESTROY outside production, so a teardown cannot orphan it', () => {
      const app = new cdk.App();
      const chime = new MessagingStack(app, 'TestChime', { env, appInstanceName: 'test-instance' });
      const template = Template.fromStack(chime);
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
      const chime = new MessagingStack(app, 'TestChime', { env, appInstanceName: 'test-instance' });
      Template.fromStack(chime).hasResourceProperties('AWS::IAM::Policy', {
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
      const chime = new MessagingStack(app, 'TestChime', {
        env,
        appInstanceName: 'test-instance',
      });
      const stack = new ArchiveStack(app, 'TestArchive', {
        env,
        appInstanceArn: chime.appInstanceArn,
        messageStream: chime.messageStream,
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
      const chime = new MessagingStack(app, 'TestChime', { env, appInstanceName: 'test-instance' });
      const stack = new ArchiveStack(app, 'TestArchive', {
        env,
        appInstanceArn: chime.appInstanceArn,
        messageStream: chime.messageStream,
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
      const chime = new MessagingStack(app, 'TestChime', {
        env,
        appInstanceName: 'test-instance',
      });
      const stack = new ArchiveStack(app, 'TestArchive', {
        env,
        appInstanceArn: chime.appInstanceArn,
        messageStream: chime.messageStream,
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
    // Note: ArchiveStackAurora is a heavier stack that requires more setup.
    // These tests verify the stack can be instantiated without errors.
    // Full resource assertions require the Aurora stack import.

    it('should import ArchiveStackAurora without errors', async () => {
      const { ArchiveStackAurora } = await import('../lib/stacks/archive-stack-aurora');
      expect(ArchiveStackAurora).toBeDefined();
    });

    it('should synthesize the Aurora archive stack', async () => {
      const { ArchiveStackAurora } = await import('../lib/stacks/archive-stack-aurora');
      const app = new cdk.App();
      const stack = new ArchiveStackAurora(app, 'TestArchiveAurora', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        messageStream: testMessageStream(app),
        userPoolId: 'us-east-1_TestPoolId',
      });

      const template = Template.fromStack(stack);

      // VPC resources
      template.resourceCountIs('AWS::EC2::VPC', 1);

      // Aurora resources
      template.resourceCountIs('AWS::RDS::DBCluster', 1);

      // No stream of its own: it consumes the Messaging stack's, as the Athena archive does.
      template.resourceCountIs('AWS::Kinesis::Stream', 0);
    });

    // The stream policy is keyed on the one environment value (lib/config/environment.ts), so BOTH sides
    // are pinned: a dev teardown must clean the stream up, and production must still retain it.
    it('production: the message Kinesis stream is RETAINed (the conditional works both ways)', () => {
      const app = new cdk.App({ context: { environment: 'production' } });
      const chime = new MessagingStack(app, 'TestChime', { env, appInstanceName: 'test-instance' });
      Template.fromStack(chime).hasResource('AWS::Kinesis::Stream', {
        DeletionPolicy: 'Retain',
      });
    });

    it('refuses an environment it does not know, so production is never spelled into DESTROY', () => {
      const app = new cdk.App({ context: { environment: 'prod' } });
      expect(() => new MessagingStack(app, 'TestChime', { env, appInstanceName: 'test-instance' })).toThrow(/"dev" or "production"/);
    });

    it('does not create an RDS Proxy by default (avoids the 8-ACU minimum)', async () => {
      const { ArchiveStackAurora } = await import('../lib/stacks/archive-stack-aurora');
      const app = new cdk.App();
      const stack = new ArchiveStackAurora(app, 'TestAuroraNoProxy', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        messageStream: testMessageStream(app),
        userPoolId: 'us-east-1_TestPoolId',
      });
      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::RDS::DBProxy', 0);
    });

    it('creates an RDS Proxy when enableRdsProxy=true', async () => {
      const { ArchiveStackAurora } = await import('../lib/stacks/archive-stack-aurora');
      const app = new cdk.App();
      const stack = new ArchiveStackAurora(app, 'TestAuroraProxy', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        messageStream: testMessageStream(app),
        userPoolId: 'us-east-1_TestPoolId',
        enableRdsProxy: true,
      });
      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::RDS::DBProxy', 1);
    });

    it('should create Aurora with IAM authentication enabled', async () => {
      const { ArchiveStackAurora } = await import('../lib/stacks/archive-stack-aurora');
      const app = new cdk.App();
      const stack = new ArchiveStackAurora(app, 'TestArchiveAurora', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        messageStream: testMessageStream(app),
        userPoolId: 'us-east-1_TestPoolId',
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        EnableIAMDatabaseAuthentication: true,
        StorageEncrypted: true,
      });
    });

    it('should create VPC with no NAT gateways', async () => {
      const { ArchiveStackAurora } = await import('../lib/stacks/archive-stack-aurora');
      const app = new cdk.App();
      const stack = new ArchiveStackAurora(app, 'TestArchiveAurora', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        messageStream: testMessageStream(app),
        userPoolId: 'us-east-1_TestPoolId',
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
    });

    it('should create VPC endpoints for Kinesis, S3, SecretsManager, and Bedrock', async () => {
      const { ArchiveStackAurora } = await import('../lib/stacks/archive-stack-aurora');
      const app = new cdk.App();
      const stack = new ArchiveStackAurora(app, 'TestArchiveAurora', {
        env,
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        messageStream: testMessageStream(app),
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
        const { ArchiveStackAurora } = await import(
          '../lib/stacks/archive-stack-aurora'
        );
        const app = new cdk.App({ context: vpcContext });
        return new ArchiveStackAurora(app, id, {
          env,
          appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
          messageStream: testMessageStream(app),
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
        const { ArchiveStackAurora } = await import(
          '../lib/stacks/archive-stack-aurora'
        );
        const app = new cdk.App();
        expect(
          () =>
            new ArchiveStackAurora(app, 'TestAuroraBadEp', {
              env,
              appInstanceArn:
                'arn:aws:chime:us-east-1:123456789012:app-instance/test',
              messageStream: testMessageStream(app),
              userPoolId: 'us-east-1_TestPoolId',
              createVpcEndpoints: false,
            }),
        ).toThrow(/only valid with an imported/);
      });
    });
  });

  /**
   * EVERY GENERATED CLASSIFICATION CONDITION IS THE HOLDER'S GRANT SET, IN EVERY STACK.
   *
   * Three files generate `aws:ResourceTag/classification` conditions - `agent-classification-common`
   * (the shared builder), `identity-stack` (the per-classification exchange roles) and
   * `assistant-profile-stack` (the assistant's own channel + S3 reach). They all derive the permitted
   * list from `classificationsAllowedFor`, which now answers the HOLDER question (`grantsFor`) rather
   * than the ORDER question (`scopeAtOrBelow`).
   *
   * ── WHY THIS IS A GUARD AND NOT A COMMENT ───────────────────────────────────────────────────────
   *
   * The two answers are IDENTICAL until a deployment declares `grants`, so nothing observable
   * separates them today - and a config that is only half-deployed is therefore silent. If someone
   * adds a non-contiguous grant set and redeploys only some of these stacks, one half of the platform
   * reaches a set and the other half reaches a rank prefix, with no error anywhere and a boundary that
   * means two different things depending on which policy evaluated the request.
   *
   * So the assertion is made against a config that ACTUALLY DECLARES a grant set that rank could never
   * produce. A stack still deriving from rank fails here rather than at whatever hour somebody notices
   * a conversation they should not be able to open.
   */
  describe('the classification condition is the grant set, not a rank prefix', () => {
    /**
     * Every permitted-classification list in a synthesized template. A `Null` test on the tag ("carries a
     * classification", how a shared role reaches every classification without a list) names no value and is
     * counted separately (`taggedAnyCount`); a negated operator names what is excluded, not what is permitted.
     */
    const conditionsOf = (template: Template): Record<string, Record<string, unknown>>[] => {
      const out: Record<string, Record<string, unknown>>[] = [];
      const walk = (x: unknown): void => {
        if (!x || typeof x !== 'object') return;
        const o = x as Record<string, unknown>;
        if (o.Condition && typeof o.Condition === 'object') out.push(o.Condition as Record<string, Record<string, unknown>>);
        for (const v of Object.values(o)) walk(v);
      };
      walk(template.toJSON());
      return out;
    };
    const KEY = 'aws:ResourceTag/classification';
    const permittedLists = (template: Template): string[][] => conditionsOf(template).flatMap((c) => Object.entries(c)
      .filter(([op, keys]) => op !== 'Null' && !op.startsWith('StringNot') && !!keys && typeof keys === 'object' && KEY in keys)
      .map(([, keys]) => ([] as unknown[]).concat((keys as Record<string, unknown>)[KEY]).map(String)));
    const taggedAnyCount = (template: Template): number => conditionsOf(template)
      .filter((c) => (c.Null as Record<string, unknown> | undefined)?.[KEY] === 'false').length;

    it('derives the exchange role conditions from grantsFor, in the deployed shape', () => {
      // The vend roles, wherever each is built: Identity's and each classification stack's own.
      const lists = permittedLists(vendTemplate());

      // Non-vacuous: the scan must actually find conditions.
      expect(lists.length).toBeGreaterThan(0);

      // Every list is some classification's grant set - never an arbitrary subset, never a list containing
      // a value no classification grants, and never every declared classification at once: a service grant
      // that acts in every conversation (offboarding, the outside classification's included) says so by the
      // tag being present, with no list, so declaring a classification changes no shared grant.
      const known = new Set(defaultProfileRegistry.classificationValues().map((v) => defaultProfileRegistry.grantsFor(v).join(',')));
      for (const list of lists) {
        expect(known).toContain([...list].join(','));
      }
      const everyDeclared = [...defaultProfileRegistry.classificationValues()].sort().join(',');
      expect(lists.map((l) => [...l].sort().join(','))).not.toContain(everyDeclared);
      // And Identity's service grants that act in every conversation say so by the tag being present.
      expect(permittedLists(vendApp().identity).map((l) => [...l].sort().join(','))).not.toContain(everyDeclared);
      expect(taggedAnyCount(vendApp().identity)).toBeGreaterThan(0);

      // And the standard role specifically reaches basic+standard, which is the shape a reader of the
      // deployed policy sees. Pinned so a silent widening is visible here.
      expect(lists.map((l) => l.join(','))).toContain(defaultProfileRegistry.grantsFor('standard').join(','));
    });

    it('FAILS a stack still deriving from rank, once a non-contiguous grant set exists', () => {
      // The regression this file exists for, shown to be detectable rather than asserted to be.
      // `premium` granting basic+premium but NOT standard is unreachable through any rank comparison,
      // so a rank-derived generator produces [basic,standard,premium] and a grant-derived one produces
      // [basic,premium]. If those two ever stop differing, this test has stopped proving anything.
      const ranked = new ProfileRegistry(DEFAULT_PROFILES_CONFIG);
      const granted = new ProfileRegistry({
        ...DEFAULT_PROFILES_CONFIG,
        classifications: DEFAULT_PROFILES_CONFIG.classifications.map((c) => (
          c.value === 'premium' ? { ...c, grants: ['basic', 'premium'] } : c
        )),
      });
      expect(granted.grantsFor('premium')).toEqual(['basic', 'premium']);
      // THE RANK-DERIVED ANSWER IS THE FULL PREFIX, and `standard` is the element that carries the
      // whole comparison: the grant set above deliberately omits it, so a generator still deriving
      // from rank includes it and one deriving from grants does not. Asserted by that property rather
      // than by a written-out array, because the array changes whenever the deployment's
      // classification set does - `probe` was removed on 2026-09-17 and a literal list turned this
      // guard into a failure about bookkeeping instead of about rank-versus-grants.
      expect(ranked.grantsFor('premium')).toContain('standard');
      expect(granted.grantsFor('premium')).not.toContain('standard');
      expect(granted.grantsFor('premium')).not.toEqual(ranked.grantsFor('premium'));
    });

    it('derives the Aurora RLS scope from the SAME set as IAM', () => {
      // THE THIRD GENERATOR, and the one this guard originally missed. `scopeFunctionSql` builds
      // `ae_classification_scope`, which is what the per-classification database reader roles are
      // narrowed by - the data-plane half of the same boundary IAM enforces on channels.
      //
      // It read `scopeAtOrBelow` while the other two moved to `grantsFor`. Identical for a ladder, and
      // divergent under a non-contiguous grant set: IAM admits the holder to a channel, the RLS scope
      // withholds that classification from their reader role, and retrieval returns nothing with no
      // error. Asserted against a config that actually declares such a set, so agreement by
      // coincidence cannot pass.
      const granted = new ProfileRegistry({
        ...DEFAULT_PROFILES_CONFIG,
        classifications: DEFAULT_PROFILES_CONFIG.classifications.map((c) => (
          c.value === 'premium' ? { ...c, grants: ['basic', 'premium'] } : c
        )),
      });
      const sql = scopeFunctionSql(granted);
      // The premium reader reaches basic+premium, and NOT standard.
      expect(sql).toMatch(/THEN ARRAY\['basic', 'premium'\]::text\[\]/);
      expect(sql).not.toMatch(/THEN ARRAY\['basic', 'standard', 'premium'\]::text\[\]/);
    });

    it('gives the assistant the SAME reach for channels and for context prefixes', () => {
      // Two derivations of one question is how an assistant ends up able to message a conversation
      // whose grounding it cannot read. The S3 prefixes must be the channel set, spelled as prefixes.
      for (const v of defaultProfileRegistry.classificationValues()) {
        expect(defaultProfileRegistry.contextPrefixesGranted(v))
          .toEqual(defaultProfileRegistry.grantsFor(v).map((c) => `context/${c}/`));
      }
    });
  });

  describe('Cognito stack', () => {
    /**
     * ONE SCOPE PER ROLE, AND FULL FOR THE ROLE AN ADMINISTRATOR SIGNS WITH.
     *
     * `caller-scope` keys its map on role NAME, so a role emitted twice keeps one entry and drops the
     * other. When an administrator's role came out narrowed to the `admin` classification,
     * `scopeAnalyticsRows` dropped every classified row and `admin-conversations` resolved an empty
     * allow-list: the console went blank for the one role meant to see everything, and synthesis was
     * green, because nothing read this JSON. The role that must not be narrowed is the admin console
     * session's; the `admin` classification's Identity-Pool role holds no admin route and is narrowed
     * like every classification's.
     */
    it('emits ONE scope per role, and Full for the admin console role', () => {
      // The map is the admin backend's (AdminServices), handed to the handlers that bound a read by
      // classification. Its roles are the person exchange's (Identity, by import) and the admin backend's own.
      const fns = adminServicesTemplate().findResources('AWS::Lambda::Function') as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>;
      const joined = Object.values(fns).map((fn) => fn.Properties.Environment?.Variables?.CLASSIFICATION_ROLE_SCOPES).find(Boolean) as {
        'Fn::Join': [string, Array<string | Record<string, unknown>>];
      };
      expect(joined).toBeDefined();
      // `toJsonString` renders an Fn::Join: literal fragments interleaved with role ARN references, a
      // GetAtt for a role in this stack and an ImportValue (whose export name carries the logical id) for
      // one in Identity. Walking the two in order pairs each role with the scope that follows it.
      // Each entry's role is a token for a role in this stack (a GetAtt), or a literal ARN for a vend role, which
      // carries a fixed name on the exchange path (`exchangeRoleArnOf`), so the map names it without importing it.
      const parts = joined['Fn::Join'][1];
      const rendered = parts.map((p) => (typeof p === 'string' ? p
        : 'Fn::GetAtt' in p ? `TOKEN:${(p['Fn::GetAtt'] as string[])[0]}` : `TOKEN:${JSON.stringify(p)}`)).join(joined['Fn::Join'][0]);
      const entries = JSON.parse(rendered) as Array<{ role: string; scope: string }>;
      const roleKey = (role: string) => (role.startsWith('TOKEN:') ? role.slice('TOKEN:'.length) : role.split('/').pop()!);
      expect(entries.length).toBeGreaterThan(0);

      const seen = new Map<string, string>();
      for (const { role, scope } of entries) {
        // A second scope for one role IS the defect: whichever entry the runtime map keeps last
        // decides, and nothing here says which that is.
        expect(seen.has(roleKey(role))).toBe(false);
        seen.set(roleKey(role), scope);
      }
      // NO PERSON'S VEND ROLE IS LISTED: the handlers resolve one from its fixed name and the runtime registry
      // (`EXCHANGE_ROLE_NAME_PREFIX`), so a classification added later changes nothing here.
      expect(entries.filter((e) => /-exchange-/.test(e.role))).toEqual([]);
      expect(entries.every((e) => e.scope === 'full')).toBe(true);
      const prefixes = new Set(Object.values(fns).map((fn) => fn.Properties.Environment?.Variables?.EXCHANGE_ROLE_NAME_PREFIX).filter(Boolean));
      expect([...prefixes]).toEqual([expect.stringMatching(/-exchange-$/)]);
      // The admin console role carries Full. Named explicitly rather than "some role has full",
      // because the role that must not be narrowed is the whole point.
      const consoleRole = [...seen.keys()].find((r) => r.startsWith('AdminConsoleRole'));
      expect(consoleRole).toBeDefined();
      expect(seen.get(consoleRole!)).toBe('full');
      expect(seen.get([...seen.keys()].find((r) => r.startsWith('ExchangeRoleAdminPlane'))!)).toBe('full');
      // No role in the map comes from an Identity Pool: there is none.
      expect([...seen.keys()].filter((r) => /AuthenticatedRole/.test(r))).toEqual([]);
    });

    it('should synthesize with scoped IAM permissions (not wildcard)', () => {
      // User management, which holds the pool's attribute writes, is the admin backend's.
      const template = adminServicesTemplate();

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
            expect(JSON.stringify(stmt.Resource)).toMatch(/userpool/i);
          }
        }
      }

      // Keep the test meaningful: the scoped policy must actually exist.
      expect(assertedAdminUpdate).toBe(true);
    });

    it('user-management can invoke the membership audit for on-downgrade re-eval (trigger #3)', () => {
      const template = adminServicesTemplate();

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
      const { identityStack: stack, identity: template } = vendApp();
      type PolicyResource = { Properties: { Roles?: Array<{ Ref?: string }>; PolicyDocument: { Statement: Array<{ Effect?: string; Action: unknown; Resource: unknown }> } } };
      // The grants of the vend role for `token`, wherever its stack built it. Collect GRANTS only: a Deny (the
      // archived-channel read-only Deny, SPEC-CONVERSATION-ARCHIVE) is a restriction, so it must not count
      // toward the FORBIDDEN "is this action granted?" checks below.
      const actionsFor = (token: string): string[] => {
        const acts = new Set<string>();
        for (const st of vendStatements(vendRole(token))) {
          if (st.Effect === 'Deny') continue;
          (Array.isArray(st.Action) ? st.Action : [st.Action]).forEach((a) => acts.add(String(a)));
        }
        return [...acts];
      };

      // Every CHAT exchange role must EXCLUDE the backend/moderator over-grants.
      // (The admin CHAT role is the admin's own `${sub}` identity - never elevated;
      // moderation lives on the SEPARATE admin-plane role asserted below.)
      //
      // chime:UpdateChannel is deliberately NOT forbidden: it is a base OWNER-RENAME
      // capability granted to every role (EXCHANGE_MSG_ACTIONS). It is safe because
      // (a) Chime authorizes UpdateChannel on ChannelModerator status, and only a
      // channel's creator is a moderator of their own channel, so a non-moderator
      // member is denied; and (b) tier is tag-authoritative, so a rename that mutates
      // metadata.modelTier cannot escalate. DeleteChannel (destructive) stays forbidden.
      const FORBIDDEN = [
        'chime:CreateChannel', 'chime:CreateChannelMembership', 'chime:CreateAppInstanceUser',
        'chime:RedactChannelMessage', 'chime:UpdateChannelMessage', 'chime:DeleteChannel',
      ];
      for (const role of ['restricted', 'basic', 'standard', 'premium', 'admin']) {
        const acts = actionsFor(role);
        expect(acts.length).toBeGreaterThan(0); // role exists + has grants
        for (const f of FORBIDDEN) expect(acts).not.toContain(f);
        // Positive lock: the owner-rename cap must be present on every chat role (roles
        // are pinned to the caller's own ${sub}; Chime's moderator check is the real gate).
        expect(acts).toContain('chime:UpdateChannel');
      }

      // Two-plane admin identity (docs/SPEC-ADMIN-IDENTITY.md): the moderation
      // boundary lives ONLY on the admin-plane role (pinned to `${sub}-admin`,
      // vended per-channel, short-lived, audited), which is the admin backend's
      // (AdminServices) and not in this stack. The chat admin role must NOT
      // carry it; the admin-plane role must.
      expect(Object.keys(template.findResources('AWS::IAM::Role')).some((id) => id.startsWith('ExchangeRoleAdminPlane'))).toBe(false);
      const adminPlane = (Object.values(adminServicesTemplate().findResources('AWS::IAM::Policy')) as PolicyResource[])
        .filter((p) => (p.Properties.Roles || []).some((r) => (r.Ref || '').startsWith('ExchangeRoleAdminPlane')))
        .flatMap((p) => p.Properties.PolicyDocument.Statement)
        .flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]).map(String));
      expect(adminPlane).toContain('chime:RedactChannelMessage');
      expect(adminPlane).toContain('chime:DeleteChannelMessage');
      expect(adminPlane).toContain('chime:CreateChannelMembership');
      const chatAdmin = actionsFor('admin');
      expect(chatAdmin).not.toContain('chime:RedactChannelMessage');
      expect(chatAdmin).not.toContain('chime:CreateChannelModerator');

      // The restricted/guest role holds the least: no discovery / self-membership / profile writes.
      const restricted = actionsFor('restricted');
      expect(restricted).not.toContain('chime:ListChannels');
      expect(restricted).not.toContain('chime:DeleteChannelMembership');
      expect(restricted).not.toContain('chime:UpdateAppInstanceUser');
      expect(restricted).toContain('chime:SendChannelMessage');

      // The bearer is pinned to the caller's own AppInstanceUser via the session tag.
      const blob = JSON.stringify(template.toJSON());
      expect(blob).toContain('/user/${aws:PrincipalTag/person}');
      expect(blob).not.toContain('PrincipalTag/sub');
      // The exchange Lambda role may TagSession + AssumeRole the classification roles.
      expect(blob).toContain('sts:TagSession');
      // The route exists, on PersonApi, for the exchange function, with no throttle of its own (a shared
      // throttle there would throttle sign-in for everyone at once). The stack holds no API itself.
      // The invitation landing page's read (M-5) is the exchange's too, and throttled like every unauthenticated route.
      expect(stack.routes.map((r) => `${r.api} ${r.method} ${r.path} ${r.throttle ? 'throttled' : 'unthrottled'}`))
        .toEqual(['person POST /exchange-credentials unthrottled', 'person POST /invitations/peek throttled']);
      template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
    });

    /**
     * SPEC-CONVERSATION-SECURITY section 4d, the STACK half.
     *
     * The permissions side of an exchange role is a correct description of one role's reach, and it
     * stays correct when the exchange hands it to the wrong caller. What makes a mis-vend visible is
     * the TRUST policy: `sub` must be asserted, so a session is always pinned to somebody, and
     * `classification` must equal THIS role's own classification, so a session claiming `basic` cannot be minted
     * on the role carrying premium's grants.
     *
     * The Lambda half is covered by `credential-exchange.test.ts` (it asserts the vend passes both
     * tags). The stack half had no guard at all: deleting either condition from `makeExchangeRole`
     * left the whole suite green, which is tenet P4's "provable with a deny-test rather than a code
     * review" claimed without the proof. Asserted per role FROM THE REGISTRY, because the roles
     * themselves are derived from it - a hardcoded list would go on passing for the four shipped
     * classifications while a fifth got no condition and nobody heard about it.
     */
    it('every exchange role trusts sts:TagSession only for its OWN role, with person asserted (section 4d)', () => {
      type TrustRole = { Properties?: { AssumeRolePolicyDocument?: { Statement?: Array<{ Action?: unknown; Condition?: Record<string, Record<string, unknown>> }> } } };
      const trustOf = (template: Template, id: string) => (template.findResources('AWS::IAM::Role')[id] as TrustRole)
        .Properties?.AssumeRolePolicyDocument?.Statement ?? [];
      /** The one `sts:TagSession` trust statement's Condition block. */
      const tagSessionCondition = (statements: ReturnType<typeof trustOf>) => {
        const tagging = statements.filter((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]).includes('sts:TagSession'));
        expect(tagging).toHaveLength(1);
        return tagging[0].Condition ?? {};
      };

      // Every vended classification's role, the one-conversation role, and the admin PLANE role (the admin
      // backend's), which carries its own literal role rather than a classification's. An outside
      // classification no signed-in issuer reaches (the guest) has no role: its people are vended on the
      // guest-session role.
      expect(vendApp().roles.some((r) => r.token === 'guest')).toBe(false);
      const expected: Array<readonly [string, ReturnType<typeof trustOf>]> = [
        ...defaultProfileRegistry.memberClassificationValues().map((v) => [v, trustOf(vendRole(v).template, vendRole(v).id)] as const),
        ['restricted', trustOf(vendRole('restricted').template, vendRole('restricted').id)] as const,
      ];
      const plane = Object.keys(adminServicesTemplate().findResources('AWS::IAM::Role')).filter((id) => id.startsWith('ExchangeRoleAdminPlane'));
      expect(plane).toHaveLength(1);
      expected.push(['admin', trustOf(adminServicesTemplate(), plane[0])] as const);
      // Non-vacuous: there is more than the admin plane to check, and the registry really enumerated.
      expect(expected.length).toBeGreaterThan(3);

      for (const [own, trust] of expected) {
        const cond = tagSessionCondition(trust);
        // `person` PRESENT, any value: the session is pinned to a bearer, never assumed un-pinned.
        expect(cond.StringLike).toEqual({ 'aws:RequestTag/person': '*' });
        // `classification` EQUAL to this role's own classification, and nothing else: an exact match, so a
        // widening to a list or to `StringLike` fails here instead of shipping.
        expect(cond.StringEquals).toEqual({ 'aws:RequestTag/classification': own });
      }
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
    };

    /**
     * THE SPEND LIMIT IS ON WITHOUT ANYONE ASKING FOR IT.
     *
     * It was opt-in, and opt-in meant off everywhere: the limits defaulted to 0, the runtime reads
     * 0 as "not configured" and allows everything, and the two flags that would have turned them on
     * were read through a wrapper the config-drift guard could not see - so they were missing from
     * the example too. A deployment that followed the README ran with no bound on model spend at all.
     *
     * Asserted at synth because that is where the default lives. An explicit 0 still turns it off,
     * which is what keeps this a safer default rather than a decision taken away.
     */
    it('caps model spend by DEFAULT, with no budget context set', () => {
      const app = new cdk.App();
      const stack = assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', classificationBasicProps);

      Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            BEDROCK_GLOBAL_HOURLY_BUDGET: '500',
            BEDROCK_USER_HOURLY_BUDGET: '100',
          }),
        },
      });
    });

    it('still lets a deployment turn the limit off with an explicit 0', () => {
      const app = new cdk.App({
        context: { bedrockGlobalHourlyBudget: 0, bedrockUserHourlyBudget: 0 },
      });
      const stack = assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', classificationBasicProps);

      Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            BEDROCK_GLOBAL_HOURLY_BUDGET: '0',
            BEDROCK_USER_HOURLY_BUDGET: '0',
          }),
        },
      });
    });

    it('should synthesize AgentEchelonAssistants-basic as an Option-D processor (no Bedrock Agent)', () => {
      const app = new cdk.App();
      const stack = assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', classificationBasicProps);

      const template = Template.fromStack(stack);

      // The assistant is the async-processor, NOT a managed agent.
      template.resourceCountIs('AWS::Bedrock::Agent', 0);
      template.resourceCountIs('AWS::Bedrock::AgentAlias', 0);

      // Two content guardrails (SPEC-CONFIGURABLE-ASSISTANTS 4.6b): the default + one selectable
      // alternate ('strict') from the catalog; basic has no /battle image guardrail.
      template.resourceCountIs('AWS::Bedrock::Guardrail', 2);

      // No Lex bot or AppInstanceBot custom resource: the identity is the provisioner's, and the stack declares it
      // to its one seed (ADR-048, amended 2026-10-23).
      template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
      template.resourceCountIs('Custom::DeclaredAssistants', 1);

      // SSM contract: processor-arn + bot-arn published for the shared router and
      // create-conversation to discover, router-arn (per-classification router
      // Lambda) for the profile infra resolver, the selectable-guardrails catalog
      // (SPEC-CONFIGURABLE-ASSISTANTS 4.6b), and the selectable context-source catalog
      // (SPEC-CONTEXT-SOURCES-AND-STORES). The COUNT is asserted deliberately: this is the
      // published contract other stacks and the admin console read, so a parameter
      // appearing or vanishing should require someone to say so here.
      // SIX since the task-service ARN joined them: the admin plane reads it to reach this
      // classification's task service, and without it that route resolved no services and
      // answered 503 to every request. Saying so here is the point of the count.
      // SEVEN since the ASSIGNMENT RECORD joined them (DESIGN-SEPARATE-ASSISTANTS 3.0):
      // `(classification, primary, live)` naming the assistant that occupies the slot and the bot it
      // answers as. It is the authority a reader resolves through instead of building a key out of a
      // classification, and it is published before anything reads it so the authority exists and is
      // inspectable before `resolvePrimaryBotArn` moves onto it.
      // EIGHT since the NAME APPLIER joined them (DESIGN-SEPARATE-ASSISTANTS 3.0): the function that
      // puts an activated version's `displayName` onto the `AppInstanceBot`, keyed by the ASSISTANT
      // rather than the classification because it belongs to one assistant and a classification is
      // about to hold several. `manage-profiles` resolves it here rather than holding
      // `chime:UpdateAppInstanceBot` itself, which would carry the power to repoint the Lex wiring.
      // NINE: no per-assistant IAM role is published. Every assistant of a classification acts through
      // one tagged role the vend assumes, and the vend's ARN is published (`vendArnKey`) for a declared
      // speaker in another stack (arrival triage), which speaks through it.
      // TEN: the classification's conversation creator is built here and published under its own key, which the
      // create-conversation API and guest start read at call time (`conversationCreatorArnKey`). A stack built with
      // the credential exchange's role (as bin builds it) publishes its vend role's too.
      // ELEVEN: the classification's row of the runtime registry, which every handler reads at runtime.
      // NINE since NO STACK OWNS AN ASSISTANT IDENTITY (ADR-048, amended 2026-10-23): the assignment record and
      // the name applier are the provisioner's, so neither is published here; the bot pointer is written from
      // the seed's answer.
      template.resourceCountIs('AWS::SSM::Parameter', 9);
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/registry/classification/basic',
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/assistant/basic/conversation-creator-arn',
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/assistant/basic/vend-arn',
      });
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
      const stack = assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', classificationBasicProps);

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

    // THE HANDOVER'S SELF-INVOKE (MESSAGE-FLOW §6.10). A message is answered by the assistant whose work
    // it answers, so a handler that receives one it does not own invokes this same function as the
    // owning assistant. Both halves of the grant have a failure mode that deploys clean:
    //   - Referencing the function from the role's DEFAULT policy closes a dependency cycle, which is
    //     caught at synth (the template is simply undeployable).
    //   - A NAME PATTERN is not caught anywhere. CloudFormation truncates the stack name when the
    //     generated physical name would exceed 64 characters, so the handler is really named
    //     with a shortened stack name (measured on
    //     a 34-character stack name); a pattern built from the full stack name
    //     matches nothing, deploys green, and denies at runtime. Found on the deployment, not here.
    it('grants the handler invoke on ITSELF, by ARN and from a policy of its own', () => {
      const app = new cdk.App();
      const stack = assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', classificationBasicProps);
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
          assistantsOf('standard')(new cdk.App(), `AgentEchelonAssistants-${name}`, classificationBasicProps),
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
          // keeps the read at the same location the IAM grant authorized. Stripping the prefix is
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
     * deployment actually looks at those counts, in every deployment: the alarm's notifier raises an
     * `ae.alert`, which the admin backend posts when the deployment declares `admin`, and the
     * assistant stack neither knows nor asks whether it does.
     */
    describe('context source failure-rate alarm and dashboard (INV-CTX-CAT-7)', () => {
      const alerting = () => Template.fromStack(
        assistantsOf('standard')(new cdk.App(), 'AgentEchelonAssistants-ctx-alarm', classificationBasicProps),
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

      it('routes the alarm to the notifier, which raises an ae.alert rather than mailing a list', () => {
        // SNS is the transport between CloudWatch and the notifier; the notifier raises the alert on
        // the default bus, and the admin backend posts it into the admin conversation, which fans out
        // to the roster by email through the channel flow.
        const t = alerting();
        // One topic for this alarm; a member classification's stack also carries its deadline alarm's
        // (`EventDeadlineAlarmTopic`, ADR-061), delivered by the same notifier code.
        const topics = Object.keys(t.findResources('AWS::SNS::Topic'));
        expect(topics.filter((id) => id.startsWith('ContextSourceAlarmTopic'))).toHaveLength(1);
        expect(topics.filter((id) => !id.startsWith('ContextSourceAlarmTopic') && !id.startsWith('EventDeadlineAlarmTopic'))).toEqual([]);
        const subs = Object.values(t.findResources('AWS::SNS::Subscription'));
        expect(subs.some((s) => (s.Properties as { Protocol?: string }).Protocol === 'lambda')).toBe(true);
        const notifier = Object.entries(t.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith('ContextSourceAlarmFunction'))!;
        expect((notifier[1].Properties as { Environment: { Variables: Record<string, unknown> } }).Environment.Variables.ALERT_INSTANCE).toBeDefined();
        expect(JSON.stringify(t.toJSON())).toContain('events:PutEvents');
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

      // THE CORE DOES NOT BRANCH ON THE ADMIN CAPABILITY (the component rule). The alarm is the same in
      // every deployment, and nothing in this stack names the admin channel or its agent.
      it('names no admin channel, agent or parameter, so it is the same with or without admin', () => {
        const blob = JSON.stringify(alerting().toJSON());
        expect(blob).not.toMatch(/admin-notification\/channel-arn|assistant\/admin-agent\/bot-arn|aeChannelKind|ADMIN_ALERT_CHANNEL/);
      });
    });

    it('should synthesize AgentEchelonAssistants-standard resolving the shared SSM contract (no Bedrock Agent, no Fn::importValue)', () => {
      const app = new cdk.App();
      const stack = assistantsOf('standard')(app, 'AgentEchelonAssistants-standard', { ...classificationBasicProps, experiments: true });

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
      // A DECLARED CAPABILITY'S TABLE IS NAMED, NOT RESOLVED: the experiments table by its fixed name, and the
      // Experiments stack, which deploys after this one, attaches the grants (STACKS.md, additivity).
      expect(ssmDefaults).not.toContain('/agent-echelon/shared/tables/experiments-arn');
      expect(JSON.stringify(template.toJSON())).toContain('"EXPERIMENTS_TABLE":"agent-echelon-experiments"');
      // /battle is the `battle` capability (AgentEchelonBattle): not declared here, so the stack
      // names nothing of it.
      expect(ssmDefaults).not.toContain('/agent-echelon/shared/battle-orchestrator-arn');

      // Still publishes its own processor ARN for the router to discover.
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/assistant/standard/processor-arn',
      });
    });

    // EXPERIMENTS ARE A CAPABILITY. Without `experiments` there is no Experiments stack to publish the
    // table, so the assistant stack resolves none of its parameters (a dynamic reference to an absent
    // parameter fails the deploy), grants nothing on it, and passes no EXPERIMENTS_TABLE: every turn
    // serves the assistant's active version.
    it('resolves, grants and passes no experiments table when experiments is not declared', () => {
      for (const classification of ['basic', 'standard', 'premium']) {
        const template = Template.fromStack(assistantsOf(classification)(new cdk.App(), `AgentEchelonAssistants-${classification}`, classificationBasicProps));
        const json = JSON.stringify(template.toJSON());
        expect({ classification, resolves: json.includes('/shared/tables/experiments-') }).toEqual({ classification, resolves: false });
        expect({ classification, env: json.includes('EXPERIMENTS_TABLE') }).toEqual({ classification, env: false });
      }
      const withExperiments = JSON.stringify(Template.fromStack(assistantsOf('basic')(new cdk.App(), 'AgentEchelonAssistants-basic', {
        ...classificationBasicProps,
        experiments: true,
      })).toJSON());
      // Declared, it is NAMED and never resolved, and this classification grants its own router on it in a
      // policy of its own (`attachExperiments`); basic's processor is not rich, so its acting role holds none.
      expect(withExperiments).not.toContain('/shared/tables/experiments-');
      expect(withExperiments).toContain('"EXPERIMENTS_TABLE":"agent-echelon-experiments"');
      expect(withExperiments).toContain('table/agent-echelon-experiments');
      expect(withExperiments).toContain('ExperimentsOnTheRouter');
      expect(withExperiments).not.toContain('ExperimentsOnTheTurn');
    });

    it('names the battle tables and orchestrator when battle is declared, resolves none of them, and grants its own roles on them', () => {
      const stack = assistantsOf('standard')(new cdk.App(), 'AgentEchelonAssistants-standard', { ...classificationBasicProps, battle: true });
      const template = Template.fromStack(stack);
      const json = JSON.stringify(template.toJSON());
      // NAMED in the environment and in the grants, by their fixed names; never resolved at deploy.
      expect(json).not.toContain('/shared/tables/battle-');
      expect(json).not.toContain('/shared/battle-orchestrator-arn');
      expect(json).toContain('"BATTLE_STATE_TABLE":"agent-echelon-battle-state"');
      expect(json).toContain('"CHANNEL_BATTLE_CONFIG_TABLE":"agent-echelon-channel-battle-config"');
      expect(json).toContain('function:AgentEchelonBattle-BattleOrchestrator');
      // THIS CLASSIFICATION'S GRANTS ON THEM, in policies of their own (`attachBattle`), so declaring battle adds
      // them and changes no policy the stack had.
      const policies = template.findResources('AWS::IAM::Policy');
      const battleGrants = Object.entries(policies).filter(([, r]) => JSON.stringify(r).includes('battle'));
      expect(battleGrants.map(([id]) => id.replace(/[0-9A-F]{8}$/, '')).sort()).toEqual(['BattleOnTheRouter', 'BattleOnTheTurn']);
      expect(JSON.stringify(policies[battleGrants.find(([id]) => id.startsWith('BattleOnTheTurn'))![0]])).toContain('lambda:InvokeFunction');
    });

    it('declares the alt of a duel to its own classification\'s seed, fulfilled by that classification\'s router (§3.7)', () => {
      const app = new cdk.App();
      const standard = assistantsOf('standard')(app, 'AgentEchelonAssistants-standard', { ...classificationBasicProps, battle: true });
      const basic = assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', { ...classificationBasicProps, battle: true });
      const battle = new BattleStack(app, 'AgentEchelonBattle', { env, appInstanceArn, selfPoolId: '', appUrl: 'https://app.example.com' });
      const resources = Template.fromStack(standard).toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>;
      // The alt is the provisioner's, like every assistant (ADR-048, amended 2026-10-23): declared to the
      // classification's one seed, silent on join, and built by the seed with that classification's router as its
      // Amazon Lex fulfillment. Its record at `(standard, primary, alt)`, with no occupant between battles, is the
      // seed's to write (`a-deploy-seeds-its-declared-assistants-once.test.ts`).
      // In a declaration of its own on the classification's seed, so declaring battle adds that resource and
      // changes none the stack had.
      const alts = Object.entries(resources).filter(([id, r]) => r.Type === 'Custom::DeclaredAssistants' && id.startsWith('DeclaredDuelAlts'));
      expect(alts).toHaveLength(1);
      expect(JSON.parse(String(alts[0][1].Properties!.declaration)).assistants).toEqual([
        { assistantId: 'alt-primary-standard', role: 'primary', occupancy: 'alt', displayName: 'Alt-standard-primary', welcome: false },
      ]);
      const seedFn = Object.entries(resources).find(([id, r]) => r.Type === 'AWS::Lambda::Function' && id.startsWith('DeclaredAssistantsFunction'));
      expect(JSON.stringify(seedFn![1].Properties!.Environment)).toMatch(/FULFILLMENT_ARN[^}]*AgentHandler/);
      // No identity, Lex bot, record or name applier of its own in the template: only its declaration.
      expect(Object.keys(resources).filter((id) => /altprimary|ApplyAssistantName/i.test(id))).toEqual([]);
      // Basic cannot duel: no alt and no battle grant.
      const basicResources = Template.fromStack(basic).toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>;
      expect(Object.keys(basicResources).filter((id) => /altprimary|^BattleOnThe/.test(id))).toEqual([]);
      expect(Object.values(basicResources).filter((r) => r.Type === 'Custom::DeclaredAssistants')).toHaveLength(1);
      const basicSeed = Object.values(basicResources).find((r) => r.Type === 'Custom::DeclaredAssistants');
      expect(JSON.parse(String(basicSeed!.Properties!.declaration)).assistants.filter((a: { occupancy: string }) => a.occupancy === 'alt')).toEqual([]);
      // And the Battle stack names no classification: no alt, and no grant on a classification's roles.
      const battleResources = Template.fromStack(battle).toJSON().Resources as Record<string, { Type: string }>;
      expect(Object.keys(battleResources).filter((id) => /alt|Assistants/i.test(id))).toEqual([]);
      expect(JSON.stringify(battleResources)).not.toContain('AgentEchelonAssistants-');
    });

    it('should synthesize AgentEchelonAssistants-premium with text + image guardrails (no Bedrock Agent)', () => {
      const app = new cdk.App();
      const stack = assistantsOf('premium')(app, 'AgentEchelonAssistants-premium', classificationBasicProps);

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::Bedrock::Agent', 0);
      // Premium owns the default content guardrail + the 'strict' selectable alternate (4.6b) + the
      // /battle image guardrail.
      template.resourceCountIs('AWS::Bedrock::Guardrail', 3);
    });

    // DESIGN-CONVERSATION-TYPES §6: one reconcile per classification, built only where some type sources its
    // membership from a group at that classification, invoked by the Cognito group change (via CloudTrail and
    // EventBridge) and by a daily backstop.
    it('gives premium a group-membership reconcile, driven by the Cognito group change, and basic none', () => {
      const app = new cdk.App();
      const premium = Template.fromStack(assistantsOf('premium')(app, 'AgentEchelonAssistants-premium', classificationBasicProps));
      premium.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({
          source: ['aws.cognito-idp'],
          'detail-type': ['AWS API Call via CloudTrail'],
          detail: Match.objectLike({
            eventName: Match.arrayWith(['AdminAddUserToGroup', 'AdminRemoveUserFromGroup', 'AdminDeleteUser', 'AdminDisableUser', 'AdminEnableUser']),
          }),
        }),
      });
      premium.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 day)' });
      premium.hasResourceProperties('AWS::Lambda::Function', {
        Environment: { Variables: Match.objectLike({ CLASSIFICATION: 'premium', BOT_ARN_PARAM: Match.anyValue() }) },
        Timeout: 300,
      });

      const app2 = new cdk.App();
      const basic = Template.fromStack(assistantsOf('basic')(app2, 'AgentEchelonAssistants-basic', classificationBasicProps));
      const rules = Object.values(basic.findResources('AWS::Events::Rule')) as Array<{ Properties: { EventPattern?: { source?: string[] } } }>;
      expect(rules.some((r) => r.Properties.EventPattern?.source?.includes('aws.cognito-idp'))).toBe(false);
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
    };

    /** The archive in Aurora mode with live drift: the stack builds its own turn data plane in the archive's VPC
     *  and its handler is granted invoke on it (project decision 018). The handler is not VPC-attached. */
    function makeHookup(_app: cdk.App) {
      return { rdsProxy: false, liveDrift: true };
    }

    const driftRolePolicyMatches = (template: Template) => {
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      // The handler invokes the data-plane Lambda for retrieval + drift (project
      // decision 018); rds-db:connect + Titan-embed IAM now live on the
      // data-plane Lambda's own role in ArchiveStackAurora, NOT on the handler.
      expect(policies).toContain('lambda:InvokeFunction');
      expect(policies).not.toContain('rds-db:connect');
      // Drift-confirm create-flow IAM (still on the handler).
      expect(policies).toContain('chime:CreateChannel');
      expect(policies).toContain('chime:TagResource');
      expect(policies).toContain('chime:SendChannelMessage');
      // The channel-flow ARN SSM read for the create path.
      expect(policies).toContain('parameter/agent-echelon/channel-flow-arn');
    };

    /** No Lambda in the tier stack is VPC-attached in the data-plane model, but its own three in the archive's VPC (ADR-065 added the golden run). */
    const noHandlerIsVpcAttached = (template: Template) => {
      const fns = template.findResources('AWS::Lambda::Function') as Record<string, { Properties?: { VpcConfig?: unknown; FunctionName?: string } }>;
      const inVpc = Object.values(fns).filter((fn) => fn.Properties?.VpcConfig !== undefined).map((fn) => String(fn.Properties?.FunctionName));
      expect(inVpc.sort()).toEqual([expect.stringMatching(/-ClassifierReplay$/), expect.stringMatching(/-GoldenRun$/), expect.stringMatching(/-TurnDataPlane$/)]);
    };

    it('wires the basic handler to the data-plane Lambda (NO VPC) + create-flow IAM (drift is all-tier)', () => {
      const app = new cdk.App();
      const stack = assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', {
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
      // ITS OWN CLASSIFICATION'S turn data plane, and no other: that invoke grant is what pins a
      // retrieval or drift call to this classification (turn-data-plane-binding.ts).
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).toContain('ArchiveTurnDataPlane');
      expect(policies).not.toContain('TurnDataPlane-premium');
      expect(policies).not.toContain('TurnDataPlane-standard');
    });

    it('wires the premium handler to the data-plane Lambda (NO VPC) + create-flow IAM', () => {
      const app = new cdk.App();
      const stack = assistantsOf('premium')(app, 'AgentEchelonAssistants-premium', {
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
      const stack = assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', {
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
      const stack = assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', { ...classificationBaseProps });
      const template = Template.fromStack(stack);
      // Both the processor AND the handler carry the abuse env: the shared table and the length cap.
      // (The rate limit moved to the profile config — profiles.ts rateLimitPerHour, read at
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

    // INVERTED (maintainer, 2026-08-30). This asserted that the budget and the circuit were OPT-IN, and
    // opt-in is what left every deployment with no limit on model spend: the flags that turned them
    // on were read through a wrapper the config-drift guard could not see, so they were undocumented,
    // and undocumented meant unset, and unset meant off. The default is now ON, and the circuit
    // follows it, so load-shedding is wired without anyone opting in. An explicit 0 is the opt-OUT,
    // which is the half worth keeping and is asserted below.
    it('abuse budget + circuit are ON BY DEFAULT, and an explicit 0 turns them off', () => {
      const app = new cdk.App();
      const stack = assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', { ...classificationBaseProps });
      const policies = JSON.stringify(Template.fromStack(stack).findResources('AWS::IAM::Policy'));
      // The circuit is wired because a global budget is now set by default.
      expect(policies).toContain('ssm:PutParameter');
      expect(policies).toContain('abuse/circuit');

      // Explicitly disabled: no global budget means no circuit to trip, so the grant goes with it.
      const app2 = new cdk.App({ context: { bedrockGlobalHourlyBudget: 0 } });
      const stack2 = assistantsOf('basic')(app2, 'AgentEchelonAssistants-basic', { ...classificationBaseProps });
      const policies2 = JSON.stringify(Template.fromStack(stack2).findResources('AWS::IAM::Policy'));
      expect(policies2).not.toContain('/agent-echelon/abuse/circuit');
    });

    it('assistant/handler roles bear BOTS only — no /user/* bearer ', () => {
      const app = new cdk.App();
      const stack = assistantsOf('premium')(app, 'AgentEchelonAssistants-premium', {
        ...classificationBaseProps,
        auroraDriftHookup: makeHookup(app),
        battle: true,
      });
      const template = Template.fromStack(stack);
      // Inspect every channel-action statement: its resources must never include a
      // `…/user/*` (assistants act as the tier bot, never impersonate a user). The
      // `…/bot/*` bearer is retained (the premium processor bears alt-slot bots in /battle).
      // Every policy document in the stack: attached policies, managed policies and role inline policies.
      type Doc = { Statement: Array<{ Action: unknown; Resource: unknown }> };
      const docs: Doc[] = [
        ...(Object.values(template.findResources('AWS::IAM::Policy')) as Array<{ Properties: { PolicyDocument: Doc } }>).map((p) => p.Properties.PolicyDocument),
        ...(Object.values(template.findResources('AWS::IAM::ManagedPolicy')) as Array<{ Properties: { PolicyDocument: Doc } }>).map((p) => p.Properties.PolicyDocument),
        ...(Object.values(template.findResources('AWS::IAM::Role')) as Array<{ Properties: { Policies?: Array<{ PolicyDocument: Doc }> } }>)
          .flatMap((r) => (r.Properties.Policies || []).map((p) => p.PolicyDocument)),
      ];
      let sawBotBearer = false;
      for (const p of docs) {
        for (const st of p.Statement) {
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
      const stack = assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', { ...classificationBaseProps });
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
      selfPoolId: 'us-east-1_testpool',
      appUrl: 'https://app.example.com',
    };

    it('owns the four battle tables + publishes the shared battle SSM contract', () => {
      const app = new cdk.App();
      const stack = new BattleStack(app, 'AgentEchelonBattle', { ...battleProps });
      const template = Template.fromStack(stack);

      // BattleState, ChannelBattleConfig and BattleOutcome. A person's picks are kept when they are offboarded,
      // so no per-voter index exists to find them by.
      template.resourceCountIs('AWS::DynamoDB::Table', 3);
      expect(JSON.stringify(template.findResources('AWS::SSM::Parameter'))).not.toContain('battle-voter-index');

      // Publishes the battle SSM the per-tier stacks resolve.
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/shared/tables/battle-state-arn',
      });
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/agent-echelon/shared/battle-orchestrator-arn',
      });
      // The channel-battle and outcome routes, declared for PersonApi under the battle capability; no API here.
      expect(stack.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
        'GET /channels/battle', 'GET /channels/battle/outcome', 'POST /channels/battle/disable',
        'POST /channels/battle/enable', 'POST /channels/battle/outcome',
      ]);
      expect(new Set(stack.routes.map((r) => r.capability))).toEqual(new Set(['battle']));
      template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
    });

    it('owns no assistant: no alt identity, no Lex bot or handler, no roster, no alt record (§3.7)', () => {
      const template = Template.fromStack(new BattleStack(new cdk.App(), 'AgentEchelonBattle', { ...battleProps }));
      const json = JSON.stringify(template.toJSON());
      // The alts are their classification stacks' assistants.
      template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
      expect(Object.values(template.findResources('AWS::Lambda::Permission'))
        .filter((r) => (r as { Properties: { Principal?: string } }).Properties.Principal === 'lexv2.amazonaws.com')).toEqual([]);
      expect(json).not.toContain('alt-bot-slots');
      expect(json).not.toContain('battle-alt-slot-handler');
      expect(json).not.toMatch(/assistant-assignments\/[a-z]+\/primary\/alt"/);
      const ids = Object.keys(template.toJSON().Resources as object);
      expect(ids.filter((id) => /AltSlot|CreateAltBot|AltBotSlot|CreateLexBot|LexBotRole/.test(id))).toEqual([]);
    });

    it('the orchestrator invokes the routers by name and no vend, never every assistant stack function', () => {
      const template = Template.fromStack(new BattleStack(new cdk.App(), 'AgentEchelonBattle', { ...battleProps }));
      const roles = template.findResources('AWS::IAM::Role');
      const orchestrator = Object.entries(roles).find(([id]) => id.startsWith('BattleOrchestratorRole'))![1] as {
        Properties: { Policies: Array<{ PolicyName: string; PolicyDocument: { Statement: Array<Record<string, unknown>> } }> };
      };
      const invokes = orchestrator.Properties.Policies.flatMap((p) => p.PolicyDocument.Statement)
        .filter((s) => ([] as unknown[]).concat(s.Action as unknown).includes('lambda:InvokeFunction'));
      const resources = invokes.flatMap((s) => ([] as unknown[]).concat(s.Resource as unknown)).map((r) => JSON.stringify(r));
      // No pattern over a whole assistant stack: it reaches every processor as well.
      expect(resources.some((r) => /Assistants-\*"$/.test(r))).toBe(false);
      // No vend: the router posts every line of a duel.
      expect(invokes.find((s) => s.Sid === 'AskTheVendForASession')).toBeUndefined();
      expect(resources.some((r) => /AssistantVend/.test(r))).toBe(false);
      // The routers and nothing else: by the router's construct id, on this instance's classification
      // functions, because Battle deploys before the classification stacks that publish their ARNs.
      expect(invokes.map((s) => s.Sid)).toEqual(['NameANoticeToTheRouter']);
      expect(resources.every((r) => r.endsWith(`:function:${STACK_PREFIX}*-AgentHandler*"`))).toBe(true);
      expect(JSON.stringify(invokes[0].Condition)).toContain('aws:ResourceTag/Instance');
      // Read by name at call time, so no router-arn parameter is resolved at deploy.
      expect(JSON.stringify(template.toJSON().Parameters ?? {})).not.toContain('router-arn');
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
      classifications: assistantClassifications(),
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
    };

    // THE SAME GUARD FOR THE FLOW'S ASSIGNMENT READ, and here a denial is worse than invisible.
    // `resolvePrimaryBotArn` resolves which assistant serves the primary role through the assignment
    // record on every turn; `resolvePrimaryBearer` in the handler swallows the throw and degrades
    // deliberately, so a missing grant does not raise - every room just stops answering. The
    // processor-arn guard above exists because a missing grant was invisible; this one is the same
    // shape with a louder consequence.
    it('the channel flow is granted ssm:GetParameter on the assignment it reads every turn', () => {
      const app = new cdk.App();
      const stack = new ChannelFlowStack(app, 'AgentEchelonChannelFlow', { ...channelFlowProps });

      // Matched in JS rather than with a shape matcher: the grant now names ONE resource, which
      // CloudFormation emits as a string rather than a list, and an Action/Resource shape assertion
      // would pass or fail on that rendering rather than on whether the grant exists.
      // The grant is INLINE ON THE ROLE, not a standalone AWS::IAM::Policy, so both are searched:
      // asserting the wrong resource type is a guard that passes because it looked in the wrong place.
      const tpl = Template.fromStack(stack);
      type Stmt = { Action?: unknown; Resource?: unknown };
      const stmts: Stmt[] = [
        ...Object.values(tpl.findResources('AWS::IAM::Policy')).flatMap(
          (r: any) => (r.Properties?.PolicyDocument?.Statement ?? []) as Stmt[]),
        ...Object.values(tpl.findResources('AWS::IAM::Role')).flatMap(
          (r: any) => ((r.Properties?.Policies ?? []) as any[]).flatMap(
            (pol) => (pol.PolicyDocument?.Statement ?? []) as Stmt[])),
      ];
      const asList = (v: unknown) => (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string') as string[];
      const granted = stmts.some((st) =>
        asList(st.Action).includes('ssm:GetParameter')
        && asList(st.Resource).some((r) => r.endsWith('/agent-echelon/assistant-assignments/*/*/*')));

      expect(granted).toBe(true);
    });

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

    it('@all routes by channel classification: the flow finds the classification\'s router by name and no processor (F1)', () => {
      // @all hands the turn to the CHANNEL's classification router, never to a processor directly, so a
      // basic channel's @all cannot run on another classification's processor. The flow reads the channel's
      // classification's own `router-arn` parameter at call time (the root it carries), holds no router
      // variable per classification, and is given no processor address at all.
      const template = Template.fromStack(
        new ChannelFlowStack(new cdk.App(), 'AgentEchelonChannelFlow', { ...channelFlowProps }));
      const fns = Object.values(template.findResources('AWS::Lambda::Function')) as Array<{
        Properties?: { Environment?: { Variables?: Record<string, unknown> } };
      }>;
      const proc = fns.find((f) => f.Properties?.Environment?.Variables?.ROUTER_ARN_PARAM_ROOT !== undefined);
      expect(proc).toBeDefined();
      const vars = proc!.Properties!.Environment!.Variables!;
      expect(vars.ROUTER_ARN_PARAM_ROOT).toBe('/agent-echelon/assistant');
      expect(vars.TASK_SERVICE_ARN_PARAM_ROOT).toBe('/agent-echelon/assistant');
      expect(Object.keys(vars).filter((k) => /_(ROUTER|TASK_SERVICE)_ARN$/.test(k))).toEqual([]);
      expect(Object.keys(vars).filter((k) => k.endsWith('ASYNC_PROCESSOR_ARN'))).toEqual([]);
      expect(vars.TURN_ROUTING_TABLE_PREFIX).toBeUndefined(); // the flow never speaks, so it writes no routing record
    });

    it('the channel-flow processor has error, throttle and occupancy alarms on itself', () => {
      // Its fallback is CONTINUE, so every one of these failures delivers the message unanswered and
      // shows nowhere else.
      const template = Template.fromStack(
        new ChannelFlowStack(new cdk.App(), 'AgentEchelonChannelFlow', { ...channelFlowProps }));
      const fns = template.findResources('AWS::Lambda::Function');
      const [procId, proc] = Object.entries(fns).find(([, f]: [string, any]) =>
        f.Properties?.Environment?.Variables?.ROUTER_ARN_PARAM_ROOT !== undefined)! as [string, any];
      const slots = proc.Properties.ReservedConcurrentExecutions;
      expect(slots).toBe(50);

      const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')) as any[];
      const onProcessor = (metric: string) => alarms.find((a) =>
        a.Properties.MetricName === metric
        && JSON.stringify(a.Properties.Dimensions || []).includes(procId));
      for (const metric of ['Errors', 'Throttles']) {
        const a = onProcessor(metric);
        expect({ metric, found: !!a }).toEqual({ metric, found: true });
        expect(a.Properties.Threshold).toBe(1);
        expect(a.Properties.TreatMissingData).toBe('notBreaching');
      }
      const occupancy = onProcessor('ConcurrentExecutions');
      expect(occupancy).toBeDefined();
      expect(occupancy.Properties.Threshold).toBe(Math.floor(slots * 0.8));
      expect(occupancy.Properties.EvaluationPeriods).toBe(2);
    });

    // INVERTED with its sibling above: the limit is ON by default, so the channel-flow path - the
    // one that gates an @all and a battle as a whole - is covered without opting in too. It shares
    // abuseControlsWiring, so it inherits the default rather than needing a decision of its own.
    it('budget + circuit are ON BY DEFAULT on channel-flow, and an explicit 0 turns them off', () => {
      const template = Template.fromStack(
        new ChannelFlowStack(new cdk.App(), 'AgentEchelonChannelFlow', { ...channelFlowProps }));
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).toContain('abuse/circuit');

      const template2 = Template.fromStack(
        new ChannelFlowStack(new cdk.App({ context: { bedrockGlobalHourlyBudget: 0 } }),
          'AgentEchelonChannelFlow', { ...channelFlowProps }));
      const policies2 = JSON.stringify(template2.findResources('AWS::IAM::Policy'));
      expect(policies2).not.toContain('/agent-echelon/abuse/circuit');
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
    // The tier-gated allows on CHANNEL resources: the classification boundary itself. The acting role
    // also carries a tier-gated BEARER statement (its own bot, `aws:PrincipalTag/bot`), which is the
    // identity pin rather than the channel boundary, so it is filtered out here.
    const channelTierAllows = (template: Template): any[] =>
      tierGatedAllows(template).filter((st) => resourceSuffixes(st.Resource).some((x) => x.endsWith('/channel/*')));
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
      const template = Template.fromStack(assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', props));
      const allows = channelTierAllows(template);
      expect(allows.length).toBeGreaterThanOrEqual(1);
      expect(allows[0].Condition.StringEquals['aws:ResourceTag/classification']).toEqual(['basic']);
      expect(allows[0].Action).toContain('chime:SendChannelMessage');
      // No fail-open broad SendChannelMessage allow.
      expect(unconditionedChannelSendAllows(template)).toHaveLength(0);
    });

    it('standard assistant: channel actions allowed on its OWN classification and no other', () => {
      // AN ASSISTANT IS A POINT (ADR-042). This asserted `['basic','standard']` until
      // 2026-09-16, pinning a boundary that was an inheritance rather than a decision: the helper
      // that builds it is shared with the Cognito user roles, where the declared grant set is correct,
      // and it was applied unchanged to the assistant roles. Every classification has its own assistant
      // and a channel carries only its matched one, so reaching any other classification was reach nothing needed and the
      // membership audit existed to report the case IAM allowed.
      const app = new cdk.App();
      const template = Template.fromStack(assistantsOf('standard')(app, 'AgentEchelonAssistants-standard', props));
      const allows = channelTierAllows(template);
      expect(allows.length).toBeGreaterThanOrEqual(1);
      expect(allows[0].Condition.StringEquals['aws:ResourceTag/classification']).toEqual(['standard']);
      expect(unconditionedChannelSendAllows(template)).toHaveLength(0);
    });

    it('premium assistant: channel actions allowed on classification ∈ {basic, standard, premium}, still fail-closed', () => {
      const app = new cdk.App();
      const template = Template.fromStack(assistantsOf('premium')(app, 'AgentEchelonAssistants-premium', props));
      const allows = channelTierAllows(template);
      expect(allows.length).toBeGreaterThanOrEqual(1);
      // PINNED TO ITS OWN CLASSIFICATION (ADR-042), where this asserted
      // `['basic','standard','probe','premium']` hours earlier. That list is what the live premium
      // processor role carried, and it is what let a premium assistant added to a basic channel out
      // of band answer there with premium's model and context. A person's role keeps its declared grant
      // set; see the exchange-role case below, which still asserts it and is what proves this narrowed the
      // assistant side alone.
      expect(allows[0].Condition.StringEquals['aws:ResourceTag/classification']).toEqual(['premium']);
      // Even premium has no unconditioned SendChannelMessage allow (an
      // untagged channel must not be silently reachable).
      expect(unconditionedChannelSendAllows(template)).toHaveLength(0);
    });

    it('user-side: exchange roles fail-closed (basic→{basic}, standard→{basic,standard}, premium→all, admin→{admin}); legacy Identity-Pool roles grant NO Chime', () => {
      // The person vend roles, wherever each is built: Identity's two and each classification stack's own.
      const template = vendTemplate();
      // The person roles only. User deletion's leave (`UserDeleteLeaves`)
      // is a service grant bearing the service admin, conditioned on every declared classification; it
      // is no person's role, and `only-declared-speakers-can-speak.test.ts` checks its two legs. Neither is
      // offboarding's erasure of an upgrade source (`UpgradeSourceErase`, path B), which follows a tag.
      // A member role's admin-plane statement (`AllowAdminPlaneChannelActionsWhenHeld`) is asserted below on its own.
      const tierSets = tierGatedAllows(template)
        .filter((d) => !/^(UserDeleteLeaves|UpgradeSourceErase|AllowAdminPlaneChannelActionsWhenHeld)/.test(String(d.Sid ?? '')))
        .map((d) => d.Condition.StringEquals['aws:ResourceTag/classification'])
        .sort((a, b) => a.length - b.length);
      expect(tierSets).toContainEqual(['basic']);
      expect(tierSets).toContainEqual(['basic', 'standard']);
      // Listed literally so that adding a classification forces this boundary to be RE-READ rather
      // than silently widened. `probe` was removed on 2026-09-17 - it existed only to isolate the turn
      // entry, and once the channel flow became the default entry it was premium twice.
      expect(tierSets).toContainEqual(['basic', 'standard', 'premium']);
      // The Identity-Pool authenticated roles grant no Chime at all. So the ONLY
      // tier-gated allows come from the bearer-pinned Credential-Exchange roles
      // (SPEC-CREDENTIAL-EXCHANGE): one classification set each.
      // (only the restricted exchange role uses an UNCONDITIONED channel/* allow.)
      // One role per member classification, counted from the registry so removing or adding one
      // re-reads this boundary instead of failing on arithmetic. `probe` was removed on 2026-09-17.
      // An outside classification (the guest) has no role: its people are vended on the guest-session role.
      // THE ADMIN PLANE'S CHAT ROLE IS ONE OF THEM, gated to admin-plane channels alone (SPEC-ADMIN-IDENTITY FR1).
      const userFacing = DEFAULT_PROFILES_CONFIG.classifications.filter((c) => !c.adminPlane && c.audience !== 'outside').length;
      expect(tierSets).toHaveLength(userFacing + 1);
      expect(tierSets.filter((s) => s.length === 1 && s[0] === 'admin')).toHaveLength(1); // the admin plane, itself alone
      expect(tierSets.filter((s) => s.length === 1)).toHaveLength(2);           // basic and the admin plane, each itself alone
      expect(tierSets.filter((s) => s.length === userFacing)).toHaveLength(1);  // a set of every user-facing classification, ×1
      // NO SET REACHES PAST WHAT IT DECLARES, which is the property the literals above are a readable
      // form of. A role whose set contains a classification its widest member does not is a widening, and it
      // would pass every `toContainEqual` here while failing this.
      // REACH, NOT RANK. A set is a widening if it contains something the widest member does not
      // itself grant, which is the order-free form of "ranked above its own highest".
      const reachOf = (v: string) => defaultProfileRegistry.grantsFor(v);
      for (const set of tierSets as string[][]) {
        const widest = set.reduce((a, b) => (reachOf(b).length > reachOf(a).length ? b : a));
        const outside = set.filter((v: string) => !reachOf(widest).includes(v));
        expect(`${set.join(',')} outside the reach of ${widest}: ${outside.join(',') || 'none'}`)
          .toBe(`${set.join(',')} outside the reach of ${widest}: none`);
      }
      expect(unconditionedChannelSendAllows(template).length).toBeGreaterThanOrEqual(1); // the restricted exchange role
      // A MEMBER ROLE REACHES ADMIN-PLANE CHANNELS ONLY WITH THE `adminPlane` PRINCIPAL TAG: every such statement
      // names the admin plane alone and conditions on the session tag.
      const plane = tierGatedAllows(template).filter((d) => d.Sid === 'AllowAdminPlaneChannelActionsWhenHeld');
      expect(plane.length).toBe(userFacing);
      for (const d of plane) {
        expect(d.Condition.StringEquals).toEqual({ 'aws:ResourceTag/classification': ['admin'], 'aws:PrincipalTag/adminPlane': 'true' });
      }
    });

    it('user-side: every clearance group precedence is a non-negative INTEGER, widest grant set first', () => {
      // THE BUG THIS EXISTS FOR, measured 2026-09-16. Precedence was derived arithmetically from a
      // per-classification `rank` number whose only validated property was uniqueness, so inserting a
      // classification between two existing ones (rank 2.5, which is what a numeric rank is FOR)
      // produced `Precedence: 2.5`. Cognito requires a non-negative integer, and CloudFormation
      // refused the change set with `AWS::EarlyValidation::PropertyValidation`, before any resource was
      // touched, naming neither the property nor the resource. Nothing in the suite caught it because a
      // fractional value synthesizes perfectly well. The schema no longer has a rank to derive from; the
      // number comes from a POSITION, so it is an integer by construction.
      // Each classification's groups are its own stack's, at the precedence it declares; the admin plane's are Identity's.
      const groups = [vendApp().identity, ...vendApp().classifications]
        .flatMap((template) => Object.values(template.findResources('AWS::Cognito::UserPoolGroup')))
        .map((r: any) => ({ name: r.Properties.GroupName as string, precedence: r.Properties.Precedence as number }));
      expect(groups.length).toBeGreaterThanOrEqual(4);
      for (const g of groups) {
        expect(`${g.name}: ${g.precedence} integer=${Number.isInteger(g.precedence)} nonNegative=${g.precedence >= 0}`)
          .toBe(`${g.name}: ${g.precedence} integer=true nonNegative=true`);
      }
      // AND IT ORDERS BY HOW MUCH EACH ONE GRANTS, which is the only thing precedence has to mean: the
      // classification that reaches MORE takes a LOWER number and so wins the `cognito:groups` claim.
      // This asserted an order by rank, which is the same answer on a ladder and no answer at all
      // between peers. Asserting only integrality would pass for a constant.
      const grantCount = (v: string) => defaultProfileRegistry.grantsFor(v).length;
      const clearance = DEFAULT_PROFILES_CONFIG.groupClearance as Record<string, string>;
      // THE ADMIN PLANE IS NOT IN THIS ORDER: it grants itself alone and is held beside a member clearance.
      const byPrecedence = groups
        .filter((g) => clearance[g.name] !== undefined && !defaultProfileRegistry.adminPlaneValues().includes(clearance[g.name]))
        .sort((a, b) => a.precedence - b.precedence)
        .map((g) => clearance[g.name]);
      const byGrantCount = [...byPrecedence].sort((a, b) => grantCount(b) - grantCount(a));
      expect(`precedence order: ${byPrecedence.join(',')}`).toBe(`precedence order: ${byGrantCount.join(',')}`);
    });

    it('user-side: no Identity Pool, and no group carries a role, so every credential is the exchange\'s', () => {
      const templates = [vendApp().identity, ...vendApp().classifications];
      for (const template of templates) {
        template.resourceCountIs('AWS::Cognito::IdentityPool', 0);
        template.resourceCountIs('AWS::Cognito::IdentityPoolRoleAttachment', 0);
      }
      // Each classification's groups are its own stack's; the admin plane's are Identity's.
      const groups = templates.flatMap((template) => Object.values(template.findResources('AWS::Cognito::UserPoolGroup'))) as any[];
      expect(groups.filter((g) => g.Properties?.RoleArn !== undefined).map((g) => g.Properties.GroupName)).toEqual([]);
      // Every clearance group still exists: the exchange reads them as clearance through the registry.
      // DERIVED FROM THE CONFIG over `groupClearance`, not `classifications`: a GROUP name maps to a
      // CLASSIFICATION value, and the two need not be equal (the `admins` group clears for `admin`).
      const named = groups.map((g) => g.Properties.GroupName);
      for (const g of Object.keys(DEFAULT_PROFILES_CONFIG.groupClearance)) {
        expect(named).toContain(g);
      }
      expect(named).toContain('admins');
      expect(DEFAULT_PROFILES_CONFIG.groupClearance.admins).toBe('admin');
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
      const t = Template.fromStack(assistantsOf('basic')(new cdk.App(), 'AgentEchelonAssistants-basic', props));
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
      const t = Template.fromStack(assistantsOf('standard')(new cdk.App(), 'AgentEchelonAssistants-standard', props));
      const gets = getObjectResources(t);
      expect(hasContext(gets, 'basic')).toBe(true);
      expect(hasContext(gets, 'standard')).toBe(true);
      expect(hasContext(gets, 'premium')).toBe(false);
    });

    it('premium assistant: context S3 read includes basic + standard + premium (its declared set)', () => {
      const t = Template.fromStack(assistantsOf('premium')(new cdk.App(), 'AgentEchelonAssistants-premium', props));
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
      const t = Template.fromStack(assistantsOf('premium')(new cdk.App(), 'AgentEchelonAssistants-premium', props));
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
      const chime = new MessagingStack(app, 'TestChimeCC', { env, appInstanceName: 'test-instance' });
      const t = Template.fromStack(new IdentityStack(app, 'TestCognitoCC', { env, appInstanceArn: chime.appInstanceArn }));
      // Reading the store's NAME from the SSM contract is not access to the store: offboarding finds the
      // table so (lib/offboarding.ts), and its grant on the table is the Conversations stack's, on that role.
      const referencesChannelContext = allStatements(t)
        .filter((s) => !actionsOf(s).every((a) => a.startsWith('ssm:')))
        .some((s) => asArr(s.Resource).map(flat).some(isChannelContextRes));
      expect(referencesChannelContext).toBe(false);
    });

    // ── Guardrail selection boundary (§7 / 4.6b). A profile SELECTS a deployment-provisioned
    //    guardrail; it can never point at an arbitrary resource because the ApplyGuardrail grant
    //    is per-provisioned-ARN. Widening the grant to '*' (or a raw/arbitrary ARN) breaks this. ──
    it('assistant role can bedrock:ApplyGuardrail ONLY on in-stack provisioned guardrails, never * / arbitrary', () => {
      const t = Template.fromStack(assistantsOf('premium')(new cdk.App(), 'AgentEchelonAssistants-premium', props));
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
  it('the archive depends on conversations, never the reverse', () => {
    // The core deploys Messaging, Identity, Conversations, then Archive, which takes the feedback table
    // and the attachments bucket from Conversations in Aurora mode. The reversed dependency this pins
    // against made every fresh account's first deploy fail with "SSM parameter not available" - while
    // staying green on any account whose parameters already existed, which is why no
    // existing-deployment run could ever catch it.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'backend.ts'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/archiveStack\.addDependency\(conversationsStack\)/);
    expect(src).not.toMatch(/conversationsStack\.addDependency\(archiveStack\)/);
  });
});
