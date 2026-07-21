# Conversation Configuration - a conversation is a configurable experience

**Status:** Partial (the `classification` type seam and the dimension/connector schemas ship and default to the profile today; the full conversation-type flexibility is the design target).

**Problem and who it's for:** A support case, a sales engagement, a scheduled service visit, and an incident room are all "a conversation," yet each needs different participants, assistant, transports, access, and external systems - and teams want to stand up and tailor each experience by configuration, not by writing and shipping new handler code (or a separate bespoke app) for every one. This is for the AI developer and admin/operator who add or tailor experiences by config. It captures that policy as data: a conversation type is the composition root that names which assistant, which access, which connectors, and which capabilities an experience gets, so handlers read dimension fields instead of branching on type.

**Site section:** Interaction layer, Conversation Configuration pillar (composition root).

The `classification` type seam and the dimension/connector schemas live in `backend/lib/config/conversation-types.ts` + `backend/lib/config/connectors.ts` (additive; `driftEnabled` is read live and the type defaults to the tier). Part of the interaction-layer set (`docs/specs/interaction/SPEC-INTERACTION-LAYER.md` is the map). This pillar is the **composition root**: a conversation type is the policy bundle that names which assistant, which access, which external systems, and which capabilities an experience gets.

**Related:** `docs/specs/interaction/SPEC-INTERACTION-LAYER.md` (the model) · `docs/specs/interaction/identity-access/core/SPEC-CREDENTIAL-EXCHANGE.md` (Identity & Access) · `docs/specs/interaction/assistant-config/SPEC-ASSISTANT-CONFIG.md` (Assistant Configuration) · `docs/specs/interaction/identity-access/core/SPEC-CONVERSATION-SECURITY.md` (the security layers) · `backend/lib/config/conversation-types.ts` + `backend/lib/config/connectors.ts` (the shipped seams).

---

## 1. Why

A conversation should be a **configurable experience, not a fixed chat.** A support case, a sales engagement, a scheduled service visit, and an alert-triggered incident room are all "a conversation" - but each needs different participants, a different assistant, different communication channels, different access, and a different relationship to the business's external systems. If every new experience requires new handler code, the platform can't grow. The conversation **type** captures that policy as **data**, so a new experience is a configuration, not a code change.

## 2. Who benefits

- **The business** adds or tailors an experience (a new support flow, a service journey) by editing config, without forking the agent code.
- **Customers & internal users** get an experience shaped to the moment - the right assistant, the right channels, the right people - instead of a one-size chat.
- **Contributors** reason about one composition point instead of scattered per-feature branches.

## 3. Experiences the model enables

The tiered private chat (basic/standard/premium) is the conversation type that ships today. The composition model is built so that additional experiences are *configuration, not new handler code*: each is one conversation type composed from the same pillars. The following are illustrative, showing how far the same dimension/connector schema stretches without new branching logic:

| Use-case type | Shape |
|---|---|
| Engagement | single assigned owner (default, non-exclusive), reassignment as a membership op |
| Support | widget/phone → assistant triage → router-resolved agent for the case (routed/ephemeral) |
| Service | scheduled visit + masked voice/SMS + meeting, one attached history |
| Internal IT | in-context help → routed service-desk ticket (the smallest first connector) |
| Incident triage | alert-initiated room → dial-in on-call + live data → escalate to vendor |

Each maps onto the connector capability contract (§6). Adding one is a new `ConversationTypeConfig` entry plus, where a non-chat transport or external system is involved, a connector; no handler `switch (type)`.

## 4. The model

A conversation type is a named bundle that **composes orthogonal dimensions**, each with a safe default. Handlers never `switch (type)` - they read dimension fields and call generic engines, so a new experience recombines existing dimensions (and a genuinely new behavior is a new *dimension*, added once). The shipped schema (`conversation-types.ts`):

```ts
interface ConversationTypeConfig {
  key: string;                 // open string - deployers add types freely
  classification: ModelTier;   // CLOSED, ordered - the one IAM-evaluated axis (§4a)

  // optional, defaulted, composable dimensions:
  initiation?: 'user'|'system'|'schedule'|'alert';  // who/what starts it (default 'user')
  defaultAgents?: string[];                          // which assistant(s) - see SPEC-ASSISTANT-CONFIG
  commsChannels?: CommsChannel[];                    // chat (default) + voice/sms/video/email (a connector provides non-chat)
  capabilities?: { tasks?: boolean; battle?: boolean; [k]: boolean };
  driftEnabled: boolean;                             // topic-drift suggestion on/off (shipped)
  participants?: ParticipantPolicy;                  // who joins + how non-creator humans are resolved
  connectors?: ConnectorRef[];                       // external vendor systems (§6)
  offboardMode?: 'delete' | 'deactivate';            // how a departed member appears in history
  expiration?: { days: number; criterion: 'CREATED_TIMESTAMP'|'LAST_MESSAGE_TIMESTAMP' };  // default channel TTL → Amazon Chime SDK ExpirationSettings (SPEC-ACCESS-AND-CONTROLS-AUDITING §4c, toggle 2)
  metadataSchemaVersion?: number;                    // forward-compat snapshot version (§7)
}
```

### 4a. The type *carries* a classification - it never *is* one
Access is gated by a small, **ordered, closed** set of security classifications that IAM evaluates (the channel's `classification` tag - see SPEC-CONVERSATION-SECURITY). Conversation types are meant to proliferate and need no ordering (there's no order between `support` and `engagement`). So a type **carries** a classification (one of the closed set) rather than being one. **Invariant: adding a type never adds a classification** - a new classification is a separate, security-reviewed change (it touches the ordered allow-list and its deny-tests). This keeps the catalog open while the enforced security axis stays minimal.

### 4b. The conversation is the hub
The conversation (an Amazon Chime SDK channel + its metadata/context) is the **runtime hub** every transport and connector attaches to: non-chat transports (voice/SMS/meeting) and external systems post their artifacts (summaries, structured cards) **back into the conversation** and link external records by reference (`ExternalRef`). So "history attached to the conversation" needs no separate aggregate store - the channel is the conversation, and everything attaches to it. A conversation-matcher routes inbound external comms to the right conversation. (`channel-creation.ts` stamps `parentChannelArn`/`createdViaDrift`.)

## 5. How it composes with the other pillars

The type is the composition root; the conversation (channel) is where it all meets:

- **→ Identity & Access** via `classification`: the type sets the channel's classification tag at creation; Identity (the credential exchange) enforces it in IAM. A participant's effective capability = **their access rung ∧ this type's policy** (the two enforcement layers).
- **→ Assistant Configuration** via `defaultAgents`: the type selects which assistant(s) (model / prompt / tools / guardrail) the experience uses.
- **→ Connectors** via `connectors[]`: the type declares which external systems the experience may use, and for what (§6).

## 6. Connectors - integrate with the business's systems, don't replace them

A **connector** is one integration to one external vendor (Salesforce, ServiceNow, Jira, AWS Support, PagerDuty, …). Broad per-vendor: one connector may implement several capabilities; the runtime consumes them generically (never `switch (vendor)`). Capabilities (open set):

- **`resolveParticipant`** - turn "bring in a human" into a concrete identity via the vendor's router/assignment (the platform does **not** reimplement routing - it calls the vendor's API + existing AWS event integrations). The resolved person is admitted at the channel's classification.
- **`syncRecord`** - create/update/read a ticket/case/work-order and attach the transcript; rides a normalized, vendor-neutral `PlatformEvent` taxonomy on an EventBridge bus, idempotent by `eventId`.
- **`fetchContext`** - read external/observability data into the conversation (e.g. CloudWatch/CloudTrail).
- **`provideComms`** - supply a non-chat transport (voice/SMS via a pluggable provider, Amazon Chime SDK Meetings); artifacts summarize back into the hub (§4b).
- **`ingest`** - inbound mirror (a vendor webhook → platform actions), signature-verified.

A conversation **type** declares available connectors (`ConnectorRef`); a conversation **instance** holds the live bindings (`ExternalRef` - the specific case/call). **Security:** per-vendor, **per-tenant** credential isolation in Secrets Manager (`connector/{tenantId}/{connectorId}`) with scoped IAM - one tenant's connector run cannot read another's secret; outbound actions (dial, open case, dispatch) are audited; externally resolved humans are admitted under the **same** classification (connectors feed admission, never bypass it).

## 7. Security & forward-compatibility (what must stay true as it grows)

- **`classification` is the only closed/ordered IAM axis** (§4a); everything else is open string-keyed config.
- **Snapshot at creation** - a channel stamps its resolved policy (`{conversationType, metadataSchemaVersion, policySnapshot}`) so a registry edit never retroactively changes a live conversation.
- **Lenient resolution** - unknown type/field/connector → safe default or skip-and-log, never a hard failure; newer-schema and older-schema both resolve safely.
- **No switch-on-type / switch-on-vendor; additive-only schema** (bump `metadataSchemaVersion`; deprecations are soft). Growth never breaks a deployed conversation.
- **Backend-owned policy** - the frontend reads/displays; it never defines policy.
