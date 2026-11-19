/**
 * THE ONE PUBLISHER OF A MEETING'S LIFECYCLE EVENTS (`agentechelon.meetings`) for its conversation's router
 * (`meeting-lifecycle.ts`): the service's start and end (`meeting-events.ts`), a change of transcription mode the service
 * raises no event for (`meeting-transcription.ts`), and a recording's finish (`meeting-media-capture.ts`). The source is
 * one the alert rule never matches, and each publishing role is granted `events:PutEvents` for this source alone.
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { MEETING_LIFECYCLE_DETAIL_TYPE, MEETING_LIFECYCLE_SOURCE, type MeetingLifecycleDetail } from './meeting-lifecycle.js';

export type LifecycleBus = Pick<EventBridgeClient, 'send'>;

let defaultBus: LifecycleBus | undefined;

/** Publish one lifecycle event on `bus` (the default bus when absent). True when the bus accepted it; throws on a fault. */
export async function publishMeetingLifecycle(detail: MeetingLifecycleDetail, bus?: LifecycleBus): Promise<boolean> {
  const target = bus ?? (defaultBus ??= new EventBridgeClient({}));
  const out = await target.send(new PutEventsCommand({
    Entries: [{ Source: MEETING_LIFECYCLE_SOURCE, DetailType: MEETING_LIFECYCLE_DETAIL_TYPE, Detail: JSON.stringify(detail) }],
  })) as { FailedEntryCount?: number };
  return !out.FailedEntryCount;
}
