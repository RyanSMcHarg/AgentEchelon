# SPEC: Assistant configuration - what the assistant is, per experience

**Status:** Implemented. The per-classification config seams ship, and the unified `AssistantConfig` bundle rides the versioned profile definition ([`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md)). The versioned definition carries a per-profile **`models` bundle** (`default` plus optional `classifier` / `image` / `byIntent` overrides), a per-profile **`tools`** surface, a per-profile **`workflows`** selection, and a **`guardrailId`** selection - so **model selection is PROFILE-level, not a global strategy table**. The schema is additive and byte-identical (the seed sets `models.default` to the base model); resolution reads `models.byIntent` / `models.classifier` from the active profile version, seeding `byIntent` from the global `model-strategy` table. The three per-assistant config axes (context scope, workflow selection, guardrail selection) are collected in [`SPEC-CONFIGURABLE-ASSISTANTS.md`](./SPEC-CONFIGURABLE-ASSISTANTS.md).

**Coverage:** `tests/e2e/profile-config.spec.ts`, `tests/e2e/admin-profiles.spec.ts`

**Verified by:** `backend/test/lib/active-profile.test.ts` (a version's models/tools/workflows/guardrailId surface on the resolved profile, a version's `machines` block is dropped on read, and an invalid version fails closed to the seed), `backend/test/lib/profile-lifecycle.test.ts` (a version that tries to define a machine is refused at the write, and a workflow key naming no available workflow is refused), `backend/test/lib/guardrail-catalog.test.ts` (default vs strict guardrail policy), `backend/test/task-state-machines.test.ts` and `backend/test/lib/task-loop-machines.test.ts` (task-machine graph validation, and the loop honoring exactly the machine set its caller hands it), and `backend/test/cdk-synth.test.ts` (describe 'Layer 4 / §7 - IAM resource boundaries (deny-by-absence...)': the S3 context prefix boundary excludes every prefix its grants do not declare, the assistant role holds `GetItem` and `UpdateItem` on the channel-context store and never `PutItem`, `DeleteItem`, `Scan` or `Query`, and `bedrock:ApplyGuardrail` is scoped to provisioned guardrails).

**Related:** [SPEC-PORTABLE-PROFILES.md](./SPEC-PORTABLE-PROFILES.md) - the versioned artifact this bundle rides. [SPEC-CONFIGURABLE-ASSISTANTS.md](./SPEC-CONFIGURABLE-ASSISTANTS.md) - the three per-assistant config axes. [SPEC-CONFIGURABLE-INTENT-PACK.md](./SPEC-CONFIGURABLE-INTENT-PACK.md) - the taxonomy half of what an assistant is.

**Site section:** Interaction layer, assistants.

---

## Overview

**An assistant is a bundle of declared selections, and the bundle is a versioned artifact rather than a code path.** What an assistant *is* - its model for each kind of turn, its persona, the intents it recognizes, the tools it may call, the guardrail applied to its replies, the workflows it may open and the context it may read - is data a conversation type selects by name. A new experience gets the right assistant by naming it, not by forking the turn engine. The bundle has two entry points, one per half: the boundary is declared in `backend/lib/config/profiles.ts` and ships with a deploy, and the behavior is edited on a version in the admin console's Profiles tab with no deploy. [HOW-TO-ADD-OR-MANAGE-A-PROFILE.md](../../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) is the procedure for both.

**Model selection is per-profile, with per-classification defaults.** A portable, versioned assistant decides its own base model, its own classifier model and its own per-intent routes, each route carrying a primary and an optional fallback. What stays at the classification level is the *default*: the base model per classification and the deployment's default classifier model. A profile that wants a default records it explicitly as the sentinel `'default'` rather than leaving the field absent, because `'default'` is a visible choice to follow the classification-set model as it changes, whereas writing today's concrete key silently pins the profile to a snapshot. Resolution treats `'default'` exactly like unset, and the write-path allowlist check skips it because it names no catalog model.

**A selection is bounded by a boundary it cannot widen.** Every model a version names is checked against the classification's `bedrock:InvokeModel` allowlist at the write path and enforced by IAM at the call, so a profile version is a selection among grants and never a grant of its own. The same shape governs tools (a version may only name registered tools), guardrails (a version selects among deployment-provisioned guardrails) and context (the assistant's role reaches only what its classification's `grants` declare). A version carries selections; the deployment carries the boundary.

**The boundary fields deliberately do not ride the version.** `contextScope`, `classifierMode`, the Lambda timeout and the hourly rate limit are read from the compiled deployment config or from the function's own topology, because none of them is a change publishing a version could actually make. A version that carried them would offer an operator a live edit the platform could not honor.

**One tool sits outside the allowlist on purpose.** `record_reading` is how a queue reading is recorded (ADR-033) - the platform's own output contract rather than a capability a deployment grants or withholds - so it is offered on a turn that has queued items whether or not the profile lists it. Gating it would allow an assistant to be configured into a state where it can be asked to read a queue and has no way to answer, and the symptom would not read as a misconfiguration: the drain would fall to its derived floor on every turn and every queued message would come back unreadable. It is side-effect free, so it stays inside the read-only surface a triage turn is held to - it records a decision, it does not act on one.

This is the Assistant Configuration pillar of the interaction layer; [SPEC-INTERACTION-LAYER.md](../SPEC-INTERACTION-LAYER.md) is the map.

## Business Problem

A business wants distinct assistants for distinct experiences - a cheap fast generalist for a low-cost tier, a triage assistant that reaches live observability data under an incident-shaped guardrail, a sales assistant that knows the catalog - and it wants to shape each one by declaring what it is rather than by writing or forking code for every variant. The alternative on offer is a chatbot builder that hard-wires one assistant and one model, or a home-grown configuration layer the team builds, secures and maintains itself. Either way the team ends up unable to answer the operator's question: what model does this assistant use, what may it call, what may it read, and what does it cost. This spec gives the assistant definition a single home, so a new experience picks an assistant by name and an operator reads one place to see what that assistant is.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. Five of them meet an assistant's configuration, and they divide by what they are allowed to change: the AI developer edits a version, the admin / operator sets the boundary a version is bounded by, and nobody else changes either.

### AI developer

**How this relates to them:** this is their working surface. They answer for how an assistant behaves, so they edit the selections - model per intent, persona, taxonomy, tools, guardrail, workflow selection - and they need every edit to be a published version rather than a deploy.

| What they need | Requirement |
|---|---|
| Decide this assistant's own per-intent models, each with a fallback, without editing a shared table | FR1 |
| Record "follow the deployment default" as a visible choice that keeps tracking the default | FR2 |
| Narrow the tool surface for one assistant without touching another | FR4 |
| Edit the persona and the taxonomy with no deploy | FR8, FR9 |
| Select which of the global workflows this assistant may open, without being able to redefine one | FR7 |
| Have a bad selection refused at the write rather than discovered on a turn | FR3, FR6 |
| Slice quality by which configuration produced it | FR11 |

### Admin / operator

**How this relates to them:** they own the boundary and the bill. They do not tune an assistant's prose, but every model a version may name and every guardrail it may select is a deployment fact they set, and one place has to say what each assistant costs and reaches.

| What they need | Requirement |
|---|---|
| One surface naming the model catalog and the per-classification defaults a version falls back to | FR1, FR2, FR12 |
| A boundary a published version cannot widen, enforced where the call is made | FR3, FR10 |
| Guardrails provisioned once and selected by name, never pointed at an arbitrary resource | FR6 |
| Deployment-time settings that a version cannot claim to change | FR13 |

### Platform developer

**How this relates to them:** they answer for the seam rather than for any assistant, so what they need is that adding a capability is a registry entry plus an implementation and never a new orchestration path.

| What they need | Requirement |
|---|---|
| A single tool registry the write path and the turn both read | FR4 |
| A platform output contract that configuration cannot switch off | FR5 |
| One shared turn engine every assistant runs, whatever it selects | FR1, FR4, FR6 |

### Manager

**How this relates to them:** they answer for what an experience achieves, so what they need from configuration is that the assistant in a conversation is the one that experience declared, and that a change to it is attributable.

| What they need | Requirement |
|---|---|
| A conversation type that selects its assistant by name | FR12 |
| A change to an assistant that is attributable to a version | FR11 |

### End user

**How this relates to them:** they never see configuration, and the point is that the assistant in front of them fits the conversation they are in and cannot read past its boundary.

| What they need | Requirement |
|---|---|
| An assistant that fits this conversation rather than a single generic one | FR12 |
| An assurance that it reaches only the context its classification grants | FR10 |
| A reply that still arrives when the guardrail service is unavailable | FR6 |

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | Model selection is per-profile: a version carries its own base model, classifier model and per-intent routes, each route carrying a primary and an optional fallback | Differentiator | Yes | `active-profile` (unit, behavior) |
| FR2 | A profile records "follow the applicable default" as the explicit sentinel `'default'`, which resolves like unset and is never materialized into a concrete key | Differentiator | Yes | `active-profile` (unit, behavior) |
| FR3 | Every model a version names is bounded by the classification's `bedrock:InvokeModel` allowlist - refused at the write path and refused again by IAM at the call | Table stakes | Yes | `active-profile` (unit, behavior), `cdk-synth` (unit, behavior) |
| FR4 | A version's `tools` is the Converse tool surface for that assistant, drawn from one registry and validated at the write path | Differentiator | Yes | `tool-registry` (unit, behavior), `active-profile` (unit, behavior) |
| FR5 | The reading a queue drain records is a platform output contract rather than a capability, so it is offered whatever the profile's tool surface lists | Enabler | Yes | `the-reading-is-a-choice-not-a-sentence` (unit, behavior) |
| FR6 | A version selects among deployment-provisioned guardrails, an unresolvable selection is refused at activation, and a guardrail outage fails open rather than dropping a reply | Differentiator | Yes | `guardrail-catalog` (unit, behavior), `guardrail-selection` (unit, behavior), `guardrail-selection-validated-on-activate` (unit, behavior) |
| FR7 | A version SELECTS the global workflows it may open (`workflows`) and can never define a machine; a version carrying one is refused at the write, and a stored one normalizes away on read | Differentiator | Yes | `profile-lifecycle` (unit, behavior), `active-profile` (unit, behavior), `battle-turn` (unit, behavior) |
| FR8 | The persona is out of code and editable with no deploy: a written version stores a pointer and the body lives in object storage, hashing the same either way | Table stakes | Yes | `profile-bodies` (unit, behavior), `profile-bodies-roundtrip` (unit, behavior) |
| FR9 | The intent taxonomy rides the same version as the per-intent model map, so a route and the intent it is keyed by cannot be published out of step | Table stakes | Yes | `the-intent-pack-rides-the-version` (unit, behavior) |
| FR10 | An assistant's readable context is an IAM boundary rather than a prompt instruction: its role reaches only what its classification's `grants` declare, and an out-of-scope read is refused | Table stakes | Yes | `cdk-synth` (unit, behavior) |
| FR11 | The assembled configuration is fingerprinted, so quality can be sliced by which configuration produced a turn | Enabler | Yes | `config-identity` (unit, behavior) |
| FR12 | A conversation type selects its assistants by name (`defaultAgents`), and a new experience needs no orchestration change to use one | Table stakes | Partly - the selection field ships on the conversation type; no test asserts the end-to-end selection | none |
| FR13 | Deployment-time settings are absent from the versioned artifact, so no version can offer an edit publishing cannot make | Enabler | Yes | `versioned-profile-omits-deploy-time-fields` (unit, behavior) |
| FR14 | An experience-specific pre- and post-processing flow is a selection the bundle owns, layered over the shared routing flow rather than replacing it | Above bar - optional | No | none |
| FR15 | A conversation may hold several assistants with distinct identities and distinct visibility | Differentiator | No - specified elsewhere | none |

**Reading the "Validated by" column.** Each entry is one specific test, named by its filename without its extension. Backend unit tests live in `backend/test/`, with the shared-library ones under `backend/test/lib/`; end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists.

**Known limits on the delivered rows.** FR5's evidence covers the reading tool's schema and its single name; nothing asserts that the tool is appended outside the profile's allowlist filter, which is the property the requirement is about. FR14 depends on a primitive that is per-channel while the deployment provisions one shared flow, so it is a bundle field that does not exist rather than a field that is off.

**OPEN:** how a version's tool surface reconciles with the connectors a conversation type makes available. The tool surface should be a subset of what the type offers, and nothing today computes that intersection.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| Replacing the shared app-instance channel flow with a per-classification one | That flow is load-bearing routing infrastructure: it fans out `@all`, routes `/battle` and reads the immutable classification tag. Swapping it per classification breaks those routes | FR14 - slim the shared flow to routing and layer an additional flow on top |
| Versioning the context boundary | `contextScope` is an IAM grant established at deploy, so a published version changing it would claim an edit the platform cannot make | FR10, and [SPEC-CONVERSATION-SECURITY.md](../governance/SPEC-CONVERSATION-SECURITY.md) for the layered access model |
| Versioning the classifier mode, the Lambda timeout or the hourly rate limit | Each is read from the compiled deployment config or from the function's own topology, which a running function cannot change | FR13, and [HOW-TO-ADD-OR-MANAGE-A-PROFILE.md](../../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) for where each is read |
| Pointing a version at an arbitrary guardrail resource | A selection that can name any ARN is a grant, and a version is not allowed to grant | FR6 |
| Deciding which assistants share one conversation | A separate design question about identity and visibility, not a field on this bundle | [DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md](./DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md) |
| Defining what the assistant may do as a principal | Configuration defines behavior; the identity plane defines authority, and the two together describe the assistant | [SPEC-CREDENTIAL-EXCHANGE.md](../governance/SPEC-CREDENTIAL-EXCHANGE.md) - the bearer-pinned assistant identity |
| A model catalog editable from the console | The catalog is a deployment fact with IAM behind each entry; a console edit would have to mint a grant | FR3, and [MODEL_STRATEGY.md](../../../guides/developer/MODEL_STRATEGY.md) |

## User Experience Description and Mocks

**Configuration has no conversational surface; an AI developer meets it as the profile editor in the admin console and an operator meets it as the model catalog.** The journey is the same one either way: read what this assistant is, change one selection, publish, and have the change attributable.

1. **Open the assistant and read its selections.** The base model, the classifier model, the per-intent routes with their fallbacks, the tool surface, the guardrail selection, the persona, the taxonomy and the workflow selection, all on the version that is live.
2. **Change one thing.** A per-intent route, a narrowed tool list, a reworded persona, one added intent. A field left as `'default'` says out loud that this assistant follows the deployment default rather than a model chosen once and forgotten (FR2).
3. **Be refused early where the selection is not available.** A model the classification does not allow, a tool that is not registered, a guardrail that does not resolve, a workflow key naming no available workflow and a version that tries to define a machine are all refused at the write, with the reason named, rather than found on a turn (FR3, FR4, FR6, FR7).
4. **Publish, and get a new fingerprint.** The published version carries its own identity, so analytics separate turns served by this configuration from turns served by the one before it (FR11).
5. **Read the boundary separately.** The model catalog and the per-classification defaults are the operator's surface: what is available and what a version falls back to, as distinct from what any one assistant selected (FR1, FR12).

**OPEN:** this document carries no mocks. The candidate is the profile editor beside the model catalog, so the split between a selection and the boundary it sits inside is visible in one screen; the editor's own surface is specified in [SPEC-PORTABLE-PROFILES.md](./SPEC-PORTABLE-PROFILES.md).

## Related Documents

- [SPEC-PORTABLE-PROFILES.md](./SPEC-PORTABLE-PROFILES.md) - the versioned, portable artifact this bundle rides, and where each body is stored
- [SPEC-CONFIGURABLE-ASSISTANTS.md](./SPEC-CONFIGURABLE-ASSISTANTS.md) - the three per-assistant config axes: context scope, workflow selection, guardrail selection
- [SPEC-CONFIGURABLE-INTENT-PACK.md](./SPEC-CONFIGURABLE-INTENT-PACK.md) - the taxonomy half of what an assistant is
- [SPEC-CONTEXT-AWARE-MODEL-ROUTING.md](./SPEC-CONTEXT-AWARE-MODEL-ROUTING.md) - routing a turn on signals beyond intent and classification
- [SPEC-INTERACTION-LAYER.md](../SPEC-INTERACTION-LAYER.md) - the pillar map this spec is one pillar of
- [SPEC-CONVERSATION-TYPES.md](../conversation/SPEC-CONVERSATION-TYPES.md) - the experience that selects an assistant by name
- [SPEC-CREDENTIAL-EXCHANGE.md](../governance/SPEC-CREDENTIAL-EXCHANGE.md) - the assistant as a bearer-pinned identity
- [SPEC-TASK-STATE-TRANSITIONS.md](../conversation/SPEC-TASK-STATE-TRANSITIONS.md) - the global workflows a version's `workflows` selection narrows, and the contract those workflows are written against
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the personas above
- [TENETS.md](../../../overview/TENETS.md) - tenet D4, which the selection-inside-a-boundary shape follows from, and tenet P5, which the per-step control answers
- [MODEL_STRATEGY.md](../../../guides/developer/MODEL_STRATEGY.md) - the catalog and the per-classification defaults
- [HOW-TO-ADD-OR-MANAGE-A-PROFILE.md](../../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) - authoring a profile and where each deployment-time field is read

## Appendix A - The mechanism, section by section

The numbered heading below keeps its number because source files cite `SPEC-ASSISTANT-CONFIG §4` for the per-profile model bundle.

### 4. The assistant configuration bundle

An assistant configuration is what a conversation type's assistant selection resolves to. The versioned definition body carries these selections:

| Selection | What it decides | Bounded by |
|---|---|---|
| `models.default` | The base model for a turn that no route claims. Blank or `'default'` inherits the classification default | The classification's `bedrock:InvokeModel` allowlist |
| `models.classifier` | The model that classifies the turn's intent. Seeded as `'default'`, which follows the deployment classifier | The same allowlist |
| `models.byIntent` | Per-intent routes keyed by the intent itself ([ADR-064](../../../design/decisions/064-a-turn-takes-its-model-from-the-intent-and-the-step-it-runs.md)), each carrying the text model (`primary`, optional `fallback`) and per-step overrides (`steps`, keyed by a state of the intent's workflow, each `{ primary, fallback? }`). A turn bound to a task runs on the step's override where one is set and the classification selects it, on the task intent's route where the step delivers, and on the message's intent otherwise. A retired route key (`general_qa`, `workflow_actions`, `document_extraction`) is refused naming the intent key | The same allowlist; a step override names a state its workflow declares and a model of the kind the step produces (`stepRouteErrors`), and is dropped at read where the classification does not select it (`confineModelsToClassification`) |
| `models.byIntent[<intent>].image` | The route's image model (`primary`, optional different `fallback`), which a step that produces an image draws on (ADR-064 decision C). The seed writes the default image model here for every intent that needs an image. The retired `models.image`, and an image model named as a route's text `primary`, are refused naming this field | The image-model registry, and refused unless the assistant's classification selects that image model (`models.selected`, the same rule as every text model) |
| `persona` | The system prompt. A written version stores a pointer and the body lives in object storage | The persona length cap |
| `intentPack` | The taxonomy this assistant recognizes, and the behavior each intent carries | Route reachability and the tool surface, at the write path |
| `tools` | The Converse tool surface for this assistant | The tool registry |
| `guardrailId` | Which deployment-provisioned guardrail applies to the reply | The provisioned guardrails |
| `messages`, `eventWorkflows`, `displayName` | Which message template each of its person-facing lines is said from (ADR-062), and the event workflows that open a conversation and act on events, its welcome included (ADR-061); a version's `copy` and `welcome` are retired and refused on a draft (`retiredCopyErrors`, `retiredWelcomeErrors`) | The welcome and message template contracts |
| `workflows` | Which of the global workflows this assistant may open, by key. A version selects and never defines a task machine: a machine on a version is refused at the write and dropped on read. Event workflows are the exception, by decision (ADR-061 decision 1, as built): a version declares its own in `eventWorkflows`, because a welcome and its follow-up are the assistant's own behavior rather than a shared task lifecycle | Every key validated against the workflows the deployment has; the platform machines are exempt from the selection |
| `confirmBrief` | Per workflow key, when that workflow's confirmed step is put to the person: `always`, or `when-incomplete`, where a request that already carries the complete brief goes past the step in its own turn ([ADR-064](../../../design/decisions/064-a-turn-takes-its-model-from-the-intent-and-the-step-it-runs.md) decision G). It replaces the value the workflow declares on its `confirm` step for this version's turns. Absent, each workflow's declared value; `image_generation` declares `when-incomplete` | Each key a workflow the deployment runs with a step that declares `confirm`, each value one of the two, and `when-incomplete` only where that step declares its `brief` (`confirmBriefErrors`) |
| `contextSources` | Which published context sources this assistant draws on, by catalog key | The classification's published catalog, and at most `MAX_CONTEXT_SOURCES` (16) keys |
| `onboarding` | The intake this assistant runs once per person: a greeting and the fields it collects | The intake schema, validated at the write path |
| `boundary` | The one line stating what this assistant cannot reach, rendered in its introduction | Carried as a string; kept about reach rather than quality |

`models.default` and `models.classifier` resolve through the sentinel rule in the Overview: `'default'` is stored explicitly and resolves like unset, so the profile tracks the classification default rather than freezing today's key.

Every assistant runs the same self-hosted Converse tool loop: classify the turn's intent, resolve the model for that intent, run bounded tool calls, and apply the guardrail out of band on the final reply. The tool surface is the same schema the loop exposes, so adding a tool is a registry entry plus an implementation rather than an orchestration rewrite.

### How the bundle composes with the other pillars

- **Conversation Configuration** selects the assistant; the experience decides which assistant participates.
- **Identity and Access** decides what that assistant may do as a principal. It acts as its own assistant identity, never as a user, classification-gated like every actor and bearer-pinned. Configuration defines behavior; identity defines authority.
- **Connectors** supply the systems of record behind a tool. A version's tool surface should be a subset of what the conversation type makes available, which is the open question in the requirements table.
