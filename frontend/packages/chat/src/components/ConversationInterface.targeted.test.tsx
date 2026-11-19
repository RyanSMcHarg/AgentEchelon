/**
 * A TARGETED MESSAGE SAYS WHO CAN SEE IT, in the main conversation and the meeting window's chat; an assistant's
 * `@humans` meeting notice is drawn as its card there too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import '@ae/shared/i18n';
import type { Message } from '@ae/shared';
import en from '@ae/shared/locales/en.json';
import { STARTED_CARD_CONTENT, STARTED_CARD_METADATA } from '../test-fixtures/meetingStartedCard';

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

const BOT = `${APP}/bot/ops`;
const at = new Date('2026-11-12T10:00:00Z');
const STORED = [
  { id: 't1', content: '.<Alice|alice-sub-123> just between us', isBot: false, timestamp: at, sender: { arn: ME, name: 'Me' }, targetArns: [ALICE] },
  { id: 't2', content: 'Here is your answer.', isBot: true, timestamp: at, sender: { arn: BOT, name: 'Ops' }, targetedToUser: true },
  { id: 't3', content: 'For the room.', isBot: true, timestamp: at, sender: { arn: BOT, name: 'Ops' }, modelId: 'anthropic.claude-sonnet-4-6' },
  { id: 't6', content: "You own the incident.\n1. Join the call\n2. Decide the change", isBot: true, timestamp: at, sender: { arn: BOT, name: 'Ops' }, taskCard: { id: 'evt-1', state: 'leading', choices: ['resolved'] } },
  { id: 't4', content: STARTED_CARD_CONTENT, isBot: true, timestamp: at, sender: { arn: BOT, name: 'Advisor' }, meetingCard: { event: 'meeting-started', meetingId: STARTED_CARD_METADATA.meetingCard.meetingId, conversationId: STARTED_CARD_METADATA.meetingCard.conversationId } },
  { id: 't5', content: '@humans The deploy finished.', isBot: true, timestamp: at, sender: { arn: BOT, name: 'Ops' } },
] as unknown as Message[];

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
      { userArn: BOT, name: 'Ops', isBot: true },
    ],
    renameConversation: vi.fn(),
    archiveConversation: vi.fn(),
    selectConversation: vi.fn(),
    conversations: [],
  });
});

describe.each([
  ['the conversation', false],
  ["the meeting window's chat", true],
])('in %s', (_where, inMeetingWindow) => {
  it('a targeted message says who can see it, to its sender and to its recipient, and a room message says nothing', () => {
    const { getAllByTestId } = render(<ConversationInterface inMeetingWindow={inMeetingWindow} />);
    expect(getAllByTestId('targeted-label').map((l) => l.textContent)).toEqual([
      en.message.onlyYouAnd.replace('{{names}}', 'Alice Cooper'),
      en.message.onlyYouAnd.replace('{{names}}', 'Ops'),
    ]);
  });

  it("the room's started card, with the router's exact Metadata, is drawn as its card, and no assistant text shows @humans", () => {
    const { container, getByTestId } = render(<ConversationInterface inMeetingWindow={inMeetingWindow} />);
    expect(getByTestId('meeting-started-card').textContent).toContain('Incident call in progress: AgentEchelon-demo-incident');
    expect(container.textContent).toContain('The deploy finished.');
    expect(container.textContent).not.toContain('@humans');
  });

  it("a task card's message is drawn inside the card, above its choices, once", () => {
    const { container } = render(<ConversationInterface inMeetingWindow={inMeetingWindow} />);
    const card = container.querySelector('.task-card')!;
    const body = card.querySelector('.task-card-body')!;
    expect(body.textContent).toContain("You own the incident.");
    expect(body.compareDocumentPosition(card.querySelector('.proposal-card-actions')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent!.split("You own the incident.").length - 1).toBe(1);
  });

  it("an assistant's reply carries no model label", () => {
    const { container } = render(<ConversationInterface inMeetingWindow={inMeetingWindow} />);
    expect(container.querySelector('.message-model-badge')).toBeNull();
    expect(container.textContent).not.toMatch(/via sonnet/i);
  });
});
