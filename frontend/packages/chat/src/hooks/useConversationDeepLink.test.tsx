/**
 * A CONVERSATION LINK IN A MESSAGE OPENS IN PLACE (`useConversationDeepLink.ts`, `CollapsibleText.tsx`).
 *
 * A team room's "opened an incident: [open it](?conversation=<id>)" selects the room as the sidebar does, with no page
 * load, so the app, its messaging session and an open meeting stay as they are. A click that asks for another tab is
 * the browser's, and an app not ready yet follows the address, which the deep link opens on load.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useConversationDeepLink, openConversationLinkInPlace } from './useConversationDeepLink';
import { CollapsibleText } from '../components/CollapsibleText';
import * as focus from '../utils/focusMessage';

function Opener({ ready, select }: { ready: boolean; select: (id: string) => Promise<void> }) {
  useConversationDeepLink(ready, select);
  return null;
}

afterEach(() => cleanup());

describe('a conversation link in a message opens in place', () => {
  it('selects the conversation the link names, with no navigation', () => {
    const select = vi.fn(async () => undefined);
    render(<Opener ready select={select} />);
    const { container } = render(<CollapsibleText content="Report latency opened an incident: [open it](?conversation=conv-ops-1)." isBot />);
    const link = container.querySelector('a') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    expect(select).toHaveBeenCalledWith('conv-ops-1');
    // The browser's own navigation is cancelled: the app does not load again.
    expect(event.defaultPrevented).toBe(true);
  });

  it('focuses the message a link names, by the deep link\'s rule', () => {
    const select = vi.fn(async () => undefined);
    const requested = vi.spyOn(focus, 'requestMessageFocus');
    render(<Opener ready select={select} />);
    expect(openConversationLinkInPlace('?conversation=conv-1#message=m%201')).toBe(true);
    expect(requested).toHaveBeenCalledWith('m 1', 'conv-1');
    expect(select).toHaveBeenCalledWith('conv-1');
  });

  it('leaves a click asking for another tab to the browser', () => {
    const select = vi.fn(async () => undefined);
    render(<Opener ready select={select} />);
    const { container } = render(<CollapsibleText content="[open it](?conversation=conv-ops-1)" isBot />);
    fireEvent.click(container.querySelector('a') as HTMLAnchorElement, { ctrlKey: true });
    expect(select).not.toHaveBeenCalled();
  });

  it('follows the address while the app is not ready to open it', () => {
    const select = vi.fn(async () => undefined);
    render(<Opener ready={false} select={select} />);
    expect(openConversationLinkInPlace('?conversation=conv-ops-1')).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('opens nothing once the app that registered it is gone', () => {
    const select = vi.fn(async () => undefined);
    const { unmount } = render(<Opener ready select={select} />);
    unmount();
    expect(openConversationLinkInPlace('?conversation=conv-ops-1')).toBe(false);
  });
});
