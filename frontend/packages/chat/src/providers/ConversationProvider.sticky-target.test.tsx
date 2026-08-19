/**
 * ConversationProvider — a sticky mention target belongs to ONE conversation.
 *
 * THE DEFECT THIS EXISTS FOR. The sticky target is set from a mention the user just sent, and the
 * composer then prepends `@Name ` to every later message that does not already start with `@`.
 * `selectConversation` cleared it on switch, but `createConversation` did not: it swaps the active
 * conversation directly. So creating a conversation carried the previous one's sticky target into
 * it, asserting a targeted exchange that never happened there and naming a member who is usually not
 * even in the new channel. Every message the user typed was silently re-addressed.
 *
 * That is the same class as the "cross-chat leak" the create path already documents for in-flight
 * replies - state belonging to the outgoing conversation surviving the swap - and it is closed the
 * same way: keyed on the conversation ARN, in one place, rather than as a step each new call site
 * has to remember. The explicit clear in selectConversation is left alone; it is now redundant
 * rather than load-bearing.
 *
 * It surfaced as e2e B-E6, where a `/battle` in a freshly created channel went out as
 * `@Assistant-premium /battle ...` and the router correctly declined to start a duel.
 *
 * These tests drive the provider's real create/select paths through its context, because the swap is
 * what the defect rode in on - asserting on a reimplementation of the effect would prove nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

const createConversationSvc = vi.fn();
const listMessages = vi.fn();
const listChannelMembers = vi.fn();
const getConversation = vi.fn();
const listConversations = vi.fn();

const ARN_A = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-a';
const ARN_B = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-b';
const SELF = 'arn:aws:chime:us-east-1:111:app-instance/i/user/self';

const CONV_A = {
  id: 'conv-a', conversationArn: ARN_A, title: 'A', modelTier: 'premium',
  modelId: 'anthropic.claude-opus', modelName: 'Opus', messages: [], createdAt: new Date().toISOString(),
};
const CONV_B = {
  id: 'conv-b', conversationArn: ARN_B, title: 'B', modelTier: 'premium',
  modelId: 'anthropic.claude-opus', modelName: 'Opus', messages: [], createdAt: new Date().toISOString(),
};

vi.mock('../services/chimeService', () => ({
  chimeService: {
    createConversation: (...a: unknown[]) => createConversationSvc(...a),
    getConversation: (...a: unknown[]) => getConversation(...a),
    listConversations: (...a: unknown[]) => listConversations(...a),
    listMessages: (...a: unknown[]) => listMessages(...a),
    listChannelMembers: (...a: unknown[]) => listChannelMembers(...a),
    markConversationRead: () => Promise.resolve(),
    getUserArn: () => SELF,
    sendMessage: () => Promise.resolve(),
    shareConversation: () => Promise.resolve({}),
    updateChannelName: () => Promise.resolve(),
  },
}));
vi.mock('../services/notificationService', () => ({
  notificationService: {
    closeAll: () => {},
    notifyNewMessage: () => {},
    requestPermission: () => Promise.resolve(),
  },
}));
vi.mock('../services/conversationManagementService', () => ({
  archiveConversation: vi.fn(),
  leaveConversation: vi.fn(),
}));
// Stable references: the provider's effects depend on these, and a fresh object per render would
// re-run them forever under jsdom (an infinite render loop looks like a hang with no output).
const AUTH = { user: { userArn: SELF, isAdmin: false, tier: 'premium' } };
const AWS_CLIENT = { isInitialized: true };
const MESSAGING = { setChannelListener: () => {}, setGlobalListener: () => {} };
// Full replacement, NOT importOriginal: the real @ae/shared barrel reaches AWS SDK modules that
// never settle under jsdom and hang the run at import time.
vi.mock('@ae/shared', () => ({
  useAuth: () => AUTH,
  trackEvent: () => {},
}));
vi.mock('@ae/shared/i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('./AwsClientProvider', () => ({ useAwsClient: () => AWS_CLIENT }));
vi.mock('./MessagingProvider', () => ({ useMessaging: () => MESSAGING }));

import { ConversationProvider, useConversations } from './ConversationProvider.chime';

const TARGET = { userArn: 'bot-arn', name: 'Assistant-premium', isBot: true, isAll: false };

/** Exposes the pieces of context these tests drive, plus the sticky value under assertion. */
let ctx: ReturnType<typeof useConversations>;
const Probe: React.FC = () => {
  ctx = useConversations();
  return <div data-testid="sticky">{ctx.stickyTarget ? ctx.stickyTarget.name : 'NONE'}</div>;
};

const sticky = () => screen.getByTestId('sticky').textContent;

async function mount() {
  render(
    <ConversationProvider>
      <Probe />
    </ConversationProvider>,
  );
  // The provider loads its list on mount; let that settle so it cannot land mid-assertion.
  await waitFor(() => expect(listConversations).toHaveBeenCalled());
}

beforeEach(() => {
  createConversationSvc.mockReset().mockResolvedValue(CONV_B);
  listMessages.mockReset().mockResolvedValue([]);
  listChannelMembers.mockReset().mockResolvedValue([]);
  getConversation.mockReset().mockResolvedValue(CONV_A);
  listConversations.mockReset().mockResolvedValue([CONV_A]);
});

describe('ConversationProvider — sticky target does not cross conversations', () => {
  it('drops the sticky target when a NEW conversation is created', async () => {
    await mount();

    // The user targeted someone in the conversation they were in.
    await act(async () => { ctx.setStickyTarget(TARGET); });
    expect(sticky()).toBe('Assistant-premium');

    // Creating a conversation swaps active WITHOUT going through selectConversation — the path the
    // sticky target used to survive.
    await act(async () => { await ctx.createConversation('B', 'anthropic.claude-opus', 'Opus'); });

    await waitFor(() => expect(sticky()).toBe('NONE'));
  });

  it('drops the sticky target when SELECTING a different conversation', async () => {
    await mount();

    await act(async () => { ctx.setStickyTarget(TARGET); });
    expect(sticky()).toBe('Assistant-premium');

    await act(async () => { await ctx.selectConversation('conv-a'); });

    await waitFor(() => expect(sticky()).toBe('NONE'));
  });

  it('keeps the sticky target while the SAME conversation stays open', async () => {
    await mount();

    // Guard against over-correcting: clearing on every render would also pass the tests above while
    // destroying the feature, which is carrying the mention forward within one conversation.
    await act(async () => { await ctx.selectConversation('conv-a'); });
    await act(async () => { ctx.setStickyTarget(TARGET); });

    // A re-render that does not change which conversation is open must not clear it.
    await act(async () => { await ctx.selectConversation('conv-a'); });
    expect(sticky()).toBe('Assistant-premium');
  });
});
