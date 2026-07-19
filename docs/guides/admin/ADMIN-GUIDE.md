# Admin Console Guide

How operators use the AgentEchelon admin dashboard to check platform health,
review how the assistants are performing, and administer conversations. Written
to be portable - it describes behaviour, not any specific AWS account.

## Getting started - the decisions that shape your deployment

Before you operate the console, a handful of **deploy-time** choices decide what
this dashboard shows and what you can do in it. None is a one-way door - you can
change most later with a redeploy - but picking deliberately up front saves
rework. This is the orientation; each row links to the guide that owns the how-to.
The full context flag reference lives in `README.md` and `CLAUDE.md`.

| Decision              | Options (default **bold**)                                             | Choose the non-default when…                                                                                                                                                                                     | Console impact                                                                                                                                      | Owner doc                                                                                     |
| --------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Analytics mode**    | **Athena** \| Aurora (`-c analyticsMode=aurora`)                       | you want SQL joins, pgvector drift, multi-turn flow scores, ground-truth calibration, or per-step execution telemetry. Athena covers archival + basic evaluation; Aurora adds the advanced Effectiveness/Models views. | Aurora unlocks the **Effectiveness dashboard + drill / Flows / Flagged / Ground Truth / Tasks / Steps** views + drift detection; in Athena those show an honest "Aurora-only" banner. | `AURORA-MODE-GUIDE.md`, `SPEC-AURORA-VPC-MODE.md`                                             |
| **Identity provider** | **Built-in Cognito** \| external OIDC/SAML \| federated participants   | your users already have a corporate IdP (SSO), or you need to admit external people who have no account in this deployment.                                                                                      | Governs how users sign in and how tier (and `admins`) is derived; federation lets non-account participants join a conversation.                     | `IDENTITY-PROVIDER-GUIDE.md`, `SPEC-FEDERATED-PARTICIPANTS.md`, `SPEC-CREDENTIAL-EXCHANGE.md` |
| **Admin auth**        | **Built-in `admins` group** \| host-owned admin auth (`adminAuthMode`) | you want to front the console with your own admin app / IdP instead of the Cognito `admins` group.                                                                                                               | Decides who reaches *this* dashboard and how they authenticate.                                                                                     | `ADMIN-INTEGRATION-GUIDE.md`                                                                  |
| **Email (SES)**       | **`senderEmail` unset → skip-but-report** \| verified sender           | you want conversation-share invites and proactive briefings to actually send. New accounts start in the **SES sandbox** (every recipient must be verified; ~200/day).                                            | Share-invite + briefing delivery; failures surface as warnings, not silent drops.                                                                   | `README.md` ("Email & the SES Sandbox")                                                       |
| **`/battle`**         | **On** \| off (`-c enableBattle=false`)                                | you don't want the head-to-head model-comparison feature or its extra stack. battle eligibility is the per-profile `battleEligible` field in `backend/lib/config/profiles.ts` (premium by default).                                                                                           | The **Experiments** section's battle arming + live scorecard.                                                                                       | `GUIDE-AB-TESTING-AND-BATTLES.md`, `SPEC-BATTLE.md`                                           |
| **Cost sleep mode**   | **Off** \| on (`-c sleepMode=true`, Aurora only)                       | an idle instance's Aurora Serverless v2 min-ACU cost matters and you want it to auto-pause after idle and wake on demand.                                                                                        | Adds the sleep/wake surface (this guide's "Cost sleep mode" section) + the app paused-banner.                                                       | `SPEC-COST-SLEEP-MODE.md`                                                                     |
| **Frontend hosting**  | **CloudFront + S3 (WAF on)**                                           | rarely - WAF-off (`-c frontendWaf=false`) or IP-locking (`-c wafAllowedIps=…`) for a private demo. Remember to set `-c appUrl=` after the first deploy so CORS allows the app origin.                            | Where the console is served from; the WAF fronting it.                                                                                              | `FRONTEND-DEPLOY.md`                                                                          |
| **Tiers & models**    | **Basic / Standard / Premium**                                         | you need a different model per tier, a new tier (e.g. enterprise), or a different persona / guardrail / context scope.                                                                                           | The **Models** section's routing reference and the tier a user is approved into (Users section).                                                    | `HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`, `MODEL_STRATEGY.md`                                         |

**A sensible first deployment:** Athena mode, built-in Cognito, `/battle` on, a
verified `senderEmail`, WAF on. That gives you the full Overview / Conversations /
Effectiveness (Evaluations) / Models / Experiments / Users console with archival and
basic evaluation, and nothing that needs a VPC. Turn on Aurora mode later when you
want the advanced quality/telemetry views - it's a `--context` flag, not a
migration. After deploying, run the two backfill scripts (`backfill-tier-groups.mjs` +
`backfill-channel-flow.mjs` in `backend/scripts/`), then create your first `admins` user.

## Access

The admin console is gated by the Cognito **`admins`** group (group membership
is authoritative - `custom:tier` does not grant admin). A user in `admins` sees
an **Admin** button in the app header; clicking it opens the dashboard. Non-admins
never see it, and every admin API independently re-checks the group.

## Navigation: 6 sections

The dashboard uses a two-level nav - a **section rail** across the top, and
**sub-tabs** within a section when it has more than one view. A **date-range
selector** (7 / 30 / 90 days) in the header scopes the analytics.

| Section | Sub-views | What it's for |
|---------|-----------|---------------|
| **Overview** | Overview, Latency | Platform health at a glance: message volume, active users (sign-in DAU vs messaging DAU), error rate; response-latency breakdown (Bedrock / polling / delivery), web-vitals, WebSocket connection health. |
| **Conversations** | - | The conversation administration surface (see below). |
| **Effectiveness** | Dashboard (the intent drill) + Evaluations, Flows, Tasks, Steps, Flagged, Ground Truth (Aurora mode) | How well each capability performs, with the **intent as the spine**. The Effectiveness dashboard ranks intents worst-first on two quality axes kept separate - Classification (did routing send the right traffic here) and Execution (given routing, did the work succeed) - with Latency, Cost/reply, and Tool-error rate as independently sortable decision columns, all coloured against `metricTargets.ts`. Clicking an intent drills to its exchanges or tasks, then a task's turn-by-turn state timeline, then that turn's tool-loop steps. The **Dashboard is the consolidation target**: the full detail from Evaluations, Flows, Tasks, and Steps is being folded into its drill, and each keeps its own sub-tab until its detail is fully in the drill (so no information is lost during the transition). Flagged and Ground Truth are standalone human-action tabs. |
| **Models** | Models, Model Strategy (+ Steps in Aurora mode) | Model telemetry (usage, effectiveness, feedback), the routing/strategy reference (provider posture, intent routing, fallbacks), and **per-step execution telemetry** (Steps: each Converse tool-loop iteration for a message - tool calls, tokens, latency - persisted out of band and surfaced via `/analytics/execution-steps`). |
| **Experiments** | - | A/B experiments: create/pause/resume/complete, compare model variants, arm `/battle`. Per-variant results fold in **real human signals** - thumbs approval-rate + head-to-head `/battle` wins - *alongside* the automated evaluator score, never blended; the live battle scorecard reports per-round outcomes. |
| **Users** | Users, Manage Users | Engagement (DAU, per-user leaderboard, signup/signin funnels by tier) and the approval workflow (approve/reject, set tier, enable/disable). |

## Conversations - administration surface

This is the **conversation-administration surface of the admin console** (see
`docs/specs/identity-access/SPEC-MODERATION.md`, which describes the full open set of surfaces). Two
halves, deliberately separate:

**Viewing reads the ARCHIVE, not live Amazon Chime SDK.** The conversation list and a
conversation's messages come from the analytics archive (the system of record
for history) - so you see every conversation regardless of which assistant
created it. Open a conversation from the list to load its messages and members.

**Inspect a message:** click **ⓘ Info** on any message row to open a side
drawer showing **every field** - full content, sender (name + ARN), timestamps,
redacted flag, role/tier, the parsed **metadata** (model, intent, tokens,
latency, …), and the full raw payload (incl. `MessageAttributes`). This is the
audit/debug view.

**Members:** the Members panel lists current members; **add** a member by ARN
(must belong to this app instance) or **remove** one (×). **Membership history**
below it is a timeline of joins / leaves / moderator grants, sourced from the
archive - the audit trail (Amazon Chime SDK exposes only the *current* members, not history).

**Administer a message:**
- **Redact** blanks a message's content (recoverable concept: the message stays,
  content removed). A channel **moderator** can redact; so can the admin.
- **Delete** removes the message entirely. **Delete requires the app-instance
  admin** - a moderator cannot delete. It is **irreversible** (you'll confirm).

All admin actions run as the operator's own `${sub}-admin` app-instance-admin
identity, vended per action via the credential-exchange admin plane; the dedicated
**service** app-instance-admin is used only for no-human automation (e.g.
membership-audit auto-revoke). Every action is **audit-logged** to CloudWatch
(`_auditEvent: admin_redact | admin_delete | admin_add_member | admin_remove_member |
admin_self_add`).

**Drift Detection** (toggle in the Conversations header) lists conversations
that drifted from their topic - Aurora-mode only (honest-empty banner in Athena).

## Targets - knowing what "good" is

Every measurement surface shows its **target** so a number is interpretable at a
glance. Metric cards show a "Target <=/>= X" line with a good / warn / bad colour;
the Latency view draws **target reference lines** on an actual-vs-target trend.
Targets live in one place (`metricTargets.ts`, tune them there) and are sourced to
published standards, not guesses: Google web-vitals, the drift-validation goal
(>=95% TPR, <=5% FPR), the evaluation score bands, and for latency the industry
response-time research below. (Alerting on target breaches is a separate capability,
not part of this console.)

**Latency reads differently here, on purpose.** A reply is delivered in two phases:
a placeholder lands in under a second, then the answer updates it in place, because
the assistant runs a multi-step tool loop (two or more model calls plus a retrieval;
see [`MESSAGE-FLOW.md`](../developer/MESSAGE-FLOW.md)). So the latency a user actually perceives
is **time to first feedback (TTFF, target <= 1s)**, and total time is a completion
and throughput signal bounded by the Nielsen 10s attention limit, not a 2s single-hop
budget. **If total latency looks "red," check TTFF first.** The full basis, the
per-hop breakdown of where the time goes, and the citations are in
[`LATENCY-TARGETS.md`](../developer/LATENCY-TARGETS.md).

## Athena vs Aurora mode

AgentEchelon runs **Athena mode** (default) or **Aurora mode** (`--context
analyticsMode=aurora`). Aurora-only views (the Effectiveness dashboard + its drill,
Flows, Ground Truth, Tasks, Flagged, drift detection) are **hidden** in Athena mode;
where a base view depends on
Aurora-only data it shows an honest **"Aurora-only - enable Aurora mode"** banner
rather than a silently empty table. Admin actions (redact/delete/members) are
**mode-independent**. Archive-backed Conversations viewing uses the Athena archive.

## Cost sleep mode (sleep / wake)

If the deployment was deployed with `-c sleepMode=true` (Aurora mode only - see
`docs/specs/analytics-eval/SPEC-COST-SLEEP-MODE.md`), an idle instance **auto-pauses its Aurora data
plane** after `sleepAfterIdle` (default 2h) to stop incurring cost, and users see
a "paused" banner instead of database timeouts. As an operator:

- **Wake it:** `POST {analyticsApi}/deployment/wake` (admin-authed) restores the
  Aurora capacity and clears the paused state. `POST …/deployment/sleep` forces
  sleep on demand.
- **Check state:** `GET {analyticsApi}/deployment/state` (public) returns
  `awake` / `asleep` - the source the frontend paused-banner reads.
- Sleep/wake events are emailed to `sleepRecipients` via SNS (delivered even
  while asleep). Nothing is torn down; wake is a fast, reversible capacity change.

## Admin notifications - where audit and error alerts land

The platform raises admin-facing alerts - Layer 6 membership-audit findings (over-tier
memberships) and admin-error alerts - and delivers them into a dedicated **Admin
Notifications** conversation, in-app plus email. Enable it at deploy time:

- **Turn it on:** deploy with `-c enableAdminNotificationChannel=true`. When it is off,
  those alerts fall back to **log-only** (CloudWatch) - they are not lost, but no human is
  paged. (You can instead point the audit at an existing channel with
  `-c membershipAuditAlertChannelArn=<arn>`, but the managed channel is the simpler path.)
- **Who owns it and who receives it.** The channel is created and owned by the **admin
  agent** (an AgentEchelon assistant, defined by a capability profile), which is also the
  identity that posts every alert. Its **members are the `admins` Cognito group**, and they
  are the in-app + email recipients. The service app-instance-admin identity is deliberately
  **never a member** - it is the cross-channel moderation identity and stays out of channel
  rosters; the admin agent, not the service admin, posts.
- **Adding an admin later.** Membership is synced when the channel is provisioned. A person
  added to the `admins` group after the last deploy is not a recipient until the channel is
  re-provisioned - either redeploy, or run the repair script below.
- **Provision or repair without a deploy:** from `backend/`,
  `AWS_REGION=<region> node scripts/provision-admin-channel.mjs`. It finds-or-creates the
  channel, re-syncs the `admins` roster, and prints the channel ARN. Idempotent and safe to
  re-run.

Design and identity model: `docs/specs/identity-access/SPEC-ADMIN-AGENT-NOTIFICATIONS.md`.

## Related docs
- [`LATENCY-TARGETS.md`](../developer/LATENCY-TARGETS.md) - the industry basis for the latency targets and where the time goes in the message flow.
- [`MESSAGE-FLOW.md`](../developer/MESSAGE-FLOW.md) - how a message travels, the tool loop, and the placeholder/update delivery that makes TTFF the perceived metric.
- `docs/specs/analytics-eval/SPEC-COST-SLEEP-MODE.md` - cost sleep mode (auto-pause / admin wake).
- `docs/specs/identity-access/SPEC-MODERATION.md` - the content-moderation surfaces (real-time
  channel-flow, inference-layer Guardrails, near-real-time Kinesis tap, client-side validation -
  an open set) plus the admin console (an administration surface, via the app-instance-admin).
- `docs/specs/admin-console/SPEC-ADMIN-CONSOLE.md` - the design behind this console.
- `docs/specs/identity-access/SPEC-ADMIN-AGENT-NOTIFICATIONS.md` - the admin agent + admin notification channel (where audit/error alerts land, and the bot-owns-the-channel identity model).
- `docs/guides/admin/AURORA-MODE-GUIDE.md` - enabling Aurora mode + its extra views.
