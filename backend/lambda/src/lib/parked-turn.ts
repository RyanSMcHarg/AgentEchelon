/**
 * AN ANSWER WAITS FOR THE READING, AND THE READING IS WHAT RESUMES IT (ADR-033, owner 2026-09-14).
 *
 * The queue's promise is that follow-ups sent while the assistant is working are rolled into the answer
 * before it is sent. The reading decides which queued messages are follow-ups, and it runs BESIDE the
 * answer. When the answer is ready first, the fold finds nothing recorded and the answer goes out
 * without them. Measured live 2026-09-14: the answer was ready at 20:45:48.3, the reading recorded the
 * follow-ups at 56.6.
 *
 * So the answer PARKS (`parkTurnForReading`) and the reading RESUMES it once it has recorded what it
 * found. Triggered by the reading finishing, never by a timer (tenet D6).
 *
 * ── ONE DELIVERY PATH ────────────────────────────────────────────────────────────────────────────
 *
 * The reading does not deliver the parked answer, and does not decide whether to fold it. It hands the
 * conversation back and re-invokes the parked turn, which runs `finalizePlaceholderResponse` again from
 * its stored inputs: the fold check finds the recorded follow-ups and re-runs the turn with them, or
 * finds none and delivers the draft. A second delivery path in the reader would be a second place for
 * every rule delivery already follows (visibility, chunking, receipts, analytics) to drift.
 *
 * ── THE PROCESSOR INVOKES ITSELF ─────────────────────────────────────────────────────────────────
 *
 * The reading runs in the same processor function as the answer it resumes (both are this
 * classification's turns), so the invoke targets `AWS_LAMBDA_FUNCTION_NAME`. The stored inputs stay on
 * the record and only the key travels, so the invoke payload is small whatever the answer's size.
 */

import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { abandonResumeParkedTurn, beginResumeParkedTurn } from './turn-lock.js';
import { principalIdFromArn } from './task-tracking.js';

// Resuming a parked answer is the processor invoking itself (step 18), on its own role.
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

/** What a resume invocation carries: enough to find the parked inputs, nothing more. */
export interface ResumeParkedEvent {
  resumeParked: { channelArn: string; botArn: string; correlationId: string };
  /**
   * THE SAME THREE AT THE TOP LEVEL, because the async-invoke failure destination
   * (`turn-lock-release-on-failure.ts`) reads the lock's identity from there. Without them a resumed run
   * the platform killed would be neither retried nor released.
   */
  channelArn: string;
  botArn: string;
  correlationId: string;
}

export function isResumeParkedEvent(event: unknown): event is ResumeParkedEvent {
  const r = (event as Partial<ResumeParkedEvent> | undefined)?.resumeParked;
  return !!r && typeof r.channelArn === 'string' && typeof r.botArn === 'string'
    && typeof r.correlationId === 'string';
}

/**
 * The largest stored input set. The turn-state item also carries the queue, and DynamoDB caps an item
 * at 400 KB; an answer too large to park is delivered at once, without its follow-ups, and says so.
 */
export const MAX_PARKED_PARAMS_BYTES = 300_000;

/**
 * Resume the answer parked behind this reading, if there is one. Safe to call from every exit of a
 * reading: only the first call wins, and a reading with nothing parked behind it does nothing.
 */
export async function resumeParkedTurnIfAny(args: {
  channelArn: string;
  botArn: string;
  readerCorrelationId: string;
}): Promise<boolean> {
  const { channelArn, botArn, readerCorrelationId } = args;
  const responderId = principalIdFromArn(botArn);
  const parked = await beginResumeParkedTurn({ channelArn, responderId, reader: readerCorrelationId });
  if (!parked) return false;
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  try {
    if (!functionName) throw new Error('this function does not know its own name');
    const payload: ResumeParkedEvent = {
      resumeParked: { channelArn, botArn, correlationId: parked },
      channelArn, botArn, correlationId: parked,
    };
    await lambda.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
    console.log('[parked-turn] the reading is done; resuming the answer that waited for it', {
      channelArn, reader: readerCorrelationId, parked,
    });
    return true;
  } catch (err) {
    // LOUD, and the conversation goes back to the reader so its own exit settles it. The parked answer
    // stays recorded, and the reading's exit tries the resume once more.
    console.error('[parked-turn] could not resume the parked answer; the reader keeps the conversation', {
      channelArn, reader: readerCorrelationId, parked, err: (err as Error)?.message,
    });
    await abandonResumeParkedTurn({ channelArn, responderId, reader: readerCorrelationId, parked });
    return false;
  }
}
