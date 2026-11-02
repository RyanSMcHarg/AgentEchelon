import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { renderMarkdown } from './markdown';

const html = (text: string) => render(<div>{renderMarkdown(text)}</div>).container;

describe('renderMarkdown', () => {
  it('renders a bullet list as <ul><li>', () => {
    const c = html('- Lisbon\n- Porto\n- Faro');
    expect(c.querySelectorAll('ul li')).toHaveLength(3);
    expect(c.textContent).toContain('Faro');
  });

  it('renders an ordered list as <ol><li>', () => {
    const c = html('1. first\n2. second');
    expect(c.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('renders bold and italic', () => {
    const c = html('**bold** and _italic_');
    expect(c.querySelector('strong')?.textContent).toBe('bold');
    expect(c.querySelector('em')?.textContent).toBe('italic');
  });

  it('renders a markdown link with a safe href + new-tab rel', () => {
    const a = html('see [the guide](https://example.com/guide)').querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com/guide');
    expect(a?.getAttribute('rel')).toContain('noopener');
    expect(a?.textContent).toBe('the guide');
  });

  it('autolinks a bare URL', () => {
    const a = html('visit https://maps.example.com/x here').querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://maps.example.com/x');
  });

  it('does NOT render a javascript: link as an anchor (XSS guard)', () => {
    const c = html('[click](javascript:alert(1))');
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toContain('click');
  });

  it('renders inline code without re-parsing its contents', () => {
    const c = html('use `**not bold**` literally');
    expect(c.querySelector('code')?.textContent).toBe('**not bold**');
    expect(c.querySelector('code strong')).toBeNull();
  });

  it('separates paragraphs on blank lines', () => {
    const c = html('para one\n\npara two');
    expect(c.querySelectorAll('p')).toHaveLength(2);
  });

  it('renders a list following a paragraph (mixed blocks)', () => {
    const c = html('Here are options:\n- A\n- B');
    expect(c.querySelectorAll('p')).toHaveLength(1);
    expect(c.querySelectorAll('ul li')).toHaveLength(2);
  });
});
