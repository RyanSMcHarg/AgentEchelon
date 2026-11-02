/**
 * Where a resumed chain's reply goes: where the person spoke, except a duel side
 * answered privately, whose answer is public. Every test here is a way of getting that wrong that
 * actually happened on the deployment. The
 * failures it guards are all SILENT: each one delivers a message, so nothing errors, and the only
 * symptom is a person reading the wrong thing in the wrong place.
 */
import { ownWords } from '../helpers/own-templates';
import {
  planResumedChainDelivery,
  RESUMED_CHAIN_ACKNOWLEDGEMENT,
  RESUMED_CHAIN_QUESTION_ACKNOWLEDGEMENT,
  resumedChainReceipt,
} from '../../lambda/src/lib/resumed-chain-delivery';

describe('planResumedChainDelivery', () => {
  // The full rule, including private work, is exercised end to end in
  // a-reply-goes-where-the-work-lives.test.ts. These are the cases the old pair shipped and got wrong.
  it('answers shared work where the person spoke, with no receipt, public or private', () => {
    for (const placeholderIsTargeted of [true, false]) {
      expect(planResumedChainDelivery({ resumedChain: true, placeholderIsTargeted }))
        .toEqual({ broadcastTheAnswer: false, targetTheAnswer: false });
    }
  });

  it('still gives a duel side answered privately a public message for its answer', () => {
    // A duel is a comparison, and a duel nobody can compare is not a duel.
    expect(planResumedChainDelivery({ resumedChain: true, isDuel: true, placeholderIsTargeted: true }))
      .toEqual({ broadcastTheAnswer: true, targetTheAnswer: false });
  });

  it('never posts two public messages', () => {
    // Broadcasting from an already-public placeholder put the answer in the channel AND a note beside
    // it saying the answer was elsewhere. Observed live on an alt-slot resume.
    expect(planResumedChainDelivery({ resumedChain: true, isDuel: true, placeholderIsTargeted: false }).broadcastTheAnswer)
      .toBe(false);
  });

  it('owes nothing on an ordinary turn about shared work', () => {
    for (const placeholderIsTargeted of [true, false]) {
      expect(planResumedChainDelivery({ placeholderIsTargeted }))
        .toEqual({ broadcastTheAnswer: false, targetTheAnswer: false });
    }
  });

  it('says where the answer is, in the duel receipt itself', () => {
    expect(RESUMED_CHAIN_ACKNOWLEDGEMENT).toMatch(/conversation/i);
  });
});

/**
 * THE RECEIPT POINTS AT WHAT WAS ACTUALLY POSTED, IN THE ASSISTANT'S WORDS.
 *
 * One constant said "My answer is in the conversation" on a turn that had posted a QUESTION, sending
 * the person looking for an answer that did not exist yet. The variant authors both lines; the code
 * picks by what the turn posted.
 */
describe('resumedChainReceipt', () => {
  it('points at the answer when an answer was posted', () => {
    expect(resumedChainReceipt('answer')).toBe(RESUMED_CHAIN_ACKNOWLEDGEMENT);
  });

  it('points at the question when a question was posted, never at "my answer"', () => {
    expect(resumedChainReceipt('question')).toBe(RESUMED_CHAIN_QUESTION_ACKNOWLEDGEMENT);
    expect(RESUMED_CHAIN_QUESTION_ACKNOWLEDGEMENT).not.toMatch(/answer/i);
    expect(RESUMED_CHAIN_QUESTION_ACKNOWLEDGEMENT).toMatch(/conversation/i);
  });

  it('uses the assistant\'s own template for each, per key', () => {
    const copy = ownWords({ resumedChainAnswered: 'Réponse publiée.', resumedChainAsked: 'Question posée.' });
    expect(resumedChainReceipt('answer', copy)).toBe('Réponse publiée.');
    expect(resumedChainReceipt('question', copy)).toBe('Question posée.');
    // Wording one line does not blank the other.
    expect(resumedChainReceipt('question', ownWords({ resumedChainAnswered: 'x' }))).toBe(RESUMED_CHAIN_QUESTION_ACKNOWLEDGEMENT);
  });

  it('is the only way the processor chooses the receipt', () => {
    const core = require('fs').readFileSync(
      require('path').join(__dirname, '../../lambda/src/lib/async-processor-core.ts'), 'utf8');
    expect(core).not.toContain('RESUMED_CHAIN_ACKNOWLEDGEMENT');
    expect(core).toContain("resumedChainReceipt(phase === 'final' ? 'answer' : 'question', copy)");
  });
});
