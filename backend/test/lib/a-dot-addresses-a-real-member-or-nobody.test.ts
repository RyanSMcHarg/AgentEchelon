/**
 * A `.` PREFIX APPLIES A TARGET ONLY WHEN IT NAMES A REAL MEMBER, IN FULL.
 *
 * WHY THIS LIVES IN THE BACKEND AT ALL, which is the point it was raised on. As first built, the dot
 * was resolved only in the web client: `mentionParser.ts` set the Amazon Chime SDK `Target` and the
 * backend had no `.` handling whatsoever. Privacy - the one property here that cannot be taken back
 * when it fails - was a rule that one client happened to follow. This platform is built for more than
 * one ingress (MESSAGE-FLOW.md: "does not rely on the web client to ensure messages follow the
 * correct path"), so the meaning of an address has to be derived from the roster by shared backend
 * code that every ingress calls.
 *
 * WHAT THIS FILE PINS, and it is meaning rather than enforcement: what `.name` RESOLVES TO, decided
 * from the live membership and not from the shape of the text. What it deliberately does not pin is
 * that a `Target` was applied - the channel-flow callback carries no `Target` at all, so no test here
 * could assert it. `lib/private-prefix.ts` states that limit in its own header. Enforcing it in
 * the flow needs a measurement that does not exist yet.
 */
import {
  privatePrefixToken,
  resolvePrivateTarget,
  mightAddressPrivately,
  stripPrivatePrefix,
} from '../../lambda/src/lib/private-prefix.js';
import type { BypassMember } from '../../lambda/src/lib/flow-bypass.js';

const bot: BypassMember = { arn: 'arn:bot:assistant', name: 'assistant', isBot: true };
const alice: BypassMember = { arn: 'arn:user:alice', name: 'Alice', isBot: false };
const samantha: BypassMember = { arn: 'arn:user:samantha', name: 'Samantha', isBot: false };
const roster = [bot, alice, samantha];

describe('what counts as a private address', () => {
  it('resolves a dot followed by a members full name', () => {
    expect(resolvePrivateTarget('.Alice are you free', roster)?.arn).toBe(alice.arn);
    expect(resolvePrivateTarget('.assistant draft me a reply', roster)?.arn).toBe(bot.arn);
  });

  it('is case-insensitive, because a name is not a password', () => {
    expect(resolvePrivateTarget('.ALICE are you free', roster)?.arn).toBe(alice.arn);
  });

  it('resolves NOBODY for a token that is merely a prefix of a members name', () => {
    // FULL match, not a prefix match, and this is the difference between the two grammars: `@`
    // resolution uses word boundaries because a mention sits inside a sentence, while the dot token
    // IS the whole address. `.Sam` in a room holding Samantha addresses nobody.
    expect(resolvePrivateTarget('.Sam are you free', roster)).toBeNull();
  });

  it('resolves NOBODY for an ordinary sentence that happens to start with a dot', () => {
    // THE DEFECT THIS RULE REMOVES. Every one of these produces a token, and the composer used to
    // refuse the send with "That name is not in this conversation" - so in any room where people
    // discuss code, everyday sentences could not be sent at all.
    for (const text of ['.env is missing', '.gitignore needs a line', '...ok then', '.5s is fine']) {
      expect(resolvePrivateTarget(text, roster)).toBeNull();
    }
  });

  it('addresses a member whose name IS an email address', () => {
    // THE DEFECT THIS CLOSES. The token used to be a character class with no `@` in it, so on a
    // deployment where members are named by email NO human could be addressed privately at all:
    // the prefix matched nothing, the message was not private, and it went to the whole room.
    //
    // The class was doing safety work it was never the right tool for. Safety comes from requiring a
    // FULL match against the roster, so widening the token cannot make a message private by
    // accident - it can only let a real name through.
    const emailNamed: BypassMember = { arn: 'arn:user:basic', name: 'basic@stratum.example.com', isBot: false };
    expect(resolvePrivateTarget('.basic@stratum.example.com can you look', [emailNamed])?.arn)
      .toBe(emailNamed.arn);
  });

  it('still resolves nobody for a dot-sentence, now that the token is wider', () => {
    // Widening the token widens what gets EXTRACTED, not what gets matched. These extract tokens
    // (`env@2x`, `gitignore`) and none of them name a member, so they stay ordinary text.
    for (const text of ['.env@2x is broken', '.gitignore needs a line', '.a/b/c is the path']) {
      expect(resolvePrivateTarget(text, roster)).toBeNull();
    }
  });

  it('addresses a name containing a SPACE, through the delimited form', () => {
    // The bare token ends at the first space, so "Ryan McHarg" resolved as `Ryan` - nobody - and a
    // message the person believed was private went to the room. Angle brackets are the convention
    // every major client uses to delimit a mention target (Slack, Discord, Google Chat, and Teams'
    // `<at>Name</at>`, which like this wraps the NAME).
    const spaced: BypassMember = { arn: 'arn:user:ryan', name: 'Ryan McHarg', isBot: false };
    expect(resolvePrivateTarget('.<Ryan McHarg> are you free', [spaced])?.arn).toBe(spaced.arn);
    expect(resolvePrivateTarget('.Ryan McHarg are you free', [spaced])).toBeNull();
  });

  it('resolves a delimited address with no message after it', () => {
    // The closing bracket terminates the name, so unlike the bare form this needs no trailing space
    // to be finished - which is what lets the chip appear the moment the picker inserts it.
    const spaced: BypassMember = { arn: 'arn:user:ryan', name: 'Ryan McHarg', isBot: false };
    expect(resolvePrivateTarget('.<Ryan McHarg>', [spaced])?.arn).toBe(spaced.arn);
  });

  it('reads a delimited token as ONE address, not as a bare token starting with a bracket', () => {
    // `.<a b> c` can only be an address; the bare pattern would read `<a` as a name. Delimited is
    // resolved first for exactly that reason.
    expect(resolvePrivateTarget('.<Alice> hello', roster)?.arn).toBe(alice.arn);
  });

  it('strips the delimited form whole, leaving no stray bracket', () => {
    const spaced: BypassMember = { arn: 'arn:user:ryan', name: 'Ryan McHarg', isBot: false };
    expect(stripPrivatePrefix('.<Ryan McHarg> can you look', spaced)).toBe('can you look');
  });

  it('still resolves nobody for a delimited token naming a non-member', () => {
    expect(resolvePrivateTarget('.<Someone Else> hello', roster)).toBeNull();
  });

  it('finds the address behind a /md rendering command', () => {
    // `/md` says how to DISPLAY a message; `.name` says who may READ it. Both grammars are anchored,
    // so with the command in front the backend stopped seeing the address: the flow recorded the
    // message as not privately addressed, and the handler handed the model the address it exists to
    // remove.
    expect(resolvePrivateTarget('/md .Alice here is the **plan**', roster)?.arn).toBe(alice.arn);
    expect(resolvePrivateTarget('/MD .<Ryan McHarg> hello',
      [{ arn: 'arn:user:ryan', name: 'Ryan McHarg', isBot: false }])?.arn).toBe('arn:user:ryan');
    expect(mightAddressPrivately('/md .Alice hello')).toBe(true);
  });

  it('strips only the ADDRESS, never the rendering command', () => {
    // The command is part of what the person wrote and the renderer still needs it; the address is
    // not part of the question the model answers.
    expect(stripPrivatePrefix('/md .Alice here is the plan', alice)).toBe('/md here is the plan');
  });

  it('is ANCHORED, so a decimal or a file extension mid-sentence is not an address', () => {
    expect(privatePrefixToken('call me at 5.Alice')).toBeNull();
    expect(privatePrefixToken('see notes.Alice')).toBeNull();
    expect(resolvePrivateTarget('the file is app.Alice and it broke', roster)).toBeNull();
  });

  it('needs the token to be FINISHED, because a person mid-word has not addressed anybody yet', () => {
    expect(privatePrefixToken('.Alice')).toBeNull();
    expect(privatePrefixToken('.Alice ')).toBe('Alice');
  });

  it('resolves nobody against an empty roster rather than throwing', () => {
    // The shape an unreadable membership read produces. Nothing is private, and the message is
    // ordinary text - the same direction every other unreadable-roster path fails in.
    expect(resolvePrivateTarget('.Alice are you free', [])).toBeNull();
  });
});

describe('the cheap gate in front of the roster read', () => {
  it('says no to an ordinary message, so it never costs a membership read', () => {
    expect(mightAddressPrivately('sounds good to me')).toBe(false);
    expect(mightAddressPrivately('')).toBe(false);
  });

  it('says yes to anything dot-shaped, and lets the roster settle it', () => {
    expect(mightAddressPrivately('.Alice are you free')).toBe(true);
    expect(mightAddressPrivately('.env is missing')).toBe(true);
  });
});

describe('the address is not part of the request', () => {
  it('strips a resolved prefix, so the assistant is not answering its own name', () => {
    expect(stripPrivatePrefix('.assistant draft me a reply', bot)).toBe('draft me a reply');
  });

  it('leaves an UNRESOLVED dot exactly as the person wrote it', () => {
    // ".env is missing" is a sentence about a file. Stripping it would silently edit what was said.
    expect(stripPrivatePrefix('.env is missing', alice)).toBe('.env is missing');
  });

  it('strips only the member the prefix actually named', () => {
    expect(stripPrivatePrefix('.Alice are you free', bot)).toBe('.Alice are you free');
    expect(stripPrivatePrefix('.Alice are you free', alice)).toBe('are you free');
  });
});
