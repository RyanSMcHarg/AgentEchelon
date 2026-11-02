import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCan } from '../../capabilities';
import { listPeople, namesByPersonId, userManagementUrl } from '../../services/peopleService';
import DataTable from './DataTable';
import MetricCard from './MetricCard';
import Sparkline from './Sparkline';
import FunnelChart, { type FunnelStep } from './FunnelChart';
import GuestFunnelPanel from './GuestFunnelPanel';
import { GUEST_EXPERIENCE_SHOWN } from '../../config/guestExperience';
import { METRIC_TARGETS } from './metricTargets';
import { InfoTooltip, GuideLinks, guide } from './AdminHelp';
import type { AnalyticsResult } from '@ae/shared';
import { classificationBadgeStyle, classificationName } from '@ae/shared/config/classifications.ts';

interface UsersTabProps {
  /** Athena-only `user_activity` rollup — partition-only, no real
   *  per-user data. Retained as a fallback when client_events are empty. */
  data: AnalyticsResult | null;
  /** Session DAU — distinct person_id with session_started per day,
   *  broken out by user_tier. Includes signed-in-and-bounced. */
  activeUsersData?: AnalyticsResult | null;
  /** Messaging DAU — distinct person_id with at least one of
   *  websocket_connected / message_sent / channel_messages_listed per day,
   *  broken out by user_tier. The "actually engaged" cohort. */
  messagingUsersData?: AnalyticsResult | null;
  /** Per-user message_sent counts (descending). */
  messagesPerUserData?: AnalyticsResult | null;
  /** signup_funnel_conversion (step, event_count, session_count). */
  signupFunnelData?: AnalyticsResult | null;
  /** signin_funnel_conversion (same shape). */
  signinFunnelData?: AnalyticsResult | null;
  /** guest_to_customer_funnel (step, journeys, event_count): the Guest panel and the funnel (E6, B12). */
  guestFunnelData?: AnalyticsResult | null;
  /** guest_refusals (reason, refusals). */
  guestRefusalsData?: AnalyticsResult | null;
  isLoading: boolean;
}

/**
 * DISPLAY LABELS FOR THE SAMPLE CLASSIFICATIONS, and nothing more.
 *
 * Nothing in the console is told which classifications this deployment declares: no endpoint and no
 * build-time variable carries `backend/lib/config/profiles.ts` to the frontend, and the same gap makes
 * the chat client's conversation-type picker hardcode the same three names. So this maps the sample
 * names to prettier text and every other value falls through to itself, which is legible for a
 * deployment declaring `legal` and `finance` even though it is not capitalized for them.
 *
 * The chips themselves are built from the DATA rather than from this map (see `classificationChips`),
 * so a classification this file has never heard of is still counted and shown.
 */


/**
 * The per-classification chips, built from the rollup's own values.
 *
 * THIS WAS `TIER_ORDER = ['premium', 'standard', 'basic']`, iterated to render the chips. Two things
 * were wrong with it and neither is cosmetic. It hardcoded this deployment's three sample names, so a
 * deployment declaring its own showed three chips reading zero beside real traffic it never displayed;
 * and the order was a rank, which a classification does not have - it is a declared set of grants
 * (ADR-046), and `legal` sits neither above nor below `finance`.
 *
 * Ordered by count, descending, then by value, so the order comes from the data and is stable across
 * renders. Counting is not ranking: it says which classification is busiest in this window, which is
 * the question a reader of a usage tab is asking.
 */
export function classificationChips(
  byClassification: Map<string, number>,
  /** How a classification value is shown. Defaults to the raw value, which keeps this pure and testable. */
  label: (value: string) => string = (value) => value,
): Array<{ value: string; label: string; count: number }> {
  return [...byClassification.entries()]
    .map(([value, count]) => ({ value, label: label(value), count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}



function toFunnelSteps(
  rows: Array<Record<string, unknown>>,
  label: (stepId: string) => string,
): FunnelStep[] {
  return rows.map((r) => {
    const id = String(r.step || '');
    return {
      id,
      label: label(id),
      eventCount: Number(r.event_count || 0),
      sessionCount: Number(r.session_count || 0),
      outsideSessions: Number(r.sessions_outside_funnel || 0),
    };
  });
}

/**
 * A FUNNEL'S CONVERSION: the success step's sessions over the entry step's.
 *
 * By default it counts EVERY session that recorded the success, in the funnel or outside it (in-funnel plus
 * `sessions_outside_funnel`, which is every distinct session with the success step), so it can read over
 * 100% when sessions succeed with no form view recorded before it. With `formOnly` it counts only the
 * sessions that entered at the form and then succeeded, a subset of the entry step by construction
 * (`backend/lambda/src/lib/session-funnels.ts`), so it stays within 100% without a clamp. Null when no
 * session entered, which is no rate rather than a rate of zero.
 */
export function funnelConversion(steps: FunnelStep[], entryId: string, successId: string, formOnly = false): number | null {
  const entered = steps.find((s) => s.id === entryId)?.sessionCount || 0;
  const success = steps.find((s) => s.id === successId);
  const succeeded = (success?.sessionCount || 0) + (formOnly ? 0 : success?.outsideSessions || 0);
  return entered > 0 ? (succeeded / entered) * 100 : null;
}

/** The URL parameter that limits the conversion cards to sessions that went through the form. */
export const FORM_ONLY_PARAM = 'funnel';
const FORM_ONLY_VALUE = 'form';

/** Whether a console URL's query asks for the form-only conversion. */
export function formOnlyFromSearch(search: string): boolean {
  return new URLSearchParams(search).get(FORM_ONLY_PARAM) === FORM_ONLY_VALUE;
}

/** The query with the form-only choice set or cleared, every other parameter kept. */
export function withFormOnly(search: string, formOnly: boolean): string {
  const q = new URLSearchParams(search);
  if (formOnly) q.set(FORM_ONLY_PARAM, FORM_ONLY_VALUE);
  else q.delete(FORM_ONLY_PARAM);
  const out = q.toString();
  return out ? `?${out}` : '';
}

/** Sessions that reached the success step with no entry step before it, reported beside the funnel. */
export function successesOutsideFunnel(steps: FunnelStep[], successId: string): number {
  return steps.find((s) => s.id === successId)?.outsideSessions || 0;
}

/**
 * THE LEADERBOARD'S NAMES. The analytics read returns a person id and never a name: the analytics data
 * plane has no route to an identity provider. The names come from the console's list of people
 * (`GET /users`, user-management.ts), whose names are the directory's (`displayNameFor`) and are given
 * only to a caller who may be told who a person is. So they are asked for only by a role holding both
 * `view-users` and `see-user-identity`; anyone else, and any person the list does not name, sees the id.
 */
function useSenderNames(): Map<string, string> {
  const can = useCan();
  const mayName = can('view-users') && can('see-user-identity');
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!mayName || !userManagementUrl()) return;
    let live = true;
    listPeople()
      .then((list) => { if (live) setNames(namesByPersonId(list.users)); })
      .catch((err) => console.warn('[UsersTab] the senders could not be named; their ids are shown', (err as Error)?.message));
    return () => { live = false; };
  }, [mayName]);
  return names;
}

const UsersTab: React.FC<UsersTabProps> = ({
  data,
  activeUsersData,
  messagingUsersData,
  messagesPerUserData,
  signupFunnelData,
  signinFunnelData,
  guestFunnelData,
  guestRefusalsData,
  isLoading,
}) => {
  const { t } = useTranslation();
  // The form-only choice lives in the URL, replaced rather than pushed like the console's other filters,
  // so the view can be sent to someone.
  const [formOnly, setFormOnly] = useState<boolean>(() => {
    try { return formOnlyFromSearch(window.location.search); } catch { return false; }
  });
  const changeFormOnly = (next: boolean) => {
    setFormOnly(next);
    try {
      window.history.replaceState(null, '', `${window.location.pathname}${withFormOnly(window.location.search, next)}${window.location.hash}`);
    } catch { /* the view stands; only sharing it is lost */ }
  };
  const names = useSenderNames();
  if (isLoading) {
    return (
      <div className="admin-tab">
        <div className="skeleton skeleton--title" style={{ width: '24%' }} />
        <div className="skeleton skeleton--chart" />
        <div className="metric-cards-grid skeleton-grid">
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
        </div>
      </div>
    );
  }

  // ---------- Active-users banner ----------
  const dauRows = activeUsersData?.data ?? [];
  const dauByDate = new Map<string, number>();
  const dauByTier = new Map<string, number>();
  for (const r of dauRows) {
    const date = String(r.date || '');
    const tier = String(r.user_tier || 'unknown');
    const n = Number(r.active_users || 0);
    dauByDate.set(date, (dauByDate.get(date) || 0) + n);
    dauByTier.set(tier, (dauByTier.get(tier) || 0) + n);
  }
  const sortedDauDates = Array.from(dauByDate.keys()).sort();
  const dauTrend = sortedDauDates.map((d) => dauByDate.get(d) || 0);
  const dauLatest = dauTrend.length > 0 ? dauTrend[dauTrend.length - 1] : 0;
  const dauPeak = dauTrend.length > 0 ? Math.max(...dauTrend) : 0;

  // ---------- Messaging-users banner (same shape, engagement signal) ----------
  const mauRows = messagingUsersData?.data ?? [];
  const mauByDate = new Map<string, number>();
  const mauByTier = new Map<string, number>();
  for (const r of mauRows) {
    const date = String(r.date || '');
    const tier = String(r.user_tier || 'unknown');
    const n = Number(r.active_messaging_users || 0);
    mauByDate.set(date, (mauByDate.get(date) || 0) + n);
    mauByTier.set(tier, (mauByTier.get(tier) || 0) + n);
  }
  const sortedMauDates = Array.from(mauByDate.keys()).sort();
  const mauTrend = sortedMauDates.map((d) => mauByDate.get(d) || 0);
  const mauLatest = mauTrend.length > 0 ? mauTrend[mauTrend.length - 1] : 0;

  // ---------- Per-user leaderboard ----------
  // Stamp the rank at top-50 cut so column sort doesn't scramble it.
  const userRows: Array<Record<string, string | number>> = (messagesPerUserData?.data ?? [])
    .slice(0, 50)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const uniqueUsers = new Set(userRows.map((r) => r.person_id)).size;
  const topUserMessages = userRows.length > 0 ? Number(userRows[0].message_count || 0) : 0;

  // ---------- Funnels ----------
  const signupSteps = toFunnelSteps(signupFunnelData?.data ?? [], (id) => t(`admin.users.signupStep.${id}`, { defaultValue: id }));
  const signinSteps = toFunnelSteps(signinFunnelData?.data ?? [], (id) => t(`admin.users.signinStep.${id}`, { defaultValue: id }));
  // Conversion = success-step sessions / entry-step sessions (the target cards): every session that
  // succeeded by default, or only the sessions that went through the form when the viewer asks for it.
  const signupConv = funnelConversion(signupSteps, 'signup_form_viewed', 'signup_confirmation_completed', formOnly);
  const signinConv = funnelConversion(signinSteps, 'signin_form_viewed', 'signin_succeeded', formOnly);
  const signupOutside = successesOutsideFunnel(signupSteps, 'signup_confirmation_completed');
  const signinOutside = successesOutsideFunnel(signinSteps, 'signin_succeeded');

  // ---------- Fallback (Athena) — partition-only rollup ----------
  const showLegacyFallback = userRows.length === 0 && (data?.data?.length || 0) > 0;

  return (
    <div className="admin-tab">
      {/* This tab opened on two unlabeled banners. The reason they are two numbers - the gap between
          them IS the finding - was a code comment, which is the one audience that does not need it. */}
      <p className="admin-tab-description">
        {t('admin.users.whoIsUsingTheDeployment')}
        <InfoTooltip
          label={t('admin.users.howToReadTheTwo')}
          content={
            <>
              Signed-in counts the sessions that started; messaging counts the people who actually sent
              something. The gap between them is the cohort that authenticated and then bounced, which
              is why they are reported as two numbers rather than one.
            </>
          }
        />
      </p>
      <GuideLinks guides={[guide(t('admin.guides.users.console'), 'adminConsole')]} />

      {/* Two banners - session DAU (signed in) vs messaging DAU (engaged). */}
      <div className="admin-tab-banner-row">
        <div className="admin-tab-banner admin-tab-banner--compact">
          <div className="admin-tab-banner-label">
            <span className="admin-tab-banner-label-text">{t('admin.users.signedInSessionsStarted')}</span>
            <span className="admin-tab-banner-label-value">{dauLatest.toLocaleString()}</span>
          </div>
          {dauTrend.length >= 2 ? (
            <Sparkline data={dauTrend} width={240} height={48} label={t('admin.users.signedInUsers')} />
          ) : (
            <span className="admin-tab-banner-empty">{t('admin.users.noSessionStartedEventsYet')}</span>
          )}
        </div>
        <div className="admin-tab-banner admin-tab-banner--compact admin-tab-banner--accented">
          <div className="admin-tab-banner-label">
            <span className="admin-tab-banner-label-text">{t('admin.users.messagingActuallyEngaged')}</span>
            <span className="admin-tab-banner-label-value">{mauLatest.toLocaleString()}</span>
          </div>
          {mauTrend.length >= 2 ? (
            <Sparkline data={mauTrend} width={240} height={48} label={t('admin.users.messagingUsers')} />
          ) : (
            <span className="admin-tab-banner-empty">{t('admin.users.noMessagingEngagementYet')}</span>
          )}
        </div>
      </div>

      <div className="metric-cards-grid">
        <MetricCard title={t('admin.users.latestDau')} value={dauLatest.toLocaleString()} subtitle={t('admin.users.signedInToday')} />
        <MetricCard
          title={t('admin.users.latestMessaging')}
          value={mauLatest.toLocaleString()}
          subtitle={dauLatest > 0 ? t('admin.users.ofSignedIn', { dauLatest: Math.round((mauLatest / dauLatest) * 100) }) : t('admin.users.engagedToday')}
        />
        <MetricCard title={t('admin.users.peakDau')} value={dauPeak.toLocaleString()} subtitle={t('admin.users.windowHighWater')} />
        <MetricCard title={t('admin.users.topSender')} value={topUserMessages.toLocaleString()} subtitle={t('admin.users.1OfUniqueSenders', { uniqueUsers: uniqueUsers })} />
      </div>

      {/* DAU per classification — one chip per classification the rollup actually carries, mono numerals */}
      {dauByTier.size > 0 && (
        <div className="admin-tab-tier-strip">
          {classificationChips(dauByTier, (v) => (v === 'unknown' ? t('admin.users.classification.unknown') : classificationName(v))).map((chip) => (
            <div key={chip.value} className="admin-tab-tier-chip" style={classificationBadgeStyle(chip.value)}>
              <span className="admin-tab-tier-chip-label">{chip.label}</span>
              <span className="admin-tab-tier-chip-value">{chip.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {/* Conversion target cards — make "good" explicit alongside the funnels. */}
      {(signupSteps.length > 0 || signinSteps.length > 0) && (
        <div className="admin-metrics-row">
          <MetricCard
            title={t('admin.users.signUpConversion')}
            value={signupConv === null ? '—' : `${signupConv.toFixed(1)}%`}
            subtitle={t(formOnly ? 'admin.users.confirmedFormViewed' : 'admin.users.confirmedAnySession')}
            target={METRIC_TARGETS.signup_conversion}
            rawValue={signupConv ?? undefined}
          />
          <MetricCard
            title={t('admin.users.signInSuccess')}
            value={signinConv === null ? '—' : `${signinConv.toFixed(1)}%`}
            subtitle={t(formOnly ? 'admin.users.succeededFormViewed' : 'admin.users.succeededAnySession')}
            target={METRIC_TARGETS.signin_conversion}
            rawValue={signinConv ?? undefined}
          />
        </div>
      )}
      {(signupSteps.length > 0 || signinSteps.length > 0) && (
        <>
          <label className="admin-muted" data-testid="funnel-form-only">
            <input type="checkbox" checked={formOnly} onChange={(e) => changeFormOnly(e.target.checked)} />{' '}
            {t('admin.users.onlyFormSessions')}
          </label>
          {!formOnly && (
            <p className="admin-muted" data-testid="funnel-over-100-note">{t('admin.users.conversionCanExceed100')}</p>
          )}
        </>
      )}

      {/* Funnels */}
      <div className="admin-section">
        <h3>{t('admin.users.signUpFunnel')}</h3>
        <FunnelChart
          steps={signupSteps}
          successStepId="signup_confirmation_completed"
          failureStepId="signup_failed"
        />
        {formOnly && signupOutside > 0 && (
          <p className="admin-tab-description" data-testid="signup-outside-funnel">
            {t('admin.users.signUpsWithoutFormView', { count: signupOutside })}
          </p>
        )}
      </div>
      <div className="admin-section">
        <h3>{t('admin.users.signInFunnel')}</h3>
        <FunnelChart
          steps={signinSteps}
          successStepId="signin_succeeded"
          failureStepId="signin_failed"
        />
        {formOnly && signinOutside > 0 && (
          <p className="admin-tab-description" data-testid="signin-outside-funnel">
            {t('admin.users.signInsWithoutFormView', { count: signinOutside })}
          </p>
        )}
      </div>

      {/* The Guest panel and the guest-to-customer funnel (E6, B12). */}
      {GUEST_EXPERIENCE_SHOWN && <GuestFunnelPanel funnelData={guestFunnelData} refusalsData={guestRefusalsData} isLoading={isLoading} />}

      {/* Per-user leaderboard */}
      <div className="admin-section">
        <h3>{t('admin.users.topSendersMessagesThisWindow')}</h3>
        {userRows.length === 0 ? (
          <p className="admin-tab-description">
            No <code>message_sent</code> {t('admin.users.eventsIngestedYetPopulatesOnce')} <code>/events</code> {t('admin.users.endpointReceivesTraffic')}
          </p>
        ) : (
          <DataTable
            columns={[
              { key: 'rank', label: '#' },
              { key: 'person_id', label: 'User', render: (v) => names.get(String(v || '')) ?? String(v || '').slice(0, 12) + '…' },
              { key: 'user_tier', label: 'Tier' },
              { key: 'message_count', label: 'Messages', render: (v) => Number(v).toLocaleString() },
            ]}
            data={userRows}
            emptyMessage={t('admin.users.noUserActivity')}
          />
        )}
      </div>

      {/* Athena partition-only fallback */}
      {showLegacyFallback && (
        <div className="admin-section">
          <h3>
            {t('admin.users.activityByTierLegacyPartition')}
            <InfoTooltip
              label={t('admin.users.whyThisSectionIsShown')}
              content={
                <>
                  A pre-Brick-B aggregate, read from the conversations archive rather than from client
                  events. It is superseded by the per-user leaderboard above and stops being shown once
                  client events flow.
                </>
              }
            />
          </h3>
          <p className="admin-tab-description">
            {t('admin.users.trafficPerTierFromThe')}
          </p>
          <DataTable
            columns={[
              { key: 'classification', label: 'Classification' },
              { key: 'messages', label: 'Messages', render: (v) => Number(v).toLocaleString() },
              { key: 'active_days', label: 'Active Days' },
            ]}
            data={data?.data ?? []}
          />
        </div>
      )}
    </div>
  );
};

export default UsersTab;
