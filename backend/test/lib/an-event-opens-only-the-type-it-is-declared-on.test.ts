/**
 * AN EVENT OPENS ONLY THE TYPE A DECLARATION NAMES, AND CARRIES NO CLASSIFICATION (ADR-053 Phase 1).
 *
 * `openedBy` on a conversation type declares the events that open it (`lib/config/event-openers.ts`). These
 * pin what a declaration may say: the fields it fills are the person, the label, the summary and the
 * concerned conversation, and never a classification or a type; a type a person opens declares none; and a
 * type permitting several classifications names the one its rule is built at. They also pin the platform's
 * own ops event, as `scripts/send-ops-event.mjs` puts it, to the declaration the shipped `ops` type carries.
 */
import { CONVERSATION_TYPES } from '../../lib/config/conversation-types';
import {
  OPS_EVENT_SOURCE, OPS_INCIDENT_OPENED, PLATFORM_EVENT_FIELDS,
  eventOpenersAt, openerById, openerInput, resolveEventOpeners, valueAtPath, type OpenedTypeView,
} from '../../lib/config/event-openers';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const opsEvent = require('../../scripts/lib/ops-event.cjs');

const ROOM = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/conv-platform-on-call';

const alertType = (openedBy: OpenedTypeView['openedBy'], extra: Partial<OpenedTypeView> = {}): Record<string, OpenedTypeView> => ({
  incident: { classifications: ['premium'], initiation: 'alert', openedBy, ...extra },
});
const fields = { forPerson: '$.detail.forPerson', concernedChannelArn: '$.detail.room' };

describe('the shipped registry declares its openers validly', () => {
  it('ops is opened by the platform ops event, at premium, and nothing else is', () => {
    const all = resolveEventOpeners(CONVERSATION_TYPES);
    expect(all.map((o) => [o.id, o.typeKey, o.classification])).toEqual([['ops#0', 'ops', 'premium']]);
    expect(all[0].opener).toMatchObject({ source: OPS_EVENT_SOURCE, detailType: OPS_INCIDENT_OPENED, matchInstance: true });
    expect(eventOpenersAt(CONVERSATION_TYPES, 'standard')).toEqual([]);
    expect(openerById(CONVERSATION_TYPES, 'ops#0')?.typeKey).toBe('ops');
    expect(openerById(CONVERSATION_TYPES, 'general#0')).toBeUndefined();
  });

  it('the sender script puts the event the declaration matches, with the fields it reads and no classification', () => {
    expect(opsEvent.OPS_EVENT_SOURCE).toBe(OPS_EVENT_SOURCE);
    expect(opsEvent.OPS_INCIDENT_OPENED).toBe(OPS_INCIDENT_OPENED);
    const entry = opsEvent.opsEventEntry({
      instance: 'agent-echelon', forPerson: 'demo-oncall@example.com', concernedChannelArn: ROOM,
      topicLabel: 'Report latency', summary: 'Report generation is running slow.',
    });
    expect(entry).toMatchObject({ Source: OPS_EVENT_SOURCE, DetailType: OPS_INCIDENT_OPENED, EventBusName: 'default' });
    const detail = JSON.parse(entry.Detail);
    expect(detail).not.toHaveProperty('classification');
    expect(detail).not.toHaveProperty('conversationType');
    // EventBridge delivers the entry as an event whose `detail` is the parsed Detail.
    const delivered = { source: entry.Source, 'detail-type': entry.DetailType, detail };
    expect(openerInput({ source: '', detailType: '', fields: { ...PLATFORM_EVENT_FIELDS } }, delivered)).toEqual({
      forPerson: 'demo-oncall@example.com', concernedChannelArn: ROOM,
      topicLabel: 'Report latency', summary: 'Report generation is running slow.',
    });
    expect(detail.instance).toBe('agent-echelon');
  });
});

describe('a declaration cannot carry a classification or a type, and is refused at synth when it tries', () => {
  it.each(['classification', 'conversationType'])('refuses a field named %s, as a path or as a value', (key) => {
    expect(() => resolveEventOpeners(alertType([{ source: 's', detailType: 'd', fields: { ...fields, [key]: '$.detail.x' } as never }])))
      .toThrow(new RegExp(`fields\\.${key} is not a field an opener fills`));
    expect(() => resolveEventOpeners(alertType([{ source: 's', detailType: 'd', fields, values: { [key]: 'premium' } as never }])))
      .toThrow(new RegExp(`values\\.${key} is not a field an opener fills`));
  });

  it('refuses an opener on a type a person opens', () => {
    expect(() => resolveEventOpeners({ chat: { initiation: 'user', classifications: ['premium'], openedBy: [{ source: 's', detailType: 'd', fields }] } }))
      .toThrow(/a person opens this type/);
  });

  it('a type permitting several classifications names the one its rule is built at, and only one it permits', () => {
    const two = (classification?: string) => ({
      incident: { classifications: ['standard', 'premium'], initiation: 'alert', openedBy: [{ source: 's', detailType: 'd', fields, ...(classification ? { classification } : {}) }] },
    }) as Record<string, OpenedTypeView>;
    expect(() => resolveEventOpeners(two())).toThrow(/must name the one classification/);
    expect(() => resolveEventOpeners(two('basic'))).toThrow(/is not one the type permits/);
    expect(resolveEventOpeners(two('standard')).map((o) => o.classification)).toEqual(['standard']);
    expect(eventOpenersAt(two('standard'), 'premium')).toEqual([]);
  });

  it('refuses a path that is not a plain path, a field declared twice, no person, and no concerned conversation', () => {
    expect(() => resolveEventOpeners(alertType([{ source: 's', detailType: 'd', fields: { ...fields, topicLabel: '$..x' } }]))).toThrow(/not a plain JSON path/);
    expect(() => resolveEventOpeners(alertType([{ source: 's', detailType: 'd', fields, values: { forPerson: 'x@example.com' } }]))).toThrow(/both as a path and as a value/);
    expect(() => resolveEventOpeners(alertType([{ source: 's', detailType: 'd', fields: { concernedChannelArn: '$.detail.room' } }]))).toThrow(/names no person/);
    expect(() => resolveEventOpeners(alertType([{ source: 's', detailType: 'd', fields: { forPerson: '$.detail.p' } }]))).toThrow(/concernedChannelArn/);
    // A type the platform opens on its own concerns nothing.
    expect(resolveEventOpeners(alertType([{ source: 's', detailType: 'd', fields: { forPerson: '$.detail.p' } }], { initiation: 'system' }))).toHaveLength(1);
  });
});

describe('a CloudWatch alarm or a vendor partner bus is declared the same way, with no code', () => {
  it('an alarm state change opens a room for a fixed person, labelled from the alarm', () => {
    const [o] = resolveEventOpeners(alertType([{
      source: 'aws.cloudwatch', detailType: 'CloudWatch Alarm State Change', detail: { state: { value: ['ALARM'] } },
      fields: { topicLabel: '$.detail.alarmName', summary: '$.detail.state.reason' },
      values: { forPerson: 'on-call@example.com', concernedChannelArn: ROOM },
    }]));
    const alarm = { source: 'aws.cloudwatch', detail: { alarmName: 'p99 latency', state: { value: 'ALARM', reason: 'Threshold crossed', classification: 'basic' } } };
    expect(openerInput(o.opener, alarm)).toEqual({
      forPerson: 'on-call@example.com', concernedChannelArn: ROOM, topicLabel: 'p99 latency', summary: 'Threshold crossed',
    });
  });

  it('a partner bus is named on the declaration', () => {
    const [o] = resolveEventOpeners(alertType([{ eventBus: 'aws.partner/pagerduty.com/abc', source: 'aws.partner/pagerduty.com/abc', detailType: 'incident.triggered', fields }]));
    expect(o.opener.eventBus).toBe('aws.partner/pagerduty.com/abc');
  });

  it('reads plain paths only, and a value that is not text is absent', () => {
    const event = { detail: { a: { b: ['x', 'y'] }, n: 3, o: { k: 1 }, blank: '  ' } };
    expect(valueAtPath(event, '$.detail.a.b[1]')).toBe('y');
    expect(valueAtPath(event, '$.detail.n')).toBe('3');
    expect(valueAtPath(event, '$.detail.o')).toBeUndefined();
    expect(valueAtPath(event, '$.detail.blank')).toBeUndefined();
    expect(valueAtPath(event, '$.detail.missing.deeper')).toBeUndefined();
    expect(valueAtPath(event, '$..a')).toBeUndefined();
  });
});
