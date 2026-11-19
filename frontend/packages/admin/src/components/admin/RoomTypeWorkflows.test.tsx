/**
 * THE WORKFLOWS BY ROOM TYPE: what runs in each kind of conversation, read from the version by the runtime's own selection.
 * The ops team room shows its incident triage, an ops room its opening and its incident watch, and a room with drift off no
 * subject change; a workflow that names no type runs in every room.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '@ae/shared/i18n';
import RoomTypeWorkflows from './RoomTypeWorkflows';
import { workflowsByRoomType } from './assistantSections';
import { SHIPPED_EVENT_WORKFLOWS } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

const OPS_VERSION = {
  'incident-triage': SHIPPED_EVENT_WORKFLOWS['incident-triage'],
  watch: SHIPPED_EVENT_WORKFLOWS['incident-watch'],
  'ops-room': { ...SHIPPED_EVENT_WORKFLOWS['ops-room'] },
};

const room = (type: string, own = OPS_VERSION) => workflowsByRoomType(own as never).find((r) => r.type === type)!.workflows;

describe('workflows by room type', () => {
  it("lists only the room types a conversation of the assistant's classification can be", () => {
    const types = workflowsByRoomType(OPS_VERSION as never, 'guest').map((r) => r.type);
    expect(types).toContain('guest-visitor');
    expect(types).toContain('general');
    expect(types).not.toContain('ops-team');
    expect(types).not.toContain('customer-engagement');
  });


  it('shows the ops team room its incident triage, and an ops room its opening and incident watch, as the assistant\'s', () => {
    expect(room('ops-team')).toEqual(expect.arrayContaining([{ name: 'incident-triage', on: 'event-received', own: true }]));
    expect(room('ops-team').map((r) => r.name)).not.toContain('watch');
    expect(room('ops')).toEqual(expect.arrayContaining([
      { name: 'ops-room', on: 'conversation-opened', own: true },
      { name: 'watch', on: 'alarm-state-changed', own: true },
    ]));
    expect(room('general').map((r) => r.name)).not.toContain('incident-triage');
  });

  it('shows the platform\'s workflow where the version declares none, and no subject change where drift is off', () => {
    expect(room('general', {} as never)).toEqual([
      { name: 'welcome', on: 'assistant-joined', own: false },
      { name: 'join-recap', on: 'person-joined', own: false },
      { name: 'drift', on: 'subject-changed', own: false },
    ]);
    expect(room('ops', {} as never).map((r) => r.on)).not.toContain('subject-changed');
  });

  it('lists every conversation type, and renders each with its workflows', () => {
    render(<RoomTypeWorkflows name="Advisor" workflows={OPS_VERSION as never} />);
    const team = screen.getByTestId('workflows-room-ops-team');
    expect(within(team).getByTestId('workflows-room-ops-team-incident-triage')).toHaveTextContent('AWS event');
    expect(screen.getByTestId('workflows-room-meeting')).toBeInTheDocument();
  });
});
