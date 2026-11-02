/**
 * THE CONVERSATION ARCHIVE, READ THROUGH ONE SEAM.
 *
 * The admin console reads conversation history from one of two backends, by analytics mode:
 *
 *  - the data plane: Aurora Postgres via the VPC data-plane Lambda (`analyticsMode=aurora`), which
 *    answers sub-second, and
 *  - Athena over the `conversations` Glue table, the archive's system of record, whose query takes
 *    15-27s (BUG #21).
 *
 * Both are supported variants. `archiveReader()` picks one per request and the handler only holds auth
 * and HTTP; it never asks which backend it is talking to, except through `projection`, which says
 * whether the reads that exist only on the Aurora projection (a team's period-bounded read and the
 * de-identified copy) are available.
 *
 * NAMES ARE INCLUDED in what these return. Stripping them is the handler's job (`withoutIdentity`),
 * because `participants` answers the separately granted identity route from the same rows.
 *
 * Each read PROPAGATES its error. The handler decides what an unreadable archive answers: an empty
 * list with `archiveError`, or a fail-closed scope check.
 */
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  hasDataPlane,
  adminListConversations,
  adminListMessages,
  adminMembershipHistory,
  adminCleanConversation,
} from './data-plane-client.js';
import type {
  AdminConvSummary,
  AdminConvMessage,
  AdminMembershipEvent,
} from '../analytics-aurora/admin-conversations-aurora.js';
import type { CleanConversation } from '../analytics-aurora/clean-copy.js';
import { unwrapLexEnvelope } from './lex-envelope.js';
import { decodeContent } from './chime/history.js';

/** A conversation in the list. The Athena archive derives no lifecycle `state`. */
export type ArchiveConversation = Omit<AdminConvSummary, 'state'> & { state?: AdminConvSummary['state'] };

export interface ConversationListQuery {
  limit: number;
  offset: number;
  /** The classifications the caller may see, pushed into the query. Null is full access. */
  allowed: string[] | null;
  /** One conversation by its ARN (the lookup by id), under the same scope as the list. */
  only: string | null;
  /** A team's assistant identities: only conversations one of them was a member of. Projection only. */
  memberArns: string[] | null;
}

export interface ArchiveReader {
  /** Which backend answers, for log lines only. */
  readonly kind: 'aurora' | 'athena';
  /** True when the Aurora projection answers: a team-scoped read and the de-identified copy need it. */
  readonly projection: boolean;
  listConversations(q: ConversationListQuery): Promise<{ conversations: ArchiveConversation[]; total: number }>;
  /** The channel's classification, or undefined when the archive does not hold it. */
  channelClassification(channelArn: string): Promise<string | undefined>;
  /** Every message in the channel, oldest first, names included. */
  messages(channelArn: string): Promise<AdminConvMessage[]>;
  /** The membership timeline, oldest first, names included. */
  membership(channelArn: string): Promise<AdminMembershipEvent[]>;
  /** Every (ARN, name) pairing the archive holds for the channel, first one wins. */
  participants(channelArn: string): Promise<Array<{ arn?: string | null; name?: string | null }>>;
  /** The de-identified copy. Projection only. */
  cleanConversation(channelArn: string): Promise<CleanConversation>;
}

// ── Selection ─────────────────────────────────────────────────────────────────────────────────────

const ssm = new SSMClient({});

// The data-plane ARN cannot be passed from the Aurora stack through CDK props: the Aurora stack already
// depends on the stack this handler deploys in, so a reverse prop would be circular. The Aurora stack
// publishes the ARN to SSM and it is resolved once per container, into the env the data-plane client
// reads. An absent parameter (Athena mode) leaves the Athena reader selected.
let dataPlaneResolved = false;
async function ensureDataPlaneArn(): Promise<void> {
  if (dataPlaneResolved || process.env.AURORA_DATA_PLANE_ARN) {
    dataPlaneResolved = true;
    return;
  }
  const paramName = process.env.AURORA_DATA_PLANE_ARN_PARAM;
  if (!paramName) { dataPlaneResolved = true; return; }
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: paramName }));
    if (r.Parameter?.Value) process.env.AURORA_DATA_PLANE_ARN = r.Parameter.Value;
  } catch {
    // Parameter absent (Athena mode) or unreadable: stay on the Athena reader.
  }
  dataPlaneResolved = true;
}

/** The reader for this deployment's analytics mode, chosen once per request. */
export async function archiveReader(): Promise<ArchiveReader> {
  await ensureDataPlaneArn();
  return hasDataPlane() ? dataPlaneReader : athenaReader;
}

// ── Aurora, through the data plane ────────────────────────────────────────────────────────────────

const dataPlaneReader: ArchiveReader = {
  kind: 'aurora',
  projection: true,
  async listConversations(q) {
    return adminListConversations(q.limit, q.offset, q.allowed, q.only, q.memberArns);
  },
  async channelClassification(channelArn) {
    // KNOWN LIMITATION: the classification is resolved from the 500 most recent conversations. A
    // scoped (non-full) caller reading a channel older than that window resolves undefined and is
    // refused, even when the channel is within their classification scope: a fail-closed miss, never a
    // leak. If it bites, resolve the single channel's classification with a targeted data-plane lookup
    // instead of scanning the recent list.
    const { conversations } = await adminListConversations(500);
    return conversations.find((c) => c.channelArn === channelArn)?.metadata?.modelTier;
  },
  messages: (channelArn) => adminListMessages(channelArn),
  membership: (channelArn) => adminMembershipHistory(channelArn),
  async participants(channelArn) {
    // The membership timeline names every participant that ever joined, a superset of the senders still
    // present; the messages add any sender whose join predates the timeline.
    const out: Array<{ arn?: string | null; name?: string | null }> = [];
    for (const e of await adminMembershipHistory(channelArn)) out.push({ arn: e.memberArn, name: e.memberName });
    for (const m of await adminListMessages(channelArn)) out.push({ arn: m.senderArn, name: m.senderName });
    return out;
  },
  cleanConversation: (channelArn) => adminCleanConversation(channelArn),
};

// ── Athena, over the archive ──────────────────────────────────────────────────────────────────────

const athena = new AthenaClient({});
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP || 'agent-echelon-analytics';
const ATHENA_DATABASE = process.env.ATHENA_DATABASE || 'agent_echelon';

async function runAthena(query: string): Promise<{ columns: string[]; rows: string[][] }> {
  const start = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: query,
      WorkGroup: ATHENA_WORKGROUP,
      QueryExecutionContext: { Database: ATHENA_DATABASE },
    }),
  );
  const qid = start.QueryExecutionId!;
  // Poll for completion (the admin tab tolerates a few seconds).
  for (let i = 0; i < 30; i++) {
    const exec = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: qid }));
    const state = exec.QueryExecution?.Status?.State;
    if (state === QueryExecutionState.SUCCEEDED) break;
    if (state === QueryExecutionState.FAILED || state === QueryExecutionState.CANCELLED) {
      throw new Error(`Athena query ${state}: ${exec.QueryExecution?.Status?.StateChangeReason || ''}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const results = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: qid, MaxResults: 1000 }));
  const rawRows = results.ResultSet?.Rows || [];
  const columns = (rawRows[0]?.Data || []).map((c) => c.VarCharValue || '');
  const rows = rawRows.slice(1).map((r) => (r.Data || []).map((c) => c.VarCharValue ?? ''));
  return { columns, rows };
}

function safeJsonParse(value?: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

const quoted = (s: string) => s.replace(/'/g, "''");

const MEMBERSHIP_ACTION: Record<string, string> = {
  CREATE_CHANNEL_MEMBERSHIP: 'joined',
  DELETE_CHANNEL_MEMBERSHIP: 'left',
  CREATE_CHANNEL_MODERATOR: 'granted_moderator',
  DELETE_CHANNEL_MODERATOR: 'revoked_moderator',
};

/**
 * The archived membership rows for a channel, NAMES INCLUDED.
 *
 * Shared by the timeline, which the handler strips of names, and by `participants`, which keeps only the
 * names. One query rather than two, so the two answers cannot disagree about who was in a conversation.
 */
async function archiveMembershipRows(channelArn: string): Promise<AdminMembershipEvent[]> {
  const result = await runAthena(`
    SELECT
      json_extract_scalar(line, '$.EventType') AS event_type,
      json_extract_scalar(line, '$.Payload.Member.Arn') AS member_arn,
      json_extract_scalar(line, '$.Payload.Member.Name') AS member_name,
      json_extract_scalar(line, '$.Payload.InvitedBy.Name') AS invited_by,
      COALESCE(json_extract_scalar(line, '$.Payload.CreatedTimestamp'),
               json_extract_scalar(line, '$.Payload.LastUpdatedTimestamp')) AS at
    FROM conversations
    WHERE json_extract_scalar(line, '$.Payload.ChannelArn') = '${quoted(channelArn)}'
      AND json_extract_scalar(line, '$.EventType') IN (
        'CREATE_CHANNEL_MEMBERSHIP', 'DELETE_CHANNEL_MEMBERSHIP',
        'CREATE_CHANNEL_MODERATOR', 'DELETE_CHANNEL_MODERATOR'
      )
    ORDER BY at ASC
  `);
  const idx = (name: string) => result.columns.indexOf(name);
  return result.rows.map((r) => {
    const memberArn = r[idx('member_arn')] || '';
    return {
      action: MEMBERSHIP_ACTION[r[idx('event_type')] || ''] || r[idx('event_type')] || '',
      memberArn,
      memberName: r[idx('member_name')] || undefined,
      invitedBy: r[idx('invited_by')] || undefined,
      timestamp: r[idx('at')] || '',
      isBot: memberArn.includes('/bot/'),
    };
  });
}

const athenaReader: ArchiveReader = {
  kind: 'athena',
  projection: false,
  async listConversations(q) {
    // One pass over the archive: group by channel. Channel events carry Name; message events carry
    // MessageId/CreatedTimestamp. `user_type` is the S3 partition (the classification). The
    // classification scope goes into the SQL (values come from the profile registry, so this
    // interpolation is safe) so server-side OFFSET/LIMIT/total match what a scoped admin sees.
    const clsFilter = q.allowed ? `AND user_type IN (${q.allowed.map((c) => `'${c}'`).join(',')})` : '';
    const result = await runAthena(`
    SELECT
      json_extract_scalar(line, '$.Payload.ChannelArn') AS channel_arn,
      arbitrary(user_type) AS classification,
      -- Channels are created as "New conversation" then auto-titled via
      -- UPDATE_CHANNEL; take the name from the LATEST channel event (rows with a
      -- Name), not the alphabetical MAX.
      max_by(
        json_extract_scalar(line, '$.Payload.Name'),
        CASE WHEN json_extract_scalar(line, '$.Payload.Name') IS NOT NULL
             THEN COALESCE(json_extract_scalar(line, '$.Payload.LastUpdatedTimestamp'),
                           json_extract_scalar(line, '$.Payload.CreatedTimestamp'))
        END
      ) AS name,
      COUNT(json_extract_scalar(line, '$.Payload.MessageId')) AS message_count,
      MAX(json_extract_scalar(line, '$.Payload.CreatedTimestamp')) AS last_message_at,
      COUNT(*) OVER() AS total_count
    FROM conversations
    WHERE json_extract_scalar(line, '$.Payload.ChannelArn') IS NOT NULL ${clsFilter}
      ${q.only ? `AND json_extract_scalar(line, '$.Payload.ChannelArn') = '${quoted(q.only)}'` : ''}
    GROUP BY json_extract_scalar(line, '$.Payload.ChannelArn')
    ORDER BY last_message_at DESC
    OFFSET ${q.offset} LIMIT ${q.limit}
  `);
    const idx = (name: string) => result.columns.indexOf(name);
    const total = result.rows[0]?.[idx('total_count')] != null ? Number(result.rows[0][idx('total_count')]) : result.rows.length;
    const conversations = result.rows.map((r) => ({
      channelArn: r[idx('channel_arn')] || '',
      name: r[idx('name')] || 'Untitled Conversation',
      messageCount: Number(r[idx('message_count')] || 0),
      lastMessageAt: r[idx('last_message_at')] || undefined,
      memberCount: 0, // populated on demand via the client-side admin member list
      // The console (AdminConversationSummary) reads the classification from metadata.modelTier.
      metadata: { modelTier: r[idx('classification')] || '' },
    })).filter((c) => c.channelArn);
    return { conversations, total };
  },
  async channelClassification(channelArn) {
    const r = await runAthena(
      `SELECT arbitrary(user_type) AS classification FROM conversations
         WHERE json_extract_scalar(line, '$.Payload.ChannelArn') = '${quoted(channelArn)}' LIMIT 1`,
    );
    return r.rows[0]?.[r.columns.indexOf('classification')];
  },
  async messages(channelArn) {
    // This channel's message events. A message can appear as CREATE then UPDATE (placeholder, then
    // answer); the LATEST per MessageId is kept.
    const result = await runAthena(`
    SELECT
      json_extract_scalar(line, '$.Payload.MessageId') AS message_id,
      json_extract_scalar(line, '$.Payload.Content') AS content,
      json_extract_scalar(line, '$.Payload.Sender.Name') AS sender_name,
      json_extract_scalar(line, '$.Payload.Sender.Arn') AS sender_arn,
      json_extract_scalar(line, '$.Payload.CreatedTimestamp') AS created_at,
      json_extract_scalar(line, '$.Payload.LastUpdatedTimestamp') AS updated_at,
      json_extract_scalar(line, '$.Payload.Redacted') AS redacted,
      json_extract_scalar(line, '$.Payload.Metadata') AS metadata,
      line AS raw_line
    FROM conversations
    WHERE json_extract_scalar(line, '$.Payload.ChannelArn') = '${quoted(channelArn)}'
      AND json_extract_scalar(line, '$.Payload.MessageId') IS NOT NULL
    ORDER BY created_at ASC
  `);
    const idx = (name: string) => result.columns.indexOf(name);

    // Keep the latest row per MessageId (UPDATE supersedes CREATE).
    const latest = new Map<string, string[]>();
    for (const r of result.rows) {
      const id = r[idx('message_id')] || '';
      if (!id) continue;
      const prev = latest.get(id);
      const updated = r[idx('updated_at')] || r[idx('created_at')] || '';
      const prevUpdated = prev ? (prev[idx('updated_at')] || prev[idx('created_at')] || '') : '';
      if (!prev || updated >= prevUpdated) latest.set(id, r);
    }

    return [...latest.values()]
      .map((r): AdminConvMessage => {
        const metadata = safeJsonParse(r[idx('metadata')]);
        const rawContent = r[idx('content')] || '';
        const senderArn = r[idx('sender_arn')] || '';
        // The full archived message Payload for the inspect panel: every field as stored (Type,
        // Persistence, MessageAttributes including CHIME.LEX.*, timestamps, raw Metadata). The faithful
        // record is the point of inspect.
        let raw: Record<string, unknown> | undefined;
        try {
          const parsed = JSON.parse(r[idx('raw_line')] || '{}');
          raw = (parsed?.Payload as Record<string, unknown>) || undefined;
        } catch {
          raw = undefined;
        }
        return {
          id: r[idx('message_id')] || '',
          // Archived Content is URI-encoded; the Lex envelope (welcome) is unwrapped first. The archived
          // Payload carries no ContentType, so the envelope is detected structurally (`lex-envelope.ts`).
          content: decodeContent(unwrapLexEnvelope(rawContent)),
          senderArn,
          senderName: r[idx('sender_name')] || undefined,
          timestamp: r[idx('created_at')] || '',
          isBot: Boolean(metadata.botResponse) || senderArn.includes('/bot/'),
          redacted: r[idx('redacted')] === 'true',
          modelId: typeof metadata.bedrockModel === 'string' ? metadata.bedrockModel : undefined,
          intent: typeof metadata.intent === 'string' ? metadata.intent : undefined,
          metadata,
          raw,
        };
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  },
  membership: (channelArn) => archiveMembershipRows(channelArn),
  async participants(channelArn) {
    // The membership rows carry the pairing, read through the same query the timeline uses rather than
    // a second shape that could disagree with it.
    return (await archiveMembershipRows(channelArn)).map((e) => ({ arn: e.memberArn, name: e.memberName }));
  },
  async cleanConversation() {
    throw new Error('The de-identified copy needs Aurora analytics mode');
  },
};
