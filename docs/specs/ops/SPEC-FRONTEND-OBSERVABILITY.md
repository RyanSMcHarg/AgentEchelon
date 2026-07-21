# SPEC: Per-Page Frontend Observability

**Status:** Proposed **Layer:** Core platform (ops - cross-cutting telemetry, not an interaction pillar) **Plane:** core **Scope:** `frontend/packages/chat`, `frontend/packages/admin`, `frontend/packages/shared` **Related:** [`../interface/admin/DESIGN-SEPARATE-ADMIN-APP.md`](../interface/admin/DESIGN-SEPARATE-ADMIN-APP.md), `docs/LATENCY-TARGETS.md`

## Business problem

An operator improving a front-end needs to know which page or admin tab is actually slow, janky, or failing - not just that the app is slow on average - without standing up their own frontend telemetry pipeline to find out. This is for the admin/operator who owns front-end performance and reliability. This spec defines, per page and per admin tab, the performance, usage, and reliability metrics to capture, and maps each to the existing ingestion seam so the gaps are additive instrumentation rather than a new pipeline. (Current state: both front-ends emit client events today, but the signal is coarse and session-global - web vitals captured once per page load with no route attribution, and the only reliability surface is WebSocket connection health - so an operator sees that Largest Contentful Paint is slow across the app but not that the data-heavy Conversations admin tab is dragging the average, or that a specific chat view janks on interaction.)

## What exists today (BUILT)

The seam is real and already carries traffic. Do not re-propose it; extend it.

- `frontend/packages/shared/src/services/eventTrackingService.ts`
 - `trackEvent(name, properties)` with an allow-listed `EventName` union.
 - `trackPerformance(metric, value)` for free-form numeric metrics.
 - `startTimer(label)` / `endTimer(label)` for client-measured durations (via
    `performance.now()`); `endTimer` reports through `trackPerformance`.
 - `captureWebVitals()` dynamically imports `web-vitals` and wires `onLCP`, `onINP`,
    `onCLS`, `onFCP`, `onTTFB`, reporting `web_vital_*` performance metrics.
 - Batching (20 events / 30s), `keepalive: true` fetch, flush on `visibilitychange`
    (hidden) and `pagehide`, a per-session `sessionId`, and Cognito ID-token auth.
- `backend/lambda/src/client-events.ts` plus `backend/lambda/src/lib/client-event-types.ts`
 - Cognito-authed `/events` Lambda. Stamps `user_id` / `user_email` / `user_tier`
    (classification/clearance) from authorizer claims. Allow-list gates `event_type`.
 - Delivers to Kinesis Firehose -> S3 (Athena mode, default) OR to Aurora `client_events`
    via the VPC data-plane (`ingestClientEvents`) when a data plane is present.
 - `performance` records land under their own partition; `metric` is free-form.
- Admin surfaces
 - `OverviewTab.tsx`: message volume, session DAU (`session_started`), engaged messaging
    DAU, error-rate percent (`error` events / total), intent distribution.
 - `LatencyTab.tsx`: backend latency + TTFF (from exchanges), page-load web-vital
    percentiles (p50/p95/p99 per `web_vital_*` metric), and WebSocket connection health
    (`websocket_connected` / `_disconnected` / `_reconnected` counts per day).
- Wired events today: the auth funnel (`signup_*`, `signin_*`, `login`, `logout`, `session_started`), the three `websocket_*` events, `conversation_created`, `message_sent`, `message_received`, `channel_messages_listed`, `file_uploaded`, `tab_switched`, `admin_tab_viewed`, the four admin-action events emitted by `adminChime.ts` (`admin_message_redacted`, `admin_message_deleted`, `admin_member_added`, `admin_member_removed` - all in the `VALID_EVENT_TYPES` allow-list and ingested), and `error` (React render errors via `ErrorBoundary`). Perf: `message_round_trip_ms` (`messageLatencyTracker.ts`) and the five `web_vital_*`.

## Routing model (why "page" is not a URL)

Neither app uses a router. The chat app (`chat/src/App.tsx`) is a state machine: auth views (`login` / `register` / `verify` / `success` / `forgot`), then a list+detail shell where `activeConversation` selects the detail pane, a mobile master-detail swap driven by the `has-active` CSS class, and a `NewConversationModal`. The admin app (`admin/src/components/admin/AdminDashboard.tsx`) is query-param navigation: seven `SECTIONS` grouping sub-tab `TabId`s, reflected in `?admin=<tab>` with `?conv=<id>` deep links. A "page" here is therefore a rendered view/state, and a "route change" is a state transition, not a browser navigation. Per-page attribution must be stamped by the app at transition time, not inferred from `location`.

## Personas

Personas are defined once in [`../../overview/PERSONAS.md`](../../overview/PERSONAS.md); this spec only notes which metrics each cares about.

- AI developer: cares about the conversation detail and battle views, message round-trip, time to first feedback, and interaction responsiveness (INP) while a response streams in.
- Platform developer: cares about page load (FCP/LCP/TTI), route-change transition time, layout stability (CLS), JS error rate, and failed API calls per view.
- Admin/operator: cares about data-heavy admin tab query/settle time, per-tab error rate, and WebSocket reconnect spikes as an early instability signal.
- Manager: cares about page views, dwell/active time, and funnel conversion across pages, not raw millisecond percentiles.
- QA / test engineer: cares about JS error rate, failed-API-call rate, and per-page/per-tab reliability as regression signals that gate a release.
- BI analyst: cares about the per-page usage metrics (page views, dwell, funnel conversion) and their EXPORT to a BI tool, not only the curated admin rollup.

## Per-page metric matrix

Legend: B = built today, P = proposed. Load metrics (FCP/LCP/CLS/INP) are captured session-globally today (B*), so per-page attribution of them is the proposed delta.

| Page / view (app) | FCP/LCP | INP | CLS | TTI | Route-change ms | Query/settle ms | Page view | Dwell | JS error | Failed API | WS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Login/auth (chat) | B* | B* | B* | P | n/a | n/a | P (funnel B) | P | P | P | n/a |
| Conversation list (chat) | B* | B* | B* | P | P | P (channels list) | P | P | P | P | B |
| Conversation detail (chat) | B* | B* | B* | P | P | P (messages list) | P | P | P (render B) | P | B |
| New-conversation modal (chat) | n/a | B* | B* | n/a | P (open) | n/a | P | P | P | P | n/a |
| Battle view (chat) | B* | B* | B* | P | P | P | P | P | P | P | B |
| Mobile detail (chat) | B* | B* | B* | P | P (swap) | P | P | P | P | P | B |
| Overview + Latency (admin) | B* | B* | B* | P | P | P | B (tab) | P | P (render B) | P | n/a |
| Conversations (admin) | B* | B* | B* | P | P | P (summaries) | B (tab) | P | P | P | n/a |
| Effectiveness section (admin) | B* | B* | B* | P | P | P (per query) | B (tab) | P | P | P | n/a |
| Models + Strategy (admin) | B* | B* | B* | P | P | P | B (tab) | P | P | P | n/a |
| Experiments (admin) | B* | B* | B* | P | P | P | B (tab) | P | P | P | n/a |
| Users + Mgmt (admin) | B* | B* | B* | P | P | P (funnels) | B (tab) | P | P | P | n/a |
| Security (admin) | B* | B* | B* | P | P | P | B (tab) | P | P | P | n/a |

## Per-page detail

### Chat: login/auth
BUILT: full signup/signin funnel events; `error` on render failure. PROPOSED: `page_view` per auth sub-view, dwell per step (time on form before submit), and `failed_api_call` for Cognito calls (currently only success/failure funnel events, no latency or transport failure separated from user error).

### Chat: conversation list
BUILT: `channel_messages_listed`, `websocket_*`, session-global web vitals. PROPOSED: `page_view` for the list, a `channels_list_settle_ms` timer (sidebar open to list rendered), route-change timer into a conversation, and CLS attributed to the list (sidebar reflow as channels stream in is a likely layout-shift source).

### Chat: conversation detail
BUILT: `message_sent`, `message_received`, `message_round_trip_ms`, render errors. PROPOSED: `page_view` on select, `messages_settle_ms` (select to messages rendered), INP attributed to this view (typing/scroll while a response arrives), dwell, and `failed_api_call` for message send/list failures now swallowed silently.

### Chat: new-conversation modal
BUILT: `conversation_created`. PROPOSED: `page_view` (modal open), open-transition timer, dwell (open to create/dismiss), and abandon signal (open with no create).

### Chat: battle view
BUILT: `message_sent` for each side. PROPOSED: `page_view` for battle entry, per-side round-trip already flows via `message_round_trip_ms` but is not tagged battle; add a `battle` property so the two assistants can be compared, plus INP during scoring.

### Chat: mobile detail
BUILT: same events as detail; the master-detail swap is CSS-only. PROPOSED: a swap- transition timer (list to detail on mobile), and CLS/INP attributed to the mobile layout specifically (the swap is a known reflow point).

### Admin: Overview + Latency
BUILT: `admin_tab_viewed`, and this is where page-load web vitals and connection health are surfaced. PROPOSED: `tab_settle_ms` per query (`queryAnalytics` first byte to rendered table/chart) and per-tab error rate.

### Admin: Effectiveness section (Effectiveness, Flagged, Ground Truth)
The heaviest section, several tabs Aurora-only, each fanning out multiple `queryAnalytics` calls in `loadData()`. The Effectiveness tab is itself a multi-level drill: the detail that once lived in standalone Evaluations, Flows, Tasks, and Steps tabs now lives inside it (L2 exchanges carry the per-exchange judge verdict = Evaluations; L2 tasks + L3 timeline = Tasks; L3 `FlowScorePanel` = Flows; L4 inline steps = Steps), so those standalone tabs are retired. BUILT: `admin_tab_viewed`. PROPOSED: a per-query `settle_ms` timer wrapping the `Promise.all` fan-out, a `query_failed` count (today each failed query is caught and returned as `null`, rendering an honest-empty table with no metric), and INP for the drill-down interactions (L2/L3/L4 expansion).

### Admin: Conversations, Models+Strategy, Experiments, Users+Management, Security
BUILT: `admin_tab_viewed`. PROPOSED: `tab_settle_ms`, `query_failed`, dwell, and per-tab error rate. Users additionally has the signup/signin funnel conversion already computed server-side; add page-scoped funnel dwell.

## Functional requirements

- FR1 (per-page attribution): every `trackEvent` and `trackPerformance` call carries a `page` (or `tab`) property identifying the rendered view. `captureWebVitals` stamps the active page at metric-report time so LCP/INP/CLS/FCP/TTFB are attributable per page.
- FR2 (page_view): a `page_view` event fires on each chat view transition and continues to fire `admin_tab_viewed` for admin tabs, both carrying a `page`/`tab` and a route-change duration where a prior view exists.
- FR3 (route-change timing): a shared helper records the transition duration between views (`startTimer` at intent, `endTimer` after the new view's first paint) as `route_change_ms` with a `from`/`to` property.
- FR4 (query/settle timing): data-heavy admin tabs wrap their `queryAnalytics` fan-out with a `startTimer`/`endTimer` pair reporting `tab_settle_ms` with a `tab` property; per-query failures increment a `query_failed` event with `{ tab, query }`.
- FR5 (reliability): add a `failed_api_call` event `{ page, endpoint, status }` at the fetch/service layer (chat `chimeService`/`attachmentService`, admin `analyticsService`), and broaden JS-error capture beyond `ErrorBoundary` render errors to `window.onerror` and `unhandledrejection`, both tagged with `page`.
- FR6 (dwell): on each view exit (transition or `visibilitychange` hidden), emit an active- time duration for the view being left.
- FR7 (allow-list + projection): every new `event_type` is added to `client-event-types.ts` `VALID_EVENT_TYPES` AND the Glue projection is redeployed, per that file's documented three-step rule, so no partition silently drops. Performance metric names remain free-form and need no allow-list change.
- FR8 (surfacing): the admin Latency/Overview tabs gain per-page breakdowns of the metrics above; the existing session-global rows remain as the roll-up.

## Acceptance criteria

- AC1: opening the Conversations admin tab produces a `tab_settle_ms` sample with `tab: "conversations"` visible in the Latency tab within one refresh window.
- AC2: web-vital percentiles can be filtered by `page`; the Conversation detail view and the Effectiveness tab show distinct LCP/INP distributions.
- AC3: a forced failed analytics query increments `query_failed` and surfaces a non-zero per-tab error count rather than only an empty table.
- AC4: a chat view transition emits one `page_view` and one `route_change_ms` with correct `from`/`to`.
- AC5: an unhandled promise rejection in the chat app is captured as an `error` event with a `page` property (today it is not captured at all).
- AC6: no new event type lands in S3 under a partition absent from the Glue projection (verified by the shared allow-list test).

## Known gaps this spec closes

- Web vitals are session-global with no page attribution (captured once at bootstrap).
- No `page_view` for any chat view; no route-change or view-transition timing anywhere.
- No dwell/active-time per page.
- No query/settle timing on the admin data-heavy tabs despite the `queryAnalytics` fan-out.
- Failed API calls are swallowed silently (chat services and admin `queryAnalytics` catch and return `null`); no `failed_api_call` metric exists.
- JS-error capture only covers React render errors via `ErrorBoundary`, not `window.onerror` or `unhandledrejection`.
- The four admin action events emitted by `adminChime.ts` (`admin_message_redacted`, `admin_message_deleted`, `admin_member_removed`, `admin_member_added`) are already in the `VALID_EVENT_TYPES` allow-list and ingested, but they carry no per-page/tab attribution; the per-page attribution (FR1) and any new event types still follow the three-step allow-list rule (FR7).

## Non-goals

- No third-party RUM SaaS (Datadog, Sentry, New Relic, Google Analytics). The seam stays first-party: `web-vitals` -> `/events` -> Athena/Aurora -> admin console. A deployer may wire an external RUM sink themselves, but the product does not depend on one.
- No PII in analytics. Events carry `user_id` (Cognito sub), classification/clearance, and a session id only. Message content, prompts, file names, and free-text stay out of the client-events stream; `properties` remain typed scalars, not payloads.
- No new datastore or ingestion path. Everything routes through the existing Firehose/Aurora `client_events` seam.
- No token-level streaming timing; TTFF (time to first feedback) remains the perceived- latency metric per `docs/LATENCY-TARGETS.md`.
- No synthetic monitoring or uptime probing; this spec is real-user telemetry only.

## Open questions

- Do per-page web-vital samples need enough volume to compute stable p95s at low traffic, or should low-sample pages roll up into the session-global bucket until a threshold?
- Should `route_change_ms` measure to first paint or to interactive (TTI) for a fair cross-view comparison, given views differ in data dependency?
- Is dwell better measured by active (focused) time or wall-clock, given tab-switching and background suspension?
- Does per-page attribution risk cardinality blow-up in the Glue partition / Aurora index, and should `page` be a payload column rather than a partition key?
- Should `failed_api_call` distinguish transport failure from a 4xx the user caused, so reliability dashboards do not count user error as platform error?
