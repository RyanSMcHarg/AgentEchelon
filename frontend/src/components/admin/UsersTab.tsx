import React from 'react';
import DataTable from './DataTable';
import MetricCard from './MetricCard';
import Sparkline from './Sparkline';
import FunnelChart, { type FunnelStep } from './FunnelChart';
import { METRIC_TARGETS } from './metricTargets';
import type { AnalyticsResult } from '../../types/analytics';

interface UsersTabProps {
  /** Athena-only `user_activity` rollup — partition-only, no real
   *  per-user data. Retained as a fallback when client_events are empty. */
  data: AnalyticsResult | null;
  /** Session DAU — distinct user_id with session_started per day,
   *  broken out by user_tier. Includes signed-in-and-bounced. */
  activeUsersData?: AnalyticsResult | null;
  /** Messaging DAU — distinct user_id with at least one of
   *  websocket_connected / message_sent / channel_messages_listed per day,
   *  broken out by user_tier. The "actually engaged" cohort. */
  messagingUsersData?: AnalyticsResult | null;
  /** Per-user message_sent counts (descending). */
  messagesPerUserData?: AnalyticsResult | null;
  /** signup_funnel_conversion (step, event_count, session_count). */
  signupFunnelData?: AnalyticsResult | null;
  /** signin_funnel_conversion (same shape). */
  signinFunnelData?: AnalyticsResult | null;
  isLoading: boolean;
}

const TIER_ORDER = ['premium', 'standard', 'basic'] as const;
const TIER_LABEL: Record<string, string> = {
  premium: 'Premium',
  standard: 'Standard',
  basic: 'Basic',
  unknown: 'Unknown',
};

const SIGNUP_STEP_LABEL: Record<string, string> = {
  signup_form_viewed: 'Form viewed',
  signup_submitted: 'Submitted',
  signup_confirmation_required: 'Verify email',
  signup_confirmation_completed: 'Confirmed',
  signup_failed: 'Failed',
};

const SIGNIN_STEP_LABEL: Record<string, string> = {
  signin_form_viewed: 'Form viewed',
  signin_submitted: 'Submitted',
  signin_succeeded: 'Succeeded',
  signin_failed: 'Failed',
  signin_password_reset_initiated: 'Password reset',
};

function toFunnelSteps(
  rows: Array<Record<string, unknown>>,
  labels: Record<string, string>,
): FunnelStep[] {
  return rows.map((r) => {
    const id = String(r.step || '');
    return {
      id,
      label: labels[id] || id,
      eventCount: Number(r.event_count || 0),
      sessionCount: Number(r.session_count || 0),
    };
  });
}

const UsersTab: React.FC<UsersTabProps> = ({
  data,
  activeUsersData,
  messagingUsersData,
  messagesPerUserData,
  signupFunnelData,
  signinFunnelData,
  isLoading,
}) => {
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
  const uniqueUsers = new Set(userRows.map((r) => r.user_id)).size;
  const topUserMessages = userRows.length > 0 ? Number(userRows[0].message_count || 0) : 0;

  // ---------- Funnels ----------
  const signupSteps = toFunnelSteps(signupFunnelData?.data ?? [], SIGNUP_STEP_LABEL);
  const signinSteps = toFunnelSteps(signinFunnelData?.data ?? [], SIGNIN_STEP_LABEL);
  // Conversion = success-step sessions / first-step sessions (for the target cards).
  const funnelConversion = (steps: FunnelStep[], successId: string): number => {
    const first = steps[0]?.sessionCount || 0;
    const success = steps.find((s) => s.id === successId)?.sessionCount || 0;
    return first > 0 ? (success / first) * 100 : 0;
  };
  const signupConv = funnelConversion(signupSteps, 'signup_confirmation_completed');
  const signinConv = funnelConversion(signinSteps, 'signin_succeeded');

  // ---------- Fallback (Athena) — partition-only rollup ----------
  const showLegacyFallback = userRows.length === 0 && (data?.data?.length || 0) > 0;

  return (
    <div className="admin-tab">
      {/* Two banners — session DAU (signed in) vs messaging DAU (engaged).
          The gap between them is the "auth'd but bounced" cohort. */}
      <div className="admin-tab-banner-row">
        <div className="admin-tab-banner admin-tab-banner--compact">
          <div className="admin-tab-banner-label">
            <span className="admin-tab-banner-label-text">Signed-in · sessions started</span>
            <span className="admin-tab-banner-label-value">{dauLatest.toLocaleString()}</span>
          </div>
          {dauTrend.length >= 2 ? (
            <Sparkline data={dauTrend} width={240} height={48} label="Signed-in users" />
          ) : (
            <span className="admin-tab-banner-empty">No session_started events yet</span>
          )}
        </div>
        <div className="admin-tab-banner admin-tab-banner--compact admin-tab-banner--accented">
          <div className="admin-tab-banner-label">
            <span className="admin-tab-banner-label-text">Messaging · actually engaged</span>
            <span className="admin-tab-banner-label-value">{mauLatest.toLocaleString()}</span>
          </div>
          {mauTrend.length >= 2 ? (
            <Sparkline data={mauTrend} width={240} height={48} label="Messaging users" />
          ) : (
            <span className="admin-tab-banner-empty">No messaging engagement yet</span>
          )}
        </div>
      </div>

      <div className="metric-cards-grid">
        <MetricCard title="Latest DAU" value={dauLatest.toLocaleString()} subtitle="signed in today" />
        <MetricCard
          title="Latest Messaging"
          value={mauLatest.toLocaleString()}
          subtitle={dauLatest > 0 ? `${Math.round((mauLatest / dauLatest) * 100)}% of signed-in` : 'engaged today'}
        />
        <MetricCard title="Peak DAU" value={dauPeak.toLocaleString()} subtitle="window high-water" />
        <MetricCard title="Top sender" value={topUserMessages.toLocaleString()} subtitle={`#1 of ${uniqueUsers} unique senders`} />
      </div>

      {/* DAU by tier — three little chips, mono numerals */}
      {dauByTier.size > 0 && (
        <div className="admin-tab-tier-strip">
          {TIER_ORDER.map((tier) => {
            const n = dauByTier.get(tier) || 0;
            return (
              <div key={tier} className={`admin-tab-tier-chip admin-tab-tier-chip--${tier}`}>
                <span className="admin-tab-tier-chip-label">{TIER_LABEL[tier]}</span>
                <span className="admin-tab-tier-chip-value">{n.toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Conversion target cards — make "good" explicit alongside the funnels. */}
      {(signupSteps.length > 0 || signinSteps.length > 0) && (
        <div className="admin-metrics-row">
          <MetricCard
            title="Sign-up conversion"
            value={`${signupConv.toFixed(1)}%`}
            subtitle="confirmed / form viewed"
            target={METRIC_TARGETS.signup_conversion}
            rawValue={signupConv}
          />
          <MetricCard
            title="Sign-in success"
            value={`${signinConv.toFixed(1)}%`}
            subtitle="succeeded / form viewed"
            target={METRIC_TARGETS.signin_conversion}
            rawValue={signinConv}
          />
        </div>
      )}

      {/* Funnels */}
      <div className="admin-section">
        <h3>Sign-up funnel</h3>
        <FunnelChart
          steps={signupSteps}
          successStepId="signup_confirmation_completed"
          failureStepId="signup_failed"
        />
      </div>
      <div className="admin-section">
        <h3>Sign-in funnel</h3>
        <FunnelChart
          steps={signinSteps}
          successStepId="signin_succeeded"
          failureStepId="signin_failed"
        />
      </div>

      {/* Per-user leaderboard */}
      <div className="admin-section">
        <h3>Top senders (messages this window)</h3>
        {userRows.length === 0 ? (
          <p className="admin-tab-description">
            No <code>message_sent</code> events ingested yet. Populates once the
            new <code>/events</code> endpoint receives traffic.
          </p>
        ) : (
          <DataTable
            columns={[
              { key: 'rank', label: '#' },
              { key: 'user_email', label: 'User', render: (v, row) => (v as string) || String(row.user_id || '').slice(0, 12) + '…' },
              { key: 'user_tier', label: 'Tier' },
              { key: 'message_count', label: 'Messages', render: (v) => Number(v).toLocaleString() },
            ]}
            data={userRows}
            emptyMessage="No user activity"
          />
        )}
      </div>

      {/* Athena partition-only fallback */}
      {showLegacyFallback && (
        <div className="admin-section">
          <h3>Activity by tier (legacy partition-only)</h3>
          <p className="admin-tab-description">
            Pre-Brick-B aggregate; shows traffic per tier from the conversations
            archive. Superseded by the per-user leaderboard above once client
            events flow.
          </p>
          <DataTable
            columns={[
              { key: 'user_type', label: 'Tier' },
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
