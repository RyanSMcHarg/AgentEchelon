/**
 * THE EMAIL BRIDGE: the notification fan-out, as its own consumer on the message stream.
 *
 * An assistant message whose `Metadata` carries a `notify` directive reaches the members who are not in
 * the room, over email (`lib/notify-on-delivery.ts`, SPEC-NOTIFICATION-BRIDGE). It is a side effect of a
 * message delivery already routed, so it runs after delivery, on the stream, and never in front of the
 * channel flow's callback (ADR-041 decision 7).
 *
 * WHY ITS OWN CONSUMER, IN THE NOTIFICATIONS STACK. Email is the `notifications` capability: this
 * function and the deployment's only SES send grant exist when the deployment declares it, and not
 * otherwise. Post-processing (`message-post-processing.ts`) reads the same stream for the rules that act
 * on a message delivery did not route, and holds no grant to send mail.
 *
 * THE CONTRACT: it never throws. A handler that throws on a Kinesis stream stalls its shard until the
 * retries are exhausted. `notifyOnDelivery` counts its own failures and returns.
 */

import type { KinesisStreamEvent } from 'aws-lambda';
import { parseStreamRecord } from './lib/message-stream-event.js';
import { notifyOnDelivery } from './lib/notify-on-delivery.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

export const handler = async (event: KinesisStreamEvent): Promise<void> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  for (const record of event.Records || []) {
    const message = parseStreamRecord(record.kinesis.data);
    // A record this consumer cannot read is not a notification it can send. The archival consumer on the
    // same stream reports parse failures; duplicating that here would double-count it.
    if (!message) continue;
    await notifyOnDelivery(message);
  }
};
