/**
 * AN ARCHIVAL BATCH THAT EXHAUSTS ITS RETRIES IS KEPT, AND THE ADMINS ARE TOLD.
 *
 * The archival function's Kinesis event source retries a failed batch and then moves on. Without a failure
 * destination the batch's position is lost with it, and the turn telemetry it carried lives on only in the
 * message-analytics table for its seven-day TTL. The stack keeps the position in a dead-letter queue that
 * outlives that TTL, and alarms on the queue through the one alarm notifier that posts to the admin channel.
 * The function's half (health recorded on failure, a failed telemetry read retried) is
 * `a-failed-archival-batch-is-recorded-and-retried.test.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { Type: string; Properties: Record<string, any>; DependsOn?: string[] };

describe('the Aurora archive stack keeps a failed archival batch', () => {
  let resources: Record<string, Res>;
  let retry: { retryAttempts: number; dlqRetentionDays: number };

  beforeAll(async () => {
    const cdk = await import('aws-cdk-lib');
    const { Template } = await import('aws-cdk-lib/assertions');
    const { ArchiveStackAurora, ARCHIVAL_RETRY } = await import('../../lib/stacks/archive-stack-aurora');
    const { testMessageStream } = await import('../helpers/synth');
    retry = ARCHIVAL_RETRY;
    const app = new cdk.App();
    const stack = new ArchiveStackAurora(app, 'TestArchivalDlq', { companyBucketArn: 'arn:aws:s3:::test-company-bucket',
      env: { account: '123456789012', region: 'us-east-1' },
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
      messageStream: testMessageStream(app),
      userPoolId: 'us-east-1_TestPoolId',
    } as never);
    resources = (Template.fromStack(stack).toJSON() as { Resources: Record<string, Res> }).Resources;
  });

  const ofType = (t: string) => Object.entries(resources).filter(([, r]) => r.Type === t);
  const idOf = (t: string, prefix: string) => ofType(t).map(([id]) => id).find((id) => id.startsWith(prefix))!;
  const dlqId = () => idOf('AWS::SQS::Queue', 'ArchivalDeadLetterQueue');
  const archivalId = () => idOf('AWS::Lambda::Function', 'ArchivalLambda');

  it('sends a batch that failed every retry to the archival dead-letter queue', () => {
    const mapping = ofType('AWS::Lambda::EventSourceMapping')
      .find(([, r]) => JSON.stringify(r.Properties.FunctionName).includes(archivalId()));
    expect(mapping).toBeDefined();
    const p = mapping![1].Properties;
    expect(p.MaximumRetryAttempts).toBe(retry.retryAttempts);
    expect(p.BisectBatchOnFunctionError).toBe(true);
    expect(JSON.stringify(p.DestinationConfig)).toContain(dlqId());
  });

  it('keeps the record past the seven days the turn telemetry is kept for, encrypted, and lets the function write it', () => {
    const q = resources[dlqId()].Properties;
    expect(retry.dlqRetentionDays).toBeGreaterThan(7);
    expect(q.MessageRetentionPeriod).toBe(retry.dlqRetentionDays * 86400);
    expect(q.SqsManagedSseEnabled).toBe(true);
    const sends = ofType('AWS::IAM::Policy').some(([, r]) => {
      const raw = JSON.stringify(r.Properties);
      return raw.includes('sqs:SendMessage') && raw.includes(dlqId());
    });
    expect(sends).toBe(true);
  });

  it('alarms while the queue holds a batch, and the alarm reaches the admin-channel notifier', () => {
    const alarm = ofType('AWS::CloudWatch::Alarm').find(([id]) => id.startsWith('ArchivalDeadLetterAlarm'));
    expect(alarm).toBeDefined();
    const p = alarm![1].Properties;
    expect(JSON.stringify(p.Metrics)).toContain(dlqId());
    expect(JSON.stringify(p.Metrics)).toContain('ApproximateNumberOfMessagesVisible');
    expect(JSON.stringify(p.Metrics)).toContain('ApproximateNumberOfMessagesNotVisible');
    expect(p.Threshold).toBe(0);
    expect(p.ComparisonOperator).toBe('GreaterThanThreshold');

    const topicId = idOf('AWS::SNS::Topic', 'ArchivalFailureAlarmTopic');
    expect(JSON.stringify(p.AlarmActions)).toContain(topicId);
    expect(JSON.stringify(p.OKActions)).toContain(topicId);
    const notifierId = idOf('AWS::Lambda::Function', 'AlarmToAdminChannelFunction');
    const subscribed = ofType('AWS::SNS::Subscription').some(([, r]) =>
      JSON.stringify(r.Properties.TopicArn).includes(topicId) && JSON.stringify(r.Properties.Endpoint).includes(notifierId));
    expect(subscribed).toBe(true);
  });

  it('alarms when the projection is held at its maximum - CPU or capacity for 15 minutes - and reaches the admin-channel notifier', () => {
    const topicId = idOf('AWS::SNS::Topic', 'AnalyticsDbSaturatedAlarmTopic');
    const notifierId = idOf('AWS::Lambda::Function', 'AlarmToAdminChannelFunction');
    for (const [prefix, metric] of [['AnalyticsDbCpuSaturatedAlarm', 'CPUUtilization'], ['AnalyticsDbAtCapacityAlarm', 'ServerlessDatabaseCapacity']] as const) {
      const alarm = ofType('AWS::CloudWatch::Alarm').find(([id]) => id.startsWith(prefix));
      expect(alarm).toBeDefined();
      const p = alarm![1].Properties;
      expect(p.MetricName).toBe(metric);
      expect(p.Namespace).toBe('AWS/RDS');
      expect(p.Period * p.EvaluationPeriods).toBe(900);
      expect(p.DatapointsToAlarm).toBe(p.EvaluationPeriods);
      expect(JSON.stringify(p.AlarmActions)).toContain(topicId);
      expect(JSON.stringify(p.OKActions)).toContain(topicId);
    }
    // CPU on its average: a Maximum breaches on the scale-up seconds of ordinary traffic.
    const cpu = ofType('AWS::CloudWatch::Alarm').find(([id]) => id.startsWith('AnalyticsDbCpuSaturatedAlarm'))![1].Properties;
    expect(cpu.Statistic).toBe('Average');
    const capacity = ofType('AWS::CloudWatch::Alarm').find(([id]) => id.startsWith('AnalyticsDbAtCapacityAlarm'))![1].Properties;
    const cluster = ofType('AWS::RDS::DBCluster')[0][1].Properties;
    // The alarm's threshold is the cluster's own maximum capacity, one declaration.
    expect(capacity.Threshold).toBe(cluster.ServerlessV2ScalingConfiguration.MaxCapacity);
    const subscribed = ofType('AWS::SNS::Subscription').some(([, r]) =>
      JSON.stringify(r.Properties.TopicArn).includes(topicId) && JSON.stringify(r.Properties.Endpoint).includes(notifierId));
    expect(subscribed).toBe(true);
  });

  it('alarms on one classification-boundary refusal by any assistant, and reaches the admin-channel notifier (ADR-045)', () => {
    const topicId = idOf('AWS::SNS::Topic', 'BoundaryRefusalAlarmTopic');
    const notifierId = idOf('AWS::Lambda::Function', 'AlarmToAdminChannelFunction');
    const alarm = ofType('AWS::CloudWatch::Alarm').find(([id]) => id.startsWith('AssistantRefusedByClassificationAlarm'));
    expect(alarm).toBeDefined();
    const p = alarm![1].Properties;
    // Summed over every assistant's series, since assistants are data and no alarm can name each one.
    const query = JSON.stringify(p.Metrics);
    expect(query).toContain('SELECT SUM(AssistantRefusedByChannelClassification)');
    expect(query).toContain('SCHEMA(\\"AgentEchelon/ClassificationBoundary\\", Assistant)');
    expect(p.Threshold).toBe(1);
    expect(p.EvaluationPeriods).toBe(1);
    expect(p.TreatMissingData).toBe('notBreaching');
    expect(JSON.stringify(p.AlarmActions)).toContain(topicId);
    const subscribed = ofType('AWS::SNS::Subscription').some(([, r]) =>
      JSON.stringify(r.Properties.TopicArn).includes(topicId) && JSON.stringify(r.Properties.Endpoint).includes(notifierId));
    expect(subscribed).toBe(true);
  });

  it('names the redrive in the alarm, and the script it names exists', () => {
    const fs = require('fs');
    const path = require('path');
    const alarm = ofType('AWS::CloudWatch::Alarm').find(([id]) => id.startsWith('ArchivalDeadLetterAlarm'))!;
    expect(String(alarm[1].Properties.AlarmDescription)).toContain('scripts/redrive-archival-dlq.mjs');
    expect(fs.existsSync(path.join(__dirname, '../../scripts/redrive-archival-dlq.mjs'))).toBe(true);
  });
});
