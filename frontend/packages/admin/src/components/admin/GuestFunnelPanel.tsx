import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalyticsResult } from '@ae/shared';
import { useCan } from '../../capabilities';
import { adminRequest } from '../../services/sigv4Fetch';
import { adminApiConfigured, adminUrl } from '../../services/adminApi';
import FunnelChart, { type FunnelStep } from './FunnelChart';
import DataTable from './DataTable';
import GuestRegistrations, { type RegistrationsApi } from './GuestRegistrations';

/**
 * THE GUEST PANEL AND THE GUEST-TO-CUSTOMER FUNNEL (E6, B12, L16).
 *
 * Each figure is a query over a record that already exists, never a copy: the starts, the refusals by
 * reason and every funnel stage are the archive's events (`guest_to_customer_funnel`, `guest_refusals`), and
 * the kill switch is its SSM parameter, read through user management (`GET /users/guest`). A journey is the
 * visitor's conversation, so path B is joined by conversation and never by an address.
 *
 * THE STAGES, MIRRORED FROM `backend/lambda/src/lib/funnel-stages.ts`, which a browser bundle cannot import.
 * `backend/test/lib/the-funnel-records-each-stage-once-per-journey.test.ts` fails when the two disagree. A
 * stage whose recorder is not built is shown as not built, never as zero.
 */
export const GUEST_FUNNEL_STAGES: ReadonlyArray<{ stage: string; built: boolean }> = [
  { stage: 'guest_started', built: true },
  { stage: 'guest_refused', built: true },
  { stage: 'registration_offered', built: false },
  { stage: 'registration_started', built: false },
  { stage: 'claim_sent', built: true },
  { stage: 'claim_redeemed', built: true },
  { stage: 'guest_bound', built: true },
  { stage: 'rep_added', built: false },
  { stage: 'rep_first_reply', built: false },
  { stage: 'handoff_unassigned', built: false },
];

/** Each path's stages, in funnel order. */
const PATH_A = ['guest_started', 'guest_bound'];
const PATH_B = ['guest_started', 'claim_sent', 'claim_redeemed'];

interface KillSwitch {
  declared: boolean;
  paused?: boolean;
  changedBy?: string | null;
  changedAt?: string | null;
  reason?: string | null;
  unreadable?: boolean;
  /** `admin` when registrations wait for an operator: the only deployment that serves their list. */
  registrationApproval?: 'admin' | 'none';
}

interface Props {
  funnelData?: AnalyticsResult | null;
  refusalsData?: AnalyticsResult | null;
  isLoading?: boolean;
  /** Injected for tests. */
  loadSwitch?: () => Promise<KillSwitch>;
  /** Injected for tests: the registrations waiting for an operator. */
  registrationsApi?: RegistrationsApi;
}

function journeysByStage(rows: Array<Record<string, unknown>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(String(r.step || ''), Number(r.journeys || 0));
  return out;
}

const loadDeployedSwitch = (): Promise<KillSwitch> => adminRequest<KillSwitch>('GET', adminUrl('user-management', '/users/guest'));

const GuestFunnelPanel: React.FC<Props> = ({ funnelData, refusalsData, isLoading = false, loadSwitch, registrationsApi }) => {
  const { t } = useTranslation();
  const can = useCan();
  const [killSwitch, setKillSwitch] = useState<KillSwitch | null>(null);
  const [switchError, setSwitchError] = useState(false);
  const maySeeSwitch = can('view-guest-sessions');

  useEffect(() => {
    if (!maySeeSwitch) return;
    const load = loadSwitch ?? (adminApiConfigured() ? loadDeployedSwitch : null);
    if (!load) return;
    let live = true;
    load().then((s) => { if (live) setKillSwitch(s); }, () => { if (live) setSwitchError(true); });
    return () => { live = false; };
  }, [maySeeSwitch, loadSwitch]);

  const journeys = journeysByStage(funnelData?.data ?? []);
  const label = (stage: string) => t(`admin.guestFunnel.stage.${stage}`, { defaultValue: stage });
  const stepsOf = (stages: string[]): FunnelStep[] => stages.map((id) => ({
    id, label: label(id), eventCount: journeys.get(id) ?? 0, sessionCount: journeys.get(id) ?? 0,
  }));
  const notBuilt = GUEST_FUNNEL_STAGES.filter((s) => !s.built).map((s) => label(s.stage));
  const refusals = (refusalsData?.data ?? []).map((r) => ({
    reason: t(`admin.guestFunnel.reason.${String(r.reason || 'unknown')}`, { defaultValue: String(r.reason || 'unknown') }),
    refusals: Number(r.refusals || 0),
  }));

  return (
    <>
      <div className="admin-section" data-testid="guest-panel">
        <h3>{t('admin.guestFunnel.guestTitle')}</h3>
        <p className="admin-tab-description">
          {t('admin.guestFunnel.starts', { count: journeys.get('guest_started') ?? 0 })}
        </p>
        {maySeeSwitch && (
          <p className="admin-tab-description" data-testid="guest-kill-switch">
            {switchError || killSwitch?.unreadable
              ? t('admin.guestFunnel.switchUnreadable')
              : !killSwitch
                ? t('admin.guestFunnel.switchLoading')
                : !killSwitch.declared
                  ? t('admin.guestFunnel.noGuestIssuer')
                  : t(killSwitch.paused ? 'admin.guestFunnel.paused' : 'admin.guestFunnel.running', {
                    by: killSwitch.changedBy || t('admin.guestFunnel.nobody'),
                    at: killSwitch.changedAt || '--',
                    reason: killSwitch.reason || '--',
                  })}
          </p>
        )}
        <h4>{t('admin.guestFunnel.refusalsTitle')}</h4>
        <DataTable
          columns={[
            { key: 'reason', label: t('admin.guestFunnel.reasonColumn') },
            { key: 'refusals', label: t('admin.guestFunnel.refusalsColumn'), render: (v) => Number(v).toLocaleString() },
          ]}
          data={refusals}
          emptyMessage={t('admin.guestFunnel.noRefusals')}
        />
      </div>
      {/* ASKED FOR ONLY WHERE IT IS SERVED: without an approval step there is no list, and no route for it. */}
      {(registrationsApi || killSwitch?.registrationApproval === 'admin') && <GuestRegistrations api={registrationsApi} />}
      <div className="admin-section" data-testid="guest-funnel">
        <h3>{t('admin.guestFunnel.funnelTitle')}</h3>
        <p className="admin-tab-description">{t('admin.guestFunnel.funnelHelp')}</p>
        <h4>{t('admin.guestFunnel.pathA')}</h4>
        <FunnelChart steps={stepsOf(PATH_A)} successStepId="guest_bound" isLoading={isLoading} />
        <h4>{t('admin.guestFunnel.pathB')}</h4>
        <FunnelChart steps={stepsOf(PATH_B)} successStepId="claim_redeemed" isLoading={isLoading} />
        <p className="admin-tab-description" data-testid="guest-funnel-not-built">
          {t('admin.guestFunnel.notBuilt', { stages: notBuilt.join(', ') })}
        </p>
      </div>
    </>
  );
};

export default GuestFunnelPanel;
