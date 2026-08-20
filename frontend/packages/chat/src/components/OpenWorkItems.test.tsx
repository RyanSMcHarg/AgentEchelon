/**
 * The open-items queue — what the user still owes, and the prompt that makes them notice.
 *
 * The behaviour that matters is not "a list renders". It is:
 *   - nothing is shown when nothing is owed (an empty affordance is noise that trains people to
 *     ignore the real one);
 *   - the count is stated without the user opening anything, because a queue nobody opens does not
 *     exist;
 *   - an item in ANOTHER conversation is listed and can be jumped to, which is the whole reason this
 *     is not derived from the loaded channel's messages;
 *   - an item in THIS conversation says so instead of offering to navigate somewhere you already are.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenWorkItems } from './OpenWorkItems';

const selectConversation = vi.fn();
let ctx: Record<string, unknown>;

vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => ctx,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars && 'count' in vars ? `${key}:${vars.count}` : key,
  }),
}));

const conversation = (id: string, title: string, arn: string) => ({
  id,
  title,
  conversationArn: arn,
});

const item = (over: Record<string, unknown> = {}) => ({
  taskId: 't1',
  taskType: 'report_generation',
  channelArn: 'arn:chan:other',
  status: 'in_progress',
  title: 'Scope the Q3 report',
  updatedAt: '2026-08-13T10:00:00.000Z',
  ...over,
});

beforeEach(() => {
  selectConversation.mockReset();
  ctx = {
    openWorkItems: [],
    conversations: [],
    selectConversation,
    activeConversation: null,
    battleWaitingBots: [],
  };
});

describe('OpenWorkItems', () => {
  it('renders nothing when the user owes nothing', () => {
    const { container } = render(<OpenWorkItems />);
    expect(container).toBeEmptyDOMElement();
  });

  it('states the count without the user opening anything', () => {
    ctx.openWorkItems = [item(), item({ taskId: 't2' })];
    render(<OpenWorkItems />);

    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('workItems.headlineMany:2')).toBeTruthy();
    // Collapsed by default: this is an obligation, not a workspace.
    expect(screen.queryByText('Scope the Q3 report')).toBeNull();
  });

  it('lists an item from ANOTHER conversation and takes the user there', () => {
    ctx.openWorkItems = [item()];
    ctx.conversations = [conversation('c9', 'Quarterly planning', 'arn:chan:other')];
    render(<OpenWorkItems />);

    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText('Scope the Q3 report')).toBeTruthy();
    expect(screen.getByText('Quarterly planning')).toBeTruthy();

    fireEvent.click(screen.getByText('workItems.finish'));
    // The point of the cross-conversation queue: the forgotten item is somewhere else, and one click
    // goes there.
    expect(selectConversation).toHaveBeenCalledWith('c9');
  });

  it('does not offer to navigate to the conversation you are already in', () => {
    ctx.openWorkItems = [item({ channelArn: 'arn:chan:here' })];
    ctx.conversations = [conversation('c1', 'This one', 'arn:chan:here')];
    ctx.activeConversation = conversation('c1', 'This one', 'arn:chan:here');
    render(<OpenWorkItems />);

    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText('workItems.here')).toBeTruthy();
    expect(screen.queryByText('workItems.finish')).toBeNull();
  });

  it('can still TAKE YOU to an item whose conversation this client has not loaded', () => {
    // This asserted the opposite - listed, but with no way to open it - on the reasoning that the
    // client should not offer what it cannot do. It can: `selectConversation` resolves an unlisted
    // channel through the same deep-link path a navigation marker uses, and the conversation id is
    // the channel ARN's last segment.
    //
    // The old behaviour was worst exactly where the queue matters most. Work you have forgotten is by
    // definition in a conversation you are not looking at, which is the one least likely to be loaded -
    // so the item you most needed to reach was the one that offered no way to reach it.
    ctx.openWorkItems = [item({ channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c-unloaded' })];
    ctx.conversations = [];
    render(<OpenWorkItems />);

    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText('Scope the Q3 report')).toBeTruthy();
    // Still honest about the NAME: without the conversation loaded there is no title to show.
    expect(screen.getByText('workItems.otherConversation')).toBeTruthy();

    fireEvent.click(screen.getByText('workItems.finish'));
    expect(ctx.selectConversation).toHaveBeenCalledWith('c-unloaded');
  });

  it('renders a task type a person can read, never the raw key', () => {
    // The fallback for an item with no title of its own rendered `report_generation`. Task types are
    // declared per deployment, so there is no table to look them up in - the key is reshaped instead,
    // which is what the backend already does for the status chip and degrades for a type nobody
    // anticipated.
    ctx.openWorkItems = [item({ title: undefined, taskType: 'report_generation' })];
    ctx.conversations = [];
    render(<OpenWorkItems />);

    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText('Report generation')).toBeTruthy();
    expect(screen.queryByText('report_generation')).toBeNull();
  });
});

/**
 * A running battle holds the floor.
 *
 * While a duel waits on this person, answering some other workflow would advance that machine with two
 * assistants sitting mid-comparison, and the duel cannot proceed until it has its answer. So everything
 * that is not the duel's own item becomes unselectable - and stays VISIBLE, because hiding it would
 * tell the user their outstanding work had disappeared.
 */
describe('OpenWorkItems while a battle is waiting', () => {
  const inBattle = () => {
    ctx.activeConversation = conversation('c1', 'Duel', 'arn:chan:battle');
    ctx.conversations = [
      conversation('c1', 'Duel', 'arn:chan:battle'),
      conversation('c2', 'Quarterly planning', 'arn:chan:other'),
    ];
    ctx.battleWaitingBots = [{ botArn: 'arn:bot:atlas', battleId: 'b1' }];
  };

  it('keeps an unrelated item visible but unselectable, and says why', () => {
    inBattle();
    ctx.openWorkItems = [item({ taskId: 't2', channelArn: 'arn:chan:other', title: 'Scope the Q3 report' })];
    render(<OpenWorkItems />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    // Visible: the user must not think the work vanished.
    expect(screen.getByText('Scope the Q3 report')).toBeTruthy();
    expect(screen.getByText('workItems.blockedByBattle')).toBeTruthy();
    // Unselectable: the jump is disabled rather than absent.
    expect(screen.getByText('workItems.finish').closest('button')?.disabled).toBe(true);
  });

  it('leaves the DUEL\'s own item answerable, or the battle could never be resolved', () => {
    inBattle();
    ctx.openWorkItems = [item({ taskId: 't1', channelArn: 'arn:chan:battle', title: 'Which quarter?' })];
    render(<OpenWorkItems />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText('Which quarter?')).toBeTruthy();
    expect(screen.queryByText('workItems.blockedByBattle')).toBeNull();
  });

  it('releases the others once no side is waiting', () => {
    ctx.activeConversation = conversation('c1', 'Duel', 'arn:chan:battle');
    ctx.conversations = [conversation('c2', 'Quarterly planning', 'arn:chan:other')];
    ctx.battleWaitingBots = [];
    ctx.openWorkItems = [item({ taskId: 't2', channelArn: 'arn:chan:other' })];
    render(<OpenWorkItems />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.queryByText('workItems.blockedByBattle')).toBeNull();
    expect(screen.getByText('workItems.finish').closest('button')?.disabled).toBe(false);
  });
});
