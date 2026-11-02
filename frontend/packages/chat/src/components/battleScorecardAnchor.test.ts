/**
 * ONE DUEL, ONE SCORECARD - however the conversation is interleaved.
 *
 * The rule this covers shipped wrong: it anchored to the last message of a CONTIGUOUS RUN of a
 * battleId, so any message arriving between a duel's own messages split it into blocks and each block
 * rendered the same scorecard again. Three appeared for one duel on a live run.
 *
 * The cases below are the interleavings that actually occur, not invented ones: a person speaking
 * mid-duel, a refused second `/battle`, and round 2 landing after both.
 */
import { describe, it, expect } from 'vitest';
import { battleOf, lastMessageIndexByBattleId, messagesById, opensRound2, type BattleAnchorable } from './battleScorecardAnchor';

const inBattle = (battleId: string): BattleAnchorable => ({ battle: { battleId } });
const plain = (): BattleAnchorable => ({});

/** The anchor predicate exactly as the component applies it. */
const anchors = (messages: BattleAnchorable[]): number[] => {
  const last = lastMessageIndexByBattleId(messages);
  return messages
    .map((m, i) => (m.battle?.battleId && last.get(m.battle.battleId) === i ? i : -1))
    .filter((i) => i >= 0);
};

describe('a duel anchors its scorecard once', () => {
  it('on a contiguous duel, at its last message', () => {
    expect(anchors([plain(), inBattle('b1'), inBattle('b1'), plain()])).toEqual([2]);
  });

  it('when the person speaks in the MIDDLE of the duel', () => {
    // The case the old rule broke on. Two blocks, and it anchored both.
    const messages = [inBattle('b1'), inBattle('b1'), plain(), inBattle('b1'), inBattle('b1')];
    expect(anchors(messages)).toEqual([4]);
  });

  it('when a refused second /battle is interleaved, then round 2 arrives', () => {
    // The single-active-battle shape, which is what produced three scorecards live: round 1's two
    // sides, the person's second /battle, its refusal, then round 2's two rebuttals.
    const messages = [
      inBattle('b1'), inBattle('b1'), // round 1, both sides
      plain(), plain(),               // the second /battle and the explained refusal
      inBattle('b1'), inBattle('b1'), // round 2, both rebuttals
    ];
    expect(anchors(messages)).toEqual([5]);
  });

  it('anchors each of two SEPARATE duels once, at its own end', () => {
    // The split must still happen where it is real: two battles are two scorecards.
    const messages = [inBattle('b1'), inBattle('b1'), plain(), inBattle('b2'), inBattle('b2')];
    expect(anchors(messages)).toEqual([1, 4]);
  });

  it('anchors interleaved duels to their own last message, not to the run boundary', () => {
    // Pathological but possible while one duel is ending as another begins.
    const messages = [inBattle('b1'), inBattle('b2'), inBattle('b1'), inBattle('b2')];
    expect(anchors(messages)).toEqual([2, 3]);
  });

  it('anchors nothing when no message belongs to a battle', () => {
    expect(anchors([plain(), plain()])).toEqual([]);
  });

  it('ignores a battle object carrying no id rather than keying on undefined', () => {
    // A malformed marker must not collapse every such message into one shared key, which would
    // anchor a scorecard onto an unrelated message.
    const messages: BattleAnchorable[] = [{ battle: {} }, { battle: null }, inBattle('b1')];
    expect(anchors(messages)).toEqual([2]);
  });
});

/**
 * A LONG ANSWER'S TAIL IS PART OF THE DUEL.
 *
 * An answer past one message's budget is posted as the answer plus continuation parts, and only the
 * answer carries the battle marker. Seen live: a long round-1 answer's tail sat between round 1 and
 * round 2, so the "Round 2 - rebuttals" divider never rendered.
 */
describe('a continuation part belongs to the answer it continues', () => {
  const answer = (id: string, battleId: string, round: number): BattleAnchorable =>
    ({ id, battle: { battleId, round } });
  const tail = (id: string, parentMessageId: string): BattleAnchorable =>
    ({ id, continuation: true, parentMessageId });

  it("takes the parent's battle", () => {
    const messages = [answer('a', 'b1', 1), tail('t', 'a')];
    expect(battleOf(messages[1], messagesById(messages))).toEqual({ battleId: 'b1', round: 1 });
  });

  it('a plain message, or a part whose parent is not loaded, belongs to no battle', () => {
    const messages = [{ id: 'p' }, tail('t', 'missing')];
    const byId = messagesById(messages);
    expect(battleOf(messages[0], byId)).toBeUndefined();
    expect(battleOf(messages[1], byId)).toBeUndefined();
  });

  it('the round-2 divider renders after the tail of a long round-1 answer', () => {
    const messages = [answer('a1', 'b1', 1), answer('b1r1', 'b1', 1), tail('t', 'b1r1'), answer('r2', 'b1', 2)];
    const byId = messagesById(messages);
    expect(opensRound2(messages[3], messages[2], byId)).toBe(true);
  });

  it('the divider still renders only at the round-1 to round-2 boundary', () => {
    const messages = [answer('a', 'b1', 2), tail('t', 'a'), answer('b', 'b1', 2), answer('c', 'b2', 2)];
    const byId = messagesById(messages);
    expect(opensRound2(messages[2], messages[1], byId)).toBe(false); // round 2 after round 2
    expect(opensRound2(messages[3], messages[2], byId)).toBe(false); // a different duel
    expect(opensRound2(messages[0], null, byId)).toBe(false);
  });

  it("the scorecard anchors after the tail of the duel's last answer, not above it", () => {
    const messages = [answer('a', 'b1', 1), answer('b', 'b1', 1), answer('c', 'b1', 2), tail('t', 'c'), { id: 'p' }];
    expect(lastMessageIndexByBattleId(messages).get('b1')).toBe(3);
  });
});
