---
title: "ADR-052: The console is four surfaces, and one of them is privileged"
status: >-
  Proposed 2026-09-21. The layout half is BUILT (`SECTIONS` in `AdminDashboard.tsx`: Operations, Performance and Oversight sections, with Client a sub-view of Operations rather than a section of its own). The Oversight gate is BUILT, its Access Log included: the credential exchange refuses a per-conversation vend without a stated reason (`REASON_REQUIRED`, `credential-exchange.ts`), records it on the `admin_scoped_credential_vend` audit line, and scopes the credential to the one conversation (SPEC-ADMIN-CONSOLE FR51). Every vend, the console session included, is recorded durably in the Access Log before the credential is returned and is refused when the record cannot be written, and the Access Log tab in Oversight reads those records back (SPEC-ADMIN-CONSOLE FR30). A working record for a structure the owner is explicitly not committed to, written to be argued with and then deleted once the requirements it feeds are updated.
date: 2026-09-21
related:
  - "../../specs/interface/SPEC-ADMIN-CONSOLE.md"
  - "../../specs/interface/DESIGN-ADMIN-CONSOLE.md"
  - "../../specs/interface/SPEC-ADMIN-CONSOLE-EFFECTIVENESS.md"
  - "../../specs/interface/SPEC-FRONTEND-OBSERVABILITY.md"
  - "../../specs/interaction/governance/SPEC-ADMIN-IDENTITY.md"
  - "../../specs/interaction/governance/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md"
  - "../../specs/interaction/governance/SPEC-MODERATION.md"
  - "../../specs/interaction/governance/SPEC-ACCESS-AND-CONTROLS-AUDITING.md"
  - "../../guides/developer/LATENCY-TARGETS.md"
  - "../../overview/PERSONAS.md"
  - "./051-an-assistant-is-an-id-and-a-name-is-display.md"
  - "../../../frontend/packages/admin/src/components/admin/AdminDashboard.tsx"
  - "../../../frontend/packages/admin/src/components/admin/LatencyTab.tsx"
  - "../../../frontend/packages/admin/src/components/admin/ConversationsTab.tsx"
tracking: |
  The owner, 2026-09-21, gave thirteen notes on the dashboard and asked for honest feedback on the experience they would create, plus whatever is missing. Five of the notes name something that already exists under a different name, two rest on a premise the tree contradicts, and one is the missing half of a promise PERSONAS.md already makes. Those are recorded as corrections rather than quietly implemented, because implementing them as stated would have built a second copy of something the platform already has.
---

# ADR-052: The console is four surfaces, and one of them is privileged

## Status

**Proposed (2026-09-21). The layout half is built, and so is the Oversight gate with its Access Log.** `SECTIONS` in `frontend/packages/admin/src/components/admin/AdminDashboard.tsx` groups the console into Operations, Performance and Oversight, with Membership Audit inside Oversight and Client as a sub-view of Operations rather than a section of its own. The gate this record asks for is built for its first two parts: the credential exchange refuses a per-conversation credential without a stated reason (`REASON_REQUIRED`), records the reason on the `admin_scoped_credential_vend` audit line, and scopes the credential to one conversation, with a change costing its own reason (`adminReason.ts`, SPEC-ADMIN-CONSOLE FR51). The Access Log is built: the exchange writes every vend's record, with its reason, to a retained DynamoDB table before the credential is returned and withholds the credential when the write fails (`lib/access-log.ts`, `credential-exchange.ts`); the Oversight section's Access Log tab reads it under `view-access-log`, admins only, and records its own read (`access-log-reader.ts`, `AccessLogTab.tsx`). Records expire 400 days after the access (Verified by: `an-access-is-recorded-before-it-is-granted.test.ts`, `credential-exchange.test.ts`, `AccessLogTab.test.tsx`). Every claim is read from the current tree and cited. This record is disposable by design: it exists to be argued with, and the requirements it feeds (`SPEC-ADMIN-CONSOLE.md` first) are the durable artifacts.

## The problem

The console has eight top-level sections and about eighteen sub-views (`AdminDashboard.tsx:107-133`). They accumulated one at a time, each in the section that was nearest when it was built, and the result is that the Latency sub-tab now holds six unrelated things: server latency legs, client web vitals, WebSocket health, queue depth, a browser-versus-server diagnostic, and a duel filter. A reader cannot tell which of those answers their question, and two of them are not even read from the same store.

The owner's thirteen notes are all corrections in the same direction: separate the surfaces by *who is asking and from which store*, rather than by what was convenient.

## The decision

**Four surfaces, distinguished by the question they answer and the store that answers it.**

| Surface | The question | Store | Time semantics |
|---|---|---|---|
| Performance | How fast and how good is it, sliced by assistant | Aurora projection (`v_turn_latency`, `messages`) | a range you choose |
| Client | What does the browser experience | `client_events` | a range you choose |
| Operations | Is it healthy right now | CloudWatch `GetMetricData` | now, and a short trailing window |
| Oversight | What was said, by whom, and who looked | Archive plus Amazon Chime SDK | a matter, not a range |

That table is the whole argument. Tenet D7 says to know which store answers a question and to use one source per question; the current Latency tab violates it visually by putting a CloudWatch panel (`QueueHealth.tsx`, served by `queue-health.ts` over `GetMetricData`) beside SQL-derived latency legs, which invites a reader to compare two numbers that do not share a clock, a population, or a refresh cadence.

## What the owner asked for, and what the tree says

Honest feedback was requested. Five notes are already built, two rest on a premise that is wrong, and the rest are sound.

### Already built, needing promotion or renaming rather than construction

**"Need to add [placeholder to post-processing delay] to analytics."** It exists. `answer_ms` is defined in `v_turn_latency` as the final answer less the placeholder (`schema/052-a-queued-message-that-was-answered-is-a-response.sql:161`), documented at `LATENCY-TARGETS.md:149` as "the half of E2E the person spends watching a placeholder." It is derived at read, so it cannot drift from the instants it is defined against. The work is to promote it from the audit panel to a headline leg, not to measure it.

There is a real gap underneath the ask, and it is larger than "show the leg." **The console can attribute latency to polling, the model, tools, the guard and every router step, but it cannot attribute any latency to post-processing at all.**

`total_ms` is stamped about three hundred lines before the final `UpdateChannelMessage` (`LATENCY-TARGETS.md:67`), on the reasoning that a number cannot include the cost of its own delivery. That reasoning is sound, and the consequence is that the whole delivery leg sits outside every server-clock bracket. It lands in `unattributed_ms`, defined as E2E less `inbound_ms` less `total_ms`: "the part of the wait no bracket claimed."

That residual is a bucket rather than a measurement. It holds the final `UpdateChannelMessage`, propagation to the client, **and NTP skew**, because it is taken across two clock domains. It is also shown per-turn in the Turn Latency Audit panel only, and it is explicitly not an SLO metric: nothing in `metricTargets.ts` or `alerts.ts` reads it.

### The answer does not travel through Kinesis post-processing at all, and this record said it did

**Asked by the owner, 2026-09-22: when is the final update to the placeholder made via Kinesis post-processing? The answer is never, today.** `message-post-processing.ts` contains no `UpdateChannelMessage`; its four rules are `repairTaskAnswer`, `triageOnArrival`, `notifyOnDelivery` and `refreshRoutingContext`. The async processor writes the answer onto the placeholder directly, with its own call, on its own invocation. ADR-032 says why: the stream is where "later" lives, and the critical path is reserved for what cannot be done later. Delivering the answer cannot.

So the paragraph above previously named a Kinesis stream wait as a component of a person's wait, and that was wrong. The stream carries archival, the repair, triage-on-arrival and the notification fan-out - none of which a person is waiting on.

**Which changes what `ApproximateArrivalTimestamp` is worth, and this record should not have led with it.** Reading it still isolates stream queuing delay from compute on one clock, and it is still free. But it measures **how fresh the analytics and the side-effect rules are**, not how long anybody waited for an answer. That is worth having - a repair that fires late is a person waiting on work that reached nobody, and archival lag is what makes a dashboard disagree with the conversation - and it is not the latency gap this section opened with.

**The honest version of the gap is smaller and still real:** the final `UpdateChannelMessage` and the propagation behind it are outside every server-clock bracket, and `e2e_ms` is the only figure containing them. Splitting `answer_ms` into "the assistant was working" and "the answer was landing" is a subtraction across two clock domains, so it is an estimate rather than a measurement, and it should be labeled as one wherever it is shown.

**And delivery is NOT moving onto the stream.** That was proposed for the targeted path and is withdrawn, for two reasons worth keeping apart because only the first was the owner's:

1. **The inbound id is now declared, so the reason to reach for it is gone** (owner, 2026-09-22). The flow stamps the inbound `MessageId` into a targeted message's body before Amazon Lex is invoked, so that path names its turn instead of hashing a window.
2. **It would not have worked regardless.** Post-processing is defined as after delivery (ADR-032): the flow is the FIRST component to see a Lex-materialized acknowledgment and the stream is strictly later, so moving the claim there would have made the mapping arrive later, not sooner - the opposite of the problem.

One thing the stamp does NOT solve, and it should not be read as solving: the **acknowledgment's** id on the Lex path is still unknown until it crosses the flow, because Amazon Chime SDK materializes it from the fulfillment return and no component of ours creates it. So that path still reads the mapping and still waits when it is not there yet. That wait is a bounded read on an exact key, which is the trade the owner asked for - delay in exchange for accuracy on the targeted path - rather than a defect to remove.

The timestamp therefore stays optional and stays scoped to what it actually measures: how fresh the analytics and the side-effect rules are.

Splitting `answer_ms` into "the assistant was working" and "the pipeline was carrying it" then becomes a real division rather than a subtraction across clocks.

**There is a second unattributed region, in front of the turn rather than behind it.** The worker leg closes exactly: `total_ms = guard_ms + placeholder_resolve_ms + latency_ms + tail`, all on one clock, so anything inside the processor can be attributed. The front leg does not close. `inbound_ms` spans Amazon Chime SDK ingest, the channel flow, Lex, the whole router and the cold start as ONE figure, and it overlaps `router_ms` entirely rather than dividing it (`LATENCY-TARGETS.md:145`). The pre-router hop is deliberately left as prose rather than published as a column, because a residual taken across a clock boundary is an estimate.

That is the hop the entry filter was expected to expose. Only a targeted message reaches Lex, so the Lex cost is real and it is currently inseparable from ingest and cold start. **Filtering `inbound_ms` by entry and comparing the two populations is the closest available reading**, and it is a comparison rather than a measurement: it says targeted turns start slower by some amount, not that Lex costs that amount. Worth stating plainly on the surface, because the number invites the stronger reading.

**"Targets need to be filterable."** Latency already filters by Tier, Assistant, Role, Version, Entry and Duel (`LatencyTab.tsx:531-610`). Entry is the targeted-versus-standard split the owner asked for and it shipped earlier the same day.

**"Battle details should be reserved for experiments."** There is no battle panel on Latency to remove. Battles are reviewed on their experiment's page (`ExperimentBattles.tsx`); Latency carries only a Battle filter pill (`LatencyTab.tsx:599-610`). **Keep that pill.** A duel fans out, so battle turns skew latency percentiles, and removing the ability to exclude them would make the aggregate quietly wrong. The open question is not where battles are shown but whether they are in the default population at all.

**"Queue health is a separate tab."** Agreed, and for a better reason than crowding: it is the one panel read from CloudWatch rather than the ledger, and it answers "now" rather than "over a range."

**"Web page and other page metrics should be in their own tab."** Agreed. `SPEC-FRONTEND-OBSERVABILITY.md` is still `Proposed` and already owns this, which makes it the cheapest place to land the change.

### Where the premise is wrong

**"Polling should be removed. I don't believe it exists except for fallback now."** REVISED 2026-09-22, at the owner's direction, after measuring. The first version of this section said `poll_ms` timed "a single scan" and that there was "no polling loop". Both halves were wrong.

`pollForPlaceholderMessage` is a **retry loop on a DynamoDB point read** - six attempts on a 1.5x backoff, the last read at about 2 seconds (`backend/lambda/src/lib/async-processor-core.ts`). It is not a channel scan; the channel/bot parameters it once took were deliberately removed. So it IS polling in tenet D6's plainest sense: a timer waiting on an event.

The measured cost is much smaller than the window suggests: over seven days to 2026-09-22, 92% of the 230 polls that resolved did so on the second read, after one 150ms sleep.

**And it was not rare.** CloudWatch, dev, three days to 2026-09-21, the three live processors: **127 of 270 turns (47%) entered it, and none gave up.** 116 of the 127 resolved on the SECOND read, about 150 ms after the first miss. The mapping was never absent, only late - and the lateness was one fixed thing, the round trip the id was taking from the component that already held it.

**So the owner's instinct was right and this record argued against it on bad evidence.** `db0fae2` removed the cause on the bypass path: the handler claims `corr# -> MessageId` from its own `SendChannelMessage` response instead of waiting for the channel flow to observe the message and write it.

What remains is genuinely a fallback, and it should be measured as one:

- **The Lex path still polls, by design.** Amazon Chime SDK materializes that acknowledgment, so the flow is the first component to see its id and the worker can legitimately look before it exists. Delay there is the correct trade: the read is keyed on the correlation id, which is exact, and waiting for an exact answer beats guessing at a fast one.
- **On the bypass path a poll now means something is wrong** - the claim at the send failed, or the worker outran a write it should not have. That is an alarm, not a latency component.

The two are indistinguishable in today's number, which is why the call sites are now labeled `before-inference` and `at-delivery`, and why the figure belongs on Operations as a rate rather than on Performance as a duration. **The rate after the deploy is the test of all of this, and it has not been read yet.**

**"Browser vs server shouldn't be visible to anyone except me as developer."** The instinct is right, the gate is wrong. `PERSONAS.md:16` defines Platform developer as the persona that "needs technical telemetry and the raw event structure," and `SPEC-ADMIN-CONSOLE.md`, under Personas, gives them "trace a turn step by step." That is this panel. Gating it on one person does not survive the project being deployed by someone else, and every deployment has a platform developer. Gate it on the capability, which is the pattern `DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md` already uses for every other privileged view.

### Sound, and the reasoning is worth recording

**Progressive disclosure of legs.** The owner asked for the Router leg table to appear only when TTFF is selected. The general rule is better than the special case: **a leg is only shown inside the metric it decomposes.** Router steps sum to `router_ms` by construction (`LATENCY-TARGETS.md:115`) and `router_ms` sits inside TTFF, so the table is meaningless except as a drill on TTFF. The same rule then places `classifier_ms` under Router and `model_ms`/`tool_ms` under worker compute, and it stops the grid from growing a card per measurement forever.

**Shared filters between Latency and Effectiveness.** They share only `dateRange` today (`AdminDashboard.tsx:218-224`). Latency owns the richer set locally in a `FilterPills` component that is defined inside the file and never exported (`LatencyTab.tsx:86-126`); Effectiveness re-implements a subset as plain selects (`EffectivenessTab.tsx:601-621`), with near-duplicate tooltip copy. Lifting `FilterPills` into `@ae/shared` and the state into the Performance shell is the change.

The cascade the owner described (classification, then assistants and roles within it, then versions once an assistant is chosen) is right, and it is the same axis set ADR-051 argues for: an assistant has an id, a classification, and a role. **The filter bar is where that ADR becomes visible to a user**, which is a good reason to land them together.

Three things the cascade needs that were not named:
- **Reset semantics.** Changing classification invalidates the selected assistant. Say whether that clears the assistant or blocks the change.
- **Empty states that distinguish two cases.** "This classification has no assistants" is a configuration fact; "no data in range" is a measurement fact. Showing one message for both sends people to the wrong place.
- **The filter state belongs in the URL.** It is React state today, so a filtered view cannot be sent to anyone. On a console where Legal, HR and a manager work the same conversation, that is the difference between collaborating and describing.

## Oversight, which is the part that is not a layout change

The owner's two Conversations notes are the only ones that change authority rather than arrangement, and they are the reason this record exists.

### Naming it "Moderation" would entrench the conflation the IAM model avoids

`SPEC-MODERATION.md` keeps channel-scoped moderator `redact` distinct from cross-conversation admin `delete`, and records that containment is the channel scope on the vended credential. A browse-every-conversation view is administration; the redact button inside one conversation is moderation. Labeling the parent "Moderation" gives the cross-channel surface the narrower word, which is the conflation the whole identity model is built to prevent.

**Proposed: the section is Oversight.** It holds Conversations, Membership Audit (today's "Security"), and an Access Log. Moderation is what you *do* to a message inside it, and the button already says so.

The owner's instinct to put Security beside Conversations is right and the current placement is worse: "Security" is a top-level section containing exactly one sub-tab, `MembershipAuditTab.tsx`, labeled "Membership Audit" (`AdminDashboard.tsx:132`). A section whose name and only child disagree teaches nobody where to look.

### Hiding names while showing message bodies is not a privacy control

This is the honest feedback the owner asked for, and it is the one place the proposal as stated would not achieve what it is for.

`ConversationsTab.tsx` shows sender display names (`:442`), member names (`:510`), actor names falling back to ARNs (`:571-575`), and **full message content previews** (`:446`), with the inspect drawer showing the raw stored payload. Defaulting the *names* to ids while leaving *message bodies* in the same table moves the least sensitive field behind a gate and leaves the most sensitive one in front of it. A conversation body is the thing that carries the medical detail, the grievance, and the salary figure. The name is the index to it.

If the goal is minimization by default, the ordering is: message content first, then identity, then metadata. If the goal is *unlinkability* (seeing that something happened without learning whose it was), then ids-not-names is exactly right, and it should be stated as that goal, because the two lead to different designs.

A pseudonymous id is still personal data under GDPR, and `ARCHITECTURE.md:808-822` already carries that caveat. So this reduces exposure; it does not move the surface out of scope.

### The gate, as the owner specified it (2026-09-22)

**The reason is required BEFORE the credential is vended, and the credential is what the reason buys.** Not a dialog the client shows and then calls the same endpoint anyway: the stated justification is a precondition of the grant, so an operator who did not give one holds nothing to read with. As built, the exchange refuses a vend with no reason (`REASON_REQUIRED` in `credential-exchange.ts`) and records the reason after `AssumeRole` returns, on the `admin_scoped_credential_vend` audit line, which is a CloudWatch log line only. The Access Log build (below) records the reason durably before the response. That also makes the mechanism demonstrate the platform's own claim - capabilities are scoped and delegated by narrowing a vended, recorded grant rather than by rewriting a policy (tenet D4) - on a surface a person can watch it happen on.

**Two levels, because "read everything" and "read this matter" are different asks.**

| Level | What is requested | What the credential can reach |
|---|---|---|
| Broad | the Oversight surface itself | conversations across the deployment, for the session the reason opened |
| Scoped | a named conversation, by id | that conversation and nothing else |

The scoped level is the one Legal and HR actually need, and it is the one `PERSONAS.md` already promises them ("purpose-scoped and audited"). A matter names its conversations; it does not need the deployment.

**A change costs a second reason and a second credential.** Reading is not writing: changing membership, deleting a message and redacting a message each require their own justification and their own grant, because each is an action on somebody's record rather than a look at it. This is also where the existing split already points - `attachment-read` against `attachment-read-uploads`, the second marked "moderation grade, sensitive audit plus UI confirm".

**The seam exists.** `DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md` already maps privileged actions to named capabilities and API resources, and the Credential Exchange already vends short-lived, channel-scoped, audited sessions for attachments (`S3_ATTACHMENT_CAP_PREFIXES` in `credential-exchange.ts`). This narrows that vend by conversation and puts a stored reason in front of it; it does not introduce a new mechanism.

**The gate is built, on its own and not inside a layout change:** every per-conversation vend requires a stated reason and is scoped to the one conversation (SPEC-ADMIN-CONSOLE FR51). Open questions it still leaves: how long a grant lasts and whether it renews silently; what the reason field accepts, given a free-text box nobody reads is the failure mode this is meant to avoid; whether a denied or expired grant degrades to the id-only view or to nothing; and who can read the access log, since a log only its subjects cannot see is an assurance to the operator rather than to the person.

### Reason for access is the missing half of a promise already made

`PERSONAS.md:31` and `:34` say Legal and HR have "High-sensitivity access: purpose-scoped and audited." The stated reason is specified and built for every per-conversation credential and action (`SPEC-ADMIN-CONSOLE.md`, "Stated reason", FR51), and the Access Log reads those reasons back (`SPEC-ADMIN-CONSOLE.md` 3.3, FR30). `SPEC-ADMIN-IDENTITY.md:92` lists "read-access logging of sensitive reads" among the things a GDPR-style deployment must add.

So the remaining work is not a new feature request. It is the unbuilt half of two personas the product already claims to serve, and the console cannot answer the one question Legal exists to ask: who accessed this conversation, and when.

**Two precedents to extend rather than invent** (tenet D8):
1. `view-user-activity (PII)` is already a named capability mapped to an API Gateway resource (`DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md` §2).
2. `attachment-read-uploads` is already scoped to user uploads that may carry PII, moderation grade and audited distinctly (`SENSITIVE_ATTACHMENT_CAPS` in `admin-credential-exchange.ts`), reached through a short-lived, channel-scoped, audited Credential Exchange vend rather than a server-side bearer.

The design follows from those: PII resolution is a **separate, capability-gated call** that takes a reason, not a field the list endpoint returns and the client hides. If the reason is collected in the browser and the API returns names anyway, the control is CSS.

**What is built is the field-omission variant, which satisfies the concern above and not the design.** `admin-conversations` withholds the participant name from the read itself (SPEC-ADMIN-CONSOLE FR41), so the value never reaches the browser and the "control is CSS" failure does not apply. The name resolves on a sub-path of its own, `GET admin/conversations/identities` under `see-user-identity`, which the gateway refuses to a role without the capability. One thing this ADR asks for is still absent: that route takes no **reason**, so nothing is recorded for seeing a name. The omission is the interim that stops the disclosure meanwhile; it is not the graded read (FR29), and it is **not** the Access Log dependency below.

**And it has a hard dependency.** A reason with nowhere durable to land is theater. The gate is built, and so is the Access Log (FR30) that makes its reason real: the reason is recorded durably before the credential is returned, and a vend whose record cannot be written is refused. It is also the Legal persona's own primary need.

## What is missing from the thirteen notes

**Cost has no home.** Tenet P5 names the four things a builder controls: cost, performance, quality, and policy. The proposed Performance surface carries performance and quality. Cost is computed (`estimateStepCostUsd`, `backend/lambda/src/analytics-aurora/analytics-query.ts:21`) and sliced by the same four axes, so it belongs in the same shell behind the same filters. Today it is scattered across Models and Overview.

**Policy has no home either.** Guardrail decisions, refusals, and compliance-rule findings are the "adherence to the business's own policies" half of the same tenet. A deployment that has configured compliance rules has no view that answers how often they fire.

**The persona docs contradict each other on Manager**, which matters because Manager is the persona the "moderator view" header would be written for. `PERSONAS.md:22` says Manager "needs the conversation content and the redact (moderation-level) capability for their scope." `SPEC-ADMIN-CONSOLE.md`, under Personas, says Manager reads "outcomes for decisions ... without touching the underlying stores." Those cannot both be true, and the answer determines whether the Conversations view has one audience or two. Filed separately; it should be settled before the header copy is written.

**`SITE-MAP.md` is already stale**, saying "7 sections" and listing five. Any restructure must update it or it drifts further.

**Policy is NOT getting a console surface, and the guides should say where it actually lives** (owner, 2026-09-22). Policy today is the channel flow plus Amazon Bedrock Guardrails, and guardrails are configured in the AWS console rather than in ours. A first-class policy view is therefore not buildable here without duplicating a control plane we do not own - and a console page that showed guardrail state it could not change would be the worst of both, implying an authority the product does not have.

So the answer is documentation, not a tab: the guides state plainly that policy is enforced in the channel flow and in guardrails, that guardrails are managed in AWS, and what an operator can and cannot see from here. That is the honest version, and writing it down is cheap. `HOW-TO-CONFIGURE-COMPLIANCE-RULES.md` is the natural home, with a pointer from the admin guide.

This also removes "policy" from the list of things the Performance shell is missing above: cost belongs there, policy does not belong in the console at all today.

## Consequences

Four sections replace the current Overview/Conversations sprawl, and three specs move together: `SPEC-ADMIN-CONSOLE.md` (feature catalog and personas), `DESIGN-ADMIN-CONSOLE.md` (nav, `TabId`, `QUERIES_BY_TAB`), and `SPEC-FRONTEND-OBSERVABILITY.md` (which gains the Client surface it already specifies). `ADMIN-GUIDE.md` and `SITE-MAP.md` follow the nav.

The Oversight work is not a restructure and should not be scheduled as one. It adds a capability, an audited resolution path, and an access log, and it touches `SPEC-ADMIN-IDENTITY.md` and `SPEC-ACCESS-AND-CONTROLS-AUDITING.md`. It is worth doing on its own merits because two documented personas currently have no mechanism.

Nothing here is decided. The layout half is low-risk and mostly moves existing components. The Oversight half is the part that deserves the argument.
