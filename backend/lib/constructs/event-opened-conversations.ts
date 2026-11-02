/**
 * THE RULES THAT OPEN A TYPED CONVERSATION WHEN A DECLARED EVENT ARRIVES (ADR-053 Phase 1), and the one
 * grant the creator needs to welcome the people it opened the room for.
 *
 * Built on a classification's stack, beside its typed-conversation creator, from the conversation types'
 * `openedBy` declarations that resolve to this classification (`lib/config/event-openers.ts`). Nothing is
 * built for a classification no declaration names.
 *
 *  - ONE RULE PER DECLARATION, on the bus it names (the default bus when it names none, a partner bus by its
 *    name), whose pattern is the declared source, detail type and detail filter, plus this deployment's
 *    instance for a platform source (`matchInstance`). Its one target is the creator, handed
 *    `{ aeOpener, event }`: the declaration's id and the event as it arrived. The rule names the TYPE by
 *    naming the declaration; nothing in the target input carries a classification, and the creator creates
 *    at the one it was deployed with.
 *  - `targets.LambdaFunction` adds the creator's resource policy for that rule's ARN alone, so no other
 *    rule, bus or account can invoke it through EventBridge.
 *  - BOUNDED DELIVERY. EventBridge retries a delivery that failed (`targetRetryAttempts`) for at most
 *    `maxEventAgeHours`, then keeps the event in the dead-letter queue. The function's own asynchronous
 *    retries are OFF: a creation that ran and then failed (a timeout) would be a second room if retried, so
 *    it goes to the same queue instead. An alarm says when the queue holds anything.
 *  - THE WELCOMES: invoke on this classification's router, found by name at call time
 *    (`sayThroughRouterWiring`), so the creator names `memberWelcome` and the router says it as the room's
 *    primary. Nothing to speak with: no vend, no send.
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { CONVERSATION_TYPES } from '../config/conversation-types';
import { eventOpenersAt, resolveEventOpeners, type ResolvedOpener } from '../config/event-openers';
import { INSTANCE_NAME, RES_PREFIX, STACK_PREFIX, sayThroughRouterWiring } from '../stacks/agent-classification-common';

/** Delivery bounds for an event that opens a conversation. An incident room opened hours late misleads. */
export const EVENT_OPENER_RETRY = { targetRetryAttempts: 8, maxEventAgeHours: 1, dlqRetentionDays: 14 } as const;

/** The reserved EventBridge variable that is the whole matched event, as JSON. */
const WHOLE_EVENT = '<aws.events.event.json>';

/** The target input a rule hands the creator: the declaration's id, and the event unchanged. */
class OpenerInput extends events.RuleTargetInput {
  constructor(private readonly openerId: string) {
    super();
  }
  bind(): events.RuleTargetInputProperties {
    return { inputTemplate: `{"aeOpener":${JSON.stringify(this.openerId)},"event":${WHOLE_EVENT}}` };
  }
}

/** The event pattern a declaration matches, with this deployment's instance for a platform source. */
export function openerEventPattern(o: ResolvedOpener, instance: string = INSTANCE_NAME): events.EventPattern {
  const detail = { ...(o.opener.detail ?? {}), ...(o.opener.matchInstance ? { instance: [instance] } : {}) };
  return {
    source: [o.opener.source],
    detailType: [o.opener.detailType],
    ...(Object.keys(detail).length ? { detail } : {}),
  };
}

/**
 * THIS DEPLOYMENT'S ALARMS, BY NAME (ADR-061, the incident watch): every alarm a stack of this deployment declares is
 * named from its stack name (`<STACK_PREFIX>...`) or from the resource prefix (`<RES_PREFIX>-...`). The incident watch's
 * rule matches only these, and the router's alarm read reaches only these.
 */
export function incidentWatchAlarmPrefixes(stackPrefix: string = STACK_PREFIX, resPrefix: string = RES_PREFIX): string[] {
  return [...new Set([stackPrefix, `${resPrefix}-`])].filter(Boolean);
}

/** The incident watch's pattern: a CloudWatch alarm state change on the default bus, of this deployment's alarms. */
export function incidentWatchPattern(prefixes: readonly string[]): events.EventPattern {
  return {
    source: ['aws.cloudwatch'],
    detailType: ['CloudWatch Alarm State Change'],
    detail: { alarmName: prefixes.map((prefix) => ({ prefix })) },
  };
}

/** A construct id from a declaration id (`ops#0` -> `ops-0`). */
const idOf = (o: ResolvedOpener) => o.id.replace(/[^A-Za-z0-9-]/g, '-');

export interface EventOpenedConversationsProps {
  /** The classification this stack serves; its declarations alone are built. */
  classification: string;
  /** The typed-conversation creator. */
  creator: lambda.Function;
  /** The creator's role, which is granted the router invoke its welcomes need. */
  creatorRole: iam.IRole;
}

/**
 * Wire the declared events of one classification to its creator, and grant the creator its welcomes.
 * Throws at synth when any declaration in the registry is invalid.
 */
export function wireEventOpenedConversations(scope: Construct, props: EventOpenedConversationsProps): {
  rules: events.Rule[];
  deadLetterQueue?: sqs.Queue;
} {
  // EVERY DECLARATION IS CHECKED, not only this classification's, so an invalid one fails every synth.
  resolveEventOpeners(CONVERSATION_TYPES);

  // The welcomes: this classification's router, by name. The creator already knows the room's primary.
  const notices = sayThroughRouterWiring(scope, [props.classification], { resolvesPrimary: false });
  for (const [key, value] of Object.entries(notices.env)) props.creator.addEnvironment(key, value);
  for (const statement of notices.statements) props.creatorRole.addToPrincipalPolicy(statement);

  const openers = eventOpenersAt(CONVERSATION_TYPES, props.classification);
  if (!openers.length) return { rules: [] };

  const dlq = new sqs.Queue(scope, 'TypedConversationEventsDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    retentionPeriod: cdk.Duration.days(EVENT_OPENER_RETRY.dlqRetentionDays),
  });
  props.creator.configureAsyncInvoke({
    retryAttempts: 0,
    maxEventAge: cdk.Duration.hours(EVENT_OPENER_RETRY.maxEventAgeHours),
    onFailure: new destinations.SqsDestination(dlq),
  });

  const rules = openers.map((o) => {
    const rule = new events.Rule(scope, `OpensTypedConversation-${idOf(o)}`, {
      description: `Opens a "${o.typeKey}" conversation at ${o.classification} for ${o.opener.source} / ${o.opener.detailType}`,
      ...(o.opener.eventBus && o.opener.eventBus !== 'default'
        ? { eventBus: events.EventBus.fromEventBusName(scope, `OpenerBus-${idOf(o)}`, o.opener.eventBus) }
        : {}),
      eventPattern: openerEventPattern(o),
    });
    rule.addTarget(new targets.LambdaFunction(props.creator, {
      event: new OpenerInput(o.id),
      deadLetterQueue: dlq,
      retryAttempts: EVENT_OPENER_RETRY.targetRetryAttempts,
      maxEventAge: cdk.Duration.hours(EVENT_OPENER_RETRY.maxEventAgeHours),
    }));
    return rule;
  });

  // AN EVENT THAT OPENED NOTHING, because it was never delivered or the creation failed outright, is an
  // operator's to read: the queue keeps it, and this alarm says so.
  new cloudwatch.Alarm(scope, 'TypedConversationEventsDlqAlarm', {
    alarmName: `${cdk.Stack.of(scope).stackName}-typed-conversation-events-undelivered`,
    alarmDescription: 'An event declared to open a typed conversation was not delivered to the creator, or its creation '
      + 'failed outright, after every retry; it is kept in the typed conversation events dead-letter queue. '
      + 'See docs/specs/interaction/conversation/SPEC-CONVERSATION-TYPES.md.',
    metric: dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
    threshold: 0,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  return { rules, deadLetterQueue: dlq };
}
