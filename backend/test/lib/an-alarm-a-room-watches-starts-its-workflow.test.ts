/**
 * AN ALARM A ROOM WATCHES STARTS ITS WORKFLOW (ADR-061 slice 5, the incident watch).
 *
 * What it proves:
 *  - `alarm-state-changed` is a built event with one source, the CloudWatch alarm state change on the default bus, that
 *    selects its own workflow and may open with an agent step, because nobody is waiting on it;
 *  - its fields, the alarm's name and the state it entered, are platform trust, so the state may decide an edge;
 *  - a run is keyed by the alarm and the time it entered its state, so a redelivered change starts nothing twice and
 *    each state the alarm enters is a run of its own;
 *  - the router starts nothing on a malformed change, an alarm no room watches, or a room that no longer watches it, and
 *    otherwise checks the room's classification and archive tag and reads the alarm back from CloudWatch before any run;
 *  - an ops event that names an alarm opens a room that watches it: the creator records it on the room's row and in the
 *    alarm's watch record, and the platform's ops event carries it.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ALARM_NAME,
  EVENTS_SELECTING_THEIR_WORKFLOW,
  EVENT_WORKFLOW_EVENTS,
  PLATFORM_EVENT_WORKFLOWS,
  alarmWatchKey,
  declaredWorkflowOn,
  eventNaturalKey,
  eventRunKey,
  eventWorkflowErrors,
  workflowSendEmailKind,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { EVENT_FIELDS, buildSourceTable, sourceLookup, whenErrors } from '../../lambda/src/lib/variables';
import { OPENER_FIELDS, PLATFORM_EVENT_FIELDS, openerWatchesAlarms } from '../../lib/config/event-openers';
import { CONVERSATION_TYPES } from '../../lib/config/conversation-types';
import { incidentWatchAlarmPrefixes, incidentWatchPattern } from '../../lib/constructs/event-opened-conversations';
import { handleAlarmStateChanged } from '../../lambda/src/router-agent-handler';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const CHANNEL = `${APP}/channel/ch-1`;
const WATCH = PLATFORM_EVENT_WORKFLOWS['incident-watch'];

describe('the event and its fields', () => {
  it('is a built event that selects its own workflow, names no person, and emails nobody', () => {
    expect(EVENT_WORKFLOW_EVENTS).toContain('alarm-state-changed');
    expect(EVENTS_SELECTING_THEIR_WORKFLOW).toContain('alarm-state-changed');
    expect(declaredWorkflowOn({ watch: WATCH }, 'alarm-state-changed')).toEqual({ name: 'watch', workflow: WATCH });
    expect(workflowSendEmailKind('alarm-state-changed', ['x'])).toBeUndefined();
  });

  it('carries the alarm\'s name and its state, each platform trust, the state a closed set a condition may name', () => {
    const fields = EVENT_FIELDS.filter((f) => f.event === 'alarm-state-changed');
    expect(fields.map((f) => f.field).sort()).toEqual(['alarmName', 'alarmState']);
    const table = buildSourceTable({ catalog: [] });
    expect(table.sources['event:alarmState']).toMatchObject({ trust: 'platform', type: 'enum', values: ['ALARM', 'OK', 'INSUFFICIENT_DATA'], describesPerson: false });
    const lookup = sourceLookup(table);
    expect(whenErrors({ 'event:alarmState': 'OK' }, lookup, { event: 'alarm-state-changed', selects: 'room' })).toEqual([]);
    expect(whenErrors({ 'event:alarmState': 'RECOVERED' }, lookup, { event: 'alarm-state-changed', selects: 'room' }).join()).toMatch(/is an enum of ALARM, OK, INSUFFICIENT_DATA/);
  });

  it('the platform\'s incident watch tells the room the state, then reads the health again, and opens with whatever it likes', () => {
    expect(WATCH).toMatchObject({ on: 'alarm-state-changed', types: ['ops'], initial: 'announce' });
    expect(WATCH.states.recheck.agent).toMatchObject({ prompt: 'ops-incident-recheck', tools: ['read_deployment_health'], reads: 'messages', to: 'room' });
    expect(eventWorkflowErrors('incident-watch', WATCH)).toEqual([]);
    const agentFirst: EventWorkflow = { ...clone(WATCH), initial: 'recheck' };
    expect(eventWorkflowErrors('w', agentFirst)).toEqual([]);
    const conditioned: EventWorkflow = clone(WATCH);
    conditioned.states.announce.onSuccess = [{ to: 'recheck', when: { 'event:alarmState': 'ALARM' } }, { to: 'done' }];
    expect(eventWorkflowErrors('w', conditioned)).toEqual([]);
  });

  it('addresses the room or a role, never a person the event does not name', () => {
    const joined: EventWorkflow = clone(WATCH);
    joined.states.announce.send!.to = 'joined';
    expect(eventWorkflowErrors('w', joined).join()).toMatch(/to is joined, which only person-joined carries/);
  });

  it('a run is keyed by the alarm and the time it entered its state', () => {
    const at = 1_800_000_000_000;
    expect(eventNaturalKey('alarm-state-changed', CHANNEL, undefined, undefined, { name: 'AgentEchelon-latency', changedAt: at })).toBe(`alarm-${at}-AgentEchelon-latency`);
    expect(eventNaturalKey('alarm-state-changed', CHANNEL, undefined, undefined, { name: 'AgentEchelon-latency', changedAt: at + 60_000 }))
      .not.toBe(eventNaturalKey('alarm-state-changed', CHANNEL, undefined, undefined, { name: 'AgentEchelon-latency', changedAt: at }));
    expect(eventNaturalKey('alarm-state-changed', CHANNEL)).toBeUndefined();
    expect(eventNaturalKey('alarm-state-changed', CHANNEL, undefined, undefined, { name: 'bad\nname', changedAt: at })).toBeUndefined();
    expect(eventRunKey('alarm-state-changed', `alarm-${at}-x`, 'ops-premium')).toBe(`alarm-state-changed#alarm-${at}-x#ops-premium`);
  });
});

describe('the router verifies the change before anything runs', () => {
  it('starts nothing on a malformed change, an alarm no room watches, or a room that does not watch it here', async () => {
    expect(await handleAlarmStateChanged({ alarmName: 'x' })).toEqual({ ran: false, reason: 'malformed' });
    expect(await handleAlarmStateChanged({ alarmName: 'x', state: 'RED' })).toEqual({ ran: false, reason: 'malformed' });
    expect(await handleAlarmStateChanged({ alarmName: 'AgentEchelon-x', state: 'ALARM' }, { watch: async () => null }))
      .toEqual({ ran: false, reason: 'no conversation watches the alarm' });
    expect(await handleAlarmStateChanged({ alarmName: 'AgentEchelon-x', state: 'ALARM' }, {
      watch: async () => ({ room: CHANNEL, classification: 'premium' }), watches: async () => null,
    })).toEqual({ ran: false, reason: 'the conversation does not watch the alarm at this classification' });
  });

  it('checks the watch, the room\'s tags, the alarm\'s state now, the primary and the workflow, in that order, before the run', () => {
    const router = read('router-agent-handler.ts');
    const fn = router.slice(router.indexOf('export async function handleAlarmStateChanged('), router.indexOf('export async function handleDeadlineCancel('));
    const order = [
      'ALARM_NAME.test(alarmName)', '(deps.watch ?? alarmWatchOf)(alarmWatchKey(alarmName))', '(deps.watches ?? conversationWatches)(channelArn, alarmName)',
      'readChannelTags(chimeClient, channelArn)', 'tags[CLASSIFICATION_TAG] !== STATIC_CLASSIFICATION', "tags.archived === 'true'",
      '(deps.stateNow ?? alarmStateNow)(alarmName)', 'now.state !== r.state', 'primaryAssistantOf(', "declaredWorkflowOn(served?.version.eventWorkflows, 'alarm-state-changed')", 'runWorkflowFor(',
    ].map((t) => fn.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The run is keyed by the time CloudWatch reports, never one the payload carries.
    expect(fn).toMatch(/const alarm: AlarmChange = \{ name: alarmName, state: now\.state, changedAt: now\.changedAt \};/);
    // The watch is the room's own row and the alarm's record, both server-only, and the continuation reads them again.
    expect(router).toMatch(/if \(!watch \|\| watch\.room !== channelArn \|\| watch\.classification !== STATIC_CLASSIFICATION\) return null;/);
    expect(router).toMatch(/if \(!row \|\| row\.watchedAlarm !== alarmName\) return null;/);
    expect(router).toMatch(/if \(!\(await conversationWatches\(channelArn, alarm\.name\)\)\) return refuse\('the conversation no longer watches the alarm'\);/);
  });
});

describe('a room that watches an alarm', () => {
  it('an opener may name the alarm its room watches, and the platform\'s ops event carries it', () => {
    expect(OPENER_FIELDS).toContain('watchesAlarm');
    expect(PLATFORM_EVENT_FIELDS.watchesAlarm).toBe('$.detail.alarmName');
    expect(openerWatchesAlarms(CONVERSATION_TYPES.ops.openedBy![0])).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { opsEventEntry } = require('../../scripts/lib/ops-event.cjs');
    const entry = opsEventEntry({ instance: 'ae', forPerson: 'a@b.c', concernedChannelArn: CHANNEL, alarmName: 'AgentEchelon-latency' });
    expect(JSON.parse(entry.Detail).alarmName).toBe('AgentEchelon-latency');
  });

  it('the creator records it on the room\'s row and in the alarm\'s watch record, and refuses a name that is not an alarm\'s', () => {
    const creator = read('typed-conversation-from-event.ts');
    expect(creator).toMatch(/if \(watchedAlarm && !ALARM_NAME\.test\(watchedAlarm\)\) throw new Error\('detail\.watchesAlarm is not an alarm name'\);/);
    expect(creator).toMatch(/\.\.\.\(watchedAlarm \? \{ watchedAlarm \} : \{\}\),/);
    expect(creator).toMatch(/recordAlarmWatch\(alarmWatchKey\(watchedAlarm\), \{ room: created\.channelArn, classification: DEPLOYED_CLASSIFICATION \}\)/);
    expect(read('lib/channel-creation.ts')).toMatch(/\.\.\.\(input\.watchedAlarm \? \{ watchedAlarm: input\.watchedAlarm \} : \{\}\),/);
    expect(alarmWatchKey('AgentEchelon-latency')).toBe('watch#alarm#AgentEchelon-latency');
    expect(ALARM_NAME.test('AgentEchelon-premium-context-source-failure-rate')).toBe(true);
    expect(ALARM_NAME.test('a"b')).toBe(false);
  });

  it('the rule matches a CloudWatch alarm state change of this deployment\'s alarms alone', () => {
    const prefixes = incidentWatchAlarmPrefixes('AgentEchelon', 'agent-echelon');
    expect(prefixes).toEqual(['AgentEchelon', 'agent-echelon-']);
    expect(incidentWatchPattern(prefixes)).toEqual({
      source: ['aws.cloudwatch'], detailType: ['CloudWatch Alarm State Change'],
      detail: { alarmName: [{ prefix: 'AgentEchelon' }, { prefix: 'agent-echelon-' }] },
    });
  });
});

describe('the router reads the alarm it was told about under its scoped grant', () => {
  it('asks for metric alarms by name, never composite alarms, which are authorized against `*`', () => {
    const router = read('router-agent-handler.ts');
    const fn = router.slice(router.indexOf('async function alarmStateNow('), router.indexOf('async function alarmStateNow(') + 1200);
    expect(fn).toContain("new DescribeAlarmsCommand({ AlarmNames: [alarmName], AlarmTypes: ['MetricAlarm'] })");
    expect(fn).not.toContain('CompositeAlarm');
  });
});
