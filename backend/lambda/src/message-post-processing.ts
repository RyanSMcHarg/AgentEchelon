/**
 * POST-PROCESSING: what the platform does with a message AFTER it has been delivered.
 *
 * WHY THERE IS SUCH A PLACE AT ALL (ADR-032). The channel flow is synchronous and runs on every
 * message in every conversation, with Amazon Chime SDK waiting on it, so its only EXCLUSIVE power is
 * denial - a message it releases cannot be un-released. Everything else it could do is a LATENCY
 * CHOICE rather than a capability, because the message stream can do the same thing afterwards,
 * including dispatching a turn. So the critical path is reserved for what cannot be done later, and
 * this is where "later" lives.
 *
 * It also sees more. The flow's callback carries no `Target` and cannot set one; the stream carries
 * `Target` and `Metadata` intact (MESSAGE-FLOW Appendix B). Any rule that reasons about how a message
 * was ADDRESSED can only run here.
 *
 * WHAT BELONGS HERE, AND WHAT DOES NOT (ADR-041, tenet D9). Rules that act on a message DELIVERY DID
 * NOT ROUTE - the platform's own after-the-fact correction of who should be acting on what. A person's
 * task answer that addressed nobody and therefore reached no assistant; triage on arrival, which reads a
 * queue from the deferral notice that announced it; a handover the flow could not route. ADR-023's
 * B-stream (an assistant-to-assistant message, which Amazon Chime SDK delivers and persists but routes
 * to no handler) is the same shape and would be a further rule here, not a second consumer.
 *
 * OUT-OF-BAND SIDE EFFECTS OF A MESSAGE DELIVERY DID ROUTE are their capability's own consumer. The
 * notification fan-out is one: delivery routed the message correctly, and the fan-out is an additional
 * transport carrying it to somebody who is not in the room. It runs in the Notifications stack
 * (`notification-bridge.ts`), which holds the deployment's only SES send grant, so a deployment that does
 * not declare `notifications` neither sends email nor holds a grant to.
 *
 * What does NOT belong here is archival, measurement and analysis: those already have a consumer on
 * this stream (`analytics-aurora/kinesis-archival.ts`), and they read a far wider shape of every
 * message. Two components on one stream with two jobs, rather than one that grew to do both.
 *
 * THE CONTRACT EVERY RULE HOLDS: it never throws. A handler that throws on a Kinesis stream stalls its
 * shard until the retries are exhausted, which would take a defect affecting one message and stop
 * every message behind it. A rule that fails counts its failure and returns.
 */

import type { KinesisStreamEvent } from 'aws-lambda';
import { parseStreamRecord } from './lib/message-stream-event.js';
import { repairTaskAnswer } from './lib/task-answer-repair.js';
import { triageOnArrival } from './lib/triage-on-arrival.js';
import { deliverMissedHandover } from './lib/handover-backstop.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

/**
 * Every rule, in order. Each is handed the same message and decides for itself whether it applies.
 *
 * Sequential rather than concurrent, deliberately: a batch is up to 100 messages of which almost none
 * reach a lookup, so there is nothing to parallelise except the rare case that acts - and a fan-out
 * here would let one broken conversation dispatch a burst of turns at once.
 *
 * Order carries no meaning: no rule here reads what another wrote, and each rejects on its own free
 * checks. The repair acts only on a person's message, triage on an assistant's deferral notice and the
 * backstop on a handover marker. So no record reaches two of them, and the list is in the order the
 * rules were added.
 */
const RULES = [repairTaskAnswer, triageOnArrival, deliverMissedHandover];

export const handler = async (event: KinesisStreamEvent): Promise<void> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  for (const record of event.Records || []) {
    const message = parseStreamRecord(record.kinesis.data);
    if (!message) {
      // A record this component cannot read is not a decision it can make. The archival consumer on
      // the same stream reports parse failures; duplicating that alarm here would double-count it.
      console.warn('[PostProcessing] unreadable stream record; skipping');
      continue;
    }
    for (const rule of RULES) {
      await rule(message);
    }
  }
};
