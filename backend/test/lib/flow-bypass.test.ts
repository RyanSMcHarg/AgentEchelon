/**
 * The Lex-bypass tokens, and the seam that keeps both sides agreeing about them.
 *
 * THE DEFECT THIS PINS. The channel flow claims a turn on a bypass token; the router's guard matches
 * the SAME token on the Lex entry and stands down, so a 2-member channel - where `AUTO` routes every
 * message regardless of mentions - is not answered twice. Each side used to declare its own copy of
 * the patterns, and they drifted: the flow gained `/battle`, the router's guard kept testing `@all`
 * alone, and a `/battle` in a 2-member channel was answered by both entries. Nothing errored; two
 * plausible answers arrived.
 *
 * So the last block is the one that matters most. Pinning the token behaviour alone would not have
 * caught the original bug, because both sides were individually correct about the token they knew
 * about. What was wrong was that there were two definitions at all.
 */

import { stripComments } from '../helpers/strip-comments';
import * as fs from 'fs';
import * as path from 'path';
import {
  flowBypassToken,
  matchesAtAll,
  matchesBattleCommand,
  stripAtAll,
  stripBattleCommand,
  FLOW_BYPASS_TOKENS,
} from '../../lambda/src/lib/flow-bypass';

describe('@all is mention-shaped: matched anywhere, on a word boundary', () => {
  it('matches wherever it appears', () => {
    expect(matchesAtAll('@all what is the billing policy?')).toBe(true);
    expect(matchesAtAll('hey @all, thoughts?')).toBe(true);
  });

  it('does not match a longer word or a bare "all"', () => {
    // Over-matching silences a real turn, which is worse than the duplicate the guard prevents.
    expect(matchesAtAll('@allison can you look')).toBe(false);
    expect(matchesAtAll('tell me all of the billing policies')).toBe(false);
  });

  it('strips every occurrence', () => {
    expect(stripAtAll('@all please review @all')).toBe('please review');
  });

  it('is not stateful across calls', () => {
    // A shared `/g` regex carries lastIndex between callers, so alternating tests silently skip
    // matches. That is the exact class of bug a shared seam must not have.
    expect(matchesAtAll('@all one')).toBe(true);
    expect(matchesAtAll('@all two')).toBe(true);
    expect(stripAtAll('@all a')).toBe('a');
    expect(stripAtAll('@all b')).toBe('b');
  });
});

describe('/battle is a slash command: anchored to the start of the trimmed message', () => {
  it('matches at the start, with or without leading whitespace', () => {
    expect(matchesBattleCommand('/battle compare these plans')).toBe(true);
    expect(matchesBattleCommand('   /battle compare these plans')).toBe(true);
    expect(matchesBattleCommand('/BATTLE shout')).toBe(true);
  });

  it('does NOT match mid-sentence, and that anchoring is load-bearing on both sides', () => {
    // Unanchored, the flow would fan out a duel because someone wrote this - and the router would
    // silence a turn the flow never claimed, leaving NOBODY to answer. That is the worse direction.
    expect(matchesBattleCommand('you should try /battle sometime')).toBe(false);
  });

  it('does not match a longer word', () => {
    expect(matchesBattleCommand('/battlefield report')).toBe(false);
  });

  it('strips only the leading command', () => {
    expect(stripBattleCommand('/battle who wins a /battle')).toBe('who wins a /battle');
  });
});

describe('flowBypassToken: the decision both sides make', () => {
  it('names each token', () => {
    expect(flowBypassToken('@all hello')).toBe('@all');
    expect(flowBypassToken('/battle hello')).toBe('/battle');
    expect(flowBypassToken('an ordinary question')).toBeNull();
  });

  it('lets the command win when a message somehow carries both', () => {
    // Matches the flow's own precedence: a slash command is a process invocation, a mention is
    // addressing. If the two sides disagreed here, one would fan out a duel and the other would not.
    expect(flowBypassToken('/battle ask @all about it')).toBe('/battle');
  });

  it('finds a token in the DECODED form, which is how encoded content matches', () => {
    const raw = encodeURIComponent('@all what is the billing policy?');
    expect(flowBypassToken(raw, decodeURIComponent(raw))).toBe('@all');
    const rawBattle = encodeURIComponent('/battle compare');
    expect(flowBypassToken(rawBattle, decodeURIComponent(rawBattle))).toBe('/battle');
  });

  it('finds a token in the RAW form when the content was never encoded', () => {
    // Both forms are tested because the caller cannot know which one carries the token: an unencoded
    // message matches raw, an encoded one matches decoded.
    expect(flowBypassToken('@all hi', '@all hi')).toBe('@all');
    expect(flowBypassToken('/battle go', '/battle go')).toBe('/battle');
  });

  it('CANNOT see a token that is still percent-encoded — a known, accepted limit', () => {
    // `%40all` is not `@all`, so when `decodeURIComponent` throws on a malformed escape elsewhere in
    // the message and the caller falls back to the raw string, the token is genuinely unmatchable.
    // Both sides fail the SAME way, which is what keeps them agreeing: the flow does not claim the
    // turn and the router does not stand down, so an ordinary Lex turn answers it. One responder,
    // just not the bypass. Pinned so nobody "fixes" one side into disagreeing with the other.
    expect(flowBypassToken('%40all%20hi')).toBeNull();
    expect(flowBypassToken('%2Fbattle%20go')).toBeNull();
  });
});

describe('ONE definition, imported by both sides', () => {
  const SRC = path.join(__dirname, '../../lambda/src');
  const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

  // Ignore comments: the rationale in both files NAMES the tokens, and that prose must not read as a
  // second definition.
  //
  // `/*` must be preceded by whitespace or a line start. Neither file contains an IAM resource glob
  // today, so the naive form happens to be equivalent here - but a glob like `${appInstanceArn}/user/*`
  // ends in `/*`, which the naive pattern reads as a comment opener, silently blanking everything up
  // to the next `*/`. That defeated an identical scan in
  // `handler-send-grant-carries-archive-deny.test.ts` and was only caught by mutation. Matched here so
  // adding one ARN to either file cannot quietly turn this guard off.
  const codeOnly = (src: string) =>
    stripComments(src);

  it.each([
    ['channel-flow-processor.ts'],
    ['router-agent-handler.ts'],
  ])('%s declares no bypass-token pattern of its own', (file) => {
    const code = codeOnly(read(file));
    // Any regex literal mentioning either token is a second definition, which is how they drifted.
    expect(code).not.toMatch(/\/[^/\n]*@all[^/\n]*\/[gimsuy]*/);
    expect(code).not.toMatch(/\/[^\n]*\\\/battle[^\n]*\/[gimsuy]*/);
  });

  it.each([
    ['channel-flow-processor.ts'],
    ['router-agent-handler.ts'],
  ])('%s imports the shared module', (file) => {
    expect(codeOnly(read(file))).toMatch(/from '\.\/lib\/flow-bypass\.js'/);
  });

  it('the router stands down for EVERY token the flow can claim', () => {
    // The original bug in one assertion: the flow had two bypasses and the guard knew one. Both sides
    // now read this list, so it is the list itself that has to stay complete.
    expect([...FLOW_BYPASS_TOKENS].sort()).toEqual(['/battle', '@all']);
    for (const token of FLOW_BYPASS_TOKENS) {
      expect(flowBypassToken(`${token} do the thing`)).toBe(token);
    }
  });
});
