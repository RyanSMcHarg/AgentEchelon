import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearMessageFocus,
  hasPendingMessageFocus,
  noteMessageFocusMiss,
  peekMessageFocus,
  requestMessageFocus,
  scrollToMessage,
} from './focusMessage';

const CONV = 'conv-a';
const OTHER_CONV = 'conv-b';
const TARGET = 'msg-1';
/** How a backend-composed deep link spells the same conversation. */
const CONV_ARN = `arn:aws:chime:us-east-1:1234:app-instance/f66def4e/channel/${CONV}`;

/** jsdom has no layout, so scrollIntoView is not implemented on Element. */
const scrollIntoView = vi.fn();
Element.prototype.scrollIntoView = scrollIntoView;

function renderMessage(id: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-message-id', id);
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  clearMessageFocus();
  document.body.innerHTML = '';
  scrollIntoView.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scrollToMessage', () => {
  it('reports failure when the target is not in the DOM', () => {
    expect(scrollToMessage(TARGET)).toBe(false);
  });

  it('scrolls and marks the target when it is rendered', () => {
    const el = renderMessage(TARGET);
    expect(scrollToMessage(TARGET)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(el.classList.contains('message--focused')).toBe(true);
  });
});

describe('a pending focus request', () => {
  it('waits across renders and still lands when the target arrives late', () => {
    requestMessageFocus(TARGET, CONV);

    // First pass: history has not rendered the target yet.
    expect(peekMessageFocus(CONV)).toBe(TARGET);
    expect(scrollToMessage(TARGET)).toBe(false);
    noteMessageFocusMiss();

    // Still pending, so auto-scroll stays out of the way.
    expect(hasPendingMessageFocus(CONV)).toBe(true);

    // The message arrives a moment later.
    const el = renderMessage(TARGET);
    expect(peekMessageFocus(CONV)).toBe(TARGET);
    expect(scrollToMessage(TARGET)).toBe(true);
    expect(el.classList.contains('message--focused')).toBe(true);

    clearMessageFocus();
    expect(hasPendingMessageFocus(CONV)).toBe(false);
  });

  it('gives up after the attempt ceiling so auto-scroll recovers', () => {
    requestMessageFocus(TARGET, CONV);

    // The ceiling leaves room for more than one render, or the late-arrival case would break.
    noteMessageFocusMiss();
    noteMessageFocusMiss();
    expect(hasPendingMessageFocus(CONV)).toBe(true);

    // A target that never renders: deleted, redacted, or past the loaded history page.
    for (let i = 0; i < 50; i++) {
      if (!peekMessageFocus(CONV)) break;
      noteMessageFocusMiss();
    }

    expect(hasPendingMessageFocus(CONV)).toBe(false);
    expect(peekMessageFocus(CONV)).toBeNull();
  });

  it('gives up on its deadline when no further render ever comes', () => {
    vi.useFakeTimers();
    requestMessageFocus(TARGET, CONV);
    expect(hasPendingMessageFocus(CONV)).toBe(true);

    vi.advanceTimersByTime(60_000);

    expect(hasPendingMessageFocus(CONV)).toBe(false);
  });

  it('does not leak into another conversation', () => {
    requestMessageFocus(TARGET, CONV);

    expect(hasPendingMessageFocus(OTHER_CONV)).toBe(false);
    expect(peekMessageFocus(OTHER_CONV)).toBeNull();
    // No conversation active at all (the component renders its empty state).
    expect(hasPendingMessageFocus(null)).toBe(false);
    expect(hasPendingMessageFocus(undefined)).toBe(false);

    // The conversation the link named still sees it.
    expect(peekMessageFocus(CONV)).toBe(TARGET);
  });

  it('matches the ARN a deep link carries against the short id the app holds', () => {
    // The welcome link addresses the parent by full channel ARN; `Conversation.id` is the last segment.
    requestMessageFocus(TARGET, CONV_ARN);

    expect(peekMessageFocus(CONV)).toBe(TARGET);
    expect(peekMessageFocus(CONV_ARN)).toBe(TARGET);
    expect(peekMessageFocus(OTHER_CONV)).toBeNull();
  });

  it('is ignored without both a message and a conversation', () => {
    requestMessageFocus('', CONV);
    expect(hasPendingMessageFocus(CONV)).toBe(false);

    requestMessageFocus(TARGET, '');
    expect(hasPendingMessageFocus('')).toBe(false);
    expect(hasPendingMessageFocus(CONV)).toBe(false);
  });

  it('replaces an earlier request rather than queueing behind it', () => {
    requestMessageFocus(TARGET, CONV);
    requestMessageFocus('msg-2', OTHER_CONV);

    expect(hasPendingMessageFocus(CONV)).toBe(false);
    expect(peekMessageFocus(OTHER_CONV)).toBe('msg-2');
  });
});
