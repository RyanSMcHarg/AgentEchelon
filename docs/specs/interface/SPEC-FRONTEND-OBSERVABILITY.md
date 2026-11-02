# SPEC: Per-Page Frontend Observability

**Status:** Proposed, under consideration. The per-page attribution this document adds is **NOT BUILT**; the shared telemetry seam it extends is built (FR10, and FR7, FR8, FR12 and FR13 in part or whole).

**Coverage:** none - proposed; the per-page attribution this document adds is not emitted. The seam it extends (FR7, FR8, FR10, FR12 and FR13 below) has unit coverage and no e2e spec.

**Related:** [`DESIGN-SEPARATE-ADMIN-APP.md`](./DESIGN-SEPARATE-ADMIN-APP.md) - the two apps this spec instruments. [`SPEC-ADMIN-CONSOLE.md`](./SPEC-ADMIN-CONSOLE.md) - the console surfaces that read the result. [`LATENCY-TARGETS.md`](../../guides/developer/LATENCY-TARGETS.md) - the latency definitions these metrics sit beside.

**Site section:** Interface layer.

---

## Overview

**A "page" here is a rendered view rather than a URL, and that is a property of the product rather than a shortcut.** Neither app uses a router. The chat app is a state machine - auth views, then a list-and-detail shell where the active conversation selects the detail pane, a mobile master-detail swap driven by a CSS class, and a new-conversation modal. The admin console is query-param navigation: seven sections grouping sub-tab ids, reflected in `?admin=<tab>` with a `?conv=<id>` deep link. A route change is therefore a state transition rather than a browser navigation, so per-page attribution is stamped by the app at transition time and can never be inferred from `location`.

**The telemetry seam is first-party from the browser to the governed store, and it ends where every other platform figure ends.** The browser batches events, sends them with `keepalive` so an in-flight request survives a page hide, flushes on `visibilitychange` and `pagehide`, carries a per-session id, and authenticates with the Cognito ID token. The ingestion Lambda stamps the person id (`callerPersonId`) and the classification from the caller's token rather than from the body, so an identity on a client event is asserted by the token that sent it and not by the page. Delivery then follows the live analytics mode: Firehose to S3 in the default mode, or the Aurora `client_events` table through the in-VPC data plane where one is present. The same admin console that reads server-side latency reads this, which is what makes a browser-versus-server comparison possible at all.

**Every accepted name is a closed set, because a name here becomes a partition key and a GROUP BY key.** One shared constant holds the event-type allow-list, read both by the runtime gate that rejects an unknown type and by the Glue partition projection that has to enumerate the same set, so the two cannot drift into the failure where rows land in S3 under a partition no query enumerates. Performance metric names are closed for a sharper reason: a timing's name becomes the `event_type` of its row, and `client_ttff_ms` is joined to the server's own time-to-first-feedback for the same turn, so a free-form name would let any signed-in client invent unbounded cardinality in a panel an operator reads, or post rows that skew the client-against-server comparison. An undeclared metric is rejected and counted by reason; an undeclared property is dropped while the timing is kept.

**Message content stays out of the seam, and the seam carries an identifier.** A client event carries `person_id` (the caller's AppInstanceUser id), the classification and a session id, which the ingestion Lambda stamps from the caller's token on every row, and no email address (`backend/lambda/src/client-events.ts`, `backend/lambda/src/analytics-aurora/client-events-ingest.ts`). Message content, prompts, file names and free text stay out because the emitter's unions admit no field for them; a performance record's properties are bounded to what its metric declares, while an event's `properties` pass through without a bound; and a rejection is logged by reason without echoing the input that was refused. The unbounded event `properties` are the open half of FR12.

## Business Problem

An operator improving a front end needs to know which page or admin tab is slow, janky or failing, rather than that the app is slow on average, and needs it without standing up a front-end telemetry pipeline to find out. Today a page-load percentile is captured once per load with no view attached, and the only reliability signal is WebSocket connection health, so the reading says that Largest Contentful Paint is poor across the app and not that the data-heavy conversation views are dragging the average. Failures are worse than coarse: a failed analytics query is caught and returned as null, so a tab renders honestly empty with no metric anywhere, and an unhandled promise rejection is not captured at all. What a team needs is the signal it already collects, attributed to the view it came from, on the seam that is already carrying traffic.

## Personas

Personas are defined in [PERSONAS.md](../../overview/PERSONAS.md) and are not redefined here. Six of them read this data, and they divide by what a slow or broken view costs them: an engineer needs the millisecond and the stack, a manager needs the funnel, and an analyst needs the rows in their own stack.

### Admin / operator

**How this relates to them:** they own front-end performance and reliability for the deployment, and the console is where they find out. A per-tab reading is the difference between "the console is slow" and "one tab's fan-out is slow".

| What they need | Requirement |
|---|---|
| Settle time per data-heavy admin tab, from the query fan-out to a rendered table | FR4 |
| A failed query counted rather than rendered as an empty table | FR4 |
| Per-tab error rate | FR5 |
| Reconnect spikes as an early instability signal | FR10 |
| Per-page breakdowns on the surfaces that already carry the roll-up | FR9 |

### Platform developer

**How this relates to them:** they debug the platform itself, so they need the load and stability numbers attributed to a view and the errors the current capture does not reach.

| What they need | Requirement |
|---|---|
| Page load and layout stability attributed to the view that produced them | FR1 |
| Route-change transition time between views | FR3 |
| JS errors from `window.onerror` and `unhandledrejection`, not only React render errors | FR5 |
| Failed API calls per view rather than swallowed | FR5 |
| Attribution stamped by the app at transition time, since neither app has a router | FR11 |

### AI developer

**How this relates to them:** they own the conversation and battle experiences, so their question is what the person experiences while a response is arriving.

| What they need | Requirement |
|---|---|
| Interaction responsiveness attributed to the conversation detail view while a response streams | FR1 |
| Message round-trip and time to first feedback beside the view they were measured in | FR1, FR10 |
| Per-side round-trip on a battle tagged so the two assistants are comparable | FR1 |

### QA / test engineer

**How this relates to them:** they gate releases, so reliability per view is a regression signal and it has to be a number rather than an impression.

| What they need | Requirement |
|---|---|
| JS-error rate per page | FR5 |
| Failed-API-call rate per page | FR5 |
| Per-tab reliability as a release signal | FR4, FR9 |
| No new event type landing in a partition nothing enumerates | FR7 |

### Manager

**How this relates to them:** they read adoption rather than milliseconds, so what they need is which views people reach and where they stop.

| What they need | Requirement |
|---|---|
| Page views per view rather than per session | FR2 |
| Dwell or active time per view | FR6 |
| Funnel conversion across pages, with page-scoped dwell on the sign-up and sign-in steps | FR2, FR6 |

### BI analyst

**How this relates to them:** they take the rows into their own stack, so what they need is the per-page dimension present on the row and the governed store queryable, not another panel.

| What they need | Requirement |
|---|---|
| The `page` or `tab` dimension on the row rather than derived in a view | FR1 |
| Page views, dwell and funnel conversion as queryable rows | FR2, FR6 |
| A cardinality decision that does not make the partition unusable | FR14 |

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

**Mode** is the analytics mode the requirement is expected in. Ingestion serves both modes through different sinks, so most rows read `Both`; the Glue partition projection is the one step that exists only on the default path.

| # | Requirement | Priority | Mode | Delivered | Validated by |
|---|---|---|---|---|---|
| FR1 | Every `trackEvent` and `trackPerformance` call carries a `page` or `tab` property identifying the rendered view, and web-vital capture stamps the active page at metric-report time so the load and interaction percentiles are attributable per page | Table stakes | Both | No - the metrics are captured session-globally, and the five admin-action events carry no page or tab | none |
| FR2 | A `page_view` fires on each chat view transition and the admin tab view continues to fire for admin tabs, both carrying a `page` or `tab` and a route-change duration where a prior view exists | Table stakes | Both | Partly - the admin tab-view event is emitted, allow-listed and ingested; `tab_switched` is allow-listed and nothing emits it; no chat `page_view` type exists and none of them carries a route-change duration | `client-events` (unit, behavior) |
| FR3 | A shared helper records the transition duration between views - a timer started at the intent and ended after the new view's first paint - reported as `route_change_ms` with `from` and `to` properties | Table stakes | Both | No | none |
| FR4 | Data-heavy admin tabs wrap their query fan-out in a timer reporting `tab_settle_ms` with a `tab` property, and a per-query failure increments a `query_failed` event carrying the tab and the query, so a failure is a number rather than an honestly empty table | Table stakes | Both | No | none |
| FR5 | Reliability is captured at the layer that knows: a `failed_api_call` event carrying page, endpoint and status at the fetch and service layer, and JS-error capture extended past React render errors to `window.onerror` and `unhandledrejection`, each tagged with its page | Gap - prioritize | Both | No - render errors are captured through the error boundary; a transport failure is caught and returned as null, and an unhandled rejection is not captured | none |
| FR6 | On each view exit - a transition, or the page becoming hidden - an active-time duration is emitted for the view being left | Above bar - optional | Both | No | none |
| FR7 | A new event type is added to the one shared allow-list constant that both the runtime gate and the Glue partition projection read, and the projection is redeployed, so a new type cannot land in S3 under a partition no query enumerates | Enabler | Both, and the projection redeploy on the default path only | Yes | `client-events` (unit, behavior) |
| FR8 | A new performance metric name is added to the backend allow-list and to the emitter's mirrored union, with its permitted properties declared, because a metric name becomes an `event_type` and a GROUP BY key and one of them is joined to a server-side measurement | Enabler | Both | Yes | `client-perf-metrics-match-the-emitter` (unit, source text), `client-events` (unit, behavior) |
| FR9 | The admin latency and overview surfaces carry per-page breakdowns of the metrics above, with the existing session-global rows kept as the roll-up rather than replaced | Table stakes | Both | No - the page-load percentiles and the connection-health counts render session-globally | none |
| FR10 | The seam delivers without a third-party agent: batching, a `keepalive` send, a flush on page hide, a per-session id, authenticated ingestion, and delivery to the store for the live analytics mode | Enabler | Both | Yes | `eventTrackingService` (unit, behavior - auth gating and payload shape; batching, keepalive and the flush on hide are not asserted), `client-events` (unit, behavior), `client-events-ingest` (unit, behavior) |
| FR11 | Per-page attribution is stamped by the app at transition time rather than inferred from `location`, because neither app uses a router and a rendered view has no URL of its own | Enabler | Both | No - nothing stamps a view identity today | none |
| FR12 | No PII crosses the seam: the person id, the classification and a session id only, with message content, prompts, file names and free text excluded and `properties` restricted to typed scalars | Table stakes | Both | Partly - message content is excluded by the emitter's unions, performance properties are bounded to what each metric declares, and ingestion stamps no email; ingestion does not bound an event's `properties` | `client-events` (unit, behavior) |
| FR13 | A record that cannot be trusted is refused and counted: an unknown metric name or an out-of-range value rejects the record, an undeclared property is dropped while the timing is kept, each rejection is counted by reason, and the log does not echo the refused input | Differentiator | Both | Yes | `client-events` (unit, behavior) |
| FR14 | The per-page dimension is carried in a shape that does not break the store it lands in, whether as a payload column or a partition key | Enabler | Both | No | none |

**Reading the "Validated by" column.** Each entry is one specific test, named by its filename without its extension. Backend unit tests live in `backend/test/` (the ones specific to the Aurora sink under `backend/test/analytics-aurora/`); the emitter's own tests live under `frontend/packages/shared/src/`, and the console's under `frontend/packages/admin/src/`, beside the component or service they cover; end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists, which is expected where `Delivered` is No.

**Resolved against the code.** Three statements about the current state are checked against the source rather than carried forward. The admin console groups its sub-tabs under **seven** top-level sections. Performance metric names are a **closed set**, not free-form: a backend allow-list mirrored by a typed union in the emitter, with permitted properties declared per metric, so FR3 and FR4 each need their name added in both places. What needs no redeploy for a performance metric is the Glue projection, because every performance record shares one partition, which is the narrower claim FR8 makes. And the timings emitted today are the five web vitals plus **two** browser-measured durations: message round-trip, and a client-side time to first feedback that is joined to the server's own figure for the same turn.

**Acceptance criteria.** (a) Opening a data-heavy admin tab produces a settle-time sample carrying that tab, visible on the latency surface within one refresh window. (b) Web-vital percentiles filter by page, and the conversation detail view and the effectiveness section show distinct distributions. (c) A forced analytics-query failure increments the failure count and surfaces a non-zero per-tab error count rather than only an empty table. (d) A chat view transition emits one page view and one route-change duration with the correct origin and destination. (e) An unhandled promise rejection in the chat app is captured as an error event carrying its page. (f) No new event type lands in S3 under a partition absent from the Glue projection, which the shared allow-list constant is what guarantees.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| A third-party real-user-monitoring service | The seam stays first-party and ends in the governed stores, so a client measurement is read beside the server measurement of the same turn rather than in a second vendor's console. A deployer may wire an external sink themselves; the product does not depend on one | [SPEC-ADMIN-CONSOLE](./SPEC-ADMIN-CONSOLE.md) FR25, the browser-versus-server diagnostic that the shared store makes possible |
| Message content, prompts or free text in analytics | A telemetry stream is the easiest place for content to leak into a store with different retention and a different audience from the archive | FR12, which also states what identity the seam does carry today; [SPEC-CONVERSATION-SECURITY](../interaction/governance/SPEC-CONVERSATION-SECURITY.md) for where content is allowed to live |
| A new datastore or a second ingestion path | Everything routes through the existing client-events seam, which already carries traffic in both analytics modes (tenet D8) | [SPEC-AURORA-VPC-MODE](../foundations/SPEC-AURORA-VPC-MODE.md) for the two sinks the one seam delivers to |
| Token-level streaming timing | Time to first feedback is the perceived-latency metric, and a token-level measure would describe the model rather than the experience | [LATENCY-TARGETS.md](../../guides/developer/LATENCY-TARGETS.md) |
| Synthetic monitoring and uptime probing | This is real-user telemetry. A probe measures a path nobody took | [SPEC-ADMIN-CONSOLE](./SPEC-ADMIN-CONSOLE.md), the Operations surface, for the right-now health question |
| Off-console alerting on a front-end regression | A breach is consolidated and linked to its drill; pushing a page or an email is a delivery concern with its own escalation policy | [SPEC-ADMIN-CONSOLE](./SPEC-ADMIN-CONSOLE.md) FR6; **OPEN:** no document in this repository owns off-console notification delivery |

## User Experience Description and Mocks

The reading surface is the admin console, so these journeys end on a panel rather than on a new screen.

### The admin / operator's journey

1. **Open the operations surface and read the roll-up** (FR9, FR10). Traffic, active users, the trailing error-rate band, page-load percentiles and connection health, over the shared date preset.
2. **Break the percentile down by view** (FR1, FR9). The session-global row stays as the roll-up, and beneath it each page carries its own distribution, so a poor average has an owner.
3. **Read settle time per tab** (FR4). From the query fan-out to a rendered table, per tab, which is what separates a slow console from one slow fan-out.
4. **See a failure as a number** (FR4, FR5). A failed query increments a count and a per-tab error rate rather than rendering as an honestly empty table with nothing recorded.
5. **Watch reconnects as an early signal** (FR10). Connect, disconnect and reconnect counts per day, already on this surface, now readable beside the view they happened in.

### The platform developer's journey

1. **Attribute a load or stability number to the view that produced it** (FR1, FR11), stamped by the app at transition time because a rendered view has no URL.
2. **Read the transition itself** (FR3). Route-change duration with its origin and destination, which is the number a state-machine app has instead of a navigation timing.
3. **Reach the errors the boundary cannot see** (FR5). `window.onerror` and `unhandledrejection`, each carrying its page, alongside the render errors already captured.
4. **See a transport failure separately from an empty result** (FR5), rather than as a null return that renders as nothing to show.

### The AI developer's journey

1. **Read interaction responsiveness in the conversation detail view** (FR1) while a response is arriving, which is the moment the experience is judged on.
2. **Compare the two sides of a battle** (FR1). Per-side round-trip already flows; tagging it with the battle is what makes the two assistants comparable.
3. **Read the browser's time to first feedback beside the server's** (FR10) for the same turn, which is what the joined metric name exists for.

### The manager's and the BI analyst's journey

1. **Read page views and dwell per view** (FR2, FR6) rather than per session, so a view nobody reaches is distinguishable from one people leave.
2. **Read the funnel with page-scoped dwell** (FR2, FR6) on the sign-up and sign-in steps, where the conversion is already computed server-side.
3. **Take the rows out** (FR1, FR14). The page dimension is on the row rather than derived in a view, in a shape the store can carry.

**OPEN:** this document carries no mocks. What a per-page breakdown looks like beside the existing session-global roll-up - a filter on the current panels, or panels of their own - is unsettled, and FR9 does not decide it.

**OPEN:** four calibration questions this document does not settle. Whether a per-page web-vital sample has enough volume for a stable p95 at low traffic, or should roll up into the session-global bucket below a threshold. Whether the route-change duration ends at first paint or at interactive, given views differ in data dependency. Whether dwell is active focused time or wall clock, given tab switching and background suspension. And whether a failed API call distinguishes a transport failure from a status the person caused, so a reliability figure does not count user error as platform error.

## Related Documents

- [DESIGN-SEPARATE-ADMIN-APP.md](./DESIGN-SEPARATE-ADMIN-APP.md) - the two apps and the shared package the emitter lives in
- [SPEC-ADMIN-CONSOLE.md](./SPEC-ADMIN-CONSOLE.md) - the console that reads this data, and the browser-versus-server diagnostic
- [DESIGN-ADMIN-CONSOLE.md](./DESIGN-ADMIN-CONSOLE.md) - the sections and sub-tabs a `tab` value names
- [SPEC-AURORA-VPC-MODE.md](../foundations/SPEC-AURORA-VPC-MODE.md) - the two sinks the one ingestion path delivers to
- [SPEC-CHAT-APP.md](./SPEC-CHAT-APP.md) - the chat views a `page` value names
- [LATENCY-TARGETS.md](../../guides/developer/LATENCY-TARGETS.md) - the latency definitions and the client-events gap
- [PERSONAS.md](../../overview/PERSONAS.md) - the canonical definitions of the six personas above
- [TENETS.md](../../overview/TENETS.md) - tenets D7 and D8, which the one-seam and one-store-per-question rules follow from

## Appendix A - The seam as it stands

The seam carries traffic today and is extended rather than replaced.

| Piece | Where | What it does |
|---|---|---|
| Emitter | `frontend/packages/shared/src/services/eventTrackingService.ts` | `trackEvent(name, properties)` over an allow-listed name union; `trackPerformance(metric, value)` typed by the metric-name union so the client cannot emit a name the backend refuses; `startTimer` and `endTimer` for client-measured durations; web-vital capture wiring the five vitals through a dynamic import; batching at 20 events or 30 seconds, a `keepalive` send, a flush on page hide, a per-session id, and Cognito ID-token auth. What is recorded before sign-in is held in the tab's `sessionStorage` (the newest 100 entries), survives a reload or a redirect sign-in, and is sent when the person signs in; signing out sends what was recorded under the outgoing sign-in first |
| Ingestion | `backend/lambda/src/client-events.ts` with `backend/lambda/src/lib/client-event-types.ts` | The authenticated endpoint. Stamps the person id and the classification from the caller's token; gates the event type on the shared allow-list; validates a performance record's metric name, its value range and its declared properties; counts each rejection by reason; and delivers to Firehose and S3 on the default path or to the Aurora table through the data plane where one is present |
| Reading surfaces | The console's operations and latency sub-views | Message volume, session and messaging daily active users, error-rate percent, intent distribution; backend latency and time to first feedback from exchanges; page-load percentiles per web vital; and connect, disconnect and reconnect counts per day |

**Events carried today.** The sign-up and sign-in funnel, the auth lifecycle, the three connection events, `conversation_created`, `message_sent`, `message_received`, `channel_messages_listed`, `file_uploaded`, `admin_tab_viewed`, the five admin-action events the console emits when a message is redacted or deleted, a member added or removed, and a conversation deleted, and `error` from React render errors. `tab_switched` is allow-listed and nothing emits it. **Timings carried today.** The five web vitals, `message_round_trip_ms`, and `client_ttff_ms`.

## Appendix B - Per-page metric matrix

What each view would carry. `B` is carried today, `P` is proposed, and `B*` marks a load metric that is captured today without page attribution, which is what FR1 adds.

| Page or view (app) | FCP and LCP | INP | CLS | TTI | Route-change | Query settle | Page view | Dwell | JS error | Failed API | WebSocket |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Login and auth (chat) | B* | B* | B* | P | n/a | n/a | P, funnel B | P | P | P | n/a |
| Conversation list (chat) | B* | B* | B* | P | P | P, channels list | P | P | P | P | B |
| Conversation detail (chat) | B* | B* | B* | P | P | P, messages list | P | P | P, render B | P | B |
| New-conversation modal (chat) | n/a | B* | B* | n/a | P, open | n/a | P | P | P | P | n/a |
| Battle view (chat) | B* | B* | B* | P | P | P | P | P | P | P | B |
| Mobile detail (chat) | B* | B* | B* | P | P, swap | P | P | P | P | P | B |
| Operations and latency (admin) | B* | B* | B* | P | P | P | B, tab | P | P, render B | P | n/a |
| Conversations (admin) | B* | B* | B* | P | P | P, summaries | B, tab | P | P | P | n/a |
| Effectiveness (admin) | B* | B* | B* | P | P | P, per query | B, tab | P | P | P | n/a |
| Models and Strategy (admin) | B* | B* | B* | P | P | P | B, tab | P | P | P | n/a |
| Experiments (admin) | B* | B* | B* | P | P | P | B, tab | P | P | P | n/a |
| Users and Management (admin) | B* | B* | B* | P | P | P, funnels | B, tab | P | P | P | n/a |
| Security (admin) | B* | B* | B* | P | P | P | B, tab | P | P | P | n/a |

### What each view adds

**Chat, login and auth.** The full sign-up and sign-in funnel and render-error capture are carried. Added: a page view per auth sub-view, dwell per step as time on the form before submit, and a failed-API-call event for the identity-provider calls, where today a success or failure funnel event exists with no latency and no transport failure separated from user error.

**Chat, conversation list.** The channel-list event, the connection events and session-global vitals are carried. Added: a page view for the list, a settle timer from sidebar open to list rendered, a route-change timer into a conversation, and layout stability attributed to the list, since the sidebar reflows as channels stream in.

**Chat, conversation detail.** Message sent and received, the round-trip timing and render errors are carried. Added: a page view on select, a settle timer from select to messages rendered, interaction responsiveness attributed to this view for typing and scrolling while a response arrives, dwell, and a failed-API-call event for send and list failures that are swallowed today.

**Chat, new-conversation modal.** Conversation created is carried. Added: a page view on open, an open-transition timer, dwell from open to create or dismiss, and an abandon signal where the modal opens and nothing is created.

**Chat, battle view.** Message sent for each side is carried, and the per-side round-trip already flows. Added: a page view on battle entry, a battle property on the round-trip so the two assistants are comparable, and interaction responsiveness during scoring.

**Chat, mobile detail.** The same events as the detail view are carried, and the master-detail swap is CSS-only. Added: a swap-transition timer from list to detail, and layout stability and interaction responsiveness attributed to the mobile layout, where the swap is the known reflow point.

**Admin, operations and latency.** The tab-view event is carried, and this is where the page-load percentiles and connection health surface. Added: a settle timer per query, from the query response to a rendered table or chart, and a per-tab error rate.

**Admin, effectiveness.** The heaviest section: several sub-views are Aurora-served and each fans out multiple queries. The effectiveness view is itself a multi-level drill holding the evaluation, flow, task and step detail in one place - the per-exchange judge verdict at the exchange level, the task list and its turn timeline, the flow score panel on that timeline, and the tool-loop steps inline at the deepest level. The tab-view event is carried. Added: a settle timer wrapping the fan-out, a failure count where each failed query is caught and returned as null today, and interaction responsiveness for the drill expansions.

**Admin, conversations, models and strategy, experiments, users and management, and security.** The tab-view event is carried. Added: a settle timer, a failure count, dwell and a per-tab error rate. Users additionally has the sign-up and sign-in funnel conversion computed server-side already, so what it adds is page-scoped dwell.
