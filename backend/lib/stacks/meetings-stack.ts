/**
 * MeetingsStack (`<prefix>Meetings`): the `meetings` capability (SPEC-ASSISTANT-MEETINGS, DESIGN-ASSISTANT-MEETINGS).
 *
 * A conversation's Amazon Chime SDK meeting:
 *  - the person routes `POST /meetings`, `/meetings/join` and `/meetings/end`, on the person API, each passing the caller's
 *    membership and clearance (`meeting-api.ts`);
 *  - each classification's run entry, which a workflow's `start_meeting` step invokes by its fixed name
 *    (`CAPABILITY_RESOURCES.meetingRun(classification)`) from that classification's router, and which acts only in that
 *    classification's conversations;
 *  - each classification's summary entry, which that router reads a meeting's figures through by its fixed name
 *    (`CAPABILITY_RESOURCES.meetingSummary(classification)`), to rewrite the ended card; a reader only (`meeting-summary.ts`);
 *  - the roster's source: Amazon Chime SDK meeting lifecycle events, filed in the conversation archive first (this
 *    stack's `meeting-events` delivery stream, `meeting_events/` in the archive bucket, the `meeting_events` Glue table)
 *    and then projected into Aurora where the deployment keeps it (`meeting-events.ts`), with a dead-letter queue an
 *    operator can replay.
 *
 * IT OWNS NO STORE OF ITS OWN. Its events are a family of the conversation archive, the system of record, and its
 * running meeting is a field of its server-only context item (`activeMeeting`), keyed
 * by the conversation and governed by its classification.
 *
 * ITS REACH INTO THE CORE: the person API carries its routes, and each classification's router names its own run and
 * summary functions and may invoke those alone (`assistant-profile-stack.ts`). Nothing in the core reads a meeting, so the capability adds and removes
 * cleanly.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import { MEETING_METRICS } from '../../lambda/src/lib/meeting-client-events';
import { MEETING_EVENT_COLUMNS } from '../../lambda/src/lib/meeting-event-shape';
import * as path from 'path';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { TRANSCRIPTS_FAMILY } from '../../lambda/src/lib/meeting-transcript';
import { RECORDINGS_FAMILY } from '../../lambda/src/lib/meeting-recording';
import { Construct } from 'constructs';
import { grantIssuerRegistry } from '../constructs/trusted-issuers';
import { grantLiveClearance } from '../constructs/directory-access';
import { serverEventStatements } from '../constructs/server-event-writer';
import type { RouteSource, RouteSpec } from '../constructs/http-api';
import { MEETING_LIFECYCLE_SOURCE } from '../../lambda/src/lib/meeting-lifecycle';
import { MEETING_RUN_TIMEOUT_SECONDS, MEETING_SUMMARY_TIMEOUT_SECONDS } from '../../lambda/src/lib/meeting-run';
import { typedCreatorName } from '../constructs/conversation-creator';
import { ANALYTICS_DB_NAME, ANALYTICS_PREFIX, ATHENA_WORKGROUP_NAME, CAPABILITY_RESOURCES, INSTANCE_NAME, ownInstanceMemberConversationFunctions, alertEmitterWiring, SHARED_SSM, resolveSharedSSM } from './agent-classification-common';

/** The archive family meeting events are filed under, and the stream that files them. */
export const MEETING_EVENTS_PREFIX = 'meeting_events';
export const MEETING_EVENTS_STREAM = `${ANALYTICS_PREFIX}-meeting-events`;
/** This instance's meeting metric, which the meeting API emits and the alarm reads. */
export const MEETINGS_METRIC_NAMESPACE = `${ANALYTICS_PREFIX}/Meetings`;
/** Client failures in an hour, across every meeting, that raise the alarm. */
export const CLIENT_FAILURES_PER_HOUR = 10;

/** The columns of a meeting event, declared once beside the record every writer files (`meeting-event-shape.ts`). */
export { MEETING_EVENT_COLUMNS };

export interface MeetingsStackProps extends cdk.StackProps {
  /** The Amazon Chime SDK app instance whose conversations hold meetings. */
  appInstanceArn: string;
  /** This deployment's own pool, which the trusted-issuer registry and the live clearance read. */
  selfPoolId: string;
  /** The chat app's origin, allowed by the meeting routes' CORS. */
  appUrl: string;
  /** The conversation archive, the system of record its events are filed in: its bucket and the key it is encrypted with. */
  archive: { bucketName: string; bucketArn: string; keyArn: string };
  /** The classifications with an assistants stack: each gets its own run and summary entry, which its router alone invokes. */
  classifications: readonly string[];
}

export class MeetingsStack extends cdk.Stack implements RouteSource {
  public readonly routes: RouteSpec[] = [];

  constructor(scope: Construct, id: string, props: MeetingsStackProps) {
    super(scope, id, props);
    const { appInstanceArn, selfPoolId, appUrl, archive } = props;
    const shared = resolveSharedSSM(this);

    /**
     * THE MEETING CONTROL PLANE. A meeting id is minted by `CreateMeeting`, so these actions name no resource ahead of the
     * call and the grant is account-wide; the boundary is the handler's (its header).
     */
    const controlPlane = new iam.PolicyStatement({
      sid: 'MeetingControlPlane',
      actions: ['chime:CreateMeeting', 'chime:CreateAttendee', 'chime:GetAttendee', 'chime:GetMeeting', 'chime:DeleteMeeting'],
      resources: ['*'],
    });
    /**
     * A MEETING IS CREATED WITH ITS CONVERSATION'S CLASSIFICATION AS A TAG, so the tag grant reaches meetings only and
     * writes only that key. Every other Amazon Chime SDK resource, an AppInstanceBot included, stays out of its reach.
     */
    const meetingTags = new iam.PolicyStatement({
      sid: 'MeetingClassificationTag',
      actions: ['chime:TagResource'],
      resources: [`arn:${this.partition}:chime:${this.region}:${this.account}:meeting/*`],
      conditions: { 'ForAllValues:StringEquals': { 'aws:TagKeys': ['classification'] } },
    });
    /** The conversation's context item: read, and the conditional claim and release of its meeting. Never a whole-item put. */
    const context = new iam.PolicyStatement({
      sid: 'ConversationContext',
      actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resources: [shared.channelContextArn],
    });
    /**
     * A MEETING'S OWN CONVERSATION, asked of the creator of the parent's classification (`typed-conversation-from-event.ts`):
     * this instance's member-audience creators only, by their fixed name. The creator holds the create and membership
     * grants at its one classification, so this function holds none.
     */
    const openMeetingConversations = new iam.PolicyStatement({
      sid: 'OpenMeetingConversations',
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:${this.partition}:lambda:${this.region}:${this.account}:function:${typedCreatorName('*')}`],
      conditions: ownInstanceMemberConversationFunctions(),
    });
    /**
     * A MEETING'S LIVE TRANSCRIPTION (SPEC-ASSISTANT-MEETINGS FR28): started and stopped on the meeting, which a policy can
     * name only as any meeting of this account and region; the boundary is the handler's, which turns it on at the start
     * where the deployment transcribes its meetings and otherwise only for a host.
     */
    // ON '*' BECAUSE IAM AUTHORIZES THESE TWO ACTIONS ONLY THERE: a statement naming `meeting/*` is refused even for a meeting of
    // this account (verified against the deployed role with iam:SimulatePrincipalPolicy, 2026-11-13). The statement holds these two actions alone, so nothing else widens with it.
    const transcription = new iam.PolicyStatement({
      sid: 'MeetingTranscription',
      actions: ['chime:StartMeetingTranscription', 'chime:StopMeetingTranscription'],
      resources: ['*'],
    });
    /**
     * THE TRANSCRIPT FAMILY OF THE CONVERSATION STORE (`transcripts/`, `meeting-transcript.ts`), and no other key in it: its
     * segments written while a meeting runs, and the transcript written from them once it has ended.
     */
    const attachmentsBucketArn = ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.attachmentsBucketArn);
    const attachmentsBucketName = cdk.Fn.select(5, cdk.Fn.split(':', attachmentsBucketArn));
    const transcriptObjects = new iam.PolicyStatement({
      sid: 'TranscriptObjects',
      actions: ['s3:PutObject', 's3:GetObject'],
      resources: [`${attachmentsBucketArn}/${TRANSCRIPTS_FAMILY}*`],
    });
    const transcriptListing = new iam.PolicyStatement({
      sid: 'TranscriptListing',
      actions: ['s3:ListBucket'],
      resources: [attachmentsBucketArn],
      conditions: { StringLike: { 's3:prefix': [`${TRANSCRIPTS_FAMILY}*`] } },
    });
    // Whether this deployment transcribes its meetings (`meetingTranscription`): "true" turns it on at every start.
    const transcribes = String(this.node.tryGetContext('meetingTranscription') ?? '').trim() === 'true';
    // Whether a meeting transcribed from its start is recorded (`meetingRecording`): only "false" starts with captions alone.
    const records = String(this.node.tryGetContext('meetingRecording') ?? '').trim() !== 'false';
    const ringSeconds = String(this.node.tryGetContext('meetingRingSeconds') ?? '').trim();
    // The longest a meeting runs (`meetingMaxMinutes`, 10 to 1440); absent, 90 minutes (`meeting-watch.ts`).
    const maxMinutes = String(this.node.tryGetContext('meetingMaxMinutes') ?? '').trim();
    // Whether recording mode also captures a meeting's audio and video (`meetingMediaRecording`): "true" captures it.
    const capturesMedia = String(this.node.tryGetContext('meetingMediaRecording') ?? '').trim() === 'true';
    const environment = {
      APP_INSTANCE_ARN: appInstanceArn,
      CHANNEL_CONTEXT_TABLE: shared.channelContextName,
      // The media is hosted in the stack's region.
      MEDIA_REGION: this.region,
      ALLOWED_ORIGIN: appUrl,
      MEETINGS_METRIC_NAMESPACE,
      // A MEETING'S OWN CONVERSATION is opened, and a member of its parent admitted to it, by the creator of the parent's
      // classification (`typed-conversation-from-event.ts`), found by its fixed name with the classification filled in.
      TYPED_CREATOR_NAME_PATTERN: typedCreatorName('{classification}'),
      // The deployment's ring length (`meetingRingSeconds`), so a status read says how much of a person's start's ring is left.
      ...(ringSeconds ? { MEETING_RING_SECONDS: ringSeconds } : {}),
      // The conversation store the transcript family is in, and whether meetings are transcribed from their start.
      ATTACHMENTS_BUCKET: attachmentsBucketName,
      MEETING_TRANSCRIPTION: transcribes ? 'true' : 'false',
      MEETING_RECORDING: records ? 'true' : 'false',
      MEETING_MEDIA_RECORDING: capturesMedia ? 'true' : 'false',
      // A change of recording mode the service raises no event for is handed to the meeting's router as this instance's.
      MEETING_LIFECYCLE_INSTANCE: INSTANCE_NAME,
    };

    // ── THE PERSON ROUTES ──────────────────────────────────────────────────────────────────────
    const api = new lambdaNodeJs.NodejsFunction(this, 'MeetingApiFunction', {
      entry: path.join(__dirname, '../../lambda/src/meeting-api.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(28),
      memorySize: 256,
      environment,
      bundling: { minify: false, forceDockerBundling: false },
    });
    api.addToRolePolicy(controlPlane);
    api.addToRolePolicy(meetingTags);
    api.addToRolePolicy(context);
    api.addToRolePolicy(openMeetingConversations);
    api.addToRolePolicy(transcription);
    // A HOST'S CHANGE OF RECORDING MODE is told to the meeting's chat through its router: the meetings' lifecycle source only.
    api.addToRolePolicy(new iam.PolicyStatement({
      sid: 'HandAModeChangeToItsRouter',
      actions: ['events:PutEvents'],
      resources: [`arn:${this.partition}:events:${this.region}:${this.account}:event-bus/default`],
      conditions: { StringEquals: { 'events:source': MEETING_LIFECYCLE_SOURCE } },
    }));
    /**
     * A HOST'S CONTROLS OVER THE PEOPLE IN A MEETING (SPEC-ASSISTANT-MEETINGS FR59): read who is in it, stop or restore an
     * attendee's audio, and remove one. Meetings only, which a policy can name only as any meeting of this account and
     * region; the host check is the handler's (`meeting-host-controls.ts`). The person routes' function alone holds it.
     */
    api.addToRolePolicy(new iam.PolicyStatement({
      sid: 'MeetingHostControls',
      actions: ['chime:ListAttendees', 'chime:UpdateAttendeeCapabilities', 'chime:BatchUpdateAttendeeCapabilitiesExcept', 'chime:DeleteAttendee'],
      resources: [`arn:${this.partition}:chime:${this.region}:${this.account}:meeting/*`],
    }));
    // A person's app files segments only: it never reads a transcript back through this function.
    api.addToRolePolicy(new iam.PolicyStatement({ sid: 'TranscriptSegmentWrites', actions: ['s3:PutObject'], resources: [`${attachmentsBucketArn}/${TRANSCRIPTS_FAMILY}*/segments/*`] }));
    // Membership bearing the caller, and the classification tag the clearance is checked against.
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['chime:DescribeChannelMembership'],
      resources: [`${appInstanceArn}/channel/*`, `${appInstanceArn}/user/*`],
    }));
    // Whether the caller moderates the room or the meeting's conversation, bearing the caller: who may end a meeting.
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['chime:DescribeChannelModerator'],
      resources: [`${appInstanceArn}/channel/*`, `${appInstanceArn}/user/*`],
    }));
    api.addToRolePolicy(new iam.PolicyStatement({ actions: ['chime:ListTagsForResource'], resources: [`${appInstanceArn}/channel/*`] }));
    // THE CALLER'S OWN MEETINGS (`POST /meetings/mine`): their conversations, listed bearing the caller, so a person's own
    // memberships are all that answers; and those conversations' rows, read in batches. Reads only.
    api.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ListTheCallersConversations',
      actions: ['chime:ListChannelMembershipsForAppInstanceUser'],
      resources: [`${appInstanceArn}/user/*`],
    }));
    api.addToRolePolicy(new iam.PolicyStatement({ sid: 'ReadTheirMeetingsRows', actions: ['dynamodb:BatchGetItem'], resources: [shared.channelContextArn] }));
    grantIssuerRegistry(api, selfPoolId);
    grantLiveClearance(api, { appInstanceArn, userPoolId: selfPoolId });
    for (const p of ['/meetings', '/meetings/join', '/meetings/end']) {
      this.routes.push({ api: 'person', method: 'POST', path: p, handler: api, capability: 'meetings', throttle: { rate: 10, burst: 20 } });
    }
    // Read when a conversation opens and on each reconnect, never on an interval.
    this.routes.push({ api: 'person', method: 'POST', path: '/meetings/status', handler: api, capability: 'meetings', throttle: { rate: 10, burst: 20 } });
    // Read when the app opens and when a meeting card or ring arrives, never on an interval.
    this.routes.push({ api: 'person', method: 'POST', path: '/meetings/mine', handler: api, capability: 'meetings', throttle: { rate: 5, burst: 10 } });
    // A host turns transcription on or off; an app reports what its person said in batches while it is on.
    this.routes.push({ api: 'person', method: 'POST', path: '/meetings/transcription', handler: api, capability: 'meetings', throttle: { rate: 5, burst: 10 } });
    this.routes.push({ api: 'person', method: 'POST', path: '/meetings/transcript', handler: api, capability: 'meetings', throttle: { rate: 20, burst: 40 } });
    // A host mutes, lets speak, or removes a person in the meeting, and a muted person asks to speak: a handful a meeting.
    for (const p of ['/meetings/speaking', '/meetings/remove', '/meetings/unmute-request']) {
      this.routes.push({ api: 'person', method: 'POST', path: p, handler: api, capability: 'meetings', throttle: { rate: 5, burst: 10 } });
    }
    // An app reports in batches of up to 20 events, a few times a meeting, so its bound is the start's.
    this.routes.push({ api: 'person', method: 'POST', path: '/meetings/events', handler: api, capability: 'meetings', throttle: { rate: 10, burst: 20 } });

    // ── THE RUN ENTRIES, one per classification, each invoked by that classification's router alone ──────────────
    // A Lambda invoke carries no caller identity, so the classification a run acts in is the function's own: its router is
    // the only principal granted invoke on it (`assistant-profile-stack.ts`), and the handler refuses a conversation whose
    // classification tag is another (`MEETING_RUN_CLASSIFICATION`, `meeting-api.ts`). Tenets D3 and D12.
    const runs = props.classifications.map((classification) => {
      const run = new lambdaNodeJs.NodejsFunction(this, `MeetingRunFunction-${classification}`, {
        entry: path.join(__dirname, '../../lambda/src/meeting-api.ts'),
        handler: 'runHandler',
        functionName: CAPABILITY_RESOURCES.meetingRun(classification),
        runtime: lambda.Runtime.NODEJS_20_X,
        // The router waits for it inside its own 30 seconds (`meeting-run.ts`).
        timeout: cdk.Duration.seconds(MEETING_RUN_TIMEOUT_SECONDS),
        memorySize: 256,
        environment: { ...environment, MEETING_RUN_CLASSIFICATION: classification },
        bundling: { minify: false, forceDockerBundling: false },
      });
      run.addToRolePolicy(controlPlane);
      run.addToRolePolicy(meetingTags);
      run.addToRolePolicy(context);
      run.addToRolePolicy(openMeetingConversations);
      // An ended meeting's transcript: its segments read and listed, the transcript written, its speakers named as the room shows them.
      run.addToRolePolicy(transcription);
      run.addToRolePolicy(transcriptObjects);
      run.addToRolePolicy(transcriptListing);
      run.addToRolePolicy(new iam.PolicyStatement({ sid: 'SpeakerNames', actions: ['chime:DescribeAppInstanceUser'], resources: [`${appInstanceArn}/user/*`] }));
      // The classification it starts the meeting under, and the one it checks against its own, read from the conversation's
      // immutable tag. A read only.
      run.addToRolePolicy(new iam.PolicyStatement({ actions: ['chime:ListTagsForResource'], resources: [`${appInstanceArn}/channel/*`] }));
      return run;
    });

    // ── THE ARCHIVE FAMILY: meeting events in the system of record ─────────────────────────────────
    /**
     * A DIRECT-PUT STREAM INTO THE CONVERSATION ARCHIVE, under `meeting_events/`, partitioned by Firehose's own arrival
     * date. Date prefixes cost nothing; content-based partitioning bills per gigabyte, per object and per query hour, and
     * classification is a column instead. Objects stay under the bucket's never-expired system-of-record rules, and a
     * failed delivery lands under the bucket's expiring `errors/` family.
     */
    const deliveryLogs = new logs.LogGroup(this, 'MeetingEventsDeliveryLogs', {
      logGroupName: `/aws/kinesisfirehose/${MEETING_EVENTS_STREAM}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const deliveryLogStream = new logs.LogStream(this, 'MeetingEventsDeliveryErrors', { logGroup: deliveryLogs, logStreamName: 'delivery-errors' });
    const deliveryRole = new iam.Role(this, 'MeetingEventsDeliveryRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
      description: 'Delivers meeting events to the conversation archive',
    });
    // Its own family and the expiring errors family only: it can write nothing else in the system of record.
    deliveryRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
      resources: [`${archive.bucketArn}/${MEETING_EVENTS_PREFIX}/*`, `${archive.bucketArn}/errors/${MEETING_EVENTS_PREFIX}/*`],
    }));
    deliveryRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'],
      resources: [archive.bucketArn],
    }));
    deliveryRole.addToPolicy(new iam.PolicyStatement({ actions: ['kms:GenerateDataKey', 'kms:Encrypt'], resources: [archive.keyArn] }));
    deliveryLogs.grantWrite(deliveryRole);
    const delivery = new firehose.CfnDeliveryStream(this, 'MeetingEventsDelivery', {
      deliveryStreamName: MEETING_EVENTS_STREAM,
      deliveryStreamType: 'DirectPut',
      extendedS3DestinationConfiguration: {
        bucketArn: archive.bucketArn,
        roleArn: deliveryRole.roleArn,
        prefix: `${MEETING_EVENTS_PREFIX}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/`,
        errorOutputPrefix: `errors/${MEETING_EVENTS_PREFIX}/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/`,
        bufferingHints: { intervalInSeconds: 60, sizeInMBs: 5 },
        compressionFormat: 'GZIP',
        cloudWatchLoggingOptions: { enabled: true, logGroupName: deliveryLogs.logGroupName, logStreamName: deliveryLogStream.logStreamName },
      },
    });
    delivery.node.addDependency(deliveryRole);

    /** Athena reads the family through this table, its partitions projected from the date prefixes. */
    new glue.CfnTable(this, 'MeetingEventsTable', {
      catalogId: this.account,
      databaseName: ANALYTICS_DB_NAME,
      tableInput: {
        name: MEETING_EVENTS_PREFIX,
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'projection.enabled': 'true',
          'projection.year.type': 'integer',
          'projection.year.range': '2024,2040',
          'projection.month.type': 'integer',
          'projection.month.range': '1,12',
          'projection.month.digits': '2',
          'projection.day.type': 'integer',
          'projection.day.range': '1,31',
          'projection.day.digits': '2',
          'storage.location.template': `s3://${archive.bucketName}/${MEETING_EVENTS_PREFIX}/year=\${year}/month=\${month}/day=\${day}/`,
        },
        storageDescriptor: {
          columns: [...MEETING_EVENT_COLUMNS],
          location: `s3://${archive.bucketName}/${MEETING_EVENTS_PREFIX}/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: { serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe', parameters: { 'ignore.malformed.json': 'true' } },
          compressed: true,
        },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
      },
    });

    /** A writer of meeting events: the stream, by its name, and nothing else in the archive. */
    const fileMeetingEvents = new iam.PolicyStatement({
      sid: 'MeetingEventsArchive',
      actions: ['firehose:PutRecordBatch'],
      resources: [delivery.attrArn],
    });
    /** Hand a function the meeting-events family: the stream, and the Aurora projection where the deployment keeps one. */
    const meetingEventWriters: lambda.Function[] = [];
    const grantFileMeetingEvents = (fn: lambda.Function, sid: string): void => {
      meetingEventWriters.push(fn);
      fn.addEnvironment('MEETING_EVENTS_DELIVERY_STREAM', MEETING_EVENTS_STREAM);
      fn.addEnvironment('AURORA_DATA_PLANE_ARN_PARAM', SHARED_SSM.auroraDataPlaneArn);
      fn.addToRolePolicy(fileMeetingEvents);
      // The data plane and its parameter, this instance's only; the client-events stream in these statements is not this family's.
      for (const s of serverEventStatements(this, sid).filter((st) => !st.actions.includes('firehose:PutRecordBatch'))) fn.addToRolePolicy(s);
    };
    // The person routes file what a participant's app reports (`POST /meetings/events`).
    grantFileMeetingEvents(api, 'MeetingApiEvents');
    // Both starts record the meeting they created, which is when its ring went out.
    for (const run of runs) grantFileMeetingEvents(run, 'MeetingRunEvents');

    // ── THE SUMMARY ENTRIES, one per classification, each invoked by that classification's router to rewrite an ended card ──
    for (const classification of props.classifications) {
      /**
       * A READER ONLY. It reads the conversation's record and the meeting-events family, from the Aurora projection where one
       * runs, else through Athena: that family's table and objects, the workgroup's results, and the archive key for those.
       * It writes nothing in the system of record and holds no meeting grant. Like the run entry it is its classification's
       * alone: only that classification's router may invoke it, and it answers nothing for a conversation whose
       * classification tag is another (`MEETING_SUMMARY_CLASSIFICATION`, `meeting-summary.ts`).
       */
      const summary = new lambdaNodeJs.NodejsFunction(this, `MeetingSummaryFunction-${classification}`, {
        entry: path.join(__dirname, '../../lambda/src/meeting-summary.ts'),
        handler: 'handler',
        functionName: CAPABILITY_RESOURCES.meetingSummary(classification),
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(MEETING_SUMMARY_TIMEOUT_SECONDS),
        memorySize: 256,
        environment: {
          APP_INSTANCE_ARN: appInstanceArn,
          CHANNEL_CONTEXT_TABLE: shared.channelContextName,
          AURORA_DATA_PLANE_ARN_PARAM: SHARED_SSM.auroraDataPlaneArn,
          ATHENA_WORKGROUP: ATHENA_WORKGROUP_NAME,
          ATHENA_DATABASE: ANALYTICS_DB_NAME,
          MEETING_SUMMARY_CLASSIFICATION: classification,
          // The longest a meeting runs (`meetingMaxMinutes`), so a meeting within it is never folded as abandoned (`meeting-figures.ts`).
          ...(maxMinutes ? { MEETING_MAX_MINUTES: maxMinutes } : {}),
        },
        bundling: { minify: false, forceDockerBundling: false },
      });
      summary.addToRolePolicy(new iam.PolicyStatement({ sid: 'ReadTheConversationsMeeting', actions: ['dynamodb:GetItem'], resources: [shared.channelContextArn] }));
      // The conversation's immutable classification tag, checked against its own. A read only.
      summary.addToRolePolicy(new iam.PolicyStatement({ sid: 'ReadTheConversationsClassification', actions: ['chime:ListTagsForResource'], resources: [`${appInstanceArn}/channel/*`] }));
      for (const s of serverEventStatements(this, 'MeetingSummary').filter((st) => !st.actions.includes('firehose:PutRecordBatch'))) summary.addToRolePolicy(s);
      summary.addToRolePolicy(new iam.PolicyStatement({
        sid: 'QueryTheMeetingEvents',
        // Stop: a query still running at the read's deadline is stopped rather than left scanning (`runArchiveQuery`).
        actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults', 'athena:StopQueryExecution'],
        resources: [`arn:${this.partition}:athena:${this.region}:${this.account}:workgroup/${ATHENA_WORKGROUP_NAME}`],
      }));
      summary.addToRolePolicy(new iam.PolicyStatement({
        sid: 'TheMeetingEventsTable',
        actions: ['glue:GetTable', 'glue:GetPartitions', 'glue:GetDatabase'],
        resources: [
          `arn:${this.partition}:glue:${this.region}:${this.account}:catalog`,
          `arn:${this.partition}:glue:${this.region}:${this.account}:database/${ANALYTICS_DB_NAME}`,
          `arn:${this.partition}:glue:${this.region}:${this.account}:table/${ANALYTICS_DB_NAME}/${MEETING_EVENTS_PREFIX}`,
        ],
      }));
      summary.addToRolePolicy(new iam.PolicyStatement({
        sid: 'TheMeetingEventsObjects',
        actions: ['s3:GetObject'],
        resources: [`${archive.bucketArn}/${MEETING_EVENTS_PREFIX}/*`, `${archive.bucketArn}/athena-results/*`],
      }));
      summary.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetBucketLocation', 's3:ListBucket'], resources: [archive.bucketArn] }));
      // Athena writes the query's results under the workgroup's own prefix: the only write, and outside the record.
      summary.addToRolePolicy(new iam.PolicyStatement({ sid: 'TheQueryResults', actions: ['s3:PutObject'], resources: [`${archive.bucketArn}/athena-results/*`] }));
      summary.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:Decrypt', 'kms:GenerateDataKey'], resources: [archive.keyArn] }));
    }

    // ── THE ROSTER'S SOURCE: the meeting lifecycle, filed in the archive ────────────────────────────
    /** Events that could not be filed after retries, replayable: the ingest is idempotent. */
    const eventDlq = new sqs.Queue(this, 'MeetingEventsDlq', { retentionPeriod: cdk.Duration.days(14), enforceSSL: true });
    const eventFn = new lambdaNodeJs.NodejsFunction(this, 'MeetingEventsFunction', {
      entry: path.join(__dirname, '../../lambda/src/meeting-events.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      // A handler that throws is retried by Lambda's asynchronous invoke and then lands here, beside the rule target's
      // undelivered events, so every unfiled event is in one queue.
      deadLetterQueue: eventDlq,
      retryAttempts: 2,
      environment: { APP_INSTANCE_ARN: appInstanceArn, MEETING_LIFECYCLE_INSTANCE: INSTANCE_NAME, CHANNEL_CONTEXT_TABLE: shared.channelContextName },
      bundling: { minify: false, forceDockerBundling: false },
    });
    // The archive first, then the Aurora projection where one runs.
    grantFileMeetingEvents(eventFn, 'MeetingEvents');
    // A start or an end, handed to the conversation's router through the default bus, under this capability's source only.
    eventFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'HandAMeetingToItsRouter',
      actions: ['events:PutEvents'],
      resources: [`arn:${this.partition}:events:${this.region}:${this.account}:event-bus/default`],
      conditions: { StringEquals: { 'events:source': MEETING_LIFECYCLE_SOURCE } },
    }));
    // The conversation's classification, which decides where the row is filed. A read; this function holds no meeting grant.
    eventFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['chime:ListTagsForResource'], resources: [`${appInstanceArn}/channel/*`] }));
    // The conversation's record of the meetings this deployment created, which decides whether an event is filed at all.
    eventFn.addToRolePolicy(new iam.PolicyStatement({ sid: 'ReadTheConversationsMeetings', actions: ['dynamodb:GetItem'], resources: [shared.channelContextArn] }));
    // WHEN A PERSON LAST JOINED THE RUNNING MEETING (`recordMeetingJoin`), which the meeting's watch reads ahead of the events
    // store: the `activeMeeting` attribute alone, written and never read back.
    eventFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RecordAJoinOnTheRunningMeeting',
      actions: ['dynamodb:UpdateItem'],
      resources: [shared.channelContextArn],
      conditions: {
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['channelArn', 'activeMeeting'] },
        StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] },
      },
    }));

    /**
     * MATCHED ON THE SERVICE AND THE EVENT SHAPE. A meeting event names its `externalMeetingId`, not a channel ARN, so the
     * rule cannot filter by app instance; the consumer derives the conversation and skips an event whose conversation this
     * app instance does not hold (`meeting-events.ts`).
     */
    new events.Rule(this, 'MeetingLifecycleRule', {
      description: 'Amazon Chime SDK meeting lifecycle events, filed as the roster source',
      eventPattern: { source: ['aws.chime'], detailType: ['Chime Meeting State Change'] },
      targets: [new targets.LambdaFunction(eventFn, { deadLetterQueue: eventDlq, retryAttempts: 2 })],
    });
    // ── A MEETING'S AUDIO AND VIDEO RECORDING (SPEC-ASSISTANT-MEETINGS FR70), where `meetingMediaRecording` is "true" ──────
    if (capturesMedia) this.mediaRecording({ api, runs, appInstanceArn, attachmentsBucketArn, attachmentsBucketName, environment, context, eventDlq, grantFileMeetingEvents });
    // A PROJECTION A WRITER COULD NOT MAKE IS HANDED ON to the meeting-events function (`fileMeetingEvents`), whose retries
    // and dead-letter queue keep it until it lands: every other writer of the family may invoke it, asynchronously.
    for (const writer of meetingEventWriters) {
      if (writer === eventFn) continue;
      writer.addEnvironment('MEETING_EVENTS_FUNCTION', eventFn.functionName);
      eventFn.grantInvoke(writer);
    }

    new cdk.CfnOutput(this, 'MeetingEventsDlqUrl', {
      value: eventDlq.queueUrl,
      description: 'Meeting lifecycle events that could not be filed; replayable, the ingest is idempotent',
    });
    // ── WHAT AN OPERATOR WATCHES: one alarm to the admins ───────────────────────────────────────────────────────
    // Every meeting figure a person reads is the console's, folded from the recorded events (`meeting-figures.ts`, tenet
    // D7), so no dashboard charts one. The one metric is the dimensionless failure count the meeting API emits for this
    // alarm alone (`recordClientFailures`): an alarm needs a series, and the alarm points the operator to the console.
    const failures = new cloudwatch.Metric({
      namespace: MEETINGS_METRIC_NAMESPACE, metricName: MEETING_METRICS.clientFailure, statistic: 'Sum', period: cdk.Duration.hours(1),
    });

    const alarmTopic = new sns.Topic(this, 'MeetingAlarmTopic', { displayName: 'Meetings: client failures' });
    const alert = alertEmitterWiring(this);
    const notifier = new lambdaNodeJs.NodejsFunction(this, 'MeetingAlarmToAdminChannelFunction', {
      entry: path.join(__dirname, '../../lambda/src/alarm-to-admin-channel.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: { ...alert.env },
      bundling: { externalModules: ['@aws-sdk/*'], minify: true, sourceMap: true },
    });
    alert.grant(notifier.role!);
    alarmTopic.addSubscription(new snsSubs.LambdaSubscription(notifier));
    const failureAlarm = new cloudwatch.Alarm(this, 'MeetingClientFailuresAlarm', {
      alarmDescription:
        `People's apps reported more than ${CLIENT_FAILURES_PER_HOUR} meeting failures in an hour: joins, devices or the connection. `
        + 'Open the Meetings tab in the console to see which meetings, which failure types and when.',
      metric: failures,
      threshold: CLIENT_FAILURES_PER_HOUR,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      // No meetings is not a failure.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    failureAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
    failureAlarm.addOkAction(new cloudwatchActions.SnsAction(alarmTopic));

    cdk.Tags.of(this).add('Component', 'Meetings');
  }

  /**
   * THE MEDIA CAPTURE AND CONCATENATION OF A RECORDED MEETING (`meeting-media-capture.ts`, `meeting-recording-events.ts`).
   *  - The person routes and the run entry start a capture when recording turns on and stop it, then concatenate it, when
   *    recording turns off or the meeting ends. The developer guide's caller grants ("Understanding Amazon Chime SDK media
   *    pipeline creation"): the media pipeline actions, on media pipelines and meetings of this account and region, and
   *    `s3:GetBucketPolicy`, which the service checks the sink with, on the conversation store alone.
   *  - The recording's event function finishes each part from the services' own events: a pipeline's state change, and
   *    the conversation store's object created for a recording's file. It concatenates a capture that stopped on its own,
   *    deletes a finished part's capture chunks (that family's `capture/` keys only), files each step, and tells the
   *    meeting's router.
   * The media pipelines service itself writes under `recordings/` by the conversation store's bucket policy
   * (`meeting-recordings.ts`); the account needs the service-linked role AWSServiceRoleForAmazonChimeSDKMediaPipelines.
   */
  private mediaRecording(w: {
    api: lambda.Function; runs: lambda.Function[]; appInstanceArn: string; attachmentsBucketArn: string; attachmentsBucketName: string;
    environment: Record<string, string>; context: iam.PolicyStatement; eventDlq: sqs.IQueue;
    grantFileMeetingEvents: (fn: lambda.Function, sid: string) => void;
  }): void {
    const pipelinesAndMeetings = [
      `arn:${this.partition}:chime:${this.region}:${this.account}:media-pipeline/*`,
      `arn:${this.partition}:chime:${this.region}:${this.account}:meeting/*`,
    ];
    const capture = new iam.PolicyStatement({
      sid: 'MeetingMediaCapture',
      actions: ['chime:DeleteMediaCapturePipeline', 'chime:GetMediaCapturePipeline', 'chime:GetMediaPipeline'],
      resources: pipelinesAndMeetings,
    });
    // A PIPELINE IS CREATED ON '*': IAM authorizes the two create actions only there, since the pipeline does not exist yet
    // (verified against the deployed role with iam:SimulatePrincipalPolicy, 2026-11-13). This statement holds the creates alone;
    // what a pipeline may capture and where it writes stay bounded by the meeting it names and the sink's bucket policy.
    const createPipelines = new iam.PolicyStatement({
      sid: 'MeetingMediaPipelineCreate',
      actions: ['chime:CreateMediaCapturePipeline', 'chime:CreateMediaConcatenationPipeline'],
      resources: ['*'],
    });
    const sinkPolicy = new iam.PolicyStatement({ sid: 'MeetingMediaSinkPolicy', actions: ['s3:GetBucketPolicy'], resources: [w.attachmentsBucketArn] });
    const handToRouter = new iam.PolicyStatement({
      sid: 'HandARecordingToItsRouter',
      actions: ['events:PutEvents'],
      resources: [`arn:${this.partition}:events:${this.region}:${this.account}:event-bus/default`],
      conditions: { StringEquals: { 'events:source': MEETING_LIFECYCLE_SOURCE } },
    });
    for (const fn of [w.api, ...w.runs]) {
      fn.addToRolePolicy(capture);
      fn.addToRolePolicy(createPipelines);
      fn.addToRolePolicy(sinkPolicy);
    }
    // The person routes already hand a mode change to the router; the run entry, which ends a meeting, hands a failed part.
    for (const run of w.runs) {
      run.addToRolePolicy(handToRouter);
      run.addEnvironment('MEETING_LIFECYCLE_INSTANCE', INSTANCE_NAME);
    }

    const fn = new lambdaNodeJs.NodejsFunction(this, 'MeetingRecordingEventsFunction', {
      entry: path.join(__dirname, '../../lambda/src/meeting-recording-events.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      deadLetterQueue: w.eventDlq,
      retryAttempts: 2,
      environment: { ...w.environment, MEETING_LIFECYCLE_INSTANCE: INSTANCE_NAME },
      bundling: { minify: false, forceDockerBundling: false },
    });
    fn.addToRolePolicy(w.context);
    fn.addToRolePolicy(capture);
    fn.addToRolePolicy(createPipelines);
    fn.addToRolePolicy(sinkPolicy);
    fn.addToRolePolicy(handToRouter);
    fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'RecordingListing', actions: ['s3:ListBucket'], resources: [w.attachmentsBucketArn], conditions: { StringLike: { 's3:prefix': [`${RECORDINGS_FAMILY}*`] } } }));
    fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'CaptureChunkCleanup', actions: ['s3:DeleteObject'], resources: [`${w.attachmentsBucketArn}/${RECORDINGS_FAMILY}*/capture/*`] }));
    w.grantFileMeetingEvents(fn, 'MeetingRecordingEvents');

    const target = new targets.LambdaFunction(fn, { deadLetterQueue: w.eventDlq, retryAttempts: 2 });
    new events.Rule(this, 'MeetingMediaPipelineRule', {
      description: 'Amazon Chime SDK media pipeline state changes: a recorded meeting\'s capture and concatenation',
      eventPattern: { source: ['aws.chime'], detailType: ['Chime Media Pipeline State Change'] },
      targets: [target],
    });
    new events.Rule(this, 'MeetingRecordingWrittenRule', {
      description: 'A recorded meeting\'s composited audio and video file, written to the conversation store',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: { bucket: { name: [w.attachmentsBucketName] }, object: { key: [{ wildcard: `${RECORDINGS_FAMILY}*/media/composited-video/*.mp4` }] } },
      } as events.EventPattern,
      targets: [target],
    });
  }
}
