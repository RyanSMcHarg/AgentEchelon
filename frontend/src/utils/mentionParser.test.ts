import { describe, it, expect } from 'vitest';
import { parseMentions, mentionValidationMessage } from './mentionParser';
import type { ChannelMember } from '../types';

const me: ChannelMember = { userArn: 'arn:user:me', name: 'Me', isBot: false };
const bot: ChannelMember = { userArn: 'arn:bot:assistant', name: 'assistant', isBot: true };
const atlas: ChannelMember = { userArn: 'arn:bot:atlas', name: 'Atlas', isBot: true };
const alice: ChannelMember = { userArn: 'arn:user:alice', name: 'Alice', isBot: false };
const bob: ChannelMember = { userArn: 'arn:user:bob', name: 'Bob', isBot: false };

const members = [me, bot, alice, bob];

describe('parseMentions', () => {
  it('returns no mentions for plain text', () => {
    const r = parseMentions('hello there', members, me.userArn);
    expect(r).toEqual({ isAtAll: false, mentionedArns: [] });
  });

  it('detects @all and skips Target/mention', () => {
    const r = parseMentions('@all heads up', members, me.userArn);
    expect(r.isAtAll).toBe(true);
    expect(r.targetArn).toBeUndefined();
    expect(r.mentionBotArn).toBeUndefined();
  });

  it('detects @everyone as @all', () => {
    const r = parseMentions('@everyone please review', members, me.userArn);
    expect(r.isAtAll).toBe(true);
  });

  it('targets the bot and sets CHIME.mentions when @assistant alone', () => {
    const r = parseMentions('@assistant can you help', members, me.userArn);
    expect(r.targetArn).toBe(bot.userArn);
    expect(r.mentionBotArn).toBe(bot.userArn);
    expect(r.isAtAll).toBe(false);
  });

  it('targets the human and skips CHIME.mentions when only a human is mentioned', () => {
    const r = parseMentions('@Alice quick question', members, me.userArn);
    expect(r.targetArn).toBe(alice.userArn);
    expect(r.mentionBotArn).toBeUndefined();
  });

  it('targets the human and sets CHIME.mentions when both are mentioned (assistant first in text)', () => {
    const r = parseMentions('@assistant @Alice please review', members, me.userArn);
    expect(r.targetArn).toBe(alice.userArn);
    expect(r.mentionBotArn).toBe(bot.userArn);
  });

  it('targets the human and sets CHIME.mentions when both are mentioned (human first in text)', () => {
    const r = parseMentions('@Alice can you ping @assistant for me', members, me.userArn);
    expect(r.targetArn).toBe(alice.userArn);
    expect(r.mentionBotArn).toBe(bot.userArn);
  });

  it('ignores the current user in mention detection', () => {
    const r = parseMentions('@Me hello', members, me.userArn);
    expect(r).toEqual({ isAtAll: false, mentionedArns: [] });
  });

  it('only matches whole-name boundaries — @ass does not match assistant', () => {
    const r = parseMentions('@ass hi', members, me.userArn);
    expect(r.targetArn).toBeUndefined();
    expect(r.mentionBotArn).toBeUndefined();
  });

  it('case-insensitive mention matching', () => {
    const r = parseMentions('hey @ALICE', members, me.userArn);
    expect(r.targetArn).toBe(alice.userArn);
  });
});

// Chime SDK SendChannelMessage.Target is fixed at 1 item by the AWS API
// (TS type is Target[] but the docs say "Array Members: Fixed number of 1
// item."). The parser
// enforces single-target-or-@all by returning an error rather than
// silently dropping the extras and shipping a half-targeted message.
describe('parseMentions — Target=1 enforcement', () => {
  it('flags multiple distinct human mentions as multiple_humans', () => {
    const r = parseMentions('@Bob and @Alice take a look', members, me.userArn);
    expect(r.error).toBe('multiple_humans');
    expect(r.targetArn).toBeUndefined();
    expect(r.mentionBotArn).toBeUndefined();
    // Still surface every match so the UI can highlight what to remove.
    expect(r.mentionedArns).toEqual([bob.userArn, alice.userArn]);
  });

  it('flags multiple distinct bot mentions as multiple_bots', () => {
    const r = parseMentions('@assistant @Atlas weigh in', [me, bot, atlas], me.userArn);
    expect(r.error).toBe('multiple_bots');
    expect(r.targetArn).toBeUndefined();
    expect(r.mentionBotArn).toBeUndefined();
  });

  it('flags @all combined with an explicit @-mention as all_with_member', () => {
    const r = parseMentions('@all @Alice heads up', members, me.userArn);
    expect(r.error).toBe('all_with_member');
    expect(r.isAtAll).toBe(true); // @all was present
    expect(r.targetArn).toBeUndefined();
    expect(r.mentionBotArn).toBeUndefined();
  });

  it('flags @all combined with a bot mention as all_with_member', () => {
    const r = parseMentions('@all @assistant ping me', members, me.userArn);
    expect(r.error).toBe('all_with_member');
  });

  it('still permits one human + one bot — that is a single Target plus AUTO routing', () => {
    const r = parseMentions('@Alice @assistant please', members, me.userArn);
    expect(r.error).toBeUndefined();
    expect(r.targetArn).toBe(alice.userArn);
    expect(r.mentionBotArn).toBe(bot.userArn);
  });

  it('still permits a bare @all on its own', () => {
    const r = parseMentions('@all standup in 5', members, me.userArn);
    expect(r.error).toBeUndefined();
    expect(r.isAtAll).toBe(true);
  });
});

describe('mentionValidationMessage', () => {
  it('returns a distinct human-readable message for each error code', () => {
    const a = mentionValidationMessage('multiple_humans');
    const b = mentionValidationMessage('multiple_bots');
    const c = mentionValidationMessage('all_with_member');
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(c.length).toBeGreaterThan(0);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
