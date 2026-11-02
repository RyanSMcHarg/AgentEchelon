/**
 * Membership Audit admin API (SPEC-CONVERSATION-SECURITY Layer 6, review surface).
 *
 * Admin-authed endpoints backing the dashboard's flagged-memberships panel:
 *   GET  /membership-audit/findings  -> list recent findings (newest first)
 *   GET  /membership-audit/enforce   -> { enabled }  (the runtime report-only <-> auto-revoke toggle)
 *   POST /membership-audit/enforce   -> set { enabled }
 *   POST /membership-audit/revoke    -> { channelArn, memberArn, sk? } revoke + mark the finding
 *
 * Non-VPC: only DynamoDB + Chime + SSM. Findings and the `config/enforce` toggle live in the
 * `AUDIT_TABLE` created by the MembershipAuditConstruct. The Cognito admin authorizer on the API
 * gates access; this handler reads the caller's `sub` only for the audit trail.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ChimeSDKMessagingClient, DeleteChannelMembershipCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { requireAdmin } from './lib/auth.js';
import { responder, originsFrom } from './lib/http-response.js';
import { chimeMessagingClient, appInstanceAdminBearer } from './lib/chime/clients.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AUDIT_TABLE = process.env.AUDIT_TABLE || '';
const ADMIN_ARN_PARAM = process.env.ADMIN_ARN_PARAM || '/agent-echelon/app-instance-admin-arn';
const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGINS, '', { trim: true, dropEmpty: true });

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));
const chime = chimeMessagingClient({ region: AWS_REGION });
const ssm = new SSMClient({ region: AWS_REGION });

const http = responder({ origin: { allow: ALLOWED_ORIGINS, fallback: '*' }, methods: 'GET,POST,OPTIONS' });
const respond = http.respond;

const getAdminArn = appInstanceAdminBearer({ ssm, param: ADMIN_ARN_PARAM, onFailure: 'throw' });

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const origin = (event.headers?.origin || event.headers?.Origin) as string | undefined;
  const method = event.httpMethod;
  const path = event.path || '';

  if (method === 'OPTIONS') return respond(200, {}, origin);
  if (!AUDIT_TABLE) return respond(503, { error: 'Membership audit is not enabled on this deployment' }, origin);

  // Enforce admin authority via the project's mode-aware check (Cognito `admins` group /
  // ADMIN_GROUP_NAMES / a federated host pool / an IAM-signed service call). The API-Gateway
  // authorizer only authenticates; this is what gates on admin. Do NOT rely on the authorizer alone.
  const auth = await requireAdmin(event);
  if ('statusCode' in auth) return { ...auth, headers: { ...auth.headers, ...http.headers(origin) } };
  const adminSub = auth.claims.actor;

  try {
    if (method === 'GET' && path.endsWith('/findings')) {
      const r = await ddb.send(new QueryCommand({
        TableName: AUDIT_TABLE,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': 'finding' },
        ScanIndexForward: false, // newest first
        Limit: 100,
      }));
      return respond(200, { findings: r.Items || [] }, origin);
    }

    if (path.endsWith('/enforce')) {
      if (method === 'GET') {
        const r = await ddb.send(new GetCommand({ TableName: AUDIT_TABLE, Key: { pk: 'config', sk: 'enforce' } }));
        return respond(200, { enabled: r.Item?.value === 'true' }, origin);
      }
      if (method === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const enabled = body.enabled === true || body.enabled === 'true';
        await ddb.send(new PutCommand({
          TableName: AUDIT_TABLE,
          Item: { pk: 'config', sk: 'enforce', value: enabled ? 'true' : 'false', updatedBy: adminSub, updatedAt: new Date().toISOString() },
        }));
        console.log(JSON.stringify({ _auditEvent: 'membership_audit_set_enforce', timestamp: new Date().toISOString(), adminSub, enabled }));
        return respond(200, { enabled }, origin);
      }
    }

    if (method === 'POST' && path.endsWith('/revoke')) {
      const body = JSON.parse(event.body || '{}');
      const channelArn = String(body.channelArn || '');
      const memberArn = String(body.memberArn || '');
      const sk = body.sk ? String(body.sk) : '';
      if (!channelArn || !memberArn) return respond(400, { error: 'channelArn and memberArn required' }, origin);
      const adminArn = await getAdminArn();
      if (!adminArn) return respond(500, { error: 'App-instance admin not configured' }, origin);
      try {
        await chime.send(new DeleteChannelMembershipCommand({ ChannelArn: channelArn, MemberArn: memberArn, ChimeBearer: adminArn }));
      } catch (err: unknown) {
        const name = (err as { name?: string })?.name;
        if (name !== 'NotFoundException' && name !== 'ConflictException') throw err; // idempotent
      }
      if (sk) {
        await ddb
          .send(new UpdateCommand({
            TableName: AUDIT_TABLE,
            Key: { pk: 'finding', sk },
            UpdateExpression: 'SET #s = :s, reviewedBy = :b, reviewedAt = :t',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':s': 'revoked', ':b': adminSub, ':t': new Date().toISOString() },
          }))
          .catch((e) => console.warn('[MembershipAuditAdmin] failed to mark finding:', e));
      }
      console.log(JSON.stringify({ _auditEvent: 'membership_audit_revoke', timestamp: new Date().toISOString(), adminSub, channelArn, memberArn }));
      return respond(200, { success: true, action: 'revoked' }, origin);
    }

    return respond(404, { error: 'Not found' }, origin);
  } catch (err) {
    console.error('[MembershipAuditAdmin] error:', err);
    return respond(500, { error: 'Internal error' }, origin);
  }
}
