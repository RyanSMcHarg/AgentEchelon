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

  it('renders user messages as plain text by default', () => {
    // Plain-by-default is right for a person: what they typed is what they meant, and a literal `**`
    // should survive being sent.
    const { container } = render(<CollapsibleText content={'**not bold**'} isBot={false} />);
    expect(container.querySelector('.message-markdown')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('**not bold**');
  });

  it('renders a user message as Markdown when they ask with /md', () => {
    // What was missing was any way to opt in. The recorded reason for plain-only was that users "do
    // not author Markdown", which is not true of people who paste code and write lists.
    const { container } = render(<CollapsibleText content={'/md **bold**'} isBot={false} />);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });

  it('shows the effect of the command and never the command', () => {
    const { container } = render(<CollapsibleText content={'/md **bold**'} isBot={false} />);
    expect(container.textContent).not.toContain('/md');
  });

  it('does not treat a mention of the command as the command', () => {
    // Anchored, so a message ABOUT `/md` is not formatted by it - and is not edited either.
    const { container } = render(<CollapsibleText content={'use /md to format **this**'} isBot={false} />);
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('use /md to format **this**');
  });

  it('opens links away from the app, and cannot be reached back through', () => {
    // Opt-in markdown lets a member write a link whose text disagrees with its href, so the window
    // handle and the referrer are denied. A property of the renderer, so assistant links get it too.
    const { container } = render(
      <CollapsibleText content={'[click](https://example.com)'} isBot={true} />,
    );
    const link = container.querySelector('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(link?.getAttribute('rel')).toContain('noreferrer');
  });

  /**
   * THE ONE EXCEPTION, AND ITS EDGES.
   *
   * A drift-spawned conversation links back to the message that spawned it. Sent to a new tab, that
   * link does not take you back - the tab you are reading stays on the child, which is what
   * `drift-detection.spec.ts:376` measured against the live deployment.
   */
  it('navigates the app\'s own conversation deep link in place, so the link returns you', () => {
    const { container } = render(
      <CollapsibleText
        content={'[the conversation it came from](?conversation=arn%3Aaws%3Achime%3Aus-east-1%3A1%3Aapp-instance%2Fi%2Fchannel%2Fc1#message=m1)'}
        isBot={true}
      />,
    );
    const link = container.querySelector('a');
    expect(link?.getAttribute('target')).toBeNull();
    expect(link?.getAttribute('href')).toContain('?conversation=');
    expect(link?.getAttribute('href')).toContain('#message=m1');
  });

  it('does not let a look-alike href escape the same-tab exception', () => {
    // The exception is a SHAPE test, not a trust decision - an injected message can spell it too. So
    // it must admit only a relative query string: anything naming another origin keeps `_blank` and
    // the denied window handle, which is the whole defense.
    for (const href of [
      'https://evil.example.com/?conversation=x',
      '//evil.example.com/?conversation=x',
      'http://evil.example.com?conversation=x',
      '/other/path?conversation=x',
    ]) {
      const { container } = render(<CollapsibleText content={`[go](${href})`} isBot={true} />);
      const link = container.querySelector('a');
      expect({ href, target: link?.getAttribute('target') }).toEqual({ href, target: '_blank' });
      expect(link?.getAttribute('rel')).toContain('noopener');
    }
  });

  it('collapses a long USER message too, because length is length', () => {
    // `isBot` gated the collapse as well, so a pasted 5,000 character log rendered in full forever
    // while a model reply of the same length got a Show more. Nothing recorded that as a decision.
    const long = 'x'.repeat(MESSAGE_COLLAPSE_THRESHOLD + 200);
    const { container } = render(<CollapsibleText content={long} isBot={false} />);
    expect(container.querySelector('.message-text-toggle')).not.toBeNull();
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
