/**
 * The natural key of an event's run, computed only where a run is started: in the router, never in a browser bundle,
 * because the key of a watched conversation's run is a content hash (`node:crypto`). The admin console imports
 * event-workflow.ts for the workflow shapes and their checks; this module keeps that import free of Node built-ins.
 */
import { contentHash12 } from './canonical-json.js';
import { personIdFromArn } from './person-arn.js';
import { isMeetingId } from './meeting-lifecycle.js';
import {
  ALARM_NAME, INTENT_TRIGGER, INVITATION_ID, conversationKey, isInvitationEvent, isMeetingEvent,
  type AlarmChange, type RuleEventRef, type WorkflowEvent,
} from './event-workflow.js';

/**
 * AN EVENT'S NATURAL KEY (decision 5): the conversation; for `person-joined` the conversation and the person, so each
 * person added is a run of their own and a redelivered add starts no second one; for an invitation's events the
 * invitation, so a redelivered naming or a schedule that fires twice starts no second run and two invitations are two runs;
 * for `alarm-state-changed` the alarm and the time it entered its state, so a redelivered change starts no second run
 * and each state the alarm enters is a run of its own. Undefined for a `person-joined` that
 * names no person, an `invitation-sent` that names no invitation, or an alarm change that names no alarm, which runs nothing.
 */
/** What a run's natural key is computed from beside its event and conversation, by name, so no caller passes them out of order. */
export interface RunKeyFields {
  eventPerson?: string;
  invitationId?: string;
  alarm?: Pick<AlarmChange, 'name' | 'changedAt'>;
  reopened?: { taskId: string; n: number };
  ruleEvent?: RuleEventRef;
  subjectMessageId?: string;
  meetingId?: string;
}

/** A run's natural key from its identity by name (`eventNaturalKey`). */
export function runNaturalKey(event: WorkflowEvent, channelArn: string, f: RunKeyFields): string | undefined {
  return eventNaturalKey(event, channelArn, f.eventPerson, f.invitationId, f.alarm, f.reopened, f.ruleEvent, f.subjectMessageId, f.meetingId);
}

export function eventNaturalKey(event: WorkflowEvent, channelArn: string, eventPerson?: string, invitationId?: string, alarm?: Pick<AlarmChange, 'name' | 'changedAt'>, reopened?: { taskId: string; n: number }, ruleEvent?: RuleEventRef, subjectMessageId?: string, meetingId?: string): string | undefined {
  // ONE RUN PER MESSAGE THAT CHANGED THE SUBJECT (WT88), so a redelivered turn raises the event once. No message id, no run.
  if (event === 'subject-changed') return subjectMessageId && /^[A-Za-z0-9-]{1,128}$/.test(subjectMessageId) ? `subject-${subjectMessageId}` : undefined;
  // ONE RUN PER RULE PER WINDOW, so a redelivery and a storm of events are one run.
  // A WATCHED CONVERSATION'S: one run per rule, key and window (DESIGN-EVENT-TARGETS section 4), the key hashed to a fixed shape.
  if (event === 'event-received' && ruleEvent?.watch) {
    return /^[a-f0-9]{12}$/.test(ruleEvent.rule) && Number.isInteger(ruleEvent.window) && ruleEvent.watch.kind && ruleEvent.watch.key
      ? `watch-${ruleEvent.rule}-${contentHash12({ kind: ruleEvent.watch.kind, key: ruleEvent.watch.key })}-${ruleEvent.window}` : undefined;
  }
  if (event === 'event-received') return ruleEvent && /^[a-f0-9]{12}$/.test(ruleEvent.rule) && Number.isInteger(ruleEvent.window) ? `rule-${ruleEvent.rule}-${ruleEvent.window}` : undefined;
  if (isInvitationEvent(event)) return invitationId && INVITATION_ID.test(invitationId) ? `invitation-${invitationId}` : undefined;
  // ONE RUN PER REOPEN of a task, the nth taking the task back from an ending.
  if (event === 'task-reopened') return reopened?.taskId && Number.isInteger(reopened.n) && reopened.n > 0 ? `reopen-${reopened.taskId}-${reopened.n}` : undefined;
  if (event === INTENT_TRIGGER) return undefined;
  // ONE RUN PER MEETING, per event, so a redelivered start or end runs nothing twice.
  if (isMeetingEvent(event)) return isMeetingId(meetingId) ? `meeting-${meetingId}` : undefined;
  if (event === 'alarm-state-changed') {
    return alarm && ALARM_NAME.test(alarm.name) && Number.isInteger(alarm.changedAt) && alarm.changedAt > 0
      ? `alarm-${alarm.changedAt}-${alarm.name}` : undefined;
  }
  if (event !== 'person-joined') return conversationKey(channelArn);
  const person = personIdFromArn(eventPerson) ?? undefined;
  return person ? `${conversationKey(channelArn)}#${person}` : undefined;
}
