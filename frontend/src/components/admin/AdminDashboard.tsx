import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { queryAnalytics } from '../../services/analyticsService';
import OverviewTab from './OverviewTab';
import ModelsTab from './ModelsTab';
import EvaluationsTab from './EvaluationsTab';
import UsersTab from './UsersTab';
import FlowsTab from './FlowsTab';
import StepsTab from './StepsTab';
import FlaggedResponsesTab from './FlaggedResponsesTab';
import GroundTruthTab from './GroundTruthTab';
import TasksTab from './TasksTab';
import EffectivenessTab from './EffectivenessTab';
import ConversationsTab from './ConversationsTab';
import LatencyTab from './LatencyTab';
import UserManagementTab from './UserManagementTab';
import ModelStrategyTab from './ModelStrategyTab';
import ExperimentsTab from './ExperimentsTab';
import './UserManagementTab.css';
import { trackEvent } from '../../services/eventTrackingService';
import type { AnalyticsDateRange, AnalyticsResult, QueryType } from '../../types/analytics';
import './AdminDashboard.css';
import MembershipAuditTab from './MembershipAuditTab';

type TabId = 'overview' | 'models' | 'strategy' | 'steps' | 'experiments' | 'evaluations' | 'latency' | 'flows' | 'flagged' | 'ground_truth' | 'tasks' | 'effectiveness' | 'conversations' | 'users' | 'user_management' | 'security';

interface AdminDashboardProps {
  onBack: () => void;
  analyticsMode?: 'athena' | 'aurora';
}

function getDateRange(preset: string): AnalyticsDateRange {
  const end = new Date().toISOString().split('T')[0];
  const start = new Date();

  switch (preset) {
    case '7d':
      start.setDate(start.getDate() - 7);
      break;
    case '30d':
      start.setDate(start.getDate() - 30);
      break;
    case '90d':
      start.setDate(start.getDate() - 90);
      break;
    default:
      start.setDate(start.getDate() - 7);
  }

  return { start: start.toISOString().split('T')[0], end };
}

// Tabs available only in Aurora mode (hidden in Athena). Sub-view labels are
// resolved from i18n at render time via the tab id → admin.tabs.<camelCase> key.
const AURORA_TAB_IDS: TabId[] = ['flows', 'flagged', 'ground_truth', 'tasks', 'steps', 'effectiveness'];

// Two-level navigation: 6 top-level SECTIONS, each grouping one or more
// sub-views (the per-tab components). activeTab (TabId) remains the source of
// truth for content + data loading; the section rail just groups the sub-tabs.
interface AdminSection { id: string; label: string; tabs: TabId[]; }
const SECTIONS: AdminSection[] = [
  { id: 'overview', label: 'Overview', tabs: ['overview', 'latency'] },
  { id: 'conversations', label: 'Conversations', tabs: ['conversations'] },
  // Effectiveness is the intent-anchored spine (SPEC-ADMIN-CONSOLE-EFFECTIVENESS). The Dashboard is the
  // consolidation target: over successive iterations the full detail from Evaluations / Flows / Tasks /
  // Steps folds INTO its drill (L2 exchanges, L2 tasks, L3 timeline, L4 steps). Until each view's detail
  // is fully in the drill, its tab stays here so NO information is lost. Steps is grouped here (not
  // Models) since it is the tool-loop detail + the L4 leaf. Flagged / Ground Truth are human-action tabs.
  { id: 'quality', label: 'Effectiveness', tabs: ['effectiveness', 'evaluations', 'flows', 'tasks', 'steps', 'flagged', 'ground_truth'] },
  { id: 'models', label: 'Models', tabs: ['models', 'strategy'] },
  { id: 'experiments', label: 'Experiments', tabs: ['experiments'] },
  { id: 'users', label: 'Users', tabs: ['users', 'user_management'] },
  { id: 'security', label: 'Security', tabs: ['security'] },
];

// Flat list of every valid sub-tab id, for URL (`?admin=<tab>`) validation.
const ALL_TAB_IDS: TabId[] = SECTIONS.flatMap((s) => s.tabs);
/** The tab named by the `?admin=<tab>` query param, if it is a valid sub-tab. */
function tabFromUrl(): TabId | null {
  const v = new URLSearchParams(window.location.search).get('admin');
  return v && (ALL_TAB_IDS as string[]).includes(v) ? (v as TabId) : null;
}

/** Map a TabId to its i18n key under admin.tabs.* */
function tabI18nKey(id: TabId): string {
  const camelCase = id.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  // user_management → userManagement, ground_truth → groundTruth
  const key = camelCase === 'userManagement' ? 'manageUsers' : camelCase;
  return `admin.tabs.${key}`;
}

// Single source of truth for which queryTypes each tab requests. The
// banner block reads this to know which results belong to the current
// tab (vs leftovers from prior tab switches), and loadData() reads it
// to fan out the actual fetches. Aurora-only queries listed here are
// still requested in Athena mode - the backend returns 200 + unsupported
// and the dashboard renders an honest "Aurora-only" banner instead of a
// silently-empty table.
const QUERIES_BY_TAB: Partial<Record<TabId, QueryType[]>> = {
  overview: [
    'conversation_volumes',
    'intent_distribution',
    // Client-events health bands.
    'active_users_daily' as QueryType,
    'active_messaging_users_daily' as QueryType,
    'error_rate_daily' as QueryType,
  ],
  models: ['model_usage', 'model_effectiveness'],
  steps: ['execution_steps' as QueryType],
  experiments: ['experiment_results' as QueryType],
  evaluations: ['evaluation_scores'],
  latency: [
    'latency_metrics' as QueryType,
    // Client-events page-load + connection health.
    'page_load_metrics' as QueryType,
    'connection_health_daily' as QueryType,
  ],
  flows: ['evaluation_flows'],
  flagged: ['flagged_responses'],
  ground_truth: ['ground_truth'],
  tasks: ['task_metrics', 'task_details' as QueryType],
  effectiveness: ['intent_effectiveness' as QueryType],
  conversations: ['conversation_summaries', 'drift_events'],
  users: [
    'user_activity', // partition-only fallback
    // Client-events per-user + funnels + DAU breakdown.
    'active_users_daily' as QueryType,
    'active_messaging_users_daily' as QueryType,
    'messages_per_user' as QueryType,
    'signup_funnel_conversion' as QueryType,
    'signin_funnel_conversion' as QueryType,
  ],
};

const AdminDashboard: React.FC<AdminDashboardProps> = ({ onBack, analyticsMode = 'athena' }) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>(() => tabFromUrl() ?? 'overview');
  const [datePreset, setDatePreset] = useState('7d');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, AnalyticsResult | null>>({});
  // Cross-tab deep-link: a Flagged/Ground-Truth row's "conversation" link sets the
  // target channel and jumps to the Conversations tab, which opens that channel's
  // detail page and clears the link (via onDeepLinkConsumed) so it fires once.
  const [conversationDeepLink, setConversationDeepLink] = useState<string | null>(null);

  // Aurora-only sub-views are hidden in Athena mode (their content would just
  // honest-empty). activeTab drives content; activeSection groups the sub-tabs.
  const isTabAvailable = (id: TabId) => analyticsMode === 'aurora' || !AURORA_TAB_IDS.includes(id);
  const activeSection = SECTIONS.find((s) => s.tabs.includes(activeTab)) ?? SECTIONS[0];
  const subTabs = activeSection.tabs.filter(isTabAvailable);

  // Deep-linking + Back/forward: the active sub-tab is reflected in `?admin=<tab>`.
  // App.tsx owns the `?admin` PRESENCE (console open/closed); this owns the tab VALUE.
  // Selecting a tab pushes a history entry so browser Back steps through tabs; popstate
  // syncs the tab from the URL; `?admin=<tab>` deep-links straight to a tab.
  const selectTab = useCallback((tab: TabId) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set('admin', tab);
    window.history.pushState({}, '', url);
  }, []);

  // Open a specific conversation's detail from another tab (Flagged / Ground Truth).
  // Sets the deep-link target, then switches to the Conversations tab; that tab reads
  // deepLinkChannelArn, opens the detail page, and calls onDeepLinkConsumed.
  const openConversation = useCallback((channelArn: string) => {
    if (!channelArn) return;
    setConversationDeepLink(channelArn);
    selectTab('conversations');
  }, [selectTab]);

  // A tab can register a "close the drill-down first" handler (e.g. the Conversations
  // tab's open conversation detail). Opening that detail is React state, not a history
  // entry, so without this the global Back would walk the TAB history and skip past the
  // list — jumping "too far". When a detail is open, Back closes it (→ list) first.
  const drillBackRef = useRef<(() => void) | null>(null);
  const registerDrillBack = useCallback((fn: (() => void) | null) => {
    drillBackRef.current = fn;
  }, []);

  // In-app "Back": if a tab has an open drill-down, close that one level first.
  // Otherwise walk the browser history we've been pushing, so Back steps to the
  // previously-viewed admin tab (popstate syncs it), and popping past the first admin
  // tab returns to the app (App.tsx exits the console). Admin is auth-gated, so there
  // is always an app/login entry behind it; if somehow there is nothing behind (admin
  // was the very first page), fall back to the in-app exit so we never leave the site.
  const handleBack = useCallback(() => {
    if (drillBackRef.current) {
      drillBackRef.current();
      return;
    }
    if (window.history.length > 1) {
      window.history.back();
    } else {
      onBack();
    }
  }, [onBack]);

  // On open, normalize the URL to the active tab (App.tsx opens with `?admin=1`) without
  // adding a history entry, so the URL is deep-linkable and Back is consistent.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('admin') !== activeTab) {
      url.searchParams.set('admin', activeTab);
      window.history.replaceState({}, '', url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browser Back/forward within the console: sync the active tab from the URL. When Back
  // pops past the console entirely (no `?admin`), App.tsx exits the console (unmounts us).
  useEffect(() => {
    const onPop = () => {
      const t = tabFromUrl();
      if (t) setActiveTab(t);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const loadData = useCallback(async () => {
    const dateRange = getDateRange(datePreset);
    setIsLoading(true);
    setError(null);

    const queries: QueryType[] = [...(QUERIES_BY_TAB[activeTab] ?? [])];
    // Evaluations tab adds the per-exchange detail in Aurora mode only;
    // it's not part of the base contract because Athena can't serve it.
    if (activeTab === 'evaluations' && analyticsMode === 'aurora') {
      queries.push('evaluation_exchanges');
    }

    try {
      const queryResults = await Promise.all(
        queries.map(async (q) => {
          try {
            return { key: q, result: await queryAnalytics(q, dateRange) };
          } catch {
            return { key: q, result: null };
          }
        })
      );

      const newResults: Record<string, AnalyticsResult | null> = {};
      for (const { key, result } of queryResults) {
        newResults[key] = result;
      }
      setResults((prev) => ({ ...prev, ...newResults }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
    } finally {
      setIsLoading(false);
    }
  }, [activeTab, datePreset, analyticsMode]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Track admin tab views
  useEffect(() => {
    try {
      trackEvent('admin_tab_viewed', { tab: activeTab });
    } catch {
      // Tracking must never break the dashboard
    }
  }, [activeTab]);

  const handleReviewResponse = async (exchangeId: string, action: 'approved' | 'rejected', notes: string) => {
    try {
      await queryAnalytics('flagged_responses' as QueryType, getDateRange(datePreset), {
        action: 'review',
        exchangeId,
        reviewAction: action,
        notes,
      });
      loadData(); // Refresh
    } catch (err) {
      setError(`Failed to submit review: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const handleSubmitGroundTruth = async (exchangeId: string, score: number, classification: string, reasoning: string) => {
    try {
      await queryAnalytics('ground_truth' as QueryType, getDateRange(datePreset), {
        action: 'submit',
        exchangeId,
        score,
        classification,
        reasoning,
      });
      loadData(); // Refresh
    } catch (err) {
      setError(`Failed to submit score: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const datePresetLabel = (preset: string) => {
    if (preset === '7d') return t('admin.header.last7Days');
    if (preset === '30d') return t('admin.header.last30Days');
    return t('admin.header.last90Days');
  };

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <div className="admin-header-left">
          <button
            className="admin-back-btn"
            onClick={handleBack}
            aria-label={t('admin.header.backAria')}
          >
            {t('admin.header.back')}
          </button>
          <h2>{t('admin.header.title')}</h2>
          {analyticsMode === 'aurora' && (
            <span className="status-badge status-badge--live">{t('admin.header.auroraBadge')}</span>
          )}
        </div>
        <div className="admin-date-selector">
          {['7d', '30d', '90d'].map((preset) => (
            <button
              key={preset}
              className={`admin-date-btn ${datePreset === preset ? 'active' : ''}`}
              onClick={() => setDatePreset(preset)}
            >
              {datePresetLabel(preset)}
            </button>
          ))}
        </div>
      </div>

      <nav className="admin-section-rail" role="tablist" aria-label={t('admin.tablistAria')}>
        {SECTIONS.map((section) => {
          const tabs = section.tabs.filter(isTabAvailable);
          if (tabs.length === 0) return null;
          const active = section.id === activeSection.id;
          return (
            <button
              key={section.id}
              role="tab"
              aria-selected={active}
              className={`admin-section-btn ${active ? 'active' : ''}`}
              onClick={() => { if (!section.tabs.includes(activeTab)) selectTab(tabs[0]); }}
            >
              {section.label}
            </button>
          );
        })}
      </nav>

      {subTabs.length > 1 && (
        <div className="admin-subtabs" role="tablist" aria-label={`${activeSection.label} views`}>
          {subTabs.map((tabId) => (
            <button
              key={tabId}
              role="tab"
              aria-selected={activeTab === tabId}
              aria-controls={`admin-tabpanel-${tabId}`}
              id={`admin-tab-${tabId}`}
              className={`admin-subtab-btn ${activeTab === tabId ? 'active' : ''}`}
              onClick={() => selectTab(tabId)}
            >
              {t(tabI18nKey(tabId))}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="admin-error">
          <span>{error}</span>
          <button onClick={loadData}>{t('common.retry')}</button>
        </div>
      )}

      <div className="admin-content" role="tabpanel" id={`admin-tabpanel-${activeTab}`} aria-labelledby={`admin-tab-${activeTab}`}>
        {!isLoading && activeTab !== 'user_management' && activeTab !== 'strategy' && activeTab !== 'conversations' && activeTab !== 'experiments' && activeTab !== 'security' && (() => {
          // Only inspect results for queries the *current* tab actually requested,
          // not the union of every previously-viewed tab's results. Otherwise a
          // stale Aurora-only result from a prior tab would mis-banner the
          // current one.
          const tabQueries = QUERIES_BY_TAB[activeTab] ?? [];
          const tabResults = tabQueries.map(q => results[q]).filter(r => r !== undefined);
          const hasData = tabResults.some(r => r && r.data && r.data.length > 0);
          const allFailed = tabResults.length > 0 && tabResults.every(r => r === null);
          // unsupported = backend confirmed this queryType isn't served in this
          // analytics mode (200 + { unsupported: true, reason }). Distinct from
          // "API down" (allFailed) and "no rows yet" (!hasData).
          const unsupportedResult = tabResults.find(r => r && r.unsupported === true) ?? null;

          if (allFailed) {
            return (
              <div className="admin-info-banner">
                <strong>{t('admin.banners.apiUnavailableTitle')}</strong>{' '}
                {t('admin.banners.apiUnavailableBody')}
              </div>
            );
          }
          // Only let an unsupported query banner the whole tab when NOTHING
          // else rendered. If a sibling query returned data (e.g. Overview's
          // conversation_volumes works while a client-events band is Aurora-
          // unsupported), show the tab and let each widget's own empty state
          // stand, rather than blanking a working page.
          if (unsupportedResult && !hasData) {
            return (
              <div className="admin-info-banner">
                <strong>{t('admin.banners.unsupportedTitle')}</strong>{' '}
                {unsupportedResult.reason}{' '}
                {analyticsMode === 'athena' && (
                  <span>{t('admin.banners.unsupportedBody')}<code>--context analyticsMode=aurora</code>.</span>
                )}
              </div>
            );
          }
          if (!hasData && tabResults.length > 0) {
            return (
              <div className="admin-info-banner">
                <strong>{t('admin.banners.noDataTitle')}</strong>{' '}
                {t('admin.banners.noDataBody')}
                {analyticsMode === 'athena' && (
                  <span> {t('admin.banners.auroraUpgrade')}<code>--context analyticsMode=aurora</code> for real-time per-message analytics, drift detection, and cross-conversation context.</span>
                )}
              </div>
            );
          }
          return null;
        })()}

        {activeTab === 'overview' && (
          <OverviewTab
            volumeData={results.conversation_volumes ?? null}
            intentData={results.intent_distribution ?? null}
            activeUsersData={results.active_users_daily ?? null}
            messagingUsersData={results.active_messaging_users_daily ?? null}
            errorRateData={results.error_rate_daily ?? null}
            isLoading={isLoading}
          />
        )}
        {activeTab === 'models' && (
          <ModelsTab
            data={results.model_usage ?? null}
            effectivenessData={results.model_effectiveness ?? null}
            isLoading={isLoading}
          />
        )}
        {activeTab === 'strategy' && <ModelStrategyTab />}
        {activeTab === 'experiments' && (
          <ExperimentsTab
            resultsData={results.experiment_results ?? null}
            isLoading={isLoading}
          />
        )}
        {activeTab === 'evaluations' && (
          <EvaluationsTab data={results.evaluation_scores ?? null} isLoading={isLoading} />
        )}
        {activeTab === 'latency' && (
          <LatencyTab
            data={results.latency_metrics ?? null}
            pageLoadData={results.page_load_metrics ?? null}
            connectionHealthData={results.connection_health_daily ?? null}
            isLoading={isLoading}
          />
        )}
        {activeTab === 'flows' && (
          <FlowsTab data={results.evaluation_flows ?? null} isLoading={isLoading} />
        )}
        {activeTab === 'steps' && (
          <StepsTab data={results.execution_steps ?? null} isLoading={isLoading} />
        )}
        {activeTab === 'flagged' && (
          <FlaggedResponsesTab
            data={results.flagged_responses ?? null}
            isLoading={isLoading}
            onReview={handleReviewResponse}
            onOpenConversation={openConversation}
          />
        )}
        {activeTab === 'ground_truth' && (
          <GroundTruthTab
            data={results.ground_truth ?? null}
            isLoading={isLoading}
            onSubmitScore={handleSubmitGroundTruth}
            onOpenConversation={openConversation}
          />
        )}
        {activeTab === 'tasks' && (
          <TasksTab
            metricsData={results.task_metrics ?? null}
            detailData={results.task_details ?? null}
            isLoading={isLoading}
          />
        )}
        {activeTab === 'effectiveness' && (
          <EffectivenessTab
            data={results.intent_effectiveness ?? null}
            dateRange={getDateRange(datePreset)}
            isLoading={isLoading}
          />
        )}
        {activeTab === 'conversations' && (
          <ConversationsTab
            summaryData={results.conversation_summaries ?? null}
            driftData={results.drift_events ?? null}
            isLoading={isLoading}
            deepLinkChannelArn={conversationDeepLink}
            onDeepLinkConsumed={() => setConversationDeepLink(null)}
            registerBack={registerDrillBack}
          />
        )}
        {activeTab === 'users' && (
          <UsersTab
            data={results.user_activity ?? null}
            activeUsersData={results.active_users_daily ?? null}
            messagingUsersData={results.active_messaging_users_daily ?? null}
            messagesPerUserData={results.messages_per_user ?? null}
            signupFunnelData={results.signup_funnel_conversion ?? null}
            signinFunnelData={results.signin_funnel_conversion ?? null}
            isLoading={isLoading}
          />
        )}
        {activeTab === 'user_management' && (
          <UserManagementTab />
        )}
        {activeTab === 'security' && <MembershipAuditTab />}
      </div>
    </div>
  );
};

export default AdminDashboard;
