/**
 * THE VIDEO LAYOUT'S RULES (SPEC-ASSISTANT-MEETINGS FR61): what is subscribed and at what priority, the pages, and the
 * initials of a tile with no video.
 */
import { describe, it, expect } from 'vitest';
import { baseAttendeeOf, initialsOf, pageOf, videoPreferencesFor } from './videoLayout';

describe('the videos subscribed', () => {
  it('takes every share first, the featured next at high resolution, the rest in view after, and nothing out of view', () => {
    const choices = videoPreferencesFor({ sources: ['a-3', 'a-1', 'a-2#content', 'a-2', 'a-9'], visible: ['a-1', 'a-2', 'a-3'], featured: ['a-3'] });
    expect(choices).toEqual([
      { attendeeId: 'a-2#content', priority: 1, size: 'high' },
      { attendeeId: 'a-3', priority: 2, size: 'high' },
      { attendeeId: 'a-1', priority: 3, size: 'high' },
      { attendeeId: 'a-2', priority: 3, size: 'high' },
    ]);
  });

  it('asks a smaller resolution as more are in view, and none of a person not publishing', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `a-${i}`);
    expect(videoPreferencesFor({ sources: ids(5), visible: ids(5) }).every((c) => c.size === 'medium')).toBe(true);
    expect(videoPreferencesFor({ sources: ids(9), visible: ids(9) }).every((c) => c.size === 'low')).toBe(true);
    expect(videoPreferencesFor({ sources: [], visible: ['a-1'] })).toEqual([]);
  });
});

describe('the grid pages', () => {
  it('holds the page within the pages there are', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    expect(pageOf(items, 1, 9)).toEqual({ items: [9, 10, 11], page: 1, pages: 2 });
    expect(pageOf(items, 5, 9).page).toBe(1);
    expect(pageOf([], 0, 9)).toEqual({ items: [], page: 0, pages: 1 });
  });
});

describe('a name as initials, and a share as its sharer', () => {
  it('takes the first and last word', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('ada  de la lovelace ')).toBe('AL');
    expect(initialsOf('Ada')).toBe('A');
    expect(initialsOf('')).toBe('');
  });
  it('reads the sharer from a share attendee', () => {
    expect(baseAttendeeOf('a-1#content')).toBe('a-1');
    expect(baseAttendeeOf('a-1')).toBe('a-1');
  });
});
