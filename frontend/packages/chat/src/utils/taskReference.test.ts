import { describe, it, expect } from 'vitest';
import { taskReferenceOf, withoutTaskReference } from './taskReference';

describe('taskReference', () => {
  it('reads a reference at the start, after mentions, and after re', () => {
    expect(taskReferenceOf('#2 EMEA only')).toBe(2);
    expect(taskReferenceOf('re #2: EMEA only')).toBe(2);
    expect(taskReferenceOf('@Atlas #12 yes')).toBe(12);
    expect(taskReferenceOf('#3')).toBe(3);
  });

  it('reads nothing elsewhere in a sentence, or from a longer token', () => {
    expect(taskReferenceOf('we ranked it #1 last quarter')).toBeNull();
    expect(taskReferenceOf('#2nd place')).toBeNull();
    expect(taskReferenceOf('#1234567')).toBeNull();
    expect(taskReferenceOf('#0 nothing')).toBeNull();
    expect(taskReferenceOf('')).toBeNull();
  });

  it('takes a reference back off, so dismissing the chip leaves ordinary text', () => {
    expect(withoutTaskReference('#5 EMEA only')).toBe('EMEA only');
    expect(withoutTaskReference('EMEA only')).toBe('EMEA only');
  });
});
