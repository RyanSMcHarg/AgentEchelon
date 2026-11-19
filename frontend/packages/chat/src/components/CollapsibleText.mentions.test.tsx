/**
 * A mention and a private address read as a styled chip by name, in every way a message body renders.
 *
 * The stored message carries `@<Name|id>` and `.<Name|id>`: the id is for the server, which resolves
 * the member by it. A reader sees `@Name` or `.Name` as a chip, and never the id, the pipe or the
 * angle brackets, whether the body is plain text, `/md` markdown, an assistant reply, collapsed or
 * expanded.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: { name?: string }) => (key === 'message.privateAddressTitle' ? `Private to ${o?.name}` : key),
  }),
}));

import { CollapsibleText, MESSAGE_COLLAPSE_THRESHOLD } from './CollapsibleText';
import { memberNameResolver } from '@ae/shared/utils/addressTokens.ts';

const chips = (container: HTMLElement) => Array.from(container.querySelectorAll('.message-address-chip'));

function expectNoId(container: HTMLElement, id: string) {
  expect(container.textContent).not.toContain(id);
  expect(container.textContent).not.toContain('|');
  expect(container.textContent).not.toMatch(/[<>]/);
  expect(container.innerHTML).not.toContain(id);
}

describe('a mention in a message body', () => {
  it('renders a styled @Name chip in a person\'s plain message', () => {
    const { container } = render(<CollapsibleText content="hey @<Alice|alice-sub-123> can you look" isBot={false} />);
    const [chip] = chips(container);
    expect(chip.textContent).toBe('@Alice');
    expect(chip.classList.contains('message-address-chip--mention')).toBe(true);
    expect(container.textContent).toBe('hey @Alice can you look');
    expectNoId(container, 'alice-sub-123');
  });

  it('renders the chip in a person\'s /md message', () => {
    const { container } = render(<CollapsibleText content="/md **look** @<Alice|alice-sub-123>" isBot={false} />);
    expect(container.querySelector('strong')?.textContent).toBe('look');
    expect(chips(container).map((c) => c.textContent)).toEqual(['@Alice']);
    expectNoId(container, 'alice-sub-123');
  });

  it('renders the chip in an assistant reply, and a name markdown would read stays a name', () => {
    const { container } = render(
      <CollapsibleText content={'Thanks @<Ryan McHarg|ryan-sub>, and @<snake_case_name_|s-2> too.\n\n- @<Alice|alice-sub-123> owns it'} isBot={true} />,
    );
    expect(chips(container).map((c) => c.textContent)).toEqual(['@Ryan McHarg', '@snake_case_name_', '@Alice']);
    expect(container.querySelector('li .message-address-chip')?.textContent).toBe('@Alice');
    expectNoId(container, 'ryan-sub');
    expectNoId(container, 'alice-sub-123');
  });

  it('shows the plain name inside code, where a chip cannot go', () => {
    const { container } = render(<CollapsibleText content="run `ping @<Alice|alice-sub-123>`" isBot={true} />);
    expect(container.querySelector('code')?.textContent).toBe('ping @Alice');
    expectNoId(container, 'alice-sub-123');
  });

  it('renders the chip collapsed and expanded, and a cut never shows a partial token', () => {
    const long = `@<Alice|alice-sub-123> ${'word '.repeat(MESSAGE_COLLAPSE_THRESHOLD / 5)} end @<Bob|bob-sub>`;
    const { container, getByRole } = render(<CollapsibleText content={long} isBot={false} />);
    expect(chips(container).map((c) => c.textContent)).toEqual(['@Alice']);
    expectNoId(container, 'alice-sub-123');
    expect(container.textContent).not.toMatch(/[]/);

    fireEvent.click(getByRole('button'));
    expect(chips(container).map((c) => c.textContent)).toEqual(['@Alice', '@Bob']);
    expectNoId(container, 'bob-sub');
  });

  it('drops a placeholder the collapse cut through', () => {
    // No space in the back half of the window, so the cut is hard and lands inside the second token.
    const head = 'x'.repeat(MESSAGE_COLLAPSE_THRESHOLD - 2);
    const { container } = render(<CollapsibleText content={`${head}@<Alice|alice-sub-123> tail`} isBot={false} />);
    expect(container.textContent).not.toMatch(/[]|\d/);
    expectNoId(container, 'alice-sub-123');
  });

  it('shows the member\'s current name when the id resolves, and the token\'s name when it does not', () => {
    const resolveName = memberNameResolver([
      { userArn: 'arn:aws:chime:us-east-1:1:app-instance/i/user/alice-sub-123', name: 'Alice Cooper' },
    ]);
    const { container } = render(
      <CollapsibleText content="@<Alice|alice-sub-123> and @<Bob|unknown-id>" isBot={false} resolveName={resolveName} />,
    );
    expect(chips(container).map((c) => c.textContent)).toEqual(['@Alice Cooper', '@Bob']);
    expectNoId(container, 'unknown-id');
  });
});

describe('a typed @Name of a member', () => {
  const INSTANCE = 'arn:aws:chime:us-east-1:1:app-instance/i';
  // An incident room: two assistants of one classification, the room's primary and a second one,
  // and people.
  const ROOM = [
    { userArn: `${INSTANCE}/bot/advisor-premium`, name: 'Advisor', isBot: true },
    { userArn: `${INSTANCE}/bot/ops-premium`, name: 'Ops', isBot: true },
    { userArn: `${INSTANCE}/user/alice-sub`, name: 'Alice', isBot: false },
  ];

  it('is a chip for the second assistant of a room, as for the primary and a person', () => {
    const { container } = render(<CollapsibleText content="@Ops which alarms are firing?" isBot={false} members={ROOM} />);
    const [chip] = chips(container);
    expect(chip?.textContent).toBe('@Ops');
    expect(chip.classList.contains('message-address-chip--mention')).toBe(true);
    expect(container.textContent).toBe('@Ops which alarms are firing?');

    const both = render(<CollapsibleText content="@advisor and @Alice, then @Ops." isBot={false} members={ROOM} />);
    expect(chips(both.container).map((c) => c.textContent)).toEqual(['@Advisor', '@Alice', '@Ops']);
  });

  it('is a chip in an assistant reply too', () => {
    const { container } = render(<CollapsibleText content={'Handing this to @Ops now.\n\n- @Alice owns it'} isBot={true} members={ROOM} />);
    expect(chips(container).map((c) => c.textContent)).toEqual(['@Ops', '@Alice']);
  });

  it('stays text when it names nobody here or the name runs on', () => {
    const { container } = render(
      <CollapsibleText content="@Opsy and @Ops-team and mail ops@Ops.com and @Bob" isBot={false} members={ROOM} />,
    );
    expect(chips(container)).toHaveLength(0);
    expect(container.textContent).toBe('@Opsy and @Ops-team and mail ops@Ops.com and @Bob');
  });

  it('stays code inside code: an inline span and a fenced block show it exactly as written', () => {
    const { container } = render(
      <CollapsibleText content={'Run `notify @ops` then ask @Alice.\n\n```\n@advisor restart\n```'} isBot={true} members={ROOM} />,
    );
    expect(chips(container).map((c) => c.textContent)).toEqual(['@Alice']);
    const code = Array.from(container.querySelectorAll('code')).map((c) => c.textContent);
    expect(code).toContain('notify @ops');
    expect(code.some((t) => t?.includes('@advisor restart'))).toBe(true);
  });
});

describe('a private address in a message body', () => {
  it('renders a styled .Name chip that names who the message is private to', () => {
    const { container } = render(<CollapsibleText content=".<Alice|alice-sub-123> can you check this" isBot={false} />);
    const [chip] = chips(container);
    expect(chip.textContent).toBe('.Alice');
    expect(chip.classList.contains('message-address-chip--address')).toBe(true);
    expect(chip.getAttribute('title')).toBe('Private to Alice');
    expect(container.textContent).toBe('.Alice can you check this');
    expectNoId(container, 'alice-sub-123');
  });

  it('renders it in a /md message, after the command is removed', () => {
    const { container } = render(<CollapsibleText content="/md .<Ryan McHarg|ryan-sub> **hi**" isBot={false} />);
    expect(chips(container).map((c) => c.textContent)).toEqual(['.Ryan McHarg']);
    expect(container.textContent).not.toContain('/md');
    expectNoId(container, 'ryan-sub');
  });
});

describe('the stored message', () => {
  it('is not changed by rendering it', () => {
    const content = '.<Alice|alice-sub-123> @<Bob|bob-sub> hi';
    const message = { content };
    render(<CollapsibleText content={message.content} isBot={false} />);
    expect(message.content).toBe('.<Alice|alice-sub-123> @<Bob|bob-sub> hi');
  });
});
