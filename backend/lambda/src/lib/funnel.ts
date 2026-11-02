/**
 * THE GUEST-TO-CUSTOMER FUNNEL (B12): each stage is a fact, recorded once, in the store that owns it (tenet D7).
 *
 * The archive is the system of record for what happened (`lib/event-archive.ts`): a server stage is one
 * event the platform records about itself at the moment the transition happens, on the component that
 * performs it, keyed by the AppInstanceUser it is about (its id, never an address). No funnel figure is a
 * second count of something another store already holds: the operational `GuestRefused` metric remains the
 * alarm's signal, and the refusal by reason is this stage; the guest start's own metric is replaced by its
 * stage.
 *
 * ── ONE JOURNEY, BY CONVERSATION, NEVER BY EMAIL ─────────────────────────────────────────────────────
 *
 * Every stage carries `journey`: the channel id of the visitor's conversation, the one the visit began in.
 * Under path A the visitor's AppInstanceUser becomes the account, so the journey and the person are the
 * same throughout. Under path B the account is another AppInstanceUser, and the `customer-engagement`
 * conversation a claim opens names the visitor's conversation by its `upgradedFrom` tag, so the claim's
 * stage carries the same journey. The funnel query counts distinct journeys per stage and joins nothing by
 * an address (`guest_to_customer_funnel`, the analytics query in either mode).
 *
 * ── WHAT IS RECORDED, AND WHAT IS NOT BUILT ──────────────────────────────────────────────────────────
 *
 * A stage whose recorder is not built is still declared, so its absence from the funnel reads as not built
 * rather than as zero. Recording is best-effort: a stage that cannot be archived is logged and never fails
 * the visitor's request (tenet D5).
 */
import { appendServerEvent } from './event-archive.js';
import { personIdFromArn } from './person-arn.js';
import type { ServerEventType } from './client-event-types.js';

export { FUNNEL_STAGES, RECORDED_FUNNEL_STAGES, type FunnelSource, type FunnelStageDefinition, type RecordedFunnelStage } from './funnel-stages.js';
import { FUNNEL_STAGES, type RecordedFunnelStage } from './funnel-stages.js';

/** The channel id a journey is named by: the last segment of the visitor's conversation ARN. */
export function journeyOf(channelArn: string | null | undefined): string {
  const id = String(channelArn || '').split('/').pop() || '';
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : '';
}

export interface FunnelStageInput {
  stage: RecordedFunnelStage;
  /** The AppInstanceUser the stage is about. Empty for a refused start, which minted nobody. */
  personArn?: string | null;
  /** The visitor's conversation: the journey every stage of one visit carries. */
  journeyChannelArn?: string | null;
  /** The refusal's reason code, for `guest_refused`. */
  reason?: string;
  now?: Date;
}

/** The archive writer a recorder uses. Injected for tests. */
export type FunnelSink = (input: { eventType: ServerEventType; personId: string; properties: Record<string, string | number | boolean>; now?: Date }) => Promise<void>;

/**
 * Record one stage. Never throws: an unrecorded stage is logged and the request it belongs to goes on.
 * Nothing that names a person by an address is ever a property.
 */
export async function recordFunnelStage(input: FunnelStageInput, sink: FunnelSink = appendServerEvent): Promise<boolean> {
  const def = FUNNEL_STAGES.find((s) => s.stage === input.stage);
  const properties: Record<string, string | number | boolean> = {};
  const journey = journeyOf(input.journeyChannelArn);
  if (journey) properties.journey = journey;
  if (def?.path) properties.path = def.path;
  if (input.reason && /^[a-z_]{1,40}$/.test(input.reason)) properties.reason = input.reason;
  try {
    await sink({ eventType: input.stage, personId: personIdFromArn(input.personArn || '') || '', properties, ...(input.now ? { now: input.now } : {}) });
    return true;
  } catch (err) {
    console.warn('[funnel] a stage could not be archived; the request goes on', { stage: input.stage, err: (err as Error)?.name || 'error' });
    return false;
  }
}
