---
title: "ADR-055: Stacks are capabilities in layers, and a deployment declares the capabilities it stands up"
status: >-
  Accepted. Decisions 1 to 6 are built. `backend/bin/backend.ts` builds the required core under the target names
  (`backend/lib/config/stack-names.json`) plus each capability `capabilities` declares
  (`backend/lib/config/capabilities.ts`), refuses an unknown, not-built or unmet capability at synth, and refuses
  the four retired switches. A core stack names an optional capability's resources only at that capability's
  declared attach points, and core code reads an absent attach point as off, with no call and no warning. The
  `Meetings` stack and `IngressApi` are NOT BUILT. Verified by: `backend/test/deploy-matrix/` (every
  configuration synthesizes, and its stack-set, component-rule, SSM-edge and additivity checks pass) and
  `backend/test/the-core-names-no-undeclared-capability.test.ts`.
date: 2026-10-17
related:
  - "../../overview/STACKS.md"
  - "../../overview/ARCHITECTURE.md"
  - "../../overview/TENETS.md"
  - "../../specs/interface/DESIGN-SEPARATE-ADMIN-APP.md"
  - "./054-compute-is-per-classification-and-an-assistant-is-data.md"
  - "./056-two-http-apis-and-no-aws-waf.md"
  - "./057-assistant-stacks-come-from-the-registry.md"
  - "../../../backend/bin/backend.ts"
  - "../../../backend/lib/config/deploy-context.ts"
  - "../../../backend/lib/stacks/admin-services-stack.ts"
tracking: |
  Two published promises do not hold in the tree: an operator can stand up only the layers and capabilities they need, and one part is swapped without editing the others. The admin backend was described as already separable, so only the admin frontend became optional; its handlers live in the identity stack, both analytics stacks and the experiments stack. Three layer vocabularies are in use across the documents. This record settles one model and the rule that keeps the stacks on it.
---

# ADR-055: Stacks are capabilities in layers, and a deployment declares the capabilities it stands up

## Status

**Accepted.** The layout and the as-built list are both in [STACKS.md](../../overview/STACKS.md). What the CDK app does:

- It reads one declared list, `capabilities` (`backend/lib/config/capabilities.ts`), and builds the required core (`Messaging`, `Identity`, `Conversations`, `Archive`, `ChannelFlow`, `PostProcessing`, `PersonApi` and the `Assistants-*` stacks) plus each declared capability's stacks: `chat` (`ChatApp`), `admin` (`AdminServices`, `AdminApi`, `AdminApp`), `notifications`, `experiments`, `battle` (which requires `experiments`), `operations`, `connectors` (`Connectors`) and `widget` (`Widget`). `meetings` is refused at synth as NOT BUILT.
- `enableBattle`, `enableAdminApp`, `enableAdminNotificationChannel` and `enableMeetings` are retired keys, refused at synth with the capability that replaced each (`RETIRED_CONTEXT_KEYS`).
- It creates one `Assistants-<classification>` stack per classification the profile registry declares ([ADR-057](./057-assistant-stacks-come-from-the-registry.md)).
- A core stack names an optional capability's resources only at that capability's attach points (`attaches` on its registry entry), and core code reads an absent attach point as off, with no call and no warning: offboarding names the battle-setting table only with `battle`, the channel flow answers `/battle` without a read when `battle` is absent, the invitation and guest-upgrade functions name the mail sender only with `notifications`, and an observability role reads a capability's alarms only where it is declared.
- The smallest deployment it produces is the core with the deployment's own pool as its issuer. The smallest with no accounts is ten stacks: the core with `Assistants-guest` and `Assistants-customer` (a guest issuer needs both declared), plus `Widget` (STACKS.md, "The minimal set"). Without `admin`, no admin handler, route or role deploys: they are all in `AdminServices` and `AdminApi`. Core stacks raise alerts as `ae.alert` events whether or not `admin` is declared.

## Context

Three decisions are recorded together because none holds without the other two:

- **One layer model.** Without it, "stand up only the layers you need" has no layers to name.
- **The admin backend as two stacks.** Without it, the admin capability cannot be omitted, which is the case the published promise was made about.
- **One declared capability list.** Without it, each optional stack carries its own switch, and a consumer learns presence at runtime from a missing parameter.

The four architectural layers are already the vocabulary of [ARCHITECTURE.md](../../overview/ARCHITECTURE.md): Interface (the clients), Communication (client connectivity), Interaction (the engine) and Foundations (deploying and operating). No stack follows them. Every backend stack mixes Communication routes with Interaction state, and an admin route mounted on a feature's API puts the admin capability into that feature's deploy unit.

Tenet D9 already says a stack owns a capability, not a technology. The gap is that nothing states what a capability is at deploy time, or checks the rule.

## Decision

**1. One layer model, and every stack is one capability labeled with one layer.**

- **Interface:** the clients - the chat app, the admin console, the embeddable widget.
- **Communication:** client connectivity - the APIs and their authorizers, the messaging WebSocket, meeting media, email.
- **Interaction:** the engine - the conversation substrate, identity and the credential exchange, conversations, meetings as conversation state, assistants, connectors, the archive.
- **Foundations:** deploying and operating - the CDK app, tags, the deploy scripts, the operations stack.

Interaction and Foundations together make up the core, which always deploys whole. The layers are labels for what a stack does, not deploy units: what a deployer chooses is the components and capabilities in decisions 2 and 4.

**A service is not a layer.** The Amazon Chime SDK spans three: the WebSocket session and meeting media are Communication; the app instance, channels, flows, AppInstanceBots and AppInstanceUsers are Interaction; retention and streaming settings are Foundations. Cognito splits the same way: the user pool is an identity issuer (Interaction), managed login is Interface, and the token check is Communication. Stacks are cut by capability, never by the AWS service they use.

**2. The component rule, and no per-stack layer rule.** The layers are conceptual labels: STACKS.md labels each stack with its layer, and no per-stack layer dependency is checked. The rule is the order of the four deployable components the published overview names: the core first; then the chat interface and the admin backend on it; then the admin interface on the admin backend.

- The core (every Required stack) depends on no admin or interface stack.
- The chat interface (`ChatApp`) needs only the core.
- The admin backend (`AdminServices` plus `AdminApi`) needs only the core, never an optional stack, and is present or absent as one unit.
- The admin interface (`AdminApp`) needs the admin backend.

A strict per-stack layer rule, in which every stack depends only on stacks in its own layer or a lower one, is rejected. The admin plane is a slice across the layers (the admin console, admin identity and IAM enforcement, and the admin-facing parts of auditing), so a per-stack layer order describes it as pieces in three layers rather than as the one unit an operator includes or leaves out. The components are what an operator deploys, so they are what the rule binds.

An API stack takes handler references from the capability stacks it fronts, so a route exists exactly when its capability is declared.

**3. The admin backend is two stacks, omitted together.** `AdminServices` (Interaction) holds every admin handler, the admin credential exchange and its roles, the admin conversations and the admin alert channel. `AdminApi` (Communication) is the IAM-authorized API in front of it. No other stack reads either. Core stacks that raise an operator alert put an `ae.alert` event on the account's default EventBridge bus, and `AdminServices` adds the rule that posts it into the admin channel, so a core stack never depends on the admin capability.

**4. One declared capability list replaces the switches.** `capabilities` in `deploy.config.json` lists what the deployment stands up, for example `["widget", "chat", "admin", "battle", "experiments", "meetings", "notifications", "connectors", "operations"]`.

- The CDK app creates the required core plus exactly the declared stacks.
- Synth refuses a capability whose prerequisite is not declared, for example `admin` with no issuer other than the guest issuer.
- A capability that is not declared leaves no stack, no route and no required setting behind.
- Every consumer learns presence at synth, through an attach point the capability declares on its registry entry (an environment variable, a grant, a route). Core code reads an absent attach point as off: it makes no call for the capability and logs no warning, the way `experiment-manager.ts` reads an empty `EXPERIMENTS_TABLE` as no experiments. No core code probes for a capability's parameter at runtime.
- The `enable*` switches are retired through the same refusal `deploy-context.ts` applies to every retired key (`RETIRED_CONTEXT_KEYS`), so a stale value fails loudly rather than doing nothing.
- A guest is an issuer in the trusted-issuer registry, not a capability.

**5. The published deploy view is a view over the stacks, not a second model.** The core is the required set; the admin backend is `AdminServices` plus `AdminApi`; the chat interface is `ChatApp`; the admin interface is `AdminApp`.

**6. Additivity.** Adding a capability creates its own stacks and changes only the attach points above it: the two APIs' route tables, the frontends' generated settings, and the identity stack's issuer configuration when an issuer is added. Beyond those, it changes a core stack only at the attach points its registry entry declares: a function's environment (`ChannelFlow`, `PostProcessing`, `Conversations`), and an assistant stack's environment plus policies of the capability's own beside the resources it had, never a change to one of them.

## Consequences

- **The smallest deployment with no accounts is ten stacks:** the seven core stacks, `Assistants-guest`, `Assistants-customer` and `Widget`. An anonymous visitor in the widget talks to the guest classification's assistant. The customer classification is declared beside the guest, because a visit's upgrade path B opens its conversation there.
- **A configuration is a capability set, not a line.** Admin before customer accounts is a valid order, and so is chat with no admin.
- **The admin capability can be left out**, which is what a deployment that brings its own console needs.
- **Two stacks own the cross-cutting pieces that are spread today:** the message stream belongs to `Messaging`, and outbound email belongs to `Notifications`, which holds the only SES send grant.
- **Stack names come from one list.** `backend/lib/config/stack-names.json` names every stack, the operator scripts read it through `backend/scripts/lib/stack-lookup.cjs`, and `backend/test/retired-stack-names-are-refused.test.ts` refuses a retired name in `backend/` and `tests/`. A deployment on an earlier layout has no in-place upgrade path; it is deployed fresh.

## What is not built

- The `meetings` capability and its `Meetings` stack, which synth refuses with the reason.
- `IngressApi`, for a vendor with no Amazon EventBridge integration ([ADR-056](./056-two-http-apis-and-no-aws-waf.md)).

## What proves it

A configuration matrix test synthesizes each configuration cumulatively, from the anonymous widget alone through connectors, plus a headless chat configuration, each in both analytics modes. It diffs each configuration against the one before, where both synthesize the same registry and classifications, and fails on any change outside the allowed attach points, checks the component rule, and checks that every SSM read has an edge to its writer. It is `backend/test/deploy-matrix/`, one file per configuration (C0, C0 + `admin`, C1, C1-headless, C1-custom, C2, C3, C5, C6, C7), with the meetings configuration (C4) declared absent. Six configurations stand the core up with one layer at a time: C1-headless with `chat`, with `admin`, with `chat` and `admin`, with `experiments` alone, the duels set (`chat`, `admin`, `experiments` and `battle`), and C-example, which declares what `deploy.config.example.json` declares. A configuration declares only built capabilities, and the matrix refuses one that declares another. Every check binds: the stack set, the component rule, every SSM read's edge to its writer, and additivity, where a capability (`Battle`, `Experiments`) attaches its grants and resources to the core from its own stack and changes the core's environment alone. `backend/test/the-core-names-no-undeclared-capability.test.ts` holds rules 1 to 3 of CONTRIBUTING's "Deploy only what you declare" in both analytics modes: the core alone names no resource of `battle` or `notifications` in any template (no table, parameter, function or alarm, in any environment variable or grant); declared, each reaches the core at its attach points; and with an attach point absent, offboarding reads no battle store and a link is answered as not emailed with no invoke and no warning. `backend/test/lib/the-flow-pays-for-what-it-uses.test.ts` holds that `/battle` in a deployment without `battle` reads no battle setting, and `backend/test/an-assistant-acts-through-one-tagged-role.test.ts` that a capability's alarms are read through its own policy only where it is declared.

## Revisit when

A component cannot stand up in the published order: a core stack needs an admin or interface stack, the chat interface needs more than the core, or the admin backend cannot be left out as one unit. That is a sign a capability is two capabilities, and the answer is to split it, not to relax the rule.
