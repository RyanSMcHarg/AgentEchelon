import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ChimeSDKMessagingClient, DescribeChannelMembershipCommand } from '@aws-sdk/client-chime-sdk-messaging';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { parseJsonBody, callerIsAdmin, callerPersonId, isAdminConsoleSession, signedAsPerson, isServiceAdminCall } from './lib/auth.js';
import { userArnFor } from './lib/person-arn.js';
import { responder, originsFrom, DEV_ORIGIN } from './lib/http-response.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const APP_INSTANCE_ARN_FB = process.env.APP_INSTANCE_ARN || '';
const messagingClientFb = chimeMessagingClient({});

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Why a person said a response needed work. CLOSED, and validated here rather than trusted from the
 * client, because the whole value of the field is that it groups: these are the three axes
 * effectiveness is judged on (routing, answer quality, having to re-ask), so an unrecognized value
 * is dropped to null instead of being stored and quietly splitting a rollup.
 *
 * Mirrors `FeedbackReason` in `frontend/packages/shared/src/services/feedbackService.ts`.
 */
const FEEDBACK_REASONS = ['wrong_assistant', 'poor_answer', 'asked_again'] as const;
type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

function normalizeReason(raw: unknown): FeedbackReason | null {
  return typeof raw === 'string' && (FEEDBACK_REASONS as readonly string[]).includes(raw)
    ? (raw as FeedbackReason)
    : null;
}

const FEEDBACK_TABLE = process.env.FEEDBACK_TABLE || '';
const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN);

const http = responder({ origin: { allow: ALLOWED_ORIGINS }, methods: 'GET,POST,OPTIONS' });

function isAllowedOrigin(origin?: string): boolean {
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

const respond = http.respond;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === 'OPTIONS') {
    return respond(200, {}, origin);
  }
  if (!isAllowedOrigin(origin)) {
    return respond(403, { error: 'Origin not allowed' }, origin);
  }

  try {
    if (event.httpMethod === 'POST') {
      return submitFeedback(event, origin);
    }
    if (event.httpMethod === 'GET') {
      // Admin summary: an AWS_IAM catalog route (`view-analytics`), so the gateway has already
      // refused a principal that does not hold it. `callerIsAdmin` trusts that signed principal
      // because the stack sets ADMIN_IAM_ENFORCEMENT on this function. The handler then refuses on its
      // own as well (tenet D3): the summary counts every assistant together and has no team route, so
      // only an ADMIN console session is admitted, or, under `adminAuthMode=service`, the deployer's
      // trusted proxy (a signed principal that names no person). A team console session, an
      // Identity-Pool principal and any other signed principal get 403 here even if a gateway grant
      // admits them.
      const adminSession = isAdminConsoleSession(event)
        || (isServiceAdminCall(event) && !signedAsPerson(event));
      if (!callerIsAdmin(event) || !adminSession) {
        return respond(403, { error: 'Admin access required' }, origin);
      }
      return summarizeFeedback(event, origin);
    }

    return respond(405, { error: 'Method not allowed' }, origin);
  } catch (error) {
    // Don't echo raw error.message to client (leaks AWS SDK class names,
    // request IDs, table names). Log server-side.
    console.error('[UserFeedback] Error:', error);
    return respond(500, { error: 'Internal error' }, origin);
  }
};

async function submitFeedback(event: APIGatewayProxyEvent, origin?: string): Promise<APIGatewayProxyResult> {
  const userSub = await callerPersonId(event);
  if (!userSub) {
    return respond(400, { error: 'Unable to determine user' }, origin);
  }

  // 400 on malformed JSON instead of 500.
  const parsed = parseJsonBody<{
    messageId?: string;
    channelArn?: string;
    feedback?: string;
    modelId?: string;
    intent?: string;
    reason?: string;
    note?: string;
    // Feedback join: the experiment + variant this message was served by (from
    // the bot message's analytics metadata),
    // so thumbs aggregate per variant alongside the evaluator score.
    // assignmentMode lets the rollup exclude battle traffic by default.
    experimentId?: string;
    variantId?: string;
    assignmentMode?: string;
  }>(event, origin);
  if ('statusCode' in parsed) return parsed;
  const body = parsed.body;
  if (!body.messageId || !body.channelArn || !body.feedback) {
    return respond(400, { error: 'messageId, channelArn, and feedback are required' }, origin);
  }
  if (body.feedback !== 'up' && body.feedback !== 'down' && body.feedback !== 'clear') {
    return respond(400, { error: 'feedback must be "up", "down", or "clear"' }, origin);
  }

  // Verify caller is a member of channelArn before recording feedback.
  // Without this, a signed-in
  // user can ballot-stuff thumbs-up/down on any other channel's bot
  // responses, skewing model-effectiveness analytics. Use the caller's
  // own AppInstanceUser ARN as ChimeBearer — Chime allows a user to
  // call DescribeChannelMembership for their own membership without
  // needing admin/moderator privilege.
  if (APP_INSTANCE_ARN_FB) {
    const callerUserArn = userArnFor(APP_INSTANCE_ARN_FB, userSub);
    try {
      await messagingClientFb.send(new DescribeChannelMembershipCommand({
        ChannelArn: body.channelArn,
        MemberArn: callerUserArn,
        ChimeBearer: callerUserArn,
      }));
    } catch (membershipErr) {
      console.warn('[user-feedback] caller not a member of channel', {
        userSub, channelArn: body.channelArn, err: (membershipErr as Error).name,
      });
      return respond(403, {
        error: 'Caller is not a member of the conversation',
        code: 'NOT_A_MEMBER',
      }, origin);
    }
  }

  // APPEND every vote — including a change (up→down) or a CLEAR (feedback:'clear')
  // — so the full decision trail (indecision) is preserved for audit. Only the
  // LATEST vote per (user, message) is COUNTED in the rollup (see
  // summarizeFeedback + the Aurora feedback join), so a re-vote replaces and a
  // 'clear' un-counts without erasing history.
  const record = {
    feedbackId: randomUUID(),
    createdAt: new Date().toISOString(),
    userSub,
    channelArn: body.channelArn,
    messageId: body.messageId,
    feedback: body.feedback, // 'up' | 'down' | 'clear'
    // Only a 'down' can carry a reason: there is nothing to attribute about approval, and a reason
    // riding an 'up' or a 'clear' would be a leftover from the picker the previous vote opened.
    reason: body.feedback === 'down' ? normalizeReason(body.reason) : null,
    modelId: body.modelId || null,
    intent: body.intent || null,
    note: body.note || null,
    // Feedback join — null when the message wasn't served by an experiment
    // (the common case).
    experimentId: body.experimentId || null,
    variantId: body.variantId || null,
    assignmentMode: body.assignmentMode || null,
  };

  await ddb.send(new PutCommand({
    TableName: FEEDBACK_TABLE,
    Item: record,
  }));

  return respond(200, { success: true, feedbackId: record.feedbackId, feedback: body.feedback }, origin);
}

async function summarizeFeedback(event: APIGatewayProxyEvent, origin?: string): Promise<APIGatewayProxyResult> {
  // A window the caller cannot have meant is refused rather than read as some other window: a
  // non-numeric `days` would otherwise become NaN and silently count nothing.
  const rawDays = event.queryStringParameters?.days ?? '30';
  const days = Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > 180) {
    return respond(400, { error: 'days must be a whole number from 1 to 180' }, origin);
  }
  const since = Date.now() - (days * 24 * 60 * 60 * 1000);

  // EVERY PAGE. One Scan returns at most 1 MB, so a single call undercounts as soon as the table
  // outgrows it, and the summary would still look complete.
  // LIMIT: every call reads the whole table inside the function's 15 s timeout, so a very large
  // table times out with a 502 rather than returning an undercount.
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: FEEDBACK_TABLE,
      ProjectionExpression: 'userSub, messageId, modelId, intent, feedback, createdAt',
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }));
    items.push(...(page.Items || []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  // Count only the LATEST vote per (user, message): the store appends every vote
  // (change/clear included) for the audit trail, but a message reflects a user's
  // CURRENT sentiment — superseded up/down votes and 'clear' must not be counted.
  const latest = new Map<string, { ts: number; feedback: string; modelId: string; intent: string }>();
  for (const item of items) {
    const ts = Date.parse(String(item.createdAt || ''));
    if (!Number.isFinite(ts)) continue;
    const key = `${String(item.userSub || '')}#${String(item.messageId || '')}`;
    const prev = latest.get(key);
    if (!prev || ts > prev.ts) {
      latest.set(key, { ts, feedback: String(item.feedback || ''), modelId: String(item.modelId || 'unknown'), intent: String(item.intent || 'unknown') });
    }
  }

  const byModelIntent = new Map<string, {
    model_name: string;
    intent: string;
    thumbs_up: number;
    thumbs_down: number;
    feedback_count: number;
  }>();

  for (const v of latest.values()) {
    if (v.ts < since) continue;                       // outside the window
    if (v.feedback !== 'up' && v.feedback !== 'down') continue; // 'clear' un-counts
    const key = `${v.modelId}::${v.intent}`;
    const current = byModelIntent.get(key) || {
      model_name: v.modelId,
      intent: v.intent,
      thumbs_up: 0,
      thumbs_down: 0,
      feedback_count: 0,
    };
    if (v.feedback === 'up') current.thumbs_up += 1;
    if (v.feedback === 'down') current.thumbs_down += 1;
    current.feedback_count += 1;
    byModelIntent.set(key, current);
  }

  const data = Array.from(byModelIntent.values()).map((row) => ({
    ...row,
    approval_rate: row.feedback_count > 0
      ? Number(((row.thumbs_up / row.feedback_count) * 100).toFixed(1))
      : 0,
  }));

  return respond(200, { data }, origin);
}
