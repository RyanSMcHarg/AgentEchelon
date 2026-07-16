import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ChimeSDKMessagingClient, DescribeChannelMembershipCommand } from '@aws-sdk/client-chime-sdk-messaging';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { parseJsonBody, callerIsAdmin } from './lib/auth.js';

const APP_INSTANCE_ARN_FB = process.env.APP_INSTANCE_ARN || '';
const messagingClientFb = new ChimeSDKMessagingClient({});

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const FEEDBACK_TABLE = process.env.FEEDBACK_TABLE || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173').split(',');

function corsHeaders(origin?: string) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Vary': 'Origin',
  };
}

function isAllowedOrigin(origin?: string): boolean {
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

function respond(statusCode: number, body: unknown, origin?: string): APIGatewayProxyResult {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
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
      // Admin summary. Gate via the mode-aware check (Cognito `admins` group /
      // ADMIN_GROUP_NAMES / federated host pool / IAM service caller), not a
      // hardcoded group on raw claims.
      if (!callerIsAdmin(event)) {
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
  const claims = event.requestContext.authorizer?.claims || {};
  const userSub = claims.sub;
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
    const callerUserArn = `${APP_INSTANCE_ARN_FB}/user/${userSub}`;
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
  const days = Math.min(Number(event.queryStringParameters?.days || '30'), 180);
  const since = Date.now() - (days * 24 * 60 * 60 * 1000);

  const result = await ddb.send(new ScanCommand({
    TableName: FEEDBACK_TABLE,
    ProjectionExpression: 'userSub, messageId, modelId, intent, feedback, createdAt',
  }));

  // Count only the LATEST vote per (user, message): the store appends every vote
  // (change/clear included) for the audit trail, but a message reflects a user's
  // CURRENT sentiment — superseded up/down votes and 'clear' must not be counted.
  const latest = new Map<string, { ts: number; feedback: string; modelId: string; intent: string }>();
  for (const item of result.Items || []) {
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
