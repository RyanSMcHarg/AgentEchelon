/**
 * parseBattleClarification — SPEC-BATTLE.md "Clarification Routing".
 *
 * Whether a battle model asks for clarification vs. forges ahead is a
 * MEASURED dimension (see project_battle_clarification), so detection
 * is an explicit model sentinel (mirrors NO_REBUTTAL), never substring
 * inference. These pins matter: a false positive strands a bot in
 * WAITING_FOR_USER forever; a false negative force-completes a bot that
 * actually needed input and skips the clarification count.
 */
import {
  parseBattleClarification,
  planBattleClarificationDelivery,
} from '../../lambda/src/lib/async-processor-core';

describe('parseBattleClarification', () => {
  it('a complete answer with no sentinel → not clarification', () => {
    expect(parseBattleClarification('Here is the full report on Q3 revenue. ...')).toEqual({
      needsClarification: false,
    });
  });

  it('empty / whitespace → not clarification', () => {
    expect(parseBattleClarification('').needsClarification).toBe(false);
    expect(parseBattleClarification('   \n  ').needsClarification).toBe(false);
  });

  it('token form: question then trailing sentinel line → question extracted', () => {
    const r = parseBattleClarification(
      'Which fiscal quarter should the report cover — Q3 or Q4?\nNEED_CLARIFICATION',
    );
    expect(r.needsClarification).toBe(true);
    expect(r.question).toBe('Which fiscal quarter should the report cover — Q3 or Q4?');
  });

  it('token form: leading sentinel line then question → question extracted', () => {
    const r = parseBattleClarification('NEED_CLARIFICATION\n\nWhich region: EMEA or APAC?');
    expect(r.needsClarification).toBe(true);
    expect(r.question).toBe('Which region: EMEA or APAC?');
  });

  it('token form tolerates case, _/space, and trailing punctuation (like NO_REBUTTAL)', () => {
    for (const tok of [
      'need clarification',
      'NEED CLARIFICATION',
      'Need_Clarification.',
      'NEED_CLARIFICATION:',
      'NEED_CLARIFICATION!',
    ]) {
      const r = parseBattleClarification(`What scope did you have in mind?\n${tok}`);
      expect(r.needsClarification).toBe(true);
      expect(r.question).toBe('What scope did you have in mind?');
    }
  });

  it('lone sentinel, no question text → needsClarification true, question undefined', () => {
    expect(parseBattleClarification('NEED_CLARIFICATION')).toEqual({
      needsClarification: true,
      question: undefined,
    });
  });

  it('substring guard: prose merely MENTIONING clarification → not clarification', () => {
    // The sentinel must own its line; a sentence containing the words
    // can never false-positive (this is the whole point of an anchored
    // sentinel vs. keyword matching).
    expect(
      parseBattleClarification(
        'You may need clarification on the exact scope, but here is my best complete answer: ...',
      ).needsClarification,
    ).toBe(false);
    expect(
      parseBattleClarification('Answer: 42. NEED_CLARIFICATION if you disagree.').needsClarification,
    ).toBe(false);
  });

  it('JSON form: {needsClarification:true, question} → parsed', () => {
    const r = parseBattleClarification('{"needsClarification":true,"question":"Which quarter?"}');
    expect(r).toEqual({ needsClarification: true, question: 'Which quarter?' });
  });

  it('JSON form: {clarification:"..."} → parsed', () => {
    const r = parseBattleClarification('{"clarification":"Which region — EMEA or APAC?"}');
    expect(r).toEqual({ needsClarification: true, question: 'Which region — EMEA or APAC?' });
  });

  it('JSON answer object that is NOT a clarification → not clarification', () => {
    expect(parseBattleClarification('{"answer":"42"}').needsClarification).toBe(false);
  });

  it('JSON-looking but invalid, with a sentinel line → falls through to token form', () => {
    const r = parseBattleClarification('{ this is not valid json\nNEED_CLARIFICATION');
    expect(r.needsClarification).toBe(true);
  });
});

describe('planBattleClarificationDelivery', () => {
  const BATTLE_ID = 'a1b2c3d4e5f60718';
  const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/AltSlot0';
  const USER = 'arn:aws:chime:us-east-1:111:app-instance/i/user/u-123';
  const QUESTION = 'Which fiscal quarter should the report cover — Q3 or Q4?';

  it('placeholder is a neutral waiting state — NEVER the question', () => {
    const d = planBattleClarificationDelivery({
      battleId: BATTLE_ID,
      botArn: BOT,
      senderArn: USER,
      question: QUESTION,
    });
    expect(d.waitingPlaceholderContent).toContain('waiting for your response');
    // The question must not leak into the broadcast placeholder.
    expect(d.waitingPlaceholderContent).not.toContain(QUESTION);
    expect(d.waitingPlaceholderContent).not.toContain('Q3');
  });

  it('placeholder carries the battlewaiting marker, shaped like battlestats/battle', () => {
    const d = planBattleClarificationDelivery({ battleId: BATTLE_ID, botArn: BOT, senderArn: USER });
    expect(d.waitingPlaceholderContent).toContain(
      `<!--battlewaiting:battleId=${BATTLE_ID},botArn=${BOT}-->`,
    );
  });

  it('question is targeted to the invoking user only', () => {
    const d = planBattleClarificationDelivery({
      battleId: BATTLE_ID,
      botArn: BOT,
      senderArn: USER,
      question: QUESTION,
    });
    expect(d.targetedQuestion).toEqual({ content: QUESTION, targetMemberArn: USER });
  });

  it('no senderArn → targetedQuestion null but placeholder still produced', () => {
    const d = planBattleClarificationDelivery({ battleId: BATTLE_ID, botArn: BOT, question: QUESTION });
    expect(d.targetedQuestion).toBeNull();
    expect(d.waitingPlaceholderContent).toContain('waiting for your response');
  });

  it('absent/empty question → a sensible fallback ask (lone-sentinel case)', () => {
    for (const q of [undefined, '', '   ']) {
      const d = planBattleClarificationDelivery({
        battleId: BATTLE_ID,
        botArn: BOT,
        senderArn: USER,
        question: q,
      });
      expect(d.targetedQuestion?.content).toMatch(/clarify/i);
      expect(d.targetedQuestion?.targetMemberArn).toBe(USER);
    }
  });
});
