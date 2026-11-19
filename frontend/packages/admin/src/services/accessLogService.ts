/**
 * The Access Log: who was given access to which conversation, when, and why, and every access the
 * credential exchanges refused (ADR-052, FR30).
 *
 * An admin catalog route on the admin credential exchange API (`view-access-log`, `GET admin/access-log`),
 * SigV4-signed with the console session like every admin read. The read is itself recorded before the
 * records come back, so a 503 here means the read could not be recorded and nothing was served.
 */
import i18n from '@ae/shared/i18n';

import { requireAdminApi, consoleCredentials, sigv4GetJson } from './sigv4Fetch';
import { adminUrl } from './adminApi';

export interface AccessLogRecord {
  id: string;
  /**
   * The audit event: a console session, a per-conversation vend, a team vend, a read of this log, or a
   * refusal by the admin or the person credential exchange.
   */
  event: string;
  at: string;
  /**
   * The person, by id; `iam#<arn>` for a reader that is not a person (`actorKind: 'iam'`); null on a refusal of a
   * sign-in that never became a person.
   */
  actor: string | null;
  /** `iam` when the reader is the IAM principal that signed the request rather than a person. */
  actorKind?: 'iam';
  /** That principal's ARN. */
  actorPrincipalArn?: string;
  /** Whether the access was given or refused. A record without one was written as a grant. */
  outcome?: 'granted' | 'refused';
  /** A refusal's code, when the exchange gave one. */
  code?: string | null;
  /** A refusal's HTTP status. */
  status?: number | null;
  conversation: string | null;
  capabilities: string[];
  reason: string | null;
  detail: Record<string, unknown> | null;
}

export interface AccessLogFilter {
  days?: number;
  /** A conversation id (the channel id), not its ARN. */
  channelId?: string;
  /** A person id. */
  actor?: string;
  limit?: number;
}

function accessLogUrl(): string {
  requireAdminApi(i18n.t('admin.accessLog.notConfigured'));
  return adminUrl('admin-exchange', '/admin/access-log');
}

export async function fetchAccessLog(filter: AccessLogFilter = {}): Promise<AccessLogRecord[]> {
  const params: Record<string, string | number> = { days: filter.days ?? 30, limit: filter.limit ?? 200 };
  if (filter.channelId?.trim()) params.channelId = filter.channelId.trim();
  if (filter.actor?.trim()) params.actor = filter.actor.trim();
  const creds = await consoleCredentials();
  const body = await sigv4GetJson<{ records?: AccessLogRecord[] }>(accessLogUrl(), params, creds);
  return Array.isArray(body?.records) ? body.records : [];
}
