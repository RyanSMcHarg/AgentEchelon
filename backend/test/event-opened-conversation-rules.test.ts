/**
 * THE RULES THAT OPEN A TYPED CONVERSATION EXIST ONLY FOR DECLARED EVENTS, ADMIT ONLY THEMSELVES, AND CARRY
 * NO CLASSIFICATION (`lib/constructs/event-opened-conversations.ts`).
 *
 * Synthesized on a bare stack with a stand-in creator, so each assertion is about the wiring alone:
 *   - a rule per declaration that resolves to the stack's classification, and none for any other;
 *   - its pattern is the declaration's source, detail type and filter, plus the instance for a platform event;
 *   - the creator's resource policy admits EventBridge from that rule's ARN and nothing else;
 *   - delivery is bounded (retries, maximum age, a dead-letter queue with an alarm), and the function's own
 *     asynchronous retries are off, because a retried creation is a second room;
 *   - the target input names the declaration and passes the event, and no rule's input carries a
 *     classification, which the refusal half proves by trying to declare one.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { CONVERSATION_TYPES } from '../lib/config/conversation-types';
import { OPS_EVENT_SOURCE, OPS_INCIDENT_OPENED } from '../lib/config/event-openers';
import { EVENT_OPENER_RETRY, wireEventOpenedConversations } from '../lib/constructs/event-opened-conversations';
import { INSTANCE_NAME } from '../lib/stacks/agent-classification-common';
import { assistantsOf } from './helpers/assistants';

function synth(classification: string): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, `Assistants-${classification}`, { env: { account: '111122223333', region: 'us-east-1' } });
  const role = new iam.Role(stack, 'CreatorRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  const creator = new lambda.Function(stack, 'TypedConversationFromEvent', {
    runtime: lambda.Runtime.NODEJS_20_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler=async()=>({})'), role,
  });
  wireEventOpenedConversations(stack, { classification, creator, creatorRole: role });
  return Template.fromStack(stack);
}

/** Run with a temporary type in the registry, removed afterwards whatever happens. */
function withType<T>(key: string, config: object, run: () => T): T {
  (CONVERSATION_TYPES as Record<string, unknown>)[key] = config;
  try {
    return run();
  } finally {
    delete (CONVERSATION_TYPES as Record<string, unknown>)[key];
  }
}

describe('the ops event opens an ops conversation at premium, and only there', () => {
  const premium = synth('premium');

  it('builds one rule, on the default bus, whose pattern is the declaration plus this instance', () => {
    premium.resourceCountIs('AWS::Events::Rule', 1);
    const [rule] = Object.values(premium.findResources('AWS::Events::Rule')) as Array<{ Properties: Record<string, any> }>;
    expect(rule.Properties.EventBusName).toBeUndefined();
    expect(rule.Properties.EventPattern).toEqual({
      source: [OPS_EVENT_SOURCE], 'detail-type': [OPS_INCIDENT_OPENED], detail: { instance: [INSTANCE_NAME] },
    });
  });

  it('hands the creator the declaration by id and the whole event, and no classification', () => {
    const [rule] = Object.values(premium.findResources('AWS::Events::Rule')) as Array<{ Properties: Record<string, any> }>;
    const [target] = rule.Properties.Targets;
    expect(target.InputTransformer.InputTemplate).toBe('{"aeOpener":"ops#0","event":<aws.events.event.json>}');
    expect(JSON.stringify(target)).not.toMatch(/classification/i);
    expect(target.RetryPolicy).toEqual({
      MaximumRetryAttempts: EVENT_OPENER_RETRY.targetRetryAttempts,
      MaximumEventAgeInSeconds: EVENT_OPENER_RETRY.maxEventAgeHours * 3600,
    });
    expect(target.DeadLetterConfig.Arn).toBeDefined();
  });

  it('the creator admits EventBridge from that rule alone', () => {
    const permissions = Object.values(premium.findResources('AWS::Lambda::Permission')) as Array<{ Properties: Record<string, any> }>;
    expect(permissions).toHaveLength(1);
    const [ruleId] = Object.keys(premium.findResources('AWS::Events::Rule'));
    expect(permissions[0].Properties).toMatchObject({
      Action: 'lambda:InvokeFunction',
      Principal: 'events.amazonaws.com',
      SourceArn: { 'Fn::GetAtt': [ruleId, 'Arn'] },
    });
  });

  it('retries a failed creation never, keeps what was not delivered, and alarms on it', () => {
    premium.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
      MaximumEventAgeInSeconds: EVENT_OPENER_RETRY.maxEventAgeHours * 3600,
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    premium.resourceCountIs('AWS::SQS::Queue', 1);
    premium.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible', Threshold: 0, ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it('grants the creator its welcomes: the router of its own classification, by name', () => {
    const policies = JSON.stringify(premium.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('lambda:InvokeFunction');
    expect(policies).toContain('/assistant/premium/router-arn');
    expect(policies).not.toContain('/assistant/standard/router-arn');
  });

  it('builds no rule, queue or alarm on a classification no declaration names', () => {
    const standard = synth('standard');
    standard.resourceCountIs('AWS::Events::Rule', 0);
    standard.resourceCountIs('AWS::SQS::Queue', 0);
    standard.resourceCountIs('AWS::Lambda::Permission', 0);
    standard.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  });
});

describe('the premium classification stack wires its creator to the declared rule', () => {
  it('the rule targets the stack\'s own TypedConversationFromEvent, and its permission names that rule', () => {
    const app = new cdk.App();
    const t = Template.fromStack(assistantsOf('premium')(app, 'AgentEchelonAssistants-premium', {
      env: { account: '123456789012', region: 'us-east-1' },
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
      attachmentsBucketName: 'agent-echelon-attachments-test',
      attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
      auroraDriftHookup: { rdsProxy: false, liveDrift: true },
    }));
    const rules = t.findResources('AWS::Events::Rule', { Properties: { EventPattern: { source: [OPS_EVENT_SOURCE] } } });
    const [ruleId] = Object.keys(rules);
    expect(Object.keys(rules)).toHaveLength(1);
    const fnId = Object.keys(t.findResources('AWS::Lambda::Function')).find((id) => id.startsWith('TypedConversationFromEvent'));
    expect(JSON.stringify(rules[ruleId].Properties.Targets)).toContain(fnId);
    const permissions = Object.values(t.findResources('AWS::Lambda::Permission')) as Array<{ Properties: Record<string, any> }>;
    const onCreator = permissions.filter((p) => JSON.stringify(p.Properties.FunctionName).includes(fnId!));
    expect(onCreator.map((p) => [p.Properties.Principal, p.Properties.SourceArn])).toEqual([['events.amazonaws.com', { 'Fn::GetAtt': [ruleId, 'Arn'] }]]);
  });
});

describe('a vendor bus or an alarm is declared the same way', () => {
  it('a declaration naming a partner bus puts its rule on that bus, with the declared filter and no instance', () => {
    const template = withType('tmp-vendor-incident', {
      classifications: ['premium'], driftEnabled: false, initiation: 'alert',
      openedBy: [{
        eventBus: 'aws.partner/pagerduty.com/abc', source: 'aws.partner/pagerduty.com/abc', detailType: 'incident.triggered',
        detail: { priority: ['P1'] },
        fields: { forPerson: '$.detail.assignee', topicLabel: '$.detail.title', concernedChannelArn: '$.detail.room' },
      }],
    }, () => synth('premium'));
    template.resourceCountIs('AWS::Events::Rule', 2);
    template.hasResourceProperties('AWS::Events::Rule', {
      EventBusName: 'aws.partner/pagerduty.com/abc',
      EventPattern: { source: ['aws.partner/pagerduty.com/abc'], 'detail-type': ['incident.triggered'], detail: { priority: ['P1'] } },
    });
  });
});

describe('NO RULE CAN CARRY A CLASSIFICATION FROM THE EVENT (refused at synth)', () => {
  it('a declaration reading the classification from the event fails the synth of every stack', () => {
    for (const classification of ['premium', 'standard']) {
      expect(() => withType('tmp-escalating', {
        classifications: ['premium'], driftEnabled: false, initiation: 'alert',
        openedBy: [{ source: 'x', detailType: 'y', fields: { forPerson: '$.detail.p', concernedChannelArn: '$.detail.c', classification: '$.detail.classification' } }],
      }, () => synth(classification))).toThrow(/fields\.classification is not a field an opener fills/);
    }
  });

  it('a declaration naming the type from the event is refused the same way', () => {
    expect(() => withType('tmp-retyping', {
      classifications: ['premium'], driftEnabled: false, initiation: 'alert',
      openedBy: [{ source: 'x', detailType: 'y', fields: { forPerson: '$.detail.p', concernedChannelArn: '$.detail.c', conversationType: '$.detail.type' } }],
    }, () => synth('premium'))).toThrow(/fields\.conversationType is not a field an opener fills/);
  });

  it('a type permitting several classifications builds its rule on the one it names, and nowhere else', () => {
    const build = (c: string) => withType('tmp-two', {
      classifications: ['standard', 'premium'], driftEnabled: false, initiation: 'alert',
      openedBy: [{ classification: 'standard', source: 'x', detailType: 'y', fields: { forPerson: '$.detail.p', concernedChannelArn: '$.detail.c' } }],
    }, () => synth(c));
    build('standard').resourceCountIs('AWS::Events::Rule', 1);
    build('premium').resourceCountIs('AWS::Events::Rule', 1); // ops alone
  });
});
