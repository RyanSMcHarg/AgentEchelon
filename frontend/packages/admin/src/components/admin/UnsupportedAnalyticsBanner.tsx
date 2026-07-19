import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalyticsResult } from '@ae/shared';

interface Props {
  /**
   * Result from `queryAnalytics`. Renders the banner only when the
   * backend confirmed this queryType isn't served in the current
   * analytics mode (200 with { unsupported: true, reason }). Otherwise
   * returns null — safe to drop into any tab unconditionally.
   */
  result: AnalyticsResult | null | undefined;
}

/**
 * Per-tab honest-empty banner. The global banner in AdminDashboard
 * covers most tabs, but Experiments / Conversations / UserManagement /
 * Strategy are excluded there because they have their own sub-views.
 * Drop this above the affected sub-view to surface "Aurora-only" to
 * the user instead of a silently-empty table.
 */
const UnsupportedAnalyticsBanner: React.FC<Props> = ({ result }) => {
  const { t } = useTranslation();
  if (!result || result.unsupported !== true) return null;

  // The "redeploy with analyticsMode=aurora" hint only applies in Athena mode
  // (the query needs Aurora). In Aurora mode the query simply isn't implemented
  // yet — redeploying changes nothing — so show only the backend's reason.
  const inAurora = import.meta.env.VITE_ANALYTICS_MODE === 'aurora';

  return (
    <div className="admin-info-banner">
      <strong>{t('admin.banners.unsupportedTitle')}</strong>{' '}
      {result.reason}
      {!inAurora && (
        <>
          {' '}
          <span>
            {t('admin.banners.unsupportedBody')}
            <code>--context analyticsMode=aurora</code>.
          </span>
        </>
      )}
    </div>
  );
};

export default UnsupportedAnalyticsBanner;
