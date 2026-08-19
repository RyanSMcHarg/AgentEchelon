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
 * `Target` and `Metadata` intact (MESSAGE-FLOW Appendix A). Any rule that reasons about how a message
 * was ADDRESSED can only run here.
 *
 * WHAT BELONGS HERE, AND WHAT DOES NOT. Rules that act on a message DELIVERY DID NOT ROUTE - the
 * platform's own after-the-fact correction of who should be acting on what. Today that is one rule:
 * a person's task answer that addressed nobody and therefore reached no assistant. ADR-023's B-stream
 * (an assistant-to-assistant message, which Amazon Chime SDK delivers and persists but routes to no
 * handler) is the same shape and would be a second rule here, not a second consumer.
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

/**
 * Every rule, in order. Each is handed the same message and decides for itself whether it applies.
 *
 * Sequential rather than concurrent, deliberately: a batch is up to 100 messages of which almost none
 * reach a lookup, so there is nothing to parallelise except the rare case that acts - and a fan-out
 * here would let one broken conversation dispatch a burst of turns at once.
 */
const RULES = [repairTaskAnswer];

export const handler = async (event: KinesisStreamEvent): Promise<void> => {
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
