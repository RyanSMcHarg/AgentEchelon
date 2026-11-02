/**
 * The Access Log: who was given access to which conversation, when, and why (ADR-052, FR30).
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
  /** The audit event: a console session, a per-conversation vend, a team vend, or a read of this log. */
  event: string;
  at: string;
  /** The person, by id. */
  actor: string;
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
