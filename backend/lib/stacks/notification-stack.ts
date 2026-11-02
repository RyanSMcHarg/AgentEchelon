import * as cdk from 'aws-cdk-lib';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import { grantDirectoryRead, grantEmailFanOut, type EmailConsentAccess } from '../constructs/directory-access';
import { grantTokenKinds } from '../constructs/token-store';
import { grantIssuerRegistry } from '../constructs/trusted-issuers';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import type { RouteSource, RouteSpec } from '../constructs/http-api';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { defaultProfileRegistry as profiles } from '../profile-registry';
import { SSM_ROOT, RES_PREFIX, STACK_PREFIX, INSTANCE_SSM, CAPABILITY_RESOURCES, CHANNEL_FLOW_ARN_SSM_KEY, botArnKey, SHARED_SSM, driftChannelCreateStatements, sayThroughRouterWiring, roomPrimaryReadStatements, membershipAsAssistantStatements, routerByNameEnvironment, routerByNameStatements, EVERY_CLASSIFICATION, messageTemplateReadStatements } from './agent-classification-common';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export interface NotificationStackProps extends cdk.StackProps {
  /**
   * The `Conversations` functions whose one email this stack sends (`TransactionalMail`): the invitations and
   * guest-upgrade functions, where the deployment builds them. Their invoke grant is attached here.
   */
  mailSenders?: readonly lambda.IFunction[];
  appInstanceArn: string;
  /** This deployment's own pool, or `''` when the registry declares none (L15). */
  userPoolId: string;
  /** The message stream, from the Messaging stack: the email bridge and the archival alarm read it. */
  messageStream: kinesis.IStream;
  /**
   * Run the email bridge: true when this deployment's own pool is a trusted issuer, so a recipient's
   * contact can be resolved. Absent, the stack carries no bridge.
   */
  notifyBridge?: boolean;
  /**
   * The other pools the trusted-issuer registry declares, for conversations whose members span more than
   * one issuer. A notify target's issuer is resolved to its pool and must be in this set (with this
   * deployment's own) to be looked up.
   */
  notifyAdditionalUserPoolIds?: string[];
  /**
   * The classifications this deployment creates an `Assistants-*` stack for: the routers a share's recap
   * turn is asked of. It must include the classification that declares `holdsBriefing`, when one does.
   */
  classifications: readonly string[];
  /**
   * Email address used as the sender for share notifications.
   * SES will create an email identity verification for this address.
   * In SES sandbox mode (the default for new AWS accounts), both sender
   * AND recipient emails must be verified. Request production access
   * via the SES console to send to any recipient.
   */
  senderEmail: string;
  /** Frontend URL for conversation deep links */
  appUrl?: string;
  /** The attachments bucket, which holds the message templates an email is worded from (ADR-062). */
  templateBucket?: { bucketName: string; bucketArn: string };
  /**
   * Set true when `senderEmail` is ALREADY a verified SES identity (or is
   * covered by a verified domain identity, or verification is managed outside
   * this stack). Skips creating the per-address `AWS::SES::EmailIdentity` —
   * which CloudFormation cannot do for an identity that already exists
   * ("AlreadyExists"). The SendEmail IAM grant and the SENDER_EMAIL env still
   * use the address, so delivery works.
   */
  senderEmailPreVerified?: boolean;
  /** The token store (A8), for each mail's unsubscribe and reply tokens. */
  tokens: dynamodb.ITable;
  /**
   * The email reply poster (M-8): its role and the one-conversation role it posts on, from Identity. Present
   * exactly when `replyDomain` is set.
   */
  replyPoster?: { roleArn: string; restrictedRoleArn: string };
}

/** The reply subdomain this deployment receives replies on, from `replyDomain`; empty when it takes none. */
export function replyDomainOf(node: { tryGetContext(key: string): unknown }): string {
  return String(node.tryGetContext('replyDomain') || '').trim().toLowerCase();
}

/** The key prefix a received reply is stored under until it is read. */
export const INBOUND_REPLY_PREFIX = 'replies/';

export class NotificationStack extends cdk.Stack implements RouteSource {
  /** The share route, on `PersonApi`. */
  public readonly routes: RouteSpec[] = [];

  constructor(scope: Construct, id: string, props: NotificationStackProps) {
    super(scope, id, props);

    // ============================================================
    // SES Email Identity
    //
    // Creates a verified email identity for the sender address.
    // After deployment, the email owner must click the verification
    // link that SES sends. Until verified, SendEmail calls will fail.
    //
    // For domain-level verification (avoids per-address verification),
    // replace EmailIdentity with a domain identity and add the DNS
    // records SES provides to your domain's DNS.
    // ============================================================

    // Skipped when senderEmailPreVerified: the address is already a verified SES
    // identity (CFN can't re-create an existing identity), or a domain identity
    // / external process handles verification. The IAM SendEmail grant + the
    // SENDER_EMAIL env below use the address directly, so delivery still works.
    const emailIdentity = props.senderEmailPreVerified
      ? undefined
      : new ses.EmailIdentity(this, 'SenderEmailIdentity', {
          identity: ses.Identity.email(props.senderEmail),
        });

    // ============================================================
    // Share Conversation Lambda
    // ============================================================

    // The recap for a new member is a turn by the room's assistant, asked of the router of the
    // conversation's classification (`lib/join-recap.ts`). One variable per conversational
    // classification, resolved at deploy from the parameter each classification stack publishes.
    // The proactive briefing creates a conversation at the classification that declares `holdsBriefing`
    // as that classification's assistant, so a deployment without that assistant stack has no assistant to run
    // it. A deployment that declares none builds no briefing.
    const briefingClassification = profiles.briefingClassification();
    if (briefingClassification && !props.classifications.includes(briefingClassification)) {
      throw new Error(
        `The Notifications stack needs the briefing classification "${briefingClassification}" deployed: the proactive briefing creates a `
        + `conversation at it as its assistant, and this deployment's assistant stacks are ${props.classifications.join(', ') || 'none'}.`,
      );
    }

    // ── WHAT EVERY MAIL NEEDS BEFORE IT MAY GO (B9, M-8) ─────────────────────────────────────────
    //
    // The recipient's preferences, keyed by person in the user-profile table; the token store for the
    // mail's unsubscribe link and reply address; and, where the deployment receives replies, the reply
    // subdomain. `grantEmailFanOut` grants these to every function that sends.
    const replyDomain = replyDomainOf(this.node);
    const preferencesTable = {
      tableName: ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.userProfileName),
      tableArn: ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.userProfileArn),
    };
    const consentFor = (conversationVoice: boolean): EmailConsentAccess => ({
      tokens: props.tokens,
      preferencesTable,
      ...(replyDomain ? { replyDomain } : {}),
      conversationVoice,
      ...(conversationVoice && props.templateBucket ? { templates: props.templateBucket } : {}),
    });

    const shareConversationRole = new iam.Role(this, 'ShareConversationRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // The join announcement is named to the router and the recap is the assistant's own turn
              // (RouterInvoke for both), so this role neither reads messages nor posts.
              actions: [
                'chime:DescribeChannel',
                // Verifies the caller is already a member of the conversation
                // before allowing them to share it with someone else.
                'chime:DescribeChannelMembership',
                // Counts the people in the conversation after the add, read as the caller, for the
                // caller's confirmation ("now a conversation of several people").
                'chime:ListChannelMemberships',
                // Reads the channel's classification from the IMMUTABLE `classification` tag
                // (not mutable metadata) for the uncleared-invite gate + bot-classification
                // binding, so a moderator cannot tamper metadata to weaken admission.
                'chime:ListTagsForResource',
              ],
              resources: [`${props.appInstanceArn}/*`],
            }),
            // THE ADD ITSELF, bearing the conversation's assistant, only in a conversation of a declared
            // classification and only as a bot carrying one (step 24). Who is added is a parameter IAM
            // cannot see; the handler's clearance gate and the membership audit decide that.
            ...membershipAsAssistantStatements('ShareAddsMember', props.appInstanceArn, EVERY_CLASSIFICATION, ['chime:CreateChannelMembership']),
          ],
        }),
        // WHO SPEAKS FOR THE ROOM: the share names the room's primary as the join line's assistant and as
        // the bearer of the add, so it resolves it (`primaryAssistantOf`).
        ResolveTheRoomsPrimary: new iam.PolicyDocument({
          statements: roomPrimaryReadStatements(this, EVERY_CLASSIFICATION),
        }),
        // THE ROUTERS, FOUND BY NAME, AND NOTHING ELSE IN THE CLASSIFICATION STACKS: the join line
        // (`memberJoined`) and the recap turn are the only things this function asks of them. No model grant: the share calls no model, the assistant does.
        RouterInvoke: new iam.PolicyDocument({
          statements: routerByNameStatements(this, EVERY_CLASSIFICATION),
        }),
        SSMPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              resources: [
                // Resolve the channel's per-classification bot (the real creator+member)
                // to add members as the assistant. No shared cross-classification
                // bot.
                `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/bot-arn`,
              ],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // BUNDLED rather than shipped as a raw asset, so it can use the TypeScript helpers that name a notice
    // and ask for a turn of the router.
    const shareConversationFunction = new lambdaNodeJs.NodejsFunction(this, 'ShareConversationFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: 'lambda/share-conversation/index.js',
      handler: 'handler',
      bundling: { minify: false, forceDockerBundling: false },
      // Timeout covers: Cognito lookup + Chime describe + the announcement through the router + an
      // asynchronous router invoke for the recap + SES.
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        ...(props.userPoolId ? { USER_POOL_ID: props.userPoolId } : {}),
        ...routerByNameEnvironment(),
        // A conversation whose people come from a group refuses sharing; the source is stamped on its
        // server-side context row (DESIGN-CONVERSATION-TYPES §6).
        CHANNEL_CONTEXT_TABLE: ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.channelContextName),
      },
      role: shareConversationRole,
    });
    // Who called is the edge authorizer's context, read through the registry (callerPersonId); the
    // registry travels with the directory grant below.
    // The recipient: the address finds one subject in the pool, which resolves to a person through
    // Identities; their clearance groups and name are read by person. The function sends no email and holds
    // no SES grant: the welcome it has the router say carries the email, which the bridge sends.
    grantDirectoryRead(shareConversationFunction, {
      appInstanceArn: props.appInstanceArn,
      userPoolId: props.userPoolId,
      poolReads: ['cognito-idp:ListUsers', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser'],
    });
    shareConversationRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ShareReadEnforcedMembershipSource',
      actions: ['dynamodb:GetItem'],
      resources: [ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.channelContextArn)],
    }));

    // ============================================================
    // The transactional sign-in mail
    // ============================================================

    // THE INVITATION AND CLAIM EMAILS, for the `Conversations` functions that issue their links
    // (`lambda/src/lib/transactional-mail.ts`). Fixed name, so those functions name it and are granted its
    // invoke without a dependency on this stack; on no API, and no other principal may invoke it.
    const transactionalMailFn = new lambdaNodeJs.NodejsFunction(this, 'TransactionalMailFunction', {
      functionName: CAPABILITY_RESOURCES.transactionalMail,
      entry: './lambda/src/transactional-mail.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      bundling: { minify: false, forceDockerBundling: false },
    });
    grantEmailFanOut(transactionalMailFn, {
      appInstanceArn: props.appInstanceArn,
      userPoolId: props.userPoolId,
      senderEmail: props.senderEmail,
      poolReads: [],
      identities: undefined,
      consent: consentFor(true),
    });
    // THE HAND-OFF, ATTACHED FROM HERE: the senders' roles may invoke this function only while this stack is
    // deployed, and `Conversations` is the same with or without it.
    const senderRoles = (props.mailSenders ?? []).map((fn) => fn.role).filter((r): r is iam.IRole => Boolean(r));
    if (senderRoles.length) {
      new iam.Policy(this, 'HandTheEmailToNotifications', {
        roles: senderRoles.map((role, i) => iam.Role.fromRoleName(this, `MailSenderRole${i}`, role.roleName)),
        statements: [new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [transactionalMailFn.functionArn] })],
      });
    }

    // ============================================================
    // The share route (on PersonApi)
    // ============================================================

    const appUrl = this.node.tryGetContext('appUrl') || props.appUrl || 'http://localhost:5173';

    // /share-conversation is a person route, behind the edge authorizer, so no anonymous caller can add a
    // user to a channel or send a SES email under an arbitrary sender name. The Lambda additionally
    // verifies the caller is a channel member, and names the sharer from the resolver rather than
    // trusting the request body.
    this.routes.push({
      api: 'person', method: 'POST', path: '/share-conversation', handler: shareConversationFunction, capability: 'notifications',
      throttle: { rate: 25, burst: 50 },
    });

    // ============================================================
    // Outputs
    // ============================================================


    new cdk.CfnOutput(this, 'SenderEmailIdentityArn', {
      value: `arn:aws:ses:${this.region}:${this.account}:identity/${props.senderEmail}`,
      description: 'SES email identity ARN — verify this email after deployment',
    });

    new cdk.CfnOutput(this, 'SESVerificationNote', {
      value: `Check ${props.senderEmail} inbox for SES verification email. In sandbox mode, recipients must also be verified.`,
      description: 'Post-deployment action required',
    });

    // ============================================================
    // Proactive Briefing — EventBridge-triggered proactive workflow
    //
    // Demonstrates the "proactive" half of the product story: on a
    // schedule, with no user in the loop, create a conversation, seed it
    // with the briefing, and email members a link INTO the conversation
    // via the notification workflow: never a presigned page, so the link
    // opens nothing without the recipient's own sign-in. Minimal-but-real: a genuine
    // deployed EventBridge feature, not hardened for dedupe (a periodic
    // re-fire intentionally produces a fresh briefing).
    //
    // Recipients + schedule are deployment config via CDK context:
    //   --context briefingRecipientArns='<AppInstanceUser ARN>,<AppInstanceUser ARN>'
    //   --context briefingScheduleRate='rate(1 day)'   (default: daily)
    // With no recipients the Lambda no-ops safely.
    // ============================================================

    if (briefingClassification) {
      // THE SERVICE ADMIN the briefing creates as, named exactly (the same derivation every creator uses).
      const briefingServiceAdminArn = `${props.appInstanceArn}/user/${RES_PREFIX}-admin`;
      const briefingRole = new iam.Role(this, 'ProactiveBriefingRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        inlinePolicies: {
          // CREATING a conversation at the briefing classification through the shared creator, as the service
          // admin and stamped with that classification only. The admin creates,
          // attaches the flow, adds the assistant and the recipients, and leaves, so its membership changes are
          // held only on a channel of that classification and bearing the admin's exact ARN (`membershipAsServiceAdminStatements`).
          // No grant bears an assistant: it creates, tags and adds as no bot. The seed line is named to
          // the router, so this role holds no send.
          ChimePolicy: new iam.PolicyDocument({
            statements: driftChannelCreateStatements(briefingClassification, props.appInstanceArn, this.region, this.account, briefingServiceAdminArn, { linkPostedOnSession: true }),
          }),
          // The context row the shared creator writes before the assistant is added (participants,
          // type, creation time), which the welcome reads.
          ChannelContext: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ['dynamodb:UpdateItem'],
                resources: [ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.channelContextArn)],
              }),
            ],
          }),
          // The seed line is named to the router (`sayThroughRouter`); this role speaks as nobody.
          NameANotice: new iam.PolicyDocument({
            statements: sayThroughRouterWiring(this, [briefingClassification]).statements,
          }),
          SSMPolicy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ['ssm:GetParameter'],
                resources: [
                  `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/bot-arn`,
                  // THE SERVICE ADMIN the shared creator creates as. Named rather than wildcarded: it is
                  // an identity.
                  `arn:aws:ssm:${this.region}:${this.account}:parameter${INSTANCE_SSM.appInstanceAdminArn}`,
                ],
              }),
            ],
          }),

        },
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ],
      });
      // SES identity must exist before the Lambda role references it.
      if (emailIdentity) briefingRole.node.addDependency(emailIdentity);

      // THE PEOPLE A BRIEFING IS FOR, by AppInstanceUser ARN, comma-separated. Their names and addresses are
      // resolved by the directory at send time; none is configured here.
      const briefingRecipientArns =
        (this.node.tryGetContext('briefingRecipientArns') as string | undefined) || '';
      const briefingScheduleRate =
        this.node.tryGetContext('briefingScheduleRate') || 'rate(1 day)';

      const proactiveBriefingFunction = new lambdaNodeJs.NodejsFunction(
        this,
        'ProactiveBriefingFunction',
        {
          entry: './lambda/src/proactive-briefing.ts',
          handler: 'handler',
          runtime: lambda.Runtime.NODEJS_20_X,
          timeout: cdk.Duration.seconds(60),
          memorySize: 512,
          role: briefingRole,
          environment: {
            APP_INSTANCE_ARN: props.appInstanceArn,
            // The proactive briefing creates a conversation at the briefing classification (its
            // metadata + classification tag) and runs as that classification's
            // assistant, with no shared cross-classification bot. The classification must match the
            // channel's `classification` tag or the fail-closed Layer 1 IAM would
            // block the assistant. Future: select a per-classification assistant per
            // recipient.
            BOT_ARN_PARAM: botArnKey(briefingClassification),
            ...sayThroughRouterWiring(this, [briefingClassification]).env,

            APP_URL: appUrl,
            // AppInstanceUser ARNs, comma-separated; the Lambda no-ops on none.
            BRIEFING_RECIPIENT_ARNS: briefingRecipientArns,
            // THE SERVICE ADMIN CREATES THE CHANNEL and attaches the flow before the assistant is a
            // member, so the assistant's welcome passes through the flow (`lib/channel-creation.ts`).
            CREATOR_BEARER_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
            CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY,
            // The context row the shared creator writes (participants, type, creation time).
            CHANNEL_CONTEXT_TABLE: ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.channelContextName),
            // THE ROOM IS NAMED FROM THE CLASSIFICATION'S conversation-name TEMPLATE (`conversation-name.ts`): the bucket the
            // templates are in and the root their pointers are under, which the read grant below names.
            ...(props.templateBucket ? { TEMPLATE_BUCKET: props.templateBucket.bucketName, SSM_ROOT } : {}),
          },
          bundling: { minify: false, forceDockerBundling: false },
        },
      );
      // Read-only, the briefing classification's templates and no other's (`messageTemplateReadStatements`), so a console
      // edit of `conversation-name` names the next briefing.
      if (props.templateBucket) {
        for (const stmt of messageTemplateReadStatements(this, props.templateBucket.bucketArn, briefingClassification)) briefingRole.addToPrincipalPolicy(stmt);
      }

      grantEmailFanOut(proactiveBriefingFunction, {
        appInstanceArn: props.appInstanceArn,
        userPoolId: props.userPoolId,
        senderEmail: props.senderEmail,
        consent: consentFor(true),
      });

      new events.Rule(this, 'ProactiveBriefingSchedule', {
        description: 'Fires the proactive briefing workflow on a schedule (no user in the loop)',
        schedule: events.Schedule.expression(briefingScheduleRate),
        targets: [new targets.LambdaFunction(proactiveBriefingFunction)],
      });

      new cdk.CfnOutput(this, 'ProactiveBriefingFunctionName', {
        value: proactiveBriefingFunction.functionName,
        description:
          'Proactive briefing Lambda. Invoke manually with: ' +
          'aws lambda invoke --function-name <this> /dev/stdout',
      });
    }


    // ============================================================
    // The email bridge: the notification fan-out on the message stream
    // ============================================================
    //
    // SPEC-NOTIFICATION-BRIDGE P1, ADR-041 decision 7. An assistant message carrying a `notify`
    // directive reaches members who are not watching: each person's contact is resolved by the directory
    // at send time (their issuer subject through `Identities`, then `AdminGetUser` on the trusted pool
    // that holds it) - never stored - and sent over SES. A second consumer of the stream beside
    // post-processing, so the send grant stays in this stack.
    //
    // Only when this deployment's own pool is a trusted issuer: without it there is nobody whose contact
    // the bridge can resolve, and the stack holds no bridge rather than one that cannot send.
    if (props.notifyBridge) {
      const bridgeFn = new lambdaNodeJs.NodejsFunction(this, 'NotificationBridgeFunction', {
        entry: './lambda/src/notification-bridge.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          // The origin a conversation link in the email is built on.
          APP_URL: props.appUrl || 'http://localhost:5173',
        },
        bundling: { minify: false, forceDockerBundling: false },
      });
      bridgeFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['kinesis:GetRecords', 'kinesis:GetShardIterator', 'kinesis:DescribeStream', 'kinesis:DescribeStreamSummary', 'kinesis:ListShards'],
        resources: [props.messageStream.streamArn],
      }));
      // READ ONLY: whether the conversation is the admin conversation (its immutable `aeChannelKind` tag)
      // and who its members are, bearing whoever posted the message. Nothing here reads message content:
      // the fan-out works from the stream record it was handed.
      bridgeFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['chime:ListTagsForResource', 'chime:ListChannelMemberships'],
        resources: [`${props.appInstanceArn}/*`],
      }));
      grantEmailFanOut(bridgeFn, {
        appInstanceArn: props.appInstanceArn,
        userPoolId: props.userPoolId,
        additionalPoolIds: props.notifyAdditionalUserPoolIds,
        senderEmail: props.senderEmail,
        consent: consentFor(true),
      });
      // LATEST: a notification for a message sent before the consumer existed reaches nobody who is
      // still waiting for it. No batching window, because the recipient's wait is the window.
      bridgeFn.addEventSource(new lambdaEventSources.KinesisEventSource(props.messageStream, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        // The handler swallows its own errors by contract, so retries exist for infrastructure faults alone.
        retryAttempts: 2,
      }));

      // A SIDE EFFECT NOBODY CAN SEE FAILING IS INDISTINGUISHABLE FROM ONE THAT IS NOT RUNNING. The
      // fan-out collects its send failures rather than throwing, so this metric is the only place a
      // failure is visible (ADR-041 decision 7). Left without an action: existing and visible is the
      // floor, and wiring it to a destination is the deployer's choice.
      new cloudwatch.Alarm(this, 'NotificationFailuresAlarm', {
        alarmName: `${STACK_PREFIX}-notification-failures`,
        alarmDescription:
          'Notifications are failing to reach their recipients. The fan-out never throws and its '
          + 'caller never surfaces the result, so this metric is the only place a failure is visible. '
          + 'Check the SES sender identity is verified and that the bridge role is allowed to send '
          + 'on the identity SES resolves the From address to.',
        metric: new cloudwatch.Metric({
          namespace: 'AgentEchelon/Notifications',
          metricName: 'Failed',
          statistic: 'Sum',
          period: cdk.Duration.hours(1),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        // No failures is the goal, not missing data.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }

    // ============================================================
    // The archival alarm (opt-in): the message stream has gone quiet
    // ============================================================
    //
    // Watches the stream's IncomingRecords. If the app instance stops streaming (the streaming
    // configuration removed, a quota hit, an IAM denial), the alarm fires after an hour of zero records
    // and the one alarm notifier emails the people named below. It is here because it emails, and this
    // stack holds the only SES send grant; the stream it watches is the Messaging stack's.
    //
    // Opt-in: only deploys the alarm and its notifier when `alertRecipientArns` is configured. Recipients
    // are PEOPLE, by AppInstanceUser ARN, comma-separated, as for the briefing:
    //   --context alertRecipientArns='<AppInstanceUser ARN>,<AppInstanceUser ARN>'
    // Their addresses are resolved by the directory at send time. In the SES sandbox, every recipient
    // must also be verified.
    //
    // The metric is on the stream, not an archival function, because in Athena mode there is no archival
    // function (Firehose delivers straight to S3), so the stream is the one signal both modes share.
    const alertRecipientArns = ((this.node.tryGetContext('alertRecipientArns') as string | undefined) || '')
      .split(',').map((arn) => arn.trim()).filter((arn) => /\/user\/[^/]+$/.test(arn));
    if (alertRecipientArns.length > 0) {
      const archivalAlarmTopic = new sns.Topic(this, 'ArchivalAlarmTopic', {
        displayName: 'AgentEchelon archival pipeline alarms',
      });
      // THE ONE ALARM NOTIFIER, as for every alarm in the deployment.
      const archivalAlarmFn = new lambdaNodeJs.NodejsFunction(this, 'ArchivalAlarmFunction', {
        entry: './lambda/src/alarm-to-admin-channel.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        environment: {
          ALERT_RECIPIENT_ARNS: alertRecipientArns.join(','),
        },
        bundling: { minify: false, forceDockerBundling: false },
      });
      grantEmailFanOut(archivalAlarmFn, {
        appInstanceArn: props.appInstanceArn,
        userPoolId: props.userPoolId,
        senderEmail: props.senderEmail,
        consent: consentFor(false),
      });
      archivalAlarmTopic.addSubscription(new snsSubs.LambdaSubscription(archivalAlarmFn));

      const archivalAlarm = new cloudwatch.Alarm(this, 'ArchivalPipelineAlarm', {
        alarmName: `${STACK_PREFIX}-archival-pipeline-stopped`,
        alarmDescription:
          'Kinesis IncomingRecords on the Amazon Chime SDK message stream has been zero for 1 hour, so '
          + 'messages are not being written to the archive and the admin dashboard will be empty '
          + 'until it is resolved. Likely causes: the messaging streaming configuration was removed or '
          + 'rewritten (check with aws chime-sdk-messaging get-messaging-streaming-configurations '
          + '--app-instance-arn <arn>); the Kinesis stream is throttled, deleted, or its retention expired; '
          + 'or the Firehose delivery role was denied the write to the archive bucket. See '
          + 'docs/guides/user/TROUBLESHOOTING.md (admin dashboard tabs silently empty).',
        metric: props.messageStream.metricIncomingRecords({
          period: cdk.Duration.hours(1),
          statistic: 'Sum',
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      archivalAlarm.addAlarmAction(new cloudwatchActions.SnsAction(archivalAlarmTopic));
    }

    // ============================================================
    // The preference page and one-click unsubscribe (B9, RFC 8058)
    // ============================================================
    //
    // `GET` and `POST /email/preferences?t=<token>` on PersonApi, with NO authorizer: one-click is posted
    // by a mail client that holds no session, so the `unsubscribe` token in the link is the credential.
    // Two layers (tenet D3): this role reaches the `unsubscribe#*` records of the token store and the
    // `<personId>#notices` items of the user-profile table, only their `muted`, `personArn` and
    // `updatedAt` attributes, and nothing else; the handler reads the person and the kind from the token's
    // record, never from the request (`email-preferences.ts`).
    const preferencesFn = new lambdaNodeJs.NodejsFunction(this, 'EmailPreferencesFunction', {
      entry: './lambda/src/email-preferences.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        TOKENS_TABLE: props.tokens.tableName,
        NOTICE_PREFERENCES_TABLE: preferencesTable.tableName,
        // The chat app's origin: a link past its live window points to the signed-in preferences screen.
        APP_URL: appUrl,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    grantTokenKinds(props.tokens, preferencesFn.role!, ['unsubscribe'], ['dynamodb:GetItem']);
    preferencesFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadNoticePreferences',
      actions: ['dynamodb:GetItem'],
      resources: [preferencesTable.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['*#notices'] } },
    }));
    preferencesFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'WriteNoticePreferences',
      actions: ['dynamodb:UpdateItem'],
      resources: [preferencesTable.tableArn],
      conditions: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['*#notices'] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['personId', 'muted', 'personArn', 'updatedAt'] },
      },
    }));
    for (const method of ['GET', 'POST'] as const) {
      this.routes.push({
        api: 'person', method, path: '/email/preferences', handler: preferencesFn, capability: 'notifications', auth: 'none',
        throttle: { rate: 10, burst: 20 },
      });
    }

    // ============================================================
    // A signed-in person's email preferences (B9, M-7)
    // ============================================================
    //
    // `GET` and `POST /email/preferences/mine` on PersonApi, behind the edge authorizer: the chat app's
    // preferences screen over the same `<personId>#notices` item the email's link changes. The person is the
    // caller the edge resolved, never the request's; this role reads and writes only `*#notices` items, and
    // only their `muted`, `personArn` and `updatedAt` attributes (`notice-preferences-api.ts`).
    const preferencesMineFn = new lambdaNodeJs.NodejsFunction(this, 'EmailPreferencesMineFunction', {
      entry: './lambda/src/notice-preferences-api.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        NOTICE_PREFERENCES_TABLE: preferencesTable.tableName,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ALLOWED_ORIGIN: appUrl,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    grantIssuerRegistry(preferencesMineFn, props.userPoolId);
    preferencesMineFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadOwnNoticePreferences',
      actions: ['dynamodb:GetItem'],
      resources: [preferencesTable.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['*#notices'] } },
    }));
    preferencesMineFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'WriteOwnNoticePreferences',
      actions: ['dynamodb:UpdateItem'],
      resources: [preferencesTable.tableArn],
      conditions: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['*#notices'] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['personId', 'muted', 'personArn', 'updatedAt'] },
      },
    }));
    for (const method of ['GET', 'POST'] as const) {
      this.routes.push({
        api: 'person', method, path: '/email/preferences/mine', handler: preferencesMineFn, capability: 'notifications',
        throttle: { rate: 10, burst: 20 },
      });
    }

    // ============================================================
    // Replies by email (M-8, B10): opt-in with `replyDomain`
    // ============================================================
    //
    // SES receives mail for the reply subdomain through a receipt rule in the account's ACTIVE rule set,
    // named by `replyRuleSet` (SES allows one active set per region, so the rule joins the set the account
    // already uses). The rule stores the message, then invokes the poster, which posts it as the person
    // only when its reply token, DMARC and From all hold (`email-reply.ts`). The domain's MX record (to
    // `inbound-smtp.<region>.amazonaws.com`) is the deployer's DNS.
    if (replyDomain) {
      const ruleSetName = String(this.node.tryGetContext('replyRuleSet') || '').trim();
      if (!ruleSetName) throw new Error('replyDomain is set and replyRuleSet is not: name the ACTIVE SES receipt rule set the reply rule joins');
      if (!props.replyPoster) throw new Error('replyDomain is set and Identity created no reply poster role');
      if (String(this.node.tryGetContext('replyDomainVerified') || '') !== 'true') {
        new ses.EmailIdentity(this, 'ReplyDomainIdentity', { identity: ses.Identity.domain(replyDomain) });
      }
      const inbound = new s3.Bucket(this, 'InboundReplies', {
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        // A reply is read once and deleted by the poster; anything it left expires.
        lifecycleRules: [{ prefix: INBOUND_REPLY_PREFIX, expiration: cdk.Duration.days(1) }],
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      });
      const ruleName = `${RES_PREFIX}-email-replies`;
      // This rule only, never any rule in the account (the same shape as the test inbox).
      inbound.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [inbound.arnForObjects(`${INBOUND_REPLY_PREFIX}*`)],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:ses:${this.region}:${this.account}:receipt-rule-set/${ruleSetName}:receipt-rule/${ruleName}` },
        },
      }));
      const posterRole = iam.Role.fromRoleArn(this, 'ImportedEmailReplyPosterRole', props.replyPoster.roleArn, { mutable: true });
      const posterFn = new lambdaNodeJs.NodejsFunction(this, 'EmailReplyFunction', {
        entry: './lambda/src/email-reply.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        role: posterRole,
        environment: {
          REPLY_DOMAIN: replyDomain,
          TOKENS_TABLE: props.tokens.tableName,
          INBOUND_BUCKET: inbound.bucketName,
          INBOUND_PREFIX: INBOUND_REPLY_PREFIX,
          RESTRICTED_ROLE_ARN: props.replyPoster.restrictedRoleArn,
        },
        bundling: { minify: false, forceDockerBundling: false },
      });
      // Reads a `reply#*` record and nothing else in the token store; reads and deletes the stored message.
      grantTokenKinds(props.tokens, posterRole, ['reply'], ['dynamodb:GetItem']);
      posterRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:DeleteObject'],
        resources: [inbound.arnForObjects(`${INBOUND_REPLY_PREFIX}*`)],
      }));
      // The From check: the address the person's issuer holds for them now.
      grantDirectoryRead(posterFn, {
        appInstanceArn: props.appInstanceArn,
        userPoolId: props.userPoolId,
        additionalPoolIds: props.notifyAdditionalUserPoolIds,
        poolReads: ['cognito-idp:AdminGetUser'],
      });
      const storeInBucket: ses.IReceiptRuleAction = {
        bind: () => ({ s3Action: { bucketName: inbound.bucketName, objectKeyPrefix: INBOUND_REPLY_PREFIX } }),
      };
      const rule = new ses.ReceiptRule(this, 'EmailReplyRule', {
        ruleSet: ses.ReceiptRuleSet.fromReceiptRuleSetName(this, 'ActiveRuleSet', ruleSetName),
        receiptRuleName: ruleName,
        recipients: [replyDomain],
        scanEnabled: true,
        tlsPolicy: ses.TlsPolicy.REQUIRE,
        actions: [storeInBucket, new sesActions.Lambda({ function: posterFn, invocationType: sesActions.LambdaInvocationType.EVENT })],
      });
      // SES checks it can write to the bucket when the rule is created, so the policy must exist first.
      rule.node.addDependency(inbound.policy!);
      new cdk.CfnOutput(this, 'ReplyDomainMx', {
        description: `The MX record ${replyDomain} needs so its mail reaches SES`,
        value: `${replyDomain} MX 10 inbound-smtp.${this.region}.amazonaws.com`,
      });
    }

    cdk.Tags.of(this).add('Component', 'Notifications');
  }
}
