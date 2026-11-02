/**
 * A CONVERSATION'S INVITATIONS (M-10, E6): who was invited, by whom, how they join and where each stands,
 * with a way to withdraw one, which removes the person it named from the conversation.
 *
 * A query over the invitation records themselves (`view-invitations`), never a copy; withdrawing is its own
 * capability (`revoke-invitations`), so the control is absent for a session that does not hold it. IAM
 * refuses either at the gateway whatever this renders.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import {
  listAdminInvitations as defaultList,
  revokeAdminInvitation as defaultRevoke,
  type AdminInvitation,
} from '../../services/adminConversationService';

export interface InvitationsPanelProps {
  channelArn: string;
  canRevoke: boolean;
  deps?: { list?: typeof defaultList; revoke?: typeof defaultRevoke; confirm?: (message: string) => boolean };
}

export function InvitationsPanel({ channelArn, canRevoke, deps = {} }: InvitationsPanelProps) {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<AdminInvitation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await (deps.list ?? defaultList)(channelArn));
      setError(null);
    } catch {
      setError(t('admin.invitations.failed'));
    } finally {
      setLoading(false);
    }
  }, [channelArn, deps.list, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (row: AdminInvitation) => {
    const confirm = deps.confirm ?? ((m: string) => window.confirm(m));
    if (!confirm(t('admin.invitations.confirmRevoke', { name: row.inviteeName }))) return;
    try {
      const revoked = await (deps.revoke ?? defaultRevoke)(channelArn, row.invitationId);
      setRows((current) => current.map((r) => (r.invitationId === revoked.invitationId ? revoked : r)));
    } catch {
      setError(t('admin.invitations.revokeFailed'));
    }
  };

  const date = (seconds: number) => new Date(seconds * 1000).toLocaleString(i18n.language);

  return (
    <div className="admin-section">
      <h4>{t('admin.invitations.title')}</h4>
      <p className="admin-field-hint">{t('admin.invitations.hint')}</p>
      {error && <div className="admin-error" role="alert">{error}</div>}
      <DataTable
        columns={[
          { key: 'inviteeName', label: t('admin.invitations.columns.invitee') },
          { key: 'inviterName', label: t('admin.invitations.columns.inviter') },
          { key: 'mode', label: t('admin.invitations.columns.mode'), render: (value) => t(`admin.invitations.mode.${String(value)}`) },
          { key: 'status', label: t('admin.invitations.columns.status'), render: (value) => t(`admin.invitations.status.${String(value)}`) },
          { key: 'expiresAt', label: t('admin.invitations.columns.expires'), render: (value) => date(Number(value)) },
          {
            key: 'revoke',
            label: '',
            sortable: false,
            render: (_value, row) => {
              const inv = row as AdminInvitation;
              return canRevoke && inv.status !== 'revoked' ? (
                <button className="btn-secondary" aria-label={t('admin.invitations.revokeFor', { name: inv.inviteeName })} onClick={() => void revoke(inv)}>
                  {t('admin.invitations.revoke')}
                </button>
              ) : null;
            },
          },
        ]}
        data={rows}
        emptyMessage={loading ? '' : t('admin.invitations.empty')}
      />
    </div>
  );
}
