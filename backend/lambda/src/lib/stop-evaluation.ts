/**
 * THE JUDGED HALF OF A STOP: WHY IT WAS SENT, AND HOW THE PERSON WANTS TO PROCEED (ADR-033).
 *
 * `/stop` has two effects and they belong on different paths. Suppressing the running answer and
 * cancelling the work in progress need no model call and get none: the person has already made that
 * decision, and making them wait on a judgement to have it honored is the design failing at the one
 * moment it is most visible. What they want to happen NEXT is a different question, unanswerable
 * from the token `/stop`, and it is asked rather than assumed.
 *
 * ── COMPLETED WORK IS KEPT, WORK IN PROGRESS IS CANCELLED ───────────────────
 *
 * `/stop` means "stop what you are doing", and work that is still running is what they are doing. So
 * it is cancelled at the stop, through the same selection that names it: the person's own open work
 * for the assistant they stopped. Work already finished is not in that selection and is never touched.
 *
 * What a cancel cannot tell apart is whether they wanted the work abandoned or wanted it again in a
 * different shape - narrowed, corrected, or aimed at the other assistant. That is the question this
 * turn asks.
 *
 * ── THE QUESTION OWNS ITS FOLLOW-UP ─────────────────────────────────────────
 *
 * Their answer arrives in ordinary words on a later message, and ordinary routing cannot be trusted
 * with it: it was measured classifying "Drop it, I do not want that report" as `intent: general` and
 * answering it conversationally. So the router reads that message against the question BEFORE any
 * routing (`buildStopAnswerReading`, `parseStopAnswer`), and only then decides whether the message
 * ends the exchange, restarts the work, or was about something else and goes on its way.
 *
 * ── WHY IT IS DISPATCHED RATHER THAN ANSWERED INLINE ────────────────────────────────────────────
 *
 * The `/stop` turn must return at once: it is the escape hatch, and a model call in front of the
 * acknowledgment would put seconds between the person asking things to stop and being told they had.
 * So the acknowledgment is deterministic and this follows behind it, the same shape and the same
 * dispatch the triage proposal uses.
 *
 * ── ITS REPLY IS PROSE, WHICH IS WHY IT CARRIES NO OUTPUT CONTRACT ──────────────────────────────
 *
 * Triage returns a machine-readable reading and therefore needs declared markers and a closed set.
 * This turn returns something a person reads: an account of what it was doing when the stop arrived,
 * and the choice. There is nothing for a parser to get wrong, so it rides the ordinary reply path and
 * is spoken in the deployment's persona and the conversation's language rather than composed here.
 */

import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { resolveRouterArn } from './turn-triage.js';
import type { TurnRequest } from '../router-agent-handler.js';
import { stopEvaluationCorrelationId } from './correlation.js';
import { sessionClient } from './assistant-session.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const lambdaClient = sessionClient(LambdaClient, { region: AWS_REGION });

/**
 * What travels with the turn.
 *
 * IT EXISTS TO BE RECOGNIZED, not to be parsed for a decision. The turn needs to know it is a stop
 * evaluation so it can skip the turn claim - it is not answering a new message - and the count is
 * carried only so the log can say what the question was about.
 */
export interface StopEvaluationContext {
  /**
   * How many pieces of work the stop cancelled. Zero is legitimate: a stop with nothing running.
   * `heldCount` is the wire name, kept so a turn dispatched across a deploy still parses.
   */
  heldCount: number;
  /**
   * WHAT ACTUALLY CAME FROM A PERSON, carried apart from the prompt that wraps it.
   *
   * The input guardrail screens the turn's `userMessage`, and for a stop evaluation that value is
   * the whole assembled CONTRACT: instructions telling the model what to work out, wrapped around
   * the person's own words and the labels of the cancelled work. That is the shape of a
   * prompt-injection attempt, so the prompt-attack filter fires on our own scaffolding and blocks the
   * turn before the model is ever called - which means the person is never asked how to proceed.
   * Observed live 2026-09-09: "input guardrail intervened; blocking turn before model call", a
   * stop-evaluation turn that finished in under a second having judged nothing.
   *
   * This is the same defect `turn-triage.ts` fixed for the reading turn, in the path that never got
   * the same treatment. The answer is not to stop screening: it is to screen the part that is
   * actually untrusted. The contract is our own text and screening it protects nobody.
   */
  userContent?: string;
}

/** Read the context back, or undefined when this is an ordinary turn. */
export function parseStopEvaluationContext(raw: string | undefined): StopEvaluationContext | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<StopEvaluationContext>;
    if (typeof parsed?.heldCount !== 'number' || parsed.heldCount < 0) return undefined;
    return {
      heldCount: Math.floor(parsed.heldCount),
      ...(typeof parsed.userContent === 'string' && parsed.userContent
        ? { userContent: parsed.userContent }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * What the assistant is asked to work out.
 *
 * IT IS ASKED TO READ, NOT TO DECIDE. The prompt does not offer it the option of starting the work
 * again on its own: the whole reason this turn exists is that the choice is the person's, and a
 * prompt that invited the model to pick would reintroduce the guess the deterministic path was
 * careful not to make.
 */
export function buildStopEvaluationPrompt(args: {
  /** Short labels for the work that was cancelled, in the order it was found. */
  cancelledLabels: string[];
  /** What the person said before the stop, when there is anything worth reading. */
  precedingMessage?: string;
}): string {
  const { cancelledLabels, precedingMessage } = args;
  return [
    'The person just sent `/stop`. You have already stopped: the answer you were producing will not',
    'be posted, and the work you were doing for them has been cancelled. Anything you had already',
    'finished for them is kept.',
    '',
    cancelledLabels.length
      ? `Work that was cancelled:\n${cancelledLabels.map((l) => `- ${l}`).join('\n')}`
      : 'There was no recorded piece of work in progress for them here.',
    precedingMessage ? `\nWhat they said just before stopping: ${precedingMessage}` : '',
    '',
    'In your own voice, and in the language of the conversation:',
    '1. Say briefly what you understand you were doing when they stopped you, and what you think',
    '   prompted it. Say you are not sure if you are not.',
    '2. Ask them how they want to proceed: leave it cancelled, or start it again, as it was or changed.',
    '',
    'Do NOT decide for them, and do not start any of it again. Keep it to a few sentences: they',
    'interrupted you, so this is not the moment for a long message.',
    '',
    // BELT TO THE LABEL'S BRACES. The dispatcher already withholds a private task's excerpt from the
    // list above, so the model cannot quote what it was never given - this line covers what it may
    // KNOW from its own turn context. Other members may see that private work exists, never what it
    // is (ADR-033, maintainer decision 2026-08-23).
    'If any cancelled item is described as a private request, do not name or guess at its contents:',
    'this reply is visible to the conversation, and what that request says is not.',
  ].filter(Boolean).join('\n');
}

/**
 * One piece of work a stop cancelled, as the question about it needs to remember it.
 *
 * THE REQUEST TEXT, NOT A LABEL, because "start it again" has to be able to say what "it" was. It is
 * the bounded excerpt the task row already kept (ADR-024 D5), and the record holding it is read only
 * for the person who made the request.
 */
export interface StoppedRequest {
  /** What they asked for, as the task row recorded it. */
  text: string;
  /**
   * Whether the request was made privately. ABSENT VISIBILITY IS PRIVATE, for the reason the stop's
   * own labels give: a task opened from a targeted message is narrowed only later in its turn.
   */
  private: boolean;
}

/**
 * WHAT THE STOP ASKED, LEFT WHERE THE PERSON'S NEXT MESSAGE WILL FIND IT.
 *
 * The shape is the one `pendingSplit` already uses for the split offer, and `pendingDriftSuggestion`
 * for drift: record the question, read it on the next turn AS THE SPEAKER, act on the answer.
 */
export interface PendingStopDecision {
  /** Who was asked. Only they can answer it: another member's message is not their decision. */
  askedOf: string;
  /** The work the stop cancelled, as task ids. */
  taskIds: string[];
  /** What each of those was, so the work can be started again if that is the answer. */
  requests: StoppedRequest[];
  /** When, so a stale question can be told from a live one. */
  askedAt: string;
}

/** What the person's next message says about the stop. */
export type StopAnswer = 'leave' | 'again' | 'other';

/**
 * The reading put to the classifier model: does this message answer the stop question, and how?
 *
 * A CLOSED SET, because the reading drives a branch rather than a reply. The person hears nothing
 * from this call; what they hear comes from the branch it selects.
 *
 * JUDGED, NOT MATCHED. An earlier keyword fallback read "drop it" and "carry on" and had to be
 * narrowed after "Can you cancel that meeting I booked for Thursday?" destroyed held work, and a word
 * list does not survive a conversation held in another language (tenet D11). The model reads the
 * message against the question it answers, in whatever language it arrives.
 *
 * Model-facing and never shown to anyone, which is why it is fixed English.
 */
export function buildStopAnswerReading(args: {
  requests: StoppedRequest[];
  message: string;
}): string {
  const { requests, message } = args;
  return [
    'An assistant was stopped by the person below. The work it was doing for them was cancelled,',
    'and it asked them how they want to proceed: leave it cancelled, or start it again (as it was',
    'or changed). This is the next message they sent.',
    '',
    'The cancelled work:',
    ...(requests.length ? requests.map((r) => `- ${r.text}`) : ['- (not recorded)']),
    '',
    `Their message: "${message}"`,
    '',
    'Answer with exactly one word:',
    'LEAVE - they want it to stay cancelled, or they are letting it go',
    'AGAIN - they want the work carried on or started again, including a narrowed or corrected version',
    'OTHER - the message is about something else and does not answer the question',
    '',
    'Answer:',
  ].join('\n');
}

/**
 * Read the one-word answer back.
 *
 * UNDEFINED IS NOT `other`. `other` is a reading - the message was about something else - and
 * undefined is the absence of one, which the router treats differently: the question stays standing
 * so the next message is read again, rather than being closed on a reply that said nothing.
 */
export function parseStopAnswer(reply: string | undefined): StopAnswer | undefined {
  const word = (reply ?? '').trim().split(/[^A-Za-z]+/).find(Boolean)?.toLowerCase();
  return word === 'leave' || word === 'again' || word === 'other' ? word : undefined;
}

/**
 * The message a restarted turn answers: what they asked for, then what they just said about it.
 *
 * NO INSTRUCTIONS AROUND IT, deliberately. Scaffolding wrapped around a person's words is the shape
 * the input guardrail's prompt-attack filter refuses (`StopEvaluationContext.userContent` records the
 * live case), so this is only their own text, in the order they wrote it.
 *
 * A PRIVATE REQUEST IS RESTARTED ONLY FROM A PRIVATE MESSAGE. The restarted turn answers with the
 * visibility of the message it is answering, so restoring a privately made request into a reply to a
 * public message would publish the one thing the targeting withheld. When nothing is left to restart,
 * this returns undefined and the message is routed as it was sent.
 */
export function restartedRequest(args: {
  requests: StoppedRequest[];
  followUp: string;
  followUpIsPrivate: boolean;
}): string | undefined {
  const { requests, followUp, followUpIsPrivate } = args;
  const restorable = requests
    .filter((r) => r.text && (followUpIsPrivate || !r.private))
    .map((r) => r.text);
  if (!restorable.length) return undefined;
  return [...restorable, followUp].filter(Boolean).join('\n\n');
}

/**
 * Dispatch the evaluation.
 *
 * RETURNS FALSE RATHER THAN THROWING, like the triage dispatch. The stop itself has already been
 * acknowledged by the time this runs, so a failure here costs the follow-up question and never the
 * stop: the work is already cancelled, and the person can simply ask for it again.
 */
export async function dispatchStopEvaluationTurn(args: {
  channelArn: string;
  botArn: string;
  classification: string;
  correlationId: string;
  senderArn: string;
  cancelledLabels: string[];
  precedingMessage?: string;
  /**
   * The `/stop` message this evaluation answers, when the caller already had its id.
   *
   * A stop evaluation IS an answer - to the stop itself - so it declares its target like any other
   * turn, and the exchange is paired on that rather than inferred from what happened to precede it.
   * Absent on the Lex path, which cannot supply a message id at all: Amazon Chime SDK sends Lex three
   * request attributes and the id is not among them. Absent is correct there; the pairing falls back
   * to the inference, and nobody buys a channel read on the escape hatch's own path to avoid it.
   */
  userMessageId?: string;
}): Promise<boolean> {
  const {
    channelArn, botArn, classification, correlationId, senderArn, cancelledLabels, precedingMessage,
  } = args;

  const routerArn = await resolveRouterArn(classification);
  if (!routerArn) {
    console.error('[stop-evaluation] no router for this classification; the stop goes unexplained', {
      classification,
    });
    return false;
  }

  const aeTurn: TurnRequest = {
    ...(args.userMessageId ? { userMessageId: args.userMessageId } : {}),
    channelArn,
    senderArn,
    userMessage: buildStopEvaluationPrompt({
      cancelledLabels,
      ...(precedingMessage ? { precedingMessage } : {}),
    }),
    botArn,
    // A NEW CORRELATION, because this is a new turn with its own placeholder. Reusing the stopped
    // turn's would attach this question to the answer that was just suppressed, and the update would
    // land on a message the person has already been told is finished with.
    // Built by the shared helper, which bounds it: the ids this derives from are themselves derived,
    // so the length is not knowable here.
    correlationId: stopEvaluationCorrelationId(correlationId),
    stopEvaluation: {
      heldCount: cancelledLabels.length,
      // The person's own words and the labels of their cancelled work - everything here that a person
      // wrote. The instructions wrapped around them are ours and are not what a guardrail is for.
      userContent: [precedingMessage ?? '', ...cancelledLabels].filter(Boolean).join('\n\n'),
    },
    // A person IS waiting on this - they just sent the stop - so it is their interaction rather than
    // background work.
    trigger: 'user' as const,
  };

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ aeTurn })),
    }));
    console.log('[stop-evaluation] dispatched the evaluation turn', {
      correlationId, cancelled: cancelledLabels.length,
    });
    return true;
  } catch (err) {
    console.error('[stop-evaluation] dispatch failed; the stop stands but goes unexplained', {
      err: (err as Error)?.message,
    });
    return false;
  }
}
