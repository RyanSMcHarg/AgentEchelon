# SPEC: Per-profile ownership (`AgentEchelonAssistants-*`)

**Status:** Implemented.

**Coverage:** `tests/e2e/profile-ownership.spec.ts`, `tests/e2e/profile-config.spec.ts` - synth proves the shape CDK would emit; the e2e proves the shape actually deployed, which is a different claim. It asserts one handler per classification, each in its OWN CloudFormation stack (that separation is the blast radius), and that the structural cross-stack SSM parameters resolve - a renamed or never-written parameter leaves a handler silently running on a fallback. Per-deployment content parameters (intent pack, welcome, onboarding schema) are reported rather than asserted, since leaving them unset is a legitimate deployment choice. The runtime surface a profile exposes is covered by `tests/e2e/profile-config.spec.ts`.

**Verified by:** `backend/test/cdk-synth.test.ts` instantiates each classification's `AssistantsStack` separately from its registry topology, asserting the per-classification stack bodies and their wiring at synth time, and `backend/test/a-deployment-stands-up-only-what-it-declares.test.ts` asserts the app creates exactly one `Assistants-<classification>` stack per classification the registry declares. `tests/e2e/profile-ownership.spec.ts` then asserts the same topology against the deployed account, which synth cannot see: a deleted stack, a partial deploy, or a drifted SSM parameter all leave synth green.

**Related:** [`SPEC-CAPABILITY-PROFILES.md`](./SPEC-CAPABILITY-PROFILES.md) (the configuration this topology is generated from), [`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md) (the behavior that rides over this fixed boundary), [`SPEC-CONFIGURABLE-ASSISTANTS.md`](./SPEC-CONFIGURABLE-ASSISTANTS.md) (the per-assistant axes bounded by these grants), [`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](../../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md).

**Site section:** Interaction layer, assistants.

---

## Overview

**Each classification is an independently deployable, independently ownable unit, and the mechanism that makes that true is a deliberately thin cross-stack contract.** A team owns `AgentEchelonAssistants-standard` end to end - its model allowlist, guardrail catalog, processor, and every assistant the classification declares - and ships it with one guarded single-stack deploy of that stack (`cd backend && npm run deploy:stack -- <prefix>Assistants-standard`), without touching the other classifications or the shared platform and without read or write access to their resources. A single-account demo deployer still gets everything with one `cd backend && npm run deploy`.

**The unit is the classification, and the name of this document predates that.** A stack is per CLASSIFICATION and hosts every profile its classification declares: the primary's, and one per additional role ([`SPEC-CAPABILITY-PROFILES.md`](./SPEC-CAPABILITY-PROFILES.md) FR9). The sample's three classification stacks host its conversational profiles between them, and `ops-premium` shares the premium stack with `advisor`. "Per-profile" in the title and in the stack names therefore reads as "per classification", and a profile is owned by the stack of the classification it serves rather than by a stack of its own.

**The cross-stack interface is AWS Systems Manager Parameter Store only.** No CloudFormation exports, and no direct construct references between a classification stack and the platform, because either one couples the deploy order and takes the independent cadence away.

**The stacks are organized classification-as-data.** One shared body, `AssistantsStack`, reads the `topology` each classification declares in the profile registry (`backend/lib/config/profiles.ts`), and `bin/backend.ts` creates one `Assistants-<classification>` stack per classification that declares one, with the shared helpers in `agent-classification-common.ts`. So there are independently deployable stacks and independently owned configuration at once: a change to one classification touches only that classification's registry entry, not the shared body and not the platform. The divergence between classifications - model, sizing, guardrails, context routing, persona and pack parameters, image generation, streaming, battle - is data in the topology rather than three copies of a stack.

**There is no Bedrock Agent, and the classification stack owns a processor instead.** The live assistant path is the async processor's own Converse tool loop: shared-router intent classification, then a per-intent model, then a tool loop that calls the classification-scoped context retrieval under the processor's own IAM role, with an out-of-band guardrail applied to the output. No agent, alias, action-group Lambda or Bedrock Agent intent appears in a classification stack.

**The isolation boundary is the per-classification processor role's object-read scope.** It grants reads only on the `context/{classification}/` prefixes of the classification's own declared grant set, derived from the single resolver the IAM generator and the retrieval walk share ([`SPEC-CAPABILITY-PROFILES.md`](./SPEC-CAPABILITY-PROFILES.md)). A prefix outside that set is absent from the policy, so a read against it is denied by absence rather than by an explicit deny.

## Business Problem

An organization running several assistant offerings side by side wants each team to own and ship its own end to end - model, prompt, tools, guardrail, processor - without touching or gaining access to the others. A monolith cannot give them that: one team's change ships everyone's, a bad deploy takes every offering down at once, and every team holds credentials on resources it has no business reading. The alternative to a monolith is usually a set of hand-wired stacks that import each other's outputs, which reintroduces the coupling under a different name and puts the deploy order back in one person's head. What is wanted is separate ownership with a blast radius per team, a demo deployer who still gets everything in one command, and an isolation boundary that a deny test can prove rather than a diagram assert.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. Three of them care about this topology, and they care about different properties of it: the descriptor, the mechanism and the cadence.

### AI developer

**How this relates to them:** they own one classification's assistant, so its registry entry is theirs. Everything that distinguishes their assistant from a sibling is data in it, and they never edit the shared body.

| What they need | Requirement |
|---|---|
| A registry entry of their own, whose change touches nobody else's stack | FR1, FR3 |
| Their own content policy, rather than a platform-wide one | FR5 |
| Only their own models granted, so a cost or capability choice is theirs | FR6 |
| A behavioral change that does not need this stack deployed at all | FR11 |
| No access to a sibling classification's resources, and none granted to them | FR4 |

### Platform developer

**How this relates to them:** they own the shared body and the contract between it and the platform, so what they answer for is that the coupling stays thin and that the isolation boundary is one function a deny test can exercise.

| What they need | Requirement |
|---|---|
| One shared stack body, parametrized, rather than copies that drift | FR3 |
| A cross-stack contract with no CloudFormation export and no construct reference | FR2 |
| One object-read scope, derived from one resolver, asserted at synth | FR4 |
| Router dispatch that answers at the channel's classification, backed by an IAM check | FR7 |
| The deployed topology asserted against the account, because synth cannot see a deleted stack or a drifted parameter | FR10 |

### Admin / operator

**How this relates to them:** they carry the deploy, so what matters is that each stack moves on its own cadence, that a demo comes up in one command, and that a missing cross-stack parameter is loud rather than silently served from a fallback.

| What they need | Requirement |
|---|---|
| Independent deploy cadence per classification | FR2 |
| One command for a single-account demo | FR8 |
| A structural parameter that fails loudly when it is absent or renamed | FR10 |
| A second assistant in a classification without a new stack | FR9 |

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | Each classification deploys as its own CloudFormation stack, holding one handler and one processor shared by every assistant the classification declares, so the blast radius of a change is one classification | Differentiator | Yes | `cdk-synth` (unit, behavior), `profile-ownership` (e2e, behavior) |
| FR2 | The cross-stack interface is parameter store only: a classification stack publishes and consumes named parameters, with no CloudFormation export and no construct reference to the platform | Enabler | Yes | `cdk-synth` (unit, behavior), `profile-ownership` (e2e, behavior) - the structural parameters resolve against the deployed account |
| FR3 | One shared parametrized stack body serves every classification, and a classification is a registry entry supplying a topology rather than a copy of the body | Enabler | Yes | `cdk-synth` (unit, behavior) - each of the three classifications is instantiated separately; `a-deployment-stands-up-only-what-it-declares` - one stack per declared classification |
| FR4 | A classification's processor role grants object reads only on the context prefixes of its declared grant set, so a sibling's prefix is absent from the policy | Table stakes | Yes | `cdk-synth` (unit, behavior) - **deny-test by absence**; `classification-context` (e2e, behavior) - **deny-test** against deployed roles |
| FR5 | Each classification owns its own content policy: a guardrail catalog provisioned in its own stack and applied out of band to the output, with each of its profiles selecting an entry | Differentiator | Yes | `guardrail-catalog` (unit, behavior), `guardrail-selection` (unit, behavior) |
| FR6 | A classification's stack grants model invocation only on the models the classification allows | Table stakes | Yes | `cdk-synth` (unit, behavior) |
| FR7 | Router dispatch answers at the channel's classification, backed by the send check that refuses a sender without clearance for that channel | Table stakes | Yes | `assistant-classification-boundary` (e2e, behavior) - **deny-test**; `cdk-synth` (unit, behavior) for the send grant's condition |
| FR8 | A single-account demo deployer gets every stack in one command, with no per-classification sequencing to remember | Table stakes | Yes | none |
| FR9 | A classification's roles beyond its primary each get their own assistant identity inside the same stack, acting through the classification's one acting role with the role as a session tag, with an assignment naming which assistant is live | Differentiator | Yes | `an-assistant-acts-through-one-tagged-role` (unit, synthesized policy), `the-assignment-says-which-assistant-is-live` (unit, behavior), `an-ops-role-reaches-only-its-own-classification` (e2e, behavior) - **deny-test**, simulated against the deployed acting role |
| FR10 | The deployed topology is asserted against the account rather than only at synth, because a deleted stack, a partial deploy or a drifted parameter all leave synth green | Enabler | Yes | `profile-ownership` (e2e, behavior) |
| FR11 | An assistant's behavior changes without this stack being deployed: the model bundle, persona, intent pack, tool allowlist and guardrail selection resolve at runtime from the served profile version | Enabler | Yes | `active-profile` (unit, behavior), `portable-profile-lifecycle` (e2e, behavior) |

**Reading the "Validated by" column.** Each entry is one specific test, named by its filename without its extension. Backend unit tests live in `backend/test/`, with the shared-library ones under `backend/test/lib/`; end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists.

**Acceptance criteria.** Deploying one classification's stack alone succeeds and changes nothing in the others. A classification's processor role carries no read on a sibling classification's context prefix, proven against the deployed role. A renamed or absent structural parameter fails the deployed-topology assertion rather than leaving a handler on a fallback. A role declared beyond a classification's primary reaches only what its own role boundary names. `backend/scripts/validate-tier-context.ts` verifies the context isolation independently of the test suite.

**OPEN:** what asserts FR8. The one-command demo deploy is the documented path and no test exercises it.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| A Bedrock Agent, agent alias, action-group Lambda or agent role in a classification stack | The assistant is the async processor's own Converse tool loop, so an agent would be a second, unused implementation of the same thing | The Overview, and [`SPEC-ASSISTANT-CONFIG.md`](./SPEC-ASSISTANT-CONFIG.md) for what the assistant is |
| CloudFormation cross-stack references between a classification stack and the platform | They couple the deploy order, which is exactly the independent-cadence property this document exists for | FR2, and the appendix on the parameter contract |
| A separate identity pool or user pool per classification | One pool, with classification as a claim. Added authentication methods then reach every classification without touching a classification stack | [`SPEC-CAPABILITY-PROFILES.md`](./SPEC-CAPABILITY-PROFILES.md), and `IDENTITY-AND-ACCESS-MODEL.md` in the platform specs |
| A per-classification channel-flow processor | Channel flow is shared, and per-conversation-type flow is a different axis from per-classification ownership | The appendix on the ownership map |
| Runtime editing of the topology itself | The topology is the boundary, and a boundary is infrastructure. Behavior is the part that moves without a deploy | FR11, and [`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md) |
| A stack per profile | A stack is a boundary, and a profile is behavior inside one. Every assistant a classification declares shares its stack, its handler and its processor, and differs in identity, role and version | FR1, FR9, and [`SPEC-CAPABILITY-PROFILES.md`](./SPEC-CAPABILITY-PROFILES.md) |
| A classification stack owning cross-classification state | Tasks, experiments, battle state and analytics are cross-classification; classification is a partition or a claim there, not a stack boundary | The appendix on the ownership map |

## User Experience Description and Mocks

**This topology has no user-facing surface.** What an AI developer does is edit one registry entry and deploy their own classification's stack (`npm run deploy:stack`); what an operator does is run `cd backend && npm run deploy` on a fresh demo account. The practical steps for adding a classification or changing an existing one's model, prompt, guardrail, context scope, sizing or second assistant are in [`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](../../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md).

## Related Documents

- [`SPEC-CAPABILITY-PROFILES.md`](./SPEC-CAPABILITY-PROFILES.md) - the configuration this topology is generated from, the declared-grant classification model, and the roles a classification hosts in one stack
- [`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md) - the versioned behavior that rides over this fixed boundary
- [`SPEC-CONFIGURABLE-ASSISTANTS.md`](./SPEC-CONFIGURABLE-ASSISTANTS.md) - the per-assistant axes bounded by these grants
- [`SPEC-ASSISTANT-CONFIG.md`](./SPEC-ASSISTANT-CONFIG.md) - what the assistant is, per experience
- [`DESIGN-ADDING-AN-ASSISTANT-ROLE.md`](./DESIGN-ADDING-AN-ASSISTANT-ROLE.md) - declaring a role, its acting roles and its boundary
- [`SPEC-CONVERSATION-SECURITY.md`](../governance/SPEC-CONVERSATION-SECURITY.md) - the layered access model this boundary is one layer of
- [`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](../../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) - the practical steps
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the personas above

## Appendix A - The ownership map

### Shared, deployed once and consumed by every classification

| Stack | Stays shared because |
|---|---|
| `AgentEchelonMessaging` | One Amazon Chime SDK app instance per account; classification stacks add their assistants' identities to it |
| `AgentEchelonIdentity` | One user and identity pool; a classification is a claim, not a separate authentication backend |
| `AgentEchelonConversations` | One attachments bucket, whose `context/{classification}/` prefixes are the IAM boundary, and cross-classification state: the task tables, the per-user profile store, the private channel-context store, the abuse-controls and turn-state tables |
| `AgentEchelonChannelFlow` | One channel-flow processor, dispatching per classification from the immutable channel tag |
| `AgentEchelonNotifications`, `AgentEchelonArchive` | Cross-classification; classification is a partition or a claim there rather than a stack boundary |
| `AgentEchelonExperiments`, `AgentEchelonBattle` | Cross-classification comparison state: the experiment table, and the battle state, per-channel battle configuration, outcome table and orchestrator |
| `AgentEchelonPostProcessing`, `AgentEchelonAdminServices` | Cross-classification runtime and the admin plane |

The shared **router** logic is a single body of code holding the classification-reach and intent-to-delivery decisions, and it is deployed as one Lambda inside each classification stack rather than as one shared function, so the code is shared while the principal and the blast radius are the classification's own.

### Per classification (`AgentEchelonAssistants-<classification>`)

The stack is named `Assistants-<classification>`, one per classification; this document's title says "per-profile", and the stack name is the accurate one. Each of these hosts every assistant its classification declares, and there is one for each classification the deployment declares (`profiles`; `basic`, `standard` and `premium` when it declares none).

| What | Why it is per classification |
|---|---|
| The async processor, one instance of the shared handler per classification, running the Converse tool loop for every assistant the classification declares | The team's product surface: one runtime, resolving each turn's model, prompt and tools from the assistant the turn arrived on |
| The classification-scoped `context/{classification}/` object-read IAM | The isolation boundary |
| The guardrail catalog, applied out of band to the output | Each team owns its content policy; each profile selects an entry |
| The Amazon Lex bot resource, carrying `WelcomeIntent` and `FallbackIntent`, fulfilled by this stack's own handler, plus one per additional role | The ownership and blast-radius boundary; its ARN is published |
| The assistant identity, one per role the classification declares | The messaging-plane handle for this classification's assistants |
| Model invocation IAM, scoped to the models this classification allows | Each classification grants only its own models |
| The task service, and the name applier that puts a version's display name onto the identity | Per-classification and per-assistant respectively |

Absent from a classification stack: any Bedrock Agent, agent alias, agent role, agent parameter, action-group Lambda or Bedrock Agent intent.

## Appendix B - The parameter-store cross-stack contract

A classification stack **publishes**, with no CloudFormation exports. The classification-level infrastructure is keyed by classification, and what belongs to one assistant is keyed by the profile name.

| Parameter | Value |
|---|---|
| `/{instance}/assistant/{classification}/processor-arn` | the classification's async-processor Lambda |
| `/{instance}/assistant/{classification}/bot-arn` | the classification's assistant identity |
| `/{instance}/assistant/{classification}/router-arn` | the classification's handler, for the console's deep links |
| `/{instance}/assistant/{classification}/task-service-arn` | the classification's task service, read by the admin plane |
| `/{instance}/assistant/{classification}/guardrails` | the provisioned guardrail catalog with its selection keys |
| `/{instance}/assistant/{classification}/context-sources` | the provisioned context-source catalog with its keys |
| `/{instance}/assistant-directory/{profile}` | the assistant's directory entry: its identity and Amazon Lex bot, how it was asked for, and its state; the one name applier finds the identity here (ADR-048, amended 2026-10-23) |
| The acting role ARNs and assignments, per classification, role and occupancy | which assistant holds each role, and which is live |

A classification stack **consumes** resolved parameters or plain props from the composition root, never a CloudFormation import:

| Parameter | Source | Used for |
|---|---|---|
| The shared table ARNs | the platform | processor IAM and environment: tasks, experiments |
| The app instance ARN | the platform | the assistant identity and the messaging IAM |
| The attachments bucket | the platform | the context bucket and the classification's object grants |
| The battle-specific parameters | the platform | resolved separately, and only where the classification is battle-capable, because the battle stack is opt-in and a missing parameter would otherwise fail the deploy |

The consumers of the published contract are the shared router logic, which resolves a classification's processor to dispatch to, and the conversation-creation path, which resolves a classification's assistant identity to add the right one to a new channel.

## Appendix C - Code layout

```
backend/
├─ bin/backend.ts                        composition root; one AssistantsStack per registry topology
├─ lib/config/profiles.ts                the config: classifications (with topologies) + profiles + groupClearance
├─ lib/profile-registry.ts               the ONLY interpreter of a classification tag or clearance
└─ lib/stacks/
   ├─ agent-classification-common.ts     SHARED: the parameter-contract key builders
   │                                     (resolveSharedSSM, CAPABILITY_RESOURCES, battleResourcesOf, experimentsResourcesOf,
   │                                      modelArnsForClassification, botArnKey,
   │                                      processorArnKey, routerArnKey, taskServiceArnKey,
   │                                      nameApplierArnKey, classificationsAllowedFor,
   │                                      contextPrefixesAllowedFor,
   │                                      classificationChannelScopedAllow,
   │                                      assistantRolesFor, roleContextStatements,
   │                                      assistantActingRole). No class.
   └─ assistant-profile-stack.ts         class AssistantsStack - the SHARED body, one
                                         Assistants-<classification> stack per classification
                                         whose registry entry declares a topology.
```

One shared stack body, one topology per classification in the registry. A basic-team change touches exactly its own entry; the other classifications, the shared body and the platform are untouched. One shared async-processor handler serves every classification and every assistant in it, and gates its own capabilities on the environment each topology sets.

The per-classification authenticated roles are built in the authentication stack rather than here, from the same configured classification list, so the user-side and assistant-side boundaries are generated from one source.

## Appendix D - Invariants and risks

- **Context isolation is the per-classification processor role's object-read scope.** `backend/scripts/validate-tier-context.ts` verifies it outside the test suite.
- **No CloudFormation cross-stack references** between a classification stack and the platform, or the independent-cadence property is lost.
- **Router dispatch answers at the channel's classification**, which is a security invariant rather than a routing convenience, backed by the send check that refuses a sender without clearance for the channel.
- **Battle wiring is the trickiest coupling**, because it is the one set of parameters resolved conditionally, only where the classification declares itself battle-capable.
- **A classification's stack names it in its logical IDs.** The assistant identities are preserved across the consolidation onto one shared body, because new identity ARNs would orphan every existing channel membership.
