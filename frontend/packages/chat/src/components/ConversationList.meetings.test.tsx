/**
 * THE CONVERSATION LIST LEAVES A MEETING'S CONVERSATION OUT, AND ITS ROOM CARRIES WHAT IS NEW IN IT.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '@ae/shared/locales/en.json';
import type { Conversation } from '@ae/shared';
import ConversationList from './ConversationList';

const conv = (id: string, title: string, extra: Partial<Conversation> = {}): Conversation => ({
  id, conversationArn: `arn:aws:chime:us-east-1:1:app-instance/i/channel/${id}`, title, modelId: '', modelName: '',
  createdAt: new Date(0), updatedAt: new Date(0), ...extra,
});
const ROOM = conv('conv-ops-1', 'Report latency');
const MEETING = conv('conv-meeting-1', 'Meeting', { meetingOf: 'conv-ops-1' });
const OTHER = conv('conv-2', 'Quarterly numbers');
const listed: { items: Conversation[] } = { items: [MEETING, ROOM, OTHER] };

// The meetings running now are their own component's tests.
vi.mock('./meeting/OngoingMeetings', () => ({ default: () => null, OngoingMeetingsList: () => null }));
// The server's answer (`POST /meetings/mine`): the meetings running now with their rooms, and every meeting
// conversation's room, running or ended.
const mine: { meetings: Array<Record<string, unknown>>; rooms: Array<{ conversationId: string; roomConversationId: string }> } = {
  meetings: [{ conversationId: 'conv-meeting-1', roomConversationId: 'conv-ops-1', startedAt: '', isHost: false }],
  rooms: [],
};
vi.mock('../hooks/useOngoingMeetings', () => ({ useOngoingMeetings: () => mine }));
vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => ({
    conversations: listed.items,
    activeConversation: OTHER,
    selectConversation: vi.fn(),
    isInitializing: false,
    // Only the meeting has something new.
    isConversationUnread: (c: Conversation) => c.id === 'conv-meeting-1',
  }),
}));

async function renderList() {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const { container } = render(<I18nextProvider i18n={i18n}><ConversationList onNewConversation={() => {}} /></I18nextProvider>);
  return container;
}

describe('a meeting\'s conversation in the conversation list', () => {
  it('is not listed beside ordinary conversations', async () => {
    const container = await renderList();
    expect(container.querySelector('[data-conversation-id="conv-meeting-1"]')).toBeNull();
    expect(screen.getByText('Report latency')).toBeTruthy();
  });

  it('shows what is new in it on its room\'s row', async () => {
    const container = await renderList();
    expect(container.querySelector('[data-conversation-id="conv-ops-1"]')?.className).toContain('unread');
    expect(container.querySelector('[data-conversation-id="conv-2"]')?.className).not.toContain('unread');
  });

  it("an ended meeting's conversation stays with its room, by the room the server reads from its record", async () => {
    const running = mine.meetings;
    mine.meetings = [];
    try {
      // Nothing names its room: it is listed like any other.
      expect((await renderList()).querySelector('[data-conversation-id="conv-meeting-1"]')).not.toBeNull();
      mine.rooms = [{ conversationId: 'conv-meeting-1', roomConversationId: 'conv-ops-1' }];
      const container = await renderList();
      expect(container.querySelector('[data-conversation-id="conv-meeting-1"]')).toBeNull();
      expect(container.querySelector('[data-conversation-id="conv-ops-1"]')?.className).toContain('unread');
    } finally {
      mine.meetings = running;
      mine.rooms = [];
    }
  });

  it('an archived meeting conversation carries nothing to its room', async () => {
    listed.items = [{ ...MEETING, archived: true }, ROOM, OTHER];
    try {
      const container = await renderList();
      expect(container.querySelector('[data-conversation-id="conv-ops-1"]')?.className).not.toContain('unread');
    } finally {
      listed.items = [MEETING, ROOM, OTHER];
    }
  });
});
