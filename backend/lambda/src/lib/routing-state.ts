/**
 * Does a person's reply read as a yes or a no? The classifier a confirmation step reads, such as the onboarding intake's
 * summary (`onboarding-intake.ts`).
 */

// Whole-utterance acks: a bare confirmation/decline, optionally with trailing
// punctuation. Kept strict so a verb-y token ("switch", "navigate", "do it")
// only confirms when it IS the whole reply — "switch to dark mode" is a request,
// not a confirmation, and must stay ambiguous.
const AFFIRMATIVE_EXACT = /^\s*(yes|yeah|yep|yup|sure|ok|okay|please do|do it|go ahead|sounds good|let'?s do it|create it|switch|navigate)\s*[.!]*\s*$/i;
const NEGATIVE_EXACT = /^\s*(no|nope|nah|not now|don'?t|stay here|keep going|continue|stay|cancel|nevermind)\s*[.!]*\s*$/i;

// Brief natural affirmative: a strong yes-word at the LEAD followed by a short
// tail — "yes please", "ok create it", "sure, go ahead". This is the fix for the
// bare-ack case: the old `$`-anchored form accepted exactly one token and dropped
// "yes please" to ambiguous → no channel created. Only the unambiguous yes-words
// lead here (not the verb-y phrase tokens), and the tail is length-capped so a
// multi-clause reply ("yes please tell me about both") stays ambiguous rather
// than auto-creating a channel the user didn't clearly ask for. Question marks
// disqualify (a question isn't a confirmation). SPEC-DRIFT-CONVERGENCE.md
// §Live-Suggestion Flow lists these as confirmations.
const AFFIRMATIVE_LEAD = /^\s*(yes|yeah|yep|yup|sure|ok|okay)\b/i;
const MAX_ACK_TAIL_WORDS = 3;

export type ReplyClassification = 'affirmative' | 'negative' | 'ambiguous';

export function classifyConfirmDeclineReply(text: string): ReplyClassification {
  const trimmed = (text || '').trim();
  if (!trimmed) return 'ambiguous';
  if (NEGATIVE_EXACT.test(trimmed)) return 'negative';
  if (AFFIRMATIVE_EXACT.test(trimmed)) return 'affirmative';
  // Brief leading yes-word ("yes please") — short tail, not a question.
  const lead = AFFIRMATIVE_LEAD.exec(trimmed);
  if (lead && !trimmed.includes('?')) {
    const tail = trimmed.slice(lead[0].length).trim();
    const tailWords = tail ? tail.split(/\s+/).length : 0;
    if (tailWords <= MAX_ACK_TAIL_WORDS) return 'affirmative';
  }
  return 'ambiguous';
}
