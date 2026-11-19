/**
 * THE MEMBERS TOGGLE IN A CONVERSATION'S HEADER: its count is every member the panel lists, people and assistants alike,
 * its label says members, and it widens for its count so its icon stays visible.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import '@ae/shared/i18n';

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
const PEOPLE = [ME, `${APP}/user/a`, `${APP}/user/b`].map((userArn, i) => ({ userArn, name: `Person ${i}`, isBot: false }));
const ASSISTANTS = ['advisor', 'ops'].map((b) => ({ userArn: `${APP}/bot/${b}`, name: b, isBot: true }));

beforeEach(() => {
  vi.clearAllMocks();
  mockConversations.mockReturnValue({
    activeConversation: { id: 'c1', conversationArn: `${APP}/channel/c1`, title: 'Ops Team Main' },
    messages: [],
    isLoadingMessages: false,
    isBotTyping: false,
    channelMembers: [...PEOPLE, ...ASSISTANTS],
    renameConversation: vi.fn(),
    archiveConversation: vi.fn(),
    selectConversation: vi.fn(),
    conversations: [],
  });
});

describe('the members toggle', () => {
  it('counts every member the panel lists, people and assistants, and says members, not channel members', () => {
    const { getByRole } = render(<ConversationInterface />);
    const toggle = getByRole('button', { name: 'Show members' });
    expect(toggle.querySelector('.conversation-header-btn-count')?.textContent).toBe('5');
    // THE BUTTON WIDENS FOR ITS COUNT, so the icon beside it keeps its size.
    expect(toggle.className).toContain('has-count');
    expect(toggle.querySelector('svg')).not.toBeNull();
  });
});
