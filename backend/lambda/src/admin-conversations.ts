/**
 * Admin Conversations API — backs the admin dashboard Conversations tab
 * (level-3 moderation; see docs/SPEC-MODERATION.md).
 *
 * This handler is READ-ONLY over the ANALYTICS ARCHIVE (Athena over the
 * `conversations` Glue table; the system of record for history). No single bot
 * sees every channel, so live Chime is the wrong source for cross-conversation
 * review. It holds NO Chime bearer.
 *
 * Every live-Chime ACTION (listing members, add-self / add-member, redact,
 * delete) runs CLIENT-SIDE as the admin's OWN `${sub}-admin` identity, vended
 * per-channel by the Credential-Exchange (docs/SPEC-ADMIN-IDENTITY.md,
 * `chimeService.ts`). No server-side component wields a bearer on the admin's
 * behalf.
 *
 * Two read backends by analytics mode: Athena over the `conversations` Glue table
 * (default), OR — in Aurora mode — Aurora Postgres via the VPC data-plane Lambda
 * (BUG #21: the Athena archive query takes 15-27s and 502s past API Gateway's 29s
 * cap; Aurora answers the same views sub-second). The data-plane ARN is resolved
 * from SSM at cold start (a direct CDK prop would be circular).
 */
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { callerIsAdmin, callerCanReadArchive, isAdminIamEnforcedCall, iamCallerSub } from './lib/auth.js';
import { resolveCallerCeiling, classificationAllowed, type ClassificationCeiling } from './lib/caller-scope.js';
// Aurora-mode read path: when the data-plane ARN is wired (analyticsMode=aurora),
// read conversations from Aurora via the VPC data-plane Lambda instead of Athena
// (the Athena archive query is too slow — 15-27s > API Gateway's 29s cap — and
// 502s the Conversations tab). See BUG #21.
import {
  hasDataPlane,
  adminListConversations as auroraListConversations,
  adminListMessages as auroraListMessages,
  adminMembershipHistory as auroraMembershipHistory,
} from './lib/data-plane-client.js';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const athena = new AthenaClient({});
const ssm = new SSMClient({});

// The data-plane ARN can't be passed from the Aurora stack via CDK props — the
// Aurora stack already depends on this (CognitoAuth) stack (userPool/feedback
// table), so a reverse prop would be circular. Instead the Aurora stack publishes
// the ARN to SSM and we resolve it once at cold start, writing it into the env
// the data-plane client reads. Absent param (Athena mode) => Athena fallback.
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
    // Param absent (Athena mode) or unreadable → stay on the Athena path.
  }
  dataPlaneResolved = true;
}

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
// A14 Scoped: the pool the caller's classification ceiling is resolved against
// (same stack, so this is always set on the admin-conversations Lambda).
const USER_POOL_ID = process.env.USER_POOL_ID || '';
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP || 'agent-echelon-analytics';
const ATHENA_DATABASE = process.env.ATHENA_DATABASE || 'agent_echelon';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173').split(',');

function corsHeaders(origin?: string) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Vary': 'Origin',
  };
}

function isAllowedOrigin(origin?: string): boolean {
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

function respond(statusCode: number, body: unknown, origin?: string): APIGatewayProxyResult {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

function requireAdmin(event: APIGatewayProxyEvent): string | null {
  // Shared, IdP-agnostic admin gate (honors ADMIN_GROUP_NAMES + service mode).
  // Behaves exactly like the legacy `groups.includes('admins')` under the
  // default ae-cognito mode.
  return callerIsAdmin(event) ? null : 'Admin access required';
}

function isValidChannelArn(channelArn: string): boolean {
  if (!channelArn.startsWith(`${APP_INSTANCE_ARN}/channel/`)) return false;
  const channelId = channelArn.slice(`${APP_INSTANCE_ARN}/channel/`.length);
  return /^[a-zA-Z0-9-]+$/.test(channelId);
}

function safeJsonParse(value?: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Unwrap a Lex fulfillment envelope (welcome) so the admin view never shows raw
// JSON. The archived Payload carries no ContentType, so detect the envelope
// STRUCTURALLY (a top-level object whose only meaningful key is a Messages array
// of {Content,...}). A coding answer is prose+fenced code, never a bare
// top-level Lex envelope — so this won't eat code-block JSON.
function unwrapArchivedLex(content: string): string {
  if (!content.startsWith('{') || !content.includes('"Messages"')) return content;
  try {
    const parsed = JSON.parse(content);
    if (
      parsed &&
      Array.isArray(parsed.Messages) &&
      parsed.Messages.length > 0 &&
      typeof parsed.Messages[0]?.Content === 'string' &&
      Object.keys(parsed).length === 1
    ) {
      return parsed.Messages[0].Content;
    }
  } catch {
    /* not an envelope */
  }
  return content;
}

// ── Athena (archive) ───────────────────────────────────────────────────────
async function runAthena(query: string): Promise<{ columns: string[]; rows: string[][] }> {
  const start = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: query,
      WorkGroup: ATHENA_WORKGROUP,
      QueryExecutionContext: { Database: ATHENA_DATABASE },
    }),
  );
  const qid = start.QueryExecutionId!;
  // Poll for completion (admin tab tolerates a few seconds).
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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === 'OPTIONS') return respond(200, {}, origin);
  if (!isAllowedOrigin(origin)) return respond(403, { error: 'Origin not allowed' }, origin);
  const authError = requireAdmin(event);
  if (authError) return respond(403, { error: authError }, origin);
  // Every endpoint here reads conversation ARCHIVE content, a SEPARABLE authorization from base
  // admin so a future role can be denied archive access. Interim group gate (callerCanReadArchive,
  // default = the admin groups); the IAM-enforceable capability is the tracked follow-up.
  if (!callerCanReadArchive(event)) {
    return respond(403, { error: 'Archive-view permission required' }, origin);
  }

  // Resolve the Aurora data-plane ARN (once) before the read functions branch.
  await ensureDataPlaneArn();

  // A14 Scoped: under IAM enforcement, narrow the reads to the caller's
  // classification ceiling (resolved from the verified sub). Full (null) on a
  // Cognito-JWT call or a full-access caller (admins / platform-admins), so the
  // default path is unchanged.
  let ceiling: ClassificationCeiling = null;
  if (isAdminIamEnforcedCall(event) && USER_POOL_ID) {
    const sub = iamCallerSub(event);
    if (sub) ceiling = await resolveCallerCeiling(sub, USER_POOL_ID);
  }

  try {
    const path = event.path;
    const method = event.httpMethod;

    if (method === 'GET' && path.endsWith('/conversations')) return listConversations(event, origin, ceiling);
    if (method === 'GET' && path.endsWith('/messages')) return listMessages(event, origin, ceiling);
    if (method === 'GET' && path.endsWith('/membership-history')) return membershipHistory(event, origin, ceiling);

    return respond(404, { error: 'Not found' }, origin);
  } catch (error) {
    console.error('[AdminConversations] Error:', error);
    return respond(500, { error: (error as Error).message }, origin);
  }
};

// ── VIEW: read the archive (Athena) ──────────────────────────────────────────

async function listConversations(event: APIGatewayProxyEvent, origin?: string, ceiling: ClassificationCeiling = null): Promise<APIGatewayProxyResult> {
  const limit = Math.min(Number(event.queryStringParameters?.limit || '50'), 200);
  // A14 Scoped: keep only conversations at/below the caller's classification ceiling.
  const scope = (list: AdminConversationSummaryLike[]) =>
    ceiling === null ? list : list.filter((c) => classificationAllowed(c?.metadata?.modelTier, ceiling));
  // Aurora mode: read from Aurora via the data-plane Lambda (sub-second) instead
  // of the slow Athena archive (see BUG #21).
  if (hasDataPlane()) {
    try {
      return respond(200, { conversations: scope(await auroraListConversations(limit)) }, origin);
    } catch (err) {
      console.error('[AdminConversations] Aurora list failed:', err);
      return respond(200, { conversations: [], archiveError: (err as Error).message }, origin);
    }
  }
  // One pass over the archive: group by channel. Channel events carry Name;
  // message events carry MessageId/CreatedTimestamp. `user_type` is the S3
  // partition (= classification). MAX() picks the non-null Name across the group.
  const query = `
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
      MAX(json_extract_scalar(line, '$.Payload.CreatedTimestamp')) AS last_message_at
    FROM conversations
    WHERE json_extract_scalar(line, '$.Payload.ChannelArn') IS NOT NULL
    GROUP BY json_extract_scalar(line, '$.Payload.ChannelArn')
    ORDER BY last_message_at DESC
    LIMIT ${limit}
  `;
  let result;
  try {
    result = await runAthena(query);
  } catch (err) {
    console.error('[AdminConversations] archive query failed:', err);
    return respond(200, { conversations: [], archiveError: (err as Error).message }, origin);
  }
  const idx = (name: string) => result.columns.indexOf(name);
  const conversations = result.rows.map((r) => {
    const classification = r[idx('classification')] || '';
    return {
      channelArn: r[idx('channel_arn')] || '',
      name: r[idx('name')] || 'Untitled Conversation',
      messageCount: Number(r[idx('message_count')] || 0),
      lastMessageAt: r[idx('last_message_at')] || undefined,
      memberCount: 0, // populated on demand via the client-side admin member list
      // Frontend (AdminConversationSummary) reads the classification from metadata.modelTier.
      metadata: { modelTier: classification },
    };
  }).filter((c) => c.channelArn);

  return respond(200, { conversations: scope(conversations) }, origin);
}

// Minimal shape the classification scope reads (both the Aurora data-plane summary
// and the Athena-built summary carry metadata.modelTier = the channel classification).
type AdminConversationSummaryLike = { metadata?: { modelTier?: string } };

// A14 Scoped guard for a SINGLE channel (messages / membership-history take a
// channelArn directly, so the caller could replay an ARN outside their scoped
// list). Resolve the channel's classification and deny if it exceeds the ceiling.
// Fail-CLOSED: if the classification cannot be determined, deny.
async function channelClassificationAllowed(channelArn: string, ceiling: ClassificationCeiling): Promise<boolean> {
  if (ceiling === null) return true; // Full
  let cls: string | undefined;
  if (hasDataPlane()) {
    try {
      const list = await auroraListConversations(500);
      cls = (list as Array<{ channelArn?: string; metadata?: { modelTier?: string } }>)
        .find((c) => c.channelArn === channelArn)?.metadata?.modelTier;
    } catch { cls = undefined; }
  } else {
    const safeArn = channelArn.replace(/'/g, "''");
    try {
      const r = await runAthena(
        `SELECT arbitrary(user_type) AS classification FROM conversations
         WHERE json_extract_scalar(line, '$.Payload.ChannelArn') = '${safeArn}' LIMIT 1`,
      );
      cls = r.rows[0]?.[r.columns.indexOf('classification')];
    } catch { cls = undefined; }
  }
  if (cls === undefined) return false; // cannot determine -> fail closed
  return classificationAllowed(cls, ceiling);
}

async function listMessages(event: APIGatewayProxyEvent, origin?: string, ceiling: ClassificationCeiling = null): Promise<APIGatewayProxyResult> {
  const channelArn = event.queryStringParameters?.channelArn || '';
  if (!channelArn || !isValidChannelArn(channelArn)) {
    return respond(400, { error: 'Valid channelArn query parameter required' }, origin);
  }
  if (!(await channelClassificationAllowed(channelArn, ceiling))) {
    return respond(403, { error: 'Conversation is outside your classification scope' }, origin);
  }
  // Aurora mode: fast Aurora read via the data-plane (BUG #21).
  if (hasDataPlane()) {
    try {
      return respond(200, { messages: await auroraListMessages(channelArn) }, origin);
    } catch (err) {
      console.error('[AdminConversations] Aurora messages failed:', err);
      return respond(200, { messages: [], archiveError: (err as Error).message }, origin);
    }
  }
  // Pull this channel's message events from the archive. A message can appear as
  // CREATE then UPDATE (placeholder → answer); keep the LATEST per MessageId.
  const safeArn = channelArn.replace(/'/g, "''");
  const query = `
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
    WHERE json_extract_scalar(line, '$.Payload.ChannelArn') = '${safeArn}'
      AND json_extract_scalar(line, '$.Payload.MessageId') IS NOT NULL
    ORDER BY created_at ASC
  `;
  let result;
  try {
    result = await runAthena(query);
  } catch (err) {
    console.error('[AdminConversations] archive messages query failed:', err);
    return respond(200, { messages: [], archiveError: (err as Error).message }, origin);
  }
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

  const messages = [...latest.values()]
    .map((r) => {
      const metadata = safeJsonParse(r[idx('metadata')]);
      const rawContent = r[idx('content')] || '';
      const senderArn = r[idx('sender_arn')] || '';
      // Full archived message Payload for the inspect/"info" panel — every
      // field as stored (Type, Persistence, MessageAttributes incl CHIME.LEX.*,
      // timestamps, raw Metadata). The faithful record is the point of inspect.
      let raw: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(r[idx('raw_line')] || '{}');
        raw = (parsed?.Payload as Record<string, unknown>) || undefined;
      } catch {
        raw = undefined;
      }
      return {
        id: r[idx('message_id')] || '',
        // Archived Content is URI-encoded; unwrap the Lex envelope (welcome) first.
        content: safeDecode(unwrapArchivedLex(rawContent)),
        senderArn,
        senderName: r[idx('sender_name')] || 'Unknown',
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

  return respond(200, { messages }, origin);
}

// Membership HISTORY (audit) — joins/leaves/moderator grants from the ARCHIVE.
// Chime has no membership-history API; the archive captures CREATE/DELETE
// channel-membership + moderator events, so this is the system of record for
// "who joined/left when". Required for audits.
async function membershipHistory(event: APIGatewayProxyEvent, origin?: string, ceiling: ClassificationCeiling = null): Promise<APIGatewayProxyResult> {
  const channelArn = event.queryStringParameters?.channelArn || '';
  if (!channelArn || !isValidChannelArn(channelArn)) {
    return respond(400, { error: 'Valid channelArn query parameter required' }, origin);
  }
  if (!(await channelClassificationAllowed(channelArn, ceiling))) {
    return respond(403, { error: 'Conversation is outside your classification scope' }, origin);
  }
  // Aurora mode: fast Aurora read via the data-plane (BUG #21).
  if (hasDataPlane()) {
    try {
      return respond(200, { history: await auroraMembershipHistory(channelArn) }, origin);
    } catch (err) {
      console.error('[AdminConversations] Aurora membership history failed:', err);
      return respond(200, { history: [], archiveError: (err as Error).message }, origin);
    }
  }
  const safeArn = channelArn.replace(/'/g, "''");
  const query = `
    SELECT
      json_extract_scalar(line, '$.EventType') AS event_type,
      json_extract_scalar(line, '$.Payload.Member.Arn') AS member_arn,
      json_extract_scalar(line, '$.Payload.Member.Name') AS member_name,
      json_extract_scalar(line, '$.Payload.InvitedBy.Name') AS invited_by,
      COALESCE(json_extract_scalar(line, '$.Payload.CreatedTimestamp'),
               json_extract_scalar(line, '$.Payload.LastUpdatedTimestamp')) AS at
    FROM conversations
    WHERE json_extract_scalar(line, '$.Payload.ChannelArn') = '${safeArn}'
      AND json_extract_scalar(line, '$.EventType') IN (
        'CREATE_CHANNEL_MEMBERSHIP', 'DELETE_CHANNEL_MEMBERSHIP',
        'CREATE_CHANNEL_MODERATOR', 'DELETE_CHANNEL_MODERATOR'
      )
    ORDER BY at ASC
  `;
  let result;
  try {
    result = await runAthena(query);
  } catch (err) {
    console.error('[AdminConversations] membership-history query failed:', err);
    return respond(200, { history: [], archiveError: (err as Error).message }, origin);
  }
  const idx = (name: string) => result.columns.indexOf(name);
  const ACTION: Record<string, string> = {
    CREATE_CHANNEL_MEMBERSHIP: 'joined',
    DELETE_CHANNEL_MEMBERSHIP: 'left',
    CREATE_CHANNEL_MODERATOR: 'granted_moderator',
    DELETE_CHANNEL_MODERATOR: 'revoked_moderator',
  };
  const history = result.rows.map((r) => {
    const memberArn = r[idx('member_arn')] || '';
    return {
      action: ACTION[r[idx('event_type')] || ''] || r[idx('event_type')] || '',
      memberArn,
      memberName: r[idx('member_name')] || 'Unknown',
      invitedBy: r[idx('invited_by')] || undefined,
      timestamp: r[idx('at')] || '',
      isBot: memberArn.includes('/bot/'),
    };
  });
  return respond(200, { history }, origin);
}
