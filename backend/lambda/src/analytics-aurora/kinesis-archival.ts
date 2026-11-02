/**
 * Kinesis Archival Lambda (Aurora Mode)
 *
 * Consumes messages from the Chime SDK Kinesis stream and archives them
 * to Aurora PostgreSQL for evaluation and analysis.
 *
 * Data flow: Chime SDK -> Kinesis -> This Lambda -> Aurora PostgreSQL
 *
 * Features:
 * - Archives all Chime SDK event types (messages, channels, memberships)
 * - In-batch exchange pairing (user message + bot response)
 * - DB-side exchange pairing fallback for cross-batch matches
 * - Drift detection on topic changes
 * - Cross-conversation context updates
 */

import { KinesisStreamEvent, KinesisStreamRecord, Context } from 'aws-lambda';
import {
  query,
  transaction,
  batchInsert,
  ensureSchema,
  resetConnection,
  isAuthError,
} from './db-client.js';
import { detectDrift, recordDriftFire } from './drift-detection.js';
import { summarizeChannelsNow } from './summary-updater.js';
import { lookupChannelClassification } from './channel-classification.js';
import { writeTurnEvents, battleRoundOf } from './turn-events-live.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { updateConversationContext } from './cross-conversation-context.js';
import { readMessageAnalytics } from '../lib/message-analytics.js';
import { S3Client } from '@aws-sdk/client-s3';
import { deliveredDocumentOf } from '../lib/delivered-document.js';
import { archiveDeliveredDocument } from './delivered-document-archive.js';
import { turnDeclarationOf, turnEntryOf } from '../lib/turn-declaration.js';
import { answersNoMessage, ANSWERS_NO_MESSAGE_KINDS } from '../lib/interaction-kinds.js';
import { backfillModelFromAnalytics, ModelBackfillResult } from './model-backfill.js';
import { touchActivity } from '../lib/sleep-mode.js';
import { emitArchivalHealth } from './archival-health.js';
import { updateEventMessageId, baseMessageIdOf, isUpdateEventId, updateJoinSql } from './update-events.js';
// The shared principal taxonomy - the same rules the membership audit classifies members by.
import { classifyPrincipal } from '../lib/principal-role.js';
import { personIdFromArn } from '../lib/person-arn.js';
import { parseChannelMetadata } from '../lib/chime/channel-meta.js';
import { loadProfileRegistry } from '../../../lib/profile-registry';

const MAX_AUTH_RETRIES = 2;

/** Built on first use: only a message carrying a delivered document reaches S3 at all. */
let archiveS3Client: S3Client | null = null;
const archiveS3 = (): S3Client => (archiveS3Client ??= new S3Client({}));

// The deployment's admin identity id, so a turn from the admin plane is labelled as one rather than
// as an ordinary person. Same env and same default the membership audit reads.
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || 'agent-echelon-admin';

/** The person a sender row is filed under: the owner of an admin-plane twin, else the sender's own id. */
function senderPersonKey(principal: { sub: string | null; owner?: string }): string | null {
  return principal.owner ?? principal.sub;
}

// Chime SDK Kinesis event structure
interface ChimeKinesisEvent {
  EventType: string;
  Payload: {
    MessageId?: string;
    ChannelArn?: string;
    Content?: string;
    Metadata?: string;
    Sender?: {
      Arn: string;
      Name?: string;
    };
    CreatedTimestamp?: string;
    LastUpdatedTimestamp?: string;
    /** A message's type (`STANDARD`, `CONTROL`), or a membership's visibility (`DEFAULT`, `HIDDEN`). */
    Type?: string;
    Persistence?: string;
    // Channel-lifecycle events (CREATE/UPDATE/DELETE_CHANNEL) stream the channel
    // fields at the TOP LEVEL of Payload (verified against the live stream), not
    // nested under `Channel`. These mirror the DescribeChannel shape.
    Name?: string;
    Mode?: string;
    Privacy?: string;
    CreatedBy?: {
      Arn: string;
      Name?: string;
    };
    // Legacy/defensive: some SDK docs show a nested Channel object. Kept as a
    // fallback so both shapes parse.
    Channel?: {
      ChannelArn: string;
      Name?: string;
      Mode?: string;
      Privacy?: string;
      Metadata?: string;
      CreatedBy?: {
        Arn: string;
        Name?: string;
      };
      CreatedTimestamp?: string;
      LastUpdatedTimestamp?: string;
    };
    Member?: {
      Arn: string;
      Name?: string;
    };
    InvitedBy?: {
      Arn: string;
      Name?: string;
    };
  };
}

// Event types we capture
const MESSAGE_EVENT_TYPES = [
  'CREATE_CHANNEL_MESSAGE',
  'UPDATE_CHANNEL_MESSAGE',
  'DELETE_CHANNEL_MESSAGE',
  'REDACT_CHANNEL_MESSAGE',
];

const CHANNEL_EVENT_TYPES = [
  'CREATE_CHANNEL',
  'UPDATE_CHANNEL',
  'DELETE_CHANNEL',
];

const MEMBERSHIP_EVENT_TYPES = [
  'CREATE_CHANNEL_MEMBERSHIP',
  'DELETE_CHANNEL_MEMBERSHIP',
  'UPDATE_CHANNEL_MEMBERSHIP',
];

const ALL_ARCHIVABLE_EVENTS = [
  ...MESSAGE_EVENT_TYPES,
  ...CHANNEL_EVENT_TYPES,
  ...MEMBERSHIP_EVENT_TYPES,
];

// Internal record format
/**
 * A HANDOVER (lib/assistant-handover.ts): one assistant handing a person's message to another, marked
 * `aeHandover` in Metadata. Never an assistant reply. It IS the start of the receiving assistant's
 * exchange, paired only with the reply that declares it. The primary's acknowledgment is the primary's
 * response to the person, and the handover starts the other assistant's end to end.
 */
/** A non-empty string cut to the column width, or null. */
function shortString(v: unknown, max: number): string | null {
  return typeof v === 'string' && v ? v.slice(0, max) : null;
}

function isHandoverRecord(r: { is_bot?: boolean; metadata?: Record<string, any> | null }): boolean {
  return !!r.is_bot && !!r.metadata && typeof r.metadata === 'object' && 'aeHandover' in r.metadata;
}

interface MessageRecord {
  event_type: string;
  message_id: string;
  channel_arn: string;
  content: string | null;
  sender_arn: string | null;
  sender_name: string | null;
  target_arn: string | null;
  is_bot: boolean;
  /** The CONVERSATION's classification, as the turn declared it from the channel's tag. Never the
   *  sender's clearance (`user_clearance`) and never the answering assistant's (`agent_type`). */
  conversation_classification: string | null;
  /** The sender's ROLE - person, admin plane, federated, assistant. Structural, never a clearance. */
  user_role: string | null;
  /** The person who sent it, by id (migration 074); null on an assistant's message. */
  person_id: string | null;
  /** The caller clearance in force when the turn ran. Point-in-time: never re-derived at read time,
   *  because a classification change moves both the groups and the identity tag. */
  user_clearance: string | null;
  assistant: string | null;
  /** The ROLE the answering assistant holds (DESIGN-SEPARATE-ASSISTANTS 3.0). NULL on a turn that
   *  did not declare one - a row from before the dimension existed, never a guessed 'primary'. */
  assistant_role: string | null;
  /** The profile VERSION that produced this turn (the SSM parameter version the Profiles tab lists),
   *  and the configId that fingerprints what it says. Promoted out of the metadata JSONB so they can
   *  be filtered and indexed rather than read only by a MODE() over a JSON key. */
  profile_version: number | null;
  profile_config_id: string | null;
  /** The NAME of the definition that served the turn (migration 091): the live assistant's profile on an
   *  ordinary turn, the candidate's on an experiment's treatment. A column, folded onto the CREATE row
   *  like its version and config id, because the metadata key arrives only on the update event. */
  profile_name: string | null;
  bedrock_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  total_ms: number | null;
  /** The router leg: handler entry to hand-off, one clock. classifier_ms is a sub-step of it. */
  router_ms: number | null;
  /** What the intent classification cost, from the router. NULL when no model was asked. */
  classifier_ms: number | null;
  /** What the classification COST: its tokens and the model that consumed them (migration 063). */
  classifier_tokens_in: number | null;
  classifier_tokens_out: number | null;
  classifier_model: string | null;
  /** Admission: the dedup claim and the task-status write, before any lookup begins. */
  guard_ms: number | null;
  /** Cost of LOCATING the placeholder (mapping read + scan when needed). */
  placeholder_resolve_ms: number | null;
  /** The fallback SCAN only, NULL when none ran - so a COUNT of it is the fallback rate. */
  poll_ms: number | null;
  /** This turn initialized its container (G9). NULL means warm; only a cold turn declares itself. */
  cold_start: boolean | null;
  /** When the CAUSE of this turn happened, as an ISO string, declared by the dispatcher (G13).
   *  NULL on an ordinary user turn, which anchors on its own user message instead. */
  trigger_at: string | null;
  /** Latency split (LATENCY-TARGETS.md), from the out-of-band analytics record: model_ms = Converse
   *  inference time, tool_ms = in-loop tool execution. Folded onto messages.model_ms / tool_ms. */
  model_ms: number | null;
  tool_ms: number | null;
  /** Server-clock processor-entry epoch ms (analytics.processorEntryMs). Transient (NOT a column):
   *  used to derive exchanges.inbound_ms against the Chime user_message_at. */
  processor_entry_ms: number | null;
  persistence: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
  /** The Chime `LastUpdatedTimestamp` of THIS event (an UPDATE event's own time, distinct from
   *  `created_at` which prefers the original CreatedTimestamp). Used to derive `agent_final_at` /
   *  `e2e_ms` from the final-answer update. Null on events that carry no update timestamp. */
  last_updated_at: string | null;
  /** The MessageId a MESSAGE event is about (migration 084): the CREATE row's own id, which every
   *  update, redaction and deletion of it shares. Null on channel and membership events. */
  base_message_id: string | null;
  /**
   * WHICH STEP OF THE ANSWER THIS EVENT IS, as the producer DECLARED it (`ResponsePhase`), or null on
   * a message written before the declaration existed.
   *
   * Only `final` may close a turn. Null falls back to the legacy inference, and only for those rows.
   */
  resp_phase: string | null;
  /** For a deferral notice: the queued message this post acknowledges. NULL on every other row. */
  acknowledges: string | null;
  /** For a deferral notice: the drain stage this update records (waiting..settled). */
  queue_status: string | null;
  /**
   * WHICH INTERACTION this turn is, when the producer declared one (`interaction-kinds.ts`):
   * `user`, `rebuttal`, `handover` or `repair`. NULL reads as a user turn, which is what every path
   * did before a kind was forwarded at all.
   *
   * Rows written before the vocabulary was named by INTERACTION carry the retired dispatcher name
   * `orchestrator`, which covered both a rebuttal and a repair and cannot be separated after the
   * fact. `normaliseLegacyTrigger` maps it to the one it was overwhelmingly used for.
   */
  /** The member this MESSAGE was addressed to, from the stream record's Target. NULL when untargeted. */
  targeted_to: string | null;
  trigger_kind: string | null;
  /** How the turn entered: 'lex' or 'flow'. NULL for a row written before the column existed. */
  turn_entry: string | null;
  /**
   * THE MESSAGE THIS ANSWER ANSWERS, as declared by the turn that produced it.
   *
   * Present only when the turn already had the id. Absent means no component paid to resolve it, and
   * the pairing falls back to the inference it always used - so this is additive, and a row without it
   * is no worse off than before.
   */
  answers_message_id: string | null;
  /**
   * QUEUE WORK, DECLARED. `reading` means the turn answered a BURST rather than a message: it has no
   * single target and must not pair with one. Owned by queue analytics (drain depth, time to drain,
   * work created), not by the exchange population.
   */
  turn_kind: string | null;
  /**
   * THE QUEUED MESSAGES THIS ANSWER ADDRESSES, declared by the turn that folded them in (ADR-033
   * amendment, owner 2026-09-15).
   *
   * Empty on every ordinary answer, which is almost all of them. A non-empty list means the person
   * sent these while the assistant was busy, the reading marked them as amending the work in flight,
   * and this answer rolled them in - so each of them is answered by this message and gets its own
   * exchange row, labeled `folded`. The mapping is the reading's, not this path's: nothing here
   * infers which message an answer addressed.
   */
  answered_queued: string[];
  intent: string | null;
  intent_confidence: string | null;
  was_rerouted: boolean;
  delivery_option: string | null;
  task_id: string | null;
  task_status: string | null;
  // Task MACHINE state (SPEC-TASK-STATE-TRANSITIONS §6), distinct from task_status (the lifecycle):
  // task_state = the declared-graph state after this turn; task_transition = the edge it applied.
  task_state: string | null;
  task_transition: { from: string; to: string } | null;
  /**
   * HOW THE TASK ENDED, as the turn's runtime declared it from the deployment's pack-merged machines (`taskTerminal`).
   * Read by the turn-events ledger beside `task_status`; not a column of its own.
   */
  task_terminal?: string | null;
  /**
   * WHAT CHOSE THIS TURN'S MODEL AND WHICH WORK IT IS ATTRIBUTED TO (ADR-064 decision 4): the task's type and the state
   * the turn started in (`task_state` stays the state after), whether the model produced text or an image, and which
   * rule chose it (`experiment`, `version_rule`, `context_rule`, `step`, `route`, `general`, `base`).
   */
  task_type: string | null;
  task_step: string | null;
  model_kind: string | null;
  model_from: string | null;
  /**
   * The router's step instants, carried straight through to the ledger.
   *
   * NOT a `messages` column and deliberately so: it is a set of instants, and the ledger is where
   * instants live. It travels on this record only because this is the record that already holds the
   * merged analytics blob.
   */
  router_steps: unknown;
  /** When the channel flow received the turn's message, epoch ms. Standard path only. */
  flow_received_at: number | null;
  /**
   * WHICH ROUND OF A DUEL THIS MESSAGE IS, from the placeholder's own `<!--battle:-->` marker. NULL
   * on every ordinary turn.
   *
   * IT IS NOW A `messages` COLUMN TOO (migration 057), which reverses what this comment used to say.
   * The round was written only to the turn ledger, on the reasoning that the round qualifies a TURN.
   * True, and it left the round joinable to a latency SPAN and not to an ANSWER - so a reader asking
   * "what did each side say in round 2" had to cross two stores that do not join. It is written to
   * both: the ledger keeps it for the timeline, the exchange keeps it for the review.
   */
  battle_round: number | null;
  /**
   * WHICH DUEL this message belongs to (migration 057). `sha256(channelArn:userMessageId)`, so every
   * turn of one battle carries the same value and the value names no conversation.
   *
   * Read from the analytics blob rather than from a content marker, unlike the round above. The round
   * is resolved from content because the CREATE the ledger records against is the placeholder, whose
   * marker is the carrier that exists at that instant. The battle id is on the analytics metadata of
   * the answer itself, which is the row this column lives on - so taking it from content would be
   * reading a second carrier for a fact the first one already holds.
   *
   * NULL on an ordinary turn, which is how a battle turn is told from one.
   */
  battle_id: string | null;
  experiment_id: string | null;
  variant_id: string | null;
  was_fallback: boolean;
}

/**
 * Initialize schema with retry on auth failures
 */
async function initializeSchemaWithRetry(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_AUTH_RETRIES; attempt++) {
    try {
      await ensureSchema();
      return;
    } catch (error: any) {
      if (isAuthError(error) && attempt < MAX_AUTH_RETRIES) {
        console.log(`Schema init auth failure (attempt ${attempt}), retrying...`);
        resetConnection();
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      throw error;
    }
  }
}

/**
 * Lambda handler for Kinesis stream events
 */
export async function handler(
  event: KinesisStreamEvent | { op: string },
  context: Context
): Promise<void | ModelBackfillResult> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  // Direct-invoke maintenance op (not a Kinesis event): fold historical model +
  // token/latency telemetry from the out-of-band DynamoDB store onto Aurora rows
  // whose column is still NULL. Runs here because this Lambda already holds both
  // DynamoDB read and Aurora write (no new IAM grant needed). Idempotent.
  if ('op' in event) {
    if (event.op === 'backfillModelFromAnalytics') {
      await initializeSchemaWithRetry();
      const result = await backfillModelFromAnalytics();
      console.log('[model-backfill]', JSON.stringify(result));
      return result;
    }
    throw new Error(`[archival] unknown direct-invoke op: ${String(event.op)}`);
  }

  console.log(
    `Processing ${event.Records.length} Kinesis records, requestId: ${context.awsRequestId}`
  );

  // Cost sleep mode: record activity so the idle checker knows the deployment is
  // in use. Best-effort and fire-and-forget — a state-table hiccup must never
  // block archival. Only active when sleep mode wired the table env.
  if (process.env.DEPLOYMENT_STATE_TABLE) {
    touchActivity(Date.now()).catch((e) => console.warn('[sleep] touchActivity failed', e));
  }

  await initializeSchemaWithRetry();

  const records: MessageRecord[] = [];
  const errors: Error[] = [];

  for (const record of event.Records) {
    try {
      const payload = parseKinesisRecord(record);
      if (!payload) continue;

      const messageRecord = await transformToMessageRecord(payload);
      if (messageRecord) {
        records.push(messageRecord);
      }
    } catch (error) {
      console.error('Error parsing record:', error);
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (records.length === 0) {
    console.log('No records to archive');
    return;
  }

  console.log(`Archiving: ${records.length} records`);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_AUTH_RETRIES; attempt++) {
    try {
      await transaction(async () => {
        // 1. Insert all records to messages table
        const insertedCount = await insertMessageRecords(records);
        console.log(`Inserted ${insertedCount} records`);

        // 2. For CREATE_CHANNEL_MESSAGE events, update conversations and exchanges
        const createMessages = records.filter(
          (r) => r.event_type === 'CREATE_CHANNEL_MESSAGE'
        );
        if (createMessages.length > 0) {
          await ensureConversationsFromRecords(createMessages);
          const exchangeCount = await createExchangesFromRecords(createMessages, records);
          console.log(`Created ${exchangeCount} exchanges from batch`);

          // 3. Drift detection for user messages
          await processDriftDetection(createMessages);

          // 4. Update cross-conversation context
          await processContextUpdates(createMessages);
        }

        // THE CHANNELS THIS BATCH TOUCHED AT ALL, which the two pairing passes below both work over.
        // An answer arrives as an UPDATE, and the batch carrying it may hold no CREATE of its own.
        const touchedChannels = [...new Set(records.map((r) => r.channel_arn).filter(Boolean))];

        // 5. THE CROSS-BATCH SWEEP, OVER EVERY TOUCHED CHANNEL RATHER THAN ONLY CREATE-BEARING ONES.
        //
        // It defers a bot message whose answer update has not landed yet (see `updateDeferSeconds`
        // and the sweep's own WHERE clause), so it has to be given a turn on the batch that CARRIES
        // that update - otherwise the deferral would be permanent for every turn whose conversation
        // then went quiet, which is worse than the mislabeling it exists to prevent.
        //
        // AND STILL BEFORE THE FOLD, which is what makes that work rather than a detail of taste.
        // Every update row is already in `messages` (step 1 inserted the whole batch), so the deferral
        // can see it here; and the fold is what DERIVES `e2e_ms` and `inbound_ms` onto the exchange,
        // so the pairing has to exist by the time it runs. Minting after it would leave a
        // sweep-paired turn with no inbound_ms at all, since that update's fold has already passed.
        const dbExchangeCount = await createExchangesFromDatabase(touchedChannels);
        if (dbExchangeCount > 0) {
          console.log(`Created ${dbExchangeCount} exchanges from DB pairing`);
        }

        // 6. Fold placeholder->final edits onto the canonical CREATE row +
        //    exchange. Delivery is placeholder->update (the bot posts "One
        //    moment..." then edits in the real answer + model), so without this
        //    every analytics read resolves the placeholder and a null
        //    model/intent. Runs on every batch that carries UPDATE events.
        const updateMessages = records.filter(
          (r) => r.event_type === 'UPDATE_CHANNEL_MESSAGE'
        );
        if (updateMessages.length > 0) {
          await backfillFromUpdateEvents(updateMessages);
          // AN ANSWER WRITTEN INTO A NOTICE IS PAIRABLE ONLY ONCE ITS FINAL IS FOLDED, which is the
          // step just above and after the sweep. It is usually the last event of the turn, so no later
          // batch may come for that conversation; the sweep runs again here for those channels only.
          const answeredInNotice = [...new Set(updateMessages.filter(isAnswerWrittenIntoNotice).map((r) => r.channel_arn))];
          if (answeredInNotice.length > 0) {
            await createExchangesFromDatabase(answeredInNotice);
          }
        }

        // 7. A QUEUED MESSAGE THAT WAS ANSWERED IS A RESPONSE, AND GETS A ROW SAYING SO.
        //
        // AFTER the update fold, deliberately. The declaration rides the UPDATE that carries the
        // answer - the CREATE is a bare placeholder posted before the turn knows what it folded - so
        // running this earlier would look at rows that do not yet carry `answered_queued`.
        const queuedExchangeCount = await createQueuedExchanges(touchedChannels);
        if (queuedExchangeCount > 0) {
          console.log(`Created ${queuedExchangeCount} exchanges for answered queued messages`);
        }

        // 6. Sync membership events
        const membershipRecords = records.filter((r) =>
          MEMBERSHIP_EVENT_TYPES.includes(r.event_type)
        );
        if (membershipRecords.length > 0) {
          await syncMembershipRecords(membershipRecords);
        }

        // 7. Sync channel registry events. UPDATE_CHANNEL is included so a rename
        // (including the first-turn auto-title) reaches channel_name, not just the
        // creation-time placeholder.
        const channelRegistryRecords = records.filter(
          (r) => r.event_type === 'CREATE_CHANNEL' || r.event_type === 'UPDATE_CHANNEL'
        );
        if (channelRegistryRecords.length > 0) {
          await syncChannelRegistryRecords(channelRegistryRecords);
        }
      });

      console.log(
        `Successfully archived ${records.length} records, ${errors.length} errors`
      );
      // ── THE ARCHIVAL DROP RATE (G8, LATENCY-TARGETS.md) ──
      //
      // Every latency number on the console is computed over rows that REACHED this table, so a
      // dropped record does not make a metric wrong - it makes it silently narrower. That is the
      // worse failure: an average over 90% of the traffic reads exactly like an average over all of
      // it, and nothing on the dashboard moves. The count has existed in this log line all along and
      // could only be read by a human grepping CloudWatch after already suspecting a problem.
      //
      // Emitted as a metric so it can carry an ALARM, which is the only form of monitoring that
      // works for a failure nobody goes looking for. Both series are published deliberately:
      // Archived is the denominator, without which "12 errors" is unreadable.
      //
      // Through a NAMED emitter in its own module, not an inline envelope here: CloudWatch rejects a
      // malformed EMF document silently, and the schema guard can only exercise an emitter a test can
      // call. `emitArchivalHealth` swallows its own failures - measurement must not cost the archive.
      emitArchivalHealth({ archived: records.length, errors: errors.length });

      // THE SUMMARY FOLLOWS THE CONVERSATION. A conversation whose assistant just
      // answered has a new exchange in Aurora, so its summary and subjects are refreshed now rather than
      // on the next 30-minute scan, which stays as the backstop. After the commit, so the summary reads
      // what was just written; it never throws, so archival cannot fail over a summary.
      const answered = records
        .filter((r) => r.is_bot && (r.event_type === 'CREATE_CHANNEL_MESSAGE' || r.event_type === 'UPDATE_CHANNEL_MESSAGE'))
        .map((r) => r.channel_arn);
      if (answered.length) {
        const { summarized, deferred } = await summarizeChannelsNow(answered);
        if (summarized || deferred) console.log('[archival] summaries refreshed', { summarized, deferred });
      }
      return;
    } catch (error: any) {
      lastError = error;
      console.error(
        `Transaction failed (attempt ${attempt}/${MAX_AUTH_RETRIES}):`,
        error
      );

      if (isAuthError(error) && attempt < MAX_AUTH_RETRIES) {
        console.log('Auth failure detected, clearing connection state...');
        resetConnection();
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      break;
    }
  }

  console.error('All retry attempts failed');
  throw lastError;
}

/**
 * THE DUEL A TURN BELONGS TO, from whichever carrier that turn used.
 *
 * Three carriers exist. The out-of-band analytics record writes `metadata.analytics.battleContext`;
 * older rows carry the object at `metadata.battleContext`; and the slimmed Metadata on the channel
 * message itself carries the id as the scalar `battleId` (`FRONTEND_METADATA_KEYS`), because the full
 * context is too large to ride it. The scalar is the one carrier present on every battle reply, so a
 * reply whose out-of-band record never arrived is still filed under its duel. `resolveBattleChannels`
 * reads the same carriers in SQL, so the column and the JSON reader cannot disagree.
 *
 * Takes the already-merged `analytics` object AND the raw metadata, because the merge upstream
 * (`metadata.analytics || metadata`) resolves the flat case only when there is no `analytics` key at
 * all - a row with both would otherwise lose the flat value silently.
 */
export function battleIdOf(analytics: Record<string, any>, metadata: unknown): string | null {
  const m = (metadata ?? {}) as Record<string, any>;
  for (const candidate of [
    analytics?.battleContext?.battleId,
    m.battleContext?.battleId,
    analytics?.battleId,
    m.battleId,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * Parse a Kinesis record into a Chime event
 */
function parseKinesisRecord(
  record: KinesisStreamRecord
): ChimeKinesisEvent | null {
  try {
    const data = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
    return JSON.parse(data) as ChimeKinesisEvent;
  } catch (error) {
    console.error('Failed to parse Kinesis record:', error);
    return null;
  }
}

/**
 * Transform any Chime event into unified MessageRecord format
 */
export async function transformToMessageRecord(
  event: ChimeKinesisEvent
): Promise<MessageRecord | null> {
  const { EventType, Payload } = event;

  if (!ALL_ARCHIVABLE_EVENTS.includes(EventType)) {
    return null;
  }

  let messageId: string;
  let channelArn: string | null = null;
  let content: string | null = null;
  let senderArn: string | null = null;
  let senderName: string | null = null;
  let targetArn: string | null = null;
  // WHO THE MESSAGE WAS ADDRESSED TO, which is a different fact from targetArn above: that one is the
  // member a MEMBERSHIP event is about. The stream carries Target on every message record, including
  // ones no bearer can read, and this projection has been discarding it (migration 054).
  let messageTargetArn: string | null = null;
  let persistence: string | null = null;
  let metadata: Record<string, any> | null = null;
  let createdAt: string;
  // The event's own LastUpdatedTimestamp (Chime clock). For an UPDATE event this is when the update
  // happened (the final answer being posted), which `createdAt` does NOT capture (it prefers the fixed
  // original CreatedTimestamp). Drives agent_final_at / e2e_ms. Null when absent.
  let lastUpdatedAt: string | null = null;
  // Raw Chime MessageId (no archival suffix) — the key the out-of-band analytics
  // row is stored under (Phase 1). Only set for MESSAGE events.
  let rawChimeMessageId: string | null = null;

  if (MESSAGE_EVENT_TYPES.includes(EventType)) {
    if (!Payload.MessageId || !Payload.ChannelArn) {
      console.warn('Missing required fields in message payload');
      return null;
    }

    // ONE ROW PER EVENT (migration 084, update-events.ts). An UPDATE is keyed by the event itself, so
    // a message's second update is a row of its own rather than a collision the insert drops, and a
    // redelivery of the same event lands on the row it already wrote. A redaction and a deletion are
    // terminal facts and keep their fixed suffixes.
    const suffixMap: Record<string, string> = {
      CREATE_CHANNEL_MESSAGE: '',
      DELETE_CHANNEL_MESSAGE: '-DEL',
      REDACT_CHANNEL_MESSAGE: '-RED',
    };
    messageId = EventType === 'UPDATE_CHANNEL_MESSAGE'
      ? updateEventMessageId(Payload.MessageId, Payload)
      : Payload.MessageId + (suffixMap[EventType] ?? `-${EventType.substring(0, 10)}`);
    rawChimeMessageId = Payload.MessageId;
    channelArn = Payload.ChannelArn;
    senderArn = Payload.Sender?.Arn || null;
    senderName = Payload.Sender?.Name || null;
    persistence = Payload.Persistence || 'PERSISTENT';
    createdAt =
      Payload.CreatedTimestamp ||
      Payload.LastUpdatedTimestamp ||
      new Date().toISOString();
    // The UPDATE event's own timestamp (when the final answer replaced the placeholder), kept
    // separately from createdAt so agent_final_at reflects the answer time, not the placeholder time.
    lastUpdatedAt = Payload.LastUpdatedTimestamp || null;

    content = Payload.Content || null;
    if (content) {
      try {
        if (content.includes('%')) {
          content = decodeURIComponent(content);
        }
        const parsed = JSON.parse(content);
        if (parsed.Messages?.[0]?.Content) {
          content = parsed.Messages[0].Content;
        }
      } catch {
        // Not JSON, use as-is
      }
    }

    // WHO THIS MESSAGE WAS ADDRESSED TO (migration 054), read here and nowhere else on the turn path.
    //
    // Amazon Chime SDK carries `Target` on the stream record in full, on messages no bearer can read,
    // and this function has been reading the id, the channel, the sender, the timestamps, the content
    // and the metadata past it without ever touching it. So the archive knew and the projection did
    // not, and "who was this addressed to" was unanswerable from the queryable copy.
    //
    // FIRST ENTRY ONLY, and that is not a simplification. `Target` is a list in the API shape, and a
    // channel message is addressed to exactly one member: the platform sets one, and a reply inherits
    // one. Storing the first is the fact rather than a projection of it, and a row with more than one
    // would be a shape this deployment has never produced.
    const rawTarget = (Payload as { Target?: Array<{ MemberArn?: string }> }).Target;
    if (Array.isArray(rawTarget) && typeof rawTarget[0]?.MemberArn === 'string') {
      messageTargetArn = rawTarget[0].MemberArn;
    }

    if (Payload.Metadata) {
      try {
        metadata = JSON.parse(Payload.Metadata);
      } catch {
        metadata = { raw: Payload.Metadata };
      }
    }
  } else if (CHANNEL_EVENT_TYPES.includes(EventType)) {
    // Chime streams CREATE/UPDATE/DELETE_CHANNEL with the channel fields at the TOP
    // LEVEL of Payload (verified against the live stream), NOT nested under
    // Payload.Channel. Reading Payload.Channel dropped every channel event as
    // "missing Channel payload", so Aurora held no channel name or lifecycle rows:
    // conversation titles fell back to the first user message, and archived/deleted
    // state could not be derived. Read top-level, keeping Payload.Channel as a
    // defensive fallback so both shapes parse.
    const channel = Payload.Channel ?? Payload;
    const chArn = channel.ChannelArn || Payload.ChannelArn;
    if (!chArn) {
      console.warn(`Channel event ${EventType} missing Channel payload`);
      return null;
    }

    const crypto = require('crypto');
    const hash = crypto
      .createHash('md5')
      .update(chArn)
      .digest('hex')
      .substring(0, 16);
    // UPDATE events (rename + the archived-metadata mirror) must sort AFTER the
    // CREATE so the latest name/metadata wins in the read-path DISTINCT ON; a
    // rename leaves CreatedTimestamp fixed, so prefer LastUpdatedTimestamp.
    createdAt =
      channel.LastUpdatedTimestamp ||
      channel.CreatedTimestamp ||
      new Date().toISOString();
    // Deterministic, collision-free id. Previously `${EventType}-${hash}-${Date.now()}`
    // meant two channel events of the SAME type for the same channel in one archival
    // batch shared Date.now() → identical (message_id, channel_arn) → the second was
    // dropped by `ON CONFLICT (message_id, channel_arn) DO NOTHING`. That silently lost
    // the archived-metadata UPDATE_CHANNEL when it followed a rename UPDATE_CHANNEL in
    // the same batch. Keying off the event's own timestamp + a content hash keeps
    // distinct events distinct AND makes Kinesis redeliveries idempotent (Date.now()
    // made every replay a new duplicate row).
    const evtDisc = crypto
      .createHash('md5')
      .update(`${createdAt}|${channel.Name || ''}|${channel.Metadata || ''}`)
      .digest('hex')
      .substring(0, 12);
    messageId = `${EventType.substring(0, 20)}-${hash}-${evtDisc}`;
    channelArn = chArn;
    senderArn = channel.CreatedBy?.Arn || null;
    senderName = channel.CreatedBy?.Name || null;
    content = channel.Name || null;

    // A document that is not a JSON object is archived as sent, under `raw`.
    metadata = parseChannelMetadata(channel.Metadata) ?? { raw: channel.Metadata };
    metadata!.channelMode = channel.Mode;
    metadata!.channelPrivacy = channel.Privacy;
  } else if (MEMBERSHIP_EVENT_TYPES.includes(EventType)) {
    channelArn = Payload.ChannelArn || Payload.Channel?.ChannelArn || null;
    if (!channelArn) {
      console.warn(`Membership event ${EventType} missing channel ARN`);
      return null;
    }

    const crypto = require('crypto');
    const memberArn = Payload.Member?.Arn || 'unknown';
    const hash = crypto
      .createHash('md5')
      .update(`${channelArn}-${memberArn}`)
      .digest('hex')
      .substring(0, 16);
    messageId = `${EventType.substring(0, 20)}-${hash}-${Date.now()}`;
    targetArn = Payload.Member?.Arn || null;
    senderArn = Payload.InvitedBy?.Arn || null;
    senderName = Payload.InvitedBy?.Name || null;
    content = Payload.Member?.Name || null;
    createdAt = Payload.CreatedTimestamp || new Date().toISOString();
    // WHETHER THE OTHER MEMBERS COULD SEE THIS MEMBER. The event carries it and the archive keeps it, so
    // the projection keeps it too: without it no view can tell a hidden join (an operator joining
    // invisibly) from a visible one, or show what participants saw (SPEC-ADMIN-CONSOLE FR55).
    if (Payload.Type) metadata = { ...(metadata || {}), membershipType: Payload.Type };
  } else {
    return null;
  }

  const isBot = senderArn ? !senderArn.includes('/user/') : false;

  // Out-of-band analytics (SPEC-MESSAGE-METADATA-CODEBOOK.md Phase 1; ADR-016).
  // The heavy analytics-only fields do not ride the (size-capped) Chime
  // Metadata; they are persisted to a dedicated table keyed by the message id.
  // For bot messages, read that row and merge it over the slim inline metadata
  // (out-of-band wins; inline still carries the frontend-kept fields). Absent
  // row (pre-migration message, Athena mode, or fail-open) → fall back to
  // whatever the inline metadata holds, exactly as before.
  if (isBot && rawChimeMessageId) {
    const oob = await readMessageAnalytics(rawChimeMessageId);
    if (oob) {
      metadata = { ...(metadata || {}), ...oob };
      // A DELIVERED DOCUMENT IS COPIED INTO THE ARCHIVE HERE (SPEC-EVALUATION FR22), and the reference
      // the row keeps says where. Read from the out-of-band record only: that record is the
      // processor's own, and the inline Metadata is not where a document reference is declared.
      const delivered = deliveredDocumentOf(oob);
      // EVERY EVENT OF THE MESSAGE READS THE SAME RECORD, so the copy is made on the events that write the message
      // (its create and its updates) and never on its redaction or deletion. Repeats across those events are
      // skipped once a container has copied the document (`archiveDeliveredDocument`).
      const writesTheMessage = EventType === 'CREATE_CHANNEL_MESSAGE' || EventType === 'UPDATE_CHANNEL_MESSAGE';
      if (delivered && channelArn && writesTheMessage) {
        metadata = {
          ...metadata,
          deliveredDocument: await archiveDeliveredDocument({
            s3: archiveS3(),
            attachmentsBucket: process.env.ATTACHMENTS_BUCKET || '',
            archiveBucket: process.env.ARCHIVE_BUCKET || '',
            channelArn,
            classification: typeof oob.classification === 'string' ? oob.classification : undefined,
            reference: delivered,
          }),
        };
      }
    }
  }

  const analytics = (metadata as any)?.analytics || metadata || {};

  // ── WHAT A HANDLER-ANSWERED TURN DECLARED, BECAUSE IT HAS NOWHERE ELSE TO PUT IT ──────────────
  //
  // A `DIRECT` answer is returned by the Lex fulfillment and materialized by Amazon Chime SDK. A
  // fulfillment return carries messages and session attributes; it carries no message metadata, so
  // not one of the fields below could ever reach here for that turn - which is why the `unknown`
  // delivery-option bucket held 1,134 exchanges with one day-row carrying any `e2e_ms` (measured
  // 2026-09-11), and why its pairing was left to adjacency. What that turn CAN hand forward is its
  // own content, so it declares there (`lib/turn-declaration.ts`).
  //
  // METADATA WINS WHERE BOTH EXIST. Content is the carrier of last resort: a declaration in Metadata
  // was written by the processor about the message that metadata lands on, while content travels
  // through a guardrail and a channel flow that may both rewrite it.
  //
  // BOT RECORDS ONLY. A declaration is a statement a turn makes about its own answer. Read off a
  // person's message it would let anyone who can type assert who answered what.
  const declared = isBot ? turnDeclarationOf(content) : {};

  // THE DECLARED PHASE. Read from the TOP level of the blob, where `updateMessage`
  // merges it, and from the analytics sub-object as a fallback so a producer that nests it is not
  // silently ignored. Absent on every message written before this shipped, which is what keeps the
  // legacy inference below reachable for them and only for them.
  // Same two sources as respPhase, for the same reason: the frontend-rendered Metadata carries it on
  // the paths that keep a full blob, and the out-of-band analytics record carries it everywhere else.
  const triggerKind: string | null =
    (typeof (metadata as any)?.trigger === 'string' ? (metadata as any).trigger : null)
    ?? (typeof analytics.trigger === 'string' ? analytics.trigger : null);

  // HOW THE TURN ENTERED, read the same two ways and for the same reason. Constrained to the values a
  // turn can honestly declare (`TURN_ENTRIES`): anything else is a producer this reader does not know, and
  // an unrecognized entry is not written through as a value queries would group by.
  // THE CONTENT DECLARATION IS THE CARRIER OF LAST RESORT, exactly as it is for `delivery` below.
  // The metadata does not always arrive: it is slimmed in Aurora mode (`entry` is not a kept key) and
  // a `DIRECT` answer materialized from a Lex fulfillment carries none at all. Without this fallback
  // the entry was simply lost on those turns, which is why 153 `TASK_MULTI_STEP` and 24 `DIRECT`
  // turns over 30 days carried a delivery option and no entry: one key had a content carrier and the
  // other did not.
  const rawEntry = (typeof (metadata as any)?.entry === 'string' ? (metadata as any).entry : null)
    ?? (typeof (analytics as any).entry === 'string' ? (analytics as any).entry : null)
    ?? declared.entry
    ?? null;
  // A TURN OF A KIND NO MESSAGE STARTS IS NAMED BY THAT KIND (`turnEntryOf`): a rebuttal, a welcome or an
  // event step a producer wrote without an entry entered through neither door, so it records `platform`
  // rather than an unrecorded path. A person-started turn with no declaration stays NULL: its door is a fact
  // only the router knew.
  const turnEntry: string | null = turnEntryOf(rawEntry, triggerKind) ?? null;

  const respPhase: string | null =
    (typeof (metadata as any)?.respPhase === 'string' ? (metadata as any).respPhase : null)
    ?? (typeof analytics.respPhase === 'string' ? analytics.respPhase : null)
    // And from the content declaration, which is the only phase a handler-answered turn can state.
    // It matters more here than anywhere else: that message carries a correlation marker, and the
    // ledger reads a marked bot CREATE as a PLACEHOLDER - a response something else will close. A
    // turn that posts once and is finished would otherwise open a response that never closes, which
    // would land every greeting in the unclosed-turn population.
    ?? declared.phase
    ?? null;

  // WHICH MESSAGE A DEFERRAL NOTICE IS ACKNOWLEDGING.
  //
  // The notice is the response a queued message actually gets, and it was unmeasurable: it carries no
  // correlation marker, so it declares no turn to join on, and it is ONE message updated in place, so
  // every queued send shares its id. Naming the acknowledged message on each post is what separates
  // them - without it the second and third sends have no first-feedback instant of their own, which
  // ADR-033 requires them to have.
  const acknowledges: string | null =
    typeof (metadata as any)?.acknowledges === 'string' ? (metadata as any).acknowledges : null;

  // THE DRAIN STAGE THIS NOTICE UPDATE RECORDS. Without it the ledger cannot tell the notice being
  // CREATED from the notice being SETTLED - they are the same message id and the same kind - so any
  // "when was the queue read" measure had to guess with MIN or MAX over every update, and MIN gave a
  // read instant EARLIER than the acknowledgement it followed.
  const queueStatus: string | null =
    typeof (metadata as any)?.queueStatus === 'string' ? (metadata as any).queueStatus : null;

  // ── WHAT THIS TURN DECLARED (2026-09-10) ──────────────────────────────────────────────────────
  //
  // `answersMessageId` is the message this answer answers, named by the turn that produced it rather
  // than inferred downstream. `turnKind` says a turn is queue work - a reading answers a BURST, so it
  // has no single target and must not pair with one.
  //
  // Carried onto the record because BOTH pairing paths need them, and the in-batch path has no SQL to
  // read metadata JSON with: it works from these flattened fields.
  //
  // ── AND A HANDLER-ANSWERED TURN DECLARES BOTH IN CONTENT (see `declared` above) ───────────────
  const answersMessageId = typeof analytics.answersMessageId === 'string'
    ? analytics.answersMessageId : (declared.answers || null);
  // A TRIGGER THAT ANSWERS NO MESSAGE IS ALSO A KIND (`answersNoMessage`). A join recap declares its
  // trigger and no kind: the processor stamps `trigger: join_recap` on the answer, and that trigger says
  // as plainly as a kind would that the turn is not the reply to any message. Recorded as the kind only
  // when the turn declared none, on bot records only, so both pairing paths skip it by the one test they
  // already apply, and the turn-kinds view lists it as itself rather than in the `answer` remainder.
  const turnKind = typeof analytics.turnKind === 'string'
    ? analytics.turnKind
    : (declared.kind || (isBot && answersNoMessage(triggerKind) ? triggerKind : null));
  // THE QUEUED MESSAGES THIS ANSWER ADDRESSES. Read only off a BOT record and only as an array of
  // strings: it decides which person's message is recorded as answered, so a value of any other
  // shape is dropped rather than coerced into ids.
  const answeredQueued: string[] = isBot && Array.isArray(analytics.answeredQueued)
    ? (analytics.answeredQueued as unknown[]).filter((id): id is string => typeof id === 'string' && !!id)
    : [];
  const intent = analytics.intent || null;
  const intentConfidence = analytics.intentConfidence || null;
  const wasRerouted = analytics.wasRerouted === true;
  const deliveryOption = analytics.deliveryOption || declared.delivery || null;
  // A CLOSE-OUT CARRIES A BARE `taskId`, NOT AN `activeTask` BLOB. The receipt a
  // turn leaves behind is the message the exchange is minted against, so it has to be able to say
  // which task the turn advanced - but the blob carries a STATUS, and a terminal status is what the
  // ledger reads as `task_terminal`. Carried on the receipt as well as on the answer, one task ending
  // would be recorded twice. So the close-out declares the id alone and this reads either carrier.
  const taskId = analytics.activeTask?.taskId
    || (typeof analytics.taskId === 'string' ? analytics.taskId : null);
  const taskStatus = analytics.activeTask?.status || null;
  // Machine state (§6): stamped per turn by buildAnalyticsMetadata. taskTransition is absent on a
  // turn that advanced nothing; kept structured ({from,to}) for the JSONB column.
  //
  // `from` may be EMPTY and must survive that way: an empty `from` IS the open edge - "nothing
  // preceded this state" - and it is what the turn-events projection reads as `task_opened`. The
  // previous truthiness check (`.from && .to`) silently dropped exactly the edge whose emptiness is
  // its meaning, so the producer's declaration never reached the column and `opened_at` stayed NULL
  // on live data while the projection's unit tests passed on synthesized rows.
  const taskState = analytics.taskState || null;
  const taskTransition =
    analytics.taskTransition
      && typeof analytics.taskTransition.from === 'string'
      && analytics.taskTransition.to
      ? { from: analytics.taskTransition.from, to: analytics.taskTransition.to }
      : null;

  return {
    event_type: EventType,
    message_id: messageId,
    channel_arn: channelArn!,
    content,
    sender_arn: senderArn,
    sender_name: senderName,
    target_arn: targetArn,
    targeted_to: messageTargetArn,
    is_bot: isBot,
    // DECLARED BY THE TURN, never looked up here: the dispatcher read it from the channel's immutable
    // tag. `user_type` is deprecated (migration 050) and no longer written.
    conversation_classification: analytics.classification || null,
    // ── WHAT KIND OF PRINCIPAL SENT THIS ────────────────────────────────────────────────────────
    //
    // Derived from the sender ARN rather than declared, because unlike a clearance it cannot move:
    // the ARN names a person, the admin identity, a federated sender or a bot, and it says so
    // whenever it is read. That is what lets a message a PERSON sent carry it at all - a person's
    // message arrives from Amazon Chime SDK with no AE metadata on it, so every producer-declared
    // field on that row is null.
    user_role: classifyPrincipal(senderArn ?? undefined, ADMIN_USER_ID).kind,
    // WHO, BY ID (ADR-043, migration 074). The bare id after `/user/`, the same shape drift_events
    // stores, so a person's turns join their other records without parsing an ARN or trusting a display
    // name. Null on an assistant's message: the assistant is `agent_type`.
    // An admin-plane twin's message is attributed to the person who holds the twin, so it is counted and
    // erased with them; `user_role` still says it was sent on the admin plane.
    person_id: isBot ? null : senderPersonKey(classifyPrincipal(senderArn ?? undefined, ADMIN_USER_ID)),
    // POINT IN TIME. Recorded from what the turn DECLARED, never looked up now: a person clearance
    // moves on a classification change, so reading their groups or their identity tag here would answer what
    // they hold today and file it against a turn from last month.
    user_clearance: analytics.userClearance || null,
    // ── DECLARED OR NULL. NEVER GUESSED (owner direction, 2026-09-13) ──────────────────────────
    //
    // This used to fall back to `extractAgentType(senderArn)`, which matched substrings in the bot
    // ARN - 'admin' meant premium, 'auth' meant standard - and returned null when none hit. That is
    // a guess wearing a resolution's clothes: it cannot be right about a deployment whose bots are
    // named anything else, and every miss landed as an 'unknown' row that looked like a measurement.
    //
    // The turn DECLARES its classification, and a message with no declaration is not an assistant
    // turn - it is a notice, a welcome or a drift post. NULL is the honest record of that, and the
    // latency query now excludes non-turns rather than bucketing them.
    // METADATA FIRST, THEN THE CONTENT DECLARATION, which is the same precedence `entry` and `phase`
    // use a few lines above and for the same reason: a Lex-entry answer is materialized by Amazon
    // Chime SDK from the fulfillment and carries NO metadata at all, so the declaration is its only
    // carrier. Two such returns carry a correlation marker and are therefore counted as turns - the
    // DIRECT quick answer and the drift-spawned welcome - and both landed here with NULL before this
    // fallback existed, which the latency query renders as an unknown assistant.
    //
    // The declared value is checked against the deployment's declared roster in
    // `turnDeclarationOf`, so an unrecognized name arrives here as absent rather than as an invented
    // assistant in every console rollup.
    assistant: analytics.agentType || declared.assistant || null,
    // Recorded, never defaulted: an assumed 'primary' would be indistinguishable from a turn that
    // genuinely declared it, which is the same substitution that let a classification stand in for an
    // assistant. NULL says "this turn did not declare one".
    assistant_role: analytics.assistantRole || null,
    profile_version: typeof analytics.profileVersion === 'number' ? analytics.profileVersion : null,
    profile_config_id: analytics.profileConfigId || null,
    profile_name: analytics.profileName || null,
    // The analytics metadata stores the model under `bedrockModel` (buildAnalyticsMetadata), NOT
    // `model` — reading the wrong key left bedrock_model NULL on every archived message, which zeroed
    // out model_usage + the Effectiveness cost/reply estimate (tokens landed because their keys matched).
    bedrock_model: analytics.bedrockModel || analytics.model || null,
    input_tokens: analytics.inputTokens || null,
    output_tokens: analytics.outputTokens || null,
    latency_ms: analytics.latencyMs || analytics.bedrockLatencyMs || null,
    total_ms: analytics.totalMs || null,
    // typeof-guarded, NOT ||: a resolve that completed inside a millisecond is a real 0 and the
    // best reading the metric has - coercing it to NULL would drop the fastest turns out of the
    // average and make locating look slower than it is.
    router_ms: typeof analytics.routerMs === 'number' ? analytics.routerMs : null,
    classifier_ms: typeof analytics.classifierMs === 'number' ? analytics.classifierMs : null,
    // ── WHAT THE CLASSIFICATION COST (migration 063) ──
    //
    // All three or none, matching how the router emits them: a token count without the model that
    // consumed it cannot be priced, because the classifier is per-profile configurable. NULL on a turn
    // that asked no model, which is the fast paths and orchestrator-dispatched turns - never 0, or the
    // classifier reads cheaper the more often it is skipped rather than rarer.
    classifier_tokens_in: typeof (analytics as any).classifierTokensIn === 'number'
      ? (analytics as any).classifierTokensIn : null,
    classifier_tokens_out: typeof (analytics as any).classifierTokensOut === 'number'
      ? (analytics as any).classifierTokensOut : null,
    classifier_model: typeof (analytics as any).classifierModel === 'string'
      ? (analytics as any).classifierModel : null,
    guard_ms: typeof analytics.guardMs === 'number' ? analytics.guardMs : null,
    placeholder_resolve_ms: typeof analytics.placeholderResolveMs === 'number' ? analytics.placeholderResolveMs : null,
    // Same guard, for the opposite reason: a scan that returned immediately still HAPPENED, and the
    // count of this column is the fallback rate. || null would erase that turn from the rate.
    poll_ms: typeof analytics.pollMs === 'number' ? analytics.pollMs : null,
    // TRUE or NULL, never FALSE (G9). The producer writes the key only on a cold turn, so a warm turn
    // is an ABSENCE - and `=== true` keeps it that way rather than coercing some other truthy value
    // into a claim about a container this record cannot see.
    cold_start: analytics.coldStart === true ? true : null,
    // Epoch ms in, ISO out, so the column is a real timestamp and the view compares timestamps rather
    // than doing arithmetic at read time. Finite-guarded: a malformed value becomes NULL, never a
    // 1970 instant that would report a wait of decades.
    trigger_at: typeof analytics.triggerAtMs === 'number' && Number.isFinite(analytics.triggerAtMs)
      ? new Date(analytics.triggerAtMs).toISOString()
      : null,
    model_ms: typeof analytics.modelMs === 'number' ? analytics.modelMs : null,
    tool_ms: typeof analytics.toolMs === 'number' ? analytics.toolMs : null,
    processor_entry_ms: typeof analytics.processorEntryMs === 'number' ? analytics.processorEntryMs : null,
    persistence,
    metadata,
    created_at: createdAt,
    last_updated_at: lastUpdatedAt,
    base_message_id: rawChimeMessageId,
    resp_phase: respPhase,
    acknowledges,
    queue_status: queueStatus,
    trigger_kind: triggerKind,
    turn_entry: turnEntry,
    answers_message_id: answersMessageId,
    turn_kind: turnKind,
    answered_queued: answeredQueued,
    intent,
    intent_confidence: intentConfidence,
    was_rerouted: wasRerouted,
    delivery_option: deliveryOption,
    task_id: taskId,
    task_status: taskStatus,
    task_state: taskState,
    task_transition: taskTransition,
    // A bot turn's own statement only, like the attribution below.
    task_terminal: isBot && typeof analytics.taskTerminal === 'string' ? analytics.taskTerminal : null,
    // A bot turn's own statement only: a person's message chooses no model.
    task_type: isBot ? shortString(analytics.taskType ?? analytics.activeTask?.type, 64) : null,
    task_step: isBot ? shortString(analytics.turnStep, 32) : null,
    model_kind: isBot && (analytics.modelKind === 'text' || analytics.modelKind === 'image') ? analytics.modelKind : null,
    model_from: isBot ? shortString(analytics.modelFrom, 16) : null,
    router_steps: analytics.routerSteps ?? null,
    flow_received_at: typeof analytics.flowReceivedAt === 'number' ? analytics.flowReceivedAt : null,
    // ── WHICH ROUND OF A DUEL, READ OFF THE PLACEHOLDER ITSELF ─────────────────────────────────
    //
    // BOT RECORDS ONLY, for the same reason the turn declaration above is: a marker read off a
    // person's message would let anyone who can type file their turn as a duel round.
    //
    // Sourced from content rather than from `analytics.battleContext.round`, which this function
    // already merges - `battleRoundOf` carries the argument, and it comes down to which of the two
    // is on the CREATE the ledger records the round against.
    battle_round: isBot ? battleRoundOf(content) : null,
    // WHICH DUEL (migrations 057, 073). Every carrier is read (`battleIdOf`). Bot records only, like
    // the round: a battle id read off a person's message would let anyone who can type file their
    // turn into someone else's duel.
    battle_id: isBot ? battleIdOf(analytics, metadata) : null,
    experiment_id: analytics.experimentId || null,
    variant_id: analytics.variantId || null,
    was_fallback: analytics.wasFallback === true,
  };
}

/**
 * Insert message records into unified messages table
 */
async function insertMessageRecords(records: MessageRecord[]): Promise<number> {
  // ── THE ROOM AND THE RESPONDER DISAGREED, AND SOMEBODY SHOULD LOOK (owner direction, 2026-09-13) ──
  //
  // `agent_type` is the ASSISTANT that answered - one classification, its own, always. The ROOM's
  // classification is compared from `channel_classification`, the isolation projection written from
  // the router's read of the immutable tag, and not from the row's own `conversation_classification`:
  // that one is what the turn declared in message metadata, and a check between two values the same
  // producer wrote would agree with itself.
  //
  // ONE LOOKUP PER DISTINCT CHANNEL in the batch, not per record: a batch is usually one or two
  // conversations, and the reader is a single indexed row read.
  //
  // THE INVARIANT: an assistant is ASSIGNED one classification, a channel has one, and an exchange
  // happens between parties that match. Neither direction of disagreement is acceptable - see below.
  //
  // A report, never a refusal: the turn has already been answered and the person already has it.
  // Archival is simply the first place both facts sit together.
  const classifiedChannels = new Map<string, string | null>();
  for (const r of records) {
    if (!r.assistant) continue;
    if (!classifiedChannels.has(r.channel_arn)) {
      classifiedChannels.set(r.channel_arn, await lookupChannelClassification(r.channel_arn).catch(() => null));
    }
    const room = classifiedChannels.get(r.channel_arn);
    if (!room) continue;

    // ── `agent_type` NAMES THE ASSISTANT, NOT ITS CLASSIFICATION (migration 055) ──────────────────
    //
    // This comparison was written when the two were the same string, and it was compared directly.
    // Once `agent_type` began carrying the assistant's own name, `premium` was measured against
    // `advisor` on EVERY archived bot message: never equal, so the check reported a boundary
    // crossing every time, and `channelsActableBy('advisor')` returned an empty set - so the
    // direction was always "above" too. A control that fires on every row is not a strict control,
    // it is a silent one, because nobody can find the real event in it.
    //
    // The assistant's classification is config, so it is resolved from config. An UNDECLARED name
    // resolves to nothing and is reported rather than skipped: this check exists to catch an
    // identity acting where it should not be, and an identity the deployment cannot account for is
    // the strongest form of that, not an exemption from it.
    // EVERY DECLARED ASSISTANT, a role's included (`classificationOfAssistant`): `classificationFor`
    // answers only for a classification's primary, so it reported every message from a role's
    // assistant (`ops-premium`) as an undeclared identity.
    // A RUNTIME ASSISTANT (ADR-048) is not in the compiled registry, and this function cannot read its
    // record (no SSM endpoint in its VPC), so the turn's own stamp names its classification. Accepted
    // only on a bot's own message (a person's message metadata is theirs to write), and only for a name no
    // deploy-time assistant or alt could own; a reserved name with no registry entry is still an undeclared identity.
    const analytics = (r.metadata as Record<string, any> | null)?.analytics || r.metadata || {};
    const stamped = r.is_bot && typeof analytics.runtimeClassification === 'string' && !profiles.isReservedAssistantName(r.assistant)
      ? profiles.resolveClassification(analytics.runtimeClassification)
      : undefined;
    const servingClassification = profiles.classificationOfAssistant(r.assistant) ?? stamped;
    if (servingClassification === room) continue;

    const detail = {
      messageId: r.message_id,
      channelArn: r.channel_arn,
      servedAs: r.assistant,
      servesClassification: servingClassification ?? '(undeclared assistant)',
      channelIs: room,
    };
    // ANY DISAGREEMENT IS A DEFECT. NOT ONE DIRECTION (owner direction, 2026-09-13) ────────────────
    //
    // An assistant is ASSIGNED exactly one classification and a channel has exactly one. An exchange
    // is therefore between parties that MATCH, and a participant who does not hold the channel's
    // classification should never have been admitted to it in the first place.
    //
    // So "served below the room" is NOT the expected case, and reporting it as routine - which this
    // did until now - is the same mistake one level up: it treats a bound min-cap as the design
    // working, when a bound min-cap means somebody is in a room they should not be in. The min-cap
    // stays as defense in depth, because a control that never fires is still the control that catches
    // the day admission is wrong. But its FIRING is the signal, not the resolution.
    //
    // Both directions are reported, and the direction is named because it says which way the
    // admission failed - not because one of them is acceptable.
    // NOT "THE ASSISTANT OUTRANKS THE ROOM". An assistant acts in exactly its own
    // classification, so the boundary event is simply that it acted somewhere else - which is the
    // only shape this can take once `legal` and `finance` are peers with no order between them.
    const above = !servingClassification || !profiles.channelsActableBy(servingClassification).includes(room);
    console.error('[KinesisArchival][SecurityEvent] an exchange crossed a classification boundary', {
      ...detail,
      direction: above ? 'assistant above the channel' : 'assistant below the channel',
    });
  }

  const columns = [
    'event_type',
    'message_id',
    'channel_arn',
    'content',
    'sender_arn',
    'sender_name',
    'target_arn',
    // WHO IT WAS ADDRESSED TO (migration 054), beside target_arn and deliberately not merged with it:
    // that column means the member a MEMBERSHIP event is about, and one column with two meanings would
    // silently mix the two populations for anyone filtering on it.
    'targeted_to',
    'is_bot',
    'conversation_classification',
    'user_role',
    'person_id',
    'user_clearance',
    'assistant',
    'assistant_role',
    'profile_version',
    'profile_config_id',
    'profile_name',
    'bedrock_model',
    'input_tokens',
    'output_tokens',
    'latency_ms',
    'total_ms',
    'router_ms',
    'classifier_ms',
    'classifier_tokens_in',
    'classifier_tokens_out',
    'classifier_model',
    'guard_ms',
    'placeholder_resolve_ms',
    'poll_ms',
    'cold_start',
    'trigger_at',
    'persistence',
    'task_id',
    'task_status',
    'task_state',
    'task_transition',
    // ADR-064 decision 4 (migration 092).
    'task_type',
    'task_step',
    'model_kind',
    'model_from',
    'experiment_id',
    'variant_id',
    'was_fallback',
    // WHAT THE TURN DECLARED ABOUT ITSELF (migration 042). Resolved once, in `buildMessageRecord`,
    // from whichever carrier that turn had - Metadata for a processor-delivered answer, the
    // `<!--turn:-->` content declaration for a handler-answered one - so the sweep can obey a
    // declaration rather than re-derive one, and so a person can filter on kind without a JSON
    // extraction per row. NULL on every row written before this, which is what keeps the fallback
    // in both readers reachable and correct.
    'answers_message_id',
    'turn_kind',
    // AND WHICH QUEUED MESSAGES IT ADDRESSES (migration 052). A column rather than a JSON read for
    // the same reason as the two above: the pairing pass that expands it is SQL, and it cannot reach
    // into a metadata blob. NULL on every ordinary answer, which is almost all of them.
    'answered_queued',
    // WHEN THE ANSWER ARRIVED, FOR A TURN THAT HAS NO UPDATE TO FOLD IT FROM.
    //
    // `agent_final_at` has one writer, the UPDATE fold, and a DIRECT turn produces no update - so
    // the one delivery option whose answer time is trivially its own timestamp is the one with no
    // answer time at all, and every figure built on e2e_ms describes a different set of turns from
    // the one it names.
    //
    // DECLARED, NOT INFERRED FROM THE ABSENCE OF AN UPDATE. The fold below already gates on the
    // producer's declared `respPhase`, and this is the same gate one event earlier: a CREATE that
    // says it is final IS the answer, and its own Chime timestamp is when it arrived.
    'agent_final_at',
    // AND HOW IT WAS DELIVERED. `exchanges.delivery_option` has existed since 001 and only the
    // in-batch pairer ever set it; the sweep had nowhere to read it from, so every exchange it
    // minted landed in the `unknown` bucket whatever the turn actually did.
    'delivery_option',
    // HOW THE TURN ENTERED (migration 054). On `messages` rather than `turn_events` because the two
    // queries that need to group by it, `getLatencyMetrics` and `getRouterSteps`, already sit on this
    // table, and `v_turn_latency` already joins it - so this is one column and one appended view
    // column instead of a CTE change and an aggregate that would need an explicit cast to survive the
    // next `CREATE OR REPLACE`. NULL on every row written before it, never a default.
    'turn_entry',
    // WHICH DUEL, AND WHICH ROUND OF IT (migration 057). On `messages` because the question they
    // answer is about the ANSWER - what each side said, how it scored, what it cost - and those live
    // here. `battle_round` is also written to `turn_events`, which is not a duplicate of one fact but
    // the same fact serving two joins: the ledger's is against a latency span, this one against an
    // exchange. Before this, a duel was groupable only through a JSON path no GROUP BY would find.
    'battle_id',
    'battle_round',
    'metadata',
    'created_at',
    // WHICH MESSAGE THIS EVENT IS ABOUT, AND WHEN IT HAPPENED (migration 084). Every update of a message
    // is its own row, so a reader finds them by base_message_id and orders them by the event's own
    // instant (update-events.ts). created_at keeps the message's original CreatedTimestamp.
    'base_message_id',
    'last_updated_at',
  ];

  const rows = records.map((r) => ({
    event_type: r.event_type,
    message_id: r.message_id,
    channel_arn: r.channel_arn,
    content: r.content,
    sender_arn: r.sender_arn,
    sender_name: r.sender_name,
    target_arn: r.target_arn,
    targeted_to: r.targeted_to,
    is_bot: r.is_bot,
    conversation_classification: r.conversation_classification,
    user_role: r.user_role,
    person_id: r.person_id,
    user_clearance: r.user_clearance,
    assistant: r.assistant,
    assistant_role: r.assistant_role,
    profile_version: r.profile_version,
    profile_config_id: r.profile_config_id,
    profile_name: r.profile_name,
    bedrock_model: r.bedrock_model,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    latency_ms: r.latency_ms,
    total_ms: r.total_ms,
    router_ms: r.router_ms,
    classifier_ms: r.classifier_ms,
    classifier_tokens_in: r.classifier_tokens_in,
    classifier_tokens_out: r.classifier_tokens_out,
    classifier_model: r.classifier_model,
    guard_ms: r.guard_ms,
    placeholder_resolve_ms: r.placeholder_resolve_ms,
    poll_ms: r.poll_ms,
    cold_start: r.cold_start,
    trigger_at: r.trigger_at,
    persistence: r.persistence,
    task_id: r.task_id,
    task_status: r.task_status,
    task_state: r.task_state,
    // JSONB column — stringify the {from,to} object (NULL stays NULL for a no-transition turn).
    task_transition: r.task_transition ? JSON.stringify(r.task_transition) : null,
    task_type: r.task_type,
    task_step: r.task_step,
    model_kind: r.model_kind,
    model_from: r.model_from,
    experiment_id: r.experiment_id,
    variant_id: r.variant_id,
    was_fallback: r.was_fallback,
    answers_message_id: r.answers_message_id,
    turn_kind: r.turn_kind,
    // NULL RATHER THAN AN EMPTY ARRAY. `batchInsert` passes the value through, and `{}` in a TEXT[]
    // column is a row that says "this answer addressed no queued messages" - which is a claim, while
    // NULL is the absence of one. Every reader below tests for NULL.
    answered_queued: r.answered_queued.length ? r.answered_queued : null,
    // Only a bot CREATE that declared itself final. An UPDATE's finality is folded onto the
    // canonical CREATE row by backfillFromUpdateEvents, which owns the COALESCE that freezes it.
    agent_final_at:
      r.is_bot && r.event_type === 'CREATE_CHANNEL_MESSAGE' && r.resp_phase === 'final'
        ? r.created_at
        : null,
    delivery_option: r.delivery_option,
    turn_entry: r.turn_entry,
    battle_id: r.battle_id,
    battle_round: r.battle_round,
    metadata: JSON.stringify(r.metadata || {}),
    created_at: r.created_at,
    base_message_id: r.base_message_id,
    last_updated_at: r.last_updated_at,
  }));

  const inserted = await batchInsert(
    'messages',
    columns,
    rows,
    'ON CONFLICT (message_id, channel_arn) DO NOTHING'
  );

  // THE LEDGER, WRITTEN FROM THE SAME BATCH. `turn_events` had existed since migration
  // 019 with no runtime writer at all - only a hand-run backfill - so `v_turn_latency` and
  // `v_task_resolution` were built, documented and empty.
  //
  // Best-effort and deliberately AFTER the archive write: losing a measurement must never cost an
  // archive record, so `writeTurnEvents` swallows its own failures rather than failing this batch.
  await writeTurnEvents(records.map((r) => ({
    event_type: r.event_type,
    message_id: r.message_id,
    channel_arn: r.channel_arn,
    sender_arn: r.sender_arn,
    is_bot: r.is_bot,
    created_at: r.created_at,
    last_updated_at: r.last_updated_at,
    resp_phase: r.resp_phase,
    acknowledges: r.acknowledges,
    queue_status: r.queue_status,
    trigger_kind: r.trigger_kind,
    content: r.content,
    task_id: r.task_id,
    task_state: r.task_state,
    // The two the task kinds are derived from. Already on the archive record; they were simply never
    // handed to the ledger, which is why v_task_resolution had nothing to aggregate.
    task_status: r.task_status,
    task_transition: r.task_transition,
    // The machine `task_status` may be a state of, and the ending the turn's runtime declared from its pack.
    task_type: r.task_type,
    task_terminal: r.task_terminal ?? null,
    // The router's pre-placeholder boundaries. Passed through untouched and validated by the ledger
    // writer, which is the component that knows which step names exist.
    router_steps: r.router_steps,
    // The channel flow's receipt instant, written as its own server-clock ledger row.
    flow_received_at: r.flow_received_at,
    // The duel round, which the ledger records on the placeholder row `v_turn_latency` already
    // selects it from. Until this was passed, `turn_events.battle_round` was declared end to end and
    // written by nothing, so a round-1 duel side voted in every latency population as an ordinary
    // turn with no field to filter it out by.
    battle_round: r.battle_round,
  })));

  return inserted;
}

/**
 * Ensure conversation records exist for channels
 */
async function ensureConversationsFromRecords(
  records: MessageRecord[]
): Promise<void> {
  const channels = [...new Set(records.map((r) => r.channel_arn))];

  for (const channelArn of channels) {
    const channelRecords = records.filter((r) => r.channel_arn === channelArn);
    // NULL when no record in this batch declared one, never 'unknown': a later batch that carries a
    // turn fills it, which a literal default would have blocked.
    const conversationClassification =
      channelRecords.find((r) => r.conversation_classification)?.conversation_classification ?? null;
    const agentType = channelRecords.find((r) => r.assistant)?.assistant;

    await query(
      `INSERT INTO conversations (channel_arn, conversation_classification, assistant, first_message_at, last_message_at, message_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (channel_arn) DO UPDATE SET
         last_message_at = GREATEST(conversations.last_message_at, EXCLUDED.last_message_at),
         message_count = conversations.message_count + EXCLUDED.message_count,
         conversation_classification = COALESCE(conversations.conversation_classification, EXCLUDED.conversation_classification),
         updated_at = NOW()`,
      [
        channelArn,
        conversationClassification,
        agentType,
        channelRecords[0]?.created_at,
        channelRecords[channelRecords.length - 1]?.created_at,
        channelRecords.length,
      ]
    );
  }
}

/**
 * THE ONE GUESS, AND ITS THREE PARTS, DECLARED ONCE SO TWO PATHS CANNOT MAKE IT DIFFERENTLY.
 *
 * Where no turn declared what it answered, an exchange is inferred: the reply carries a correlation
 * marker, it lands within a bound of the prompt, and no other person spoke in between. The sweep has
 * applied all three since they were written; the in-batch pairer applied NONE, so the same
 * conversation paired by different rules depending on which Kinesis batch each half landed in.
 *
 * Stated here rather than twice, and interpolated into the SQL, so the bound cannot be changed in one
 * reader and not the other. `an-exchange-is-declared-not-inferred.test.ts` pins that both use it.
 */
const REPLY_BOUND_MINUTES = 60;
const REPLY_BOUND_MS = REPLY_BOUND_MINUTES * 60 * 1000;

/**
 * ── HOW LONG THE SWEEP WAITS FOR THE ANSWER'S UPDATE BEFORE PAIRING WITHOUT IT ──────────────────
 *
 * THE DEFECT THIS BOUND EXISTS FOR IS A SCHEDULE, NOT A CARRIER. The message id a turn answers is
 * NOT known when the placeholder is posted, and IS known by the time the answer update is written.
 * The sweep used to mint the exchange the moment the placeholder landed, so on a turn whose answer
 * had not arrived yet there was no declaration to read and the row was stamped `paired_by = 'swept'`
 * permanently. That label excludes the row from the headline TTFF, and the excluded rows were
 * disproportionately the SLOW ones: Kinesis batches on a five second window, so a turn slower than
 * five seconds cannot have its user message and its placeholder in one batch and is precisely the
 * turn the sweep reaches first. The SLO was being computed with its own worst cases censored.
 *
 * SO THE SWEEP WAITS FOR THE EVIDENCE INSTEAD OF RACING IT. It defers a bot message that has no
 * update yet until either the update exists or the placeholder is older than any live turn can be.
 *
 * THIS IS THE LAYER THE FIX BELONGS AT (tenet D6). A low-frequency reconciliation sweep behind an
 * event path is correct design; a sweep that runs AS the primary mechanism is not. Minting from the
 * placeholder alone made this pass the first and usually the only writer of a pairing, which is the
 * wrong role for it. Deferring hands the turn back to the event that carries the answer and leaves
 * the sweep as the backstop for what that event never delivers.
 *
 * ── AND THE BOUND IS DERIVED FROM WHAT THE CODE ALREADY KNOWS A TURN MAY COST ───────────────────
 *
 * Read live from the deployment's own profile topology rather than snapshotted, for the reason a
 * count is always taken live here: a deployment that raises a profile timeout would otherwise have
 * its slowest turns quietly re-censored by a constant nobody re-derived.
 */
const maxProfileTimeoutSeconds = (): number => Math.max(
  ...profiles.classificationValues().map((c) => profiles.requireProfileFor(c).timeoutSeconds),
);

/**
 * How many invocations one turn may consume before it is out of chances.
 *
 * Lambda's async invoke retries twice by default and the async processor sets no `retryAttempts`, so
 * each dispatch is up to THREE invocations; `turn-lock-release-on-failure.ts` then re-dispatches the
 * turn up to `TURN_MAX_ATTEMPTS` (default 2) times. Both numbers are recorded in that file's header.
 */
const MAX_TURN_INVOCATIONS = 3 * 2;

/**
 * What sits BETWEEN and AFTER those invocations: Lambda's async retry backoff (tens of seconds per
 * attempt) and, once the update is finally posted, the five second Kinesis batching window
 * (`archive-stack-aurora.ts`) plus consumer lag before this pass can see it. Two minutes covers
 * both with margin; erring long costs a late pairing, erring short costs a mislabeled one.
 */
const ARCHIVAL_SETTLE_SECONDS = 120;

/**
 * The staleness bound. Past it, a placeholder with no update is a turn that died: nothing on the
 * platform can still be working on it, so nothing further is coming and pairing it now is the best
 * reading that will ever exist.
 *
 * IT EXPIRES, AND THAT IS NOT NEGOTIABLE. A deferral with no expiry would drop an abandoned or
 * failed turn out of analytics entirely, which is a worse failure than labeling it: a mislabeled row
 * is visible and counted (`ttff_reconstructed_count`), a missing one is indistinguishable from a
 * turn that never happened.
 */
const updateDeferSeconds = (): number => maxProfileTimeoutSeconds() * MAX_TURN_INVOCATIONS + ARCHIVAL_SETTLE_SECONDS;

/**
 * Is this bot message RESPONSE-ANCHORED - born as a placeholder for a turn?
 *
 * The same substring the sweep tests with `LIKE '%<!--corr:%'`, deliberately, rather than the lib's
 * stricter bounded reader: two readers that disagree about what counts as marked would pair
 * different sets, and "which rule saw this row" is exactly what nothing recorded.
 */
function isResponseAnchored(content: string): boolean {
  return content.includes('<!--corr:');
}

/**
 * An answer the processor wrote into its placeholder after that placeholder had become the queue notice,
 * because posting it at the end failed. It declares itself so (`answeredInNotice`) on a final.
 */
function isAnswerWrittenIntoNotice(record: MessageRecord): boolean {
  return record.resp_phase === 'final' && (record.metadata as any)?.answeredInNotice === true;
}

/** The MessageId a message event is about: the field the transform sets, else the id's own prefix. */
function baseIdOfRecord(record: Pick<MessageRecord, 'message_id' | 'base_message_id'>): string {
  return record.base_message_id ?? baseMessageIdOf(record.message_id);
}

/**
 * THE LATEST OF A MESSAGE'S UPDATES IN ONE BATCH, by the event's own LastUpdatedTimestamp and then by
 * arrival order, which is the order `latestUpdateOrderSql` reads the stored rows in. Undefined when the
 * batch holds none.
 */
export function latestUpdateInBatch<R extends Pick<MessageRecord, 'last_updated_at'>>(updates: R[]): R | undefined {
  let latest: R | undefined;
  for (const u of updates) {
    if (!latest) { latest = u; continue; }
    const a = latest.last_updated_at ? Date.parse(latest.last_updated_at) : -Infinity;
    const b = u.last_updated_at ? Date.parse(u.last_updated_at) : -Infinity;
    if (b >= a) latest = u;
  }
  return latest;
}

/**
 * A placeholder whose turn has not said what it became: corr-marked, and not declared final on its own
 * CREATE (a DIRECT answer is posted once and finished, so it has no update to wait for).
 */
function isOpenPlaceholder(record: MessageRecord): boolean {
  return isResponseAnchored(record.content || '') && record.resp_phase !== 'final';
}

/**
 * THE PHASE A TURN WRITES WHILE IT NARRATES ITS OWN WORK ("Tidying the document before delivering it..."),
 * which says nothing about what the placeholder becomes. The same name `ResponsePhase` gives it.
 */
export const NARRATION_PHASE = 'progress';

/**
 * WHETHER A PLACEHOLDER'S UPDATE SO FAR SAYS WHAT IT BECAME. A narration update does not: the turn is
 * still working, and the update that follows may yet declare the placeholder a receipt and move the
 * answer to a message of its own. A resumed duel side does exactly that, and pairing on the narration
 * gave the receipt the exchange beside the answer's, so one turn was counted twice and the receipt's
 * row read as a turn with no path (2026-10-30). Any other update, including one that declares nothing,
 * is the turn's word on the placeholder.
 */
export function updateSaysWhatItBecame(update: Pick<MessageRecord, 'resp_phase'> | undefined): boolean {
  return !!update && update.resp_phase !== NARRATION_PHASE;
}

/**
 * AN EXCHANGE'S END TO END, as one SQL expression for the three statements that write it: the
 * in-batch pairer, the cross-batch sweep and the update fold. Each passes the column references it
 * holds; the rule is written here once.
 *
 * A FIRST ROUND, AND EVERY ORDINARY TURN, is measured from the person's message to the final answer.
 *
 * A LATER DUEL ROUND IS MEASURED FROM THE INSTANT IT WAS TRIGGERED. A round-2 rebuttal answers the
 * rival's round-1 reply, not the person, so the exchange's user instant (the message the duel began
 * from) would span both rounds. Its own end to end starts when round two was triggered, which the
 * battle orchestrator declares as the turn's `trigger_at` (migration 034). With no declared instant
 * the value is NULL rather than a span from the person's message.
 *
 * The turn ledger computes the authoritative figure the same way (migration 071), and this is the
 * second opinion the shadow diff compares it against. NO BACKTICKS in what this returns: it is
 * interpolated into template-literal SQL.
 */
export function exchangeE2eSql(cols: { round: string; finalAt: string; triggerAt: string; userAt: string }): string {
  const { round, finalAt, triggerAt, userAt } = cols;
  return `CASE WHEN COALESCE(${round}, 1) > 1
                THEN CASE WHEN ${triggerAt} IS NOT NULL AND ${finalAt} > ${triggerAt}
                          THEN (EXTRACT(EPOCH FROM (${finalAt} - ${triggerAt})) * 1000)::integer
                     END
                WHEN ${finalAt} IS NOT NULL AND ${finalAt} > ${userAt}
                THEN (EXTRACT(EPOCH FROM (${finalAt} - ${userAt})) * 1000)::integer
           END`;
}

/**
 * Create exchange records for user->bot message pairs within the batch
 */
async function createExchangesFromRecords(
  records: MessageRecord[],
  /**
   * The WHOLE batch, because the declaration this path reads lives on a row `records` does not hold.
   *
   * The caller passes CREATE events only - that is what the pairing walk is over - so the update
   * lookup below could never match and every processor-delivered answer read as undeclared, which is
   * the entire population the declaration was added for. The walk still runs on `records`; this is
   * consulted for the update partner and nothing else.
   */
  allRecords: MessageRecord[] = records,
): Promise<number> {
  let exchangeCount = 0;

  const byChannel = new Map<string, MessageRecord[]>();
  for (const record of records) {
    const existing = byChannel.get(record.channel_arn) || [];
    existing.push(record);
    byChannel.set(record.channel_arn, existing);
  }

  for (const [channelArn, channelRecords] of byChannel) {
    const sorted = channelRecords.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    for (let i = 0; i < sorted.length; i++) {
      const userRecord = sorted[i];
      // A person's message, or a HANDOVER, which starts the receiving assistant's exchange.
      const isHandoverAnchor = isHandoverRecord(userRecord);
      if (userRecord.is_bot && !isHandoverAnchor) continue;

      for (let j = i + 1; j < sorted.length; j++) {
        const botRecord = sorted[j];
        if (botRecord.channel_arn !== channelArn) continue;
        if (!botRecord.is_bot) continue;
        // A handover is a message one assistant says privately to another; it is never a reply to anything.
        if (isHandoverRecord(botRecord)) continue;

        // THE UPDATE ROW IS PART OF THE ANSWER, AND IT IS READ BEFORE THE TESTS, NOT AFTER.
        //
        // A turn declares what it answered on the update it already performs, because the
        // placeholder is created before the turn knows. This lookup used to sit BELOW the declared
        // checks, so those checks read only the CREATE - and the CREATE is precisely the row that
        // never carries the declaration. Every processor-delivered answer therefore looked
        // undeclared to this path, which is the whole population the declaration was added for.
        // The sweep has read the two together since the declaration shipped; only this path did not.
        //
        // AND WHEN THE ANSWER WAS WRITTEN INTO A QUEUE NOTICE, THAT UPDATE IS THE PARTNER. The first update of such a placeholder is the notice, which declares queue_ack;
        // when the answer could not be posted at the end it lands in that same message and says so
        // (answeredInNotice, a final). Read first, it makes the message the answer it now holds.
        //
        // OTHERWISE THE LATEST UPDATE IN THE BATCH (migration 084), the same choice the sweep makes:
        // every update is its own event, and what the message declared last is what it is now. A
        // placeholder that became the notice and then the receipt is a receipt.
        const updatesOfBot = allRecords.filter(
          (r) => r.event_type === 'UPDATE_CHANNEL_MESSAGE' && baseIdOfRecord(r) === botRecord.message_id
        );
        const updateRecord = updatesOfBot.find(isAnswerWrittenIntoNotice) ?? latestUpdateInBatch(updatesOfBot);
        const declaredKind = updateRecord?.turn_kind || botRecord.turn_kind;
        const declaredTarget =
          updateRecord?.answers_message_id || botRecord.answers_message_id;

        // ── A DECLARED KIND IS NOT AN ANSWER TO THIS MESSAGE ──
        //
        // A reading answers a BURST. This path takes the first bot record after a user record, so
        // without this the reading's proposal - which often IS the first thing back during a drain -
        // claims the pairing and the real answer that follows finds the turn already taken.
        //
        // THE TEST IS THE CLOSED SET, NOT A LIST OF KINDS. Every kind a turn may declare names a
        // turn that is not an ordinary answer (`lib/turn-declaration.ts` owns the set); an ordinary
        // answer declares no kind at all. So "not an answer" is "declared a kind", and a kind added
        // later is excluded the day its producer ships rather than the day somebody remembers to
        // extend a list here. This read `=== 'reading'` while `drift` was being added, which is
        // exactly the drift this shape prevents.
        //
        // It is skipped rather than broken on: the answer may be further down the same batch.
        if (declaredKind) continue;

        // ── AND A DECLARED TARGET IS OBEYED, NOT GUESSED AT ──────────────────────────────────────
        //
        // When the turn said which message it answers, that is the answer. Pairing it with anything
        // else is inventing a fact over one that was recorded. A declaration naming a DIFFERENT
        // message means this bot record is not the reply to THIS user record, and the sweep will pair
        // it with the one it named.
        if (declaredTarget && declaredTarget !== userRecord.message_id) continue;

        // A HANDOVER PAIRS ONLY BY DECLARATION, AND ONLY WITH ITS RECEIVER. Never inferred: the
        // receiving turn names the handover it answers, and nothing else may claim it.
        if (isHandoverAnchor && (declaredTarget !== userRecord.message_id || botRecord.sender_arn !== userRecord.targeted_to)) continue;

        // ── AND WHERE NOTHING WAS DECLARED, THIS PATH STOPS GUESSING ─────────
        //
        // "I don't like matching direct answers in exchanges just by adjacency. Especially with
        // queueing and everything going on."
        //
        // Until now this path applied NO tests at all: it took the first bot message after a user
        // message and inserted. The sweep applies three. So the same conversation paired by
        // different rules depending on whether both halves happened to land in one Kinesis batch,
        // and during a drain the first thing back is routinely a deferral notice or somebody else's
        // answer - which claimed the turn, leaving the real answer to find it already taken.
        //
        // The three tests below are the SWEEP'S OWN, deliberately: one guess made of three parts,
        // and weakening any of them alone widens the guess. Two paths that disagree about what an
        // exchange is are two definitions of the number, and nothing said which one a figure came
        // from.
        //
        // Applies only where nothing was declared, so a turn that named its target is unaffected -
        // including a DIRECT answer, which carries no update row and would fail the marker test if
        // its declaration were not honored first.
        if (!declaredTarget) {
          // A reply is born as a corr-marked placeholder, so a marker-less bot CREATE - a hint, a
          // raw send, a suggestion this system posts itself - is not an answer to anything.
          if (!isResponseAnchored(botRecord.content || '')) continue;
          // A reply belongs to a RECENT prompt. Unbounded, a briefing hours later pairs with a stale
          // message at that "latency" and drags every average built on the table.
          const gapMs = new Date(botRecord.created_at).getTime()
            - new Date(userRecord.created_at).getTime();
          if (gapMs > REPLY_BOUND_MS) continue;
          // And it belongs to THIS turn, bounded by the next USER message rather than by the first
          // bot message - which is what lets a duel's two sides both pair while a normal turn still
          // yields exactly one row.
          //
          // SEEN WITHIN THIS BATCH ONLY, and that is the honest limit of this path rather than a
          // shortcut: it holds no more than the records it was handed. A user message that landed in
          // a different batch is invisible here, so the test is weaker than the sweep's identical
          // one - which is also why the sweep stays, as the reconciliation behind an event path
          // rather than as the mechanism (tenet D6).
          const interveningUser = sorted.some(
            (r) => !r.is_bot
              && r.event_type === 'CREATE_CHANNEL_MESSAGE'
              && new Date(r.created_at).getTime() > new Date(userRecord.created_at).getTime()
              && new Date(r.created_at).getTime() < new Date(botRecord.created_at).getTime()
          );
          if (interveningUser) continue;
        }

        // ── A PLACEHOLDER WAITS FOR ITS UPDATE BEFORE IT CAN PAIR ──────────────
        //
        // The CREATE is posted before the turn knows what the placeholder becomes. When the answer moves
        // to a message of its own, the placeholder's update declares it a `receipt` or a `queue_ack`, and
        // the answer is the message that pairs. A flow placeholder names its target in its CREATE content
        // and an Amazon Lex placeholder names none, and either way pairing from the CREATE alone gave the
        // placeholder the exchange and left the answer as a turn with no exchange and no kind (16 on
        // 2026-10-21).
        //
        // So an open placeholder (corr-marked, not final on its CREATE) with no update in this batch is
        // left to the sweep, which defers it the same way until the update lands or the turn is past any
        // live turn's lifetime. Broken on rather than skipped: what this user message's answer is stays
        // undecided until that update, and the sweep makes the decision once, with the update in hand.
        // The update usually declares the target (the processor resolves it when the router could not),
        // and the sweep then records the pairing as `declared`.
        //
        // AND A NARRATION IS NOT THAT UPDATE (`updateSaysWhatItBecame`): it lands mid-turn, before the update
        // that may close the placeholder out as a receipt, so the placeholder still waits.
        if (!updateSaysWhatItBecame(updateRecord) && isOpenPlaceholder(botRecord)) break;

        const agentType = updateRecord?.assistant || botRecord.assistant;
        const intent = updateRecord?.intent || botRecord.intent;
        const intentConfidence =
          updateRecord?.intent_confidence || botRecord.intent_confidence;
        const wasRerouted =
          updateRecord?.was_rerouted || botRecord.was_rerouted;
        const deliveryOption =
          updateRecord?.delivery_option || botRecord.delivery_option;
        const taskId = updateRecord?.task_id || botRecord.task_id;
        const taskStatus = updateRecord?.task_status || botRecord.task_status;
        const taskState = updateRecord?.task_state || botRecord.task_state;
        const taskTransition = updateRecord?.task_transition || botRecord.task_transition;

        try {
          await query(
            `INSERT INTO exchanges (
               conversation_id, user_message_id, agent_message_id,
               channel_arn, conversation_classification, user_role, person_id, assistant,
               assistant_role, profile_version, profile_config_id, profile_name,
               battle_id, battle_round,
               response_latency_ms, user_message_at, agent_response_at,
               intent, intent_confidence, was_rerouted,
               delivery_option, task_id, task_status, task_state, task_transition,
               paired_by, e2e_ms, task_type, task_step, model_kind, model_from
             )
             SELECT
               c.id,
               um.id,
               am.id,
               $1,
               -- THE ANSWERING TURN declares the conversation's classification. A DIRECT quick
               -- response (a greeting posted by the router via Lex) archives without analytics, so it
               -- falls to the conversation's, which any declaring turn in the channel fills. NULL when
               -- nothing declared one - never a literal that looks like a value.
               COALESCE($2, c.conversation_classification),
               um.user_role,
               um.person_id,
               COALESCE($3, c.assistant),
               -- READ OFF THE ANSWERING MESSAGE rather than threaded through as parameters. The bot
               -- message already carries them, every pairing path joins it as am, and a parameter
               -- per path is how one path ends up filling a column the others leave null.
               am.assistant_role,
               am.profile_version,
               am.profile_config_id,
               am.profile_name,
               -- WHICH DUEL AND WHICH ROUND (migration 057), off the answering message for the same
               -- reason as the three above. A duel's two sides each pair into their own exchange, so
               -- carrying the id here is what makes "the turns of one battle" a single indexed read
               -- instead of a JSON extraction across the window.
               am.battle_id,
               am.battle_round,
               -- A REBUTTAL REPORTS NO REPLY TIME, the same rule the sweep applies: it answers its
               -- rival, so the gap to the person's message spans both rounds.
               CASE WHEN COALESCE(am.battle_round, 1) > 1 THEN NULL
                    ELSE EXTRACT(EPOCH FROM (am.created_at - um.created_at)) * 1000 END,
               um.created_at,
               am.created_at,
               $6, $7, $8, $9, $10, $11, $12, $13, $14,
               -- THE END TO END, WHERE THE ANSWER ALREADY SAID WHEN IT ARRIVED.
               --
               -- NULL on a placeholder, because its agent_final_at is not written until the answer
               -- update folds, and backfillFromUpdateEvents derives this then. Non-NULL only for a
               -- turn that declared itself final on its CREATE, which is the turn that will never
               -- have an update to derive it from. A later duel round is measured from its own
               -- trigger (exchangeE2eSql).
               ${exchangeE2eSql({ round: 'am.battle_round', finalAt: 'am.agent_final_at', triggerAt: 'am.trigger_at', userAt: 'um.created_at' })},
               -- WHAT CHOSE THE MODEL (ADR-064 decision 4), off the answering message like the dimensions above.
               am.task_type, am.task_step, am.model_kind, am.model_from
             FROM conversations c
             JOIN messages um ON um.message_id = $4 AND um.channel_arn = $1
             JOIN messages am ON am.message_id = $5 AND am.channel_arn = $1
             WHERE c.channel_arn = $1
             ON CONFLICT DO NOTHING`,
            [
              channelArn,
              // From the BOT side of the pair: the person's own message declares nothing. Raw (may
              // be null) so the SQL COALESCE above can fall back to the conversation's.
              updateRecord?.conversation_classification || botRecord.conversation_classification || null,
              agentType,
              userRecord.message_id,
              botRecord.message_id,
              intent,
              intentConfidence,
              wasRerouted,
              deliveryOption,
              taskId,
              taskStatus,
              taskState,
              // JSONB param: stringify the {from,to} object; NULL for a no-transition turn.
              taskTransition ? JSON.stringify(taskTransition) : null,
              // HOW THIS PAIR WAS MADE, stated rather than left to be read off an absence. A
              // declared pairing is the turn's own statement; an in-batch inference is bounded to
              // seconds by the Kinesis batch it was made in. Both belong in a TTFF average; the
              // sweep's inference does not, and until now the only thing separating them was that
              // the sweep happened to omit delivery_option.
              declaredTarget ? 'declared' : 'in_batch',
            ]
          );
          exchangeCount++;
        } catch (error) {
          console.error('Error creating exchange:', error);
        }

        break;
      }
    }
  }

  return exchangeCount;
}

/**
 * Create exchanges by querying the database for unpaired user messages.
 * Handles cases where user and bot messages arrive in different Kinesis batches.
 */
async function createExchangesFromDatabase(
  channelArns: string[]
): Promise<number> {
  if (channelArns.length === 0) return 0;
  return pairUnmatchedMessages(channelArns, '24 hours');
}

/**
 * The same pass, over a window an operator chooses and every channel.
 *
 * ── WHY A BACKFILL IS SAFE HERE, WHICH IS NOT TRUE OF EVERY ONE ─────────────────────────────────
 *
 * The mention-marker clause shipped 2026-09-23 and only ever reaches turns that arrive after it: the
 * sweep above is scoped to the channels in the current Kinesis batch AND to the last 24 hours, so a
 * quiet channel is never revisited. 77 corr-marked answers were measured unpaired over three days
 * before the fix, and nothing since has gone back for them. They are real answers carrying an intent,
 * and while they stay unpaired they are absent from every figure built on `exchanges` - `ttff_ms` and
 * `e2e_ms` in `v_turn_latency` go NULL for the turn rather than the turn being visibly missing.
 *
 * THE LINKING DATA WAS NEVER LOST, which is what separates this from the backfills this codebase has
 * declined. The correlation id IS the user's message id (`correlation.ts` mints `mention-<MessageId>`)
 * and it lives in the placeholder's own `content`. The answer lands on a separate update row, so the
 * marker survives the edit the person sees, and nothing in this tree rewrites `messages.content`.
 *
 * AND WIDENING THE WINDOW CANNOT WIDEN THE GUESS. Every clause in the pairing predicate is bounded
 * relative to the PAIR rather than relative to now: declared and mention are exact id matches, and
 * the inferred branch keeps its REPLY_BOUND_MINUTES bound and its no-intervening-user-message test.
 * So the 24-hour bound above is a work limit, not a correctness guard, and removing it admits older
 * rows to the same tests rather than looser ones. A pass over 90 days cannot mint a pairing that a
 * pass over 24 hours would have refused.
 *
 * Idempotent by the same two mechanisms the hot path relies on: the `e.id IS NULL` anti-join skips a
 * turn this sender already answered, and `ON CONFLICT DO NOTHING` catches the rest. Re-running
 * converges.
 *
 * MINT EXCHANGES ONLY - do not chase this with `backfillTurnEvents`. An exchange is enough for
 * `v_turn_latency` to anchor the turn (`anchor_source = 'exchange'`), while minting `turn_events`
 * rows would stamp `turn_id_source = 'paired'` and flip the anchor to `'ledger'`, presenting a
 * derived binding as a measured one - the defect `a-backfilled-anchor-is-not-a-measured-one` exists
 * to catch.
 */
export async function backfillExchangePairings(
  opts: { days?: number } = {}
): Promise<{ exchangesCreated: number; windowDays: number }> {
  // Same shape as backfillTurnEvents: 90 days by default, never more than a year, so a mistyped
  // argument cannot turn into an unbounded scan of the whole table.
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 90) || 90, 1), 365);
  const exchangesCreated = await pairUnmatchedMessages(null, `${days} days`);
  return { exchangesCreated, windowDays: days };
}

/** The triggers that answer no message, as a SQL list for the sweep below. Built here, outside the statement, so the statement stays one backtick-free literal. */
const ANSWERS_NO_MESSAGE_SQL = ANSWERS_NO_MESSAGE_KINDS.map((k) => "'" + k + "'").join(", ");

/**
 * ONE statement, two callers. The hot path passes the batch's channels and 24 hours; the backfill
 * passes every channel and a wider window. Copying the SQL for the backfill would have put a second
 * definition of "what counts as an answer to this message" in the tree, which is the drift the
 * correlation-marker regex already needs its own test to prevent.
 */
async function pairUnmatchedMessages(
  channelArns: string[] | null,
  window: string
): Promise<number> {
  const result = await query<{ count: string }>(
    `WITH new_exchanges AS (
       INSERT INTO exchanges (
         conversation_id, user_message_id, agent_message_id,
         channel_arn, conversation_classification, user_role, person_id, assistant,
         -- THE DIMENSIONS THIS PATH USED TO DROP. The in-batch pairer has carried role, version and
         -- config id since migration 056; this one never did, so every exchange it minted had them
         -- NULL and the filters that read them silently excluded it.
         --
         -- THAT LANDED HARDEST ON EXACTLY THE POPULATION MOST WORTH FILTERING. A duel runs two model
         -- calls per round, so its time to first feedback routinely exceeds the five second Kinesis
         -- batching window - which means a duel's exchanges are usually minted HERE, by the sweep,
         -- and not by the in-batch pairer. "Filter battle turns by role and version" would therefore
         -- have returned nothing, on a column that was populated everywhere else.
         assistant_role, profile_version, profile_config_id, profile_name,
         battle_id, battle_round,
         response_latency_ms, user_message_at, agent_response_at,
         intent, delivery_option, task_id, task_status, task_state, task_transition,
         paired_by, e2e_ms, task_type, task_step, model_kind, model_from
       )
       -- ONE ROW PER (turn, responding bot). The next-user bound below keeps replies attached to the
       -- prompt that caused them, but alone it paired EVERY bot CREATE before the next user turn -
       -- welcomes, drift notices and continuation chunks each minted an exchange whose
       -- response_latency_ms was the gap to a user message they never answered, inflating raw
       -- exchange counts and polluting TTFF averages. DISTINCT ON takes the EARLIEST bot CREATE per
       -- sender: a normal turn yields exactly one row again (the in-batch pairer's own rule), and a
       -- duel still yields two because its sides answer as different bot identities.
       -- ── AND THE ROUND, SO A DUEL IS SCORED OVER THE TURNS IT ACTUALLY FOUGHT
       --
       -- The key was (turn, sender), which is right for a normal duel - two sides, two exchanges -
       -- and caps a MULTI-ROUND one at two. A side's round-2 rebuttal answers the same user message
       -- as its round-1 reply and comes from the same bot, so it collided with the round-1 row and
       -- was dropped. Measured over 30 days: of 14 two-round duels only 3 recorded all four turns,
       -- and one reported two rounds with a single turn and a single contender - a comparison
       -- computed over half of itself.
       --
       -- THE ROUND IS PART OF WHAT MAKES A TURN DISTINCT, so it belongs in the key rather than in a
       -- filter downstream. COALESCE to 0 so every non-battle turn shares one value and behaves
       -- exactly as before: this widens the key only where a round exists.
       --
       -- DESIGN-BATTLE section 8 settles why the turns belong here at all, about abandoned duels but
       -- for the same reason: they "really happened, really reached the user, and really cost money;
       -- dropping them would misstate spend". A rebuttal is a real model call against a real bill.
       --
       -- WHAT A ROUND-2 ROW MUST NOT DO is contribute a reply time. It answers onto its rival's
       -- reply, not onto the person, so a span from the person's message covers both rounds - see
       -- the latency columns below: no reply time, and an end to end measured from the instant round
       -- two was triggered. Migration 064 keeps it out of the turn ledger's person anchor.
       SELECT DISTINCT ON (um.id, am.sender_arn, COALESCE(am_upd.battle_round, am.battle_round, 0))
         c.id,
         um.id,
         am.id,
         um.channel_arn,
         -- THE CONVERSATION'S CLASSIFICATION, from the answering turn's declaration (its update row carries
         -- the analytics), else from the conversation. The person's own message declares nothing, so it is
         -- never read here. The sender's clearance is messages.user_clearance and the kind of sender is
         -- user_role: neither is copied onto this column, which describes the ROOM. user_type is
         -- deprecated (migration 050) and no longer written.
         COALESCE(am_upd.conversation_classification, am.conversation_classification, c.conversation_classification),
         -- THE ROLE, straight off the opening message. Archival resolved it from the sender ARN when
         -- that row was written, so it is present even though the person's message declared nothing -
         -- which is the whole reason the role axis can be populated where the clearance axis cannot.
         um.user_role,
         um.person_id,
         COALESCE(am_upd.assistant, am.assistant, c.assistant),
         -- The UPDATE first, then the CREATE, the same order every other declared field above uses:
         -- a placeholder's CREATE predates the answer, and the analytics arrive on the update.
         -- No conversation-level fallback, because there is none to have - these describe the
         -- assistant version that produced THIS answer, not a property of the room.
         COALESCE(am_upd.assistant_role, am.assistant_role),
         COALESCE(am_upd.profile_version, am.profile_version),
         COALESCE(am_upd.profile_config_id, am.profile_config_id),
         COALESCE(am_upd.profile_name, am.profile_name),
         COALESCE(am_upd.battle_id, am.battle_id),
         COALESCE(am_upd.battle_round, am.battle_round),
         -- ── A REBUTTAL REPORTS NO REPLY TIME ────────────────────────────────────────────────
         -- It answers onto its rival, not onto the person, so this span would cover both rounds and
         -- every average built on it would drift upward with the number of rounds fought. The row
         -- still exists for cost, model attribution, relevance and the round count; only the reply
         -- clock is withheld, which is the same shape as a slice the rate table cannot price.
         CASE WHEN COALESCE(am_upd.battle_round, am.battle_round, 1) > 1 THEN NULL
              ELSE EXTRACT(EPOCH FROM (am.created_at - um.created_at)) * 1000 END,
         um.created_at,
         am.created_at,
         COALESCE(am_upd.metadata->>'intent', am.metadata->>'intent'),
         -- HOW IT WAS DELIVERED, which this path never recorded at all. The in-batch pairer has
         -- passed delivery_option since the column existed; this one left it NULL on every row it
         -- minted, and NULL is the unknown bucket. So the bucket that looked like "direct answers
         -- we cannot see" was also every answer of every kind that happened to pair late.
         --
         -- The COLUMN first, then the JSON (migration 042), for the same reason as the pairing
         -- itself: the column is the archival fold of whichever carrier the turn had.
         COALESCE(
           am_upd.delivery_option, am.delivery_option,
           am_upd.metadata->>'deliveryOption', am.metadata->>'deliveryOption'
         ),
         COALESCE(am_upd.task_id, am.task_id),
         COALESCE(am_upd.task_status, am.task_status),
         COALESCE(am_upd.task_state, am.task_state),
         COALESCE(am_upd.task_transition, am.task_transition),
         -- HOW THIS PAIR WAS MADE, and it is no longer the same answer for every row this pass
         -- mints. A declared pairing is the turn's own statement and is exact; an inferred one
         -- searched up to the reply bound for a plausible answer, and its response_latency_ms is the
         -- gap to whatever that search chose. TTFF partitions on this instead of on the absence of a
         -- delivery option, which is what separated them until this column existed.
         CASE WHEN COALESCE(
                     am_upd.answers_message_id, am.answers_message_id,
                     am_upd.metadata->>'answersMessageId', am.metadata->>'answersMessageId'
                   ) = um.message_id
              THEN 'declared'
              -- The correlation marker NAMED this message, which is a declaration too - see the
              -- mention clause below. Recorded apart from 'declared' so the two carriers stay
              -- countable: one is the turn stating its target, the other is the channel flow having
              -- minted the turn identity FROM the target.
              WHEN substring(am.content from '<!--corr:mention-([A-Za-z0-9._-]{1,56})-->') = um.message_id
              THEN 'mention'
              ELSE 'swept' END,
         -- The same as the in-batch path: present only where the answer's finish is already folded,
         -- and left for the update fold to derive otherwise. A later duel round is measured from its
         -- own declared trigger, never from the person's message (exchangeE2eSql).
         ${exchangeE2eSql({
           round: 'COALESCE(am_upd.battle_round, am.battle_round)',
           finalAt: 'am.agent_final_at',
           triggerAt: 'COALESCE(am.trigger_at, am_upd.trigger_at)',
           userAt: 'um.created_at',
         })},
         COALESCE(am_upd.task_type, am.task_type),
         COALESCE(am_upd.task_step, am.task_step),
         COALESCE(am_upd.model_kind, am.model_kind),
         COALESCE(am_upd.model_from, am.model_from)
       FROM messages um
       JOIN messages am ON am.channel_arn = um.channel_arn
         AND am.is_bot = true
         AND am.event_type = 'CREATE_CHANNEL_MESSAGE'
         -- A handover is said privately, one assistant to another, and is never a reply (isHandoverRecord).
         AND NOT (COALESCE(am.metadata, '{}'::jsonb) ? 'aeHandover')
         AND am.created_at > um.created_at
       -- THE ANSWER'S LATEST UPDATE (migration 084), the same choice the in-batch pairer makes: what
       -- the message declared last is what it is now, so a notice later closed out as a receipt reads
       -- as the receipt, and an answer written into the notice reads as the answer.
       ${updateJoinSql({ alias: 'am_upd', create: 'am', pick: 'latest' })}
       JOIN conversations c ON c.channel_arn = um.channel_arn
       -- Dedup on the PAIR, not on the user message. A /battle turn is answered by BOTH variants,
       -- so one user message legitimately has two agent replies; keying on user_message_id alone let
       -- the first reply claim the turn and silently dropped the second, leaving every duel with one
       -- side in exchanges and no comparison possible.
       -- Durable per-(turn, sender), NOT per exact pair. The pair-level anti-join runs BEFORE
       -- DISTINCT ON, so once (U, A1) was inserted in an earlier batch, A1 was eliminated as a
       -- candidate and a LATER unprompted message from the same sender became the "earliest
       -- surviving" row - minting a second exchange for an already-answered turn, at whatever
       -- latency the gap happened to be. The join now asks "has this SENDER already answered this
       -- turn", which survives across batches.
       LEFT JOIN exchanges e
         ON e.user_message_id = um.id
        AND EXISTS (
          SELECT 1 FROM messages am_prev
           WHERE am_prev.id = e.agent_message_id AND am_prev.sender_arn = am.sender_arn
             -- ROUND-AWARE FOR THE SAME REASON THE KEY IS. Without this the cross-batch guard still
             -- asks "has this sender already answered this turn", which a round-1 reply satisfies -
             -- so the rebuttal was excluded as a candidate before DISTINCT ON ever saw it.
             AND COALESCE(am_prev.battle_round, 0) = COALESCE(am.battle_round, 0)
        )
       -- A person's message, or a HANDOVER paired only with the reply its receiver declared for it
       -- (isHandoverRecord): the handover is where the receiving assistant's end to end starts.
       WHERE (um.is_bot = false
              OR (COALESCE(um.metadata, '{}'::jsonb) ? 'aeHandover'
                  AND am.sender_arn = um.targeted_to
                  AND COALESCE(am_upd.answers_message_id, am.answers_message_id,
                               am_upd.metadata->>'answersMessageId', am.metadata->>'answersMessageId') = um.message_id))
         AND um.event_type = 'CREATE_CHANNEL_MESSAGE'
         -- Both scoping predicates are PARAMETERS rather than constants, so the backfill runs this
         -- exact statement over a wider window instead of a second copy of it. NULL channels means
         -- every channel; the window is always bounded so neither caller can scan the whole table.
         AND um.created_at > NOW() - $2::interval
         AND ($1::text[] IS NULL OR um.channel_arn = ANY($1))
         AND e.id IS NULL
         -- ── A DECLARED KIND NEVER PAIRS ────────────────────
         --
         -- A reading answers a BURST, so it has no single target. A drift suggestion names one and
         -- deliberately does not do the work, so counting it would drop a fast non-answer into the
         -- population that measures answers. Both are excluded because they SAY what they are, not
         -- because they happen to lack a marker - the same coincidence excludes a broadcast answer,
         -- which is a real reply, so the absence could never be read as intent.
         --
         -- THE TEST IS THE CLOSED SET. Every kind a turn may declare is a non-answer by
         -- construction; an ordinary answer declares no kind. So this asks "did it declare one",
         -- and a kind added later is excluded the day its producer ships.
         --
         -- The COLUMN first, then the JSON (migration 042): the column is the fold of whichever
         -- carrier the turn had, and the JSON is what every row written before it has.
         AND (COALESCE(
               am_upd.turn_kind, am.turn_kind,
               am_upd.metadata->>'turnKind', am.metadata->>'turnKind'
             ) IS NULL
              -- A QUEUE NOTICE THAT REACHED A FINAL ANSWER IS THE ANSWER. A notice
              -- never declares itself final, so a final folded onto a message whose first update was
              -- the notice is the answer written into it when it could not be posted at the end.
              OR (COALESCE(am_upd.turn_kind, am.turn_kind,
                           am_upd.metadata->>'turnKind', am.metadata->>'turnKind') = 'queue_ack'
                  AND am.agent_final_at IS NOT NULL))
         -- AND A TRIGGER THAT ANSWERS NO MESSAGE NEVER PAIRS (answersNoMessage). Archival records it as
         -- the kind above; this reads the trigger as well, from the same two places transformToMessageRecord
         -- reads it, for a row archived before the kind was.
         AND COALESCE(
               am_upd.metadata->>'trigger', am_upd.metadata->'analytics'->>'trigger',
               am.metadata->>'trigger', am.metadata->'analytics'->>'trigger', ''
             ) NOT IN (${ANSWERS_NO_MESSAGE_SQL})
         -- ── AND THE SWEEP WAITS FOR THE ANSWER RATHER THAN RACING IT ──────────────────────────
         --
         -- See updateDeferSeconds above for why this is a scheduling fix and why it belongs in
         -- this pass. In one line: the message a turn answers is unknown when the placeholder is
         -- posted and known by the time the answer update is written, so minting from the
         -- placeholder alone stamped a permanent reconstruction label over evidence that was about
         -- to arrive - and it did that most often to the slowest turns.
         --
         -- NO NEW JOIN. am_upd is already LEFT JOINed above for the intent, the delivery option and
         -- the declaration, and am.agent_final_at is already read below for e2e_ms. This is four
         -- tests over columns this statement already has in hand.
         --
         -- NO BACKTICKS ANYWHERE IN THIS SQL: it is a template literal, and one backtick in a
         -- comment ends the string mid-query.
         AND (
           -- THE DECLARATION IS ALREADY READABLE, from whichever row carries it. There is nothing
           -- left to wait for - the CASE above will write 'declared', which is the turn's own
           -- statement.
           --
           -- EXCEPT ON AN OPEN PLACEHOLDER. A flow turn's placeholder names its
           -- target in its CREATE content, before the turn knows what the placeholder becomes. When
           -- the answer moves to a message of its own, the placeholder's update declares it a receipt
           -- or a queue notice and the answer is what pairs; paired from the CREATE alone, the
           -- placeholder took the exchange first. So a corr-marked message waits for its update (the
           -- arms below), and only a declared message that is not a placeholder is decided here.
           (COALESCE(
             am_upd.answers_message_id, am.answers_message_id,
             am_upd.metadata->>'answersMessageId', am.metadata->>'answersMessageId'
           ) IS NOT NULL
            AND am.content NOT LIKE '%<!--corr:%')
           -- OR THE ANSWER UPDATE HAS LANDED. Whatever it declared, including nothing, is the last
           -- evidence this pairing will ever get, so deciding now decides on a complete record. A
           -- narration (respPhase progress) is not that update: the turn is still working and may yet
           -- close the placeholder out as a receipt (updateSaysWhatItBecame).
           OR (am_upd.id IS NOT NULL AND COALESCE(am_upd.metadata->>'respPhase', '') <> '${NARRATION_PHASE}')
           -- OR THE TURN ALREADY FINISHED ON ITS CREATE. A DIRECT answer is posted once and has no
           -- update to come; waiting for one would wait for an event that cannot arrive.
           OR am.agent_final_at IS NOT NULL
           -- OR THE PLACEHOLDER IS OLDER THAN ANY LIVE TURN CAN BE, so no update is coming and this
           -- turn pairs on the evidence it has. The deferral must expire: an abandoned or failed
           -- turn that never paired would leave analytics silently, which is worse than a label.
           OR am.created_at <= NOW() - INTERVAL '${updateDeferSeconds()} seconds'
         )
         AND (
           -- ── DECLARED: the answer named this message, so nothing else has to hold ─────────────
           --
           -- An exchange is "an assistant answered this message", and the turn knows which message
           -- that is. Where it said so, that IS the pairing: no marker, no time bound, no
           -- intervening-message test, because each of those exists only to GUESS at what this
           -- states. Read from the UPDATE row first, exactly as intent above is, because the
           -- placeholder is created before the turn knows what it answered.
           --
           -- THE COLUMN FIRST, THEN THE JSON (migration 042). The column is the archival fold of
           -- whichever carrier the turn had: Metadata for a processor-delivered answer, the
           -- <!--turn:--> content declaration for one the handler answered itself. Before it
           -- existed this clause could only ever see the first of those, so the fastest answer in
           -- the system - the one that never reaches the processor - could never be paired by
           -- declaration however plainly it named its target.
           COALESCE(
             am_upd.answers_message_id, am.answers_message_id,
             am_upd.metadata->>'answersMessageId', am.metadata->>'answersMessageId'
           ) = um.message_id
           -- ── THE MENTION MARKER NAMES THE MESSAGE, SO IT IS A DECLARATION ──
           --
           -- On the channel-flow path the correlation id IS the user message id: correlation.ts mints
           -- it as mention-<MessageId>. So a flow turn has always been telling us exactly what it
           -- answered, in the marker it was already writing, and the sweep was throwing that away and
           -- guessing instead.
           --
           -- WHAT THE GUESS COST. The inferred branch below refuses to pair when another user message
           -- landed between the prompt and the answer. That is a sound guess and it is wrong for the
           -- ordinary case of somebody typing again while the assistant is working: the answer to the
           -- first message then pairs with nothing, and the turn disappears from every figure built on
           -- exchanges. Measured on live traffic: 77 corr-marked answers unpaired over three days, all
           -- of them real answers carrying an intent.
           --
           -- NOT BOUNDED BY TIME OR BY INTERVENING MESSAGES, deliberately, and for the same reason the
           -- declared clause is not: those tests exist only to guess at what this states outright. The
           -- id is the flow's own, minted from the message it is answering.
           --
           -- The queued case is NOT this one and keeps its own pass: a burst folded onto a running
           -- turn pairs many-to-one through answered_queued, which this leaves untouched.
           OR substring(am.content from '<!--corr:mention-([A-Za-z0-9._-]{1,56})-->') = um.message_id
           OR (
             -- ── INFERRED: the pre-declaration fallback, unchanged ────────────────────────────
             --
             -- Applies only where nothing was declared, so no existing row changes behaviour and no
             -- backfill is needed. Its three tests are kept together deliberately: they are one
             -- guess made of three parts, and weakening any of them alone widens the guess.
             COALESCE(
               am_upd.answers_message_id, am.answers_message_id,
               am_upd.metadata->>'answersMessageId', am.metadata->>'answersMessageId'
             ) IS NULL
             -- Only RESPONSE-ANCHORED bot messages pair: a reply is always born as a corr-marked
             -- placeholder (placeholder->update delivery), so a marker-less bot CREATE - a drift
             -- notice, a hint, a raw send - is not an answer to anything and must not mint an exchange.
             AND am.content LIKE '%<!--corr:%'
             -- And a reply belongs to a RECENT prompt. Placeholders land within seconds of dispatch;
             -- an unbounded gap let a briefing hours later pair with a stale user message at ~8-hour
             -- "latency", dragging every average built on this table.
             AND am.created_at <= um.created_at + INTERVAL '${REPLY_BOUND_MINUTES} minutes'
             -- Bound the reply to THIS turn by the next USER message, not by the first bot message. The
             -- old "no intervening bot message" test is what limited a turn to a single reply; bounding on
             -- the next user turn keeps replies attached to the prompt that caused them while allowing the
             -- two a battle produces. A normal turn still yields exactly one row.
             AND NOT EXISTS (
               SELECT 1 FROM messages nxt
               WHERE nxt.channel_arn = um.channel_arn
                 AND nxt.is_bot = false
                 AND nxt.event_type = 'CREATE_CHANNEL_MESSAGE'
                 AND nxt.created_at > um.created_at
                 AND nxt.created_at < am.created_at
             )
           )
         )
       -- Matches the DISTINCT ON prefix, which Postgres requires, then takes the EARLIEST message
       -- per (turn, sender, round) exactly as it always took the earliest per (turn, sender).
       ORDER BY um.id, am.sender_arn, COALESCE(am_upd.battle_round, am.battle_round, 0), am.created_at
       ON CONFLICT DO NOTHING
       RETURNING id
     )
     SELECT COUNT(*)::text as count FROM new_exchanges`,
    [channelArns, window]
  );

  return parseInt(result.rows[0]?.count || '0', 10);
}

/**
 * ONE EXCHANGE PER QUEUED MESSAGE THE ANSWER ADDRESSED, LABELED AS HAVING WAITED.
 *
 * ── THE DECISION ────────────────────────────────────────────────────────────
 *
 * "Queued responses are still responses. They should be tracked as responses for all messages being
 * answered in the queue but clearly labeled as messages that were in queue so they can be looked at
 * separate from exchanges that are 1 to 1."
 *
 * ── WHY THIS IS NOT THE MAPPING ADR-033 SAID DOES NOT EXIST ────────────────────────────────────
 *
 * ADR-033 refused an affordance that marked each queued message with the answer that addressed it,
 * on the grounds that "the mapping does not exist". That is true of an INFERRED mapping - adjacency,
 * transcript order, the nearest reply - and this path infers nothing. The reading produces exactly
 * one entry per queued message and labels each `amends`, `new` or `unclear`; the fold takes the
 * `amends` entries and rolls them into the running answer, and the turn writes down which ids it
 * rolled in. Three queued messages folded into one reply therefore produce three rows pointing at
 * that reply, because the reading said so.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────────────────────────
 *
 * A queued message the reading marked `new` or `unclear` gets no row from this pass, and that is the
 * handoff ADR-033 already rules on: it becomes a `queued_request` or a `queued_clarification` task
 * and is measured as TASK RESOLUTION, where human think time is kept out of `agent_ms`. Minting an
 * exchange for it as well would be two surfaces answering one question (tenet D7), and the latency
 * one would report the person's deciding time as the platform's.
 *
 * The queued message's FIRST FEEDBACK is likewise not here: `v_queue_acknowledgement` reports
 * `ack_ms` per queued message, keyed on the acknowledged message, and this pass does not duplicate
 * it. What this adds is the other end - the answer - which nothing recorded.
 *
 * ── AND WHY IT IS ITS OWN PASS ─────────────────────────────────────────────────────────────────
 *
 * The two existing pairers each pick ONE bot message per user message. This is the opposite shape:
 * one bot message, several user messages, all of them declared. Bending either pairer around that
 * would put a second definition of "an exchange" inside a function that already holds one.
 */
async function createQueuedExchanges(channelArns: string[]): Promise<number> {
  if (channelArns.length === 0) return 0;

  const result = await query<{ count: string }>(
    `WITH declared AS (
       -- THE ANSWER AND WHAT IT SAID IT ADDRESSED. The declaration rides the UPDATE that carries the
       -- answer, and the update fold copies it onto the canonical CREATE row - so this reads the
       -- CREATE first and the UPDATE as the fallback for a batch the fold has not reached.
       -- NO BACKTICKS ANYWHERE IN THIS SQL: it is a template literal, and one backtick in a comment
       -- ends the string mid-query. The same trap the latency query's own header records.
       SELECT am.id             AS agent_id,
              am.channel_arn    AS channel_arn,
              am.created_at     AS agent_created_at,
              am.agent_final_at AS agent_final_at,
              COALESCE(am_upd.conversation_classification, am.conversation_classification) AS conversation_classification,
              COALESCE(am_upd.assistant, am.assistant)             AS assistant,
              -- INTENT IS NOT A COLUMN ON messages; it rides in metadata, and exchanges is the table
              -- that has a column by that name, which is where this expression came from. Reading it
              -- as a column failed 42703 on every invoke and took the whole transaction down with it.
              COALESCE(am_upd.metadata->>'intent', am.metadata->>'intent') AS intent,
              COALESCE(am_upd.delivery_option, am.delivery_option)   AS delivery_option,
              COALESCE(am_upd.task_id, am.task_id)                   AS task_id,
              -- WHAT CHOSE THE COMPLETING TURN'S MODEL AND THE WORK IT IS ATTRIBUTED TO (ADR-064 decision 4), which a
              -- folded message shares: its answer is that turn's answer.
              COALESCE(am_upd.task_type, am.task_type)               AS task_type,
              COALESCE(am_upd.task_step, am.task_step)               AS task_step,
              COALESCE(am_upd.model_kind, am.model_kind)             AS model_kind,
              COALESCE(am_upd.model_from, am.model_from)             AS model_from,
              -- WHAT EACH FOLDED MESSAGE ASKED FOR, declared by the turn that folded it (answeredQueuedIntents, the
              -- intent the router classified it as when it queued). A map by message id, read per row below.
              COALESCE(am_upd.metadata->'answeredQueuedIntents', am.metadata->'answeredQueuedIntents') AS queued_intents,
              UNNEST(COALESCE(am.answered_queued, am_upd.answered_queued)) AS queued_message_id
         FROM messages am
         -- THE LATEST UPDATE THAT DECLARED WHAT IT ADDRESSED (migration 084). The declaration rides
         -- the update that carries the answer; a later update of the same message (a moderation edit)
         -- need not repeat it, so the latest update overall could hide it.
         ${updateJoinSql({ alias: 'am_upd', create: 'am', pick: 'latest', and: 'answered_queued IS NOT NULL' })}
        WHERE am.channel_arn = ANY($1)
          AND am.is_bot = true
          AND am.event_type = 'CREATE_CHANNEL_MESSAGE'
          AND am.created_at > NOW() - INTERVAL '24 hours'
          AND COALESCE(am.answered_queued, am_upd.answered_queued) IS NOT NULL
     ),
     new_exchanges AS (
       INSERT INTO exchanges (
         conversation_id, user_message_id, agent_message_id,
         channel_arn, conversation_classification, user_role, person_id, assistant,
         response_latency_ms, user_message_at, agent_response_at,
         intent, delivery_option, task_id,
         paired_by, queued_as, e2e_ms,
         task_type, task_step, model_kind, model_from
       )
       SELECT
         c.id,
         um.id,
         d.agent_id,
         d.channel_arn,
         COALESCE(d.conversation_classification, c.conversation_classification),
         um.user_role,
         um.person_id,
         COALESCE(d.assistant, c.assistant),
         -- THE PERSON'S WHOLE WAIT, AND IT IS NOT A TIME-TO-FIRST-FEEDBACK. They sent this while the
         -- assistant was busy, so the gap to the answer includes the queue. A declared paired_by
         -- keeps it out of nothing on its own; queued_as is what says the wait was deliberate, and
         -- it is why this population has to be readable apart from the 1:1 one.
         -- FROM THE ANSWER, NOT THE PLACEHOLDER, AND THE GUARD IS NOT OPTIONAL (review, 2026-09-17).
         -- This read d.agent_created_at, the placeholder instant. A message is queued precisely
         -- BECAUSE a turn was already running, and the fold re-dispatches onto that same turn's
         -- placeholder - so the placeholder always predates the queued message and every folded row
         -- was written with a NEGATIVE latency and agent_response_at < user_message_at. The
         -- paragraph above already says what this should measure: the gap to the ANSWER, queue
         -- included. For a folded message there was never separate first feedback, so this coincides
         -- with e2e_ms by construction rather than by accident, and carries the same guard the
         -- column below already had.
         CASE WHEN d.agent_final_at IS NOT NULL AND d.agent_final_at > um.created_at
              THEN EXTRACT(EPOCH FROM (d.agent_final_at - um.created_at)) * 1000
         END,
         um.created_at,
         d.agent_created_at,
         -- THE FOLDED MESSAGE'S OWN INTENT (ADR-064 decision B), as it was classified when it queued, never the
         -- answer's: a correction folded into a report is attributed to what it asked for, not to whatever the
         -- answering turn's own message was classified as. Where no declaration reached the answer (an enqueue
         -- whose intent write failed), the work it was folded into stands for it, and only then the answer's intent.
         COALESCE(NULLIF(d.queued_intents->>d.queued_message_id, ''), d.task_type, d.intent),
         d.delivery_option,
         d.task_id,
         -- DECLARED, because that is exactly what it is: the turn named this message.
         'declared',
         -- HOW IT LEFT THE QUEUE. folded is the only value written today; a queued message the
         -- reading marked new or unclear is measured as task resolution and gets no row here.
         'folded',
         CASE WHEN d.agent_final_at IS NOT NULL AND d.agent_final_at > um.created_at
              THEN (EXTRACT(EPOCH FROM (d.agent_final_at - um.created_at)) * 1000)::integer
         END,
         -- THE COMPLETING TURN'S ATTRIBUTION, so Effectiveness counts the folded message under the work that answered
         -- it (COALESCE(task_type, intent)) and reads which model served it and why.
         d.task_type,
         d.task_step,
         d.model_kind,
         d.model_from
       FROM declared d
       JOIN messages um ON um.channel_arn = d.channel_arn
         AND um.message_id = d.queued_message_id
         AND um.is_bot = false
         AND um.event_type = 'CREATE_CHANNEL_MESSAGE'
       JOIN conversations c ON c.channel_arn = d.channel_arn
       -- The pair is unique (migration 017), so a re-delivered batch re-inserts nothing. Stated as a
       -- conflict clause rather than an anti-join because that index IS the durable answer.
       ON CONFLICT DO NOTHING
       RETURNING id
     )
     SELECT COUNT(*)::text as count FROM new_exchanges`,
    [channelArns]
  );

  return parseInt(result.rows[0]?.count || '0', 10);
}

/**
 * Fold the final answer + model/intent attribution onto the canonical CREATE
 * row and its exchange when the bot edits its placeholder into the real reply.
 *
 * Delivery is placeholder->update: the bot posts a "One moment..." placeholder
 * (CREATE_CHANNEL_MESSAGE), then edits in the final content + model
 * (UPDATE_CHANNEL_MESSAGE, archived as a row of its own per event, `<id>-UPD-<hash>`). Analytics
 * reads resolve the CREATE row — exchanges link `agent_message_id` to it, and
 * `messages.bedrock_model` is read off it — so without this step every read sees
 * the placeholder, a null model, and (because intent lands on the update) a null
 * intent. The schema carries `updated_content` on the message row and the
 * denormalized intent/model on the exchange precisely so the UPDATE can be
 * folded onto the canonical record; that is what this does.
 *
 * Order-independent for the normal case: the CREATE batch is archived before the
 * UPDATE batch (same channel -> same Kinesis shard -> in-sequence), so the target
 * message and exchange already exist when the UPDATE arrives. COALESCE keeps any
 * value already present, so a rare in-order race (CREATE archived after analytics
 * were written) is not clobbered, and a re-delivered UPDATE is idempotent.
 *
 * AND IT CORRECTS ONE PROVENANCE CLAIM, which is the one thing here that is not a COALESCE. The
 * pairing may have been minted before the turn's declaration reached the archive, in which case the
 * sweep recorded `paired_by = 'swept'` over evidence that did not exist yet. Where this update
 * carries a declaration naming the exchange's own user message, the label is promoted to `declared`.
 * See the comment on that clause for why it promotes only, only on exact equality, and why it stays
 * now that the sweep defers instead of racing.
 */
export async function backfillFromUpdateEvents(
  updates: MessageRecord[]
): Promise<void> {
  for (const upd of updates) {
    // Each UPDATE event is its own row, `<createId>-UPD-<hash>` (migration 084, update-events.ts);
    // the canonical CREATE is the message the event is about.
    if (!isUpdateEventId(upd.message_id)) continue;
    const createMessageId = baseIdOfRecord(upd);

    try {
      // 1. Fold the final content + model/telemetry onto the bot CREATE message.
      await query(
        `UPDATE messages
            SET updated_content = CASE
                                       -- THE LATEST TEXT, BY THE EVENT'S OWN INSTANT, NOT BY ARRIVAL
                                       -- (migration 084). Every update is its own row by the time this
                                       -- runs (step 1 inserted the batch), so an update older than one
                                       -- already stored, a redelivery arriving late among them, leaves
                                       -- the newer text in place. An event with no timestamp folds as it
                                       -- always has.
                                       WHEN $14::timestamptz IS NOT NULL AND EXISTS (
                                         SELECT 1 FROM messages later
                                          WHERE later.channel_arn = $13
                                            AND later.event_type = 'UPDATE_CHANNEL_MESSAGE'
                                            AND later.base_message_id = $12
                                            AND later.last_updated_at > $14::timestamptz)
                                       THEN updated_content
                                       ELSE COALESCE($1, updated_content) END,
                bedrock_model   = COALESCE($2, bedrock_model),
                assistant      = COALESCE($3, assistant),
                input_tokens    = COALESCE($4, input_tokens),
                output_tokens   = COALESCE($5, output_tokens),
                latency_ms      = COALESCE($6, latency_ms),
                total_ms        = COALESCE($7, total_ms),
                poll_ms         = COALESCE($8, poll_ms),
                experiment_id   = COALESCE($9, experiment_id),
                variant_id      = COALESCE($10, variant_id),
                was_fallback    = COALESCE(was_fallback, FALSE) OR $11,
                -- agent_final_at: the Chime update time of the FINAL answer, for e2e_ms (LATENCY-TARGETS.md).
                --
                -- FINALITY IS DECLARED, NOT INFERRED. $17 is the producer's own
                -- respPhase, stamped on the update that carries the answer. Only 'final' closes the turn,
                -- so an interim update is harmless BY CONSTRUCTION rather than by happening to arrive with
                -- no telemetry.
                --
                -- The $7 (total_ms) test is now a LEGACY FALLBACK and fires only when no phase was declared,
                -- i.e. on messages written before this shipped. It was never a statement about finality: it
                -- said "this update carries worker telemetry", and the two coincided only for as long as no
                -- interim update happened to carry any. The battle clarification update does carry telemetry,
                -- and under the old rule it FROZE e2e_ms at a moment the duel had not finished.
                --
                -- COALESCE still freezes the FIRST completion so a later edit cannot move it: a moderation
                -- content-edit re-reads the SAME out-of-band record and would otherwise pass any gate.
                -- (Redactions are -RED rows, skipped upstream, and never reach here.)
                agent_final_at  = COALESCE(agent_final_at,
                                    CASE WHEN $17::text = 'final' THEN $14::timestamptz
                                         WHEN $17::text IS NULL AND $7 IS NOT NULL THEN $14::timestamptz
                                    END),
                -- Latency split (LATENCY-TARGETS.md): model_ms = Converse inference, tool_ms = in-loop
                -- tool execution. Folded like latency_ms; COALESCE keeps them idempotent.
                model_ms        = COALESCE($15, model_ms),
                tool_ms         = COALESCE($16, tool_ms),
                -- APPENDED AS $18, not inserted next to poll_ms: the params above are referenced by
                -- number in this statements own comments, and renumbering them to keep related
                -- columns adjacent is how a fold quietly starts writing the wrong one.
                placeholder_resolve_ms = COALESCE($18, placeholder_resolve_ms),
                guard_ms               = COALESCE($19, guard_ms),
                classifier_ms          = COALESCE($20, classifier_ms),
                router_ms              = COALESCE($21, router_ms),
                -- $22 (G9). COALESCE like the rest, which is also what keeps FALSE-by-absence intact:
                -- a warm turn folds NULL and leaves whatever the row already had, so a cold turn's
                -- TRUE can never be erased by a later update of the same message.
                cold_start             = COALESCE($22, cold_start),
                -- $23 (G13). COALESCE like the rest: the declared instant arrives on whichever event
                -- carried the analytics, and a later update with none must not erase it.
                trigger_at             = COALESCE($23::timestamptz, trigger_at),
                -- $24 (migration 046). THE CLEARANCE ARRIVES ON THE UPDATE, LIKE EVERY OTHER
                -- ANALYTIC. The router declares it, the processor stamps it in the turn's metadata,
                -- and that metadata rides the update row - so without this line the canonical CREATE
                -- row is NULL forever. COALESCE like the rest: a later update that declares none must
                -- not erase what the turn ran under.
                user_clearance         = COALESCE($24, user_clearance),
                -- $25 (migration 050). The conversation's classification rides the same update row, for
                -- the same reason.
                conversation_classification = COALESCE($25, conversation_classification),
                -- $26 (migration 054). HOW THE TURN ENTERED, folded for exactly the reason the two
                -- lines above are. The placeholder CREATE row carries no analytics, and all three
                -- readers join messages on the CREATE event type - so without this the column is NULL
                -- on every canonical row and the Latency tab gains a grouping key whose only value is
                -- unknown. COALESCE like the rest.
                turn_entry             = COALESCE($26, turn_entry),
                -- ── $27-$31 (migrations 056, 057). THE ANSWER'S OWN FACTS, ONTO THE ROW THAT IS
                -- THE ANSWER ──────────────────────────────────────────────────────────────────
                --
                -- WHY THESE HAVE TO FOLD, and why leaving them out was silent. A placeholder CREATE
                -- carries no analytics - that is the whole reason this function exists - so every
                -- one of these is NULL on it and arrives only here. And exchanges.agent_message_id
                -- is the CREATE row, never an update row, so a column that never folds is a
                -- column every exchange reads as NULL.
                --
                -- battle_id unfolded meant a duel minted by the in-batch pairer was invisible to
                -- the per-duel review, to battle_count, and to the win bucketing that resolves a
                -- pick through its duel - so wins would have regressed to a dash with only a warning
                -- to say why. The sweep path was correct by accident, because it coalesces the
                -- update row explicitly; the in-batch path had nothing to coalesce.
                --
                -- Role, version and config id have the same shape and predate the battle columns:
                -- migration 056 added them and only the update rows ever carried them.
                assistant_role         = COALESCE($27, assistant_role),
                profile_version        = COALESCE($28, profile_version),
                profile_config_id      = COALESCE($29, profile_config_id),
                battle_id              = COALESCE($30, battle_id),
                -- The round is the exception that proves the rule: it is read off the placeholder's
                -- own content marker, so the CREATE row DOES have it. Folded anyway, because an
                -- update that carries one must not be able to disagree with it, and COALESCE keeps
                -- the CREATE's value where it already has one.
                battle_round           = COALESCE(battle_round, $31),
                -- THE TARGET AN ANSWER WRITTEN INTO A NOTICE DECLARED. The update row is the notice and
                -- names nothing, so without this an Amazon Lex placeholder that ended holding its answer
                -- had no declared target anywhere the sweep reads.
                answers_message_id     = COALESCE(answers_message_id, $32),
                -- $33 (migration 091). The served definition's name, folded like its version and
                -- config id: only the update row carries the analytics.
                profile_name           = COALESCE($33, profile_name)
          WHERE message_id = $12
            AND channel_arn = $13
            AND event_type = 'CREATE_CHANNEL_MESSAGE'`,
        [
          upd.content,
          upd.bedrock_model,
          upd.assistant,
          upd.input_tokens,
          upd.output_tokens,
          upd.latency_ms,
          upd.total_ms,
          upd.poll_ms,
          upd.experiment_id,
          upd.variant_id,
          upd.was_fallback,
          createMessageId,
          upd.channel_arn,
          upd.last_updated_at,
          upd.model_ms,
          upd.tool_ms,
          upd.resp_phase,
          // $18. Appended LAST because the position in this array IS the parameter number: putting it
          // beside poll_ms would have shifted model_ms/tool_ms/resp_phase by one and folded each into
          // the column after it, with nothing to complain.
          upd.placeholder_resolve_ms,
          // $19. Appended last, same reason as $18.
          upd.guard_ms,
          // $20. Appended last, same reason as $18 and $19.
          upd.classifier_ms,
          // $21. Appended last, same reason as $18-$20.
          upd.router_ms,
          // $22. Appended last, same reason as $18-$21.
          upd.cold_start,
          // $23. Appended last, same reason as $18-$22.
          upd.trigger_at,
          // $24. Appended last, same reason as $18-$23.
          upd.user_clearance,
          // $25. Appended last, same reason as $18-$24.
          upd.conversation_classification,
          // $26. Appended last, same reason as $18-$25.
          upd.turn_entry,
          // $27-$31. Appended last, same reason as $18-$26: a renumber of the existing list is a
          // silent mis-bind, and every one of these is COALESCEd so order carries no meaning.
          upd.assistant_role,
          upd.profile_version,
          upd.profile_config_id,
          upd.battle_id,
          upd.battle_round,
          // $32. Appended last, same reason as $18-$31. Only an answer written into a notice.
          isAnswerWrittenIntoNotice(upd) ? upd.answers_message_id : null,
          // $33. Appended last, same reason as $18-$32.
          upd.profile_name,
        ]
      );

      // 1b. KEEP THIS VERSION ON THE MESSAGE'S OWN ROW (migration 070). Every update is also its own
      //     row (084), and this list is the one place the versions read in order beside the original,
      //     on the row the read-time redaction join covers. Guarded on containment so a redelivered
      //     event appends nothing.
      if (upd.content != null) {
        const version = JSON.stringify([{ at: upd.last_updated_at || upd.created_at, content: upd.content }]);
        await query(
          `UPDATE messages
              SET content_versions = COALESCE(content_versions, '[]'::jsonb) || $1::jsonb
            WHERE message_id = $2
              AND channel_arn = $3
              AND event_type = 'CREATE_CHANNEL_MESSAGE'
              AND NOT (COALESCE(content_versions, '[]'::jsonb) @> $1::jsonb)`,
          [version, createMessageId, upd.channel_arn],
        );
      }

      // 2. Fold intent/routing/task attribution onto the exchange that pairs this
      //    reply. Intent lives only on exchanges (no messages.intent column) and
      //    lands on the update, so an exchange paired from the CREATE placeholder
      //    otherwise keeps a NULL intent -> "unknown".
      await query(
        `UPDATE exchanges ex
            SET intent            = COALESCE($1, ex.intent),
                intent_confidence = COALESCE($2, ex.intent_confidence),
                -- $3 (migration 092): the task's type, in the position the unwritten original_intent held, so no later number moves.
                task_type         = COALESCE($3, ex.task_type),
                was_rerouted      = COALESCE(ex.was_rerouted, FALSE) OR $4,
                delivery_option   = COALESCE($5, ex.delivery_option),
                assistant        = COALESCE($6, ex.assistant),
                task_id           = COALESCE($7, ex.task_id),
                task_status       = COALESCE($8, ex.task_status),
                experiment_id     = COALESCE($9, ex.experiment_id),
                variant_id        = COALESCE($10, ex.variant_id),
                was_fallback      = COALESCE(ex.was_fallback, FALSE) OR $11,
                task_state        = COALESCE($14, ex.task_state),
                task_transition   = COALESCE($15, ex.task_transition),
                -- $19-$21 (migration 092, ADR-064 decision 4): the step the turn started in and what chose its model.
                task_step         = COALESCE($19, ex.task_step),
                model_kind        = COALESCE($20, ex.model_kind),
                model_from        = COALESCE($21, ex.model_from),
                -- $17 (migration 050): the conversation's classification, declared on the update like
                -- the rest of the turn's analytics.
                conversation_classification = COALESCE($17, ex.conversation_classification),
                -- ── $18: THE DECLARATION ARRIVED LATE, AND THE ROW SAYS SO RATHER THAN STAYING WRONG ──
                --
                -- This is NOT re-deriving a pairing. It records that the turn's own statement of what
                -- it answered reached the archive after the pairing had already been minted. The
                -- sweep was right about the evidence it had; this corrects the claim once the
                -- evidence exists.
                --
                -- ── KEPT, AND NOW A BACKSTOP RATHER THAN THE REPAIR (reassessed 2026-09-16) ────────
                --
                -- This was added when the sweep minted from the placeholder alone, which made a late
                -- declaration the ORDINARY case: any turn slower than the five second Kinesis
                -- batching window was labeled 'swept' and repaired here one batch later. The sweep
                -- now DEFERS a bot message that has no update yet (updateDeferSeconds), so that
                -- population is gone and this fires rarely.
                --
                -- IT IS NOT REDUNDANT, because the deferral is required to EXPIRE. Past the
                -- staleness bound the sweep pairs whatever it has, and a turn that genuinely ran
                -- longer than the bound - a re-driven consumer, a shard replayed hours late, a
                -- deployment upgraded mid-turn - still has its declaration arrive afterwards. That
                -- is exactly the residual an expiring deferral hands over, and without this the
                -- bound would become a hard censoring boundary: every turn slower than it labeled
                -- 'swept' for good, which is the defect one size smaller.
                --
                -- It matters because the Latency tab excludes a swept pairing from TTFF by name, and
                -- excluding it is CORRECT: a genuine sweep searched up to the reply bound for a
                -- plausible answer, so its response_latency_ms is the gap to whatever that search
                -- chose. What was wrong is which rows carried the label, and the rows wrongly carrying
                -- it were exactly the slow ones the SLO exists to catch.
                --
                -- PROMOTES ONLY, ON EXACT EQUALITY, AND ONLY FROM 'swept'.
                --   * ELSE keeps ex.paired_by, so nothing is ever downgraded and a row already
                --     'declared' or 'in_batch' is untouched - this statement contains no path that
                --     writes any other value.
                --   * The comparison is against the exchange's OWN user message id, read through the
                --     primary key. A declaration naming a DIFFERENT message is not this pairing being
                --     confirmed, it is evidence the pairing is wrong, and inventing a promotion from
                --     it would be the guesswork the declaration exists to end.
                --   * A NULL on either side yields NULL, which is not TRUE, so the ELSE holds. A turn
                --     that declared nothing keeps its swept label and stays out of the TTFF average.
                --
                -- NO BACKTICKS ANYWHERE IN THIS SQL: it is a template literal, and one backtick in a
                -- comment ends the string mid-query.
                paired_by = CASE
                              WHEN ex.paired_by = 'swept'
                               AND $18::text IS NOT NULL
                               AND $18::text = (
                                     SELECT um.message_id FROM messages um
                                      WHERE um.id = ex.user_message_id
                                   )
                              THEN 'declared'
                              ELSE ex.paired_by
                            END,
                -- e2e_ms: user message -> final answer. am.agent_final_at was set by the UPDATE above,
                -- ex.user_message_at is the paired user message time (both on the Chime clock, so this is
                -- skew-free). The greater-than guard clamps out any anomaly; COALESCE keeps it idempotent. Null
                -- until agent_final_at is present. LATENCY-TARGETS.md.
                --
                -- A LATER DUEL ROUND is measured from its own declared trigger, which the UPDATE above
                -- folded onto am.trigger_at, and never from ex.user_message_at: that is the message the
                -- duel began from, and a span from it covers both rounds (exchangeE2eSql).
                --
                -- A LATER ROUND IS RECOMPUTED, NOT FROZEN. Its stored value is ignored, so the rule
                -- overwrites whatever an earlier writer (or an older build still draining during a
                -- deploy) stored, and the value converges to the trigger-anchored rule migration 071
                -- repairs to. The rule is deterministic over the folded instants, so a repeat fold
                -- writes the same value. A first round keeps the COALESCE freeze.
                e2e_ms            = COALESCE(CASE WHEN COALESCE(ex.battle_round, am.battle_round, 1) > 1 THEN NULL
                                                  ELSE ex.e2e_ms END,
                                      ${exchangeE2eSql({
                                        round: 'COALESCE(ex.battle_round, am.battle_round)',
                                        finalAt: 'am.agent_final_at',
                                        triggerAt: 'am.trigger_at',
                                        userAt: 'ex.user_message_at',
                                      })}),
                -- inbound_ms (LATENCY-TARGETS.md): user message -> processor entry (routing/queue/cold
                -- start). CROSS-CLOCK ($16 server-clock entry vs ex.user_message_at Chime); GREATEST
                -- clamps the skew to >= 0. Approximate by design.
                --
                -- NULL ON A LATER DUEL ROUND, for the reason e2e_ms above is re-anchored: the span from
                -- the person's message to this turn's processor entry covers the whole of round one.
                -- Written NULL rather than coalesced, so a value an earlier writer stored is cleared.
                inbound_ms        = CASE WHEN COALESCE(ex.battle_round, am.battle_round, 1) > 1 THEN NULL
                                         ELSE COALESCE(ex.inbound_ms,
                                                CASE WHEN $16::bigint IS NOT NULL
                                                     THEN GREATEST(0, ($16::bigint - (EXTRACT(EPOCH FROM ex.user_message_at) * 1000)::bigint)::integer)
                                                END)
                                    END,
                -- The reply time is a span from the person's message too, so a later round clears it
                -- the same way, matching what the in-batch pairer and the sweep write for that round.
                response_latency_ms = CASE WHEN COALESCE(ex.battle_round, am.battle_round, 1) > 1 THEN NULL
                                           ELSE ex.response_latency_ms
                                      END
           FROM messages am
          WHERE ex.agent_message_id = am.id
            AND am.message_id = $12
            AND am.channel_arn = $13`,
        [
          upd.intent,
          upd.intent_confidence,
          // $3: the task's type (migration 092), in the position the unwritten original_intent held.
          upd.task_type,
          upd.was_rerouted,
          upd.delivery_option,
          upd.assistant,
          upd.task_id,
          upd.task_status,
          upd.experiment_id,
          upd.variant_id,
          upd.was_fallback,
          createMessageId,
          upd.channel_arn,
          upd.task_state,
          // JSONB param — stringify {from,to}; NULL when the update carried no transition.
          upd.task_transition ? JSON.stringify(upd.task_transition) : null,
          upd.processor_entry_ms,
          // $17. Appended last so no earlier parameter number moves.
          upd.conversation_classification,
          // $18. Appended last, same reason as $17: the position in this array IS the parameter
          // number. The message this turn declared it answered, from whichever carrier it had -
          // already folded to this field by `transformToMessageRecord`, so this reads one value
          // rather than repeating that resolution.
          upd.answers_message_id,
          // $19-$21, appended last so no earlier parameter number moves.
          upd.task_step,
          upd.model_kind,
          upd.model_from,
        ]
      );
    } catch (error) {
      // Non-fatal — a failed backfill must not abort archival of the batch.
      console.error(
        `Error backfilling from update ${upd.message_id}:`,
        error
      );
    }
  }
}

/**
 * Process drift detection for user messages, post-hoc from the archival pipeline.
 *
 * This is the analytics-mode call site. The live-suggestion path runs in the
 * Lex fulfillment Lambda; this archival pass exists for historical drift
 * scoring and for messages that bypassed the live path (e.g., before the
 * `enableLiveDrift` feature flag was flipped on).
 *
 * Per SPEC-DRIFT-CONVERGENCE.md, the hardened detectDrift() takes structured
 * input including `intent`. The archival pipeline doesn't have a classified
 * intent — it processes raw messages — so we pass 'GENERAL' which skips the
 * intent-based short-circuits and lets the cosine path run.
 */
async function processDriftDetection(
  records: MessageRecord[]
): Promise<void> {
  // Only check user messages (not bot responses)
  const userMessages = records.filter((r) => !r.is_bot && r.content);

  // Per-BATCH memo: classification is immutable per channel, and the lookup is one SELECT per call,
  // so a busy channel's N user messages in one batch were N identical queries. Batch-scoped (not
  // module-scoped) on purpose - a channel recorded mid-run is picked up by the next batch rather
  // than pinned to a stale null for the container's lifetime.
  const classificationByChannel = new Map<string, string | null>();

  for (const record of userMessages) {
    try {
      // ADR-028: drift's summary-embedding reads run as a per-classification database role, so this
      // post-hoc pass needs a classification too. It runs in the VPC with no route to Chime, so the
      // only source is the projection.
      //
      // THERE IS NO FALLBACK, AND THAT IS THE POINT. This value selects a reader role, which sees its
      // own classification AND everything that classification grants, so a substitute is a privilege
      // decision wearing a label's clothes. Defaulting to the most restrictive value hands this pass
      // the entire table - "fail-closed" spelled the way that fails open - because the classification
      // fewest holders reach is the one whose own grant set is widest. That inversion shipped once
      // (`failClosedContentValue`, ADR-046 removing the floor) and is what this now refuses to do.
      //
      // The consequence is honest under-reporting: an unrecorded channel is not scored at all, so its
      // drift simply does not fire. Analytics loses a row; nothing crosses a boundary.
      const projected = classificationByChannel.has(record.channel_arn)
        ? classificationByChannel.get(record.channel_arn)!
        : await lookupChannelClassification(record.channel_arn);
      classificationByChannel.set(record.channel_arn, projected);
      if (!projected) {
        // DRIFT DOES NOT RUN FOR A CHANNEL WHOSE CLASSIFICATION IS UNKNOWN, because there is no
        // longer a value that is safe to substitute here.
        //
        // This used to substitute the floor, which was right: a reader role sees its own
        // classification AND everything it grants, so the floor was the narrowest possible reader.
        // ADR-046 removed the floor, and the replacement reached for - `failClosedContentValue` - is
        // the value for STAMPING content, defined as the classification the FEWEST holders reach. For
        // a stamp that is the most restrictive answer; for a READER it is the WIDEST, because that
        // classification's `grantsFor` set is the largest. It selected `ae_reader_premium`, whose RLS
        // scope is every row of each bounded table, for a channel that may be basic.
        //
        // Skipping is what the comment above already promised: "Analytics loses a row; nothing
        // crosses a boundary." There is no narrowest-reach value to fall back to, so the honest
        // degrade is not to score rather than to score with a privilege we cannot justify.
        console.warn(
          `[kinesis-archival] no recorded classification for ${record.channel_arn}; SKIPPING drift `
          + 'scoring for this message rather than choosing a reader role for it. Historical drift is '
          + 'under-reported until the Chime-sourced backfill records it.',
        );
        continue;
      }

      const driftResult = await detectDrift({
        channelArn: record.channel_arn,
        latestMessage: record.content!,
        intent: 'GENERAL',
        // THE CHANNEL'S OWN CLASSIFICATION, NEVER A SUBSTITUTE. This selects the Postgres reader role
        // (`detectDrift` passes it to `withReaderRole`), so it is an ADMISSION decision and not, as
        // this comment previously claimed, a stamp. The unknown case returned above.
        classification: projected,
      });

      if (driftResult.isDrift) {
        await recordDriftFire({
          result: driftResult,
          channelArn: record.channel_arn,
          messageId: record.message_id,
          // The bare person id, matching what the LIVE path writes. This previously stored the whole
          // sender ARN, so `drift_events.person_id` held two different shapes depending on which
          // path fired: any join to a user, and the idx_drift_events_person index, silently split in
          // two. (The column is VARCHAR(128) while sender_arn is VARCHAR(256), so a long ARN was a
          // truncation risk too.) Read through the one ARN helper, as the rest of this file does.
          personId: personIdFromArn(record.sender_arn) || undefined,
          intent: 'GENERAL',
          // Nothing was shown to the user here - this is historical scoring, not a suggestion. It
          // must never be counted as an offer: it has nobody to accept it and never settles.
          source: 'archival',
        });
        console.log(
          `Drift detected in ${record.channel_arn}: score=${driftResult.driftScore} confidence=${driftResult.confidence}`
        );
      }
    } catch (error) {
      // Non-fatal -- drift detection is best-effort
      console.warn('Drift detection error:', error);
    }
  }
}

/**
 * Update cross-conversation context from bot summaries.
 */
async function processContextUpdates(
  records: MessageRecord[]
): Promise<void> {
  // For each channel with new messages, check if we can extract user/topic info
  const channels = [...new Set(records.map((r) => r.channel_arn))];

  for (const channelArn of channels) {
    try {
      // Get user sub from the channel's user messages
      const userRecord = records.find(
        (r) => r.channel_arn === channelArn && !r.is_bot && r.sender_arn
      );
      if (!userRecord?.sender_arn) continue;

      const personId = personIdFromArn(userRecord.sender_arn);
      if (!personId) continue;

      // THE LAST USER MESSAGE'S ID, NOT ITS TEXT (migration 068). This used to slice the message
      // itself - 100 characters as a topic, 500 as a summary - which put a second copy of what
      // somebody said in a table the redaction mechanism cannot reach, because `-RED`/`-DEL` sibling
      // rows resolve at read time and a copy is not a derived view. The reference is followed when
      // the text is genuinely needed, and following it goes through that message's own access
      // control rather than around it.
      const latestUserRecord = records
        .filter((r) => r.channel_arn === channelArn && !r.is_bot && r.content)
        .pop();

      if (!latestUserRecord) continue;

      // The conversation's classification, as the turn declared it from the channel's tag. The table
      // is bounded (ADR-028), so a row written without one is a row no reader role can see - skip
      // rather than stamp a guess, and the next turn that does declare one writes it.
      const classification = latestUserRecord.conversation_classification;
      if (!classification) continue;

      await updateConversationContext(
        personId,
        channelArn,
        classification,
        latestUserRecord.message_id ?? null
      );
    } catch (error) {
      // Non-fatal
      console.warn('Context update error:', error);
    }
  }
}

/**
 * Sync membership events to channel_membership table
 */
async function syncMembershipRecords(
  records: MessageRecord[]
): Promise<void> {
  let synced = 0;

  for (const record of records) {
    const { event_type, channel_arn, target_arn } = record;

    if (!target_arn || !target_arn.includes('/user/')) {
      continue;
    }

    const personId = personIdFromArn(target_arn);
    if (!personId) continue;

    try {
      if (event_type === 'CREATE_CHANNEL_MEMBERSHIP') {
        await query(
          `INSERT INTO channel_membership (channel_arn, person_id, membership_role)
           VALUES ($1, $2, 'member')
           ON CONFLICT (channel_arn, person_id) DO UPDATE SET updated_at = NOW()`,
          [channel_arn, personId]
        );
        synced++;
      } else if (event_type === 'DELETE_CHANNEL_MEMBERSHIP') {
        await query(
          `DELETE FROM channel_membership WHERE channel_arn = $1 AND person_id = $2`,
          [channel_arn, personId]
        );
        synced++;
      } else if (event_type === 'UPDATE_CHANNEL_MEMBERSHIP') {
        await query(
          `UPDATE channel_membership SET updated_at = NOW()
           WHERE channel_arn = $1 AND person_id = $2`,
          [channel_arn, personId]
        );
        synced++;
      }
    } catch (err) {
      console.error(
        `Membership sync error for ${event_type} on ${channel_arn}:`,
        err
      );
    }
  }

  if (synced > 0) {
    console.log(`Synced ${synced} membership events`);
  }

  // NO DERIVED MEMBER COUNT IS PUBLISHED FROM HERE, and adding one back is a regression.
  //
  // This function's product is `channel_membership`, the per-member rows the admin conversation query
  // aggregates at read time. It does not also cache a per-channel total, because the only decision that
  // ever wanted one - which entry answers an `@all` turn - cannot use a stored count at all:
  //
  //  - `channel_membership` projects only `/user/` ARNs, so any total derived here counts humans and
  //    has to guess at assistants. A battle channel is one user and TWO bots and reports 2, which is
  //    the 1:1 shape the responder branch must never misread.
  //  - `lib/channel-size.ts` is the single definition both the channel flow and the router import,
  //    precisely so the two halves of that decision cannot disagree, and it resolves size from a live
  //    `ListChannelMemberships` - what Amazon Chime SDK itself counts, which is what the routing rule
  //    is about.
  //
  // A cached total therefore has no reader, and producing one costs a `COUNT(*)` per touched channel on
  // every batch that carries a membership event.
}

/**
 * Sync CREATE_CHANNEL and UPDATE_CHANNEL events to the channel_registry table.
 *
 * UPDATE_CHANNEL matters as much as CREATE_CHANNEL here: a conversation is created
 * as the placeholder 'New conversation' (channel-title.ts) and auto-titled on its
 * first turn via UpdateChannel, and a user can rename it at any time afterwards.
 * Syncing creation alone froze `channel_name` at the placeholder for every
 * auto-titled conversation, so the column did not mean what its name says.
 */
async function syncChannelRegistryRecords(
  records: MessageRecord[]
): Promise<void> {
  let synced = 0;

  for (const record of records) {
    const { channel_arn, metadata } = record;
    if (!channel_arn) continue;

    try {
      const meta = metadata || {};
      const isPrimary = false;

      // Classify channel type from metadata. Left NULL when the event carries no
      // classification so an UPDATE_CHANNEL (a rename, which has no channelType)
      // cannot downgrade an existing 'guest' row to the 'conversation' default.
      let channelType: string | null = null;
      if (meta.channelType) {
        channelType = meta.channelType;
      } else if (meta.contextType === 'guest') {
        channelType = 'guest';
      } else if (record.event_type === 'CREATE_CHANNEL') {
        channelType = 'conversation';
      }

      const channelName = record.content || meta.channelName || null;

      await query(
        `INSERT INTO channel_registry (channel_arn, channel_type, is_primary, channel_name, created_via)
         VALUES ($1, COALESCE($2, 'conversation'), $3, $4, $5)
         ON CONFLICT (channel_arn) DO UPDATE SET
           -- The RAW parameter, NOT EXCLUDED.channel_type: the VALUES row has already coalesced $2
           -- to 'conversation', so EXCLUDED is never NULL and the guard the comment above describes
           -- never fired - a metadata-less UPDATE_CHANNEL silently reclassified a 'guest' row.
           channel_type = COALESCE($2, channel_registry.channel_type),
           channel_name = COALESCE(EXCLUDED.channel_name, channel_registry.channel_name),
           created_via = COALESCE(EXCLUDED.created_via, channel_registry.created_via),
           updated_at = NOW()`,
        [
          channel_arn,
          channelType,
          isPrimary,
          channelName,
          meta.createdVia || 'kinesis',
        ]
      );
      synced++;
    } catch (err) {
      console.error(
        `Channel registry sync error for ${channel_arn}:`,
        err
      );
    }
  }

  if (synced > 0) {
    console.log(`Synced ${synced} channel registry events`);
  }
}
