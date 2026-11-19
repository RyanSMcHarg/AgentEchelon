/**
 * The conversation draws each message's mentions as chips by the member's name, in the main view and
 * in the meeting window's chat, for a person's message and an assistant's reply alike. The stored
 * message keeps its `@<Name|id>` token for the server; the reader never sees the id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import '@ae/shared/i18n';
import type { Message } from '@ae/shared';

const mockConversations = vi.fn();
vi.mock('../providers/ConversationProvider.chime', () => ({ useConversations: () => mockConversations() }));
vi.mock('../providers/AwsClientProvider', () => ({ useAwsClient: () => ({ userArn: ME }) }));
vi.mock('../hooks/useConversationMeeting', () => ({ useConversationMeeting: () => ({}) }));
vi.mock('../hooks/useTurnState', () => ({ useTurnState: () => ({ queuedIds: new Set<string>(), dispatchFailed: false }) }));
vi.mock('../services/meetingService', () => ({ isMeetingEnabled: () => false }));
vi.mock('../services/channelBattleService', () => ({ getBattleConfig: () => Promise.resolve(null) }));
vi.mock('../services/chimeService', () => ({ chimeService: { listModerators: () => Promise.resolve([]) } }));
vi.mock('@ae/shared', async (orig) => ({ ...(await orig<object>()), personApiServes: () => false }));
vi.mock('./ChannelMembersPanel', () => ({ default: () => null }));
vi.mock('./ShareConversationModal', () => ({ default: () => null }));
vi.mock('./ArchiveConversationModal', () => ({ default: () => null }));
vi.mock('./meeting/MeetingInProgress', () => ({ default: () => null }));

import ConversationInterface from './ConversationInterface';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/abc';
const ME = `${APP}/user/me-sub`;
const ALICE = `${APP}/user/alice-sub-123`;

const message = (id: string, content: string, isBot: boolean): Message => ({
  id,
  content,
  isBot,
  timestamp: new Date('2026-11-12T10:00:00Z'),
  sender: { arn: isBot ? `${APP}/bot/advisor` : ME, name: isBot ? 'Advisor' : 'Me' },
} as unknown as Message);

const STORED = [
  message('m1', 'hey @<Alice|alice-sub-123> and @<Bob|gone-sub>', false),
  message('m2', '.<Alice|alice-sub-123> private note', false),
  message('m3', 'Thanks **@<Alice|alice-sub-123>**, noted.', true),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockConversations.mockReturnValue({
    activeConversation: { id: 'c1', conversationArn: `${APP}/channel/c1`, title: 'Room' },
    messages: STORED,
    isLoadingMessages: false,
    isBotTyping: false,
    channelMembers: [
      { userArn: ME, name: 'Me', isBot: false },
      { userArn: ALICE, name: 'Alice Cooper', isBot: false },
    ],
    renameConversation: vi.fn(),
    archiveConversation: vi.fn(),
    selectConversation: vi.fn(),
    conversations: [],
  });
});

describe.each([
  ['the conversation', false],
  ['the meeting window\'s chat', true],
])('mentions in %s', (_where, inMeetingWindow) => {
  it('draw as chips by the member\'s current name, with no id, pipe or brackets', () => {
    const { container } = render(<ConversationInterface inMeetingWindow={inMeetingWindow} />);
    const chips = Array.from(container.querySelectorAll('.message-address-chip')).map((c) => c.textContent);
    // A person's message, a private address, and an assistant reply.
    expect(chips).toEqual(['@Alice Cooper', '@Bob', '.Alice Cooper', '@Alice Cooper']);
    const text = container.textContent ?? '';
    expect(text).not.toContain('alice-sub-123');
    expect(text).not.toContain('gone-sub');
    expect(container.innerHTML).not.toContain('alice-sub-123');
    // The stored messages are unchanged.
    expect(STORED.map((m) => m.content)).toEqual([
      'hey @<Alice|alice-sub-123> and @<Bob|gone-sub>',
      '.<Alice|alice-sub-123> private note',
      'Thanks **@<Alice|alice-sub-123>**, noted.',
    ]);
  });
});
