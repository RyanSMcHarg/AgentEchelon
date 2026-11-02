# Personas

The canonical people AgentEchelon serves. Specs reference these by name and link here; they do NOT re-define personas inline. This is the single source of truth for who the product is for.

Personas are distinct from **classifications** (the `basic`, `standard` and `premium` classifications this repo ships). A classification is a boundary on data and models; a persona is a role a real person plays. One person can hold different classifications in different conversations.

## Product personas

### End user
Chats with assistants to get work done. Sees only the conversations they are a member of, and models bounded by the channel's classification. Wants fast, on-topic, trustworthy replies; does not administer anything. Primary surface: the chat application.

### AI developer
Builds and tunes the assistants (personas, models, intent packs, profiles). Needs quality signals - intent distribution, evaluations, tool/step telemetry, drift, ground truth - and prompt/reply pairs, scoped to the assistants and classifications they own. Does not need customer message bodies by default. Primary surfaces: admin console (Effectiveness, Models, Experiments), profile config.

### Platform developer
Builds and debugs AgentEchelon itself. Needs technical telemetry and the raw event structure; the platform internals. Does not need customer message content by default (scoped, opt-in, audited when required). Primary surfaces: admin console (Overview, Security, raw events), the code.

### Admin / operator
Runs a deployment. Reads and moderates conversations, manages users, watches health and cost, reviews the security/membership audit. The break-glass, full-access role for a deployment. Acts as their own short-lived, audited `${personId}-admin` identity for privileged actions, never a standing bearer. Primary surface: the admin console.

### Manager
Monitors a use case: the interactions between their team and their customers. Needs the conversation content and the redact (moderation-level) capability for their scope, and none of the platform internals or config. Scoped to their use-case channels. Primary surface: admin console (Conversations, scoped).

### QA / test engineer
Validates that assistants and experiences behave correctly across scenarios and edge cases; owns test coverage and regression, and gates releases. Consumes the platform's evaluation, battle-as-comparison, and e2e/validation capabilities to test the assistants THEY build in the deployer's org. Distinct from the AI developer (who tunes quality) and the platform developer (who debugs the runtime); validating AgentEchelon itself is a platform-developer activity, not this persona. Primary surfaces: admin console (Effectiveness, Flagged, Ground Truth), battle-as-test.

### BI analyst
Analyzes and reports on platform data - usage, adoption, effectiveness, cost, funnels, experiment results - and needs queryable access and data EXPORT to their own BI tools, not just curated dashboards. Distinct from the manager, who consumes curated views to make a decision. Their primary surface is often AWS-native (QuickSight / Athena / their own BI stack directly on the governed archive, the data-in-your-account model), alongside the admin console's analytics and the export / scheduled-report / custom-dashboard capabilities (several currently roadmap). AgentEchelon does not build a BI tool; it exposes governed, queryable data and lets the analyst bring their own stack.

### Legal
Reviews conversations for legal matters: litigation hold, e-discovery, regulatory requests, liability disputes. Needs read access to the specific conversations tied to a matter, including the preserved history (redacted and deleted content is retained rather than overwritten; how long the archive keeps anything is its deployed lifecycle, which as shipped expires objects at 90 days - see SPEC-ACCESS-AND-CONTROLS-AUDITING FR12), plus preservation/export and a who-accessed-when trail. Does not touch platform config, effectiveness, or user management. High-sensitivity access: purpose-scoped and audited. Primary surface: admin console (Conversations, scoped).

### HR
Reviews conversations for workplace matters: conduct and harassment investigations, policy violations, employee disputes. Needs read access to the specific conversations and participants under an investigation, under strict access control and accountability logging (the subject may need to be informed, per deployment policy). Does not touch platform internals. High-sensitivity access: purpose-scoped and audited. Primary surface: admin console (Conversations, scoped).

## System actors (not personas)

These are not people and not personas, but they are first-class ACTORS: identities that perform behaviors the specs describe. Use cases name them as the actor where they perform the action ("As the assistant, I ..."), not only human personas.

### The assistant
A configured AI participant, defined by a capability profile, that acts as its OWN identity (never a user's) and is bounded by its classification. Its behaviors have use cases: responding to a turn, greeting on the first turn, moderating its own or an assigned channel (ChannelModerator), competing in a battle, suggesting a split on drift, triggering an add-member escalation, and handing off to another assistant. It is an actor, not a user of the console. See [SPEC-ASSISTANT-CONFIG](../specs/interaction/assistants/SPEC-ASSISTANT-CONFIG.md).

### The admin assistant
A special assistant bound to NO classification, admin-plane only. It owns the admin notification channel and posts every admin alert, and it holds admin capabilities (deputy, never amplifier). Only admins may reach it. See [DESIGN-ADMIN-AGENT-NOTIFICATIONS](../specs/interaction/governance/DESIGN-ADMIN-AGENT-NOTIFICATIONS.md).

### The service app-instance-admin
A non-human automation identity for no-human paths (membership auto-revoke, roster sync). It never acts on behalf of a human and is never a channel member. See [SPEC-ADMIN-IDENTITY](../specs/interaction/governance/SPEC-ADMIN-IDENTITY.md).

## Classifications (not personas)

A **classification** is carried by the channel and the user - a boundary on data and models, not a role someone plays. It is the one closed axis IAM evaluates.

**A classification is a declared set of grants, not a ladder** ([ADR-046](../design/decisions/046-classifications-are-a-set-not-a-ladder.md)). There is no rank to compare. A classification reaches exactly what its `grants` declare, and a classification that declares none is unknown and reaches nothing rather than falling back to a floor. The three the repo ships happen to nest, which is a property of what they declare and not of the axis:

| Classification | Declares grants over |
|---|---|
| `basic` | `basic` |
| `standard` | `basic`, `standard` |
| `premium` | `basic`, `standard`, `premium` |

The nesting is the sample's configuration, not a property of classifications, and many deployments should not nest them. The shipped `customer` classification is the worked example: it grants only itself, so a person cleared for `basic`, `standard` or `premium` does not reach it, and an outside person signed in for it reaches none of those; synth refuses a member classification that grants it (`validateProfilesConfig`) and an issuer that names it beside the deployment's own (`lib/config/issuers.ts`). A deployment is free to declare classifications that do not nest - two peers that grant only themselves, for instance - and nothing in the platform will try to order them.

Any persona can be cleared for any classification; the classification bounds data and model access to what it declares, while the persona describes the job. Admin/operator authority is a separate identity/group concept (the `admins` group, the `${personId}-admin` plane), orthogonal to classification. See [SPEC-ADMIN-IDENTITY.md](../specs/interaction/governance/SPEC-ADMIN-IDENTITY.md).
