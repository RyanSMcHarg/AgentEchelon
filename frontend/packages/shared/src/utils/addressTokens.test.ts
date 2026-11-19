import { describe, it, expect } from 'vitest';
import { codeSpans, encodeAddressTokens, insideCode, memberNameResolver, readableAddressText, shownAssistantText } from './addressTokens';

describe('readableAddressText', () => {
  it('shows a mention by name, with no id, pipe or brackets', () => {
    expect(readableAddressText('ask @<Alice|alice-sub> today')).toBe('ask @Alice today');
  });

  it('shows a name with spaces whole', () => {
    expect(readableAddressText('ask @<Ryan McHarg|ryan-sub>, please')).toBe('ask @Ryan McHarg, please');
  });

  it('shows a private address by name, keeping a leading /md', () => {
    expect(readableAddressText('.<Alice|alice-sub> hi')).toBe('.Alice hi');
    expect(readableAddressText('/md .<Alice|alice-sub> **hi**')).toBe('/md .Alice **hi**');
  });

  it('reads a private address only at the start, so a dot inside a sentence is text', () => {
    expect(readableAddressText('see file.<Alice|a> later')).toBe('see file.<Alice|a> later');
  });

  it('uses the member\'s current name when the id resolves, else the token\'s name', () => {
    const resolve = memberNameResolver([
      { userArn: 'arn:aws:chime:r:1:app-instance/i/user/alice-sub', name: 'Alice Cooper' },
    ]);
    expect(readableAddressText('@<Alice|alice-sub> and @<Bob|bob-sub>', resolve)).toBe('@Alice Cooper and @Bob');
  });

  it('leaves text with no token unchanged', () => {
    expect(readableAddressText('@Sam and .net and a <b>tag</b>')).toBe('@Sam and .net and a <b>tag</b>');
  });

  it('splits on the last pipe, as the server does', () => {
    expect(readableAddressText('@<A|B|sub-1>')).toBe('@A|B');
  });
});

describe('encodeAddressTokens', () => {
  it('replaces each token with a placeholder and keeps the tokens in order', () => {
    const { text, tokens } = encodeAddressTokens('.<Alice|a> cc @<Bob Smith|b> and @<Carol>');
    expect(text).toBe('0 cc 1 and 2');
    expect(tokens).toEqual([
      { kind: 'address', name: 'Alice', id: 'a' },
      { kind: 'mention', name: 'Bob Smith', id: 'b' },
      { kind: 'mention', name: 'Carol' },
    ]);
  });

  it('given the members, encodes a typed @Name of any member, the longest name winning at one position', () => {
    const members = [
      { userArn: 'arn:aws:chime:r:1:app-instance/i/bot/advisor', name: 'Advisor' },
      { userArn: 'arn:aws:chime:r:1:app-instance/i/bot/advisor-alt', name: 'Advisor (alt)' },
      { userArn: 'arn:aws:chime:r:1:app-instance/i/bot/ops-premium', name: 'Ops' },
    ];
    const { tokens } = encodeAddressTokens('@<Advisor|advisor> then @ops and @Advisor (alt) but not a@Ops', members);
    expect(tokens).toEqual([
      { kind: 'mention', name: 'Advisor', id: 'advisor' },
      { kind: 'mention', name: 'Ops', id: 'ops-premium' },
      { kind: 'mention', name: 'Advisor (alt)', id: 'advisor-alt' },
    ]);
  });

  it('without the members, leaves a typed @Name as text', () => {
    expect(encodeAddressTokens('@Ops hi', []).tokens).toEqual([]);
    expect(encodeAddressTokens('@Ops hi').text).toBe('@Ops hi');
  });
});

describe('a typed @Name inside code is the code, not a mention', () => {
  const members = [
    { userArn: 'arn:aws:chime:r:1:app-instance/i/user/alice-id', name: 'Alice' },
    { userArn: 'arn:aws:chime:r:1:app-instance/i/bot/ops', name: 'Ops' },
  ];

  it('leaves @Name inside an inline code span as written, and still reads one outside it', () => {
    const { text, tokens } = encodeAddressTokens('run `git blame @Alice` then ask @Ops', members);
    expect(text).toContain('`git blame @Alice`');
    expect(tokens).toEqual([{ kind: 'mention', name: 'Ops', id: 'ops' }]);
  });

  it('leaves @Name inside a fenced block as written, whether the fence closes or runs to the end', () => {
    const closed = encodeAddressTokens('@Alice see:\n```\ncc @Ops\n```\nand @Ops', members);
    expect(closed.text).toContain('```\ncc @Ops\n```');
    expect(closed.tokens.map((t) => t.name)).toEqual(['Alice', 'Ops']);
    const open = encodeAddressTokens('see:\n~~~\n@Alice\n@Ops', members);
    expect(open.tokens).toEqual([]);
  });

  it('a double-backtick span holds a single backtick, and an unclosed backtick opens nothing', () => {
    expect(encodeAddressTokens('``a ` @Alice`` @Ops', members).tokens.map((t) => t.name)).toEqual(['Ops']);
    expect(encodeAddressTokens('it`s @Alice', members).tokens.map((t) => t.name)).toEqual(['Alice']);
  });

  it('codeSpans covers the delimiters', () => {
    expect(codeSpans('a `b` c')).toEqual([[2, 5]]);
    expect(codeSpans('x\n```\ny\n```')).toEqual([[2, 11]]);
    expect(codeSpans('no code here')).toEqual([]);
  });
});

describe('the bare-mention scan reads the member list once per list', () => {
  it('builds the sorted list once for one member array, however many messages are read', () => {
    let reads = 0;
    const member = { userArn: 'arn:aws:chime:r:1:app-instance/i/user/alice-id', get name() { reads += 1; return 'Alice'; } };
    const members = [member];
    encodeAddressTokens('hi @Alice', members);
    const afterFirst = reads;
    encodeAddressTokens('again @Alice', members);
    encodeAddressTokens('and @Alice', members);
    expect(reads).toBe(afterFirst);
  });

  it('a message with no @ never reads the member list', () => {
    let reads = 0;
    const members = [{ userArn: 'arn:aws:chime:r:1:app-instance/i/user/b', get name() { reads += 1; return 'Bob'; } }];
    expect(encodeAddressTokens('plain words', members).tokens).toEqual([]);
    expect(reads).toBe(0);
  });
});

describe("an assistant's leading @humans", () => {
  it('is not shown, with the punctuation and space after it', () => {
    expect(shownAssistantText('@humans The deploy finished.')).toBe('The deploy finished.');
    expect(shownAssistantText('  @Humans, heads up')).toBe('heads up');
  });

  it('is only the address at the front, and only the whole word', () => {
    expect(shownAssistantText('Ask @humans later')).toBe('Ask @humans later');
    expect(shownAssistantText('@humans-team owns this')).toBe('@humans-team owns this');
    expect(shownAssistantText('@humans_ops owns this')).toBe('@humans_ops owns this');
    expect(shownAssistantText('@humansé x')).toBe('@humansé x');
  });
});

describe('insideCode', () => {
  it('is true inside a closed span, inside a block, and after a backtick nothing has closed yet', () => {
    expect(insideCode('a `b @c` d', 5)).toBe(true);
    expect(insideCode('```\n@x', 4)).toBe(true);
    expect(insideCode('run `git @Al', 9)).toBe(true);
  });
  it('is false outside code', () => {
    expect(insideCode('`a` @Al', 4)).toBe(false);
    expect(insideCode('hello @Al', 6)).toBe(false);
  });
});
