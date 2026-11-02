/**
 * THE CHANNEL FLOW OWNS EVERY ONE-TO-ONE TURN, AND STILL NEVER OWNS A TARGETED ONE.
 *
 * Every assistant carries `InvokedBy: { StandardMessages: 'NONE', TargetedMessages: 'ALL' }`
 * (`assistant-profile-stack`), so Amazon Chime SDK turns no untargeted message into an Amazon Lex turn
 * at any conversation size. The channel flow is the only thing that can start one, and standing down
 * in a one-to-one would answer NOBODY - silently, with the person left talking to a room that looks
 * exactly like one where the assistant is simply thinking.
 *
 * ── WHY THIS IS ONE INVARIANT AND NOT A SETTING ─────────────────────────────────────────────────
 *
 * It used to be a per-profile `turnEntry`, resolved per message from the classification tag. That was
 * unsound as well as complicated. The entry is PROVISIONED at deploy time onto the `AppInstanceBot`,
 * and it was RE-DERIVED at runtime from the same config by two components independently. Those can
 * disagree: a bot provisioned `AUTO` while the runtime reads "flow" gives two responders on one
 * message, and the reverse gives none, and nothing downstream could catch either. One invariant,
 * asserted in one place, cannot disagree with itself.
 *
 * ── WHY THE TARGETED CASE IS HALF OF THIS FILE ──────────────────────────────────────────────────
 *
 * `NONE` narrows ONE axis. `TargetedMessages` stays `ALL`, because Amazon Chime SDK refuses an
 * `InvokedBy` whose members are both `NONE` (measured 2026-09-16 across eight combinations, ADR-041).
 * So a `.` address still reaches Amazon Lex at EVERY size including a one-to-one, and if the flow
 * claimed it there, the duplicate the size rule exists to prevent would come straight back in the one
 * configuration meant to remove it. Asserting the one-to-one claim without asserting the targeted
 * exception would pass while that hole was open.
 */

import { flowOwnsTheTurn, BypassMember } from '../../lambda/src/lib/flow-bypass';
import { defaultProfileRegistry } from '../../lib/profile-registry';

const ASSISTANT: BypassMember = { arn: 'arn:aws:chime:us-east-1:1:app-instance/a/bot/atlas', name: 'Atlas', isBot: true };
const PERSON: BypassMember = { arn: 'arn:aws:chime:us-east-1:1:app-instance/a/user/jo', name: 'Jo', isBot: false };
const OTHER: BypassMember = { arn: 'arn:aws:chime:us-east-1:1:app-instance/a/user/sam', name: 'Sam', isBot: false };

/** A one-to-one roster: the person and the one assistant. */
const PAIR = [PERSON, ASSISTANT];
/** A group: a second person joined. */
const ROOM = [PERSON, ASSISTANT, OTHER];

describe('the flow owns every one-to-one turn', () => {
  it('claims plain prose in a one-to-one, because nothing else is invoked for it', () => {
    expect(flowOwnsTheTurn({ text: 'what did we agree about the rollout?', members: PAIR, isOneToOne: true }))
      .toBe(true);
  });

  it('claims a size-branched command in a one-to-one, which is the case the entry change moved', () => {
    // `/stop` is `sizeBranched: true`, so it sits BELOW the one-to-one return. It used to be answered
    // by the Amazon Lex entry at that size; now the flow claims it, and it has to, because nothing
    // else is invoked. This combination had no coverage before 2026-09-17.
    expect(flowOwnsTheTurn({ text: '/stop', members: PAIR, isOneToOne: true })).toBe(true);
  });

  it('NEVER claims a targeted message, at any size', () => {
    // `.Atlas ...` resolves against the roster and rides a `Target` Amazon Chime SDK routes to Amazon
    // Lex at every size. Claiming it would answer one message twice - the exact defect the size rule
    // was written for, reintroduced by the change that removed the size rule.
    const text = '.Atlas can you check this quietly';
    expect(flowOwnsTheTurn({ text, members: PAIR, isOneToOne: true })).toBe(false);
    expect(flowOwnsTheTurn({ text, members: ROOM, isOneToOne: false })).toBe(false);
    // Including a privately addressed command, which the router refuses rather than the flow claiming
    // it into a broadcast turn.
    expect(flowOwnsTheTurn({ text: '.Jo /stop', members: PAIR, isOneToOne: true })).toBe(false);
  });

  it('answers a group message by what it carries, which the entry never affected', () => {
    // OWNING A TURN IS NOT DISPATCHING ONE, and `@Sam` is where that shows. It names a MEMBER, so this
    // returns true and the Amazon Lex entry stands down - and the flow then resolves no assistant and
    // dispatches nothing, which is MESSAGE-FLOW's routing cell 11, "nobody, and it is warned".
    const cases: Array<[string, boolean]> = [
      ['@all what is the status', true],
      ['@Atlas thoughts?', true],
      ['@Sam can you look', true],
      ['plain prose nobody is addressed in', false],
      ['/battle compare these', true],
    ];
    for (const [text, expected] of cases) {
      expect(`${text} => ${flowOwnsTheTurn({ text, members: ROOM, isOneToOne: false })}`)
        .toBe(`${text} => ${expected}`);
    }
  });

  it('keeps /battle owned at every size, which is the one token size never affected', () => {
    // `sizeBranched: false`, so it returns above the size check and the conversation size never
    // enters into it. Pinned because an entry change is the obvious moment to break it.
    expect(flowOwnsTheTurn({ text: '/battle a vs b', members: PAIR, isOneToOne: true })).toBe(true);
    expect(flowOwnsTheTurn({ text: '/battle a vs b', members: ROOM, isOneToOne: false })).toBe(true);
  });

  it('is not vacuous: a group message nobody addressed is still nobody\'s turn', () => {
    // If the one-to-one return had been widened into "always true", every assertion above that expects
    // true would still pass. This one fails in that case, which is what makes the rest mean something.
    expect(flowOwnsTheTurn({ text: 'plain prose', members: ROOM, isOneToOne: false })).toBe(false);
  });
});

describe('the entry is an invariant, not a profile setting', () => {
  it('has no per-profile turn entry left to disagree about', () => {
    // `turnEntry` was removed on 2026-09-17 along with `entryVariesByProfile` and `sharedTurnEntry`.
    // Asserted structurally so re-adding it as a profile field fails here rather than quietly
    // reintroducing a value the provisioned bot and the runtime can disagree about.
    for (const c of defaultProfileRegistry.classificationValues()) {
      const profile = defaultProfileRegistry.profileFor(c) as unknown as Record<string, unknown>;
      expect(`${c} declares a turn entry: ${'turnEntry' in profile}`).toBe(`${c} declares a turn entry: false`);
    }
    expect('entryVariesByProfile' in defaultProfileRegistry).toBe(false);
    expect('sharedTurnEntry' in defaultProfileRegistry).toBe(false);
  });

  it('no longer carries the probe classification, which existed only to vary the entry', () => {
    expect(defaultProfileRegistry.classificationValues()).not.toContain('probe');
  });
});
