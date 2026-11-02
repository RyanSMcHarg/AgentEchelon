import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { queryAnalytics, writeAnalytics } from '../../services/analyticsService';
import OverviewTab from './OverviewTab';
import ModelsTab from './ModelsTab';
import EvaluationsTab from './EvaluationsTab';
import UsersTab from './UsersTab';
import AlertsTab from './AlertsTab';
import FlaggedResponsesTab from './FlaggedResponsesTab';
import GroundTruthTab, { type LabelHalves } from './GroundTruthTab';
import EffectivenessTab, { type Drill as EffectivenessDrill } from './EffectivenessTab';
import ProfilesTab from './ProfilesTab';
import { GUEST_EXPERIENCE_SHOWN } from '../../config/guestExperience';
import ConversationsTab from './ConversationsTab';
import { messageLinkFromSearch, writeMessageLink, type MessageLink } from './messageLink';
import LatencyTab from './LatencyTab';
import PerformanceTab, { flowParams, type PerfView } from './PerformanceTab';
import ClientTab from './ClientTab';
import { filtersFromUrl, syncFiltersToUrl, type PerformanceFilters } from './PerformanceFilters';
import OperationsTab from './OperationsTab';
import UserManagementTab from './UserManagementTab';
import ModelStrategyTab from './ModelStrategyTab';
import ExperimentsTab from './ExperimentsTab';
import ReasonDialog from './ReasonDialog';
import { useCan, useConsoleAccess } from '../../capabilities';
import { setTeamAssistant, teamAssistant, teamCanQuery } from '../../services/teamScope';
import ClassifierGatePanel from './ClassifierGatePanel';
import TeamIdentity from './TeamIdentity';
import './UserManagementTab.css';
import { trackEvent } from '@ae/shared';
import type { AnalyticsDateRange, AnalyticsResult, QueryType } from '@ae/shared';
import './AdminDashboard.css';
import MembershipAuditTab from './MembershipAuditTab';
import AccessLogTab from './AccessLogTab';
import TurnKinds from './TurnKinds';
import { UnservedSubjects } from './UnservedSubjects';
import Handovers from './Handovers';
import { experimentsAvailable } from '../../services/experimentsService';
import { intentFromUrl, linkFilters, stepFromUrl, withIntentParam, type AssistantLink } from './assistantLinks';

type TabId = 'overview' | 'alerts' | 'models' | 'strategy' | 'profiles' | 'experiments' | 'classifier_gate' | 'evaluations' | 'latency' | 'flagged' | 'ground_truth' | 'effectiveness' | 'conversations' | 'users' | 'user_management' | 'security' | 'access_log' | 'client' | 'queue' | 'answer_types';

/**
 * The capability a tab reads with, so a role that does not hold it is never shown the tab
 * (SPEC-ADMIN-CONSOLE FR0f). The keys are the capability catalog's (`admin-capabilities.ts`).
 */
/**
 * THE TABS A TEAM MEMBER'S ROUTES SERVE (SPEC-ADMIN-CONSOLE FR48). A team member reaches one assistant's
 * profile, experiments, conversations, and the analytics that are attributed per assistant; every
 * other tab reads something across assistants or classifications, so it is absent for them rather than
 * present and refusing.
 */
export const TEAM_TABS: ReadonlySet<TabId> = new Set<TabId>(['effectiveness', 'latency', 'answer_types', 'models', 'flagged', 'ground_truth', 'profiles', 'experiments', 'conversations']);
/** The team tabs served in Athena mode, which has no team analytics or conversation route. */
export const TEAM_TABS_ATHENA: ReadonlySet<TabId> = new Set<TabId>(['profiles', 'experiments']);

/**
 * Whether a team member's console shows a tab. A team's analytics and conversation routes are served in
 * Aurora mode only, so in Athena mode a team keeps its profile and experiments. A team that owns no
 * assistant yet has nothing to scope any other view to, so it sees Assistants alone, where it creates one.
 */
export function isTabAvailableToTeam(id: TabId, mode: 'athena' | 'aurora', ownsNone: boolean): boolean {
  if (ownsNone) return id === 'profiles';
  return TEAM_TABS.has(id) && (mode === 'aurora' || TEAM_TABS_ATHENA.has(id));
}

export const TAB_CAPABILITY: Record<TabId, string> = {
  overview: 'view-analytics',
  alerts: 'view-analytics',
  client: 'view-analytics',
  effectiveness: 'view-analytics',
  latency: 'view-analytics',
  answer_types: 'view-analytics',
  queue: 'view-analytics',
  evaluations: 'view-analytics',
  flagged: 'view-analytics',
  ground_truth: 'view-analytics',
  models: 'view-analytics',
  strategy: 'view-analytics',
  conversations: 'view-conversations',
  security: 'view-security',
  access_log: 'view-access-log',
  profiles: 'view-profiles',
  experiments: 'view-experiments',
  classifier_gate: 'view-experiments',
  users: 'view-user-activity',
  user_management: 'view-users',
};

interface AdminDashboardProps {
  onBack: () => void;
  analyticsMode?: 'athena' | 'aurora';
}

/**
 * The presets, and the days each one spans. ONE TABLE, so a preset cannot exist as a button with no
 * window behind it: DATE_PRESETS is what the selector renders AND what getDateRange reads, and a
 * preset with no entry here is a compile error rather than a silent fall-through.
 *
 * That fall-through is why this is a table. The switch it replaces had cases for 7d, 30d and 90d and
 * a `default` that quietly returned seven days, so a shorter window - the one an operator reaches for
 * when checking whether something landed - was served as a week without saying so.
 *
 * The bounds are YYYY-MM-DD, and both analytics modes read a range as whole UTC days from start through
 * end. So an N-day preset is the N calendar days ending today (start = today - (N - 1)), and its span
 * matches its label. '24h' is the exception, because no calendar window is 24 hours: it is yesterday
 * through today, the smallest calendar window that always contains the last 24 hours.
 */
export const DATE_PRESETS = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
} as const;

export type DatePreset = keyof typeof DATE_PRESETS;

/**
 * One label key per preset, keyed off the preset rather than a chain of ifs whose last branch
 * answered for anything it did not recognize - which is how a fourth preset would have rendered as
 * "Last 90 days". `Record<DatePreset, string>` makes adding a preset without its copy a compile
 * error, and the copy itself stays in the locale file rather than as English in this component.
 */
const DATE_PRESET_LABEL_KEYS: Record<DatePreset, string> = {
  '24h': 'admin.header.last24Hours',
  '7d': 'admin.header.last7Days',
  '30d': 'admin.header.last30Days',
  '90d': 'admin.header.last90Days',
};

export function getDateRange(preset: DatePreset): AnalyticsDateRange {
  const end = new Date().toISOString().split('T')[0];
  const start = new Date();
  start.setDate(start.getDate() - (preset === '24h' ? 1 : DATE_PRESETS[preset] - 1));
  return { start: start.toISOString().split('T')[0], end };
}

// Tabs available only in Aurora mode (hidden in Athena). Sub-view labels are
// resolved from i18n at render time via the tab id → admin.tabs.<camelCase> key.
// Aurora-only sub-views still reachable from the nav. (flows/tasks/steps were retired from SECTIONS —
// their detail folded into the Effectiveness drill — so they no longer appear here.) Alerts leans on
// the Aurora-only effectiveness/model-effectiveness data, so it is Aurora-only too.
const AURORA_TAB_IDS: TabId[] = ['flagged', 'ground_truth', 'effectiveness', 'alerts'];

// Tabs available only in ATHENA mode (hidden in Aurora). `evaluations` is the basic daily
// evaluation-score view; in Aurora the richer per-intent Effectiveness drill supersedes it, but Athena
// has no drill, so it stays the reachable eval surface there. (Without this, retiring `evaluations`
// from the nav left Athena mode with NO evaluation UI even though evaluation_scores is still served —
// the B6 regression from 8f143e3.)
const ATHENA_ONLY_TAB_IDS: TabId[] = ['evaluations'];

// Tabs that read experiment administration, which a deployment serves only when `VITE_ADMIN_API_CAPABILITIES`
// names `experiments`. Without it there is no route behind them, so they are hidden.
const EXPERIMENT_TAB_IDS: TabId[] = ['experiments', 'classifier_gate'];

/**
 * Whether a sub-tab is available in the given analytics mode (pure, exported for testing). Aurora-only
 * tabs are hidden in Athena; Athena-only tabs (the basic evaluation view) are hidden in Aurora; every
 * other tab is available in both. A section with no available tab is hidden entirely, so this is what
 * decides whether the Performance section (hence any evaluation UI) shows in Athena mode (B6).
 */
export function isTabAvailableIn(id: TabId, mode: 'athena' | 'aurora'): boolean {
  if (ATHENA_ONLY_TAB_IDS.includes(id)) return mode !== 'aurora';
  return mode === 'aurora' || !AURORA_TAB_IDS.includes(id);
}

// Two-level navigation: 7 top-level SECTIONS, each grouping one or more
// sub-views (the per-tab components). activeTab (TabId) remains the source of
// truth for content + data loading; the section rail just groups the sub-tabs.
interface AdminSection { id: string; label: string; tabs: TabId[]; }
/**
 * FOUR SURFACES, EACH ANSWERING ONE QUESTION FROM ONE STORE (SPEC-ADMIN-CONSOLE, Overview).
 *
 * Cited by section TITLE rather than by number: the spec is organized by prose headings, and a
 * numbered citation goes stale the moment a section is added above it.
 *
 * The sections below used to be grouped by what was nearest when each view was built, and the cost
 * showed most on the Latency sub-tab, which held six unrelated things: server latency legs, client
 * web vitals, WebSocket health, queue depth, a browser-versus-server diagnostic and a duel filter.
 * Two of those were not read from the same store as the rest, so the page invited a reader to compare
 * numbers sharing neither a clock, a population, nor a refresh cadence.
 *
 *   Performance  how fast and how good, sliced by assistant   Aurora projection   a range you choose
 *   Client       what the BROWSER experienced                 client_events       a range you choose
 *   Operations   is it healthy RIGHT NOW                      CloudWatch          now
 *   Oversight    what was said, by whom, and who looked       archive + Chime     a matter
 *
 * The four are the MONITORING and OVERSIGHT half. Models, Assistants, Experiments and Users are
 * configuration surfaces and keep their own sections: they are not answering a question about
 * traffic, so folding them into this scheme would make the scheme mean less rather than more.
 *
 * THIS CHANGES HOW THE DATA IS ORGANIZED, NEVER WHO MAY SEE IT. Scoping stays where it is enforced,
 * on the IAM-backed capability behind each read (DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT), which is what
 * lets one console serve a platform administrator and a team scoped to its own use cases without a
 * second surface being built for either.
 */
export const SECTIONS: AdminSection[] = [
  // OPERATIONS LEADS, and its Dashboard is where the console opens. An operator arrives asking
  // "is anything wrong right now", not "how did last week compare" - so the surface that answers
  // now is the one in front of them, and the two that answer about a range come after it.
  //
  // CLIENT IS A SUB-VIEW HERE rather than a section of its own. It asks the same operational
  // question from the browser's side - are people's page loads and sockets healthy - and a
  // top-level section holding one tab is the shape 'Security' was just corrected out of.
  { id: 'operations', label: 'Operations', tabs: ['overview', 'alerts', 'client'] },
  // PERFORMANCE SECOND: how fast and how good, over a window you choose.
  //
  // QUEUE MOVED HERE FROM OPERATIONS, and the reason is the message flow rather
  // than tidiness. Waiting in the queue is a STEP a turn takes: a message sent while the assistant is
  // busy is held, and that wait is part of what the person experienced. The Latency tab now reads as
  // the flow itself, so the step that happens before a turn starts belongs beside it, not on the
  // surface that answers "is anything wrong right now".
  //
  // IT ALSO READS A RANGE, which is what the section is defined by: `QueueHealth` takes the same
  // dateRange every other Performance view takes, so it was already answering a Performance-shaped
  // question from an Operations-shaped home. The one thing it does NOT share is the store - it reads
  // CloudWatch rather than the Aurora projection - and the tab says so itself rather than leaving a
  // reader to assume one clock and one cadence across the section.
  // ONE VIEW, NOT TWO TABS. `effectiveness` is the Performance overview now: the cards
  // and the message flow, with Effectiveness and Latency as the drills a click opens. `latency` stays a
  // valid id so an old link or an alert still lands, on that drill.
  { id: 'performance', label: 'Performance', tabs: ['effectiveness', 'answer_types', 'queue', 'evaluations', 'flagged', 'ground_truth'] },
  // PERFORMANCE holds the two views of one population: how fast a turn was, and how good it was.
  // They are the same rows read two ways, which is why they now share one filter set rather than each
  // inventing its own.
  // CLIENT is browser-side measurement, from client_events. Separate because it is a separate store
  // (gap G5 in LATENCY-TARGETS), not because the Latency tab was crowded.
  // OPERATIONS answers "now" from CloudWatch. Alerts belongs here for the same reason queue health
  // does: an operator reads it to decide whether to act today, not to understand last week.
  // OVERSIGHT, not "Moderation". SPEC-MODERATION keeps channel-scoped moderator `redact` distinct
  // from cross-conversation admin `delete`, and a browse-every-conversation view is administration;
  // naming the parent for the narrower authority is the conflation the identity model exists to
  // prevent. Moderation is what you DO to a message inside it, and the button already says so.
  //
  // Membership Audit moves in here too. It was a top-level section called "Security" whose only child
  // was labeled something else, which teaches nobody where to look.
  { id: 'oversight', label: 'Oversight', tabs: ['conversations', 'security', 'access_log'] },
  { id: 'models', label: 'Models', tabs: ['models', 'strategy'] },
  // Assistant profiles as versioned, portable artifacts (SPEC-PORTABLE-PROFILES): version /
  // activate / rollback / import / export the assistant definition, no redeploy. The retiring global
  // "Model Strategy" surface (per-intent routing) is moving onto the profile here.
  { id: 'assistants', label: 'Assistants', tabs: ['profiles'] },
  // EXPERIMENTS HAVE A GOAL AND RESULTS, AND MAY RUN BATTLES. A battle is a sub-result of its experiment
  // (someone in Battle Mode gets both versions' answers over a few turns and picks one), so battles are
  // read on the experiment's page and have no view of their own. Classifier accuracy is a different
  // thing: a check on how well conversations are sorted into intents, and the gate on classifier
  // changes. It is never a team's, since it acts on a whole classification.
  { id: 'experiments', label: 'Experiments', tabs: ['experiments', 'classifier_gate'] },
  { id: 'users', label: 'Users', tabs: ['users', 'user_management'] },
];

// Flat list of every valid sub-tab id, for URL (`?admin=<tab>`) validation.
const ALL_TAB_IDS: TabId[] = SECTIONS.flatMap((s) => s.tabs);
/** The tab named by the `?admin=<tab>` query param, if it is a valid sub-tab. */
function tabFromUrl(): TabId | null {
  const v = new URLSearchParams(window.location.search).get('admin');
  // `latency` is no longer a tab but stays a valid link: an old bookmark or an alert lands on the
  // Performance view at its latency detail (the redirect below), never on the default tab.
  // Battles are read on their experiment's page, so a link to the retired Battles or Duels view lands on
  // Experiments: the list, or the experiment the link names (`&exp=`).
  if (v === 'battles' || v === 'duels') return 'experiments';
  return v && ((ALL_TAB_IDS as string[]).includes(v) || v === 'latency') ? (v as TabId) : null;
}

// Deep link to a specific conversation detail: `?conv=<channelId>`. A single app
// instance backs every conversation, so the short channel id is enough — we
// reconstruct the full ARN the read path needs. Accepts a full ARN too (defensive).
function convFromUrl(): string | null {
  const id = new URLSearchParams(window.location.search).get('conv');
  if (!id) return null;
  if (id.includes(':')) return id;
  const appInstance = import.meta.env.VITE_APP_INSTANCE_ARN as string | undefined;
  return appInstance ? `${appInstance}/channel/${id}` : null;
}

// With `?conv=`, the message to open at: `&msg=<MessageId>&at=<iso>` (see messageLink.ts).
function messageLinkFromUrl(): MessageLink | null {
  return convFromUrl() ? messageLinkFromSearch(window.location.search) : null;
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
/**
 * TABS THAT ASK FOR NOTHING HERE, AND WHY EACH ONE IS ALLOWED TO.
 *
 * Exported with the map beside it so a test can assert that every tab in `SECTIONS` is in one list or
 * the other. Without that pairing an absent entry is invisible: a tab that renders shared constants
 * and a tab whose fetch was forgotten look identical from here, and one of them shows an operator an
 * empty page that blames the data.
 */
export const TABS_THAT_FETCH_NOTHING_HERE: Partial<Record<TabId, string>> = {
  strategy: 'Renders the shipped routing and capability constants. No query, in any mode.',
  security: 'Membership Audit reads findings and the enforce flag through membershipAuditService.',
  access_log: 'accessLogService (admin/access-log)',
  user_management: 'Reads the roster through its own user-management API, and not at all under an external IdP.',
  profiles: 'Reads the profile registry through profileService.',
  queue: 'Reads GET /analytics/queue-health through analyticsService, outside this fan-out.',
  answer_types: 'TurnKinds issues its own turn_kinds query when it mounts.',
  classifier_gate: 'Its component issues its own reads when it mounts.',
};

export const QUERIES_BY_TAB: Partial<Record<TabId, QueryType[]>> = {
  overview: [
    'conversation_volumes',
    'intent_distribution',
    // Client-events health bands.
    'active_users_daily' as QueryType,
    'active_messaging_users_daily' as QueryType,
    'error_rate_daily' as QueryType,
  ],
  // Alerts scans everything that carries a target: per-intent quality, latency, per-model quality,
  // literal error-response rows, and the platform error rate. All assembled client-side (see alerts.ts).
  alerts: [
    'intent_effectiveness' as QueryType,
    'latency_metrics' as QueryType,
    'model_effectiveness' as QueryType,
    'flagged_responses' as QueryType,
    'error_rate_daily' as QueryType,
  ],
  models: ['model_usage', 'model_effectiveness'],
  experiments: ['experiment_results' as QueryType],
  evaluations: ['evaluation_scores'],
  // No `latency` entry: Latency is a drill of the Performance view (`effectiveness`), which fetches its rows.
  // PAGE AND CONNECTION ASKS FOR ITS OWN DATA. It renders `page_load_metrics` and
  // `connection_health_daily`, and having no entry here meant it fetched nothing: the tab was empty
  // until Latency had been opened in the same session, and the empty state told the operator there
  // was no data in the window rather than that nothing had been asked. That reads as "the browser
  // telemetry is not being collected", which is the opposite of true, and it is the failure
  // SPEC-ADMIN-CONSOLE FR26 exists to prevent - no table renders as silently empty or misleading.
  client: [
    'page_load_metrics' as QueryType,
    'connection_health_daily' as QueryType,
  ],
  flagged: ['flagged_responses'],
  ground_truth: ['ground_truth'],
  // `latency_metrics` IS FETCHED HERE FOR ITS AXES, not for its numbers.
  //
  // The shared filter bar derives its options from the rows it is given, and the effectiveness
  // rollup is GROUP BY intent - it carries no conversation_classification, agent_type or
  // assistant_role per row, so a bar fed only that data offers nothing and renders empty. The
  // latency rows are the same population at a different grain and DO carry all four axes.
  //
  // The alternative is a distinct-values endpoint, which is a backend change for a list the console
  // already has in hand on the sibling tab.
  // The Performance view and both of its drills read these: the flow, the per-intent rollup, and the
  // Latency detail's own rows (which also give the filter bar its axes).
  effectiveness: [
    'intent_effectiveness' as QueryType,
    'latency_metrics' as QueryType,
    'message_flow' as QueryType,
    'welcome_flow' as QueryType,
    'router_steps' as QueryType,
    'page_load_metrics' as QueryType,
  ],
  conversations: ['conversation_summaries', 'drift_events'],
  users: [
    'user_activity', // partition-only fallback
    // Client-events per-user + funnels + DAU breakdown.
    'active_users_daily' as QueryType,
    'active_messaging_users_daily' as QueryType,
    'messages_per_user' as QueryType,
    'signup_funnel_conversion' as QueryType,
    'signin_funnel_conversion' as QueryType,
    // The Guest panel and the guest-to-customer funnel (E6, B12): not run while the guest experience is hidden.
    ...(GUEST_EXPERIENCE_SHOWN ? ['guest_to_customer_funnel' as QueryType, 'guest_refusals' as QueryType] : []),
  ],
};

const AdminDashboard: React.FC<AdminDashboardProps> = ({ onBack, analyticsMode = 'athena' }) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>(() => tabFromUrl() ?? (convFromUrl() ? 'conversations' : 'overview'));
  const [datePreset, setDatePreset] = useState<DatePreset>('7d');
  // ONE OBJECT PER PRESET, NOT ONE PER RENDER. `getDateRange(datePreset)` was called inline in each
  // panel's props, so every render built a new object; panels that list `dateRange` in an effect
  // dependency saw a changed value every time and refetched. The CloudWatch-backed queue-health GET
  // therefore refired on unrelated dashboard state - a tab change, a filter - with no cancellation,
  // so a slow response could also land after a newer one and overwrite it.
  const dateRange = useMemo(() => getDateRange(datePreset), [datePreset]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, AnalyticsResult | null>>({});
  // Cross-tab deep-link: a Flagged/Ground-Truth row's "conversation" link sets the
  // target channel and jumps to the Conversations tab, which opens that channel's
  // detail page and clears the link (via onDeepLinkConsumed) so it fires once.
  // Initialized from `?conv=` so a shared link opens straight to the conversation detail.
  const [conversationDeepLink, setConversationDeepLink] = useState<string | null>(() => convFromUrl());
  // The message inside that conversation to open at, consumed with it.
  const [messageDeepLink, setMessageDeepLink] = useState<MessageLink | null>(() => messageLinkFromUrl());
  // Owned here (not in EffectivenessTab) so the drill position survives the tab unmounting on a tab
  // switch — e.g. "View conversation" jumps to Conversations and Back returns to the SAME drill (C2).
  /**
   * THE ONE FILTER SET THE PERFORMANCE SURFACES SHARE, held here because both of them read it.
   *
   * SEEDED FROM THE URL, so a link somebody was sent opens on the population they were looking at
   * rather than on everything. Written back on every change (replace, not push - narrowing a pill is
   * not navigation, and pushing would make Back walk one pill at a time).
   */
  const [perfFilters, setPerfFilters] = React.useState<PerformanceFilters>(() => filtersFromUrl());
  const applyPerfFilters = React.useCallback((next: PerformanceFilters) => {
    setPerfFilters(next);
    syncFiltersToUrl(next);
  }, []);

  // SEEDED FROM `?intent=` (and `?step=` beside it), as the filters are from theirs: a link to one intent's
  // Effectiveness opens on that intent, its step and model breakdown narrowed to the step the link names.
  const [effectivenessDrill, setEffectivenessDrill] = useState<EffectivenessDrill>(() => {
    const intent = intentFromUrl();
    const step = stepFromUrl();
    return intent ? { level: 1, intent, ...(step ? { step } : {}) } : { level: 0 };
  });
  // Where the Performance view is: the overview, or the detail a click opened. Lifted, like the drill, so
  // it survives opening a conversation and coming Back.
  const [perfView, setPerfView] = useState<PerfView>(() => {
    const intent = intentFromUrl();
    return intent ? { view: 'intent', key: intent } : { view: 'overview' };
  });
  const changePerfView = useCallback((next: PerfView, step: string | null = null) => {
    setPerfView(next);
    // The intent open is in the URL, replaced rather than pushed like the filters, so the view can be sent to someone.
    try {
      const search = withIntentParam(next.view === 'intent' ? next.key : null, window.location.search, step);
      window.history.replaceState(null, '', `${window.location.pathname}${search}${window.location.hash}`);
    } catch { /* a browser that refuses the write keeps the view; only the sharing is lost */ }
    // The Effectiveness drill a view embeds starts where the click asked: one intent, or every intent.
    if (next.view === 'intent') setEffectivenessDrill({ level: 1, intent: next.key, ...(step ? { step } : {}) });
    else if (next.view === 'quality') setEffectivenessDrill({ level: 0 });
  }, []);
  // ROLE AND VERSION LIVE HERE, NOT IN THE TAB, because the L0 rollup is fetched from this component.
  // Held in the tab they would filter the drill and leave the table above it unfiltered - the control
  // would look broken in the one place a person is looking when they use it.

  // Aurora-only sub-views are hidden in Athena mode (their content would just
  // honest-empty). activeTab drives content; activeSection groups the sub-tabs.
  const can = useCan();
  const access = useConsoleAccess();
  // A tab exists when the mode serves it AND the operator's role holds what it reads with.
  const isTeam = access.status === 'ready' && access.role === 'team-members';
  // A TEAM THAT OWNS NO ASSISTANT YET has nothing to scope any other view to, so its console is the
  // Assistants tab alone, where it creates one for itself.
  const teamOwnsNone = isTeam && access.assistants.length === 0;
  const isTabAvailable = (id: TabId) =>
    isTabAvailableIn(id, analyticsMode) && can(TAB_CAPABILITY[id])
    // Experiment administration exists only where AdminApi serves the `experiments` capability.
    && (!EXPERIMENT_TAB_IDS.includes(id) || experimentsAvailable())
    && (!isTeam || isTabAvailableToTeam(id, analyticsMode, teamOwnsNone));
  // The assistant a team member's console is scoped to; changing it remounts every view on the new one.
  const [scopedTo, setScopedTo] = useState<string | null>(() => teamAssistant());
  const chooseAssistant = (a: string) => {
    setTeamAssistant(a);
    setScopedTo(a);
  };
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
    // An open experiment belongs to the Experiments view; another view's URL does not carry it.
    if (tab !== 'experiments') url.searchParams.delete('exp');
    window.history.pushState({}, '', url);
  }, []);

  // Open a specific conversation's detail from another tab (Flagged / Ground Truth).
  // Sets the deep-link target, then switches to the Conversations tab; that tab reads
  // deepLinkChannelArn, opens the detail page, and calls onDeepLinkConsumed.
  // When a conversation is opened from ANOTHER tab (Effectiveness/Flagged/Ground-Truth), remember that
  // origin so Back returns THERE (with its drill state, which is lifted) instead of dropping onto the
  // Conversations list. AT4.
  const [conversationOrigin, setConversationOrigin] = useState<TabId | null>(null);
  // Read by the URL sync, which is stable: a conversation opened from another tab replaces the history
  // entry rather than adding one, so the browser's Back returns to that tab in one step too.
  const conversationOriginRef = useRef<TabId | null>(null);
  conversationOriginRef.current = conversationOrigin;
  // AN ASSISTANT'S ANALYTICS OPENED FROM ITS PAGE remember that assistant, as a conversation opened from another tab
  // remembers its tab (AT4): Back, in the console or the browser, returns to that assistant, not the list.
  const [assistantOrigin, setAssistantOrigin] = useState<string | null>(null);
  const assistantOriginRef = useRef<string | null>(null);
  const [reopenAssistant, setReopenAssistant] = useState<string | null>(null);
  // Handed to the Assistants tab once, when Back returns to it; leaving the tab spends it, so a later visit opens the list.
  useEffect(() => {
    if (activeTab !== 'profiles') setReopenAssistant(null);
  }, [activeTab]);
  // A caller that knows the message it is about (a battle's /battle message) hands it over, and the viewer opens at it.
  const openConversation = useCallback((channelArn: string, message?: MessageLink | null) => {
    if (!channelArn) return;
    setConversationOrigin(activeTab !== 'conversations' ? activeTab : null);
    setMessageDeepLink(message ?? null);
    setConversationDeepLink(channelArn);
    selectTab('conversations');
  }, [selectTab, activeTab]);

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
    // AT4: viewing a conversation opened from another tab → Back returns to that origin tab (drill preserved),
    // not to the Conversations list. One press gets you back where you were.
    if (conversationOrigin && activeTab === 'conversations') {
      const origin = conversationOrigin;
      setConversationOrigin(null);
      setConversationDeepLink(null);
      setMessageDeepLink(null);
      selectTab(origin);
      return;
    }
    if (assistantOrigin && activeTab === 'effectiveness') {
      setReopenAssistant(assistantOrigin);
      setAssistantOrigin(null);
      assistantOriginRef.current = null;
      selectTab('profiles');
      return;
    }
    if (drillBackRef.current) {
      drillBackRef.current();
      return;
    }
    if (window.history.length > 1) {
      window.history.back();
    } else {
      onBack();
    }
  }, [onBack, conversationOrigin, assistantOrigin, activeTab, selectTab]);

  // Reflect the open conversation detail in the URL (`?conv=<channelId>`), so a detail
  // is deep-linkable and browser Back/forward steps through it. The sync guard (current
  // === next) keeps a popstate-driven change from pushing a redundant history entry.
  // The message the detail opened at rides along (`&msg=`, `&at=`), so the shared link opens at it too.
  const updateConvUrl = useCallback((channelArn: string | null, message?: MessageLink | null) => {
    const url = new URL(window.location.href);
    const current = url.searchParams.get('conv');
    const next = channelArn ? channelArn.split('/').pop() ?? null : null;
    const messageChanged = writeMessageLink(url, next ? message ?? null : null);
    if (current === next && !messageChanged) return;
    if (current === next) {
      // The same conversation, now opened at (or no longer at) a message: the address is corrected, not a step added.
      window.history.replaceState({}, '', url);
      return;
    }
    if (next) url.searchParams.set('conv', next);
    else url.searchParams.delete('conv');
    if (next && conversationOriginRef.current) window.history.replaceState({}, '', url);
    else window.history.pushState({}, '', url);
  }, []);

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
      setConversationOrigin(null); // browser Back uses URL history, not the in-app origin shortcut
      const t = tabFromUrl();
      // Browser Back from an assistant's analytics lands on that assistant, as the in-app Back does.
      if (t === 'profiles' && assistantOriginRef.current) {
        setReopenAssistant(assistantOriginRef.current);
        setAssistantOrigin(null);
        assistantOriginRef.current = null;
        setActiveTab(t);
        return;
      }
      if (t) setActiveTab(t);
      // Sync the conversation detail with the URL: forward to a `?conv` opens it,
      // Back (conv removed) closes the open detail via the registered drill-back.
      const arn = convFromUrl();
      if (arn) setMessageDeepLink(messageLinkFromUrl());
      if (arn) setConversationDeepLink(arn);
      else if (drillBackRef.current) drillBackRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Whether the open tab is one this person can see. A tab they cannot see is never asked for: a team
  // that owns no assistant has no scope to put on a query, so asking would send an admin's request on
  // its behalf, which IAM refuses.
  // Computed during render, so the same answer decides what is fetched AND what is mounted: a tab's own
  // mount effect cannot fire a request for a tab the redirect below is about to leave.
  const activeTabAvailable = isTabAvailable(activeTab);

  const loadData = useCallback(async () => {
    if (!activeTabAvailable) {
      // Nothing is asked for and nothing stale is left on screen; other tabs keep their results.
      setError(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);

    // A team member's console asks only for what their assistant's route answers (teamScope.ts).
    const queries: QueryType[] = (QUERIES_BY_TAB[activeTab] ?? []).filter((q) => teamCanQuery(q));
    // Evaluations tab adds the per-exchange detail in Aurora mode only;
    // it's not part of the base contract because Athena can't serve it.
    if (activeTab === 'evaluations' && analyticsMode === 'aurora') {
      queries.push('evaluation_exchanges');
    }

    try {
      const queryResults = await Promise.all(
        queries.map(async (q) => {
          try {
            // One mapping from the shared bar to parameters, the same one the Performance view's own
            // drills use, so the flow, the rollup and the turns behind them cut the same population.
            // The bar's options come from `latency_metrics`, which takes no filter, so narrowing these
            // never narrows the choices the bar offers.
            const extra = q === 'message_flow' || q === 'welcome_flow' || q === 'intent_effectiveness'
              ? flowParams(perfFilters)
              : undefined;
            return { key: q, result: await queryAnalytics(q, dateRange, extra) };
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
      setError(err instanceof Error ? err.message : t('admin.dashboard.failedToLoadAnalytics'));
    } finally {
      setIsLoading(false);
    }
  }, [activeTab, activeTabAvailable, dateRange, analyticsMode, perfFilters]);

  // OPEN AN ASSISTANT PAGE'S PERFORMANCE LINK (`assistantLinks.ts`): Effectiveness for a version or an intent, or
  // Conversations, narrowed to the assistant. The values are the ones the link's URL carries, applied without a reload.
  const openAssistantLink = useCallback((link: AssistantLink) => {
    setAssistantOrigin(link.assistant);
    assistantOriginRef.current = link.assistant;
    // The assistant becomes the shared bar's own pill, so the bar shows the scope and clears it like any filter.
    applyPerfFilters(linkFilters(link));
    if (link.tab === 'effectiveness') {
      changePerfView(link.intent ? { view: 'intent', key: link.intent } : { view: 'overview' }, link.step ?? null);
      if (!link.intent) setEffectivenessDrill({ level: 0 });
    } else {
      changePerfView({ view: 'overview' });
    }
    selectTab(link.tab);
  }, [applyPerfFilters, changePerfView]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (activeTab === 'latency') {
      setPerfView({ view: 'latency' });
      setActiveTab('effectiveness');
    }
  }, [activeTab]);

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
      // Same 200-refusal envelope as the ground-truth submit: an unknown verdict answers
      // `reviewed: false` with a 200, which awaiting alone would report as a stored review.
      await writeAnalytics('flagged_responses', {
        action: 'review',
        exchangeId,
        reviewAction: action,
        notes,
      }, getDateRange(datePreset));
      loadData(); // Refresh
    } catch (err) {
      setError(t('admin.dashboard.failedToSubmitReview', { unknownError: err instanceof Error ? err.message : t('admin.dashboard.unknownError') }));
    }
  };

  const handleSubmitGroundTruth = async (exchangeId: string, score: number, classification: string, reasoning: string, halves?: LabelHalves) => {
    try {
      // writeAnalytics, not queryAnalytics: a refused write answers 200 with `submitted: false`, so
      // awaiting the call alone reported success for a label that was never stored. The server refuses
      // a label it cannot attribute to a caller, and that refusal has to reach the person who wrote it.
      await writeAnalytics('ground_truth', {
        action: 'submit',
        exchangeId,
        score,
        classification,
        reasoning,
        // The compliance and groundedness halves, each only when the person judged it (Appendix C4).
        ...(halves?.isCompliant !== undefined ? { isCompliant: String(halves.isCompliant) } : {}),
        ...(halves?.complianceCategories?.length ? { complianceCategories: halves.complianceCategories.join(',') } : {}),
        ...(halves?.isGrounded !== undefined ? { isGrounded: String(halves.isGrounded) } : {}),
      }, getDateRange(datePreset));
      loadData(); // Refresh
    } catch (err) {
      setError(t('admin.dashboard.failedToSubmitScore', { unknownError: err instanceof Error ? err.message : t('admin.dashboard.unknownError') }));
    }
  };

  const datePresetLabel = (preset: DatePreset) => t(DATE_PRESET_LABEL_KEYS[preset]);

  // OPEN ON A TAB THE ROLE CAN SEE. The default is Overview, which a team member does not hold; landing
  // there would render a view their session cannot fill.
  const firstAvailable = SECTIONS.flatMap((sec) => sec.tabs).find(isTabAvailable);
  const activeAvailable = activeTabAvailable;
  // The tab whose view is mounted: none while the open tab is one this person cannot see.
  const shownTab: TabId | null = activeAvailable ? activeTab : null;
  useEffect(() => {
    if (access.status === 'ready' && !activeAvailable && firstAvailable) selectTab(firstAvailable);
  }, [access.status, activeAvailable, firstAvailable, selectTab]);

  return (
    <div className="admin-dashboard">
      <ReasonDialog />
      {/* The operator's reach (FR0e) is stated on the Access log tab, beside the record of its use, not here. */}
      {access.status === 'ready' && access.role === 'team-members' && (
        // WHO THIS PERSON IS HERE: their team and the assistant this console is showing ("Ops team, owner
        // of the Ops assistant"), with the same team selector the Assistants list uses.
        <TeamIdentity teams={access.teams} assistants={access.assistants} owners={access.owners} scopedTo={scopedTo} onChooseAssistant={chooseAssistant} />
      )}
      <div className="admin-header">
        <div className="admin-header-left">
          <button
            className="btn-secondary"
            onClick={handleBack}
            aria-label={t('admin.header.backAria')}
          >
            {t('admin.header.back')}
          </button>
          <h2>{t('admin.header.title')}</h2>
          {/* The analytics mode, stated quietly: it explains why a tab is absent in Athena mode, and it is not a
              live status, so it carries no badge. */}
          {analyticsMode && (
            <span className="admin-header-mode" title={t('admin.header.analyticsModeHelp')}>
              {t('admin.header.analyticsMode', { mode: t(`admin.header.mode.${analyticsMode}`) })}
            </span>
          )}
        </div>
        <div className="admin-date-selector">
          {(Object.keys(DATE_PRESETS) as DatePreset[]).map((preset) => (
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
              onClick={() => { setConversationOrigin(null); if (!section.tabs.includes(activeTab)) selectTab(tabs[0]); }}
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
              onClick={() => { setConversationOrigin(null); selectTab(tabId); }}
            >
              {t(tabI18nKey(tabId))}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="admin-error">
          <span>{error}</span>
          <button className="btn-secondary" onClick={loadData}>{t('common.retry')}</button>
        </div>
      )}

      <div key={scopedTo ?? 'all'} className="admin-content" role="tabpanel" id={`admin-tabpanel-${activeTab}`} aria-labelledby={`admin-tab-${activeTab}`}>
        {!isLoading && activeTab !== 'user_management' && activeTab !== 'strategy' && activeTab !== 'conversations' && activeTab !== 'experiments' && activeTab !== 'classifier_gate' && activeTab !== 'security' && activeTab !== 'access_log' && (() => {
          // Only inspect results for queries the *current* tab actually requested,
          // not the union of every previously-viewed tab's results. Otherwise a
          // stale Aurora-only result from a prior tab would mis-banner the
          // current one.
          const tabQueries = (QUERIES_BY_TAB[activeTab] ?? []).filter((q) => teamCanQuery(q));
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
                  <span> {t('admin.banners.auroraUpgrade')}<code>--context analyticsMode=aurora</code> {t('admin.dashboard.forRealTimePerMessage')}</span>
                )}
              </div>
            );
          }
          return null;
        })()}

        {shownTab === 'overview' && (
          <OverviewTab
            volumeData={results.conversation_volumes ?? null}
            intentData={results.intent_distribution ?? null}
            activeUsersData={results.active_users_daily ?? null}
            messagingUsersData={results.active_messaging_users_daily ?? null}
            errorRateData={results.error_rate_daily ?? null}
            isLoading={isLoading}
          />
        )}
        {shownTab === 'alerts' && (
          <AlertsTab
            intentEffectiveness={results.intent_effectiveness ?? null}
            latency={results.latency_metrics ?? null}
            modelEffectiveness={results.model_effectiveness ?? null}
            flagged={results.flagged_responses ?? null}
            errorRate={results.error_rate_daily ?? null}
            // THE SAME CUT THE PERFORMANCE SURFACE IS SHOWING. An alert computed over every row while
            // the tab it links to shows one tier would send a reader to a card that does not breach.
            filters={perfFilters}
            isLoading={isLoading}
            onNavigate={(tab) => selectTab(tab as TabId)}
          />
        )}
        {shownTab === 'models' && (
          <ModelsTab
            data={results.model_usage ?? null}
            effectivenessData={results.model_effectiveness ?? null}
            isLoading={isLoading}
          />
        )}
        {shownTab === 'strategy' && <ModelStrategyTab />}
        {shownTab === 'experiments' && (
          <ExperimentsTab
            resultsData={results.experiment_results ?? null}
            isLoading={isLoading}
            registerBack={registerDrillBack}
            onOpenConversation={openConversation}
            dateRange={dateRange}
          />
        )}
        {/* Never a team's: a classifier serves every assistant of a classification (SPEC-ADMIN-CONSOLE FR48). */}
        {shownTab === 'classifier_gate' && (
          <div className="admin-tab">
            <p className="admin-tab-description" data-testid="classifier-gate-what">{t('admin.classifierGate.whatItIs')}</p>
            <ClassifierGatePanel dateRange={dateRange} />
          </div>
        )}
        {shownTab === 'profiles' && (
          <ProfilesTab registerBack={registerDrillBack} onOpenLink={openAssistantLink} initialAssistant={reopenAssistant} />
        )}
        {shownTab === 'evaluations' && (
          <EvaluationsTab data={results.evaluation_scores ?? null} isLoading={isLoading} dateRange={dateRange} />
        )}
        {shownTab === 'latency' && (
          <LatencyTab
            data={results.latency_metrics ?? null}
            routerStepsData={results.router_steps ?? null}
            pageLoadData={results.page_load_metrics ?? null}
            filters={perfFilters}
            onFiltersChange={applyPerfFilters}
            isLoading={isLoading}
            dateRange={dateRange}
            analyticsMode={analyticsMode}
          />
        )}
        {shownTab === 'client' && (
          <ClientTab
            pageLoadData={results.page_load_metrics ?? null}
            connectionHealthData={results.connection_health_daily ?? null}
          />
        )}
        {/* ── WHAT AN ASSISTANT MESSAGE IS, AS ITS OWN QUESTION ───────────────
            Not every assistant message is an answer. A reading folds a queued burst into one reply,
            and a drift suggestion responds to a message and deliberately does NOT do the work - both
            are excluded from the latency figures, and until this had a home there was nowhere to see
            that they had been, or how many.

            It sat at the bottom of the Latency tab, which now reads as the message flow itself. This
            asks a different question - what KIND of message, not how long it took - so it reads as a
            digression there and as a subject here. */}
        {shownTab === 'answer_types' && (
          <div className="admin-tab">
            <TurnKinds dateRange={dateRange} />
            <Handovers dateRange={dateRange} />
            <UnservedSubjects dateRange={dateRange} />
          </div>
        )}
        {shownTab === 'queue' && (
          <OperationsTab dateRange={dateRange} analyticsMode={analyticsMode} />
        )}
        {shownTab === 'flagged' && (
          <FlaggedResponsesTab
            data={results.flagged_responses ?? null}
            isLoading={isLoading}
            onReview={can('triage-responses') ? handleReviewResponse : undefined}
            onOpenConversation={openConversation}
            registerBack={registerDrillBack}
          />
        )}
        {shownTab === 'ground_truth' && (
          <GroundTruthTab
            data={results.ground_truth ?? null}
            isLoading={isLoading}
            onSubmitScore={can('label-ground-truth') ? handleSubmitGroundTruth : undefined}
            onOpenConversation={openConversation}
          />
        )}
        {shownTab === 'effectiveness' && (
          <PerformanceTab
            flowData={results.message_flow ?? null}
            welcomeData={results.welcome_flow ?? null}
            effectivenessData={results.intent_effectiveness ?? null}
            dateRange={dateRange}
            isLoading={isLoading}
            filters={perfFilters}
            onFiltersChange={applyPerfFilters}
            filterRows={(results.latency_metrics?.data ?? []) as Record<string, unknown>[]}
            view={perfView}
            onViewChange={changePerfView}
            onOpenConversation={openConversation}
            renderLatency={(openTtff) => (
              <LatencyTab
                key={openTtff ? 'ttff' : 'all'}
                data={results.latency_metrics ?? null}
                routerStepsData={results.router_steps ?? null}
                pageLoadData={results.page_load_metrics ?? null}
                filters={perfFilters}
                onFiltersChange={applyPerfFilters}
                isLoading={isLoading}
                dateRange={dateRange}
                analyticsMode={analyticsMode}
                embedded
                openTtff={openTtff}
              />
            )}
            renderEffectiveness={() => (
              <EffectivenessTab
                data={results.intent_effectiveness ?? null}
                dateRange={dateRange}
                isLoading={isLoading}
                onOpenConversation={openConversation}
                registerBack={registerDrillBack}
                drill={effectivenessDrill}
                onDrillChange={setEffectivenessDrill}
                filters={perfFilters}
                onFiltersChange={applyPerfFilters}
                filterRows={(results.latency_metrics?.data ?? []) as Record<string, unknown>[]}
                onOpenLatency={() => changePerfView({ view: 'latency' })}
                onOpenFlagged={() => setActiveTab('flagged')}
                embedded
              />
            )}
          />
        )}
        {shownTab === 'conversations' && (
          <ConversationsTab
            summaryData={results.conversation_summaries ?? null}
            driftData={results.drift_events ?? null}
            isLoading={isLoading}
            deepLinkChannelArn={conversationDeepLink}
            deepLinkMessage={messageDeepLink}
            onDeepLinkConsumed={() => { setConversationDeepLink(null); setMessageDeepLink(null); }}
            registerBack={registerDrillBack}
            onConversationChange={updateConvUrl}
            returnTo={conversationOrigin ? { onReturn: handleBack } : null}
            assistantFilter={perfFilters.assistant}
            onClearAssistantFilter={() => applyPerfFilters({ ...perfFilters, assistant: null, version: null })}
          />
        )}
        {shownTab === 'users' && (
          <UsersTab
            data={results.user_activity ?? null}
            activeUsersData={results.active_users_daily ?? null}
            messagingUsersData={results.active_messaging_users_daily ?? null}
            messagesPerUserData={results.messages_per_user ?? null}
            signupFunnelData={results.signup_funnel_conversion ?? null}
            signinFunnelData={results.signin_funnel_conversion ?? null}
            guestFunnelData={results.guest_to_customer_funnel ?? null}
            guestRefusalsData={results.guest_refusals ?? null}
            isLoading={isLoading}
          />
        )}
        {shownTab === 'user_management' && (
          <UserManagementTab />
        )}
        {shownTab === 'security' && <MembershipAuditTab />}
        {shownTab === 'access_log' && <AccessLogTab />}
      </div>
    </div>
  );
};

export default AdminDashboard;
