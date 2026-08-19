/**
 * The normalized delivery pattern for a resumed chain (owner, 2026-08-14).
 *
 * The rule is one sentence - the answer is untargeted, the receipt is targeted at the person, always -
 * and every test here is a way of getting that wrong that actually happened on the deployment. The
 * failures it guards are all SILENT: each one delivers a message, so nothing errors, and the only
 * symptom is a person reading the wrong thing in the wrong place.
 */
import {
  planResumedChainDelivery,
  RESUMED_CHAIN_ACKNOWLEDGEMENT,
} from '../../lambda/src/lib/resumed-chain-delivery';

describe('planResumedChainDelivery', () => {
  it('gives the answer its own public message when the placeholder is PRIVATE', () => {
    // The person answered the assistant privately, so Amazon Chime SDK targeted this turn's reply back
    // at them. Answering in place buries a duel's answer where only one member can read it, and a duel
    // nobody can compare is not a duel.
    expect(planResumedChainDelivery({ resumedChain: true, placeholderIsTargeted: true })).toEqual({
      broadcastTheAnswer: true,
      targetTheReceipt: false,
    });
  });

  it('gives the receipt its own targeted message when the placeholder is PUBLIC', () => {
    // The inverse case, and the one the shipped gate got wrong by skipping the split entirely. The
    // placeholder is already public, so it IS the answer; what is missing is the private receipt, and
    // there is no inbound target to inherit it from.
    expect(planResumedChainDelivery({ resumedChain: true, placeholderIsTargeted: false })).toEqual({
      broadcastTheAnswer: false,
      targetTheReceipt: true,
    });
  });

  it('never posts two public messages', () => {
    // WHAT THE SHIPPED GATE WAS REACTING TO, and the reason it was the wrong fix rather than no fix.
    // Broadcasting from an already-public placeholder put the answer in the channel AND a note beside
    // it saying the answer was elsewhere. Observed live on an alt-slot resume.
    const publicPlaceholder = planResumedChainDelivery({ resumedChain: true, placeholderIsTargeted: false });
    expect(publicPlaceholder.broadcastTheAnswer).toBe(false);
  });

  it('posts exactly one message in every resumed case, never two and never none', () => {
    // The pair is always two messages: one the placeholder already is, one this turn posts. Both flags
    // set would make three; neither would leave the pair incomplete in whichever direction the
    // placeholder happened to point.
    for (const placeholderIsTargeted of [true, false]) {
      const plan = planResumedChainDelivery({ resumedChain: true, placeholderIsTargeted });
      expect(Number(plan.broadcastTheAnswer) + Number(plan.targetTheReceipt)).toBe(1);
    }
  });

  it('owes nothing on an ordinary turn', () => {
    // The negative control. Without it every assertion above could pass on a planner that fired on
    // every turn in the deployment, and the first symptom would be a receipt on turns that resumed
    // nothing.
    for (const placeholderIsTargeted of [true, false]) {
      expect(planResumedChainDelivery({ placeholderIsTargeted })).toEqual({
        broadcastTheAnswer: false,
        targetTheReceipt: false,
      });
      expect(planResumedChainDelivery({ resumedChain: false, placeholderIsTargeted })).toEqual({
        broadcastTheAnswer: false,
        targetTheReceipt: false,
      });
    }
  });

  describe('when the receipt was already given (the handover case)', () => {
    it('does not give a second receipt', () => {
      // The assistant the person ADDRESSED already acknowledged, naming the assistant the work went to.
      // A second receipt from that assistant tells the person their one message was picked up twice,
      // by two assistants, with the second contradicting the first about who is acting.
      expect(planResumedChainDelivery({
        resumedChain: true,
        receiptAlreadyGiven: true,
        placeholderIsTargeted: false,
      })).toEqual({ broadcastTheAnswer: false, targetTheReceipt: false });
    });

    it('still puts the answer somewhere public', () => {
      // The half that is NOT excused by the receipt. Who acknowledged has no bearing on where the
      // answer belongs: a private placeholder still cannot hold it.
      expect(planResumedChainDelivery({
        resumedChain: true,
        receiptAlreadyGiven: true,
        placeholderIsTargeted: true,
      }).broadcastTheAnswer).toBe(true);
    });
  });

  it('says where the answer is, in the receipt itself', () => {
    // A receipt only its sender can see, that does not say where the answer went, is indistinguishable
    // from the answer having gone nowhere - which is what a person concluded when the placeholder was
    // left saying "one moment" forever.
    expect(RESUMED_CHAIN_ACKNOWLEDGEMENT).toMatch(/conversation/i);
  });
});
