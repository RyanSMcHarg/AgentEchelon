import { shippedLineText, templateLine } from './message-lines.js';
/**
 * WHERE A TURN'S REPLY GOES, AND WHO MAY READ IT.
 *
 * Three rules, in the person's terms:
 *
 *  - SHARED WORK, PUBLIC MESSAGE, PUBLIC REPLY. In a group a public message reaches an assistant only
 *    when it names one (`@`) or names the item (`#n`), so the reply goes right under it where the room
 *    can read it, and nothing else is sent. A private note beside it saying "my answer is in the
 *    conversation" repeated what the person could already see.
 *  - PRIVATE MESSAGE, PRIVATE REPLY. A message sent privately is answered privately, in the placeholder
 *    Amazon Chime SDK already targeted back at the person.
 *  - PRIVATE WORK, PRIVATE DETAILS. Anything about a private item goes only in messages targeted at the
 *    person. When their message was public, the answer is posted as a new message targeted at them,
 *    and the public placeholder says only that they were answered privately.
 *
 * A DUEL IS THE EXCEPTION, because it is a comparison: a side's answer is always public, so a side
 * answered privately still posts its answer to the room, and its private placeholder becomes the
 * person's receipt.
 */

/**
 * The receipt a person gets when they answered a duel side privately and its answer was posted to the
 * conversation, when what the side posted is an ANSWER.
 *
 * It says where the output is, because a receipt only its sender can see is otherwise
 * indistinguishable from the answer having gone nowhere - which is exactly what a person concluded
 * when the placeholder was left saying "one moment" forever, next to an answer it never received.
 */
export const RESUMED_CHAIN_ACKNOWLEDGEMENT = shippedLineText('resumed-chain-answered');

/**
 * The same receipt when what the turn posted is a QUESTION: a resumed step that needs more before it
 * can answer. Pointing a person at "my answer" there sends them looking for something that does not
 * exist yet, next to a question they have not noticed is waiting on them.
 */
export const RESUMED_CHAIN_QUESTION_ACKNOWLEDGEMENT = shippedLineText('resumed-chain-asked');

/** What the turn actually put in the conversation, which is what the receipt has to point at. */
export type ResumedChainPosted = 'answer' | 'question';

/**
 * THE RECEIPT, PICKED BY WHAT WAS POSTED, IN THE ASSISTANT'S OWN WORDS.
 *
 * ONE picker, because the branch that reuses the placeholder and the branch that posts a new message
 * are the same statement made in different circumstances, and two call sites choosing their own
 * sentence is how the private and public halves of a pattern drift into saying different things.
 *
 * The variant authors both lines (`resumedChainAnswered`, `resumedChainAsked`): this is copy a person
 * reads, so it carries the persona and the conversation's language rather than fixed English (tenets
 * 5, 6 and 11). The shipped lines are the fallback where a variant configured none.
 */
export function resumedChainReceipt(
  posted: ResumedChainPosted,
  copy?: { resumedChainAnswered?: string; resumedChainAsked?: string },
): string {
  return templateLine(posted === 'question' ? 'resumed-chain-asked' : 'resumed-chain-answered', { copy });
}

export interface ResumedChainDelivery {
  /** Post a NEW untargeted message for the answer; the private placeholder becomes the receipt. Duels only. */
  broadcastTheAnswer: boolean;
  /** Post a NEW message targeted at the person for the answer; the public placeholder says only that. */
  targetTheAnswer: boolean;
}

export function planResumedChainDelivery(args: {
  /** This turn resumed a chain an assistant was holding. */
  resumedChain?: boolean;
  /** The resumed chain is a duel side, whose answer is public whatever the inbound looked like. */
  isDuel?: boolean;
  /** The work this turn answers is private: its details go only in targeted messages. */
  taskIsPrivate?: boolean;
  /** Whether the message this turn would otherwise answer onto carries a Chime `Target`. */
  placeholderIsTargeted: boolean;
}): ResumedChainDelivery {
  // A private item answered from a public message: the details go to the person alone. Checked first,
  // and for every turn rather than only a resumed one, because the rule is about the work, not the path.
  //
  // PRIVATE BEATS DUEL, DELIBERATELY. A code review read the duel rule's "public whatever the inbound
  // looked like" and proposed deciding duels first; the test beside this file already pins the
  // opposite, and it is right - a comparison is not a reason to publish somebody's private work. The
  // real defect the review found is upstream: `readTaskVisibility` reads an ABSENT visibility as
  // private, so a duel task created without stating one arrived here looking private. That is fixed
  // where the task is written, by saying `conversation` out loud, rather than by weakening this rule.
  if (args.taskIsPrivate && !args.placeholderIsTargeted) {
    return { broadcastTheAnswer: false, targetTheAnswer: true };
  }
  // A duel side answered privately still owes the room its answer.
  if (args.resumedChain && args.isDuel && args.placeholderIsTargeted && !args.taskIsPrivate) {
    return { broadcastTheAnswer: true, targetTheAnswer: false };
  }
  // Everything else answers where the person spoke: public in public, private in private.
  return { broadcastTheAnswer: false, targetTheAnswer: false };
}

/** The default public line when a private item was answered privately from a public message. */
export const ANSWERED_PRIVATELY = shippedLineText('answered-privately');
