import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@ae/shared';
import { useCan } from '../../capabilities';
import { adminRequest } from '../../services/sigv4Fetch';
import { adminApiConfigured, adminUrl } from '../../services/adminApi';
import DataTable from './DataTable';

/**
 * THE REGISTRATIONS WAITING FOR AN OPERATOR (B6, P-12), on a deployment whose guest issuer declares
 * `guest.registration.approval: 'admin'`: what each visitor registered and the address their sign-in link
 * goes to, and Approve, which emails that link (`approve-registrations`, `GET /users/guest/registrations`,
 * `POST /users/guest/registrations/{registrationId}/approve`).
 *
 * The routes exist only where approval is declared, so a deployment that sends each link straight away
 * answers the listing with a 404, and the section says so rather than showing an empty queue.
 */
export interface WaitingRegistration {
  registrationId: string;
  fields: { name: string; company?: string; role?: string; note?: string };
  deliverTo: string;
  createdAt: string;
}

export interface RegistrationsApi {
  list: () => Promise<{ registrations: WaitingRegistration[] }>;
  approve: (registrationId: string) => Promise<unknown>;
}

const deployedApi: RegistrationsApi = {
  list: () => adminRequest('GET', adminUrl('user-management', '/users/guest/registrations')),
  approve: (registrationId) => adminRequest('POST', adminUrl('user-management', `/users/guest/registrations/${encodeURIComponent(registrationId)}/approve`)),
};

type State =
  | { kind: 'loading' }
  | { kind: 'unreadable' }
  | { kind: 'straight-through' }
  | { kind: 'ready'; registrations: WaitingRegistration[] };

/** The line each unsettled state says, by locale key. */
const STATE_LINE: Record<Exclude<State['kind'], 'ready'>, { key: string; role?: 'status' | 'alert' }> = {
  loading: { key: 'admin.guestFunnel.registrations.loading', role: 'status' },
  unreadable: { key: 'admin.guestFunnel.registrations.unreadable', role: 'alert' },
  'straight-through': { key: 'admin.guestFunnel.registrations.straightThrough' },
};
const BUTTON_CLASS = ['btn', 'btn-secondary'].join(' ');

const GuestRegistrations: React.FC<{ api?: RegistrationsApi }> = ({ api }) => {
  const { t } = useTranslation();
  const can = useCan();
  const mayApprove = can('approve-registrations');
  const source = api ?? (adminApiConfigured() ? deployedApi : null);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!source) return;
    try {
      const { registrations } = await source.list();
      setState({ kind: 'ready', registrations: registrations ?? [] });
    } catch (err) {
      setState(err instanceof ApiError && err.status === 404 ? { kind: 'straight-through' } : { kind: 'unreadable' });
    }
  }, [source]);

  useEffect(() => {
    if (mayApprove) void load();
  }, [mayApprove, load]);

  if (!mayApprove || !source) return null;

  const approve = async (registrationId: string) => {
    setBusy(registrationId);
    setNotice(null);
    try {
      await source.approve(registrationId);
      setNotice(t('admin.guestFunnel.registrations.approved'));
      await load();
    } catch (err) {
      const code = err instanceof ApiError ? String((err.body as { code?: string } | undefined)?.code || err.status) : 'unknown';
      setNotice(t('admin.guestFunnel.registrations.approveFailed', { code }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="admin-section" data-testid="guest-registrations">
      <h3>{t('admin.guestFunnel.registrations.title')}</h3>
      <p className="admin-tab-description">{t('admin.guestFunnel.registrations.help')}</p>
      {notice && <p className="admin-tab-description" role="status">{notice}</p>}
      {state.kind !== 'ready' && (
        <p className="admin-tab-description" role={STATE_LINE[state.kind].role}>{t(STATE_LINE[state.kind].key)}</p>
      )}
      {state.kind === 'ready' && (
        <DataTable
          columns={[
            { key: 'name', label: t('admin.guestFunnel.registrations.name') },
            { key: 'company', label: t('admin.guestFunnel.registrations.company') },
            { key: 'role', label: t('admin.guestFunnel.registrations.role') },
            { key: 'note', label: t('admin.guestFunnel.registrations.note') },
            { key: 'deliverTo', label: t('admin.guestFunnel.registrations.deliverTo') },
            { key: 'createdAt', label: t('admin.guestFunnel.registrations.registeredAt') },
            {
              key: 'registrationId',
              label: '',
              render: (v) => (
                <button type="button" className={BUTTON_CLASS} disabled={busy !== null} aria-busy={busy === v} onClick={() => void approve(String(v))}>
                  {busy === v ? t('admin.guestFunnel.registrations.approving') : t('admin.guestFunnel.registrations.approve')}
                </button>
              ),
            },
          ]}
          data={state.registrations.map((r) => ({
            registrationId: r.registrationId,
            name: r.fields?.name ?? '',
            company: r.fields?.company ?? '',
            role: r.fields?.role ?? '',
            note: r.fields?.note ?? '',
            deliverTo: r.deliverTo,
            createdAt: r.createdAt,
          }))}
          emptyMessage={t('admin.guestFunnel.registrations.none')}
        />
      )}
    </div>
  );
};

export default GuestRegistrations;
