/**
 * ACTING ON A SPLIT THE PERSON CHOSE (DESIGN 2.4.2).
 *
 * The reading names the subjects a queue turned out to cover, and the assistant offers to continue
 * any of them somewhere else. This is the other half: the answer arrives on a LATER turn, in ordinary
 * words ("just the billing one", "both", "no, leave it"), and something has to turn that into
 * conversations without turning it into the wrong ones.
 *
 * ── THE SELECTION IS DECLARED, NOT INFERRED FROM PROSE ───────────────────────────────────────────
 *
 * The same rule the `TRIAGE:` lines follow, for the same reason. A reply that merely SOUNDS like
 * agreement is not a choice of subjects, and reading "yes" as "all of them" is the assistant deciding
 * the part the person was asked to decide. So the model is asked to declare what it heard, against
 * the labels it actually offered, and anything outside that closed set is refused rather than guessed.
 *
 * ── AND NOTHING IS CREATED THAT WAS NOT NAMED ────────────────────────────────────────────────────
 *
 * A label the offer never contained cannot be selected, even if the model emits one. Creating a
 * conversation about a subject nobody put on the table is not a near miss - it is a room the person
 * did not ask for, holding messages they did not send there.
 */

import type { PendingSplitOffer } from './turn-lock.js';
import { sessionClient } from './assistant-session.js';

export type OfferedTopic = PendingSplitOffer['topics'][number];

const SPLIT_LINE = /^[ \t]*SPLIT[ \t]*:[ \t]*(.+)$/gim;
const NONE = 'none';

export type SplitSelection =
  /** They were asked and said no. A complete answer, and the one that must be easy to give. */
  | { kind: 'declined' }
  /** These subjects, and only these, continue elsewhere. */
  | { kind: 'selected'; topics: OfferedTopic[] };

/**
 * What the person chose, or null when this reply is not an answer to the offer at all.
 *
 * NULL LEAVES THE OFFER STANDING, which is the right reading of silence. Somebody who was asked
 * whether to split and simply carried on talking has not declined - they have not answered - and
 * treating that as "no" quietly disposes of a question they may still come back to.
 */
/**
 * WHAT THE PERSON SAID, when the model did not say it for them.
 *
 * `parseSplitSelection` reads the machine line the assistant was asked to emit. Live, on a deployed
 * turn with the offer in front of it and an unambiguous answer to read, the model wrote 2102
 * characters of reply and no SPLIT line at all - so the offer stayed open, the person watched
 * nothing happen, and they could be asked the same question again. Two prompt revisions did not fix
 * that, and a third would be a guess.
 *
 * The offer does not need the model. Its labels are a CLOSED SET this system wrote down, and the
 * person answers in their own words in a message we already have. This reads those words directly.
 *
 * IT IS DELIBERATELY CONSERVATIVE, because the failure it must never have is splitting a
 * conversation nobody asked to split. Naming a subject is NOT enough - "what was our Q3 headcount
 * again?" mentions a label while answering nothing. So a selection needs BOTH:
 *   1. an intent to separate - split, separate, move, its own conversation - or an explicit refusal,
 *   2. and a label it can name.
 * Anything less returns null, which leaves the offer standing, which is what silence means.
 *
 * The model line still WINS when it exists: this runs only when that parse found nothing.
 */
const SEPARATE_INTENT = /\b(split|separate|move|moving|its own|their own|new conversation|another conversation|different conversation)\b/i;
const REFUSED_INTENT = /\b(no thanks|no thank you|leave (it|them|everything|it all) (here|together|alone)|keep (it|them|everything) (here|together)|don'?t split|do not split|not now|all here)\b/i;

export function selectionFromTheirWords(message: string, offered: OfferedTopic[]): SplitSelection | null {
  const text = (message ?? '').trim();
  if (!text || !offered.length) return null;

  // A refusal is checked FIRST, because "leave the rest here" contains a separate-intent word and
  // is still, on its own, a decision to move nothing.
  const refuses = REFUSED_INTENT.test(text);
  const separates = SEPARATE_INTENT.test(text);
  if (!refuses && !separates) return null;

  const lower = text.toLowerCase();
  // A label counts as named when every one of its distinctive words appears. Whole-label matching
  // alone is too brittle - a person writes "Q3 headcount", not "Q3 headcount lookup" - and matching
  // any single word is far too loose, since one shared word like "page" would select a subject.
  const wordsOf = (label: string): string[] => label.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const matched = offered.filter((topic) => {
    const parts = wordsOf(topic.label);
    if (!parts.length) return false;
    return parts.every((w) => lower.includes(w));
  });

  // ── A SUBSET LABEL IS NOT A SECOND SUBJECT (code review, 2026-09-04) ──────────────────────────
  //
  // Matching is per WORD, so a label whose words are all contained in another label always matches
  // alongside it. Offered "the Q3 report" and "the Q3 report timeline", somebody writing "move the Q3
  // report timeline into its own conversation" matched BOTH, and this fallback then split two
  // subjects when they had named one.
  //
  // That is the invariant this file exists for - never split something nobody named - failing in the
  // path taken whenever the model omits its `SPLIT:` line, which is the common case.
  //
  // The longer label wins because it is the more specific reading of the same words: every word of
  // the shorter one is already accounted for by it, so keeping both would be counting one phrase
  // twice. A label that shares only SOME words with another is untouched - those are genuinely two
  // subjects and both were named.
  const named = matched.filter((topic) => {
    const mine = wordsOf(topic.label);
    return !matched.some((other) => {
      if (other === topic) return false;
      const theirs = wordsOf(other.label);
      // Strictly longer, and containing every word of this one.
      return theirs.length > mine.length && mine.every((w) => theirs.includes(w));
    });
  });

  // ── A REFUSAL OUTRANKS A NAME (code review, 2026-09-04) ────────────────────────────────────────
  //
  // This returned `selected` on any named label before ever consulting `refuses`, so "no, don't split
  // the Q3 headcount question - keep it here" named a label, matched, and SPLIT IT. The comment above
  // says a refusal is checked first, and it was computed first and then not used: the assistant did
  // the exact thing the person had just said not to do, and the offer was cleared so they could not
  // say it again.
  //
  // It matters more here than anywhere else in this file, because this is the fallback that handles
  // the common case - the model omitting the SPLIT: line - so it runs on ordinary replies.
  // A REFUSAL WINS OUTRIGHT, whether or not they named a subject and whether or not the sentence also
  // contains a moving word. It has to: the commonest refusal there is - "don't split that" - contains
  // the word "split", so it matches BOTH patterns, and any rule that treats the overlap as ambiguous
  // discards the plainest answer a person can give.
  //
  // Naming the subject they are protecting is not asking for it to move. "Don't split the headcount"
  // and "no thanks" are one decision: move nothing.
  //
  // The rare genuine mix - "don't split the headcount, but move pricing" - is declined rather than
  // half-obeyed, and the offer being cleared is what makes that safe to say out loud: they can ask
  // again for the half they wanted, which is recoverable, where moving a subject they were protecting
  // is not. The model's own SPLIT: line handles the mixed case whenever it produces one, and this
  // runs only when it did not.
  if (refuses) return { kind: 'declined' };
  if (named.length) return { kind: 'selected', topics: named };
  // They asked to split something we cannot identify. NOT a guess: leaving it open asks again,
  // which is recoverable, where splitting the wrong subject is not.
  return null;
}

export function parseSplitSelection(reply: string, offered: OfferedTopic[]): SplitSelection | null {
  const text = (reply ?? '').trim();
  if (!text || !offered.length) return null;

  // Matched case-insensitively because the label travels through a model that may recapitalise it,
  // and a subject rejected over a capital letter is a subject the person chose and did not get.
  const byLabel = new Map(offered.map((topic) => [topic.label.trim().toLowerCase(), topic]));

  const chosen: OfferedTopic[] = [];
  const seen = new Set<string>();
  let answered = false;
  let declined = false;

  SPLIT_LINE.lastIndex = 0;
  for (const match of text.matchAll(SPLIT_LINE)) {
    answered = true;
    for (const raw of match[1].split('|')) {
      const label = raw.trim().toLowerCase();
      if (!label) continue;
      if (label === NONE) { declined = true; continue; }

      const topic = byLabel.get(label);
      // A SUBJECT NOBODY OFFERED. Refuse the whole selection rather than the one line: a reply
      // naming two subjects of which one is unrecognized is a reply that was not understood, and
      // acting on the half that parsed would split some of what they asked for and none of the rest.
      if (!topic) return null;
      if (seen.has(label)) continue;
      seen.add(label);
      chosen.push(topic);
    }
  }

  if (!answered) return null;
  // "none" AND a subject is not an answer either way, so it is not treated as one.
  if (declined && chosen.length) return null;
  if (declined) return { kind: 'declined' };
  return chosen.length ? { kind: 'selected', topics: chosen } : null;
}

/**
 * What the assistant is told while an offer is outstanding.
 *
 * THE WORDS ARE STILL THE MODEL'S (tenet D11). This adds a machine line to declare what it heard; it
 * does not script the reply, which carries the deployment's persona and the conversation's language.
 */
export function splitOfferDirective(offered: OfferedTopic[]): string {
  if (!offered.length) return '';
  return [
    '',
    '',
    'YOU OFFERED TO CONTINUE SOME OF THIS CONVERSATION ELSEWHERE, AND HAVE NOT HAD AN ANSWER YET.',
    'THIS PERSON IS THE ONE YOU ASKED.',
    'The subjects you offered, exactly as you named them:',
    ...offered.map((topic) => '  ' + topic.label),
    '',
    'THIS ANSWER COMES FIRST. You asked them something and they have not answered until now, so if',
    'this message answers it, settle that before continuing any other work in this conversation -',
    'including a task you were in the middle of. Anything else waiting here can wait one more turn;',
    'they cannot answer a question twice, and an unanswered offer is asked again.',
    '',
    'If this message answers that offer, put ONE line at the very start of your reply:',
    'SPLIT: <the subjects to move, exactly as named above, separated by |>',
    'or, if they said not to move anything:',
    'SPLIT: none',
    '',
    'Use ONLY the labels listed above. Do not invent one, and do not move a subject they did not name.',
    'Naming a subject in passing IS an answer: "just split out X" or "move X, leave the rest" selects',
    'X, and "leave it all here" is SPLIT: none.',
    'Only if this message has nothing to do with the offer, write no SPLIT line at all and simply',
    'carry on - the offer stays open and you can ask again later.',
    'After that line, reply to them normally, in your own voice. Do not mention the SPLIT line.',
    '',
  ].join('\n');
}

/** The reply with the machine line removed, so the person never reads the contract. */
export function stripSplitSelection(reply: string): string {
  return (reply ?? '').replace(SPLIT_LINE, '').trim();
}

/**
 * ASK THE SPLIT FUNCTION TO CREATE WHAT THEY CHOSE.
 *
 * ASK, not do. The processor holds no right to create a channel and must not: it is the component
 * that runs model output, and `chime:CreateChannel` cannot be tag-scoped the way its other rights
 * are, because the tag that would gate it does not exist until the channel does. The request is
 * checked over there against the offer record, which the model never wrote.
 *
 * Absent wiring is silence rather than an error: the offer is gated on this ARN existing, so a
 * deployment without it never made the offer that would reach here.
 */
export async function requestConversationSplit(args: {
  channelArn: string;
  responderId: string;
  botArn: string;
  correlationId: string;
  userArn: string;
  classification: string;
  labels: string[];
  originatingMessageId: string;
}): Promise<{ created: Array<{ label: string; channelArn: string }>; refused: string[] }> {
  const fn = process.env.CONVERSATION_SPLIT_FUNCTION_ARN;
  if (!fn || !args.labels.length) return { created: [], refused: args.labels };

  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const client = sessionClient(LambdaClient, { region: process.env.AWS_REGION || 'us-east-1' });
  try {
    // SYNCHRONOUS, because the person is being told in this same reply what happened. An async
    // invoke would have the assistant say it moved something before anything had tried to.
    const res = await client.send(new InvokeCommand({
      FunctionName: fn,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(args)),
    }));
    // A FUNCTION ERROR IS NOT A THROW, and that is the whole trap. An invocation that times out or
    // raises resolves with HTTP 200 and a payload of `{"errorMessage":"...Task timed out..."}`, so
    // nothing here threw: `created` and `refused` were both absent, both defaulted to [], and a
    // caller that only speaks when `refused.length` is non-zero said nothing. The assistant had
    // already told the person it was moving their subjects, `clearPendingSplit` never ran, and the
    // offer stayed standing - so they went looking for a conversation that was never created.
    //
    // The split function does real work per label (CreateChannel, tags, membership, flow
    // association) inside a 30 second timeout, so this is the expected failure, not an exotic one.
    if (res.FunctionError) {
      console.error('[turn-topic-split] the split function reported an error; nothing moved', {
        channelArn: args.channelArn,
        functionError: res.FunctionError,
        payload: Buffer.from(res.Payload ?? new Uint8Array()).toString().slice(0, 300),
      });
      return { created: [], refused: args.labels };
    }
    const parsed = JSON.parse(Buffer.from(res.Payload ?? new Uint8Array()).toString() || '{}');
    // AND NEITHER IS AN UNRECOGNIZED BODY. Two empty arrays read as "everything moved, nothing was
    // refused", which is the one reading that must never be reached by accident.
    if (!Array.isArray(parsed.created) && !Array.isArray(parsed.refused)) {
      console.error('[turn-topic-split] the split function answered in a shape this cannot read', {
        channelArn: args.channelArn,
        payload: Buffer.from(res.Payload ?? new Uint8Array()).toString().slice(0, 300),
      });
      return { created: [], refused: args.labels };
    }
    return {
      created: Array.isArray(parsed.created) ? parsed.created : [],
      refused: Array.isArray(parsed.refused) ? parsed.refused : [],
    };
  } catch (err) {
    // NOTHING MOVED, and the caller says so. Reporting a split that did not happen is the one
    // outcome worse than refusing it, because the person stops looking for the conversation.
    console.error('[turn-topic-split] the split request failed', {
      channelArn: args.channelArn, message: (err as Error)?.message,
    });
    return { created: [], refused: args.labels };
  }
}
