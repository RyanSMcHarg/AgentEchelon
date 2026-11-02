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
 * So the last block is the one that matters most. Pinning the token behavior alone would not have
 * caught the original bug, because both sides were individually correct about the token they knew
 * about. What was wrong was that there were two definitions at all.
 */

import { stripComments } from '../helpers/strip-comments';
import * as fs from 'fs';
import * as path from 'path';
import {
  flowBypassToken,
  flowOwnsTheTurn,
  matchesAtAll,
  matchesBattleCommand,
  matchesStopCommand,
  mightMentionSomeone,
  stripAtAll,
  stripBattleCommand,
  stripMentionOf,
  FLOW_BYPASS_TOKENS,
  CHAT_COMMANDS,
} from '../../lambda/src/lib/flow-bypass';

/**
 * THE PREFILTER THAT KEEPS ROUTING EVERY `@` AFFORDABLE (ADR-034).
 *
 * Resolving `@<member>` needs the channel roster, and reading the roster is an Amazon Chime SDK call
 * on the request path. This is what decides whether that call happens at all, so its two failure
 * directions are asymmetric and deliberate: a false yes costs one read that resolves to nobody, and a
 * false no costs a mention that silently addresses no one.
 */
describe('could this text mention somebody at all', () => {
  it('says yes to an @ at a word boundary, wherever it appears', () => {
    expect(mightMentionSomeone('@Atlas what is the deploy order')).toBe(true);
    expect(mightMentionSomeone('could you ask @Alice about it')).toBe(true);
    expect(mightMentionSomeone('@all heads up')).toBe(true);
  });

  it('says no to an ordinary message, which is the overwhelming majority of traffic', () => {
    expect(mightMentionSomeone('sounds good to me')).toBe(false);
    expect(mightMentionSomeone('')).toBe(false);
  });

  it('says no to an email address, so quoting one does not read the roster', () => {
    // `@` mid-word is not a mention in any chat client, and a deployment where every message quoting
    // an address pays a membership read is the cost this boundary exists to avoid.
    expect(mightMentionSomeone('reach me at name@example.com')).toBe(false);
  });

  it('says no to a bare @ with nothing after it', () => {
    expect(mightMentionSomeone('meet @ 3pm')).toBe(false);
    expect(mightMentionSomeone('what does @ mean here')).toBe(false);
  });

  it('says yes to a name that is not ASCII, because most of the world has one', () => {
    // This tested `[A-Za-z0-9]`. A no is not a cheap miss: the roster is never read, the resolver
    // never runs, and the flow's "an @ token named nobody" warning is gated on this too - so the
    // member is ignored in front of the room and nothing anywhere records it (tenet D11).
    expect(mightMentionSomeone('@Élise please look')).toBe(true);
    expect(mightMentionSomeone('@Даша can you check')).toBe(true);
    expect(mightMentionSomeone('@佐藤 thoughts?')).toBe(true);
  });

  it('OVER-matches rather than under-matches, and that is the chosen direction', () => {
    // `@5pm` is not a name, and resolving it costs one read that finds nobody. Missing a real mention
    // costs a person being ignored in front of the room, with no error anywhere.
    expect(mightMentionSomeone('lets meet @5pm')).toBe(true);
  });
});

/**
 * REMOVING THE ADDRESS FROM THE REQUEST.
 *
 * A mention is address, not content. "@Atlas what is the deploy order" asks about the deploy order,
 * and handing the model the token makes the assistant's own name part of the question it answers.
 */
describe('stripping the mention that was resolved', () => {
  const atlas = { arn: 'arn:bot:atlas', name: 'Atlas', isBot: true };

  it('removes the token and leaves the sentence', () => {
    expect(stripMentionOf('@Atlas what is the deploy order?', atlas)).toBe('what is the deploy order?');
  });

  it('keeps a mention of somebody ELSE, because that clause is the request', () => {
    expect(stripMentionOf('@Atlas could you ask @Bob about it', atlas)).toBe('could you ask @Bob about it');
  });

  it('removes the token mid-sentence too, and does not leave a double space behind it', () => {
    expect(stripMentionOf('so I asked @Atlas about the rollout', atlas)).toBe('so I asked about the rollout');
  });

  it('is case-insensitive, because a name is not a password', () => {
    expect(stripMentionOf('@ATLAS hello', atlas)).toBe('hello');
  });

  it('does not strip a name that merely starts another word', () => {
    expect(stripMentionOf('@Atlases are maps', atlas)).toBe('@Atlases are maps');
  });

  it('treats a name with regex punctuation as text, not as a pattern', () => {
    // A member name is user-controlled and arrives from the channel roster. Unescaped, `A.x` would
    // match `Abx` and strip words the person actually wrote.
    const odd = { arn: 'arn:user:odd', name: 'A.x', isBot: false };
    expect(stripMentionOf('@A.x hello', odd)).toBe('hello');
    expect(stripMentionOf('@Abx hello', odd)).toBe('@Abx hello');
  });

  it('strips a name that ends in punctuation, which the resolver accepts', () => {
    // `\b` after an escaped "Dr." asks for a word character following the dot, so the pattern matched
    // nothing while the resolver matched happily: the address reached the model as part of the
    // question, which is the one thing this function exists to prevent.
    const doc = { arn: 'arn:user:doc', name: 'Dr.', isBot: false };
    expect(stripMentionOf('@Dr. what is the dosage', doc)).toBe('what is the dosage');
  });

  it('keeps the newlines and the indentation of what was pasted', () => {
    // A blanket `\s{2,} -> ' '` collapse flattened the WHOLE message, not just the gap the token
    // left: a pasted code block reached the model as one line with its indentation gone, so the
    // message answered was not the message sent. `stripAtAll`, the sibling path for the same kind of
    // turn, never did this.
    const pasted = '@Atlas please review:\n\n```js\nconst x = 1;\n  const y = 2;\n```';
    const out = stripMentionOf(pasted, atlas);
    expect(out).toBe('please review:\n\n```js\nconst x = 1;\n  const y = 2;\n```');
  });

  it('leaves an email address alone, matching the boundary the resolver uses', () => {
    expect(stripMentionOf('mail ops@atlas.com about it', atlas)).toBe('mail ops@atlas.com about it');
  });

  it('returns the text unchanged for a nameless member rather than stripping a bare @', () => {
    expect(stripMentionOf('@ hello', { arn: 'arn:user:ghost', name: '', isBot: false })).toBe('@ hello');
  });
});

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

describe('/stop is a slash command, and the whole message or nothing', () => {
  it('matches a bare stop, with surrounding whitespace and in any case', () => {
    expect(matchesStopCommand('/stop')).toBe(true);
    expect(matchesStopCommand('  /stop  ')).toBe(true);
    expect(matchesStopCommand('/STOP')).toBe(true);
  });

  it('does NOT match a redirect, which belongs on the judged path', () => {
    // `parseStopCommand` draws exactly this line for the router. If the two disagreed, the flow would
    // claim a turn the router then declined to treat as a stop, and nobody would answer it.
    expect(matchesStopCommand('/stop the report and summarise it instead')).toBe(false);
    expect(matchesStopCommand('you should /stop')).toBe(false);
    expect(matchesStopCommand('/stopwatch')).toBe(false);
  });
});

describe('who owns a bare /stop, which is a question about the SIZE of the room', () => {
  const atlas = { arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/atlas', name: 'Atlas', isBot: true };
  const alice = { arn: 'arn:aws:chime:us-east-1:1:app-instance/i/user/alice', name: 'Alice', isBot: false };
  const members = [atlas, alice];

  it('the flow owns it in a room, because AUTO routes nothing unaddressed there', () => {
    // The defect this fixes: before, nothing claimed it. The message was persisted, the room read it,
    // and no assistant acted - so the person watched the assistant keep working after saying stop.
    expect(flowOwnsTheTurn({ text: '/stop', members, isOneToOne: false })).toBe(true);
  });

  it('the flow claims a 1:1 stop by default, and stands aside only for an explicit lex entry', () => {
    // WHY IT USED TO STAND ASIDE, kept because the hazard is real whenever a second entry exists:
    // claiming it alongside an invoked Amazon Lex entry hands a live-verified path
    // (`turn-queue.spec.ts`) to two entries and produces two acknowledgments for one stop.
    //
    // `turnEntry` now defaults to `'flow'`, so `StandardMessages: NONE` means no Lex entry is invoked
    // for this message and standing aside would acknowledge nothing at all. The old answer is still
    // the right one for a profile that explicitly asks for `'lex'`, so both are pinned here rather
    // than one replacing the other.
    expect(flowOwnsTheTurn({ text: '/stop', members, isOneToOne: true })).toBe(true);
  });

  it('the flow never claims a PRIVATE stop, which the router refuses instead', () => {
    // Claiming it would route a private stop into a broadcast turn and stop the
    // assistant for a room that never saw the request.
    expect(flowOwnsTheTurn({ text: '.Atlas /stop', members, isOneToOne: false })).toBe(false);
  });

  it('a redirect is not claimed at any size, so nothing takes a turn the router will not stop', () => {
    expect(flowOwnsTheTurn({ text: '/stop the report instead', members, isOneToOne: false })).toBe(false);
  });

  it('an addressed stop is still claimed, by the mention rather than by the command', () => {
    // `@Atlas /stop` is not a bare stop; it is a mention, and the mention branch strips the address
    // and dispatches the remainder - so the router sees the same `/stop` either way.
    expect(flowOwnsTheTurn({ text: '@Atlas /stop', members, isOneToOne: false })).toBe(true);
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
    // `/stop` gets the same guard as `/battle`. A second pattern for it in either caller is how the
    // first two drifted, and a new token is exactly when that mistake is available again.
    expect(code).not.toMatch(/\/[^\n]*\\\/stop[^\n]*\/[gimsuy]*/);
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
    expect([...FLOW_BYPASS_TOKENS].sort()).toEqual(['/battle', '/stop', '@all']);

    // EVERY TOKEN IS RECOGNIZED, AND EACH ONE'S MATCH SHAPE IS READ FROM ITS DECLARATION rather than
    // from a list here. A `prefix` command claims a message that carries it and goes on to say
    // something else; a `whole` command is the entire message or it is not the command at all. Both
    // shapes are exercised, so a new entry is covered by this test the moment it is declared.
    for (const token of FLOW_BYPASS_TOKENS) {
      expect(flowBypassToken(token)).toBe(token);
    }
    for (const command of CHAT_COMMANDS) {
      const withArgument = `${command.token} do the thing`;
      expect({ token: command.token, claimed: flowBypassToken(withArgument) === command.token })
        .toEqual({ token: command.token, claimed: command.match === 'prefix' });
    }
    // `@all` is mention-shaped, so it claims a message that says more - the one non-command token.
    expect(flowBypassToken('@all do the thing')).toBe('@all');

    // And the exclusion that matters, stated rather than implied: a redirect is not the escape hatch.
    expect(flowBypassToken('/stop the report and summarise it instead')).toBeNull();
  });

  it('an unknown slash token is NOT a command, so it starts no turn nobody asked for', () => {
    // The decision behind the registry. Treating any leading slash as a command would route "/tmp is
    // full", a pasted path, or a typo to an assistant in a room where an unaddressed message reaches
    // nobody today - the same over-match `mightMentionSomeone` and the `.` prefix both refuse.
    expect(flowBypassToken('/foo')).toBeNull();
    expect(flowBypassToken('/tmp is full')).toBeNull();
    expect(flowBypassToken('/usr/bin/env is the portable form')).toBeNull();
  });
});
