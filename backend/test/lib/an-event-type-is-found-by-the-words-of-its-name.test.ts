/**
 * The admin console's event-type search finds a schema by the words of its name, however they are spaced or cased.
 */
import { describeSchema, eventTypeMatches, eventTypeOfSchema } from '../../lambda/src/lib/event-triggers';

const ALARM = 'aws.cloudwatch@CloudWatchAlarmStateChange';

describe('an event type is found by the words of its name', () => {
  it('matches words written apart, in any case', () => {
    expect(eventTypeMatches(ALARM, 'alarm state')).toBe(true);
    expect(eventTypeMatches(ALARM, 'CloudWatch Alarm State Change')).toBe(true);
    expect(eventTypeMatches(ALARM, 'cloudwatch@alarm')).toBe(true);
  });

  it('needs every word', () => {
    expect(eventTypeMatches(ALARM, 'alarm instance')).toBe(false);
  });

  it('finds every type for an empty query', () => {
    expect(eventTypeMatches(ALARM, '')).toBe(true);
    expect(eventTypeMatches(ALARM, '   ')).toBe(true);
  });
});


/** The shape the schema registry writes: an OpenAPI document whose `AWSEvent` carries the event type and refers to its detail. */
const ALARM_SCHEMA = JSON.stringify({
  openapi: '3.0.0',
  components: {
    schemas: {
      AWSEvent: {
        'x-amazon-events-source': 'aws.cloudwatch', 'x-amazon-events-detail-type': 'CloudWatch Alarm State Change',
        properties: { detail: { $ref: '#/components/schemas/CloudWatchAlarmStateChange' }, source: { type: 'string' } },
      },
      CloudWatchAlarmStateChange: { type: 'object', properties: { alarmName: { type: 'string' }, state: { $ref: '#/components/schemas/State' } } },
      State: { type: 'object', properties: { value: { type: 'string' }, timestamp: { type: 'string' } } },
    },
  },
});

describe('what an event type carries, read from its schema', () => {
  it('reads the event type from the AWSEvent schema, where the registry writes it', () => {
    expect(eventTypeOfSchema(ALARM_SCHEMA)).toEqual({ source: 'aws.cloudwatch', detailType: 'CloudWatch Alarm State Change' });
  });

  it('lists the plain path to each scalar field of the detail, following references', () => {
    expect(describeSchema(ALARM_SCHEMA)?.detailPaths).toEqual(['$.detail.alarmName', '$.detail.state.value', '$.detail.state.timestamp']);
  });

  it('describes nothing for a document that names no event type, or is not JSON', () => {
    expect(describeSchema('{"openapi":"3.0.0"}')).toBeUndefined();
    expect(describeSchema('not json')).toBeUndefined();
  });
});
