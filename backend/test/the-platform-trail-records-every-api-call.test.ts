/**
 * The platform trail records every AWS API call the platform makes, and the context table can find every
 * conversation of a type.
 *
 * CloudTrail is the control-plane audit layer (SPEC-ACCESS-AND-CONTROLS-AUDITING) and the event source that
 * keeps group-sourced conversations and the admin conversations in sync (DESIGN-CONVERSATION-TYPES §6). An
 * account with no trail keeps only 90 days of event history, which nothing can subscribe to. Management
 * events already include the Amazon Chime SDK messaging calls and Bedrock; Lambda, DynamoDB item, S3 object
 * and Kinesis access are data events and are recorded only when selected.
 */
import { Match } from 'aws-cdk-lib/assertions';
import { adminServicesTemplate, identityTemplate, conversationsTemplate } from './helpers/synth';


describe('the platform trail, in Identity beside the roles whose use it records', () => {
  const t = identityTemplate();
  const trail = () => Object.values(t.findResources('AWS::CloudTrail::Trail'))[0] as { Properties: Record<string, any> };

  it('exists by default, logging, with file validation', () => {
    t.resourceCountIs('AWS::CloudTrail::Trail', 1);
    expect(trail().Properties.IsLogging).toBe(true);
    expect(trail().Properties.EnableLogFileValidation).toBe(true);
  });

  it('records every management event, which include the Amazon Chime SDK messaging and Bedrock calls', () => {
    const selectors = trail().Properties.AdvancedEventSelectors as Array<{ FieldSelectors: Array<{ Field: string; Equals?: string[] }> }>;
    expect(selectors.some((s) => s.FieldSelectors.length === 1
      && s.FieldSelectors[0].Field === 'eventCategory' && s.FieldSelectors[0].Equals?.[0] === 'Management')).toBe(true);
    expect(trail().Properties.EventSelectors).toBeUndefined();
  });

  it('records Lambda, DynamoDB item, Kinesis and S3 object data events', () => {
    const selectors = trail().Properties.AdvancedEventSelectors as Array<{ FieldSelectors: Array<{ Field: string; Equals?: string[] }> }>;
    const types = selectors.flatMap((s) => s.FieldSelectors.filter((f) => f.Field === 'resources.type').flatMap((f) => f.Equals ?? []));
    expect(types.sort()).toEqual(['AWS::DynamoDB::Table', 'AWS::Kinesis::Stream', 'AWS::Lambda::Function', 'AWS::S3::Object']);
  });

  it('does not record its own log delivery, which would loop', () => {
    const s3 = (trail().Properties.AdvancedEventSelectors as Array<{ FieldSelectors: Array<{ Field: string; NotStartsWith?: unknown[] }> }>)
      .find((s) => s.FieldSelectors.some((f: any) => f.Equals?.[0] === 'AWS::S3::Object'))!;
    expect(s3.FieldSelectors.find((f) => f.Field === 'resources.ARN')?.NotStartsWith).toHaveLength(1);
  });

  it('keeps management events only when data events are turned off', () => {
    const off = identityTemplate({ trailDataEvents: 'false' });
    const selectors = (Object.values(off.findResources('AWS::CloudTrail::Trail'))[0] as any).Properties.AdvancedEventSelectors;
    expect(selectors).toHaveLength(1);
  });

  it('is not created where an organization trail already covers the account', () => {
    identityTemplate({ platformTrail: 'false' }).resourceCountIs('AWS::CloudTrail::Trail', 0);
  });
});

describe('the context table can find every conversation of a type', () => {
  it('has a sparse, keys-only index over the stamped conversation type', () => {
    conversationsTemplate().hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({
        IndexName: 'ByConversationType',
        KeySchema: [{ AttributeName: 'conversationType', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      })]),
    });
  });
});

describe('the admin conversations sync when the admin group changes, not on a timer', () => {
  it('runs on the Cognito group change and keeps only a daily backstop', () => {
    // The sync is the admin backend's (AdminServices); the trail it reads the change from is Identity's.
    const cog = adminServicesTemplate();
    cog.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.cognito-idp'],
        detail: Match.objectLike({ eventName: Match.arrayWith(['AdminAddUserToGroup', 'AdminRemoveUserFromGroup']) }),
      }),
    });
    cog.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 day)' });
    const schedules = (Object.values(cog.findResources('AWS::Events::Rule')) as Array<{ Properties: { ScheduleExpression?: string } }>)
      .map((r) => r.Properties.ScheduleExpression).filter(Boolean);
    expect(schedules).not.toContain('rate(15 minutes)');
  });
});
