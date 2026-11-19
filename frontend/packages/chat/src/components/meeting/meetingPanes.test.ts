/**
 * THE MEETING WINDOW'S PANES ON A PHONE-WIDTH SCREEN (`meetingPanes.ts`): which panes there are, which is shown, and where
 * a swipe or a key lands.
 */
import { describe, it, expect } from 'vitest';
import { meetingPanes, paneAfterSwipe, paneForKey, paneShown, SWIPE_MIN_DISTANCE } from './meetingPanes';

const all = meetingPanes({ people: true, chat: true });

describe('the panes there are', () => {
  it('lists the video, then the roster and the chat where the window holds them', () => {
    expect(all).toEqual(['video', 'people', 'chat']);
    expect(meetingPanes({ people: false, chat: true })).toEqual(['video', 'chat']);
    expect(meetingPanes({ people: false, chat: false })).toEqual(['video']);
  });

  it('shows the video when the pane chosen is not there', () => {
    expect(paneShown('chat', all)).toBe('chat');
    expect(paneShown('people', ['video', 'chat'])).toBe('video');
  });
});

describe('a swipe', () => {
  it('moves one pane: leftward to the next, rightward to the previous', () => {
    expect(paneAfterSwipe('video', all, -80, 4)).toBe('people');
    expect(paneAfterSwipe('people', all, -80, 0)).toBe('chat');
    expect(paneAfterSwipe('chat', all, 80, 0)).toBe('people');
  });

  it('stops at either end', () => {
    expect(paneAfterSwipe('video', all, 120, 0)).toBe('video');
    expect(paneAfterSwipe('chat', all, -120, 0)).toBe('chat');
  });

  it('needs the least travel, and to be more sideways than up or down', () => {
    expect(paneAfterSwipe('video', all, -(SWIPE_MIN_DISTANCE - 1), 0)).toBe('video');
    expect(paneAfterSwipe('video', all, -SWIPE_MIN_DISTANCE, 0)).toBe('people');
    // Scrolling the chat or the roster with a little sideways drift.
    expect(paneAfterSwipe('chat', all, 60, 200)).toBe('chat');
  });
});

describe('the tab bar from the keyboard', () => {
  it('moves along the tabs with the arrows, around the ends, and to either end with Home and End', () => {
    expect(paneForKey('video', all, 'ArrowRight')).toBe('people');
    expect(paneForKey('chat', all, 'ArrowRight')).toBe('video');
    expect(paneForKey('video', all, 'ArrowLeft')).toBe('chat');
    expect(paneForKey('people', all, 'Home')).toBe('video');
    expect(paneForKey('people', all, 'End')).toBe('chat');
    expect(paneForKey('people', all, 'Enter')).toBeNull();
  });
});
