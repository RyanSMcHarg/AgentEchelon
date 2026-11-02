import { describe, it, expect } from 'vitest';
import { displayText, unwrapLexStructural } from './messageFormat';

describe('unwrapLexStructural', () => {
  it('unwraps a bare Lex envelope', () => {
    expect(unwrapLexStructural('{"Messages":[{"Content":"Hi there"}]}')).toBe('Hi there');
  });
  it('leaves a prose answer that contains JSON untouched', () => {
    expect(unwrapLexStructural('Sure, here is some JSON: {"Messages":[...]}')).toContain('Sure');
  });
  it('does not unwrap an object with other keys', () => {
    const s = '{"Messages":[{"Content":"x"}],"other":1}';
    expect(unwrapLexStructural(s)).toBe(s);
  });
});

describe('displayText', () => {
  it('decodes, unwraps Lex and strips the platform markers', () => {
    const raw = encodeURIComponent('{"Messages":[{"Content":"Hi <!--corr:abc-->"}]}');
    expect(displayText(raw)).toBe('Hi');
  });
  it('keeps raw text with a bare percent sign', () => {
    expect(displayText('usage down 30%')).toBe('usage down 30%');
  });
  it('is empty for no content', () => {
    expect(displayText(undefined)).toBe('');
  });
});
