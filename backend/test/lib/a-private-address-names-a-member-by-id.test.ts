/**
 * A PRIVATE ADDRESS NAMES A MEMBER BY ID, BECAUSE A DISPLAY NAME IS NOT UNIQUE.
 *
 * ── THE AMBIGUITY THIS REMOVES ──────────────────────────────────────────────────────────────────
 *
 * A person's display name falls back to the email local part, so two members can genuinely carry one
 * name. `resolvePrivateTarget` has had to break that tie by preferring assistants - deterministic, but
 * still a guess about who was meant, and its own comment records the cost: "a person who shares a name
 * with an assistant cannot be addressed privately by that name at all now".
 *
 * The composer always knew which member it inserted; it sets `targetArn` on the send from the same
 * object. What it could not do is tell the CHANNEL FLOW, because a channel-flow callback carries no
 * `Target` - the field is declared on the event "for completeness" and measured as never populated.
 * So the id travels in the text, where the flow can read it.
 *
 * ── AND WHAT KEEPS IT SAFE ──────────────────────────────────────────────────────────────────────
 *
 * The body is written by the sender, so a crafted id has to be assumed. It is resolved against THIS
 * channel's roster and nothing else, so the worst a forged id can do is name somebody already in the
 * conversation - whom the sender could address by name anyway. It narrows a guess; it grants nothing.
 */
import {
  parsePrivateAddress,
  resolvePrivateTarget,
  stripPrivatePrefix,
} from '../../lambda/src/lib/private-prefix';

const INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const ATLAS_BOT = { arn: `${INSTANCE}/bot/atlas`, name: 'Atlas', isBot: true };
const ATLAS_PERSON = { arn: `${INSTANCE}/user/sub-atlas-person`, name: 'Atlas', isBot: false };
const ALICE = { arn: `${INSTANCE}/user/sub-alice`, name: 'Alice', isBot: false };

describe('the address splits into what a person reads and what the roster is searched by', () => {
  it('reads the id the picker wrote', () => {
    expect(parsePrivateAddress('.<Alice|sub-alice> hello')).toEqual({
      name: 'Alice', id: 'sub-alice', raw: 'Alice|sub-alice',
    });
  });

  it('leaves a plain address exactly as it was', () => {
    // The bare and undelimited forms are what a person types, and what arrives over SMS or email.
    expect(parsePrivateAddress('.Alice hello')).toEqual({ name: 'Alice', raw: 'Alice' });
    expect(parsePrivateAddress('.<Ryan McHarg> hello')).toEqual({ name: 'Ryan McHarg', raw: 'Ryan McHarg' });
  });

  it('keeps the whole name when the name itself holds a separator', () => {
    // Split on the LAST one, so only the final segment is ever read as an id.
    expect(parsePrivateAddress('.<A|B|sub-x> hi')).toEqual({ name: 'A|B', id: 'sub-x', raw: 'A|B|sub-x' });
  });

  it('is not an address at all when there is no prefix', () => {
    expect(parsePrivateAddress('just a message')).toBeNull();
  });
});

describe('the id decides, and the name is the fallback', () => {
  const room = [ATLAS_BOT, ATLAS_PERSON, ALICE];

  it('addresses the PERSON called Atlas when the picker said so', () => {
    // THE CASE THE TIE-BREAK COULD NOT REACH. `.Atlas` alone resolves to the assistant by rule, so
    // the person sharing that name was unaddressable. The id says which one, and it is the one the
    // composer had in hand the whole time.
    expect(resolvePrivateTarget('.<Atlas|sub-atlas-person> hello', room)).toBe(ATLAS_PERSON);
  });

  it('still addresses the assistant when the picker said THAT', () => {
    expect(resolvePrivateTarget('.<Atlas|atlas> hello', room)).toBe(ATLAS_BOT);
  });

  it('keeps the assistants-win rule for a name typed by hand', () => {
    // Non-vacuity, and the reason the rule stays: with no id there is still a real ambiguity, and
    // roster order deciding it is what the rule replaced.
    expect(resolvePrivateTarget('.Atlas hello', room)).toBe(ATLAS_BOT);
  });

  it('falls back to the name when the id names nobody here', () => {
    // A stale or mistyped id should address whoever the NAME says rather than nobody: the message
    // reaches the room either way, and the composer showed what it had resolved while they typed.
    expect(resolvePrivateTarget('.<Alice|sub-does-not-exist> hello', room)).toBe(ALICE);
  });

  it('cannot reach outside the roster it was given', () => {
    // THE SAFETY RULE. The id is a selector among these members; an id naming somebody who is not
    // here resolves to nobody rather than to them.
    const outsider = `${INSTANCE}/user/sub-outsider`;
    expect(resolvePrivateTarget(`.<Nobody|${outsider.split('/').pop()}> hi`, room)).toBeNull();
  });

  it('resolves a member whose own name contains a separator', () => {
    const odd = { arn: `${INSTANCE}/user/sub-odd`, name: 'A|B', isBot: false };
    expect(resolvePrivateTarget('.<A|B> hi', [odd, ALICE])).toBe(odd);
  });
});

describe('the address is removed from the question', () => {
  it('strips the id form, so the model never reads the bookkeeping', () => {
    // THE DEFECT THIS NEARLY SHIPPED WITH. The stripper compared the RAW token to the member name, so
    // `.<Alice|sub-alice>` matched nothing and the whole address stayed in the text the model answers.
    expect(stripPrivatePrefix('.<Alice|sub-alice> what is a feature flag', ALICE))
      .toBe('what is a feature flag');
  });

  it('still strips the plain forms', () => {
    expect(stripPrivatePrefix('.Alice what is a feature flag', ALICE)).toBe('what is a feature flag');
    expect(stripPrivatePrefix('.<Alice> what is a feature flag', ALICE)).toBe('what is a feature flag');
  });

  it('leaves a message addressed to somebody else untouched', () => {
    expect(stripPrivatePrefix('.<Alice|sub-alice> hello', ATLAS_BOT)).toBe('.<Alice|sub-alice> hello');
  });

  it('keeps a rendering command, which is not part of the address', () => {
    expect(stripPrivatePrefix('/md .<Alice|sub-alice> a **table**', ALICE)).toBe('/md a **table**');
  });
});
