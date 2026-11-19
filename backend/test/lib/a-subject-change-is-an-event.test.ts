/**
 * A SUBJECT CHANGE IS AN EVENT A WORKFLOW ANSWERS (SPEC-WORKFLOWS-AND-TASKS WT88).
 *
 * Detection stays the platform's; what happens next is a workflow. The event is raised once per message that changed the
 * subject, a workflow on it may name only conversation types that have drift on, and a room runs the version's own workflow
 * for its type, else one that names no type, else the platform's.
 */
import { SHIPPED_EVENT_WORKFLOWS, EVENT_WORKFLOW_EVENTS, EVENTS_NAMING_A_PERSON, eventWorkflowErrors, subjectChangedWorkflowOf, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { eventNaturalKey } from '../../lambda/src/lib/event-natural-key';
import { CONVERSATION_TYPES } from '../../lib/config/conversation-types';

const ROOM = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const wf = (types?: string[]): EventWorkflow => ({
  on: 'subject-changed', ...(types ? { types } : {}), initial: 'done', states: { done: { disposition: 'success' } },
} as unknown as EventWorkflow);

describe('a subject change', () => {
  it('a move refuses a type whose members come from its group, and takes one that does not', () => {
    const types = CONVERSATION_TYPES as Record<string, unknown>;
    const move = (type: string) => {
      const drift = JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS.drift));
      drift.states.move.open.type = type;
      return eventWorkflowErrors('mine', drift).join(' ');
    };
    types['group-room'] = { ...(types.general as object), membershipSource: { group: 'ops' } };
    try {
      expect(move('group-room')).toMatch(/whose members come from its group/);
      expect(move('general')).not.toMatch(/whose members come from its group/);
    } finally {
      delete types['group-room'];
    }
  });

  it('is an event that names the person whose message changed the subject', () => {
    expect(EVENT_WORKFLOW_EVENTS).toContain('subject-changed');
    expect(EVENTS_NAMING_A_PERSON).toContain('subject-changed');
  });

  it('runs once per message that changed the subject, and not at all without one', () => {
    expect(eventNaturalKey('subject-changed', ROOM, undefined, undefined, undefined, undefined, undefined, 'msg-1')).toBe('subject-msg-1');
    expect(eventNaturalKey('subject-changed', ROOM, undefined, undefined, undefined, undefined, undefined, 'msg-1'))
      .toBe(eventNaturalKey('subject-changed', ROOM, undefined, undefined, undefined, undefined, undefined, 'msg-1'));
    expect(eventNaturalKey('subject-changed', ROOM)).toBeUndefined();
    expect(eventNaturalKey('subject-changed', ROOM, undefined, undefined, undefined, undefined, undefined, 'not a message id')).toBeUndefined();
  });

  it('DENY: a workflow on it names only types that have drift on', () => {
    const off = Object.keys(CONVERSATION_TYPES).find((k) => CONVERSATION_TYPES[k].driftEnabled === false);
    const on = Object.keys(CONVERSATION_TYPES).find((k) => CONVERSATION_TYPES[k].driftEnabled !== false);
    expect(off && on).toBeTruthy();
    expect(eventWorkflowErrors('mine', wf([off!])).join(' ')).toMatch(/has drift off/);
    expect(eventWorkflowErrors('mine', wf([on!])).filter((e) => /drift off/.test(e))).toEqual([]);
    expect(eventWorkflowErrors('mine', wf()).filter((e) => /drift off/.test(e))).toEqual([]);
  });

  it('runs the version\'s workflow for the room\'s type, else one naming no type', () => {
    const own = { general: wf(['general']), any: wf() };
    expect(subjectChangedWorkflowOf(own, 'general')).toMatchObject({ name: 'general', declared: true });
    expect(subjectChangedWorkflowOf(own, 'support')).toMatchObject({ name: 'any', declared: true });
    expect(subjectChangedWorkflowOf({ general: wf(['general']) }, 'support')?.declared ?? false).toBe(false);
  });

  it('runs the platform drift where the version declares none: the sender is asked, and a move moves it', () => {
    const drift = SHIPPED_EVENT_WORKFLOWS.drift;
    expect(subjectChangedWorkflowOf({}, 'general')).toMatchObject({ name: 'drift', declared: false });
    expect(eventWorkflowErrors('drift', drift)).toEqual([]);
    expect(drift.states.offer.task).toMatchObject({ machine: 'drift_offer', by: { people: 'event:person' }, notice: { template: 'drift-offer', redirect: 'drift-redirect-offer' } });
    expect(drift.states.move.open).toMatchObject({ mode: 'move' });
  });

  it('DENY: a notice redirect is a message template, said only on a subject change', () => {
    const offer = (notice: unknown, on = 'subject-changed') => ({
      on, initial: 'offer',
      states: { offer: { task: { machine: 'drift_offer', by: { people: 'event:person' }, notice }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
    } as unknown as EventWorkflow);
    expect(eventWorkflowErrors('mine', offer({ template: 'drift-offer', redirect: 'no-such-template' })).join(' ')).toMatch(/notice.redirect names no-such-template/);
    expect(eventWorkflowErrors('mine', offer({ template: 'drift-offer', redirect: 'drift-redirect-offer' }, 'person-joined')).join(' ')).toMatch(/notice is an offer's, said on subject-changed/);
  });
});
