// @vitest-environment jsdom
/**
 * useFollowBottom - the conversation follows its newest content while the viewer is at the bottom.
 *
 * Every chat view renders its messages through `ConversationInterface`, and this is its scrolling rule.
 * The defect it closes: new messages, and duel replies that land as UPDATEs and grow as their answer and
 * images arrive, stayed below the fold. jsdom has no layout, so the list's geometry is modeled here: a
 * content height the test sets, a fixed viewport, and a `ResizeObserver` the test fires the way a
 * browser does when the content changes height.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useRef } from 'react';
import { useFollowBottom } from './useFollowBottom';

const VIEWPORT = 500;
let contentHeight = 2000;
let resizeCallbacks: Array<() => void> = [];

class FakeResizeObserver {
  private cb: () => void;
  constructor(cb: () => void) { this.cb = cb; }
  observe() { resizeCallbacks.push(this.cb); }
  disconnect() { resizeCallbacks = resizeCallbacks.filter((c) => c !== this.cb); }
  unobserve() {}
}

const scrollTops = new WeakMap<Element, number>();
const originals: Record<string, PropertyDescriptor | undefined> = {};

beforeEach(() => {
  contentHeight = 2000;
  resizeCallbacks = [];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  for (const key of ['scrollHeight', 'clientHeight', 'scrollTop']) {
    originals[key] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
      ?? Object.getOwnPropertyDescriptor(Element.prototype, key);
  }
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return contentHeight; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return VIEWPORT; } });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get() { return scrollTops.get(this) ?? 0; },
    // Clamped the way a browser clamps it.
    set(v: number) { scrollTops.set(this, Math.max(0, Math.min(v, contentHeight - VIEWPORT))); },
  });
});

afterEach(() => {
  for (const key of ['scrollHeight', 'clientHeight', 'scrollTop']) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    if (originals[key]) Object.defineProperty(Element.prototype, key, originals[key]!);
  }
});

function List({ messages, conversation }: { messages: string[]; conversation: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const follow = useFollowBottom({ containerRef, contentRef, changeKey: messages, resetKey: conversation });
  return (
    <>
      <div data-testid="list" ref={containerRef} onScroll={follow.onScroll}>
        <div ref={contentRef}>{messages.map((m) => <p key={m}>{m}</p>)}</div>
      </div>
      {follow.showJump && <button type="button" onClick={follow.jumpToBottom}>jump</button>}
    </>
  );
}

const list = () => screen.getByTestId('list');
const bottom = () => contentHeight - VIEWPORT;

/** The viewer scrolls the list to `top`. */
function scrollTo(top: number) {
  list().scrollTop = top;
  fireEvent.scroll(list());
}

/** The content changes height without a new message, as an UPDATE or an image load does. */
function contentGrowsTo(height: number) {
  contentHeight = height;
  act(() => { for (const cb of resizeCallbacks) cb(); });
}

describe('useFollowBottom', () => {
  it('opens a conversation at its newest message', () => {
    render(<List messages={['a', 'b']} conversation="c1" />);
    expect(list().scrollTop).toBe(bottom());
  });

  it('follows a new message while the viewer is at the bottom', () => {
    const { rerender } = render(<List messages={['a']} conversation="c1" />);
    contentHeight = 2600;
    rerender(<List messages={['a', 'b']} conversation="c1" />);
    expect(list().scrollTop).toBe(bottom());
    expect(screen.queryByRole('button', { name: 'jump' })).toBeNull();
  });

  it('stays pinned when an UPDATE or an image load grows the content', () => {
    render(<List messages={['a']} conversation="c1" />);
    contentGrowsTo(3400);
    expect(list().scrollTop).toBe(bottom());
  });

  it('a viewer near the bottom, within the threshold, still follows', () => {
    render(<List messages={['a']} conversation="c1" />);
    scrollTo(bottom() - 40);
    contentGrowsTo(2800);
    expect(list().scrollTop).toBe(bottom());
  });

  it('leaves a viewer reading history where they are, and offers the jump instead', () => {
    const { rerender } = render(<List messages={['a']} conversation="c1" />);
    scrollTo(200);
    contentHeight = 2600;
    rerender(<List messages={['a', 'b']} conversation="c1" />);
    contentGrowsTo(3000);

    expect(list().scrollTop).toBe(200);
    expect(screen.getByRole('button', { name: 'jump' })).not.toBeNull();
  });

  it('the jump returns to the bottom and resumes following', () => {
    const { rerender } = render(<List messages={['a']} conversation="c1" />);
    scrollTo(200);
    rerender(<List messages={['a', 'b']} conversation="c1" />);
    fireEvent.click(screen.getByRole('button', { name: 'jump' }));

    expect(list().scrollTop).toBe(bottom());
    expect(screen.queryByRole('button', { name: 'jump' })).toBeNull();
    contentGrowsTo(3200);
    expect(list().scrollTop).toBe(bottom());
  });

  it('a different conversation opens at its bottom even after the last was scrolled up', () => {
    const { rerender } = render(<List messages={['a']} conversation="c1" />);
    scrollTo(100);
    contentHeight = 1500;
    rerender(<List messages={['x']} conversation="c2" />);
    expect(list().scrollTop).toBe(bottom());
  });
});
