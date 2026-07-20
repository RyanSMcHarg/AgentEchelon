import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CollapsibleText, MESSAGE_COLLAPSE_THRESHOLD } from './CollapsibleText';

describe('CollapsibleText', () => {
  it('renders assistant Markdown as HTML (heading, bold, code, list, link, table)', () => {
    const md = [
      '# Heading',
      '',
      'Some **bold** and `inline code`.',
      '',
      '- one',
      '- two',
      '',
      '[link](https://example.com)',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n');

    const { container } = render(<CollapsibleText content={md} isBot={true} />);

    expect(container.querySelector('.message-markdown')).not.toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('Heading');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('code')?.textContent).toBe('inline code');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com');
    expect(link?.textContent).toBe('link');

    // remark-gfm table
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);

    // The literal Markdown syntax must NOT appear as raw text (the reported bug).
    expect(container.textContent).not.toContain('**bold**');
    expect(container.textContent).not.toContain('# Heading');
  });

  it('does NOT escape into raw HTML (XSS-safe by default)', () => {
    const { container } = render(
      <CollapsibleText content={'<img src=x onerror="alert(1)"> and **safe**'} isBot={true} />,
    );
    // react-markdown ignores raw HTML by default: no <img> element is created.
    expect(container.querySelector('img')).toBeNull();
    // ...but real Markdown still renders.
    expect(container.querySelector('strong')?.textContent).toBe('safe');
  });

  it('renders user messages as plain text (no Markdown parsing)', () => {
    const { container } = render(<CollapsibleText content={'**not bold**'} isBot={false} />);
    expect(container.querySelector('.message-markdown')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('**not bold**');
  });

  it('collapses a long assistant message behind a Show more toggle', () => {
    const long = ('word '.repeat(Math.ceil((MESSAGE_COLLAPSE_THRESHOLD + 400) / 5))).trim();
    const { container, getByRole } = render(<CollapsibleText content={long} isBot={true} />);

    const toggle = getByRole('button', { name: /show more/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Collapsed preview is shorter than the full content.
    const collapsedLen = (container.querySelector('.message-markdown')?.textContent ?? '').length;
    expect(collapsedLen).toBeLessThan(long.length);

    fireEvent.click(toggle);
    expect(getByRole('button', { name: /show less/i }).getAttribute('aria-expanded')).toBe('true');
    const expandedLen = (container.querySelector('.message-markdown')?.textContent ?? '').length;
    expect(expandedLen).toBeGreaterThan(collapsedLen);
  });

  it('does not collapse a short assistant message', () => {
    const { queryByRole } = render(<CollapsibleText content={'short reply'} isBot={true} />);
    expect(queryByRole('button', { name: /show more/i })).toBeNull();
  });
});
