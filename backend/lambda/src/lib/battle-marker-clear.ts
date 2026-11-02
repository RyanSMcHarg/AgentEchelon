/**
 * TAKING DOWN A DUEL'S WAITING MARKERS IS THE ROUTER'S, BECAUSE IT EDITS THE ASSISTANTS' OWN MESSAGES.
 *
 * Ending a duel clears each waiting side's "answer here" control, which is an edit of that side's message,
 * so it is said as that assistant. The router of the conversation's classification is the one speaker for
 * everything outside a turn, so the edit is named to it (`aeClearMarkers`, `clearDuelMarkers` in
 * `router-agent-handler.ts`) rather than done by whoever ended the duel: the channel flow and the battle
 * administration API hold no assistant session at all. The router checks each marker against the battle
 * state before it edits.
 *
 * The rest of an ending (the round-2 poison, the abandoned sides, the pointer release) is DynamoDB only and
 * stays synchronous in the caller (`endBattle`), so a rebuttal cannot fire after an end. Only this cosmetic
 * half moves.
 */
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { resolveRouterArn } from './router-arn.js';

export interface WaitingMarker {
  messageId: string;
  /** The side whose message carries the marker. */
  botArn: string;
}

let lambda: LambdaClient | null = null;

/**
 * Ask the router to clear these markers. `wait` blocks until it has, for a caller whose next step removes a
 * side from the room (an edit by a non-member fails); otherwise it is asked and not awaited. Returns how many
 * were cleared when waited for, and the count asked for when not. Never throws: a marker left standing is
 * cosmetic, and the ending itself has already happened.
 */
export async function requestMarkerClear(args: {
  channelArn: string;
  battleId: string;
  classification: string;
  markers: WaitingMarker[];
  wait: boolean;
}): Promise<number> {
  if (!args.markers.length) return 0;
  const fn = await resolveRouterArn(args.classification);
  if (!fn) {
    console.warn('[battle-marker-clear] no router wired for this classification; the waiting markers stay', { channelArn: args.channelArn });
    return 0;
  }
  try {
    lambda = lambda ?? new LambdaClient({});
    const res = await lambda.send(new InvokeCommand({
      FunctionName: fn,
      InvocationType: args.wait ? InvocationType.RequestResponse : InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({
        aeClearMarkers: { channelArn: args.channelArn, battleId: args.battleId, markers: args.markers },
      })),
    }));
    if (res.FunctionError) return 0;
    if (!args.wait) return args.markers.length;
    const outcome = res.Payload ? JSON.parse(Buffer.from(res.Payload).toString() || '{}') as { cleared?: number; reason?: string } : {};
    if (outcome.reason) console.warn('[battle-marker-clear] the router cleared no markers', { reason: outcome.reason });
    return typeof outcome.cleared === 'number' ? outcome.cleared : 0;
  } catch (err) {
    console.warn('[battle-marker-clear] could not ask the router to clear the markers', {
      channelArn: args.channelArn, message: (err as Error)?.message,
    });
    return 0;
  }
}
