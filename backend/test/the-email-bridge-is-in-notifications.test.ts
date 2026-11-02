/**
 * THE EMAIL BRIDGE IS THE NOTIFICATIONS STACK'S OWN CONSUMER ON THE MESSAGE STREAM (ADR-041 decision 7).
 *
 * An assistant message carrying a `notify` directive reaches members who are not in the room, over
 * email. The fan-out runs after delivery, on the stream, in `lambda/src/notification-bridge.ts`, and its
 * function is in the Notifications stack, which holds the deployment's only SES send grant. Every piece
 * of its wiring fails silently when it is missing: without the SES grant the sends are refused and
 * collected rather than thrown, so a deployment loses every notification while every caller reports
 * success. So each piece is pinned here, and so is its absence where the bridge cannot resolve anyone.
 */
import * as cdk from 'aws-cdk-lib';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template } from 'aws-cdk-lib/assertions';
import * as fs from 'fs';
import * as path from 'path';
import { NotificationStack } from '../lib/stacks/notification-stack';
import { assistantClassifications } from '../lib/config/profiles';

const env = { account: '123456789012', region: 'us-east-1' };
const STREAM_ARN = 'arn:aws:kinesis:us-east-1:123456789012:stream/chime-messaging-test';

function synth(over: Record<string, unknown> = {}, context: Record<string, unknown> = {}): Template {
  const app = new cdk.App({ context });
  const messageStream = kinesis.Stream.fromStreamArn(new cdk.Stack(app, 'StreamHost', { env }), 'MessageStream', STREAM_ARN);
  return Template.fromStack(new NotificationStack(app, 'TestNotifications', {
    env,
    appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
    userPoolId: 'us-east-1_PRIMARY',
    classifications: assistantClassifications(),
    senderEmail: 'assistant@example.com',
    tokens: dynamodb.Table.fromTableArn(new cdk.Stack(app, 'TokensHost', { env }), 'Tokens', 'arn:aws:dynamodb:us-east-1:123456789012:table/tokens'),
    appUrl: 'https://app.example.com',
    messageStream,
    notifyBridge: true,
    notifyAdditionalUserPoolIds: ['us-east-1_SECOND'],
    ...over,
  }));
}

const bridgeFn = (t: Template): [string, any] | undefined =>
  Object.entries(t.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith('NotificationBridgeFunction'));

/** The statements on the policies attached to one function's role. */
function bridgeStatements(t: Template): any[] {
  const [, fn] = bridgeFn(t)!;
  const role = JSON.stringify(fn.Properties.Role);
  return (Object.values(t.findResources('AWS::IAM::Policy')) as any[])
    .filter((p) => role.includes(p.Properties.Roles[0].Ref))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
}
const actionsOf = (s: any): string[] => [].concat(s.Action);

describe('the email bridge', () => {
  const t = synth();

  it('consumes the message stream from LATEST, with no batching window', () => {
    const [id] = bridgeFn(t)!;
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      EventSourceArn: STREAM_ARN,
      StartingPosition: 'LATEST',
      FunctionName: { Ref: id },
    });
    const mapping = Object.values(t.findResources('AWS::Lambda::EventSourceMapping'))[0] as any;
    expect(mapping.Properties.MaximumBatchingWindowInSeconds).toBeUndefined();
  });

  it('resolves a recipient in any trusted pool and sends as the configured identity', () => {
    const all = bridgeStatements(t);
    const lookup = all.find((s) => actionsOf(s).includes('cognito-idp:AdminGetUser'));
    expect(lookup).toBeDefined();
    const pools = JSON.stringify(lookup.Resource);
    expect(pools).toContain('us-east-1_PRIMARY');
    expect(pools).toContain('us-east-1_SECOND');
    expect(actionsOf(lookup)).not.toContain('cognito-idp:AdminUpdateUserAttributes');

    const ses = all.find((s) => actionsOf(s).includes('ses:SendEmail'));
    const identities = JSON.stringify(ses.Resource);
    // BOTH the address and its parent domain: SES authorizes against whichever identity it resolves the
    // From address to, and a policy naming only the address is denied on the domain, silently.
    expect(identities).toContain('identity/assistant@example.com');
    expect(identities).toContain('identity/example.com');
    expect(identities).not.toContain('identity/*');
  });

  it('reads tags and membership on this app instance, and nothing that sends a message', () => {
    const chime = bridgeStatements(t).filter((s) => actionsOf(s).some((a) => a.startsWith('chime:')));
    const actions = chime.flatMap(actionsOf).sort();
    expect(actions).toEqual(expect.arrayContaining(['chime:ListChannelMemberships', 'chime:ListTagsForResource']));
    expect(actions.some((a) => /Send|Create|Delete|Update/.test(a))).toBe(false);
  });

  it('carries the registry, the sender and the link origin the fan-out reads', () => {
    const vars = bridgeFn(t)![1].Properties.Environment.Variables;
    expect(vars.USER_POOL_ID).toBe('us-east-1_PRIMARY');
    // The directory reads every pool the trusted-issuer registry declares (TRUSTED_ISSUERS); no second list travels.
    expect(vars.TRUSTED_ISSUERS).toBeDefined();
    expect(vars.NOTIFY_ALLOWED_POOL_IDS).toBeUndefined();
    expect(vars.SENDER_EMAIL).toBe('assistant@example.com');
    expect(vars.APP_URL).toBe('https://app.example.com');
  });

  it('alarms on a notification failing, because nothing else reports one', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AgentEchelon/Notifications',
      MetricName: 'Failed',
      TreatMissingData: 'notBreaching',
    });
  });

  it('is absent when the registry does not trust this deployment\'s own pool', () => {
    const off = synth({ notifyBridge: false });
    expect(bridgeFn(off)).toBeUndefined();
    off.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
  });

  it('runs the one rule, and post-processing no longer does', () => {
    const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'lambda', 'src', f), 'utf8');
    expect(src('notification-bridge.ts')).toMatch(/await notifyOnDelivery\(message\)/);
    expect(src('message-post-processing.ts')).not.toMatch(/notifyOnDelivery/);
  });
});

describe('the archival alarm', () => {
  it('watches the message stream and emails the declared recipients through the one notifier', () => {
    const t = synth({}, { alertRecipientArns: 'arn:aws:chime:us-east-1:123456789012:app-instance/test/user/u-1' });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'IncomingRecords',
      Namespace: 'AWS/Kinesis',
      ComparisonOperator: 'LessThanOrEqualToThreshold',
      TreatMissingData: 'breaching',
    });
    const notifier = Object.entries(t.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith('ArchivalAlarmFunction'));
    expect(notifier![1].Properties.Environment.Variables.ALERT_RECIPIENT_ARNS).toContain('/user/u-1');
  });

  it('is absent when no recipient is declared', () => {
    const t = synth();
    expect(Object.keys(t.findResources('AWS::Lambda::Function')).some((id) => id.startsWith('ArchivalAlarmFunction'))).toBe(false);
  });
});
