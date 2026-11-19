/**
 * WHICH CONVERSATION TYPES AN AWS EVENT REACHES IS ONE RULE (`eventUnreachableReason`, conversation-types.ts): a team room
 * type's one room, or a type whose opener watches a key. The workflow validator reads it, and so do the trigger API and the
 * console, so a workflow that validates is one a trigger can attach.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONVERSATION_TYPES, eventReachesType, eventUnreachableReason, isTeamRoomType } from '../../lib/config/conversation-types';
import { eventWorkflowErrors } from '../../lambda/src/lib/event-workflow';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const workflowOn = (type: string) => ({ on: 'event-received', types: [type], initial: 'done', states: { done: { disposition: 'success' } } });
const unreachable = (errs: string[]) => errs.filter((e) => /no event reaches/.test(e));

describe('the types an AWS event reaches', () => {
  it('reaches a team room type and a type whose opener watches a key, and no other', () => {
    expect(eventReachesType('ops-team')).toBe(true);
    expect(eventReachesType('ops')).toBe(true);
    expect(eventUnreachableReason('meeting')).toBe('meeting');
    expect(eventUnreachableReason('general')).toBe('noWatchedKey');
    expect(eventUnreachableReason('no-such-type')).toBe('undeclared');
    for (const [key, config] of Object.entries(CONVERSATION_TYPES)) {
      const reached = isTeamRoomType(key) || (!config.meeting && (config.openedBy ?? []).some((o) => !!o.watches));
      expect({ key, reached: eventReachesType(key) }).toEqual({ key, reached });
    }
  });

  it('the validator accepts a workflow on exactly the types an event reaches', () => {
    for (const key of Object.keys(CONVERSATION_TYPES)) {
      const errs = unreachable(eventWorkflowErrors('w', workflowOn(key)));
      expect({ key, refused: errs.length > 0 }).toEqual({ key, refused: !eventReachesType(key) });
    }
  });

  it('the trigger API and the console read the same rule', () => {
    const api = fs.readFileSync(path.join(ROOT, 'backend/lambda/src/event-triggers-api.ts'), 'utf8');
    expect(api).toMatch(/!eventReachesType\(typeKey\)/);
    const editor = fs.readFileSync(path.join(ROOT, 'frontend/packages/admin/src/components/admin/EventWorkflowEditor.tsx'), 'utf8');
    expect(editor).toMatch(/eventUnreachableReason\(type\)/);
  });
});
