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
import { updateConversationContext } from './cross-conversation-context.js';
import { readMessageAnalytics } from '../lib/message-analytics.js';
import { backfillModelFromAnalytics, ModelBackfillResult } from './model-backfill.js';
import { touchActivity } from '../lib/sleep-mode.js';

const MAX_AUTH_RETRIES = 2;

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
    Type?: string;
    Persistence?: string;
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
interface MessageRecord {
  event_type: string;
  message_id: string;
  channel_arn: string;
  content: string | null;
  sender_arn: string | null;
  sender_name: string | null;
  target_arn: string | null;
  is_bot: boolean;
  user_type: string | null;
  agent_type: string | null;
  bedrock_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  total_ms: number | null;
  poll_ms: number | null;
  persistence: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
  intent: string | null;
  intent_confidence: string | null;
  original_intent: string | null;
  was_rerouted: boolean;
  delivery_option: string | null;
  task_id: string | null;
  task_status: string | null;
  // Task MACHINE state (SPEC-TASK-STATE-TRANSITIONS §6), distinct from task_status (the lifecycle):
  // task_state = the declared-graph state after this turn; task_transition = the edge it applied.
  task_state: string | null;
  task_transition: { from: string; to: string } | null;
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
          const exchangeCount = await createExchangesFromRecords(createMessages);
          console.log(`Created ${exchangeCount} exchanges from batch`);

          // DB-side exchange pairing for cross-batch matches
          const channelArns = [
            ...new Set(createMessages.map((r) => r.channel_arn)),
          ];
          const dbExchangeCount = await createExchangesFromDatabase(channelArns);
          if (dbExchangeCount > 0) {
            console.log(`Created ${dbExchangeCount} exchanges from DB pairing`);
          }

          // 3. Drift detection for user messages
          await processDriftDetection(createMessages);

          // 4. Update cross-conversation context
          await processContextUpdates(createMessages);
        }

        // 5. Fold placeholder->final edits onto the canonical CREATE row +
        //    exchange. Delivery is placeholder->update (the bot posts "One
        //    moment..." then edits in the real answer + model), so without this
        //    every analytics read resolves the placeholder and a null
        //    model/intent. Runs on every batch that carries UPDATE events.
        const updateMessages = records.filter(
          (r) => r.event_type === 'UPDATE_CHANNEL_MESSAGE'
        );
        if (updateMessages.length > 0) {
          await backfillFromUpdateEvents(updateMessages);
        }

        // 6. Sync membership events
        const membershipRecords = records.filter((r) =>
          MEMBERSHIP_EVENT_TYPES.includes(r.event_type)
        );
        if (membershipRecords.length > 0) {
          await syncMembershipRecords(membershipRecords);
        }

        // 7. Sync channel creation events
        const channelCreateRecords = records.filter(
          (r) => r.event_type === 'CREATE_CHANNEL'
        );
        if (channelCreateRecords.length > 0) {
          await syncChannelRegistryRecords(channelCreateRecords);
        }
      });

      console.log(
        `Successfully archived ${records.length} records, ${errors.length} errors`
      );
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
async function transformToMessageRecord(
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
  let persistence: string | null = null;
  let metadata: Record<string, any> | null = null;
  let createdAt: string;
  // Raw Chime MessageId (no archival suffix) — the key the out-of-band analytics
  // row is stored under (Phase 1). Only set for MESSAGE events.
  let rawChimeMessageId: string | null = null;

  if (MESSAGE_EVENT_TYPES.includes(EventType)) {
    if (!Payload.MessageId || !Payload.ChannelArn) {
      console.warn('Missing required fields in message payload');
      return null;
    }

    const suffixMap: Record<string, string> = {
      CREATE_CHANNEL_MESSAGE: '',
      UPDATE_CHANNEL_MESSAGE: '-UPD',
      DELETE_CHANNEL_MESSAGE: '-DEL',
      REDACT_CHANNEL_MESSAGE: '-RED',
    };
    const suffix = suffixMap[EventType] ?? `-${EventType.substring(0, 10)}`;
    messageId = Payload.MessageId + suffix;
    rawChimeMessageId = Payload.MessageId;
    channelArn = Payload.ChannelArn;
    senderArn = Payload.Sender?.Arn || null;
    senderName = Payload.Sender?.Name || null;
    persistence = Payload.Persistence || 'PERSISTENT';
    createdAt =
      Payload.CreatedTimestamp ||
      Payload.LastUpdatedTimestamp ||
      new Date().toISOString();

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

    if (Payload.Metadata) {
      try {
        metadata = JSON.parse(Payload.Metadata);
      } catch {
        metadata = { raw: Payload.Metadata };
      }
    }
  } else if (CHANNEL_EVENT_TYPES.includes(EventType)) {
    const channel = Payload.Channel;
    if (!channel?.ChannelArn) {
      console.warn(`Channel event ${EventType} missing Channel payload`);
      return null;
    }

    const crypto = require('crypto');
    const hash = crypto
      .createHash('md5')
      .update(channel.ChannelArn)
      .digest('hex')
      .substring(0, 16);
    messageId = `${EventType.substring(0, 20)}-${hash}-${Date.now()}`;
    channelArn = channel.ChannelArn;
    senderArn = channel.CreatedBy?.Arn || null;
    senderName = channel.CreatedBy?.Name || null;
    content = channel.Name || null;
    createdAt =
      channel.CreatedTimestamp ||
      channel.LastUpdatedTimestamp ||
      new Date().toISOString();

    metadata = {};
    if (channel.Metadata) {
      try {
        metadata = JSON.parse(channel.Metadata);
      } catch {
        metadata = { raw: channel.Metadata };
      }
    }
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
    }
  }

  const analytics = (metadata as any)?.analytics || metadata || {};

  const intent = analytics.intent || null;
  const intentConfidence = analytics.intentConfidence || null;
  const originalIntent = analytics.originalIntent || null;
  const wasRerouted = analytics.wasRerouted === true;
  const deliveryOption = analytics.deliveryOption || null;
  const taskId = analytics.activeTask?.taskId || null;
  const taskStatus = analytics.activeTask?.status || null;
  // Machine state (§6): stamped per turn by buildAnalyticsMetadata. taskTransition is absent on a
  // turn that advanced nothing; kept structured ({from,to}) for the JSONB column.
  const taskState = analytics.taskState || null;
  const taskTransition =
    analytics.taskTransition && analytics.taskTransition.from && analytics.taskTransition.to
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
    is_bot: isBot,
    user_type: analytics.userType || null,
    agent_type:
      analytics.agentType || (isBot && senderArn ? extractAgentType(senderArn) : null),
    bedrock_model: analytics.model || null,
    input_tokens: analytics.inputTokens || null,
    output_tokens: analytics.outputTokens || null,
    latency_ms: analytics.latencyMs || analytics.bedrockLatencyMs || null,
    total_ms: analytics.totalMs || null,
    poll_ms: analytics.pollMs || null,
    persistence,
    metadata,
    created_at: createdAt,
    intent,
    intent_confidence: intentConfidence,
    original_intent: originalIntent,
    was_rerouted: wasRerouted,
    delivery_option: deliveryOption,
    task_id: taskId,
    task_status: taskStatus,
    task_state: taskState,
    task_transition: taskTransition,
    experiment_id: analytics.experimentId || null,
    variant_id: analytics.variantId || null,
    was_fallback: analytics.wasFallback === true,
  };
}

/**
 * Extract agent type from bot ARN.
 * Uses naming convention fallback since bot UUIDs are deployment-specific.
 */
function extractAgentType(botArn: string): string | null {
  const arnLower = botArn.toLowerCase();
  if (arnLower.includes('guest') || arnLower.includes('basic')) return 'basic';
  if (arnLower.includes('auth') || arnLower.includes('standard')) return 'standard';
  if (arnLower.includes('admin') || arnLower.includes('premium')) return 'premium';
  return null;
}

/**
 * Insert message records into unified messages table
 */
async function insertMessageRecords(records: MessageRecord[]): Promise<number> {
  const columns = [
    'event_type',
    'message_id',
    'channel_arn',
    'content',
    'sender_arn',
    'sender_name',
    'target_arn',
    'is_bot',
    'user_type',
    'agent_type',
    'bedrock_model',
    'input_tokens',
    'output_tokens',
    'latency_ms',
    'total_ms',
    'poll_ms',
    'persistence',
    'task_id',
    'task_status',
    'task_state',
    'task_transition',
    'experiment_id',
    'variant_id',
    'was_fallback',
    'metadata',
    'created_at',
  ];

  const rows = records.map((r) => ({
    event_type: r.event_type,
    message_id: r.message_id,
    channel_arn: r.channel_arn,
    content: r.content,
    sender_arn: r.sender_arn,
    sender_name: r.sender_name,
    target_arn: r.target_arn,
    is_bot: r.is_bot,
    user_type: r.user_type,
    agent_type: r.agent_type,
    bedrock_model: r.bedrock_model,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    latency_ms: r.latency_ms,
    total_ms: r.total_ms,
    poll_ms: r.poll_ms,
    persistence: r.persistence,
    task_id: r.task_id,
    task_status: r.task_status,
    task_state: r.task_state,
    // JSONB column — stringify the {from,to} object (NULL stays NULL for a no-transition turn).
    task_transition: r.task_transition ? JSON.stringify(r.task_transition) : null,
    experiment_id: r.experiment_id,
    variant_id: r.variant_id,
    was_fallback: r.was_fallback,
    metadata: JSON.stringify(r.metadata || {}),
    created_at: r.created_at,
  }));

  return batchInsert(
    'messages',
    columns,
    rows,
    'ON CONFLICT (message_id, channel_arn) DO NOTHING'
  );
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
    const userType =
      channelRecords.find((r) => r.user_type)?.user_type || 'unknown';
    const agentType = channelRecords.find((r) => r.agent_type)?.agent_type;

    await query(
      `INSERT INTO conversations (channel_arn, user_type, agent_type, first_message_at, last_message_at, message_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (channel_arn) DO UPDATE SET
         last_message_at = GREATEST(conversations.last_message_at, EXCLUDED.last_message_at),
         message_count = conversations.message_count + EXCLUDED.message_count,
         updated_at = NOW()`,
      [
        channelArn,
        userType,
        agentType,
        channelRecords[0]?.created_at,
        channelRecords[channelRecords.length - 1]?.created_at,
        channelRecords.length,
      ]
    );
  }
}

/**
 * Create exchange records for user->bot message pairs within the batch
 */
async function createExchangesFromRecords(
  records: MessageRecord[]
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
      if (userRecord.is_bot) continue;

      for (let j = i + 1; j < sorted.length; j++) {
        const botRecord = sorted[j];
        if (botRecord.channel_arn !== channelArn) continue;
        if (!botRecord.is_bot) continue;

        // Check for UPDATE record with analytics metadata
        const updateRecord = sorted.find(
          (r) =>
            r.message_id === botRecord.message_id + '-UPD' &&
            r.event_type === 'UPDATE_CHANNEL_MESSAGE'
        );

        const agentType = updateRecord?.agent_type || botRecord.agent_type;
        const intent = updateRecord?.intent || botRecord.intent;
        const intentConfidence =
          updateRecord?.intent_confidence || botRecord.intent_confidence;
        const originalIntent =
          updateRecord?.original_intent || botRecord.original_intent;
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
               channel_arn, user_type, agent_type,
               response_latency_ms, user_message_at, agent_response_at,
               intent, intent_confidence, original_intent, was_rerouted,
               delivery_option, task_id, task_status, task_state, task_transition
             )
             SELECT
               c.id,
               um.id,
               am.id,
               $1,
               -- Fall back to the conversation's tier when the message itself carries no
               -- user/agent type. DIRECT quick-responses (greetings/acks posted by the router
               -- via Lex) and legacy rows archive without analytics, so without this they land as
               -- 'unknown' in the admin tabs. The conversation has a tier from any analytics-bearing
               -- message in the channel.
               COALESCE($2, c.user_type, 'unknown'),
               COALESCE($3, c.agent_type),
               EXTRACT(EPOCH FROM (am.created_at - um.created_at)) * 1000,
               um.created_at,
               am.created_at,
               $6, $7, $8, $9, $10, $11, $12, $13, $14
             FROM conversations c
             JOIN messages um ON um.message_id = $4 AND um.channel_arn = $1
             JOIN messages am ON am.message_id = $5 AND am.channel_arn = $1
             WHERE c.channel_arn = $1
             ON CONFLICT DO NOTHING`,
            [
              channelArn,
              // Pass raw (may be null) so the SQL COALESCE above can fall back to the
              // conversation tier; 'unknown' is only the final SQL fallback.
              userRecord.user_type || null,
              agentType,
              userRecord.message_id,
              botRecord.message_id,
              intent,
              intentConfidence,
              originalIntent,
              wasRerouted,
              deliveryOption,
              taskId,
              taskStatus,
              taskState,
              // JSONB param: stringify the {from,to} object; NULL for a no-transition turn.
              taskTransition ? JSON.stringify(taskTransition) : null,
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

  const result = await query<{ count: string }>(
    `WITH new_exchanges AS (
       INSERT INTO exchanges (
         conversation_id, user_message_id, agent_message_id,
         channel_arn, user_type, agent_type,
         response_latency_ms, user_message_at, agent_response_at,
         intent, task_id, task_status, task_state, task_transition
       )
       SELECT
         c.id,
         um.id,
         am.id,
         um.channel_arn,
         COALESCE(um.user_type, 'unknown'),
         COALESCE(am_upd.agent_type, am.agent_type),
         EXTRACT(EPOCH FROM (am.created_at - um.created_at)) * 1000,
         um.created_at,
         am.created_at,
         COALESCE(am_upd.metadata->>'intent', am.metadata->>'intent'),
         COALESCE(am_upd.task_id, am.task_id),
         COALESCE(am_upd.task_status, am.task_status),
         COALESCE(am_upd.task_state, am.task_state),
         COALESCE(am_upd.task_transition, am.task_transition)
       FROM messages um
       JOIN messages am ON am.channel_arn = um.channel_arn
         AND am.is_bot = true
         AND am.event_type = 'CREATE_CHANNEL_MESSAGE'
         AND am.created_at > um.created_at
       LEFT JOIN messages am_upd ON am_upd.channel_arn = am.channel_arn
         AND am_upd.event_type = 'UPDATE_CHANNEL_MESSAGE'
         AND am_upd.message_id = am.message_id || '-UPD'
       JOIN conversations c ON c.channel_arn = um.channel_arn
       LEFT JOIN exchanges e ON e.user_message_id = um.id
       WHERE um.is_bot = false
         AND um.event_type = 'CREATE_CHANNEL_MESSAGE'
         AND um.created_at > NOW() - INTERVAL '24 hours'
         AND um.channel_arn = ANY($1)
         AND e.id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM messages mid
           WHERE mid.channel_arn = um.channel_arn
             AND mid.is_bot = true
             AND mid.event_type = 'CREATE_CHANNEL_MESSAGE'
             AND mid.created_at > um.created_at
             AND mid.created_at < am.created_at
         )
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
 * (UPDATE_CHANNEL_MESSAGE, archived as a separate `<id>-UPD` row). Analytics
 * reads resolve the CREATE row — exchanges link `agent_message_id` to it, and
 * `messages.bedrock_model` is read off it — so without this step every read sees
 * the placeholder, a null model, and (because intent lands on the update) a null
 * intent. The schema carries `updated_content` on the message row and the
 * denormalised intent/model on the exchange precisely so the UPDATE can be
 * folded onto the canonical record; that is what this does.
 *
 * Order-independent for the normal case: the CREATE batch is archived before the
 * UPDATE batch (same channel -> same Kinesis shard -> in-sequence), so the target
 * message and exchange already exist when the UPDATE arrives. COALESCE keeps any
 * value already present, so a rare in-order race (CREATE archived after analytics
 * were written) is not clobbered, and a re-delivered UPDATE is idempotent.
 */
export async function backfillFromUpdateEvents(
  updates: MessageRecord[]
): Promise<void> {
  for (const upd of updates) {
    // The UPDATE row is stored as `<createId>-UPD`; recover the canonical CREATE
    // message id by stripping the archival suffix.
    if (!upd.message_id.endsWith('-UPD')) continue;
    const createMessageId = upd.message_id.slice(0, -'-UPD'.length);

    try {
      // 1. Fold the final content + model/telemetry onto the bot CREATE message.
      await query(
        `UPDATE messages
            SET updated_content = COALESCE($1, updated_content),
                bedrock_model   = COALESCE($2, bedrock_model),
                agent_type      = COALESCE($3, agent_type),
                input_tokens    = COALESCE($4, input_tokens),
                output_tokens   = COALESCE($5, output_tokens),
                latency_ms      = COALESCE($6, latency_ms),
                total_ms        = COALESCE($7, total_ms),
                poll_ms         = COALESCE($8, poll_ms),
                experiment_id   = COALESCE($9, experiment_id),
                variant_id      = COALESCE($10, variant_id),
                was_fallback    = COALESCE(was_fallback, FALSE) OR $11
          WHERE message_id = $12
            AND channel_arn = $13
            AND event_type = 'CREATE_CHANNEL_MESSAGE'`,
        [
          upd.content,
          upd.bedrock_model,
          upd.agent_type,
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
        ]
      );

      // 2. Fold intent/routing/task attribution onto the exchange that pairs this
      //    reply. Intent lives only on exchanges (no messages.intent column) and
      //    lands on the update, so an exchange paired from the CREATE placeholder
      //    otherwise keeps a NULL intent -> "unknown".
      await query(
        `UPDATE exchanges ex
            SET intent            = COALESCE($1, ex.intent),
                intent_confidence = COALESCE($2, ex.intent_confidence),
                original_intent   = COALESCE($3, ex.original_intent),
                was_rerouted      = COALESCE(ex.was_rerouted, FALSE) OR $4,
                delivery_option   = COALESCE($5, ex.delivery_option),
                agent_type        = COALESCE($6, ex.agent_type),
                task_id           = COALESCE($7, ex.task_id),
                task_status       = COALESCE($8, ex.task_status),
                experiment_id     = COALESCE($9, ex.experiment_id),
                variant_id        = COALESCE($10, ex.variant_id),
                was_fallback      = COALESCE(ex.was_fallback, FALSE) OR $11,
                task_state        = COALESCE($14, ex.task_state),
                task_transition   = COALESCE($15, ex.task_transition)
           FROM messages am
          WHERE ex.agent_message_id = am.id
            AND am.message_id = $12
            AND am.channel_arn = $13`,
        [
          upd.intent,
          upd.intent_confidence,
          upd.original_intent,
          upd.was_rerouted,
          upd.delivery_option,
          upd.agent_type,
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

  for (const record of userMessages) {
    try {
      const driftResult = await detectDrift({
        channelArn: record.channel_arn,
        messageId: record.message_id,
        latestMessage: record.content!,
        intent: 'GENERAL',
      });

      if (driftResult.isDrift) {
        await recordDriftFire({
          result: driftResult,
          channelArn: record.channel_arn,
          messageId: record.message_id,
          userSub: record.sender_arn || undefined,
          intent: 'GENERAL',
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

      const userSub = userRecord.sender_arn.split('/user/')[1];
      if (!userSub) continue;

      // Get or create a simple topic from the latest user message
      const latestUserContent = records
        .filter(
          (r) => r.channel_arn === channelArn && !r.is_bot && r.content
        )
        .pop()?.content;

      if (!latestUserContent) continue;

      // Simple topic extraction -- truncate to a reasonable summary
      const topic =
        latestUserContent.length > 100
          ? latestUserContent.substring(0, 100) + '...'
          : latestUserContent;

      await updateConversationContext(
        userSub,
        channelArn,
        topic,
        latestUserContent.substring(0, 500)
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

    const userSub = target_arn.split('/user/')[1];
    if (!userSub) continue;

    try {
      if (event_type === 'CREATE_CHANNEL_MEMBERSHIP') {
        await query(
          `INSERT INTO channel_membership (channel_arn, user_sub, membership_role)
           VALUES ($1, $2, 'member')
           ON CONFLICT (channel_arn, user_sub) DO UPDATE SET updated_at = NOW()`,
          [channel_arn, userSub]
        );
        synced++;
      } else if (event_type === 'DELETE_CHANNEL_MEMBERSHIP') {
        await query(
          `DELETE FROM channel_membership WHERE channel_arn = $1 AND user_sub = $2`,
          [channel_arn, userSub]
        );
        synced++;
      } else if (event_type === 'UPDATE_CHANNEL_MEMBERSHIP') {
        await query(
          `UPDATE channel_membership SET updated_at = NOW()
           WHERE channel_arn = $1 AND user_sub = $2`,
          [channel_arn, userSub]
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
}

/**
 * Sync CREATE_CHANNEL events to channel_registry table
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
      let channelType = 'conversation';
      const isPrimary = false;

      // Classify channel type from metadata
      if (meta.channelType) {
        channelType = meta.channelType;
      } else if (meta.contextType === 'guest') {
        channelType = 'guest';
      }

      const channelName = record.content || meta.channelName || null;

      await query(
        `INSERT INTO channel_registry (channel_arn, channel_type, is_primary, channel_name, created_via)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_arn) DO UPDATE SET
           channel_type = EXCLUDED.channel_type,
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
    console.log(`Synced ${synced} channel creation events`);
  }
}
