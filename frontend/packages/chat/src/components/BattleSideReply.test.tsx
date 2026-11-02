/**
 * BattleSideReply - the answer control on a duel side waiting on the person (DESIGN-BATTLE, "A side
 * parked on the person").
 *
 * A side parked on a task step resumes only on a reply targeted at it from the person who ran `/battle`.
 * Before this control, nothing in the chat app sent that reply, so a person could not answer a parked
 * side at all. The duel's owner is offered the reply (and "Answer both sides" when both wait); everyone
 * else reads whom the side waits on. Copy is read through the locale, so the assertions are on keys.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: { name?: string }) => (o?.name ? `${key}:${o.name}` : key),
  }),
}));

import { BattleSideReply, type BattleSideReplyProps } from './BattleSideReply';

const props = (over: Partial<BattleSideReplyProps> = {}): BattleSideReplyProps => ({
  sideName: 'Atlas',
  canAnswer: true,
  replying: false,
  offerBoth: false,
  onReply: vi.fn(),
  onReplyBoth: vi.fn(),
  ...over,
});

describe('the duel owner', () => {
  it('is offered "Reply to this side", labeled with the side for assistive technology', () => {
    render(<BattleSideReply {...props()} />);

    const button = screen.getByRole('button', { name: 'conversation.battleSide.replyAria:Atlas' });
    expect(button).toHaveTextContent('conversation.battleSide.reply');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('group', { name: 'conversation.battleSide.groupLabel:Atlas' })).toBeInTheDocument();
  });

  it('reaches it from the keyboard and chooses the side with Enter', async () => {
    const onReply = vi.fn();
    render(<BattleSideReply {...props({ onReply })} />);
    const user = userEvent.setup();

    await user.tab();
    expect(screen.getByRole('button', { name: 'conversation.battleSide.replyAria:Atlas' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('shows the side as chosen while the composer replies to it', () => {
    render(<BattleSideReply {...props({ replying: true })} />);

    expect(screen.getByRole('button', { name: 'conversation.battleSide.replyAria:Atlas' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('is offered "Answer both sides" when both sides wait on them', async () => {
    const onReplyBoth = vi.fn();
    render(<BattleSideReply {...props({ offerBoth: true, onReplyBoth })} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'conversation.battleSide.replyBothAria' }));
    expect(onReplyBoth).toHaveBeenCalledTimes(1);
  });

  it('is not offered "Answer both sides" while only this side waits', () => {
    render(<BattleSideReply {...props()} />);

    expect(screen.queryByRole('button', { name: 'conversation.battleSide.replyBothAria' })).toBeNull();
  });
});

describe('everyone else', () => {
  it('reads whom the side is waiting on, and is offered no reply', () => {
    render(<BattleSideReply {...props({ canAnswer: false, ownerName: 'Dana' })} />);

    expect(screen.getByRole('status')).toHaveTextContent('conversation.battleSide.waitingOn:Dana');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('reads that the side waits on whoever started the duel when that person is not in the roster', () => {
    render(<BattleSideReply {...props({ canAnswer: false })} />);

    expect(screen.getByRole('status')).toHaveTextContent('conversation.battleSide.waitingOnOwner');
  });
});
