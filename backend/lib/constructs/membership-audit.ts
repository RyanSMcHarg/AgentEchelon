/**
 * MembershipAuditConstruct — SPEC-CONVERSATION-SECURITY Layer 6.
 *
 * Wires the near-real-time membership-audit consumer to a Chime -> Kinesis message stream.
 * ALWAYS instantiated by the Archive stack, in both modes, on the Messaging stack's stream - flagging uncleared
 * memberships for review is a standing security guarantee, not opt-in (the only knob is
 * `membershipAuditEnforce`: report-only vs auto-revoke). The Lambda is intentionally
 * NOT in a VPC: it only calls Chime, Cognito, SSM, and SES (all public AWS APIs), so it
 * needs no Aurora/VPC access even in Aurora mode.
 *
 * See `backend/lambda/src/membership-audit.ts` for the runtime behavior.
 */
import { Construct } from 'constructs';
import { dataRemovalPolicy } from '../config/environment';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as path from 'path';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { SHARED_SSM, SSM_ROOT, alertEmitterWiring, adminPlaneMembershipStatements, serviceAdminArnOf, EVERY_CLASSIFICATION } from '../stacks/agent-classification-common';
import { grantDirectoryRead } from './directory-access';
import { invitationIndexReadStatement } from './token-store';

/** Stable name for the membership-audit Lambda. Fixed (not CDK-generated) so user-management in the
 *  Identity stack can grant `lambda:InvokeFunction` on it and invoke it by name for the on-downgrade
 *  re-eval (#3) WITHOUT a cross-stack ARN import - the Archive stack already depends on Identity's user
 *  pool, so a reverse hard ref would be circular. Safe as a constant because the Archive stack runs in
 *  one mode (Athena XOR Aurora) at a time. */
export const MEMBERSHIP_AUDIT_FN_NAME = 'agent-echelon-membership-audit';

export interface MembershipAuditProps {
  /** The Chime -> Kinesis message stream (carries CREATE/UPDATE_CHANNEL_MEMBERSHIP events). */
  stream: kinesis.IStream;
  appInstanceArn: string;
  /** Primary Cognito user pool: member-clearance resolution + recipient contact lookup. */
  userPoolId: string;
  userPoolArn: string;
  /** SSM parameter NAME holding the app-instance-admin ARN (the cross-channel moderator bearer). */
  adminArnParam: string;
  /** When true, memberships exceeding the member's clearance are auto-revoked. Default false (report-only). */
  enforce?: boolean;
  /** Trigger #2 sweep schedule (EventBridge rate/cron expression). Default `rate(6 hours)`; bounds the
   *  Chime ListChannels/ListChannelMemberships cost of the full-membership sweep. */
  sweepRate?: string;
  /**
   * Trigger #2 channel cap, across the whole continuation chain. A run that hits it stops and logs the
   * remainder as unscanned.
   *
   * ── WHY THE DEFAULT MOVED FROM 500 (measured 2026-09-14) ──────────────────────────────────────
   *
   * The dev deployment has 698 channels, so a cap of 500 left 198 of them - 28 percent - permanently
   * outside the membership backstop. Not slowly, not on a bad day: every scheduled run stopped at the
   * same place, so the same 198 were never checked by anything. A cap sized below the deployment does
   * not bound a control's cost, it silently removes most of its coverage.
   *
   * The cap was doing two jobs and is now down to one. It was also the only thing stopping a sweep
   * running past its timeout, which is the sweep's own deadline and continuation now - so the cap is
   * purely a cost limit, and can be sized to the deployment rather than to one invocation. Measured:
   * 500 channels took 132 seconds, so 2000 fits comfortably inside a single run's 12-minute budget and
   * leaves room for this instance to grow before a continuation is even needed.
   *
   * A deployment larger than this should raise it. The warning names the shortfall so that is a
   * decision somebody makes, rather than a number they never see.
   */
  maxSweepChannels?: number;
}

export class MembershipAuditConstruct extends Construct {
  public readonly fn: lambdaNodeJs.NodejsFunction;
  public readonly auditTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: MembershipAuditProps) {
    super(scope, id);

    // Findings the admin dashboard reviews, plus the runtime enforce toggle (`config/enforce`
    // item). CDK creates the table only; the enforce item is written at runtime by the admin
    // API, so `cdk deploy` never resets a live report-only <-> auto-revoke choice.
    this.auditTable = new dynamodb.Table(this, 'AuditTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRemovalPolicy(this),
    });

    // WHERE FINDINGS ARE ANNOUNCED: an `ae.alert` event, as every platform alert is raised
    // (`lib/admin-notice.ts`). The `AdminServices` stack posts it into the admin channel when `admin` is declared.
    const alert = alertEmitterWiring(this);

    // THE TOKEN STORE, for one read: the invitation that names a member who has no `Identities` row yet
    // (an invitee), so the audit recognizes the record that admits them. Resolved at deploy from
    // `Conversations`, which this stack deploys after.
    const tokensName = ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.tokensName);
    const tokensArn = ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.tokensArn);

    this.fn = new lambdaNodeJs.NodejsFunction(this, 'Fn', {
      entry: path.join(__dirname, '../../lambda/src/membership-audit.ts'),
      handler: 'handler',
      functionName: MEMBERSHIP_AUDIT_FN_NAME,
      runtime: lambda.Runtime.NODEJS_20_X,
      // ── LONG ENOUGH TO SWEEP, MEASURED RATHER THAN GUESSED ──────────────────────────────────
      //
      // This was 30 seconds, and the sweep never once completed: 698 channels on the dev deployment,
      // each needing a memberships page plus per-member tag and clearance reads. Every scheduled run
      // was killed by the runtime, and because the only log line came after the loop, each kill was
      // silent - the membership backstop reported success by saying nothing.
      //
      // 15 minutes is the Lambda maximum and the sweep budgets itself to 12, continuing in a fresh
      // invocation when it runs out. The event-stream path (#1) that shares this function is
      // unaffected: it is a few calls per record and returns in milliseconds either way.
      timeout: cdk.Duration.minutes(15),
      memorySize: 256,
      environment: {
        USER_POOL_ID: props.userPoolId,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ADMIN_ARN_PARAM: props.adminArnParam,
        SSM_ROOT,
        AUDIT_TABLE: this.auditTable.tableName,
        MEMBERSHIP_AUDIT_ENFORCE: props.enforce ? 'true' : 'false',
        MAX_SWEEP_CHANNELS: String(props.maxSweepChannels ?? 2000),
        TOKENS_TABLE: tokensName,
        ...alert.env,
      },
    });

    // Trigger #2 (SPEC-CONVERSATION-SECURITY §11): scheduled full-membership sweep. Catches uncleared
    // memberships the event stream can't - a member who became uncleared AFTER joining (clearance
    // downgraded, or the channel re-tagged down), which emits no Chime membership event. Default every
    // 6h to bound ListChannels/ListChannelMemberships cost; the Lambda caps channels per run.
    new events.Rule(this, 'MembershipSweepSchedule', {
      schedule: events.Schedule.expression(props.sweepRate || 'rate(6 hours)'),
      targets: [
        new targets.LambdaFunction(this.fn, {
          event: events.RuleTargetInput.fromObject({ type: 'sweep' }),
        }),
      ],
    });

    // Consume the stream (its own iterator/checkpoint, independent of the archival consumer).
    props.stream.grantRead(this.fn);
    this.fn.addEventSource(
      new lambdaEventSources.KinesisEventSource(props.stream, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(5),
        retryAttempts: 3,
        bisectBatchOnError: true,
      }),
    );
    this.auditTable.grantReadWriteData(this.fn);
    // A conversation's invitations, through the sparse index that holds no token: read only, never a record
    // by its key, so this role can neither redeem nor read a token.
    this.fn.addToRolePolicy(invitationIndexReadStatement(tokensArn));

    // Chime: read channel classification from the immutable `classification` tag and revoke membership,
    // both as the service app-instance-admin (`/user/*`), the identity that reads and moderates across
    // channels WITHOUT being a member. ListTagsForResource replaces the old DescribeChannel metadata read so
    // the clearance-vs-classification comparison keys on the tamper-proof tag, not mutable channel metadata.
    //
    // NO SEND HERE. Amazon Chime SDK authorizes a send against its bearer, so `SendChannelMessage` on
    // `channel/*` and `user/*` let this role post as any person in any conversation. Its alert is an
    // `ae.alert` event, granted by `alert.grant` below, and posts nothing itself.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['chime:ListTagsForResource'],
        resources: [`${props.appInstanceArn}/channel/*`],
      }),
    );
    // THE EVICTION: in a channel of any declared classification, because
    // the audit is the detection for the member IAM cannot see and must reach every conversation, and
    // bearing the service admin by its exact ARN, never `/user/*`, which let this role remove members
    // as any person. A channel with no classification is not evicted from; the audit reports it.
    for (const stmt of adminPlaneMembershipStatements('AuditEvicts', props.appInstanceArn, {
      bearerArns: [serviceAdminArnOf(props.appInstanceArn)],
      channelClassifications: EVERY_CLASSIFICATION,
      actions: ['chime:DeleteChannelMembership'],
    })) this.fn.addToRolePolicy(stmt);
    alert.grant(this.fn.role!);

    // Enumeration for the sweep (#2) and the on-downgrade re-eval (#3): list channels (authorizes on the
    // app-instance resource), list a channel's members (channel/*), and list a user's channels (user/*).
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'chime:ListChannels',
          'chime:ListChannelMemberships',
          'chime:ListChannelMembershipsForAppInstanceUser',
        ],
        resources: [props.appInstanceArn, `${props.appInstanceArn}/channel/*`, `${props.appInstanceArn}/user/*`],
      }),
    );

    // A member's authoritative clearance, by PERSON: their subject in the pool is found through Identities,
    // then their groups are read through the clearance seam (AdminListGroupsForUser).
    grantDirectoryRead(this.fn, {
      appInstanceArn: props.appInstanceArn,
      userPoolId: props.userPoolId,
      poolReads: ['cognito-idp:AdminListGroupsForUser'],
    });

    // SSM: the app-instance-admin ARN.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: props.adminArnParam.replace(/^\//, ''),
          }),
          // Per-classification assistant bot ARNs, to resolve a bot member's classification.
          cdk.Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: `${SSM_ROOT.replace(/^\//, '')}/assistant/*`,
          }),
        ],
      }),
    );

    // SELF-INVOKE, so a sweep too large for one invocation continues instead of truncating.
    //
    // Scoped to THIS function by ARN - the audit may restart itself and nothing else. Without this
    // grant the continuation fails, which the sweep reports and survives: it ends where it stopped
    // and the next scheduled run starts over. A missing permission must not silently shorten the
    // membership backstop, so the failure is logged as an error rather than swallowed.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        // BUILT FROM THE NAME, not `this.fn.functionArn`. The function reads its role and the role
        // would then read the function, which CDK resolves as a circular dependency and refuses to
        // deploy - measured 2026-09-14, the whole Aurora stack failed to synth. The name is a fixed
        // literal this construct already owns, so composing the ARN names exactly one function and
        // introduces no reference back.
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'lambda',
            resource: 'function',
            resourceName: MEMBERSHIP_AUDIT_FN_NAME,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // NO SES: the email leg is the admin notification channel's own `notify` fan-out, which the posted
    // alert's metadata asks for (`lib/admin-channel-post.ts`, in the `AdminServices` stack).
  }
}
