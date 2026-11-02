/**
 * AN `@` TOKEN NAMES ONE MEMBER OF THIS CONVERSATION, OR IT NAMES NOBODY (ADR-034).
 *
 * `@all` and `/battle` are literals and the completeness test can assert the whole set. `@<member>`
 * cannot be enumerated: it is any `@` followed by a name that resolves against THIS channel's
 * roster, so the set is per-conversation. What survives from the literal era is the property the
 * module exists for - the channel flow and the agent handler decide from ONE definition.
 *
 * WHY THAT PROPERTY IS THE WHOLE POINT. The two sides are exact complements: the flow takes the turn
 * and the handler stands down. If they disagree about whether a message carries a mention, the turn
 * is either answered twice or answered by nobody, and neither failure raises an error. That is not
 * hypothetical here - it is what happened when `/battle` was added to one side's list and not the
 * other's, and two plausible answers arrived.
 */
import {
  resolveMentionedMember,
  resolveMentionedAssistant,
  mentionsAMember,
  flowOwnsTheTurn,
  type BypassMember,
} from '../../lambda/src/lib/flow-bypass.js';

const bot: BypassMember = { arn: 'arn:bot:assistant', name: 'assistant', isBot: true };
const alice: BypassMember = { arn: 'arn:user:alice', name: 'Alice', isBot: false };
const sam: BypassMember = { arn: 'arn:user:sam', name: 'Sam', isBot: false };
const samantha: BypassMember = { arn: 'arn:user:samantha', name: 'Samantha', isBot: false };
const roster = [bot, alice, sam, samantha];

describe('resolving an @ token against the roster', () => {
  it('names the assistant', () => {
    expect(resolveMentionedMember('@assistant can you help', roster)?.arn).toBe(bot.arn);
  });

  it('names a person, and says so rather than returning nothing', () => {
    // The caller decides what a human mention MEANS - the flow notifies, the handler stands down.
    // Returning null here would make "nobody is named" and "a person is named" the same answer, and
    // the handler would then run a turn for a message addressed to somebody else.
    const found = resolveMentionedMember('@Alice quick question', roster);
    expect(found?.arn).toBe(alice.arn);
    expect(found?.isBot).toBe(false);
  });

  it('names nobody when the name is not in this conversation', () => {
    expect(resolveMentionedMember('@Carol are you there', roster)).toBeNull();
    expect(mentionsAMember('@Carol are you there', roster)).toBe(false);
  });

  it('resolves the FIRST member named, not the one with the longest name', () => {
    // The rule used to be "longest name wins", applied across the whole message rather than at one
    // position. "@Atlas and @Samantha" then resolved to Samantha: the flow took the human branch and
    // started no turn, the handler stood down because a member WAS mentioned, and the assistant the
    // person explicitly addressed answered nothing. Nothing errored - the message just sat there.
    expect(resolveMentionedMember('@assistant and @Samantha, thoughts?', roster)?.arn).toBe(bot.arn);
    expect(resolveMentionedMember('@Samantha and @assistant, thoughts?', roster)?.arn).toBe(samantha.arn);
  });

  it('ignores an @ inside an email address, which is not a mention', () => {
    // Without a leading boundary "ops@assistant.com" resolved to the assistant and dispatched a turn.
    // It also made the prefilter's bargain false: a yes there is supposed to cost only a read that
    // then resolves to nobody.
    expect(resolveMentionedMember("here's the address: ops@assistant.com", roster)).toBeNull();
    expect(resolveMentionedMember('mail alice@assistant.io about it', roster)).toBeNull();
  });

  it('still resolves a real mention in a message that also carries an email address', () => {
    expect(resolveMentionedMember("@Alice ping ops@assistant.com", roster)?.arn).toBe(alice.arn);
  });

  it('prefers the LONGER name, so @Sam cannot claim a message for @Samantha', () => {
    // The failure this prevents is silent and lands on a person: Samantha is addressed, Sam is
    // notified, and the turn is attributed to the wrong member.
    expect(resolveMentionedMember('@Samantha please review', roster)?.arn).toBe(samantha.arn);
    expect(resolveMentionedMember('@Sam please review', roster)?.arn).toBe(sam.arn);
  });

  it('does not let a SHORTER name claim a longer token built with punctuation', () => {
    // `\w` alone was too weak an end-of-token test, because the characters a NAME can contain are
    // wider than it. `@`, `-` and `.` are not word characters, so every one of these resolved to
    // Alice: somebody quoting an address or naming a different person silently mentioned whoever
    // held the shorter name - and in a group that means the flow claims the turn and the handler
    // stands down for it.
    expect(resolveMentionedMember('@Alice@example.com about billing', roster)).toBeNull();
    expect(resolveMentionedMember('@Alice-Bob please review', roster)).toBeNull();
    expect(resolveMentionedMember('@Alice.Smith owns it', roster)).toBeNull();
  });

  it('still ends the token at punctuation that is really punctuation', () => {
    // The other half of the same rule, and the reason it cannot just reject every `.` or `-`:
    // punctuation continues a token only when something name-shaped follows it.
    expect(resolveMentionedMember('could you ask @Alice.', roster)?.arn).toBe(alice.arn);
    expect(resolveMentionedMember('@Alice, can you look?', roster)?.arn).toBe(alice.arn);
    expect(resolveMentionedMember('(@Alice) owns it', roster)).toBeNull(); // no leading boundary
    expect(resolveMentionedMember('@Alice- what do you think', roster)?.arn).toBe(alice.arn);
  });

  it('finds the ASSISTANT even when a person is named first', () => {
    // THE TURN NOBODY ANSWERED. `resolveMentionedMember` returns the earliest token, which answers
    // "who is this addressed to" and not "must an assistant answer". For a message naming both - a
    // shape the composer explicitly allows - the flow saw a person and dispatched nothing while the
    // handler stood down because a member WAS named. Reversing the two names worked, which is the
    // kind of difference nobody reproduces on purpose.
    expect(resolveMentionedAssistant('@Alice and @assistant, thoughts?', roster)?.arn).toBe(bot.arn);
    expect(resolveMentionedAssistant('hey @Sam can you loop in @assistant', roster)?.arn).toBe(bot.arn);
  });

  it('finds no assistant when only people are named', () => {
    expect(resolveMentionedAssistant('@Alice and @Sam, thoughts?', roster)).toBeNull();
  });

  it('applies the same boundary rules when looking for an assistant', () => {
    expect(resolveMentionedAssistant('mail ops@assistant.com', roster)).toBeNull();
    expect(resolveMentionedAssistant('@assistants are useful', roster)).toBeNull();
  });

  it('resolves a member whose name IS an email address', () => {
    // The shape a real deployment uses. The token ends at the space, not at the `@` inside the name.
    const emailNamed = { arn: 'arn:user:basic', name: 'basic@stratum.example.com', isBot: false };
    expect(resolveMentionedMember('@basic@stratum.example.com can you look', [emailNamed])?.arn)
      .toBe(emailNamed.arn);
  });

  it('does not match a name that merely starts another word', () => {
    // The same rule, and the same reason, as the boundary `@all` needs to keep `@allison` out.
    expect(resolveMentionedMember('@Samuel is out today', roster)).toBeNull();
    expect(resolveMentionedMember('@assistants are useful', roster)).toBeNull();
  });

  it('matches case-insensitively, because a name is not a password', () => {
    expect(resolveMentionedMember('hey @ALICE', roster)?.arn).toBe(alice.arn);
  });

  it('finds a mention anywhere in the message, not only at the start', () => {
    // Unlike `/battle`, a mention is not a command: it addresses somebody and may appear mid-sentence.
    expect(resolveMentionedMember('could you ask @Alice about it', roster)?.arn).toBe(alice.arn);
  });

  it('is null on an empty roster and on empty text, rather than throwing', () => {
    expect(resolveMentionedMember('@Alice', [])).toBeNull();
    expect(resolveMentionedMember('', roster)).toBeNull();
  });

  it('ignores a member with no name rather than matching a bare @', () => {
    const anonymous: BypassMember = { arn: 'arn:user:ghost', name: '', isBot: false };
    expect(resolveMentionedMember('@ hello', [anonymous])).toBeNull();
  });
});

/**
 * ONE ANSWER, TWO CALLERS, COMPLEMENTS BY CONSTRUCTION.
 *
 * `flowOwnsTheTurn` is asked by the channel flow to decide whether to act, and by the agent handler
 * to decide whether to stand down. There is no second implementation to drift, which is the point:
 * the last time these two decided separately, `/battle` was added to one list and not the other and
 * a duel in a two-member channel was answered by both entries. Nothing errored - two plausible
 * answers simply arrived.
 */
describe('who owns the turn', () => {
  const ask = (text: string, isOneToOne: boolean) =>
    flowOwnsTheTurn({ text, members: roster, isOneToOne });

  it('the flow owns an @ mention in a group', () => {
    expect(ask('@assistant help', false)).toBe(true);
    expect(ask('@Alice quick question', false)).toBe(true);
  });

  it('the flow owns @all in a group', () => {
    expect(ask('@all heads up', false)).toBe(true);
  });

  it('the flow does NOT own an ordinary message', () => {
    expect(ask('just thinking out loud', false)).toBe(false);
    expect(ask('@Carol is not here', false)).toBe(false);
  });

  it('the flow CLAIMS a 1:1, whatever the mention says, because nothing else is invoked', () => {
    // WHY IT USED TO STAND DOWN, kept because the hazard is real wherever a second entry exists:
    // `StandardMessages: AUTO` invoked the handler on every message at that size regardless, and a
    // second entry would run the same turn under a second correlation id. Measured 2026-08-12: two
    // placeholders, one stranded forever.
    //
    // Every assistant now carries `NONE`, so no untargeted message reaches Amazon Lex at any size and
    // standing down would answer nobody. The mention still does not decide it - the size does.
    expect(ask('@assistant help', true)).toBe(true);
    expect(ask('@all heads up', true)).toBe(true);
  });

  it('/battle is owned at every size, because a duel cannot arise in a 1:1 at all', () => {
    expect(ask('/battle tabs or spaces', false)).toBe(true);
    expect(ask('/battle tabs or spaces', true)).toBe(true);
  });

  it('a private . prefix is NOT a flow bypass - Amazon Chime SDK routes it from the Target', () => {
    // The two grammars use two mechanisms: @ is routed by AgentEchelon, . by the service. A flow
    // that claimed a `.member` turn would take a turn the service is also delivering.
    expect(ask('.Alice are you free', false)).toBe(false);
    expect(ask('.assistant draft me a reply', false)).toBe(false);
  });
});
