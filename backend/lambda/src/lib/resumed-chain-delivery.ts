/**
 * WHERE A RESUMED CHAIN'S TWO MESSAGES GO (owner, 2026-08-14).
 *
 * When a person's message resumes work an assistant was holding, the turn always produces the same
 * pair: the ANSWER, untargeted, because a duel is a comparison and a task step's result belongs to the
 * conversation; and a RECEIPT, targeted at the person who spoke, because it is a confirmation for them
 * and not news for everyone else. One shape, whatever the inbound looked like.
 *
 * IT IS A DECISION AND NOT AN INHERITANCE, which is why it lives in a function with a name. Amazon
 * Chime SDK gives a Lex reply the INBOUND message's targeting, so left alone the pair inverts with how
 * the person happened to send:
 *
 * | The person's message | What inheritance produces | What is wrong with it |
 * |---|---|---|
 * | Targeted at the assistant | A private placeholder | The answer is buried where only its sender can read it |
 * | Untargeted | A public placeholder | The receipt is broadcast, so the channel gets the answer AND a note saying the answer is elsewhere |
 *
 * Both were observed live. So the planner reads which of the two messages the placeholder ALREADY is,
 * and names the one that still has to be posted. Exactly one of the two flags is ever set: the pair is
 * two messages, never one and never three.
 */

/**
 * The receipt a person gets when their message resumed work an assistant was holding.
 *
 * ONE string, because the branch that reuses the placeholder and the branch that posts a new message
 * are the same statement made in different circumstances, and two copies of a sentence are how the
 * private and public halves of a pattern drift into saying different things. It says where the answer
 * is, because a receipt only its sender can see is otherwise indistinguishable from the answer having
 * gone nowhere - which is exactly what a person concluded when the placeholder was left saying "one
 * moment" forever, next to an answer it never received.
 */
export const RESUMED_CHAIN_ACKNOWLEDGEMENT =
  'Thanks - picking that back up. My answer is in the conversation.';

export interface ResumedChainDelivery {
  /** Post a NEW untargeted message to carry the answer; the placeholder is left as the receipt. */
  broadcastTheAnswer: boolean;
  /** Post a NEW message targeted at the person to carry the receipt; the placeholder holds the answer. */
  targetTheReceipt: boolean;
}

export function planResumedChainDelivery(args: {
  /** This turn resumed a chain an assistant was holding. False ⇒ an ordinary turn, which owes neither. */
  resumedChain?: boolean;
  /**
   * Somebody already gave the person their receipt, so this turn owes only the answer.
   *
   * The handover case: the assistant the person ADDRESSED does not own the chain, so it acknowledges
   * with copy of its own - naming the assistant the work went to - and hands the turn over. Without
   * this the person gets two receipts for one message, the second contradicting the first about who is
   * acting.
   */
  receiptAlreadyGiven?: boolean;
  /** Whether the message this turn would otherwise answer onto carries a Chime `Target`. */
  placeholderIsTargeted: boolean;
}): ResumedChainDelivery {
  if (!args.resumedChain) return { broadcastTheAnswer: false, targetTheReceipt: false };
  return {
    // A private placeholder cannot hold the answer, whoever gave the receipt.
    broadcastTheAnswer: args.placeholderIsTargeted,
    // ...but a public one only needs a receipt posted beside it when nobody has given one yet.
    targetTheReceipt: !args.placeholderIsTargeted && !args.receiptAlreadyGiven,
  };
}
