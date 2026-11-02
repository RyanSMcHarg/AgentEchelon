import { describe, it, expect } from 'vitest';
import { parseMentions, mentionValidationMessage, privatePrefixToken, withPrivateAddressDisplayed, withMentionNamesDisplayed, mentionTokenFor } from './mentionParser';
import type { ChannelMember } from '@ae/shared';

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

  it('addresses the assistant WITHOUT hiding the message (ADR-034)', () => {
    const r = parseMentions('@assistant can you help', members, me.userArn);
    // No Target. Naming the assistant used to conceal the exchange from the rest of the room, which
    // is the conflation ADR-034 removes: @ addresses, . makes private.
    expect(r.targetArn).toBeUndefined();
    expect(r.mentionBotArn).toBe(bot.userArn);
    expect(r.isAtAll).toBe(false);
  });

  it('addresses a person in public - the case that was not expressible before', () => {
    // "Alice, can you confirm the Q3 figure?" is addressed to Alice and is nobody's secret. The
    // rest of the room is meant to see that she was asked.
    const r = parseMentions('@Alice quick question', members, me.userArn);
    expect(r.targetArn).toBeUndefined();
    expect(r.mentionedArns).toEqual([alice.userArn]);
    expect(r.mentionBotArn).toBeUndefined();
  });

  it('targets the human and sets CHIME.mentions when both are mentioned (assistant first in text)', () => {
    const r = parseMentions('@assistant @Alice please review', members, me.userArn);
    expect(r.targetArn).toBeUndefined();
    expect(r.mentionBotArn).toBe(bot.userArn);
  });

  it('targets the human and sets CHIME.mentions when both are mentioned (human first in text)', () => {
    const r = parseMentions('@Alice can you ping @assistant for me', members, me.userArn);
    expect(r.targetArn).toBeUndefined();
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
    expect(r.mentionedArns).toEqual([alice.userArn]);
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

  it('still permits one human + one bot, now with neither concealed', () => {
    const r = parseMentions('@Alice @assistant please', members, me.userArn);
    expect(r.error).toBeUndefined();
    expect(r.targetArn).toBeUndefined();
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

/**
 * THE PRIVATE PREFIX (ADR-034).
 *
 * `.member` addresses one member privately WITHOUT leaving the conversation, so the history, the
 * work in flight and the grounding are all still there. It is the only thing that sets a `Target`,
 * because privacy is enforced by Amazon Chime SDK before delivery and a client-side rule would be a
 * disclosure rather than a weaker version of the same guarantee.
 *
 * The asymmetry these tests exist for: a message meant for the room that reaches one person is
 * recoverable, and a message meant for one person that reaches the room cannot be taken back. So
 * every ambiguous case here refuses rather than sending.
 */
describe('the private prefix', () => {
  it('sets the Target, and names who it decorates for', () => {
    const r = parseMentions('.Alice are you free', members, me.userArn);
    expect(r.error).toBeUndefined();
    expect(r.targetArn).toBe(alice.userArn);
    expect(r.privateToArn).toBe(alice.userArn);
    expect(r.privateToName).toBe(alice.name);
  });

  it('addresses an assistant privately too', () => {
    const r = parseMentions('.assistant draft me a reply', members, me.userArn);
    expect(r.targetArn).toBe(bot.userArn);
    expect(r.privateToName).toBe(bot.name);
  });

  it('applies NO target for a token that names nobody here, and does not refuse the message', () => {
    // THE RULE: a dot applies a Target only when it is followed by the full name
    // of an actual member. Anything else is ordinary text.
    //
    // This used to return `private_unresolved` and BLOCK the send, which cost more than it protected:
    // the regex matches far more than names, so ".env is missing" and ".gitignore needs a line" were
    // unsendable in any room where people discuss code. What still guards the expensive direction is
    // that privacy is never inferred from a near miss, and that the composer decorates only when the
    // token resolves - a person typing `.Carol` when Carol is not here sees no "Private to" chip.
    const r = parseMentions('.Carol are you free', members, me.userArn);
    expect(r.error).toBeUndefined();
    expect(r.targetArn).toBeUndefined();
    expect(r.privateToArn).toBeUndefined();
  });

  it('sends an ordinary sentence that begins with a dot, exactly as written', () => {
    for (const text of ['.env is missing', '.gitignore needs a line', '...ok then', '.5s is fine']) {
      const r = parseMentions(text, members, me.userArn);
      expect({ text, error: r.error, targetArn: r.targetArn })
        .toEqual({ text, error: undefined, targetArn: undefined });
    }
  });

  it('requires the FULL name, so a prefix of a members name addresses nobody', () => {
    // `.Ali` in a room holding Alice is not "close enough" - the dot token IS the address, unlike an
    // `@` mention which sits inside a sentence and resolves on word boundaries. Getting this wrong
    // sends to a member the person did not name.
    const r = parseMentions('.Ali are you free', members, me.userArn);
    expect(r.targetArn).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it('refuses a private prefix combined with a mention', () => {
    // One says only this member may read it; the other says notify them and let everyone read it.
    const r = parseMentions('.Alice can you ping @assistant', members, me.userArn);
    expect(r.error).toBe('private_with_mention');
    expect(r.targetArn).toBeUndefined();
  });

  it('refuses a private prefix combined with @all', () => {
    const r = parseMentions('.Alice @all please look', members, me.userArn);
    expect(r.error).toBe('private_with_mention');
  });

  it('finds a member whose only valid mention comes after a near-miss', () => {
    // Sam and Samuel both in the room. The scan tested ONE occurrence and gave up: Sam was found only
    // inside `@samuel`, dropped, and the message sent with no mention attribute for him - no
    // notification, and the multiple-humans guard never fired either.
    const samuel: ChannelMember = { userArn: 'arn:user:samuel', name: 'Samuel', isBot: false };
    const sam: ChannelMember = { userArn: 'arn:user:sam', name: 'Sam', isBot: false };
    const r = parseMentions('@Samuel and @Sam please review', [me, bot, samuel, sam], me.userArn);
    // Two humans is a refusal, which is the CORRECT outcome - and it can only be reached once both
    // are actually found.
    expect(r.error).toBe('multiple_humans');
    expect(r.mentionedArns).toContain(sam.userArn);
    expect(r.mentionedArns).toContain(samuel.userArn);
  });

  it('does not treat an @ glued to a preceding word as a mention', () => {
    // The backend requires start-of-message or whitespace before the `@`; this side required nothing,
    // so `cc:@Alice` was a mention here and not there.
    const r = parseMentions('cc:@Alice about the rollout', members, me.userArn);
    expect(r.mentionedArns).toEqual([]);
  });

  it('does not refuse a private message over an @ glued to a preceding word', () => {
    // The sharper version of the same disagreement: this was blocked in the composer as a private
    // message carrying a mention, while the backend would have sent it as an ordinary private one.
    const r = parseMentions('.Bob cc:@Alice later', members, me.userArn);
    expect(r.error).toBeUndefined();
    expect(r.privateToName).toBe('Bob');
  });

  it('refuses a mention that appears AFTER a near-miss of the same name', () => {
    // The contradiction check read one `indexOf` per name, so if the first occurrence failed the
    // boundary test the scan stopped and declared no mention. ".Carol @Samuel and @Sam hi" therefore
    // went out privately to Carol carrying a live `@Sam` - one member reading a message that names,
    // and appears to address, another.
    const r = parseMentions('.Bob @Alicia and @Alice hi', members, me.userArn);
    expect(r.error).toBe('private_with_mention');
    expect(r.targetArn).toBeUndefined();
  });

  it('does NOT refuse over a word that merely starts with a member name', () => {
    // The boundary here was written `[w]` - the literal letter, not `\w` - so any character except
    // "w" after a name counted as the end of a mention. "@Alicia" therefore read as a mention of
    // Alice, and a valid private message was refused with a mention error naming nothing the person
    // had typed. The same boundary, with the same escape, guards the public mention scan.
    const r = parseMentions('.Bob did @Alicia send the file', members, me.userArn);
    expect(r.error).toBeUndefined();
    expect(r.privateToName).toBe('Bob');
  });

  it('is anchored, so ordinary prose is never made private', () => {
    for (const text of ['call me at 5.Alice', 'see notes.Alice', 'ok... Alice?']) {
      const r = parseMentions(text, members, me.userArn);
      expect(r.targetArn).toBeUndefined();
      expect(r.error).toBeUndefined();
    }
  });

  it('needs the trailing space, because that is what completes the token', () => {
    // Incomplete is not applied: the composer decorates on completion, and a token that has not
    // visibly become a pill has not taken effect.
    expect(privatePrefixToken('.Alice')).toBeNull();
    expect(privatePrefixToken('.Alice ')).toBe('Alice');
  });

  it('matches the member name case-insensitively', () => {
    const r = parseMentions('.ALICE hello', members, me.userArn);
    expect(r.targetArn).toBe(alice.userArn);
  });
});

/**
 * THE ID IS FOR THE SERVER, NOT FOR THE READER.
 *
 * The composer writes `.<Name|id>` so the backend resolves the addressee by id rather than by matching
 * a display name - that is what makes a private address land on the member the picker actually
 * selected. Nothing undid it at display, so a recipient read the literal token: the id, the pipe and
 * the angle brackets included. `privatePrefixToken`'s own comment asserted the opposite ("the SPA
 * renders the token and the id never reaches them") while no code did it.
 */
describe('what a person reads when a message was privately addressed', () => {
  it('shows the name and takes the id back out', () => {
    expect(withPrivateAddressDisplayed('.<Alice|alice-sub-123> can you check this'))
      .toBe('.Alice can you check this');
  });

  it('keeps the delimited form when the name needs it', () => {
    // The bare token ends at the first space, so a two-word name has to stay bracketed or it would
    // read as a different, shorter name.
    expect(withPrivateAddressDisplayed('.<Ryan McHarg|ryan-sub> hello'))
      .toBe('.<Ryan McHarg> hello');
  });

  it('shows the address rather than removing it, because who it went to is information', () => {
    // A message addressed to one person reads differently from one addressed to the room. Stripping
    // the address entirely would make a private note look like an open one.
    const shown = withPrivateAddressDisplayed('.<Alice|alice-sub-123> hi');
    expect(shown).toContain('Alice');
    expect(shown.startsWith('.')).toBe(true);
  });

  it('never leaves the id, the pipe or the brackets in what is rendered', () => {
    const shown = withPrivateAddressDisplayed('.<Alice|alice-sub-123> hi');
    expect(shown).not.toContain('alice-sub-123');
    expect(shown).not.toContain('|');
    expect(shown).not.toContain('<');
  });

  it('preserves a leading /md, because the rendering command is not part of the address', () => {
    expect(withPrivateAddressDisplayed('/md .<Alice|alice-sub> **hi**'))
      .toBe('/md .Alice **hi**');
  });

  it('leaves a bare address and an ordinary message untouched', () => {
    // A bare `.Alice` never carried an id, and a message with no address has nothing to rewrite - so
    // this is safe to apply to every message.
    expect(withPrivateAddressDisplayed('.Alice hello')).toBe('.Alice hello');
    expect(withPrivateAddressDisplayed('just a normal message')).toBe('just a normal message');
    expect(withPrivateAddressDisplayed('')).toBe('');
  });
});

/**
 * WHAT THE ID BUYS, AND WHAT IT MUST NOT BREAK.
 *
 * `@<Name|id>` exists because a display name is not unique - it falls back to the email local part, so
 * two members can carry one, and the backend had to break the tie by preferring assistants. The id
 * removes the guess. These assert that it does, and that every case the bare grammar already got right
 * still works, because that logic was learned from real misroutes.
 */
describe('an @mention that carries an id', () => {
  const sam: ChannelMember = { userArn: 'arn:user:sam', name: 'Sam', isBot: false };
  const samuel: ChannelMember = { userArn: 'arn:user:samuel', name: 'Samuel', isBot: false };
  // Two members, one name - the case the id exists for.
  const aliceOne: ChannelMember = { userArn: 'arn:aws:chime:r:1:app-instance/i/user/alice-1', name: 'Alice', isBot: false };
  const aliceTwo: ChannelMember = { userArn: 'arn:aws:chime:r:1:app-instance/i/user/alice-2', name: 'Alice', isBot: false };

  it('resolves the member the picker chose, not the first with that name', () => {
    const r = parseMentions('@<Alice|alice-2> can you look', [me, aliceOne, aliceTwo], me.userArn);
    expect(r.mentionedArns).toEqual([aliceTwo.userArn]);
  });

  it('falls back to the name when the id names nobody here', () => {
    // A stale or crafted id resolves to nobody rather than to a guess, and the name is what the sender
    // saw when they picked - so the mention still lands.
    const r = parseMentions('@<Alice|not-a-member> hi', [me, aliceOne], me.userArn);
    expect(r.mentionedArns).toEqual([aliceOne.userArn]);
  });

  it('still finds a bare mention, because people type them without the picker', () => {
    const r = parseMentions('@Sam please review', [me, sam], me.userArn);
    expect(r.mentionedArns).toEqual([sam.userArn]);
  });

  it('mixes the two grammars without losing either', () => {
    const r = parseMentions('@<Samuel|samuel> and @Sam please review', [me, sam, samuel], me.userArn);
    expect(new Set(r.mentionedArns)).toEqual(new Set([samuel.userArn, sam.userArn]));
  });

  it('does not double-count a member named twice', () => {
    const r = parseMentions('@<Sam|sam> and @Sam again', [me, sam], me.userArn);
    expect(r.mentionedArns).toEqual([sam.userArn]);
  });

  it('refuses a private address carrying a delimited mention, as it does a bare one', () => {
    // One says only this member may read it, the other says notify somebody and let everyone read it.
    // The delimited token is blanked out of the bare scan, so without its own check this contradiction
    // would pass and the message would go out privately with a live mention in its text.
    const r = parseMentions('.<Sam|sam> @<Samuel|samuel> hi', [me, sam, samuel], me.userArn);
    expect(r.error).toBe('private_with_mention');
  });

  it('keeps @all exclusive of a delimited mention', () => {
    const r = parseMentions('@all and @<Sam|sam> too', [me, sam], me.userArn);
    expect(r.error).toBe('all_with_member');
  });

  it('shows the reader a name and never the id', () => {
    const shown = withMentionNamesDisplayed('@<Alice|alice-2> and @<Ryan McHarg|ryan> hi');
    expect(shown).toBe('@Alice and @<Ryan McHarg> hi');
    expect(shown).not.toContain('alice-2');
    expect(shown).not.toContain('|');
  });
});

describe('a name that contains another member\'s name', () => {
  // A battle's challenger is named after the live assistant with a marker, so `@Advisor (alt)` also
  // contains `@Advisor`. The longer name wins at one position, as the channel flow's resolver decides.
  const advisor: ChannelMember = { userArn: 'arn:bot:advisor', name: 'Advisor', isBot: true };
  const challenger: ChannelMember = { userArn: 'arn:bot:alt', name: 'Advisor (alt)', isBot: true };
  const room = [me, advisor, challenger];

  it('addresses the challenger, not both assistants', () => {
    const r = parseMentions('@Advisor (alt) what is our NRR?', room, me.userArn);
    expect(r.error).toBeUndefined();
    expect(r.mentionBotArn).toBe(challenger.userArn);
    expect(r.mentionedArns).toEqual([challenger.userArn]);
  });

  it('still addresses the live assistant by its own name', () => {
    const r = parseMentions('@Advisor what is our NRR?', room, me.userArn);
    expect(r.error).toBeUndefined();
    expect(r.mentionBotArn).toBe(advisor.userArn);
  });

  it('two different assistants named at different places is still two', () => {
    const r = parseMentions('@Advisor and @Advisor (alt) compare', room, me.userArn);
    expect(r.error).toBe('multiple_bots');
  });
});

describe('a display name with a space is mentioned through the delimited token the picker writes', () => {
  const adminAssistant: ChannelMember = {
    userArn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/admin-bot', name: 'Admin Assistant', isBot: true,
  };
  const advisor: ChannelMember = { userArn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/advisor-bot', name: 'Advisor', isBot: true };
  const room = [me, alice, adminAssistant, advisor];

  it('the picker inserts the full name with the member id', () => {
    expect(mentionTokenFor('Admin Assistant', adminAssistant.userArn)).toBe('@<Admin Assistant|admin-bot> ');
  });

  it('the inserted token resolves back to that member', () => {
    const r = parseMentions(`${mentionTokenFor('Admin Assistant', adminAssistant.userArn)}please`, room, me.userArn);
    expect(r.error).toBeUndefined();
    expect(r.mentionBotArn).toBe(adminAssistant.userArn);
    expect(r.mentionedArns).toEqual([adminAssistant.userArn]);
  });

  it('a single-word name and @all behave as before', () => {
    expect(parseMentions('@Advisor please', room, me.userArn).mentionBotArn).toBe(advisor.userArn);
    expect(parseMentions('@all please', room, me.userArn)).toEqual({ isAtAll: true, mentionedArns: [] });
  });
});
