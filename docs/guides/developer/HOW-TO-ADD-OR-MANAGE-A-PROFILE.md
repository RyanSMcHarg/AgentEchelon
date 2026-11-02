# How to add or manage an assistant profile

A practical guide to what an assistant profile is made of, how its context and onboarding are configured, and how to add a new profile or change an existing one. The code is the authority for everything here; each field names the file that defines it and the code that reads it.

Contents:

1. [Overview](#1-overview): the three concepts, where a profile's settings live, and how a message reaches an assistant.
2. [What is in a profile](#2-what-is-in-a-profile-reference): every field, grouped, with its type, default, store, who changes it, and when a change takes effect.
3. [How context is managed](#3-how-context-is-managed): company documents, retrieval, context sources, the channel-context store, history, persona and welcome.
4. [How onboarding is customized](#4-how-onboarding-is-customized): the intake, `assertedBy`, when it fires, where answers go, and how to disable or test it.
5. [Adding a classification](#5-adding-a-classification): one stack, `Assistants-<classification>`, and nothing else; [adding a role](#5b-adding-a-role); and [removing a classification](#5c-removing-a-classification), with what stays.
6. [Managing an existing profile](#6-managing-an-existing-profile).
7. [Verifying](#7-verifying).

What happens to a message once it is routed (the channel flow, the router, the queue, the Converse tool loop) is [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md); this guide links to it rather than restating it. The governing specs are [SPEC-CAPABILITY-PROFILES](../../specs/interaction/assistants/SPEC-CAPABILITY-PROFILES.md) (classifications, profiles, clearance), [SPEC-PER-PROFILE-OWNERSHIP](../../specs/interaction/assistants/SPEC-PER-PROFILE-OWNERSHIP.md) (stack topology and the SSM contract), [SPEC-PORTABLE-PROFILES](../../specs/interaction/assistants/SPEC-PORTABLE-PROFILES.md) (versions, export and import), [SPEC-CONTEXT-SOURCES-AND-STORES](../../specs/interaction/assistants/SPEC-CONTEXT-SOURCES-AND-STORES.md), [SPEC-WELCOME-AND-CONTEXT](../../specs/interaction/assistants/SPEC-WELCOME-AND-CONTEXT.md) and [SPEC-USER-PROFILE-AND-ONBOARDING](../../specs/interaction/conversation/SPEC-USER-PROFILE-AND-ONBOARDING.md). Where a spec and this guide disagree, this guide describes the code.

---

## 1. Overview

### 1.1 Classification, profile, clearance

The customer-facing word "tier" is three separate config concepts in `backend/lib/config/profiles.ts`:

- a **classification** is the channel's immutable `classification` tag value plus the declared SET of classifications a holder of it may reach (`grants`). Classifications are a set, not a ladder: a deployment may declare `legal` and `finance`, neither reaching the other (ADR-046). The shipped `basic`, `standard` and `premium` nest only because the sample is configured that way; the shipped `customer` grants only itself, so no member classification reaches it;
- a **profile** is a named capability bundle (model, classifier mode, timeout, context scope, rate limit, attachment reading) that a classification names. Each profile is one assistant, and its name is never a classification value (`concierge` serves `basic` in the shipped config);
- **clearance** maps a Cognito group to the classification it clears for.

`ProfileRegistry` (`backend/lib/profile-registry.ts`) is the only interpreter of a classification value or a clearance group. Every runtime and synth site reads through `defaultProfileRegistry`, the registry of the set the deployment declares (1.5). At synth `backend/bin/backend.ts` resolves that set (`resolveDeploymentProfiles`, which validates it with `validateProfilesConfig`) and installs it (`useDeploymentProfiles`) before any stack is built; each classification's `Assistants-<classification>` stack publishes its row of that set to `<SSM root>/registry/classification/<classification>`, and `Identity` the admin plane's, and every Lambda the app builds is told that path and reads the rows at runtime (`loadProfileRegistry`, cached five minutes; `ProfileRegistryReaders` grants the read and denies every runtime principal a write). The publishing stack also writes each row's value to the registry bucket (`registry/classification/<classification>`), and a VPC-attached Lambda reads that S3 copy instead (`AE_PROFILE_REGISTRY_S3`), because the analytics VPC has no route to SSM. A handler loads the registry before it reads it, and a read before then throws. Where neither applies, a unit test or a script run by hand, the registry is the shipped catalog, `DEFAULT_PROFILES_CONFIG`.

### 1.2 Settings locations

A profile is not one object. Its settings sit in five places, and the split is the security model: behavior is data that can change at runtime, and the boundary is infrastructure that only a deploy changes.

| Layer | Where | Written by | A change takes effect |
|---|---|---|---|
| **Deployment profile config** | `profiles` in `backend/deploy.config.json` (1.5): a selection of the shipped catalog (`DEFAULT_PROFILES_CONFIG` in `backend/lib/config/profiles.ts`) or a custom set, published one row per classification by the stack that owns it and read by every Lambda at runtime | A deploy (a catalog field: a code change and deploy) | Within five minutes of the deploy of the stack that publishes the row |
| **Stack topology** | The classification's `topology` (`AssistantTopology`), in the catalog or the custom set | A deploy | After deploying that classification's `Assistants-*` stack |
| **Versioned definition** | SSM `${SSM_ROOT}/assistant/<profile>/definition`, one native SSM version per profile version, the served one carrying the `active` label; the draft in `${SSM_ROOT}/assistant/<profile>/draft`; the persona body in S3 at `profiles/<profile>/<configId>/persona` in the attachments bucket | The `manage-profiles` API (admin console Assistants tab, or import) | On the next turn after the warm-container cache expires (30 seconds; see 2.14) |
| **Per-deployment parameters** | SSM `${SSM_ROOT}/assistant/<classification>/assistant-system-prompt`, `assistant-intent-pack`, `onboarding-intake`, `welcome-orientation`; the intent pack's body in S3 at `classification-packs/<classification>/<sha256>/intentPack` in the attachments bucket, with a pointer in its parameter | CDK context at deploy (persona, intent pack), `backend/scripts/seed-demo.ts`, or a direct SSM write | Per container: the persona, intent pack and welcome are cached for the warm life, the onboarding intake for 30 seconds (2.12). Each is a FALLBACK: a version carrying its own persona, intent pack, onboarding or welcome takes precedence and converges in 30 seconds |
| **Published catalogs** | SSM `${SSM_ROOT}/assistant/<classification>/guardrails` and `.../context-sources` | The profile stack at deploy | Read by the write path (validate, activate, import) and, for context sources, by the processor per turn |
| **Assistant identity** | The assistant's `AppInstanceBot` and its own Amazon Lex bot, both tagged `provisioner = runtime`; its assignment record at `${SSM_ROOT}/assistant-assignments/<classification>/<role>/assistants/<profile>` (a duel's alt: `.../<role>/alt`); its directory entry at `${SSM_ROOT}/assistant-directory/<profile>` | The provisioner, never a stack: a deploy's seed builds each declared assistant once, and `manage-assistants` builds one created in the console (1.6) | A declared assistant is built on the deploy that first declares it; after that the console owns it (rename, owner, retire), and a later deploy does not rebuild or recreate it |

`SSM_ROOT` is `/${AE_INSTANCE_NAME}` (`agent-classification-common.ts`), which is `/agent-echelon` for the default instance. Two different names key these paths. The versioned definition, the draft and the persona body are keyed by the **profile name** (`concierge`, `analyst`, `advisor`, `ops-premium` and `admin-agent` in the shipped config). The per-deployment parameters, the published catalogs and the runtime identifiers are keyed by the **classification value** (`basic`, `standard`, `premium`). `validateProfilesConfig` refuses a profile named after a classification, so the two namespaces never collide.

### 1.3 Map of moving parts

```
backend/
├── bin/backend.ts                        ← composition root; instantiates each profile stack
├── lib/
│   ├── config/
│   │   ├── profiles.ts                   ← classifications + profiles + groupClearance (deployment config)
│   │   ├── model-strategy.ts             ← the Bedrock text catalog, INTENT_ROUTE_STRATEGY
│   │   ├── model-catalog.ts              ← image model keys, the external adapters, each key's kind
│   │   ├── guardrail-catalog.ts          ← the guardrails a deployment provisions and a profile may select
│   │   └── context-sources.ts            ← the context-source catalog loader (local file, else the example)
│   ├── profile-registry.ts               ← the ONLY interpreter of a classification tag / clearance
│   └── stacks/
│       ├── assistant-profile-stack.ts    ← AssistantsStack (the shared body), one Assistants-<classification> per topology
│       └── agent-classification-common.ts← shared SSM keys + thin helpers (no class)
└── lambda/src/
    ├── assistant-async-processor.ts      ← the ONE config-driven assistant (entry for every profile)
    ├── router-agent-handler.ts           ← the Lex fulfillment handler for every profile
    ├── manage-profiles.ts                ← the versioned-definition write path (API)
    └── lib/
        ├── active-profile.ts             ← definition schema + runtime resolution (resolveActiveProfile)
        ├── profile-lifecycle.ts          ← draft / validate / activate / rollback
        ├── profile-manifest.ts           ← export / import
        ├── profile-bodies.ts             ← persona bodies in S3
        ├── intent-pack.ts                ← per-deployment intent taxonomy
        ├── task-state-machines.ts        ← task lifecycle schema + defaults
        ├── tool-registry.ts              ← the tools a profile may allow
        ├── company-context.ts            ← classification-scoped S3 documents
        ├── context-sources-runtime.ts    ← catalog context sources, per turn
        ├── channel-context-client.ts     ← the channel-context store
        ├── onboarding-intake.ts          ← the onboarding intake engine
        └── welcome-orientation.ts        ← the welcome composer
```

**Ownership.** Whoever owns a classification owns its registry entry, `topology` included; a profile's team owns its versioned definition. The shared `assistant-profile-stack.ts` body, `assistant-async-processor.ts`, `async-processor-core.ts` and `agent-classification-common.ts` change rarely; changes to them affect every profile.

### 1.4 Channel entry

Three layers must all be in place before an assistant can take a turn. Getting one wrong produces silence rather than an error, which is why they are listed together.

| Layer | What it is | Why it exists |
|---|---|---|
| **1. Lex bot** | A Lex V2 bot with two intents, `WelcomeIntent` (fires when the assistant joins) and `FallbackIntent` (the catch-all that carries every real user turn), both with a **fulfillment code hook** pointing at that classification's handler Lambda | Amazon Lex is the **entry trigger and session**. AgentEchelon does not use Amazon Lex for NLU beyond "something was said"; request classification happens downstream in the handler. Amazon Lex provides the managed Amazon Chime SDK to Lambda bridge and the per-turn session. |
| **2. `AppInstanceBot` `InvokedBy`** | `StandardMessages: NONE` and `TargetedMessages: ALL` on every assistant identity. Every identity is built by the provisioner's one build path (`buildIdentity` in `backend/lambda/src/lib/assistant-provisioner.ts`), which passes no entry setting, so the builder's default, `NONE`, applies to all of them (`assistantBotConfiguration` in `assistant-identity.ts`) | The **routing policy**: which messages the Amazon Chime SDK forwards to Amazon Lex. Under `NONE`, Amazon Lex is reached only by a message whose `Target` names the assistant, and by the welcome; every untargeted turn is started by AgentEchelon's channel flow |
| **3. Channel membership** | The assistant is added to the channel (`CreateChannelMembership`) as the classification-matched assistant | An assistant only receives messages for channels it belongs to. **Order matters:** set `InvokedBy` *before* the assistant joins, or the Amazon Chime SDK may not route standard messages for that channel until the membership is re-created. |

**One primary per classification.** Each classification's primary assistant runs its own Lex bot, model, guardrail and `context/{classification}/` scope. Channel creation binds the classification-matched assistant (`create-conversation`), so which assistant is in a room is fixed to the room's `classification`. An additional role (5b) adds a second assistant inside the same classification.

**Use cases.** One substrate serves several use cases, and the channel flow decides between them:

| Use case | Who starts the turn | Effect |
|---|---|---|
| Private AI assistant (1:1) | the channel flow, which claims every message in a conversation with one assistant | The assistant answers every turn |
| Shared team room | the channel flow, on `@all`, `@<assistant>`, a command or a work-item reference | The assistant answers only when addressed; humans talk freely |
| A private word with the assistant (`.<assistant>`) | Amazon Lex, through `TargetedMessages: ALL` | Only the sender and the assistant can read the message, and the reply inherits that |

Nothing else changes between these: the handler, the async processor and every enforcement layer are identical.

**Entry invariant.** `StandardMessages: NONE` is an invariant in the code, not a per-profile choice. No configuration turns the Amazon Lex entry for untargeted messages on, and the two fields cannot both be `NONE`, because the Amazon Chime SDK refuses that combination (ADR-041). One consequence is worth knowing before it is diagnosed as a bug: because the flow is the only entry for an untargeted message, a flow failure still delivers the person's message and **starts no turn**, so an outage presents as an assistant that never answers rather than as an error. The ChannelFlow stack alarms on the flow processor's errors, throttles and occupancy (`ChannelFlowProcessorErrorsAlarm`, `ChannelFlowProcessorThrottlesAlarm` and `ChannelFlowProcessorOccupancyAlarm` in `backend/lib/stacks/channel-flow-stack.ts`). **OPEN:** no action is attached to those alarms; wiring a destination is the deployer's.

### 1.5 The set a deployment declares

A deployment runs the classifications and profiles it declares in `profiles` in `backend/deploy.config.json` (`resolveDeploymentProfiles` in `backend/lib/config/profiles.ts`). `deploy.mjs` forwards it as CDK context, a list as a comma list and an object as `json64:`. Three forms:

| Declared | The deployment runs |
|---|---|
| Nothing (absent or empty) | The shipped catalog minus its outside classifications: `basic`, `standard`, `premium` and the admin plane, each holding only its primary assistant. No `Assistants-guest` or `Assistants-customer` stack, and no role assistant |
| A list, e.g. `["basic", "standard", "premium", "guest", "customer"]` | Those shipped classifications, each with the profile that serves it and the clearance and membership groups naming it, and each role assistant the list names beside its classification: `["basic", "standard", "premium", "ops-premium"]` adds the premium ops assistant (section 5b, "Declare it in the deployment and deploy"). Grants narrow to the list, so `["standard"]` gives `standard` the grants `["standard"]`. A name the catalog does not ship, and a role assistant without its classification, are refused |
| An object with `classifications`, `profiles` and `groupClearance` (and optionally `membershipGroups`) | That custom set, replacing the catalog. Each classification with a `topology` declares the models it selects from the instance's catalog and its default (`models`, 2.2); the catalog names no classification, so a custom name needs nothing beyond its own entry |

The admin plane is the platform's and is in every set: the `admin` classification, granting itself alone (a chat identity holding it reaches admin conversations and no member conversation; reach across every conversation is admin access, [SPEC-ADMIN-IDENTITY](../../specs/interaction/governance/SPEC-ADMIN-IDENTITY.md) FR1), the `admin-agent` profile and the `admins` clearance group. A custom set declares no admin-plane classification and does not reuse those names. Every result is checked by `validateProfilesConfig`, and `deployedAssistantClassifications` refuses a conversational classification with no `topology`.

An outside classification (`guest`, `customer`) deploys only when declared, and synth refuses anything that names a classification the deployment does not declare (`backend/lib/config/declared-classifications.ts`, and `issuerErrors` for an issuer's own clearance):

- a guest issuer needs `guest` (its `guest-visitor` conversations) and `customer` (its path B claim opens a `customer-engagement` conversation);
- an invitation-link issuer needs every classification a served type's `linkClassifications` names;
- an issuer's classifications, fixed set, mapping or `oneChannel` names only declared classifications;
- a conversation type this deployment serves names only declared classifications and declared `defaultAgents`. A type naming none of the declared classifications (`ops` under a set without `premium`) is not served, and every creator refuses a classification the registry does not declare.

Shipped-catalog assumptions a custom set meets: the proactive briefing is held at the classification that declares `holdsBriefing` and is not built when none does, the conversation types are shipped (`general` serves every set), and an invitation-link issuer under a custom set is refused while `general`'s `linkClassifications` names `basic` and `standard`. `backend/test/a-deployment-declares-its-classifications.test.ts` and the deploy matrix configuration `C1-custom` hold this.

### 1.6 Declared assistants are seeded once

No stack owns an assistant identity ([ADR-048](../../design/decisions/048-an-assistant-is-not-a-classification.md), amended 2026-10-24). A declaration in `profiles` asks for an assistant; the provisioner builds it. ONE PRINCIPAL BUILDS AND RETIRES EVERY ASSISTANT: the provisioner (`backend/lambda/src/assistant-provisioner-function.ts`, in `Messaging`), on a session of `RuntimeAssistantProvisionerRole`, the only role that holds an identity or Amazon Lex write. Each `Assistants-<classification>` stack holds one custom resource, the seed (`Custom::DeclaredAssistants`, `DeclaredAssistantsSeed` in `backend/lib/constructs/declared-assistants-seed.ts`), whose property is the declaration: the classification's primary, each deployed role's assistant, and the alt of the primary role where the duel is wired. `AdminServices` holds the admin assistant's. The seed's handler (`backend/lambda/src/seed-declared-assistants.ts`) is a thin CloudFormation adapter: it invokes the provisioner (`op: 'seed-declared'`), naming the classification it serves. The console's create and retire ask the same provisioner (`op: 'build'`, `op: 'remove'`). A Lambda function cannot see who invoked it, so each request PROVES its caller: before invoking, the caller writes a claim carrying the digest of the exact request under `${SSM_ROOT}/provisioner-claims/seed/<classification>/` (writable by that classification's seed role alone, granted in its own stack) or `${SSM_ROOT}/provisioner-claims/console/` (`manage-assistants` alone), and the provisioner refuses a request whose claim is missing, stale or written for another request (`backend/lambda/src/lib/provisioner-claim.ts`). So the `standard` seed cannot ask in `premium`'s name. The seed's role holds the invoke, its own claim path and its own stack's status, and nothing else. The provisioner then holds a declaration to the registry: the classification must be one the registry declares and the one the claim proved, and every declared name the registry's own for its classification, role and occupancy (`backend/lambda/src/lib/declared-assistants.ts`).

| The declared assistant's directory entry | What the deploy does |
|---|---|
| None | Builds it: its Amazon Lex bot, its identity, its record and its entry (`origin: declared`) |
| `active` | Nothing. The console owns it: rename, owner, retire |
| `retired` or `retiring` | Nothing. It stays retired, and `npm run deploy` and `npm run deploy:stack` print "declared, but retired in the console; a deploy does not recreate it" |
| Created in the console, or placed at another classification or role | Fails the deploy, naming the conflict |
| `failed`, or a build that died | Removes what the build recorded and builds again |

The seed runs when the declaration changes. A ROLE AND THE ASSISTANTS FILLING IT ARE SEPARATE: a deploy that withdraws a role is refused while any assistant, declared or created in the console, still fills it (`active`, `provisioning` or `retiring`), and the refusal names them; retire them in the console first. Once none does, the withdrawal releases the role's declared assistant that a console retire left as a tombstone, so declaring the role again seeds a fresh one under the same name (its profile versions are kept). A deploy that no longer wires the duel removes the alt. A ROLLBACK IS NOT A WITHDRAWAL: when CloudFormation undoes an update that added a role, the seed reads its stack's status (`UPDATE_ROLLBACK_IN_PROGRESS`) and the provisioner removes the assistant that update built rather than refusing, so the rollback completes. The classification's removal (the seed's delete) removes every assistant it declared and NEVER FAILS the stack: what it cannot remove, and any assistant created in the console still active in the classification, is logged and reported, and the teardown sweep removes what the directory still records. The refusal lives before the deploy instead: `npm run deploy` and `npm run deploy:stack` refuse a configuration that no longer declares a classification an assistant created in the console is still active in, naming them. Nothing else a deploy does removes an assistant, and a console-created one is never removed by a seed. A full teardown removes the console-created assistants first, then the stacks, then every identity the directory still records (`scripts/teardown.mjs`). Unit-tested in `backend/test/a-deploy-seeds-its-declared-assistants-once.test.ts` and `backend/test/the-provisioner-builds-and-retires-every-assistant.test.ts`; the stack shape in `backend/test/no-stack-owns-an-assistant-identity.test.ts`, and the one principal across the whole app in `backend/test/one-principal-builds-every-assistant.test.ts`.

A deployment whose assistants were created by CloudFormation, before this, moves by a teardown and a fresh deploy; there is no in-place migration. The fresh deploy is also what moves every Amazon Lex bot onto the provisioner's one Amazon Lex runtime role: a bot built before it names a per-stack Lex role that its stack's update deleted, and the teardown removes those bots with everything else.

---

## 2. What is in a profile (reference)

Each group below is a table. "Store" is where the value lives, "Changed by" is who can change it, and "Takes effect" is when a change reaches a turn.

### 2.1 Deployment-level profile config (`ProfilesConfig`)

Defined in `backend/lib/config/profiles.ts`; the shipped catalog is `DEFAULT_PROFILES_CONFIG`, and a deployment runs the set it declares from it or in its place (1.5). A catalog field changes by editing that file and redeploying; the declared set changes by editing `profiles` in `deploy.config.json` and redeploying. The shipped defaults below are a deployment that declares nothing.

| Field | Type / allowed values | Shipped default | What it controls | Read by |
|---|---|---|---|---|
| `classifications` | `DeploymentClassification[]` (2.2) | `basic`, `standard`, `premium`, `admin` (admin plane), plus the outside classifications `guest` and `customer`, deployed only when declared | The declared classification values and what each one reaches. Declaration order is the only order, and it is used where a stable order is needed (generated policies, role names, group precedence) | `ProfileRegistry` |
| `profiles` | `AssistantProfile[]` (2.3) | `concierge` (serves `basic`), `analyst` (`standard`), `advisor` (`premium`), `ops-premium` (the `ops` role on `premium`), `admin-agent` (`admin`), `greeter` (`guest`), `liaison` (`customer`) | The compiled seed of every profile | `ProfileRegistry.profileFor`, `profileByName` |
| `groupClearance` | `Record<agentEchelonGroup, classificationValue>` | `{ basic: 'basic', standard: 'standard', premium: 'premium', admins: 'admin' }` | Which AgentEchelon group clears for which classification. On the deployment's own pool each key is a Cognito group; an issuer for another provider translates the provider's groups into these keys (`groups.map`, [IDENTITY-PROVIDER-GUIDE](../user/IDENTITY-PROVIDER-GUIDE.md#groups-from-your-provider)). Drives the pool's groups, the credential exchange's per-classification roles and the Layer-1 IAM boundary | `ProfileRegistry.clearanceForGroups`, `clearancesForGroups`, `resolveHolderToken`, `clearanceGroups` |
| `membershipGroups` | `Record<group, classificationValue>`, optional | `{ ops: 'premium' }` | A group whose members must ALREADY be cleared for the named classification. It grants nothing; it says who a conversation type adds. Never also a `groupClearance` key | `ProfileRegistry.membershipGroups`, `identity-stack.ts`, `user-management.ts`, `conversation-type-grants.ts` |

`validateProfilesConfig` rejects: no classifications or profiles, an `ownerTeam` that does not match `TEAM_NAME_PATTERN`, a duplicate classification value, a classification that declares no `grants`, one that does not grant itself, an unknown `produces` output, two classifications that grant the same set, a classification naming an unknown profile, a `grants` entry naming an undeclared classification, a profile name that is also a classification value, a `membershipGroups` entry naming an undeclared classification or doubling as a clearance group, a `groupClearance` target that is undeclared, and an alias that collides with a value or another alias.

### 2.2 Classification fields (`DeploymentClassification`)

| Field | Type | Default when absent | What it controls |
|---|---|---|---|
| `value` | string | required | The channel `classification` tag value and the `context/{value}/` S3 prefix |
| `profile` | profile name | required | The profile that serves channels at this classification |
| `aliases` | string[] | none | Legacy tag values that resolve to this classification (existing channels are never retagged) |
| `adminPlane` | boolean | `false` | Marks the admin plane. `ProfileRegistry.isConversational` refuses it, so **no conversation is created at an admin-plane classification** on any creation path; the admin notification channel, provisioned by its own stack, is the one admin-classified channel. It also keeps `failClosedContentValue` off the admin plane (3.1). Reach is unaffected: an administrator still reaches what its `grants` declare. |
| `grants` | string[] of declared values, **including itself** | required, no default | The set of classifications a principal holding this one may reach (`ProfileRegistry.grantsFor`, and `reaches(holder, target)` for a single question). A ladder-shaped deployment declares prefix-shaped sets, which makes the ladder a choice rather than an assumption. Used for IAM policy generation and the S3 context prefixes. Shipped: `basic` grants `basic`; `standard` grants `basic`, `standard`; `premium` grants `basic`, `standard`, `premium`; `admin` grants `admin` alone, and synth refuses a member classification that grants it |
| `roles` | string[] | `['primary']` | The jobs this classification instantiates; each role gets its own acting roles and share of the boundary (5b). Shipped: `premium` offers `['primary', 'ops']`, and a selection deploys `ops` only when it names `ops-premium` (`shippedProfilesSelection`). Read by `ProfileRegistry.rolesFor`; every declared role is deployed |
| `roleContext` | `Record<role, string[]>`, each a subset of `grants` | a role not listed reads every granted prefix | Which `context/{c}/` prefixes a role's assistant may read; narrows below the classification, never widens past it. Shipped: `{ ops: ['basic', 'standard'] }` on `premium`. Read by `ProfileRegistry.contextPrefixesForRole` |
| `battleCapable` | boolean | `false` | Whether the stack wires the `/battle` plumbing; turning battle on is a separate runtime setting. Shipped: `standard`, `premium`. Read by `ProfileRegistry.isBattleCapable` and the stack's `BATTLE_CAPABLE` env |
| `produces` | `Array<'document'>` | nothing | What a turn here can hand over; a capability refusal names the classifications whose `produces` serves the request. Shipped: `standard` and `premium` `['document']`. Images are not declared here: a classification produces images when its `models.selected` holds an image model, and synth refuses `'image'` in `produces`. Read by `ProfileRegistry.produces` |
| `displayName` | string | the value | The name a person sees in the New conversation picker and in a capability refusal. Shipped: `Basic`, `Standard`, `Premium` |
| `models` | `{ selected: string[], default: string }` | required on a classification with a `topology` | The models this classification may use, chosen from the instance's catalog (Bedrock text models, external adapters, image models), and the Bedrock text model its assistant answers on by default. Its stack grants exactly the selection, and a profile version uses only models in it. Synth refuses an empty selection, an unknown or repeated key, and a default that is not a selected Bedrock text model ([MODEL_STRATEGY](./MODEL_STRATEGY.md#three-layers)). Shipped: `basic`, `guest`, `customer` and `admin` select `haiku`; `standard` selects seven models with `sonnet` as its default; `premium` selects seven text models and every image model with `opus` as its default. Read by `ProfileRegistry.modelsOf`, `selectsModel` and `defaultModelOf` |

### 2.3 Profile seed fields (`AssistantProfile`)

These are the compiled seed. `modelKey` and `displayName` are also versioned fields; every other row here is deployment-time, and the "Runtime source and reader" column names what reads it.

| Field | Type / values | Shipped values (concierge / analyst / advisor / ops-premium / admin-agent) | What it controls | Runtime source and reader |
|---|---|---|---|---|
| `name` | string | `concierge` / `analyst` / `advisor` / `ops-premium` / `admin-agent` | The stable identifier: the `/assistant/{name}/` SSM segment of the definition and draft, the assignment record's `assistant`, and the analytics dimension. Never a classification value | Seed only; never taken from a version |
| `displayName` | string, optional | `Concierge` / `Analyst` / `Advisor` / `Ops` / `Admin Assistant` / `Assistant` (`greeter`, `liaison`) | The name a person sees, and the `Name` the stack gives the `AppInstanceBot` at deploy | A version's `displayName` wins, then this, then `name` (`ProfileRegistry.displayNameFor`) |
| `modelKey` | model-catalog key | `haiku` / `sonnet` / `opus` / `sonnet` / `haiku` | The base model when no version sets one | Active version `models.default`, then version `modelKey`, then this seed (`resolveFromDefinition`), used by `assistant-async-processor.ts` for `resolveModelForIntent` |
| `classifierMode` | `'keyword' \| 'llm'` | `llm` / `llm` / `llm` / `keyword` / `llm` | Whether the router classifies intent with the model-backed classifier or `classifyIntentByKeyword` | **Compiled seed**: `router-agent-handler.ts` reads `classifierMode` from the turn's assistant profile (`turnAssistantProfile`, `lib/turn-assistant.ts`): the profile of the assistant the turn is addressed to, so `ops-premium`'s turns are keyword-classified and `advisor`'s are not (2.15) |
| `timeoutSeconds` | positive number | 30 / 60 / 90 / 60 / 30 | Declared processor timeout | **Not read at runtime.** The Lambda timeout is the classification's `topology.timeoutSeconds` (2.4) |
| `contextScope` | `'granted'` (only value) | all | The retrieval and S3 scope rule: the serving classification's `grants`, nothing wider | Seed only (a boundary); `ProfileRegistry.contextPrefixesGranted` and the stack's S3 grant |
| `rateLimitPerHour` | non-negative number, optional | 60 / 120 / 240 / 120 / unset | Per-sender message limit | **Compiled seed**: `rateLimit` in `router-agent-handler.ts`, from the turn's assistant profile, so a turn to `ops-premium` is held to its 120 (2.15). The counter is the person's (`ratelimit#<personId>#<hour>`, where `<personId>` is the sender's AppInstanceUser id), shared across the assistants they talk to; the limit is the answering assistant's. `channel-flow-processor.ts` meters only the `/battle` fan-out, once per duel, at the limit of the live side, the room's primary assistant, read from that assistant's assignment record (`turnAssistantProfileForBot`) |
| `attachmentsReadable` | boolean, optional | `false` / `true` / `true` / unset / unset | Whether the processor may read an attached file; one source for the `ATTACHMENTS_BUCKET` env, the `s3:GetObject` grant on `attachments/*`, and whether the composer offers the attachment control | Compiled seed: `assistant-profile-stack.ts` and `channel-battle.ts` |
| `ownerTeam` | team name (`TEAM_NAME_PATTERN`), optional | unset / unset / unset / `ops` / unset | The team that owns the assistant when first provisioned: the ownership function copies it onto an `AppInstanceBot` that carries no `owner-team` tag yet, and the `manage-ownership` capability (`assistant-ownership.ts`) changes it afterwards. Absent leaves the assistant reachable by `admins` alone | Seed only, read at provisioning |

#### Live versus deploy

A new **version** changes, on the next turn after the 30-second cache: the base model (`models.default`), the classifier model (`models.classifier`), per-intent model routing (`models.byIntent`), the image model (`models.image`), the tool allowlist (`tools`), the guardrail selection (`guardrailId`), the persona (`persona`), the assistant copy (`copy`), the display name (`displayName`), the welcome (`welcome`), the boundary line (`boundary`), the workflow selection (`workflows`), the intent pack (`intentPack`), the onboarding intake (`onboarding`), the tested instruction an experiment carries (`systemPromptAddendum`) and the context selection (`contextSources`). These are the keys `RUNTIME_EDITABLE_KEYS` in `active-profile.ts` hashes into `configId`, and 2.6 to 2.10 describe them. Task machines are NOT in that list: they are global workflows (2.9).

A **deploy** changes `classifierMode`, `rateLimitPerHour` and `attachmentsReadable` (and a classification's `battleCapable`), by editing the profile in the catalog (`DEFAULT_PROFILES_CONFIG`, `backend/lib/config/profiles.ts`) or in the deployment's custom set (1.5) and deploying that classification's `Assistants-<classification>` stack, which publishes its row of the runtime registry (the classification, the profiles that serve it and its clearance groups); every handler reads the rows within five minutes. The processor timeout is the classification's `topology.timeoutSeconds` (2.4) and changes by deploying that classification's `Assistants-*` stack; a running Lambda cannot change its own timeout at all.

None of the deployment-time settings is part of the versioned definition, the Assistants-tab editor or an export manifest, so no surface offers a live control for a setting that publishing cannot move. The console shows each one where it applies with a "Needs a deploy" note and a link here: an assistant's classification, role and reach under Identity and ownership, and turns per hour and the other deployed settings under Limits. A stored version that carries one is tolerated: `bodyFrom` in `active-profile.ts` drops it on read, edit and export, and validation does not reject it, so such a version resolves normally rather than failing closed to the seed. `backend/test/versioned-profile-omits-deploy-time-fields.test.ts` holds both halves of that rule. A draft edit that names an assistant's `classification`, `role`, `roles`, `grants`, `reach` or `ownerTeam` is refused rather than dropped: the first five change IAM and are a deploy (5, 5b), and the owner is changed through `manage-ownership`.

### 2.4 Stack topology (`AssistantTopology`)

The `topology` field of a classification in the catalog (`DEFAULT_PROFILES_CONFIG`, `backend/lib/config/profiles.ts`) or in the deployment's custom set (1.5), typed `AssistantTopology`. `bin/backend.ts` creates one `Assistants-<classification>` stack for each classification that declares one, passing the classification by name, and `AssistantsStack` reads the rest from the registry. Changed by editing the entry and deploying that classification's stack. A conversational classification with no `topology` is refused at synth (`deployedAssistantClassifications`), and the admin plane may not declare one (`validateProfilesConfig`).

| Field | Type | basic / standard / premium | What it controls |
|---|---|---|---|
| `timeoutSeconds` | number | 30 / 60 / 90 | The async processor Lambda timeout |
| `memorySize` | number (MB) | 512 / 512 / 1024 | Processor memory |
| `reservedConcurrency` | number | 100 / 50 / 20 | Processor reserved concurrency |
| `maxTokens` | number | 1024 / 4096 / 4096 | `MAX_TOKENS`, the response limit |
| `streaming` | boolean | false / false / true | Grants `InvokeModelWithResponseStream` |
| `contextRouting` | boolean | false / true / false | Chinese-language routing env. The path is the one the classification selects: DeepSeek on Bedrock where it selects `deepseek_v3`, otherwise the external adapter `deepseek_api`; synth refuses a classification that selects neither, and refuses `deepseek_api` beside `deepseek_v3`, where no turn reaches it. Active at runtime only with `-c enableContextRouting` |
| `systemPromptParam` | boolean | false / true / false | Creates the per-deployment persona parameter and sets `ASSISTANT_SYSTEM_PROMPT_PARAM` on the processor |
| `intentPackParam` | boolean | true / true / true | Creates the per-deployment intent pack parameter and sets `ASSISTANT_INTENT_PACK_PARAM` on the handler and the task service |
| `richProcessor` | boolean | false / true / true | Experiments table (when `experiments` is declared), generated-document writes, and the battle-state grant when `battle` is declared |
| `handlerExperimentsIndex` | boolean | true / false / false | Grants the handler Query on the experiments GSI (when `experiments` is declared) |

The classification value is the stack's tag value and the SSM segment of its per-deployment parameters and runtime identifiers, and `Assistants-<classification>` is its stack name and CloudFormation `Component` tag. It is NOT the profile name: the processor's `PROFILE_NAME` comes from `defaultProfileRegistry.requireProfileFor(classification).name`.

Whether the stack wires `/battle` plumbing is not a topology field: it is the classification's `battleCapable` (2.2), read through `ProfileRegistry.isBattleCapable` together with whether the deployment declares `battle` (`props.battle`).

### 2.5 The versioned definition: envelope

Defined in `backend/lambda/src/lib/active-profile.ts` as `ProfileDefinition`, stored as JSON in `${SSM_ROOT}/assistant/<profile>/definition` (Standard tier, 4096-character value limit for the serialized definition after the persona and intent pack are offloaded to the body store).

| Field | Type | What it is |
|---|---|---|
| `schemaVersion` | `1` (`PROFILE_DEFINITION_SCHEMA_VERSION`) | A different value fails parsing, and resolution falls back to the seed |
| `profileName` | string | Must equal the SSM segment |
| `configId` | 12-hex hash | `profileDefinitionConfigId` over the runtime-editable body (`RUNTIME_EDITABLE_KEYS`); the per-turn analytics attribution key |
| `personaRef` | `{ key, configId }` | Present instead of `persona` when the persona lives in S3 (`profile-bodies.ts`); an envelope field, not hashed, so storage location does not change `configId` |
| `intentPackRef` | `{ key, configId }` | Present instead of `intentPack` when the pack lives in S3 (`profile-bodies.ts`); an envelope field on the same terms as `personaRef`, not hashed |

The body fields follow in 2.6 to 2.10. The seed body (`serializeSeedDefinition`) carries the seed's `modelKey`, `models: { default: <seed modelKey>, classifier: 'default', byIntent: <the platform routes narrowed to the intents the supplied pack declares>, image: 'stability_image_core' }`, `tools` set to every registered tool, and - when the caller supplies them - the persona, the intent pack (minus its `machines`, which a version does not read), the onboarding intake, the boundary line and the welcome. It carries none of the deployment-time settings in 2.3.

### 2.6 Models (`ProfileModels`)

| Field | Type | Default | What it controls | Read by |
|---|---|---|---|---|
| `modelKey` (top level) | model-catalog key, required | seed `modelKey` | Transitional copy of `models.default` | `resolveFromDefinition` when `models.default` is blank or `'default'` |
| `models.default` | model key or `'default'` | seed `modelKey` | Base model; `'default'` or blank inherits the classification's default (its `models.default`) | `resolveFromDefinition`, then `assistant-async-processor.ts` |
| `models.classifier` | model key or `'default'` | `'default'` | The intent-classifier model; `'default'` tracks the deployment classifier (`CLASSIFIER_MODEL_ID`, Haiku) | `router-agent-handler.ts`, when no classification experiment overrides it, read from the active version of the turn's assistant profile (2.15) |
| `models.byIntent` | `Record<routeKey, { primary, fallback? }>` | the routes of `INTENT_ROUTE_STRATEGY` whose models the classification selects, plus `image_generation` routed to `stability_image_core` with `stability_image_ultra` as its fallback where the classification selects them (premium as shipped; `defaultImageRoute`) | Per-intent model routing; a route whose `primary` is `'default'` is dropped. A route whose `primary` is an image model is an image route: that intent, whatever it is called, generates an image, and its `fallback` must be a different image model. An intent that needs an image takes only an image route. Text routes go to `buildIntentStrategy` and never carry an image model | Text routes: `buildIntentStrategy`, then `resolveModelForIntent`; image routes: `resolveTurnImageRoute` in the processor |
| `models.image` | `ImageGenModelKey` (`IMAGE_GEN_MODELS`) the classification selects | absent | Legacy. Read as the primary of the `image_generation` route when that intent has no route of its own (`imageRouteFor` in `image-route.ts`), with no fallback. Exports, imports and copies carry it as stored; the console shows it as the `image_generation` route and its next save writes the route | Processor (`resolveTurnImageRoute`) |
| `models.routing` | a list of `{ when, model }`, at most `MAX_ROUTING_RULES` (16), each model a text model of the catalog | absent: no rule | The version's routing rules (ADR-060 decision 6): after an experiment's override and before the built-in context rules, the first rule whose condition holds and whose model the classification selects serves the turn (`routedBy: 'version-rule'`). A condition is read as the room reads the reply, so no fact about a person routes a turn; it may decide on a `ctx:` field its classification publishes (see [Variables and conditions](#variables-and-conditions)) | Processor (`resolveModelPlan` with `rules`); `routingRuleErrors` on every patch, `versionConditionErrors` at validate, activate, a variant and import; a rule naming a model the classification does not select is dropped where the version is confined. Edited in the draft's models section |

**One rule for every model a version selects** ([MODEL_STRATEGY](./MODEL_STRATEGY.md#one-rule-for-every-model)): the base model, the classifier, each per-intent route and the image model must each be a model the assistant's classification selects (`models.selected`, text and image alike) and fit for its use: a text model for the base model, the classifier and a text route, and an image model for both models of an image route and for `models.image`; a route's fallback is the same kind as its primary (`validateBody` in `profile-lifecycle.ts`; import re-checks against the target and leaves out the routes the target cannot invoke). A body stored before the rule is served without the offending selection, with a logged reason, and a new version cloned from it leaves the selection out by name. The IAM model grant comes from the same selection (`modelArnsForClassification` for text, `imageModelArnsForClassification` for image), so a version can only select models the role already permits. A version stored with the retired `models.externalProviderAllowed` field is read as if it did not carry it, and every new version is written without it: a model outside AWS is the classification's to select. A conversation enrolled in an experiment is served its arm's version whole, routes included, instead of the active version: the control is the live active version pinned when the experiment was armed, the treatment a candidate in the alt's history (see [A/B testing and battles](../admin/GUIDE-AB-TESTING-AND-BATTLES.md#when-a-change-takes-effect)).

### 2.7 Persona, tools, guardrail, context sources

| Field | Type / limits | Default | What it controls | Read by |
|---|---|---|---|---|
| `persona` | string, at most `MAX_PERSONA_LENGTH` (20000) characters | absent: the deployment persona seam (3.5) | The system-prompt body | `assistant-async-processor.ts` (`activeProfile.persona`); stored in S3 via `personaRef` when a body bucket is configured (`PROFILE_BODY_BUCKET`, else `CONTEXT_BUCKET`) |
| `tools` | tool names from `TOOL_REGISTRY` in `tool-registry.ts` | all registered tools | The Converse tool allowlist, intersected with what the runtime has available | Processor (`invokeConfig.tools`) |
| `guardrailId` | a guardrail catalog key (`default`, `strict`) or an id the deployment provisions | absent: `GUARDRAIL_ID` env, the stack's default guardrail | Which provisioned guardrail applies to input and output | Processor (`applyInputGuardrail`, `applyOutputGuardrail`); validate and activate check it against `${SSM_ROOT}/assistant/<classification>/guardrails` |
| `contextSources` | catalog keys, at most `MAX_CONTEXT_SOURCES` (16), no repeats | absent: no catalog sources | Which context sources the turn resolves, in prompt order (3.3) | Processor; validate, activate and import check each key against `${SSM_ROOT}/assistant/<classification>/context-sources` |
| `displayName` | non-empty string | absent: the seed `displayName`, then the profile name | The assistant's name in the room and the console. Activating or rolling back a version also applies it to the `AppInstanceBot` (`apply-assistant-name.ts`) | `ProfileRegistry.displayNameFor` |
| `eventWorkflows` | event workflows by name (`event-workflow.ts`), at most 8, 16 steps each | absent: the platform's only | What the assistant does when it joins a conversation (its welcome, on `assistant-joined`), when an event opens one, when a person is added, and on the other events (3.6) | Router and processor (`workflowFor`); validated at draft, activation and import |
| `messages` | a shipped message's name to one template name of the assistant's own family, `@classification` or `@shipped`, or an ordered list of `{ template, when }` whose last alternative alone carries no `when` (`VersionMessages`, `message-template.ts`) | absent: each message is said from the assistant's template of its own name, else the classification's, else the shipped one | Which template a message is said from (ADR-062 decision 3), and, with conditions, the first alternative whose condition holds, else the last (see [Which template a message is said from](#which-template-a-message-is-said-from)) | `chooseMessageName` and `messageFamilies` where a message is said; validate and activate check each named template is active in the family and fits its message (`messageTemplateErrors`), and each condition against who reads the message (`messageAudience`) and the classification's catalog (`versionConditionErrors`). Picked per message on the draft's What it says card (the Message templates editor), under Used in this version |
| `variables` | a variable's name (a lowercase letter, then letters, digits or underscores) to `{ source, fallback? }`, at most `MAX_VERSION_VARIABLES` (32) (`variables.ts`, [ADR-060](../../design/decisions/060-a-variable-is-declared-once-and-its-trust-decides-what-it-may-do.md)) | absent: the version names no variables | The values this assistant names, `{ "firstName": { "source": "person:displayName", "fallback": "there" } }`: each reads one source its classification publishes (`person:`, `conversation:`, `host:`, `ctx:<source>.<field>`, `fact:<key>`, `pref:<key>`, `signal:`, `event:`; `signal:userLanguage` and `person:preferredLanguage` are each one of the languages the deployment declares), and the fallback is inserted when the value is unresolved or held back, absent meaning the line is left out. The source's trust is its own, so a member-trust variable is inserted and never decides. A message template field, the opening text, a workflow send and a condition read a variable by its name (see [Variables and conditions](#variables-and-conditions)) | Named as JSON with a draft patch (`npm run assistant -- draft <assistant> --patch <file.json>`); the console lists each in its variable picker beside the sources its classification publishes. Hashed into `configId`. The shape is checked on the patch; validate, activate, a variant and import check each source against the classification's context-source catalog (with its trust), its declared classifications (`person:clearance` is a set of them) and, for `fact:<key>`, the fields the version's own `onboarding` and `${SSM_ROOT}/assistant/<classification>/onboarding-intake` declare, and each fallback against the source's type (`versionVariableErrors`). An export carries source names, never a resource; import checks them in the target classification |
| `goldenSet` | `{ minRegressionPerIntent }`, a whole number from 1 to 100 (`goldenSetErrors`) | absent: no minimum | The fewest live regression entries the golden set must hold for each intent of a draft's pack before the draft is activated (see [The golden set a draft is measured on](#the-golden-set-a-draft-is-measured-on)) | The gate at Activate, read from the **active** version (`readGoldenGate` in `manage-profiles.ts`). Named as JSON with a draft patch. Hashed into `configId` |
| `welcome` | Retired: the welcome is the version's `assistant-joined` workflow in `eventWorkflows` (3.6). A version stored before that may carry a `welcome` object; nothing reads it, and a draft, validate, activate, an experiment's variant, an import and a rollback refuse it, naming `npm run migrate-legacy-welcome` | absent | Nothing | Refused (`retiredWelcomeErrors`); `npm run migrate-legacy-welcome` carries it into the welcome workflows |
| `boundary` | string | absent: no boundary line | One authored line saying what this assistant does NOT reach, used where the assistant describes itself | `assistant-capabilities.ts`, `assistant-advertisement.ts` |

#### Variables and conditions

A version's variables, conditions and template fields read the sources its classification publishes ([ADR-060](../../design/decisions/060-a-variable-is-declared-once-and-its-trust-decides-what-it-may-do.md)). Each source has a type and a trust, and the trust decides what it may do: platform, operator and closed-list values may decide and be inserted; member text (what a person or an outside system wrote) is inserted, stripped and capped, and never decides. A fact about one person reaches only a message addressed to that person, and a room message names a member only through a mention.

| Where a condition is written | Read with | Checked against the catalog |
|---|---|---|
| An event workflow step's `when` and an edge's `{ to, when }` alternatives (`eventWorkflows`) | what the router holds at the event: `conversation:classification`, `conversation:type`, `event:person`, and the subject's onboarded flag and clearance where one subject is settled | the router reads no catalog, so a `ctx:`, `pref:` or `fact:` condition does not hold there; the console does not offer one |
| A `messages` entry's alternatives | what the turn or the router holds where the message is said | at validate, activate, a variant and import (`versionConditionErrors`) |
| A routing rule (`models.routing`) | the turn's values, as the room reads the reply | at validate, activate, a variant and import |
| A task machine's `when` and `edgeWhen` (the classification's pack, 2.8) | the turn's values, addressed to the person whose turn it is | at the classification's synth (`machineCatalogConditionErrors`); a machine is not edited in the console |

**In the console.** One variable picker lists the version's variables, then every source the classification publishes (served on the classification catalog with the profile listing), each with its type, its trust and whether it may decide. A condition builder adds variables through it, offers only the operators each type takes, and shows the server's own refusals under the condition. The picker does not offer member text for a condition, nor a fact about a person where the room reads what the condition selects. The template editor binds a template field to a variable and inserts `{{field}}`; the opening text inserts a version's variable by its name.

#### Which template a message is said from

A version's `messages` says which template a shipped message is said from: one of the assistant's own by name, `@classification` (the classification's template of the message's name, else the shipped one), `@shipped`, or alternatives `[{ "template": "turn-failed-ops", "when": { "conversation:type": "ops" } }, { "template": "turn-failed-own" }]` whose last carries no condition. The first alternative whose condition holds is said, else the last; a failed read holds no condition. A condition is held to who reads the message: a notice declares its audience, and any other message is read as the room reads it, so a fact about one person cannot choose it. The templates are saved, and the choice is made, on the draft's What it says card (Assistants → New version → What it says → Edit): the template a message uses is picked under Used in this version and saved with the draft. With no entry, the assistant's own template of the message's name is said, else the classification's, else the shipped one (2.10).

#### A message in the reader's language

A message template may carry its text in more than one language: the template's own `language` is its unmarked sections, and each other language is the same sections marked `@<tag>`, every one of them ([ADR-062](../../design/decisions/062-a-message-is-a-template-stored-and-versioned-like-a-document.md) decision 4). A variant may choose its own plural forms (`# chat.few@pl`), selected by `Intl.PluralRules` in that language.

```markdown
---
{ "kind": "message", "name": "workflow-subject-welcome", "description": "...", "language": "en", "fields": { "name": "person:displayName" } }
---
# chat
Welcome[[, {{name}}]]. Ask me anything when you are ready.
# chat@es
Bienvenido[[, {{name}}]]. Pregúntame lo que quieras cuando quieras.
```

Which language is said is decided from records, never from what anyone wrote: for a message one person reads, that person's preferred language (`person:preferredLanguage`, set in the chat app's Account settings), then the conversation's (`signal:userLanguage`, on the server-only channel-context row), then the deployment's, then the template's own; for a message the room reads, the conversation's first. The first language in that order the template is written in is said. Every candidate is one of the languages the deployment declares (`languages` in `deploy.config.json`, `backend/lib/config/languages.ts`, its own language first, English then Simplified Chinese when it declares none), so a tag outside that list is skipped and never reaches a prompt.

A targeted workflow send whose call site may wait on a model (`workflow-subject-welcome`, `ops-lead-welcome`) may be `"fill": "voice"`, with optional bounds `"voice": { "maxChars": 600, "deadlineMs": 8000 }` (at most 1500 and 15000). Where no variant is written for the reader's language, one model call says its sections in this assistant's persona and that language, with the fields as data and no conversation; a failed, blocked, late, overlong or embellished render (a figure, a link or a handle the text does not carry) posts the written text instead, and each call is metered as machine-written. A written variant is always said as written. Every other message is said instantly, so saving it as `voice` is refused, and an event workflow refuses a `voice` template as its opening or as an agent step's fallback. The console's template editor shows one tab per declared language with the preview in it, adds a variant to write, and offers the voice and its bounds where the message allows it.

Registered tools: `load_company_context`, `load_platform_info`, `read_deployment_health` (the `ops` role's CloudWatch metric and alarm read, 5b), `search_corporate_travel` (active only with `ENABLE_TRAVEL_TOOL=true`), `add_item`, `update_item`, `remove_item`, `reorder_items`, `assign_item`, `open_work_summary`, `advance_task_state`, `deliver_document`. The guardrail catalog is `guardrailCatalog` in `backend/lib/config/guardrail-catalog.ts`; entry 0 is the default, and `strict` is a working example that adds one blocked term.

### 2.8 Intent pack and task state machines

The **intent pack** rides the versioned definition as `intentPack`, and a version that carries none inherits the per-deployment parameter. A version stores `StoredIntentPack` (`extends` plus `StoredIntentDef` entries, each a key and only the fields it declares); `IntentPack` is the RESOLVED shape readers get. Both in `backend/lambda/src/lib/intent-pack.ts`:

| Field | Type | What it controls |
|---|---|---|
| `intents[].key` | string | The classified intent value, the `models.byIntent` route key, and the task type whose machine this intent opens |
| `intents[].description` | string | The line the **classifier** sees. The answering model never reads it |
| `intents[].keywords` | lowercase substrings | The keyword classifier's matches |
| `intents[].delivery` | `'DIRECT' \| 'PLACEHOLDER_UPDATE' \| 'TASK_MULTI_STEP'` | How a turn of this intent is delivered (`selectDeliveryOption` in `delivery-options.ts`; an in-flight task continues as `TASK_MULTI_STEP`) |
| `intents[].instructions` | string, at most `MAX_INTENT_INSTRUCTIONS` (4000), optional | How to ANSWER a turn of this intent. Appended to the system prompt as a `## HOW TO ANSWER THIS REQUEST` block, after the persona |
| `intents[].tools` | tool names, optional | The tool subset a turn of this intent may use. **Intersected with the profile's `tools`, never widening it** |
| `intents[].maxTokens` | number, optional | Per-intent response budget, clamped to the classification boundary (`clampResponseMaxTokens`) |
| `intents[].verbosity` | `'tight' \| 'normal' \| 'long'`, optional | Per-intent response shaping |
| `extends` | `'default'`, optional | Inherit the platform taxonomy for every key this pack does not declare. Omitted, the pack REPLACES it |
| `machines` | `Record<taskType, TaskStateMachine>`, optional | **Per-deployment only, and a version may not declare them at all.** Task graphs are GLOBAL WORKFLOWS: the platform set (`DEFAULT_TASK_STATE_MACHINES`) with a classification's pack able to merge over it. A version's own `machines` is refused on write and dropped on read (2.9) |

The seven universal intents (`greeting`, `acknowledgment`, `general`, `conversation_summary`, `set_preference`, `show_preferences`, `off_topic`) are always present. `conversation_summary` (summarize, recap or catch up on the conversation the person is in) is a platform capability every assistant has, answered from the conversation itself; it is never a report and never refused. `off_topic` (a request unrelated to everything the pack offers and not ordinary conversation) is never refused either: the turn is told to decline in one sentence and name what the assistant helps with. A question about AgentEchelon itself is the platform intent `platform_question`, which a pack declares with its own `instructions` and `tools` to offer it and omits to refuse it. Absent or invalid, the pack is `DEFAULT_INTENT_PACK`.

**Pack storage.** With a body store configured (`PROFILE_BODY_BUCKET`, else `CONTEXT_BUCKET`) the pack goes to S3 as a second body alongside the persona, and the definition carries an `intentPackRef` pointer, so its size is not charged against the 4096-character parameter. Without one it stays inline and that budget binds, which is the same legible degradation the persona has. Either way the pack is validated inline first, so the write path that reconciles `models.byIntent` against its keys holds both halves.

A version stores the pack **as authored**, keeping `extends` rather than resolving it, so a pack declares only what it adds. `resolveFromDefinition` resolves it once at read time, so every consumer downstream takes a pack it can use directly.

**Declare, do not inherit.** A profile declares what it recognizes; it does not inherit the platform set. `extends: 'default'` exists and is supported, but the shipped demo deliberately does **not** use it. Inheriting gives every classification every platform intent, including ones it has no business recognizing: a basic assistant answering an external conversation would classify "write me a report on account health" as `report_generation` and attempt it. Declining well is not the same as not offering. So each pack REPLACES, listing the intents that assistant actually does, and `fromPlatform(key, overrides)` in `backend/demo/intent-packs.ts` copies a platform intent in by value so the platform wording stays the source of truth.

This is also what makes the platform intents genuinely editable: they are IN the profile, by value, rather than inherited from elsewhere.

**Partial overrides.** Under `extends`, a declared platform key is a PARTIAL OVERRIDE: the fields you declare win and the rest are inherited. That matters most for `delivery`: restating `report_generation` without it silently drops a tracked multi-step report to a one-shot reply.

**Per assistant.** The unit is the ASSISTANT, not the classification. A pack rides a profile, and a profile is one named assistant (`/assistant/{name}/definition`). The table below lists the three primary assistants of the shipped sample, one per classification, so it reads as a per-classification gradient; that is a property of this configuration, not of the model (`ops-premium` carries its own pack on `premium`). The direction is several assistants in a conversation, each owned by the team that owns its subject, each declaring its own intents - see [`DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md`](../../specs/interaction/assistants/DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md). Do not read the rows as levels: what an assistant recognizes follows from what it is for and what its `grants` let it reach, never from a rank (ADR-046).

**Undeclared intents.** The difference below is a taxonomy difference, not a wording one. A platform intent a pack does not declare is refused, not answered as something else ([DESIGN-CAPABILITY-REFUSAL](../../specs/interaction/assistants/DESIGN-CAPABILITY-REFUSAL.md)): the model classifier is given every platform intent the pack omits, and a request classified as one gets a refusal that says where the person could get it. So the basic assistant recognizes a report request and refuses it.

**Keyword mode never refuses.** Refused intents are offered to the model only; the keyword classifier is a substring match, and a refusal decided by a matched word would fire on "report the status of X". A `classifierMode: 'keyword'` profile, and the keyword fallback when the model call fails, answer such a request as they would without refusal.

| Assistant (classification) | Recognizes | Deliberately does not |
|---|---|---|
| `concierge` (basic) | `product_info`, `guided_troubleshooting` | `report_generation`, `data_extraction`, `image_generation` - basic hands over no files (`richProcessor: false`, and the catalog allows it no image model), so each is refused |
| `analyst` (standard) | the above plus `directory_lookup`, `process_lookup`, `data_extraction`, `report_generation`, `image_generation` | `financial_metric`, `account_status`, `competitive_intel`. Its pack declares `image_generation`, but the catalog allows standard no image model, so the router refuses an image request here and points to premium |
| `advisor` (premium) | the above plus `financial_metric`, `account_status`, `competitive_intel`, `strategic_analysis`, and `account_brief`, which opens the account brief workflow | - |

**First layer only.** The taxonomy is the first layer, not the only one. A classification's context scope and its `bedrock:InvokeModel` allowlist are enforced by IAM regardless of what its pack declares, so an intent it should not have is a legibility and behavior problem rather than an access one (tenet D3: two enforcement layers, and one missed check is not a breach).

The per-deployment parameter remains the fallback. The handler reads `${SSM_ROOT}/assistant/<classification>/assistant-intent-pack` through `ASSISTANT_INTENT_PACK_PARAM` once per container (`hydrateIntentPackFromSsm`), so a change there reaches a turn after a cold start, while a change on a version converges within the 30-second profile cache (6.3).

The parameter holds a pointer, `{ "ref": { "key", "configId" } }`, and the pack itself is a body at `classification-packs/<classification>/<sha256>/intentPack` in the attachments bucket (`classificationPackKey` in `backend/lambda/src/lib/profile-bodies.ts`). The pack's size is therefore not the parameter's value limit; it is bounded by `MAX_INTENT_PACK_BYTES`, the same bound a version's pack has. The key names the classification, so IAM gives that classification's router, task service and processor read on its own prefix and no other classification's, and only that classification's deploy-time writer may put a body there. The key is the body's hash and nothing overwrites or deletes it, so a changed pack is a new object and an earlier pointer still resolves. A reader also accepts a parameter that holds the pack inline, which is what a parameter written before the body store, or by hand, contains; a pointer whose key is outside the reader's classification or whose body does not hash to its id is refused, and the reader serves the platform default and logs it.

#### Intent behavior

An intent is a behavior bundle, not just a label. Four things key off `intents[].key`, and all four accept a key a deployment invents:

| To give an intent | Set | Where it takes effect |
|---|---|---|
| Its own answering instructions | `intents[].instructions` | `assistant-async-processor.ts`, appended to the system prompt for a turn of that intent |
| Its own model | `models.byIntent['<key>']` on the version | `resolveModelForIntent`; a key no strategy declares falls to the profile's base model |
| Its own tool subset | `intents[].tools` | `toolsForIntent`, intersected with the profile's `tools` |
| Its own tracked workflow | a machine keyed `'<key>'` in the platform set or in the CLASSIFICATION's pack `machines`, plus `delivery: 'TASK_MULTI_STEP'` on the intent | The router opens a task of that type; no machine for the key means the turn answers as an ordinary reply. An assistant cannot declare one for itself - see 2.9 |

Two rules govern the whole table, and both are refusals at the write path rather than surprises at runtime:

- **Reachable routes.** A route must be reachable. `models.byIntent` is keyed by the intent it serves (ADR-064 decision 1), so route `guided_troubleshooting` to change the model troubleshooting answers on. The retired keys `general_qa`, `workflow_actions` and `document_extraction` are refused, naming the intent key to write instead. An intent in `ANSWERS_THROUGH_GENERAL` with no route of its own answers through `general`. A route no declared intent resolves to is **refused** on publish, activate and import, because it could only ever be config that never fires.
- **Narrow only.** An intent narrows, never widens: `intents[].tools` must be a subset of the profile's `tools`; naming a tool the profile forbids is refused rather than granted.

An intent routed to an image model generates an image instead of a text reply: `image_generation` as shipped, and any intent a pack adds (a `diagram` or `logo` intent routed to an image model). The route's model decides, not the intent's name (`resolveTurnImageRoute` in `async-processor-core.ts`). The worker tries the route's fallback once when the primary fails on the model side (unavailable, not accessible, a service error, a timeout, or throttling past its retries); a guardrail or content-policy refusal and an input-validation error are final (`isImageGenFallbackEligible` in `image-gen-models.ts`). The turn records the model that produced the image.

`image_generation` runs a workflow (`gather`, `confirm`, `generate`, then `done`, which a change request reopens into `revise`). A request that already carries the complete brief (the subject, the style and the composition) is drawn in the turn that asks for it, with no question and no confirmation; any other request is gathered and confirmed before a billable image is drawn, and so is a request that asks to see the brief first. Which applies is the `confirm` declaration below and a version's `confirmBrief` ([ADR-064](../../design/decisions/064-a-turn-takes-its-model-from-the-intent-and-the-step-it-runs.md) decision G).

#### Per-assistant onboarding

`onboarding` rides the version alongside the pack (`IntakeConfig` in `lib/onboarding-intake.ts`: `greeting`, ordered `fields`, optional `completion`, `offer` and `bail`; section 4.2). Absent, the per-deployment `ONBOARDING_INTAKE` / `ONBOARDING_INTAKE_PARAM` seam answers.

It belongs on the profile because an assistant's opening should follow from what that assistant can DO; a single deployment-wide intake makes every assistant introduce itself identically and then behave differently. The shipped demo (`backend/demo/onboarding.ts`) authors one per primary assistant, and `seed-demo.ts` seeds the `concierge` and `analyst` intakes only. `PREMIUM_ONBOARDING` is authored and not seeded, so `advisor` opens with its welcome and no onboarding question:

| Assistant (classification) | Opening says | Asks |
|---|---|---|
| `concierge` (basic) | answers from public documentation; no account or financial access | which product, optional |
| `analyst` (standard) | directory and internal processes; financial and account questions out of reach | which team (asserted by `profile`) |
| `advisor` (premium), **not seeded** | financial metrics, named accounts and competitive intelligence as well as the internal set | how the person likes answers (the `answerStyle` reply preference) |

**Ask last.** Every field declares `assertedBy` (`persona`, `classification`, `profile`), and `intakeAfterChecking` drops each field something already answers, so an intake asks only what the turn genuinely cannot resolve. In the shipped demo the persona names the company and the classification is the role claim, so most fields never fire. An intake must not sit in front of a question somebody is waiting on. Both call sites resolve the intake identically (`intakeForAssistant`, passed the turn's assistant profile) - the welcome that starts one and the later turn that reads an answer against it - because if they disagreed the person would be stranded mid-intake. The intake is the addressed assistant's: a conversation with `ops-premium` is asked the questions on `ops-premium`'s version, and the per-deployment `ONBOARDING_INTAKE` / `ONBOARDING_INTAKE_PARAM` seam applies only to the classification's primary, so a second assistant whose version carries no `onboarding` asks nothing.

**Context per profile.** Context sources are per PROFILE, not per intent: `contextSources` (2.7) selects which sources every turn of this assistant resolves, in prompt order, and an intent cannot narrow or reorder that list. To see what a deployment publishes for a profile, read `${SSM_ROOT}/assistant/<classification>/context-sources`; the catalog, the contract each source declares, the 1500 ms resolution deadline and the `## AVAILABLE CONTEXT` block they render into are all in [3.3](#33-context-sources-the-catalog). An intent whose answer depends on a source the profile does not select will not get it, however its `instructions` are worded, so check that list before writing instructions that assume data.

**Task machine shape.** Task machines are global workflows (2.9): the platform set plus a classification pack's `machines`, merged by `taskStateMachines()`. A version cannot carry them. A `TaskStateMachine` is `{ initial, states }`, and each `TaskStateDef` in `task-state-machines.ts` declares:

| Field | What it declares |
|---|---|
| `transitions` | Legal next states; empty means terminal |
| `terminal` | `'success' \| 'failure' \| 'handoff'`, required exactly when `transitions` is empty |
| `reopens` | Terminal states only: the non-terminal states a finished task returns to when its requester asks for changes. `report_generation.completed` declares `['revising']` |
| `prompt` | The step's instructions, rendered under the `## CURRENT TASK` header before the legal next states. The only source of step instructions for every machine, the shipped ones included, so a pack machine that redeclares a shipped task type has its own prompts rendered |
| `placeholder` | Placeholder text for the state |
| `label` | The state's name in the status chip; falls back to the shipped table, then the reshaped state name |
| `awaits` | `{ party: 'requester' }`: who the state is blocked on; moves ownership to that person. `awaitsUser: true` is the deprecated equivalent |
| `resolvedByOneResponse` | One clear answer completes the step (a confirmation, an approval, a single choice) |
| `requires` | What the step needs from the person, in their vocabulary. Binding: `advance_task_state` refuses to leave the step (`requirement_unsourced`) unless every need is recorded in `collected` with its `source` (`message`, with a short quote of the person's words, or `context`, with the retrieved passage or source id) and `evidence`. There is no `assumed` source |
| `requiresTool` | Tools that must return success before the task leaves the state: `advance_task_state` out of it is refused with `required_tool_not_run` until each ran since the task entered the state. Each must be a registered tool the state's `tools` offers, and a state with an `action` declares none. A version whose `tools` omit a required tool of a workflow it selects is refused (ADR-064 decision 3). The demo's premium `account_brief` workflow is the worked example (below) |
| `produces` | What the state hands over: `text` (the default), `image` (the platform draws it on entry through the `generate_image` action, on the image model of the intent's route), or `document`, a file:  the document the turn declares in `advance_task_state`'s `document` argument (or `deliver_document` for a rewrite in the state), never the reply. `image` and `document` are not allowed on a state that `awaits` somebody. The retired `delivers: true` is refused naming `produces` (ADR-064) |
| `presented` | The step is put to the person before the task may leave it: `advance_task_state` refuses to leave it on the turn it was entered, including the turn that created the task (`opening_step_must_be_presented`), so the person's reply is what moves it on. Only on a state that `awaits` somebody. Omit it to leave the step to the model's judgement. The shipped document and troubleshooting workflows declare it on their opening requirements step, and on `drafting_outline` and `data_extraction.validating` |
| `confirm` | Presented states only: when the step is put to the person (ADR-064 decision G). `always`, or `when-incomplete`, where a request that already carries the complete `brief` goes past the step in its own turn, along an edge the machine declares from the state before it straight to one of its targets (`image_generation`: `gather -> generate`, past `confirm`). That edge is taken only from a step the task entered on this turn and only where every need of `brief` is recorded with its source; otherwise `advance_task_state` refuses it (`brief_not_in_request`, `brief_incomplete`, naming the missing needs). Under `always` the edge is not a legal move. Absent, a direct edge past the step is an ordinary edge. A version overrides it per workflow with `confirmBrief` |
| `brief` | With `confirm`: the needs a complete brief carries, in the person's vocabulary like `requires`. Required where `confirm` is `when-incomplete`. The shipped `image_generation.confirm` declares `['the subject', 'the style', 'the composition']` |
| `template` | Delivering states only: the document template the declared document follows, by name or pinned as `name@<sha256>`. See [Document templates](#document-templates) |
| `templates` | Delivering states only, instead of `template`: a choice of templates. The person chooses on the workflow's requirements step (its initial state, which then declares `requires`) |
| `defaultTemplate` | With `templates`: the one used when nobody chose, stated to the person as a requirement being taken |
| `tools` | The tools this step's turn may use, by registered name. A narrowing, never a grant: the turn is offered the intersection of the profile's allowlist, the intent's `tools` and this list, and a call to any other tool while the task is in the step is refused (`tool_not_in_step`). `advance_task_state` and `deliver_document` stay available whatever it says. `[]` leaves only those. Validation refuses a name the tool registry does not hold |
| `action` | What the platform runs when the task ENTERS the step, with no model call: `{ "tool": <name>, "args": { <param>: <binding> } }`. `tool` is a registered tool that executes in the turn (`load_company_context`, `load_platform_info`, `read_deployment_health`, `search_corporate_travel`, `open_work_summary`), or `deliver_document` on a delivering step, which declares the step's platform-filled template as the document. Each argument is a binding: `requirement:<need>` (a sourced requirement), `detail:<key>` (a task detail), `tool:<state>.<path>` (an earlier action's recorded result) or `literal:<text>`, or a number or boolean taken as written. It runs under the assistant's own session, only where the profile's and the intent's allowlists permit the tool, once per entry into the step. The result is recorded at `details.actions[<state>]`. A model move into the step is refused (`action_unbound_arg`) while an argument has nothing recorded. Not allowed on a step that `awaits` somebody |
| `onSuccess` | With `action`: the state the runtime moves the task to when the action succeeds. Must be one of `transitions` |
| `onFailure` | With `action`: the state the runtime moves the task to when the action fails, or is refused at run time (a tool the turn does not allow, an argument with nothing recorded). Must be one of `transitions`. Absent, the step's transition into a terminal `failure` state is taken, and validation refuses a step with neither |

**Requiring a lookup.** Where the model chooses a tool's arguments (which document, which account), a step requires the tool instead of running it as an `action`. The demo's premium pack declares `account_brief` (`ACCOUNT_BRIEF_WORKFLOW` in `backend/demo/intent-packs.ts`), a TASK_MULTI_STEP intent and the workflow of the same name: `researching` offers and requires `load_company_context`, so the brief cannot reach `drafting` on figures the person typed until the account record was read in this entry of the step. An early advance is refused with `required_tool_not_run` and recorded on the turn's `steps[]` as a `workflow_refusal`, never as a tool error, and the run is recorded on the task's `actionRuns` as `tool:load_company_context:researching#<entry>`. The seed writes the pack to premium's `assistant-intent-pack` parameter only where none is set; on a deployment that already has one, write the pack there to add the workflow.

```json
{
  "machines": {
    "account_brief": {
      "initial": "researching",
      "states": {
        "researching": { "transitions": ["drafting"], "tools": ["load_company_context"], "requiresTool": ["load_company_context"] },
        "drafting": { "transitions": ["completed"] },
        "completed": { "transitions": [], "terminal": "success" }
      }
    }
  }
}
```

**A deterministic workflow.** The owner's three levels of control: an assistant answers on model judgment; a workflow adds fixed steps; a workflow whose steps declare `action`, ending in a platform-filled template, makes the outcome deterministic. In the workflow below the model's only move is the requirements step: it puts the trip to the person and records the three needs with their sources. Entering `searching` runs the travel search with those needs as arguments; its outcome takes `quoting` or `failed`. Entering `quoting` declares the `travel-quote` template, filled from the needs and the search's recorded result, as the document; its outcome closes the task. The runtime moves are logged as `by: "system"` with the action that caused them, and a turn takes at most four of them (`MAX_RUNTIME_MOVES_PER_TURN`), so two action steps pointing at each other cannot loop.

```json
{
  "machines": {
    "travel_quote": {
      "initial": "collecting",
      "states": {
        "collecting": {
          "transitions": ["searching"],
          "awaits": { "party": "requester" },
          "requires": ["origin", "destination", "departure date"],
          "presented": true,
          "tools": [],
          "prompt": "Ask for the origin, the destination and the departure date. State what you are taking for each, then record them when the person confirms."
        },
        "searching": {
          "transitions": ["quoting", "failed"],
          "action": {
            "tool": "search_corporate_travel",
            "args": {
              "origin": "requirement:origin",
              "destination": "requirement:destination",
              "departDate": "requirement:departure date",
              "cabin": "literal:economy"
            }
          },
          "onSuccess": "quoting",
          "onFailure": "failed",
          "label": "Searching"
        },
        "quoting": {
          "transitions": ["completed", "failed"],
          "delivers": true,
          "template": "travel-quote",
          "action": { "tool": "deliver_document" },
          "onSuccess": "completed",
          "onFailure": "failed",
          "label": "Preparing your quote"
        },
        "completed": { "transitions": [], "terminal": "success" },
        "failed": { "transitions": [], "terminal": "failure" }
      }
    }
  }
}
```

The `travel-quote` template it delivers binds its fields to the same record, `tool:` fields included (see [Document templates](#document-templates)):

```markdown
---
{"name": "travel-quote", "description": "A policy-checked travel quote, filled from the search the workflow ran.", "fill": "platform",
 "fields": {"origin": "requirement:origin", "destination": "requirement:destination", "date": "requirement:departure date",
            "flight": "tool:searching.options.0.summary", "price": "tool:searching.options.0.priceUsd",
            "policy": "tool:searching.policyNote", "portal": "tool:searching.portalUrl"}}
---
# Travel quote

## Trip

| From | To | Departing |
|---|---|---|
| {{origin}} | {{destination}} | {{date}} |

## Best option

{{flight}}, {{price}} USD.

## Policy

{{policy}}

Book in the travel portal: {{portal}}
```

What the task records once it ran: `details.actions.searching` is `{ "tool": "search_corporate_travel", "ok": true, "key": "searching#1", "at": "<ISO>", "result": { ... } }` (a result over 8000 characters as JSON is recorded as `"resultTruncated": true` and binds nothing), and `stateHistory` carries `{ "from": "searching", "to": "quoting", "by": "system", "reason": "search_corporate_travel succeeded", "action": { "tool": "search_corporate_travel", "outcome": "success" } }`. A failed run records `ok: false` with a bounded `errorClass` and no result, and its `tool:` fields refuse the delivery, so the failure edge is taken instead of a document with gaps. Each action is a `platform-action:<tool>` step on the turn's analytics record, under `action` rather than `tools`, so it never counts as a model tool call or a model tool error.

The workflow is a fixture in the unit tests (`backend/test/lib/deterministic-workflow.fixture.ts`) and is not shipped in the demo pack. The search tool runs only where the deployment sets `ENABLE_TRAVEL_TOOL=true`; elsewhere the action is refused at run time (`action_tool_not_allowed`) and the task takes `failed`.


Shipped machines (`DEFAULT_TASK_STATE_MACHINES`): `queue_drain`, `image_generation`, `guided_troubleshooting`, `incident_first_look`, `data_extraction`, `report_generation`, `code_delivery`, `technical_design`, `place_item`, `queued_combination`, `queued_clarification`, `work_still_wanted`, `approval`, `acknowledgement`, `queued_request`, `action_item`. `validateTaskStateMachines` checks every machine on the write path and at resolution. The authoring contract (what a state must declare, how `produces: 'document'` decides attachment against inline, and the defaults nothing prompts for) is [SPEC-TASK-STATE-TRANSITIONS](../../specs/interaction/conversation/SPEC-TASK-STATE-TRANSITIONS.md) sections 9 to 11. The one to know before writing a state: omit `awaits` on a state that waits for an answer and the machine still validates, while the person's next message is treated as a new topic on the cheapest model, because topic-drift detection, intent classification and model selection all read it.

### 2.9 Global workflows

Everything else in section 2 is per assistant. Task graphs are not, because they decide whether an assistant can manage work at all, which has to mean the same thing whichever assistant is asked.

**Task graphs.** A global workflow is a task graph: it declares what states a piece of work has, which moves between them are legal, which step awaits a person and when the work is over.

Workflows are DEFINED in two layers and SELECTED in a third, and keeping those two verbs apart is the whole design:

| | where | who edits it |
|---|---|---|
| **Defined - platform** | `DEFAULT_TASK_STATE_MACHINES` (`task-state-machines.ts`) | the platform |
| **Defined - classification** | a `machines` block on that classification's intent pack, merged over the platform set by `taskStateMachines()` | whoever owns the classification |
| **Selected - assistant** | `workflows` on a profile version: a list of KEYS, narrowing the available set | the assistant's own team, through `manage-profiles` |

A classification can declare its own workflow, and an assistant in that classification can be configured to use it or not. An absent `workflows` means every available workflow. A key naming no available workflow is refused on write (`workflowSelectionErrors`) rather than silently never firing.

**Confirming a brief.** A version also says, per workflow, when that workflow's confirmed step is put to the person: `confirmBrief`, a map of workflow key to `always` or `when-incomplete`, set with `npm run assistant -- draft <assistant> --patch <file.json>` and shown read-only on the assistant's Workflows section with that command. It replaces what the workflow declares on its `confirm` step for this version's turns only (`withConfirmBrief`). `image_generation` ships `when-incomplete`: "a watercolor of a red fox in snow at dusk, square, no text" is drawn in the turn that asks for it, and "an image for our newsletter" is gathered and confirmed first, as is a request whose brief is completed over later turns. A deployment that wants every image confirmed sets `{ "confirmBrief": { "image_generation": "always" } }`. A key naming no workflow with a confirmed step, an unknown value, and `when-incomplete` on a step that declares no `brief` are refused on write (`confirmBriefErrors`).

**Every door gated.** The selection gates both doors into a task: the ordinary intent path and a `/battle` duel side, which consults the same selection (ADR-047). A duel side that may not open a workflow answers with a generated reply instead - it is still a duel, and it still serves its variant - rather than opening a task the version deselected.

**No definition.** A version may select a workflow but never define one: a top-level `machines` is refused on write (`editDraft` in `profile-lifecycle.ts`) and dropped on read (`bodyFrom`), and an `intentPack.machines` block is refused by `validateDefinitionBody`. A per-version definition would let two assistants in one classification run different contracts under one workflow name, so an operator asking "what happens when I ask for this work" would get an answer that depended on who they asked. Selection cannot cause that; definition can.

**Work must be openable.** A pack inherits the platform taxonomy with `extends: "default"`; WITHOUT it a pack REPLACES the taxonomy, so omitting one word produces an assistant that cannot classify a request as work at all - no multi-step task, no queue drain, nothing failing, every turn answered as a one-shot reply. A version-carried pack that replaces the taxonomy and declares no work-management intent (`WORK_MANAGEMENT_INTENT_KEYS`) is REFUSED by `manage-profiles`, with a message naming both fixes: declare one, or set `extends: "default"`. The check refuses rather than injecting the intent, because injecting into an authored pack is a silent substitution and authoring your own taxonomy is what `extends` is for.

**Parameter unguarded.** `{SSM_ROOT}/assistant/<classification>/assistant-intent-pack` is written by CDK context, by `seed-demo`, or by hand, none of which passes through code that could refuse it. For that seam this is an authoring rule: a pack written there without `extends: "default"` must declare a work-management intent itself, and nothing reports it if it does not.

**One core intent.** `WORK_MANAGEMENT_INTENT_KEYS` holds only `guided_troubleshooting`. `report_generation` and `data_extraction` look like work management and are not universal: the shipped basic pack omits them on purpose, because an external conversation must not hold an assistant that treats "write me a report on account health" as work it does (`intent-pack-extends.test.ts`). Treating them as required would widen a capability boundary in the name of consistency. The graphs stay global; which of them an assistant can ever OPEN still follows from the intents its own pack declares.

**Unaffected.** The persona, the models, the tools, the guardrail, the context selection, the message choices (`messages`), the display name, the welcome and a classification's own intents stay per assistant, all editable through `manage-profiles`.

### 2.10 Message templates

Most of what an assistant says is written by the model under the persona. The lines below are said by the platform itself, at moments when calling a model would be wrong: a deferral notice must land in milliseconds, a stop acknowledgment must not depend on a model that may be the thing that is stuck, and a failure message has to work when the failure was the model.

Each line is a message template ([ADR-062](../../design/decisions/062-a-message-is-a-template-stored-and-versioned-like-a-document.md)), and Message templates under Workflows is the one place in the console to edit what an assistant says (Assistants → the assistant → Edit or Draft → Workflows → Message templates). For each shipped message it shows the shipped template, the classification's and the assistant's own side by side, says which is in use, previews it with the function that posts it, and saves the assistant's own, which is in use at once and is not part of a version; `npm run template -- put <classification> <file> --assistant <name> --activate` does the same from a terminal. Under Used in this version it picks which template this version says the message from (the shipped one, the classification's, or one of the assistant's own, with conditions), which the draft saves as `messages` ([Which template a message is said from](#which-template-a-message-is-said-from)). With no choice, the assistant's own template of the message's name is said, else the classification's, else the shipped one.

**Retired `copy`.** A version stored before message templates may carry these lines under `copy`, keyed as the table below names them. Nothing reads them: a draft refuses a `copy` line, and validate and activate refuse a draft that still carries one, each naming the migration. `cd backend && npm run migrate-legacy-copy` reads each assistant's active version and writes each line as that assistant's own template, `{var}` as `{{field}}` and checked against the shipped template, refusing and reporting a line that does not fit; it keeps a template the assistant already holds, so a second run writes nothing (`--dry-run` says what it would write, `--assistant <name>` limits it to one). Then clear the lines from a draft cloned from that version (`copy: null`, or Clear the retired lines in the draft). A deploy seeds no `copy`.

The table is each line by the key it was known by, which is the section of the template the migration writes it to (`legacy` in `shipped-message-templates.ts`). The stop that replaces an answer in progress is the `turn-stopped` template, which no retired key worded.

| Retired key | When it is said | Placeholders | Reader | Shipped default |
|---|---|---|---|---|
| `queuedOne` | One message is waiting behind a running turn | `{count}` | `turn-queue-notice.ts` | "Still working on your earlier message. I will read this one as soon as it is done." |
| `queuedMany` | Several are waiting | `{count}` | `turn-queue-notice.ts` | "Still working on your earlier message. I will read all {count} of these when it is done." |
| `queuedOverflow` | The queue bound was hit and the oldest waiting message was dropped; must say something was lost | `{count}` | `turn-queue-notice.ts` | Says the oldest waiting message was dropped and asks for it again |
| `queueWriteFailed` | The queue could not be written, so the message is neither answered nor waiting; must ask for it again | none | `router-agent-handler.ts` | "Something went wrong holding on to that message, so it is not waiting and I will not get to it. Please send it again." |
| `queueSettled` | The queue has been read and is empty | `{count}` | `turn-queue-notice.ts` | "Caught up - I have read those {count} messages." (or "Caught up.") |
| `topicMoved` | One of the conversation's subjects moved to a conversation of its own; carries the link to it | `{title}` | `channel-creation.ts` (`topicMovedLink`), posted by the processor after a split and by the router after a drift move | "Moved {title} to its own conversation. This one stays open for anything else." |
| `queueStatus` | The stage shown while a queue is worked, keyed by stage: `waiting`, `reviewing`, `clarifying`, `addressing_private`, `clearing`, `settled` | none | `turn-queue-status.ts` (`configuredQueueStatusLabel`); a configured label is sent beside the stage token and wins over the client's translation | "Waiting", "Reviewing what arrived", "Checking what you meant", "Addressing private requests", "Clearing the queue", "Done" |
| `email` | The words an email is wrapped in, keyed by line: `language` (the BCP 47 tag the copy is written in), `greeting`, `signOff`, `openConversation`, `viewItHere`, `replyHint`, `manageEmail`, `defaultSubject`, the briefing and share lines, and the preference page | `{name}`, `{link}`, `{date}`, `{sender}`, `{title}`, `{kind}` per key | `email-copy.ts` (`DEFAULT_EMAIL_COPY`); the email of a conversation is in the voice of its primary assistant, signed with its name | "Hi {name},", "Best regards,", "Open conversation", "Manage which emails you receive: {link}" |
| `triageUnclear` | Triage could not reach a reading; must still ask something answerable | none | `async-processor-core.ts`, `turn-triage-proposal.ts` | Asks which message to start with |
| `triageDerived` | The reading was refused and a derived one was used; an invitation to correct | none | `async-processor-core.ts` | Says each message was captured separately and invites correction |
| `triageUnreadable` | The queued messages could not be read at all | none | `async-processor-core.ts` | "I could not read the messages that arrived while I was busy. I will pick them up on your next message." |
| `queuedUnclear` | Heading for queued messages whose request could not be made out | none | `turn-triage-proposal.ts` | "I have these, but I could not tell what they are asking for:" |
| `clarificationsOffer` | Offering to work through outstanding clarifications | `{count}` | `turn-triage-proposal.ts` | "Earlier questions still waiting on an answer: {count}. Would you like me to work through them now?" |
| `clarificationsWorkingThrough` | Taking outstanding clarifications up now | `{count}` | `turn-triage-proposal.ts` | "Earlier questions still waiting on an answer: {count}. I have nothing else open, so I will pick them up now unless you would rather I did not." |
| `queuedPrivateCount` | How the room is told part of the queue was private; a count only, never a person or subject | `{count}` | `turn-triage-proposal.ts` | "Requests I will take up privately with whoever sent them: {count}." |
| `triageUnderstood` | Opens the composed reading of the queue when the model's own words cannot be used | none | `turn-triage-proposal.ts` | "Here is what I understood from the messages that arrived while I was busy." |
| `triageAmendsHeading` | Heads the queued messages that change the work already in flight | none | `turn-triage-proposal.ts` | "Changes to what I was already doing:" |
| `triageOrderAgainstOpen` | Heads the order of new work when work is already open here | none | `turn-triage-proposal.ts` | "Where the new work falls against what is already open here:" |
| `triageOrderNew` | Heads the order of new work when nothing else is open | none | `turn-triage-proposal.ts` | "New, which I would take in this order:" |
| `triageNewItem` | One arriving item in an order that mixes it with open work | `{label}` | `turn-triage-proposal.ts` | "{label} (new)" |
| `triagePrivateTaskLabel` | Holds an open private task's place in the order; read by the room, so it names nothing about the task | none | `turn-triage-proposal.ts` | "a private task (details not visible to you)" |
| `triageDerivedLabel` | The label for a queued message with no text to take a label from | none | `turn-triage-proposal.ts` | "A request that arrived while the assistant was busy" |
| `triageCouldNotRecord` | Heads the requests whose task write failed; must say they were not recorded | `{count}` | `turn-triage-proposal.ts` | "Requests I could not record: {count}." |
| `triageCouldNotRecordPrivate` | Counts the unrecorded requests that were private; a count only, never a person or subject | `{count}` | `turn-triage-proposal.ts` | "Private requests among them: {count}" |
| `triageResendLost` | Asks for the unrecorded requests again; nothing else picks them up | none | `turn-triage-proposal.ts` | "Please send anything listed here again." |
| `triageAskInFlight` | Asks whether to finish the work in flight, when the reading could not tell | none | `turn-triage-proposal.ts` | "Before I start: do you still want me to finish what I was working on, or drop it?" |
| `triageInviteCorrection` | Closes the reading by inviting a change of order or a drop | none | `turn-triage-proposal.ts` | "Tell me if you want a different order, or something dropped." |
| `addressingPrivately` | What the room sees while private requests are handled; must stay generic | none | `turn-private-followup.ts` (`addressingPrivatelyLine`) | "Addressing private requests." |
| `privateFollowUp` | Sent privately to each person whose queued request was private, naming their requests | `{labels}` | `turn-private-followup.ts`, passed by the processor | "About your private request: {labels}. Tell me how you would like me to handle this." |
| `splitRefused` | A subject the person chose to continue elsewhere could not get its own conversation | none | `assistant-async-processor.ts` | Names the subjects that could not be moved and says they are still here |
| `privateMessageNotPrivate` | Said only to a sender whose private message (`.<member>`) arrived without a `Target`, naming a PERSON. The message is KEPT, so this must say the room can see it and must NOT say it was dropped or ask for it to be sent again; a re-send would be read by the room too | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | "Heads up: that message began with a private address but arrived without a private target, so everyone here can see it rather than only the person you named. It is still in the conversation; you can delete it if you would like." |
| `privateMessageNotPrivateAnswering` | The same situation where the address named an ASSISTANT, so the turn is routed to it and answered privately to the sender. A separate line because the person needs to know an answer is coming; the line above would leave somebody who just asked a question believing nothing would happen | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | "Heads up: that message began with a private address but arrived without a private target, so everyone here can see it. I am answering you privately. The original message is still in the conversation; you can delete it if you would like." |
| `privateMessageWrongTarget` | Said only to a sender whose private message (`.<member>`) was stored with a `Target` naming a different member, so it reached the wrong person; must say the person they named did not receive it and ask for it again. The message is KEPT, so it must not claim a removal, must not say the message was never delivered (it was, to somebody), and must not name who received it | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | "That message did not reach the person you named. It was sent privately to somebody else, so they received it and the person you named did not. It is still in the conversation and only they can see it; please send it again." |
| `attachmentTooLargeToRead` | The person's file is larger than the model can take in - too many bytes, or an image over the pixel edge - so the turn is answered without it; must say the file arrived, was not read, and that the answer follows without it. One line covers both limits, because the person's remedy is the same either way. Said only by the turn that carried the file, never again when the same file is re-offered from history | `{name}` | `attachment-budget.ts`, applied in `assistant-async-processor.ts` | `ATTACHMENT_TOO_LARGE_DEFAULT`: "I could not read the file you attached: it is larger than I can take in. Everything below answers your message without it. A smaller version, or the part that matters as text, and I can read it." |
| `stopped` | `/stop` canceled the work in progress and a question about how to proceed follows | `{count}` | `router-agent-handler.ts` | "Stopped, and I've cancelled that. I'll ask how you want to proceed." |
| `stopCancelledButNotAsked` | Canceled, but the follow-up question could not be asked | none | `router-agent-handler.ts` | "Stopped, and I've cancelled {the work}. Ask me again whenever you want it." |
| `stopCancelFailed` | The stop landed but the work could not be canceled; must say so | none | `router-agent-handler.ts` | "Stopped, but I could not cancel {the work}. Send /stop again to try once more." |
| `stopLeftCancelled` | The person chose to leave the work canceled | none | `router-agent-handler.ts` | "All right, it stays cancelled." |
| `stopNothingToStop` | Nothing of this person's was running | none | `router-agent-handler.ts` | "There's nothing in progress here to stop." |
| `stopAmbiguous` | `/stop` was unaddressed in a room with more than one assistant; must say nothing stopped | none | `router-agent-handler.ts` | Says nothing was stopped and asks to mention the assistant and send `/stop` again |
| `stopMustBePublic` | `/stop` was sent privately in a group, so nothing stopped; sent only to the sender | none | `router-agent-handler.ts` | "Nothing has been stopped. A stop pauses me for everyone in this conversation, so send /stop to the whole conversation rather than privately." |
| `handoverOwnerUnavailable` | A message answered work another assistant owns and could not be handed to it | `{name}` | `router-agent-handler.ts` | Says the owner could not be reached, this assistant did not answer in its place, and to send again |
| `taskRefNotFound` | A reply began with `#<n>` naming nothing its sender may answer | `{ref}`, `{items}` | `task-reference.ts` via the router | `DEFAULT_TASK_REF_NOT_FOUND` |
| `taskRefNothingOpen` | The same, with nothing else open for the sender | `{ref}` | `task-reference.ts` via the router | `DEFAULT_TASK_REF_NOTHING_OPEN` |
| `taskRefHint` | Added under a question when the person has more than one open item ([ADR-035](../../design/decisions/035-a-reply-names-the-work-it-answers.md)) | `{ref}` | `assistant-async-processor.ts` | `DEFAULT_TASK_REF_HINT`: "Start your reply with #{ref} so I know it answers this one." |
| `taskStillOpen` | Added when a turn advanced an item without finishing it | `{state}`, `{next}` | `task-reference.ts` (`taskStillOpenLine`), applied in `assistant-async-processor.ts` | `DEFAULT_TASK_STILL_OPEN`: "This is still open: it is at {state} now, and {next} comes next." |
| `answeredPrivately` | The public line left when a private item was answered privately from a public message | none | `async-processor-core.ts` | `ANSWERED_PRIVATELY`: "I have replied to you privately." |
| `resumedChainAnswered` | Private receipt when a message resumed held work and the turn posted its answer | none | `resumed-chain-delivery.ts` | "Thanks - picking that back up. My answer is in the conversation." |
| `resumedChainAsked` | The same receipt when the turn posted a question instead | none | `resumed-chain-delivery.ts` | "Thanks - picking that back up. I have asked you something in the conversation." |
| `conversationArchived` | Posted when a moderator archives the conversation; must say it is read-only | `{who}`, `{date}` | named by `conversation-management.ts` (`sayThroughRouter`); said by the router (`noticeLine`) | "Conversation archived by {who} on {date}. It is now read-only." |
| `completedWithoutSummary` | The turn changed something and produced no words; must not invite a retry | none | `async-processor-core.ts` | "That is done." |
| `nothingChanged` | The turn produced no words and changed nothing; must say to ask again | none | `async-processor-core.ts` | "I was not able to produce an answer to that, and nothing was changed. Please try again." |
| `turnFailed` | A turn died with its retries spent | none | `assistant-async-processor.ts` | "Something went wrong while I was working on your last message, and I could not finish it. Please send it again." |
| `answerTruncated` | Appended when a long answer is cut short because a later part could not be posted | none | `async-processor-core.ts` | "*(Additional content could not be delivered)*" |
| `answerUndelivered` | The failure reason recorded on a task whose answer could not be delivered | none | `assistant-async-processor.ts` | "The answer could not be delivered" |
| `battleNoRebuttal` | A battle side declined round 2; its placeholder resolves to this | none | `async-processor-core.ts` | "No rebuttal." |
| `battleAltName` | A battle challenger's display name when it matches the live assistant's, in the duel and on the scorecard | `{name}` | `experiment-manager.ts` (`battleSideNames`) | "{name} (alt)" |
| `battleChallengerUnnamed` | The challenger's name in the Battle Mode ON line when its profile's name cannot be read; never its assistant id | none | `channel-battle.ts` (`battleSidesOf`) | "The challenger" |
| `capabilityUnavailable` | A request for an output this assistant does not produce is refused | `{output}` | `capability-refusal.ts` | "I don't produce {output} in this conversation." |
| `capabilityNotOffered` | A request for something else it does not offer is refused | none | `capability-refusal.ts` | "That isn't something I do in this conversation." |
| `capabilityHasAccess`, `capabilityHasAccessClose` | Frame the list of classifications the person reaches that would serve it; sent to the person alone | none | `capability-refusal.ts` | "You have access to conversations that do:" / "Start a new conversation there and ask again." |
| `capabilityNeedsAccess` | The person reaches none; sent to them alone; must name no classification | `{output}` | `capability-refusal.ts` | "If you need {output}, ask your administrator for access." |
| `capabilityNotOfferedNeedsAccess` | The same, for a request with no output, when the person reaches no other conversation | none | `capability-refusal.ts` | "If you need it, ask your administrator for access." |
| `capabilityOutputDocument`, `capabilityOutputImage` | The nouns `{output}` takes | none | `capability-refusal.ts` | "report documents" / "images" |
| `battleNeedsPrompt` | `/battle` was sent with no prompt after it; to the sender | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | "Add a prompt after /battle and both assistants will answer it, for example: /battle what should we prioritise next quarter?" |
| `battleNoneRunning` | `/battle end` with no duel running; to the sender | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | "There is no battle running in this conversation, so there is nothing to end." |
| `battleNotYours` | `/battle end` from someone who neither started the duel nor moderates; to the sender | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | Says only the starter can end it, or a moderator can turn Battle Mode off |
| `battleAlreadyDone` | `/battle end` for a duel that had already finished; to the sender | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | "That battle is done. The conversation is clear for a new one." |
| `assistantUnavailable` | The assistant a person addressed cannot take a turn (no active version, no record, or a refused session); said by the conversation's primary, to that person | `{name}` | `assistant-notice.ts`, said by the router (`reportTurnNotStarted`) | "{name} can't answer right now, so nothing is on its way from it. An administrator has been told. You can ask me instead." |
| `battleModeOn` | A moderator turned Battle Mode on | `{variant}` | `assistant-notice.ts`, named by a service and said by the router (`sayThroughRouter`) | "Battle Mode is now ON. {variant} has joined the channel. Try /battle <your prompt> to compare both assistants." |
| `battleModeBriefing` | The same, when the experiment carries a written brief | `{briefing}` | `assistant-notice.ts`, named by a service and said by the router (`sayThroughRouter`) | "{briefing}" |
| `battleModeOff` | A moderator turned Battle Mode off | none | `assistant-notice.ts`, named by a service and said by the router (`sayThroughRouter`) | "Battle Mode is now OFF." |
| `battleModeOffEnded` | The same, and a duel was running | none | `assistant-notice.ts`, named by a service and said by the router (`sayThroughRouter`) | "Battle Mode is now OFF. The battle that was running has ended, along with anything it was collecting." |
| `memberJoined` | Someone joined the conversation | `{name}` | `assistant-notice.ts`, named by a service and said by the router (`sayThroughRouter`) | "**{name}** joined this conversation. Mention **@assistant** or **@all** to bring in the assistant." |
| `joinRecapRequest` | What the room's assistant is asked when a person joins, so it catches them up privately; read by the model, not by the room | none | `join-recap.ts` (`joinRecapRequestFor`), the `join-recap` prompt template | "The person you are answering has just joined this conversation and cannot see what came before. Catch them up in a few sentences: ..." |
| `memberWelcome` | To the person who joined, privately; emailed to them | `{name}`, `{recap}` | `assistant-notice.ts`, named by a service and said by the router (`sayThroughRouter`) | "Welcome, {name}. You have been added to {recap}. ..." |
| `briefingReady` | A proactive briefing is ready, in the conversation it created | `{source}` | `assistant-notice.ts`, named by a service and said by the router (`sayThroughRouter`) | "I generated a proactive briefing for you (no request needed, triggered by {source}). Ask me anything about it here." |
| `battleEnded` | A duel ended before its rebuttal was dispatched; to the sender | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | Says nothing from it is counted and how to start a new one |
| `battleEndedReplyInFlight` | A duel ended while a rebuttal was already on its way; must not promise that no reply follows | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | Says a final reply may still arrive and nothing is counted |
| `battleStarterUnknown` | The person starting a duel could not be identified, so none started; to the sender | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | Says no battle was started and to try again |
| `battleUnavailable` | The conversation's classification offers no Battle Mode; to the sender | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | "Battle Mode isn't available in this conversation. Reply normally and I'll respond as usual." |
| `battleNotEnabled` | Battle Mode is offered but the room's toggle is off; to the sender | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | Says to ask a moderator to turn it on |
| `battleExperimentEnded` | The experiment the room was battling for has ended; to the sender | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | Says there is nothing left to compare |
| `battleAlreadyRunningYours` | A duel is running and the sender started it | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | Says to send `/battle end` first or let it finish |
| `battleAlreadyRunningTheirs` | A duel is running and someone else started it | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | Says it stays with its starter, who can end it, or a moderator |
| `battleStartFailed` | The duel could not be recorded, so it did not start; to the sender | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | "I couldn't start that battle just now. Please try /battle again." |
| `battleNotConfigured` | The classification's battle wiring is incomplete; to the sender | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | Says to ask an operator to check the deployment |
| `battleSideStartFailed` | One side of a duel could not be started; said by that side to the room | none | `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | "I couldn't start on that just now." |
| `battleSideDidNotFinish` | A side did not finish round 1, so it runs no rebuttal; said by that side to the room | `{name}` (the side's display name in the duel) | `assistant-notice.ts`, named by the battle orchestrator and said by the router (`sayThroughRouter`) | "{name} didn't finish in time." |
| `battleSideDidNotFinishUnnamed` | The same, when the duel carries no display name for the side | none | `assistant-notice.ts`, named by the battle orchestrator and said by the router (`sayThroughRouter`) | "One assistant didn't finish in time." |
| `battleNoneFinished` | No side finished round 1, so the duel closes; said by the room's primary to the room | none | `assistant-notice.ts`, named by the battle orchestrator and said by the router (`sayThroughRouter`) | "This battle couldn't be completed. No assistant finished in time. Try /battle again." |
| `rateLimited` | The person reached their hourly message limit; to the sender | `{minutes}` | `abuse-controls.ts` (the router's own gate) and `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | "You've reached your message limit for this hour. It resets in about {minutes} min." |
| `budgetExhausted` | The spend budget refused the turn; to the sender. Falls back to the deployment's `budgetCannedResponse` before the shipped English | none | `abuse-controls.ts` (the router's own gate) and `assistant-notice.ts`, said by the router (`sayNotice`) when the channel flow names it | "We are experiencing unusually high demand right now. Please try again in a little while." |

Only the listed placeholders are substituted; in a template each is written `{{field}}`.

**Rewrite rules.** Two rules the defaults follow and a rewrite must keep. A line that names a count must not name a subject or a person: several of these are posted to a room where private requests are counted but never described. And a line that asks must stay answerable: `triageUnclear` is used at the moment the assistant admits it did not understand, and a line that only admits confusion leaves the person with nothing to do and their messages still queued.

### 2.11 What the runtime checks before it delivers

A state marked `produces: 'document'` does not simply hand its text over. The model declares the document as an argument, separate from its reply: `document` on the `advance_task_state` call that enters a delivering state or finishes from one, or `deliver_document` for a rewrite while the task stays in a delivering state. `advance_task_state` refuses a delivering move with no document (`document_required`). Only the declared document becomes the file; the reply posts as chat beside it. The turn then checks the document, corrects it if needed, and delivers what passes. Two kinds of check run:

- **Against the agreement.** If the step's `requires` collected a length, the model records it as a WORD RANGE at the moment the person confirms it - it resolves "1-2 pages" or "keep it short" into `minWords`/`maxWords` on the `advance_task_state` call - and the delivering turn measures the document against those numbers (`task.details.lengthTarget`). Nothing here parses English: the component that understood the sentence is the one that converted it, and a requirement naming no size (`"as a table"`) records none, so nothing is enforced. That is deliberate - an absent agreement is not a violation, and a guessed one is worse than none.
- **Document shape.** The document must open as a document, read from its markup: a heading, a table row, a fenced block, a bold title line, a setext heading, a CSV header with rows, or structured data. A code deliverable (an intent whose answer declares `fileType: 'code'`) is exempt, because code is code wherever it starts. This needs no agreement: a delivered file is read later by someone who is not in the conversation it came from.
- **Against the template**, when the delivering state declares one ([Document templates](#document-templates)): the template's required sections present and in order, by position and heading level, and each declared table present with its column count. Never by heading text, so a document written in the conversation's language passes.

A document that fails goes back to the model, up to three times, with the placeholder saying what is being fixed. A declared document that still does not open as a document, or still does not follow its template, after the bound posts inline after the reply rather than as a file.

**Tunable constants.** Every threshold in that paragraph is a constant with a reason, not a property of the design. They are gathered here so you can change them deliberately:

| Knob | Where | Value | What moving it costs |
|---|---|---|---|
| Correction passes | `MAX_CORRECTION_ROUNDS`, `assistant-async-processor.ts` | 3 | Each pass is a model call on the most expensive turn the platform runs. Raise it for stricter conformance, lower it for latency. |
| Minimum artifact size | `assistant-async-processor.ts`, **two sites**: the task delivery gate and the shared floor every packaged document passes, which is where the ad-hoc "save this as a document" path meets it | 400 chars | Below it, content posts inline instead of as a file. Raising it sends more short answers to chat; lowering it risks a one-sentence answer buried behind a download. Change both, or the two paths disagree about what is worth downloading. |
| Words a page is worth | the `minWords`/`maxWords` descriptions in the `advance_task_state` schema, `task-tools.ts` | "roughly 300-900 words depending on how much of it is tables and lists" | GUIDANCE, not a constant: the model converts "1-2 pages" to a range when it records the requirement, and this sentence is what it converts by. Narrow it and more documents get rewritten; widen it and more length misses pass. |
| Content floor on a rewrite | `acceptCorrection`, `deliverable-check.ts` | 60% of the original, for a length fault or a document with no countable structure | Stops a correction that deletes the document from being accepted. Raising it rejects legitimate tightening; lowering it re-opens the failure this exists for. A correction for the opening alone is judged instead by whether every table row, heading and fenced block survived, because taking a greeting and a closing offer out of a short document can remove half its words. |
| What counts as chat wrapper / reader question / file claim | `deliverable-check.ts` | three regexes, measured only | Logged as `[shadow] deliverable_phrase_check` and never acted on (tenet D11). Use the rate to see how often a declared document still carries conversation. |

**Phrase checks are a measurement.** The greeting, reader-question and file-claim rules are ENGLISH patterns, so they decide nothing: a deployment answering in another language would pass them in both directions. What decides is structural - the document arrives declared, separate from the reply, and it must open as a document by its markup - so the same rules hold in every language.

**Known limits.** Two further limits are worth knowing before you design around them, and neither is fundamental:

1. **Best version ships.** At the correction bound, the best version is delivered anyway and the shortfall is logged. The reasoning is that a report the person can read beats a turn that never lands. If your deployment would rather withhold a document that does not match, that is a change at the same place the bound lives - stop assigning the corrected text and take the error path instead.
2. **Model decides completion.** Completion is still the model's decision. `advance_task_state` runs earlier in the same turn than these checks, so the loop can correct a document but cannot un-declare a completion the model already made. The delivering state's prompt says that delivering is not closing, but holding at `generating` is the model complying rather than the runtime enforcing. Making completion conditional on the checks passing means moving the gate: hold the terminal transition until the delivering checks pass, in the same way the recorded requirements moved the length agreement out of prose and into data.

Both of these, and the thresholds above, are per-platform constants today rather than per-deployment configuration. If a deployment needs its own values, the established seam is the one the rest of this guide uses: carry them in the versioned profile definition beside `copy`, so they travel with the profile and can be changed without a code deploy.

#### Document templates

A delivering state can fix the shape of the document it hands over while the model writes the content ([SPEC-DOCUMENT-TEMPLATES](../../specs/interaction/conversation/SPEC-DOCUMENT-TEMPLATES.md)). Every report follows one: the platform `report_generation` workflow declares the shipped `report` template on `generating` and `revising`. A template is a Markdown file: its headings are its sections, its pipe tables declare their columns, and a front-matter block (a JSON object between two `---` lines) names it and carries the rest.

```markdown
---
{
  "name": "quarterly-account-review",
  "description": "A full quarterly review of one account.",
  "sections": {
    "Metrics": { "guidance": "One row per metric, previous quarter against this one." },
    "Risks": { "optional": true, "guidance": "Leave this out when there is none." }
  }
}
---
# Quarterly account review

## Summary

## Metrics

| Metric | Previous quarter | This quarter | Change |
|---|---|---|---|

## Risks
```

| Front-matter field | What it declares |
|---|---|
| `name` | The template's key: lowercase letters, digits and hyphens. What a state's `template` names |
| `description` | Read to the person when a workflow offers a choice of formats |
| `sections` | Keyed by a heading in the template: `optional` (the section may be absent) and `guidance` (instruction to the model, never expected in the document) |
| `fill` | `"platform"`: the platform renders the document from what the task recorded, with no model call |
| `fields` | With `fill`: each `{{placeholder}}` in the body bound to `requirement:<need>` (a sourced requirement), `detail:<key>` (a value on the task's details) or `tool:<state>.<path>` (the result the step action on `<state>` recorded, walked by key or array index, read only when that run succeeded). A field with nothing recorded refuses the delivery (`template_unbound_field`) |

`parseTemplate` (`lambda/src/lib/document-template.ts`) refuses a template it could not check against, naming why, when the template is put.

**The shipped template.** `backend/lib/config/default-templates/report.md` is the platform's `report` template: a title, a summary, the findings (one level-3 heading per topic), optional recommendations, and the sources. The deploy writes it for each classification whose workflows declare it, derived at synth by `templatesDeclaredFor` (`lib/config/default-templates.ts`): the intents the classification serves (its `-c assistantIntentPack` where its topology reads one, else the platform pack), less a document-producing intent where the registry's `produces` holds no `document`, each selecting its workflow, from the pack's machines over the platform's. A classification with no templated workflow gets no template, no writer and no templates read grant. The writer (`DefaultTemplateWriter`, `lib/constructs/default-template-writer.ts`) puts the body create-only and sets the pointer only when none exists, with `PutObject` on that classification's `templates/` prefix and `PutParameter` on that pointer alone, so a version the deployment activated is never moved by a redeploy. A changed shipped template is stored beside the old one at the next deploy and is adopted by activating it.

**Storing and activating.** Bodies are stored per classification at `templates/<classification>/<name>/<sha256>.md` in the attachments bucket, created once and never overwritten. The version in use is the SSM parameter `<ssmRoot>/assistant/<classification>/templates/<name>` (`{ "active": "<sha256>", "history": [...] }`); activating and rolling back rewrite only that pointer, and a turn re-reads it within 30 seconds, so a change needs no deploy. Operator writes run on the operator's own credentials; the deploy's writer is the only deployed principal that writes, and the turn roles read only their own classification's prefix and pointers.

```bash
cd backend
npm run template -- put premium demo/templates/quarterly-account-review.md --activate --dry-run
npm run template -- put premium demo/templates/quarterly-account-review.md --activate
npm run template -- list premium
npm run template -- activate premium quarterly-account-review <sha256>
npm run template -- rollback premium quarterly-account-review
npm run template -- check premium                # every template premium's workflows declare resolves
```

**Replacing the shipped template.** Put your own body under the same name and activate it; the platform workflow keeps declaring `report`, and every report from then on follows your version:

```bash
npm run template -- put standard my-report.md --activate    # my-report.md declares "name": "report"
npm run template -- rollback standard report                 # back to the version active before
```

The demo seed stores `quarterly-account-review` and `executive-summary` for premium, activating each when no version is active, and writes premium's pack, whose report workflow offers the two (below).

**Declaring.** A template is declared on a delivering state of a workflow in the classification's intent pack (`machines`, [2.9](#29-global-workflows)). Validation refuses it on a state that does not deliver. Whether the named template exists for the classification is checked where the pack and the store are both read: `npm run template -- check`, and each turn that loads the workflow, which refuses the delivering move with `template_unavailable` and the reason rather than delivering an unshaped document.

```json
{ "machines": { "report_generation": { "initial": "collecting_requirements", "states": {
  "generating": { "transitions": ["completed", "revising"], "delivers": true, "template": "quarterly-account-review" },
  "revising":   { "transitions": ["completed", "generating"], "delivers": true, "template": "quarterly-account-review" }
} } } }
```

A pack machine replaces the shipped one of the same name whole, so declare every state of `report_generation`, copying the shipped ones from `DEFAULT_TASK_STATE_MACHINES`. `withTemplateChoice` (`backend/demo/intent-packs.ts`) does that by value and changes only the delivering states' declaration, and the demo's premium pack is built with it. A version does not read `machines`, so the pack goes on the classification's `assistant-intent-pack` parameter (`-c assistantIntentPack`, or `writeClassificationPack`, which the demo seed uses for premium).

**Offering a choice.** `templates: ["quarterly-account-review", "executive-summary"]` with an optional `defaultTemplate`, as premium's demo pack declares, puts the choice on the workflow's requirements step: the step's guidance lists each template's name and description, and `advance_task_state` takes a `template` argument whose `name` is an enum of exactly those names, with `source` and `evidence` like every requirement. With no default, the step is not left until somebody chose (`requirement_unsourced`, missing `template`). The delivering step loads the recorded choice, a revision keeps it until a new one is recorded, and with no choice the default is used.

**What is recorded.** Each templated delivery records the template's name, content hash and outcome (`passed`, `passed_after_correction`, `posted_inline` or `filled_by_platform`) on the task's delivery record, on the turn's analytics record (`documentTemplate`) and on the delivered-document reference evaluation grades from. The share of matched headings whose text equals the template's is logged as `[shadow] template_heading_text` and decides nothing.

### 2.12 Per-deployment parameters and published keys

Two key families, keyed by different names (1.2). The versioned definition and draft are under `${SSM_ROOT}/assistant/<profile>/`, keyed by the PROFILE name (`definitionParamName` in `active-profile.ts`, `draftParamName` in `profile-lifecycle.ts`):

| Key | Contents | Written by | Read by | Cache |
|---|---|---|---|---|
| `definition` | The versioned definition (2.5) | `manage-profiles`; `seedAllProfileDefinitions` in `backend/lambda/src/lib/seed-profile-definitions.ts`, run by `backend/scripts/seed-demo.ts` | Handler, processor, channel flow, post-processing, experiments (`resolveActiveProfile`) | 30 seconds per warm container, per profile name |
| `draft` | The draft in progress | `manage-profiles` | `manage-profiles` | none |

Everything else is under `${SSM_ROOT}/assistant/<classification>/`, keyed by the CLASSIFICATION value and created or read by `assistant-profile-stack.ts`:

| Key | Contents | Written by | Read by | Cache |
|---|---|---|---|---|
| `assistant-system-prompt` | Per-deployment persona (Advanced tier) | `-c assistantSystemPrompt` for stacks whose topology sets `systemPromptParam` | Processor `resolveBaseSystemPrompt` | Warm life |
| `assistant-intent-pack` | A pointer to the intent pack's body at `classification-packs/<classification>/<sha256>/intentPack` in the attachments bucket (Intelligent-Tiering); an inline pack JSON still reads | `-c assistantIntentPack` for stacks whose topology sets `intentPackParam`, which writes the body and then the pointer; `writeClassificationPack` in `intent-pack.ts` for a script | Handler, processor and task service `hydrateIntentPackFromSsm`, and only when the serving version carries no `intentPack` of its own; the item list, the profile write path and the classifier replay through `resolvePackParameterValue` | Warm life |
| `onboarding-intake` | Onboarding intake JSON (section 4) | The deployer, by a direct SSM write, or `seed-demo.ts`; no stack and no CDK context key writes it | Handler `loadIntakeConfig`, only when the active version carries no `onboarding` | 30 seconds per warm container, including an absent result |
| `welcome-orientation` | Welcome orientation JSON (3.6) | A direct SSM write or `seed-demo.ts` | Handler, only when the opening of the welcome the room's type selects carries no field of its own and the assistant is the classification's primary | Warm life once loaded successfully |
| `guardrails` | Selectable guardrails with resolved ids | The stack | `manage-profiles` (validate, activate, import) | n/a |
| `context-sources` | The published context-source catalog, without ARNs | The stack | Processor per turn; `manage-profiles` | n/a |
| `processor-arn`, `router-arn`, `task-service-arn`, `bot-arn` | The classification's runtime identifiers | The stack | The shared router and other stacks | n/a |

The persona and intent pack writers are **preserve-on-absent** ([decision 012](../../design/decisions/012-assistant-config-store-and-drift.md)): a parameter is written only when a non-empty value is supplied and is never deleted, so a deploy that omits the context does not blank a live persona. With `-c assistantParamWriter` an `AwsCustomResource` performs the write, and a content hash in its physical id makes a changed value re-put. The intent pack's body is always written by an `AwsCustomResource` (`IntentPackBodyWriter`) that holds `s3:PutObject` on that classification's `classification-packs/<classification>/` prefix only, and the pointer depends on it, so a pointer never names a body that is not there. An `assistantIntentPack` over `MAX_INTENT_PACK_BYTES` is refused at synth with its size named. A `systemPromptParam` stack with an empty persona emits a synth warning. Both parameters are `String`, not `SecureString`, and passing them through `-c` puts them in shell history and possibly `cdk.context.json`: keep secrets out of persona and pack.

### 2.13 Portability: export, import, manifest, contracts

`exportManifest` and `importManifest` in `backend/lambda/src/lib/profile-manifest.ts`, reached through `POST .../admin/profiles/export` and `.../admin/profiles/import`.

| Manifest field | What it carries |
|---|---|
| `schemaVersion` | `1` (`MANIFEST_SCHEMA_VERSION`); import rejects any other value |
| `kind` | `'assistant-profile'` |
| `profileName` | The logical assistant name |
| `body` | The runtime-editable body (`bodyFrom`) with the model bundle completed (`ensureModelsBundle`: base model, classifier and routes; never an image model the version does not name); the persona is inlined, never a pointer |
| `provenance` | `sourceProfileName`, `sourceVersion`, `exportedConfigId`, best-effort `instanceId` |
| `contextContracts` | Per selected context key, the field contract it satisfied on the source (`contractVersion`, field names and types); import rejects a target publishing the same key with a different shape |
| `contentHash` | sha256 of the body, carried into the landed draft's audit chain |
| `signature` | Optional HMAC-SHA256, present when the exporter has `MANIFEST_SIGNING_SECRET`; import verifies it with a shared secret and requires it when `MANIFEST_REQUIRE_SIGNATURE` is set |

What travels and what does not:

| Component | Travels in an export? |
|---|---|
| Seed fields `name`, `contextScope`, and every deployment-time setting in 2.3 | No; the target's own seed and stack apply |
| Versioned body: models, tools, guardrail selection, message choices, display name, welcome, boundary line, workflow selection, context selection | Yes |
| Persona | Yes, inlined; import writes it into the target's own bucket |
| `active` pointer | No; an import always lands as a draft |
| Intent pack and onboarding intake | Yes; both ride the body and travel INLINE in the manifest, so a target instance never sees this account's S3 keys |
| Guardrail | The catalog key travels; the target resolves it to its own id |
| Model | The key travels; import rejects a model the target does not provision |
| Context sources | The key and its contract travel; import rejects an unpublished key or a mismatched contract |
| Company documents | No; the corpus stays in the source bucket |
| Handler and processor IAM roles | Never |

Import is fail-closed: a size bound (`MAX_MANIFEST_BYTES`), schema validation, target model, guardrail and context catalog checks, and a draft landing. It creates no IAM, widens no scope and adds no model.

**An import names its target.** The manifest's `profileName` records where it was exported from and never decides where it lands: `POST .../admin/profiles/import` requires `targetProfileName` and refuses a request without one (`400 TARGET_REQUIRED`), and the team route `.../admin/assistants/{assistant}/profiles/import` lands on the assistant in its path. A manifest exported from `advisor` and imported with `targetProfileName: finance-advisor` becomes `finance-advisor`'s draft. In the console, import is in an assistant's Versions group beside Export (**Import a version**): it reads the chosen file in the browser, refuses one that is not a manifest, and previews where it came from (its assistant, display name, version, config id, export time and source instance, where the manifest carries them) and what will happen (a draft of this assistant, replacing a draft that exists) before anything is sent. The server's refusals are shown with each reason.

**IAM stays outside.** The IAM role is not part of the profile. The role grants `bedrock:InvokeModel` on allow-listed models, `ssm:GetParameter` on the profile's parameters, and S3 reads scoped to the classification's prefixes, and no version can alter it. The widest thing an activated version can do is select a different option the deployment already provisioned and permitted, which is why a version is safe to edit at runtime and portable across instances.

### 2.14 Turn resolution

`resolveActiveProfile(profileName, { ssm, ssmRoot })`:

1. Returns the cached entry if younger than 30 seconds (`ttlMs`, per warm container, keyed by profile name).
2. Reads `${SSM_ROOT}/assistant/<profile>/definition:active` (the label, not a version number).
3. Parses and validates it (`schemaVersion`, `profileName`, `validateDefinitionBody`), then follows `personaRef` and `intentPackRef` (`hydrateBodies`, which fetches both in one pass).
4. Any failure (absent parameter or label, unparseable, invalid, unreadable persona body) serves the **compiled seed** with `configId: 'seed'`; a missing label is logged quietly, anything else with a warning.
5. `resolveFromDefinition` merges the body over the seed. `name`, `contextScope` and every deployment-time setting in 2.3 always come from the seed.

A turn consumes: the merged `modelKey`, `models.byIntent`, `models.image`, `tools`, `guardrailId`, `persona`, `intentPack` (instructions, per-intent tools and response shaping), `contextSources` and `messages` (the message templates it names) in the processor; `models.classifier`, `intentPack` (classification, delivery, and the task type a turn opens), `workflows` (also on a duel side, `battle-turn.ts`), `onboarding`, `eventWorkflows` (the welcome and the other event workflows), `persona` (for the `persona` intake assertion) and `messages` in the router. The retired `copy` and `welcome` are not read. `displayName` is applied to the assistant's identity on activation, and `boundary` feeds what the assistant publishes about itself (2.7). An activation or rollback converges within about 30 seconds and applies to the next turn of an existing conversation, with no reconnect and no effect on a reply already in flight.

### 2.15 Turn assistant profile

A profile belongs to an assistant, and a classification can have several (`premium` has `advisor` and `ops-premium`), so the profile a turn reads is the addressed assistant's, never `requireProfileFor(classification)`, which answers the classification's primary.

The router resolves it once per turn with `turnAssistantProfile` (`backend/lambda/src/lib/turn-assistant.ts`). The assistant is the one assigned to the bot the turn was addressed as, read from the assignment records (`/{root}/assistant-assignments/{classification}/{role}/{live|alt}`): a Lex turn names its Lex bot, and a turn the channel flow hands over names its bot in `AE.bot.arn`. Every per-assistant read of that turn uses the one result:

| Setting | Source |
|---|---|
| `classifierMode`, `rateLimitPerHour` | The assistant's compiled profile (deployment-time, 2.3) |
| `models.classifier`, `intentPack`, `workflows`, `onboarding`, `persona` (intake assertion), `messages` | The active version of the assistant's profile (`resolveActiveProfile`) |
| Placeholder and notice attribution (`agentType`, `assistantRole`) | The assistant's profile name and its role |
| The welcome (`loadWelcomeFor`) and the role template it picks | The assistant's profile name and its role, the same resolution the answer uses |

The assistant's message templates cover every line it speaks in its own voice from the router: the `#<n>` reference reply, the handover-unavailable reply, the stop lines, the capability refusal, the queue notice and the queue-write failure.

**Declines.** A turn whose assistant cannot be named is declined with no reply and a `[SecurityEvent]` log, never answered on another assistant's settings (tenet P4, ADR-046). That is a handler with no `CLASSIFICATION`, a record naming an assistant the deployment does not declare, assignment records that cannot be read in a classification with more than one assistant, and a bot with no record that is not the classification's own bot.

**Primary profile.** One case answers on the classification's primary, and it does not substitute one assistant for another: a classification with one assistant answers when its records cannot be read, because its primary is that assistant.

**An assistant created in the console.** An assistant can be declared here and deployed, or created in the console ([ADR-048](../../design/decisions/048-an-assistant-is-not-a-classification.md)); both behave the same and are listed together on the console's Assistants tab. One created in the console is listed and versioned while its directory entry (`{root}/assistant-directory/{assistantId}`) says it is active. It has no compiled behavior, so when its build finishes `manage-assistants` asks `manage-profiles` (the one writer of the profile namespace) for a first draft from the starting point its create named (`startingPoint`, `lib/starting-point.ts`): its classification's defaults (the classification's intent pack at `/assistant/{classification}/assistant-intent-pack` and its persona parameter where one is set), a profile manifest in the export format (landed through the same import, with the same refusals), or a copy of the active version of another assistant in the same classification. The create's display name, base model and classifier model are written over whichever it starts from. A manifest or a copy is checked by `manage-profiles` (`aeCheckStartingPoint`) before the name is taken, so one that cannot land is refused with its reasons (`STARTING_POINT_REFUSED`) and nothing is built. The draft is reviewed, edited and activated like any other; `/version` on an assistant that has never been activated seeds that draft again, and an import (`/import` with `targetProfileName`) replaces it. A seed that fails is recorded on the directory entry (`firstDraftError`) and shown on its row. Activation refuses a version that does not carry its own `intentPack`, because such an assistant does not inherit its classification's pack. Until it has an active version the vend refuses to act as it. An admin creates one with `POST /admin/roster` (`manage-assistants`): the request names the id, the classification, an enabled role, the display name and the descriptor (`modelKey`, `classifierMode`, and optionally `classifierModelKey`, a model the classification selects or `default` for the platform classifier, and `rateLimitPerHour`), and optionally `ownerTeam` and `startingPoint` (`{ kind: 'defaults' }`, `{ kind: 'manifest', manifest }` or `{ kind: 'copy', from }`; absent means the defaults). A team member creates one for their own team with `POST /admin/teams/{team}/roster`, which refuses another team, a classification their clearance does not reach, an assistant with no owner and a copy of an assistant the team does not own (`COPY_SOURCE_NOT_OWNED`). The answer is `202`; the directory entry reads `provisioning` while its Amazon Lex bot builds, then `active`, or `failed` with what was left behind. `POST /admin/roster/{assistantId}/retire` (admins) retires it and keeps the name as a tombstone, so a name is never reused. Neither route creates a classification or a role: one the deployment does not declare is refused, because declaring it changes IAM and is a deploy (5, 5b). The console's **Create an assistant** flow takes the classification and role from what is deployed, links to those sections for anything else, asks what the first draft starts from and shows what it will hold (the classification's intents, workflows and templates, or a file's source and intents, or the assistant and version copied), offers only the models the classification selects for the base and the classifier model, and takes an optional turns per hour, which its configuration changes later under Limits (`POST /admin/roster/{assistantId}/limits`, or `POST /admin/teams/{team}/roster/{assistantId}/limits` for an owning team; the router reads it from the assignment record). A team member's console session is re-issued after the create, so the new assistant opens without signing in again. Its owner is the `owner-team` tag on its identity, the one source of truth for ownership; the directory entry's `ownerTeam` is the team it was created for and is read only while it has no identity.

**The alt's profile: the candidate history.** A role's alt is the assistant `alt-{role}-{classification}` ([ADR-050](../../design/decisions/050-the-alt-is-an-assistant-and-a-conversation-is-enrolled-once.md)), and its version history is the record of what experiments tested. It is published only through an experiment: arming any experiment, battle or not, pins the live assistant's active version as the control (`controlPin`, a reference; nothing is published under the live name) and derives the treatment from it by the experiment type's recipe into the alt's history (`altPin`; `deriveExperimentVersions` in `manage-profiles.ts`, invoked by the experiments handler; `POST /admin/profiles/variant-version` derives a treatment on request and refuses the control with `409 CONTROL_IS_THE_LIVE_VERSION`). The ordinary edit routes (`/version`, `/draft`, `/validate`, `/activate`, `/rollback`, `/import`) refuse an alt's name with `409 ALT_PROFILE_IS_EDITED_THROUGH_ITS_EXPERIMENT`, and `/export` stays open. A candidate carries `derivedFrom` (experiment, variant, base assistant and version) and `activateExistingVersion` refuses it as a rollback target, naming the Promote action. A model experiment's candidate may change only the model selections and the persona addendum (an `intent` experiment only its intent's route primary); a profile experiment's may change everything but the intents. A battle's display names are aliases on the experiment row and never in a version.

**Promoting a candidate.** `POST /admin/experiments/{experimentId}/promote` (the `activate-profiles` capability) copies the measured candidate into the live assistant as a new version and activates it, only when the live active version is still the experiment's control and the copy hashes to the candidate's `configId`, both checked before anything is written (`promoteCandidate` in `profile-lifecycle.ts`). The new version records `promotedFrom` (the candidate, its version and the experiment), so the live history holds only versions that served or were promoted. The listing (`GET /admin/profiles`) returns `derivedFrom` and `promotedFrom` on each version; the Assistants tab shows them in an Origin column and offers a candidate no activation. Between instances, export and import stays the path, landing as a draft.

**Outside the router.** The queue triage (`triage-on-arrival.ts`), the private-address notice (`private-command.ts`), the archive notice (`conversation-management.ts`) and the `/battle` rate limit (`channel-flow-processor.ts`) resolve the speaking bot's assistant from the live assignment records through `turnAssistantProfileForBot` and apply the same declines.

**Verified by:** `backend/test/a-turn-runs-on-its-assistants-profile.test.ts` (a turn to `ops-premium` is keyword-classified and metered at 120 while `advisor` keeps its own; the welcome and the later answer both resolve the assistant's intake; a second assistant with no intake of its own asks nothing; an alt runs on the primary; an unknown assistant, unreadable records in `premium` and a non-primary bot with no record are declined, while unreadable records in a single-assistant classification still answer).

---

## 3. How context is managed

What a turn sees comes from six places. [`GUIDE-ASSISTANT-CONTEXT.md`](GUIDE-ASSISTANT-CONTEXT.md) covers context design and trust in depth; this section is the configuration reference.

### 3.1 Company context documents and scoping

| Aspect | As built |
|---|---|
| Bucket | The attachments bucket, passed to the processor as `CONTEXT_BUCKET` |
| Layout | `context/<classification>/*.json` for documents; `context/<classification>/_digest.json` for the digest (files beginning `_` are not loaded as documents); `platform-knowledge/<classification>/` for platform documents (`load_platform_info`): `basic/` holds a public overview, `standard/` the full documentation index |
| How a document gets its classification | Its key prefix only. There are no object tags. `classificationFromKey` in `company-context.ts` labels a document with the declared classification its prefix names (`context/<c>/` or `platform-knowledge/<c>/`), and a document under a prefix no declared classification names is not loaded |
| Scope | The prefixes a profile may read are `ProfileRegistry.contextPrefixesGranted`, derived from the classification's declared `grantsFor`, narrowed for a role by `roleContext` (`contextPrefixesForRole`). The stack grants `s3:GetObject` on exactly those prefixes plus `platform-knowledge/<c>/*` for each classification `c` in `grantsFor` (`platformGrantedPrefixes`, not narrowed by role); `contextScope` is a seed-only boundary |
| Loading | `loadCompanyContext` (the `load_company_context` tool) walks each allowed prefix in the reverse of the grant set's declaration order (`contextPrefixesForRole` with `reversed`, so a role's `roleContext` narrows the walk), which on the shipped prefix-shaped config puts the serving classification's own documents first, capped at `MAX_DOC_CHARS` (8000) per document and `MAX_TOTAL_CHARS` (24000) in total, cached for 5 minutes (`COMPANY_CONTEXT_CACHE_TTL_MS`); a denied prefix is skipped. The model may name specific documents to load |
| Adding or changing documents | Put objects under `context/<classification>/` in the attachments bucket. The reference path is `uploadContextFiles` in `backend/scripts/seed-demo.ts`, which copies `backend/demo/context/**` and builds each `_digest.json`. There is no admin-console upload and no CDK asset for documents |

**Vector retrieval.** In Aurora mode, objects under `rag/<sourceType>/<classification>/` in the archive bucket are chunked and embedded by `backend/lambda/src/analytics-aurora/document-ingestion.ts`, and the processor retrieves them through the data-plane `retrieve` op (`document-retrieval.ts`), running as a per-classification database role. `uploadCompanyRag` in `seed-demo.ts` copies the same demo documents to `rag/company/<classification>/`.

**Untagged content.** When ingestion cannot establish a document's classification, it uses `RAG_DEFAULT_CLASSIFICATION` if that names a declared classification, and otherwise `ProfileRegistry.failClosedContentValue`: the conversational classification the FEWEST holders reach (`premium` in the shipped config, reached only by `premium` and `admin` holders). The same value stamps a conversation summary whose channel tag could not be read and the NULL-classification bootstrap in `classification-boundary-sql.ts`. It excludes admin-plane classifications on purpose: content stamped on the admin plane would be read by no user conversation at any classification, silently.

### 3.2 Channel history

`loadChannelHistory` in `async-processor-core.ts` lists up to 20 channel messages, stops at the current turn's own message, and keeps the last `MAX_HISTORY_PAIRS` (5) user/assistant pairs. The bound is a code constant with no environment override. Earlier conversation beyond the window reaches the model through the conversation summary hint and retrieval, not through history.

### 3.3 Context sources (the catalog)

A context source is a named, typed read the deployment publishes and a profile selects by key.

| Aspect | As built |
|---|---|
| Definition | `ContextSourceEntry` in `backend/lib/config/context-sources.ts`, loaded by `loadContextSourceCatalog` from the deployer's gitignored `context-sources.local.ts`, else `context-sources.example.ts` |
| Keys | Reserved keys `user-profile`, `company-docs`, `conversation`, `open-work`; every other key must start with `x-` |
| Reader kinds | `s3-prefix`, `dynamodb-table`, `lambda-service`, `ssm-parameter` (`createSourceReader` in `context-source-readers.ts`) |
| Entry fields | `trust` (`platform`, `operator`, `member`), `availability` (`always`, `identity-settled`, `conversation-settled`), `maxBytes`, `fields[].from`, and `describesPerson`, false for a source that holds no fact about a person (absent means it describes one, ADR-060 decision 7) |
| As variable sources | Each field is the variable source `ctx:<key>.<field>`, with the entry's trust (`buildSourceTable` in `variables.ts`, ADR-060 slice 1a), so a new entry is a new source with no code change |
| Publication | SSM `${SSM_ROOT}/assistant/<classification>/context-sources`, ARNs stripped; each entry's IAM grant is emitted beside it (`contextSourceGrant`), scoped to its exact resource |
| Selection | The active version's `contextSources`, in list order, which is prompt order |
| Resolution | `resolveContextSources` in `context-sources-runtime.ts`, 1500 ms deadline (`DEFAULT_DEADLINE_MS`); rendered as an `## AVAILABLE CONTEXT` menu plus one `<context source=... trust=...>` section per source |
| Outcomes | CloudWatch namespace `AgentEchelon/ContextSources`: `ContextSourceResolved`, `ContextSourceFailed` (`denied`, `absent`, `timeout`, `error`), `ContextSourceSkipped` (`not-in-catalog`, `unavailable`, `no-record`), `ContextSourceFieldFailed`; dimensions `Classification`, `Outcome`, `SourceKey` (`context-source-outcomes.ts`) |
| Alarm | A per-classification failure-rate alarm routed to the one alarm notifier, `backend/lambda/src/alarm-to-admin-channel.ts`, which posts to the admin notification channel with a link to the classification's dashboard; deployed only when that channel is enabled |

A catalog change is a deploy of that classification's stack; a selection change is a profile version.

**Role-scoped sources.** A source that only ONE ROLE should reach does not take this path. `contextSourceGrant` attaches to the classification's shared `processorRole`, which every assistant of that classification answers through, so a grant emitted there gives the reach to all of them. A role-scoped source belongs in that role's contribution to the classification boundary, conditioned on `aws:PrincipalTag/role`, which the assistant session already carries. See [`DESIGN-ADDING-AN-ASSISTANT-ROLE.md`](../../specs/interaction/assistants/DESIGN-ADDING-AN-ASSISTANT-ROLE.md) section 4, and note that a per-role condition is safe on an `Allow` and unsafe on a `Deny`: the trust policy does not require the role tag, so an untagged session fails an `Allow` closed and passes a `Deny` untouched.

### 3.4 The channel-context store

Per-conversation facts the assistant relies on live in DynamoDB `ChannelContextTable`, keyed by `channelArn` (`conversations-stack.ts`), accessed through `CHANNEL_CONTEXT_TABLE` by `channel-context-client.ts`. A field not in `OWNED_FIELDS` is discarded on write.

| Field | What it holds | Written by | Read by |
|---|---|---|---|
| `participantProfile`, `domainContext`, `otherContexts` | Host grounding supplied at creation | `create-conversation-at-classification.ts` (a context request), `membershipHandler` in `conversation-management.ts` | `assembleHostGrounding` (`host-grounding.ts`), the host context resolvers |
| `userName` | The person's display name | A host's context create and add | Grounding, onboarding completion text |
| `userLanguage`, `segment` (`{ country }`) | Model-routing signals (a `CN` segment selects the CN model under context routing) | A host's context create and add | Processor routing |
| `participants` | The participant shape: `focus` (`single`, `group` or `none`), `humans`, `subject` | `backend/lambda/src/create-conversation.ts`, `backend/lambda/src/lib/channel-creation.ts` | Router (`resolveParticipants`, onboarding gate) |
| `memberIdentities` | `{ sub, iss, role }` per member | A host's context create, `recordMemberIdentity` | `channel-creation.ts` (carried into spawned conversations) |
| `priorSubject`, `priorMessage`, `parentRef` | Drift carry-over into a spawned conversation | `channel-creation.ts` | Welcome composer, router |
| `onboardingIntake` | Intake progress: `cursor`, `collected`, `phase`, `subject` (section 4) | Router (`putChannelContext`, `advanceOnboardingIntake`) | Router |

**Not in Metadata.** The Amazon Chime SDK stores Name and Metadata together, and a principal holding `chime:UpdateChannel` on its channel rewrites both in one call, so Metadata is not a trusted source for grounding, routing or onboarding state. Metadata is also size-bounded and is not readable at the moment the welcome fires. The classification boundary itself is the immutable channel **tag**, never Metadata. Existing channels whose facts sit in Metadata are promoted by the operator script `backend/scripts/backfill-channel-context.ts` (`planLegacyPromotion`); there is no read-time fallback.

### 3.5 Persona resolution

The processor composes the system prompt per turn, persona first. The base persona is the first of:

1. the **active version's** `persona` (S3 via `personaRef`), the versioned, exportable path;
2. the **per-deployment** persona (`resolveBaseSystemPrompt`): SSM `ASSISTANT_SYSTEM_PROMPT_PARAM`, else the `ASSISTANT_SYSTEM_PROMPT` env, cached per container. Applied only when the turn's assistant is the classification's primary (`deploymentCopyAppliesTo` in `backend/lambda/src/lib/deployment-copy-scope.ts`), because the parameter is keyed by classification;
3. the **built-in** persona (`defaultPersonaFor` in `assistant-async-processor.ts`): the `defaultPersona` the profile serving the classification declares (the sample's are in `backend/lib/config/sample-personas.ts`), else a generic persona. It is also what a second role with no persona of its own gets.

Only stacks whose topology sets `systemPromptParam` (`standard` in the shipped topology) have the per-deployment parameter. Because the active version wins, **a persona written only to `assistant-system-prompt` does not reach a profile whose active version carries a persona.** Applying a new per-deployment persona means re-seeding the definition with it folded in (`seedActiveProfileDefinition(ssm, ssmRoot, profileName, persona, ...)` in `backend/lambda/src/lib/seed-profile-definitions.ts`, which `backend/scripts/seed-demo.ts` runs through `seedAllProfileDefinitions` and which moves the `active` label), or editing the persona in a new version.

After the persona the processor appends, in order: host context sections (`buildSystemPrompt` with `createHostContextRegistry`: domain grounding, then participant profile), the first-turn greeting directive, identity and transcript conventions, the context-source menu and sections, task prompt and task context, open-work and referent hints, the retrieval hint, the conversation summary hint, and the battle addendum when bound; the company-context digest hint is appended inside the model call. The per-turn walk of these steps is in [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md). Every turn's analytics carries a `configId` and prompt hashes (`lib/config-identity.ts`), never the text.

### 3.6 Welcome orientation

On `WelcomeIntent` (the assistant was added to the conversation, never a real user turn) the router runs the assistant's **welcome**: the version's workflow on `assistant-joined`, selected by the room's conversation type (the one whose `types` name it, else the one that names no type, else the platform's `welcome`). Its opening is a template step, `opening`, which the router composes with `composeWelcome` in `welcome-orientation.ts`. It is additive: each field present adds a line, and a conversation with none of them gets the generic welcome.

The deployment fields come from the first of:

1. the **opening step of the welcome the room's type selects**, on the active version: its own orientation fields, and its `text`, which renders instead of the clause assembly (`renderWelcomeTemplate`): it may name the conversation fields `{{topic}}`, `{{eventSummary}}`, `{{priorSubject}}`, `{{priorMessage}}`, `{{visitSummary}}` and `{{parentRef}}`, the assistant's `{{role}}`, `{{examples}}`, the suggested prompts as a list, and any variable the version names in `variables` (ADR-060), which inserts its fallback when the welcome does not hold its value and never inserts a fact about a person, because the room reads the opening. Each field is a declared variable source (`WELCOME_FIELDS`) read through the variable resolver, and an opening saved with `{topic}` reads as `{{topic}}`; a line naming a field the conversation does not carry is left out, and a text whose every line is left out falls back to the assembly. The router selects with `welcomeWorkflowOf` and `selectOpening` and composes with `composeOpening`, and the console's Welcome area (Workflows, on an assistant's page and in the creation wizard) previews with the same functions, so the preview for a sample conversation (a topic, an event, a continuation) is the opening the router posts, the built-in assembly included. The editor edits, per kind of conversation (chosen from a selector above Opening text, where a type can also be added), that welcome's opening text and suggested prompts, says which one applies, and inserts the fields. A preview of a welcome whose opening sets nothing of its own names the classification's parameter the primary uses instead. The fields pass through the same parser as the parameter, so a version cannot set a conversation field;
2. the **per-deployment** parameter, applied only when the assistant is the classification's primary (`deploymentCopyAppliesTo`); a second role whose welcome's opening says nothing of its own gets the generic welcome.

| Field | Source | Trust |
|---|---|---|
| `companyName`, `companyBlurb`, `accessBlurb`, `examples` (2 to 4), `platformNote` (`DEPLOYMENT_FIELDS`) | The welcome's opening step, else SSM `${SSM_ROOT}/assistant/<classification>/welcome-orientation` via `ASSISTANT_WELCOME_PARAM` | Operator (a version is edited by whoever holds `manage-profiles`) |
| `topic`, `priorSubject`, `parentRef`, `priorMessage`, `eventSummary`, `visitSummary` (`CONVERSATION_FIELDS`), each the variable source `conversation:<field>` | The conversation; never settable from the parameter or a version | Member |

**The welcome is a workflow.** It is declared in `eventWorkflows` on `assistant-joined`, and its opening is one of three shapes: a template step alone (the opening above, with no model call), the template step and then a prompt step (one model turn of the joining assistant after the opening), or steps that greet and then continue. A version declares at most one welcome that names no `types`, and no type in two welcomes; a per-conversation-type welcome is one whose `types` name the type. For example, an opening for every room and a prompt turn after it, and its own opening in `alert` rooms:

```json
{ "eventWorkflows": {
  "welcome": { "on": "assistant-joined", "initial": "opening", "states": {
    "opening": { "opening": { "companyName": "Acme", "examples": ["What broke last night?"] }, "onSuccess": "greet", "onFailure": "greet" },
    "greet": { "prompt": { "template": "welcome-greeting", "tools": ["load_company_context"] }, "onSuccess": "done", "onFailure": "done" },
    "done": { "disposition": "success" } } },
  "welcome-alert": { "on": "assistant-joined", "types": ["alert"], "initial": "opening", "states": {
    "opening": { "opening": { "text": "An alert opened this conversation.\n{{eventSummary}}" }, "onSuccess": "done", "onFailure": "done" },
    "done": { "disposition": "success" } } } } }
```

| Aspect | As built |
|---|---|
| The opening step | `{ "opening": { ... } }` carries `text` (the opening text) and the deployment fields above. `{}` says the deployment's orientation for the classification's primary and the generic welcome for any other assistant, which is the platform's `welcome`. An opening and a prompt step run on `assistant-joined` only, and a welcome has one opening |
| The prompt step | `{ "prompt": { "template": ..., "tools": [...] } }` names a template of kind `prompt`: one the assistant holds, then one its classification holds, then the shipped `welcome-greeting` (`loadNamedPromptTemplate`). Its declared fields `topic`, `event`, `people` and `role` are filled from the conversation and passed to the model as delimited data after the instructions. Write one in the console's Message templates editor (ADR-062). Nothing follows it in its workflow |
| What the turn can read | The assistant's system prompt with its context sources, the company document tool, and only the tools named, each a registered tool that changes no state |
| Validation | Validate and activate refuse two welcomes for one kind of room, an opening or a prompt step on another event, a step after a prompt step, an unknown or state-changing tool, and a template no family holds (`versionEventWorkflowsErrors`, `eventWorkflowTemplateErrors`) |
| When it posts nothing | Past 11 seconds (`WELCOME_PROMPT_DEADLINE_MS`), on a model error, a guardrail intervention, an empty reply, or a refused global budget (checked by the turn, after the opening), the opening stands alone. An opening said by the reply waits on nothing it did not wait on before, and a prompt turn's opening waits only on the asynchronous dispatch. Each fallback is logged and counted as `welcome_prompt_fallback` by `Reason` in `AgentEchelon/Welcome` |
| Where the prompt turn applies | The conversation's plain welcome. A drift-spawned welcome and one that starts an intake already ask or answer something, so neither dispatches the turn |
| Console | Assistants → the assistant → Edit (or Draft) → Workflows → Welcome (and the creation wizard's Workflows step, which is the same section) edits, per kind of conversation, the welcome's opening text and suggested prompts and its prompt turn (a prompt template, previewed, and read tools only), written into `eventWorkflows` |

**A welcome that greets and then continues** runs its steps instead of answering the intent with the opening: the router posts its opening step as the assistant, then each step after it. The platform's `opening-and-subject`, which a version copies, posts its own opening, greets the person the conversation was opened for privately, and then offers them the onboarding intake when the assistant has one and they are not onboarded. Such a welcome owns the intake: the join starts none of its own, so the intake is offered only where the workflow has a `start_intake` step. A drift-spawned conversation keeps the opening said by the reply, composed from the welcome's opening step, which answers the question it was spawned for.

**A room an event opens** runs the `conversation-opened` workflow whose `types` name its type, such as `ops` (the platform's `ops-room`, which a version copies). In that room the join posts nothing, and the room is greeted once the event has added its people: the opening mentions the lead, the lead is welcomed privately, and the ops assistant opens an `incident_first_look` task in the room and posts a first look at the deployment's health from the `ops-first-look` prompt, or `ops-first-look-unavailable` when the turn is late, fails, is blocked or is over budget. Once the first look is posted the task rests on `findings_shared`, where anyone in the room may ask for another read or say it is resolved. Each step's words are message templates an assistant replaces with its own in the Message templates editor.

**A version stored before the welcome became a workflow** carries a `welcome` object (orientation fields, a `template`, a `mode` and `byConversationType` variants). Nothing reads it, and a draft, validate, activate, an experiment's variant, an import and a rollback refuse it. Run `cd backend && npm run migrate-legacy-welcome -- --dry-run` to see what each assistant's welcome becomes, then without `--dry-run` to write it: for each assistant whose active version carries one, a new version through the profile API, its welcome carried into welcome workflows that greet word for word as it did (`--assistant <name>` for one). An assistant with a draft in progress is skipped and named. What a welcome said that a workflow cannot say is reported: orientation fields beside a workflow welcome, which opened only a drift-spawned room.

**In the console**, a version's event workflows are edited in place under Workflows: Assistants → the assistant → Edit (or Draft) → Workflows → Event workflows. The assistant's own workflows are listed with the platform's, which are hidden until Show platform workflows and are copied into the draft with Copy to the assistant. Its help says what an event workflow is, that the welcome is one of them, and that task machines are separate: they are declared in the classification's intent pack and selected under Workflows (2.8, 2.9).

The card opens the **workflow builder** (`WorkflowBuilder.tsx`): pick a workflow, then work on its flow. The event that starts the run sits above the first step; each step is a box joined to the step its run takes next, Then when it succeeds, If it fails (red) and, on a task step, If the deadline passes (amber), with a dashed line for an edge that depends on a condition.

- **Add** a step from the palette, grouped Say (template message, opening, prompt, welcome prompt turn), Do (start a task, intake question) and Finish (end): it goes after the selected step, on that step's path, or where it is dropped. Opening and the welcome prompt turn are offered on `assistant-joined` alone. The palette's Decide group explains where a decision is made rather than adding a step the runtime does not run: a condition is a step's Run this step only when or an edge's Depends on a condition, and a deadline is a task step's If the deadline passes or a workflow on `invitation-unredeemed`.
- **Edit** a step by selecting it: its settings are the list editor's own controls. **Connect** an edge with a port under the selected step (Then, If it fails, If the deadline passes), then the step it goes to. Start the run here and Remove step are under its settings; with no step selected, the settings are the workflow's (its event, types, deadline, and Remove this workflow).
- **Place** a step by dragging it, or by Tab to it and the arrow keys (Shift moves further); Enter selects it and Escape cancels a connection. Where steps sit is saved with the draft as its **layout**, a body of its own under `profiles/{name}/{configId}/layout/{contentId}` beside the persona, never in the definition parameter and never hashed into `configId`. Activation keeps it, a rollback restores the rolled-to version's, a new version starts from the active one's, and export and import carry it beside the body. A step with no saved point is placed automatically. Nothing a version does reads it.
- **Check**: the status line is the server's own rules (`versionEventWorkflowsErrors`), run as you edit, and each error naming a step is shown on it and in its settings, as are the errors of the draft's last Validate. Validate and Activate stay on the draft's banner, where they check the saved draft.
- **Preview run** walks the workflow as it stands on the server (`POST /admin/profiles/preview-run`, a `view-profiles` route) through the runtime's own runner, with sample people, a sample value for each source its conditions read, and how each assistant or task step ends. It lists each step's outcome and what it would say or start, and sends nothing and writes nothing.
- **Edit as a list** shows the same workflow as the step-by-step form, the same controls in order.

A version declares its own as `eventWorkflows`, by name, each with `on` (`assistant-joined`, `conversation-opened`, `person-joined`, `invitation-sent`, `invitation-unredeemed` or `alarm-state-changed`), `types` (required on `conversation-opened`), `deadline` (required on `invitation-unredeemed`), `initial` and `states`: on `assistant-joined` an `opening` or a `prompt` step (above), a `send` (`to`, `template`, optional `mention`), an `agent` step (`prompt`, `tools`, `to`, `deadlineMs`, `fallback.send`, optional `propose`, `reads` and `workflow`), an action step (`{ "action": { "tool": "start_intake", "to": ... } }`), or a terminal `disposition`, each with `onSuccess` and `onFailure`. `"reads": "messages"` gives an agent step the room's recent messages, read as a turn reads them with every targeted message left out; where no person has spoken yet it calls no model and records `skipped`. A step whose draft reaches a person outside the room, and a step at an invitation's events, may not read them. `"workflow": "incident_first_look"` opens that task in the room before the turn (the one machine an event step may open, `EVENT_TASK_MACHINES`), the turn runs its first step, and the task moves on once the turn posted; the version's `workflows` selection must include the machine. An action step offers the onboarding intake to the one person its event names: `subject` at `assistant-joined`, `joined` or `{ "people": "event:person" }` at `person-joined`, and `{ "people": "event:person" }` at `conversation-opened`. The router offers it only where that person is not onboarded, records it only where no other person's intake is in progress in the room, and addresses the question to them. `"as": { "role": "ops" }` hands that one agent step to the room's assistant of the classification holding the role, which takes it as itself with its own tools and grants, while the run stays the primary's; the step's `tools` are then that assistant's, so the primary's tools need not include them. The platform's `ops-room` first look and `incident-watch` re-read do this, because reading the deployment's health is the ops assistant's grant alone. Where no assistant holding the role is in the room the step runs no turn and calls no tool: it posts `fallback.absent` (`{ "to": "room", "template": ... }`, the platform's says no ops assistant is in the room) and takes its failure edge. Validation warns, and does not refuse, when the deployment declares no assistant with that role. An intent pack may not declare `eventWorkflows`: a workflow is an assistant version's. Edit them in the draft's workflow editor or with a draft patch; they are hashed into the version's `configId`, travel with an export, and are validated again on import. A version may hold at most 8, each of at most 16 steps.

**A task step assigns work and waits for it** (ADR-063): `{ "task": { "machine", "for", "by", "visibility", "priority", "deadline": { "afterMinutes" } }, "onSuccess", "onFailure", "onDeadline" }`. `machine` is one the classification's runtime runs: a reference machine (`approval`, whose `deciding` step offers `approved` and `declined`; `acknowledgement`, whose `asked` step offers `acknowledged`; and the other shipped examples) or one the classification's intent pack declares, never one of the turn queue's own, and the version's `workflows` selection must include it. `for` is the person the task is for, its requester and owner: `subject`, `joined`, `{ "people": "event:person" }`, `{ "people": "invitation:inviter" }` or `{ "participantRole": "<name>" }`, required when the machine has a step that awaits the requester. `by` is who does the work: one of those people, or `{ "assistantRole": "<role>" }`; absent, the run's own assistant. A participant role named in either must be one every declared type gives one holder. The machine's own `awaits` decides who holds each step: `{ "party": "requester" }` the person it is for, `{ "party": "worker" }` whoever does the work, and nothing the assistant. `priority` (`high`, `normal`, `low`) orders the work an idle assistant takes up. `deadline.afterMinutes` (5 to 43200) is required: when it passes, the task is cancelled and the run takes `onDeadline`, else `onFailure`. The run waits at the step and continues when the task ends: `onSuccess` for a terminal state of kind `success`, whose edges may branch on `task:state` (`[{ "to": "pay", "when": { "task:state": "approved" } }, { "to": "tell-declined" }]`); `onFailure` for any other ending. A person who holds the first step is told privately in the assistant's `workflow-task-assigned` template, with a card offering the step's `choices`, and emailed as a `task` notice they can mute; they answer on the card or by writing in the conversation. An assistant that does the work takes it up when it is idle in the room, in priority order, unless the task's step awaits someone else, rests (`rests: true`, as `incident_first_look.findings_shared` declares) or runs a declared action; where the turn queue is off it runs only the task's first step, and validation warns.

```json
{ "eventWorkflows": { "ops-mine": { "on": "conversation-opened", "types": ["ops"], "initial": "opening", "states": {
  "opening": { "send": { "to": "room", "template": "ops-room-opening" }, "onSuccess": "look", "onFailure": "look" },
  "look": { "agent": { "prompt": "ops-first-look", "as": { "role": "ops" }, "tools": ["read_deployment_health"], "to": "room", "deadlineMs": 20000,
    "fallback": { "send": { "to": "room", "template": "ops-first-look-unavailable" }, "absent": { "to": "room", "template": "ops-assistant-absent" } } },
    "onSuccess": "done", "onFailure": "done" },
  "done": { "disposition": "success" } } } } }
```

**A workflow on `person-joined`** runs whenever a person is added to a conversation the assistant is primary in: by a share, by a host's add-member, or by the creator of an event-opened room, once the membership exists. No welcome names it; a version declares at most one, and it runs in the `types` it declares, or in every type. Its first step is a send, usually to `joined`, the person who was added, and a `mention:` may bind `event:person` to their display name. Where it runs, the person receives no separate welcome notice: the workflow's send addressed to them is their welcome, and it carries their email as a `conversation-shared` notice. **`person-joined` always catches the person up.** A version's workflow that has no recap step of its own gets the platform's join recap before each terminal step (step names starting `join-recap--`, which a version's own steps may not take), so its sends still come first; a version that declares none runs the platform's `join-recap`, one agent step that reads the room's recent messages and catches the person up privately, or says `join-recap-unavailable` when the turn cannot. Where a version declares none, the paths that added the person still send the welcome notice, and a share asks for a recap of its own only where naming the event to the router failed. Each person is a run of their own, so adding two people runs it twice and a repeated add runs nothing.

**In a room an event opens,** a `person-joined` workflow declared for the room's type welcomes every person the room was opened for, its lead included, unless the welcome is a `conversation-opened` workflow, whose run welcomes the lead. The room still gets its opening, but the join greets no one privately and starts no onboarding intake, so each person is welcomed once (ADR-061 decision 5). The `person-joined` workflow offers the intake to the person who joined where it has a `start_intake` step addressed `joined`; otherwise the intake is offered in that person's next conversation.

**A workflow on `invitation-sent`** runs when a member invites somebody into a conversation the assistant is primary in. No welcome names it, and a version declares at most one. The invitee has not arrived, so it may begin with an agent step; it may send to the room, to the invitee (`event:person`, read once they redeem), or to the member who sent the invitation (`{ "people": "invitation:inviter" }`), and a `mention:` may bind `invitation:inviter`. A template field may bind `invitation:reason`, the line the inviter gave, which only a message addressed to a person says. Its sends email nobody: the invitation email, which carries the link, is always the invitations function's own. An agent step addressed to the invitee is refused: they read nothing in the conversation until they redeem the invitation. Where the conversation's type declares a participant role `invitable`, the invitation may record it, and a condition reads it as `invitation:role` or as the invitee's `participant:role`.

**A workflow on `invitation-unredeemed`** runs once, at a deadline, for an invitation still unredeemed then. It declares `"deadline": { "afterMinutes": 4320 }` (5 minutes to 30 days after the invitation was sent); the router schedules it when the invitation is sent, brings it forward to before the invitation expires, and runs nothing if by then the invitation was redeemed, revoked or expired, the conversation archived, or the inviter or invitee left it. It carries the same people and values as `invitation-sent`, its sends email nobody, and a version declares at most one. Copy the platform's `chase-unredeemed` to start: an agent step drafts a short reminder (`invitation-nudge-draft`) and proposes it to the inviter.

**An agent step may propose** one consequential act, `"propose": ["send_nudge"]` or `"propose": ["open_conversation"]` with `"opens": "<type>"`. Its reply becomes the proposal's draft and nothing runs: the person the step addresses (one person, or a participant role every declared type gives one holder) sees a confirmation card on a private message and confirms or declines it, once, within three days. `send_nudge` is proposed at `invitation-unredeemed` to the inviter, who types the invitee's email address on the card; the reminder carries a second link, either link opens the invitation until it is used or revoked, and the reminder is sent once per invitation, as an email the invitee may stop. Its draft is written from the invitation's names and reason alone, with no tools, and one carrying a link or an address posts the step's fallback instead. `open_conversation` asks the classification's typed creator to open the declared type for the person who confirms, who holds each participant role the type sources from `{ "creator": true }`. The card's words are the templates `invitation-nudge-proposal` and `open-conversation-proposal`.

**A participant role** is a function a person holds in one conversation, declared on its conversation type (`participants.participantRoles` in `backend/lib/config/conversation-types.ts`; the shipped `ops` type declares `lead`, the person the opening event names, and `responder`, every other member). A send may address `{ "participantRole": "lead" }`, which targets each holder who is a member now, and a `mention:` may bind `participantRole:lead`, which lists the holders by name. A condition may read `participant:role`, the roles of the person the event names, or `participantRole:<name>`. Declare `types` on the workflow so validation checks each role against those types; without them a role the conversation's type does not declare addresses nobody. An agent step may address and mention a role too. A send to people may carry `"fromRole": "template"`, saying each person the template their role confers (`confers.template`) and the step's own where none does, and an agent step written for one person may carry `"fromRole": "brief"`, drafting from the brief their role confers. A workflow with no `types` that names a role is accepted with a warning naming the types where it addresses nobody. A role may also be sourced from a declared membership group, which the membership reconcile keeps it equal to, and a role that `adds` puts its group's people in the room. `general` declares no participant roles: roles belong to typed conversations.

```json
{ "eventWorkflows": { "greet-joiner": { "on": "person-joined", "initial": "greet", "states": {
  "greet": { "send": { "to": "joined", "template": "workflow-subject-welcome", "mention": { "name": "event:person" } }, "onSuccess": "done", "onFailure": "done" },
  "done": { "disposition": "success" } } } } }
```

Validation refuses two workflows that would answer for one kind of room on `assistant-joined` or `conversation-opened`, two workflows on `person-joined`, `invitation-sent`, `invitation-unredeemed` or `alarm-state-changed`, a template that does not exist or is not of the kind its step needs, a state-changing tool, a cycle, an agent step with no deadline or fallback, a `conversation-opened` workflow whose `types` name a type no event opens, and an agent step whose tools are not among the version's `tools`. A run and each of its steps are claimed once, so a redelivered event greets nobody twice. A drift-spawned conversation keeps the opening said by the reply.

**A workflow on `alarm-state-changed`** runs in the ops room that watches a CloudWatch alarm, each time that alarm changes state. A room watches the alarm its opening event named: the platform `ae.ops` event carries it as `detail.alarmName`, which the `ops` opener maps to `watchesAlarm`, and `backend/scripts/send-ops-event.mjs --alarm <alarm name>` sets it; the newest room for an alarm watches it. The stack adds the rule `IncidentWatchAlarmChanges`, matching this deployment's alarm names only, where a type at the classification has an opener that maps `watchesAlarm`. Before anything runs the router checks that the watch record and the room both name the room, that the room is not archived, and that the state CloudWatch reports matches the event; one run is keyed by the alarm and the state's timestamp. The run is the room primary's version's own workflow on the event, so copy the platform's `incident-watch` into `eventWorkflows` to start: it tells the room the state the alarm entered (`incident-alarm-changed`, which may bind `event:alarmName` and `event:alarmState`) and then reads the deployment's health and the room's recent messages again (`ops-incident-recheck`) and says what changed. A condition may read `event:alarmState` (`ALARM`, `OK` or `INSUFFICIENT_DATA`).

A parameter that is unusable or missing deployment fields emits `welcome_orientation_unusable` or `welcome_orientation_incomplete` (`recordWelcomeConfigDefect`, namespace `AgentEchelon/Welcome`); a missing parameter is not a defect. When an onboarding intake starts, the intake's first question (or its offer) is added after the composed welcome in the same message, and the welcome is still shown (`startIntake`, passed `welcome.content` by `router-agent-handler.ts`; section 4).

### 3.7 Context checks

| Check | Where |
|---|---|
| Which version served the turn | The turn's `configId` in analytics; `'seed'` means no active version resolved |
| Catalog sources resolved | Processor log line `[context-sources] applied`, and the `AgentEchelon/ContextSources` metrics per `SourceKey` |
| Company documents reachable | Ask a question only a `context/<classification>/` document answers; a denied prefix is skipped silently, so an empty answer is the symptom |
| Scope boundary | `tests/e2e/classification-context.spec.ts` |
| Catalog selection | `tests/e2e/context-sources.spec.ts` and `tests/e2e/context-source-alarm.spec.ts` |
| Welcome | `tests/e2e/welcome.spec.ts` (the optional `welcome` phase of `backend/scripts/validate.mjs`) |

---

## 4. How onboarding is customized

Onboarding is an optional intake the router runs once per user, when an assistant joins that user's first qualifying conversation. The engine is `backend/lambda/src/lib/onboarding-intake.ts`; the flow is in `router-agent-handler.ts`.

### 4.1 Intake configuration

| Aspect | As built |
|---|---|
| Versioned intake | The `onboarding` field on the active version of the addressed assistant's profile (`intakeForAssistant`, passed the turn's assistant profile, 2.15), read first. Edited through a draft `patch` or an import (6.1) |
| Parameter | `${SSM_ROOT}/assistant/<classification>/onboarding-intake`, named to the handler by `ONBOARDING_INTAKE_PARAM` (every classification stack sets it and grants the read); used only when the active version carries no `onboarding` |
| Inline override | The `ONBOARDING_INTAKE` env var (JSON), read before the parameter |
| Writers | The deployer. No stack and no CDK context key writes it, so the parameter exists only where somebody wrote it |
| How to write it | `aws ssm put-parameter --name "${SSM_ROOT}/assistant/<classification>/onboarding-intake" --type String --overwrite --value '<the JSON below>'`, or run `writeOnboardingIntake` in `backend/scripts/seed-demo.ts`, which writes a `company` and `role` intake for `standard` (the same seed puts an `onboarding` block on the `analyst` version, which is read first, so the demo's standard primary asks that version's questions and not this parameter's). The stack already sets `ONBOARDING_INTAKE_PARAM` and grants the read, so no deploy is needed after writing it |
| Cache | `loadIntakeConfig` caches the result for 30 seconds per warm container (`INTAKE_CONFIG_TTL_MS`), including an absent, unusable or unreadable result. A new or changed intake reaches new conversations within that window, with no cold start |

### 4.2 The intake schema

```json
{
  "greeting": "Welcome! A couple of quick questions before we start.",
  "fields": [
    { "key": "team", "prompt": "Which team are you on?", "required": true },
    { "key": "domain", "prompt": "What is your work email domain?", "required": true,
      "pattern": "^[a-z0-9.-]+\\.[a-z]{2,}$", "example": "acme.com" },
    { "key": "role", "prompt": "What is your role?", "required": false, "assertedBy": ["classification"] }
  ],
  "completion": "Thanks, {name}, you're all set. How can I help?"
}
```

| Field | Type | Default | Behavior |
|---|---|---|---|
| `greeting` | string | "Welcome! I just need a few details before we begin." | The opening line only when no welcome is passed to `startIntake`. The router always passes the composed welcome, so a deployed intake opens with the welcome followed by the first question, and `greeting` is not shown |
| `fields` | `IntakeField[]`, ordered | required unless `offer` is set | No usable field and no usable `offer` disables onboarding |
| `fields[].key` | string | required (a field without one is dropped) | The key the answer is stored under |
| `fields[].prompt` | string | required (a field without one is dropped) | The question |
| `fields[].required` | boolean | `true` | An optional field accepts `skip`, `none`, `n/a`, `na` or `-` |
| `fields[].pattern` | regex source, case-insensitive | none | Checked on a required, non-skip answer; a mismatch re-asks with `example`; an invalid regex is ignored |
| `fields[].example` | string | none | The hint shown when `pattern` rejects |
| `fields[].assertedBy` | array of `'persona' \| 'classification' \| 'profile'` (`INTAKE_ASSERTIONS`) | none (always ask) | What already asserts the field, so it is not asked; unknown values are dropped |
| `fields[].preference` | a key of `REPLY_PREFERENCES` (`backend/lib/config/reply-preferences.ts`), such as `answerStyle` | none (a fact) | The field sets a reply preference instead of collecting a fact: the answer must choose one of the preference's declared values, anything else is re-asked with the choices, and the value key is stored under the person's `preferences`. A preference the person already chose is never asked. An undeclared key is dropped and the field collects an ordinary fact |
| `completion` | string with `{name}` | "Thanks, {name}, you're all set. How can I help?" | Sent after the summary is confirmed |
| `offer` | object: `ask`, `affirmative` (string[]), `negative` (string[]), `onAccept`, `onDecline`, optional `accessHas`, `accessNeeds` | none | One yes/no offer that replaces the field flow: `ask` is added after the welcome, a reply matching an `affirmative` or `negative` word (case-insensitive, whole message) sends `onAccept` (with `accessHas` or `accessNeeds` appended when the person's clearance resolves) or `onDecline`, and either answer completes onboarding. All of `ask`, `onAccept`, `onDecline` and at least one word in each list are required, or the offer is dropped |
| `bail` | string[] | none (the platform ships none) | Phrases, in the deployment's own words, that end the intake and route the message to the assistant; matched case-insensitively against the whole trimmed message. A message that reads as a question is released the same way without a `bail` entry |

After the last field the intake shows a summary and asks for confirmation (`classifyConfirmDeclineReply`): yes completes it, no restarts it, anything else re-asks.

**Cheap assertions.** `assertedBy` is a cheap check against what the turn already holds (`fieldIsAsserted`, `intakeAfterChecking`), never a tool call, so an intake never sits in front of a question somebody is waiting on. As wired in the router:

- `classification` asserts the field whenever the conversation's classification resolved, which is every welcome that runs at all: an unknown or unreadable tag refuses the turn before this point (ADR-045). Use it for facts the classification is the claim for, such as a role or access level.
- `persona` asserts the field when the **active profile version** carries a persona (`resolveActiveProfile().persona`, the same source the processor reads first), or when the handler's own `ASSISTANT_SYSTEM_PROMPT` env is set. It is resolved only when some field asserts by persona. A persona held only in the `assistant-system-prompt` parameter is not visible to the handler, which reads no persona parameter of its own, so a profile whose active version carries none asks the field. Folding the persona into the definition (3.5) is what makes the assertion match.
- `profile` asserts the field when the person's stored profile carries a non-empty value under the same key (`UserProfile.facts`, 4.4). It comes from the read the once-per-user gate already makes, so it costs nothing extra, and it applies only to a person who is not yet onboarded, which is the only case where an intake runs at all.

When every field is asserted, nothing is asked and the conversation opens with the ordinary welcome.

The fields left after this check are **the intake for that conversation**. Their keys are pinned on the stored row (`asked`), and every answer turn resolves the intake from that list (`intakeAsStarted`), so the cursor always indexes the questions the person was actually asked. Asserted fields may therefore sit anywhere in the schema. If the deployment's intake later loses a field that a conversation in progress was asked, that conversation's turns stop being read as answers rather than being filed against a different question; the person is offered the intake again on their next conversation.

### 4.3 Trigger

On `WelcomeIntent`, where the welcome is said by the reply (a welcome that runs offers the intake as its own `start_intake` step, 3.6), in order:

1. Load the intake and drop the fields the persona and the classification assert; nothing left means no intake.
2. `resolveParticipants` reads the conversation's `participants` shape (the stored row, else live membership).
3. `onboardingApplies` requires `focus === 'single'` with a subject: a group conversation, or one with no human yet, is never onboarded.
4. `onboardingStatus(subject)` reads the user profile store once, answering the gate and handing back the stored facts. **Once per user, not per conversation and not per classification**: a user who completed any intake is not asked again in a new conversation.
5. Drop the fields those stored facts assert. Nothing left means no intake, as in step 1.
6. `startIntake`, then `putChannelContext` records `onboardingIntake` with the subject and the keys being asked. The first question is sent only if that write succeeded; otherwise the ordinary welcome is sent and the next conversation offers the intake again.

`WelcomeIntent` means the assistant was added. A real user turn never starts an intake. The answers arrive as ordinary turns: the router intercepts a turn before classification when a stored intake exists, the sender is the stored `subject`, the phase is not `done`, and the turn is not machine-written or an amendment fold. Anyone else's message in the conversation is never taken as an answer.

**Fail-open.** `onboardingStatus` (and `hasOnboarded`, which wraps it) reports not-onboarded when the store cannot be read, so an unreachable store asks again rather than silently skipping. A positive answer is cached for 5 minutes (`ONBOARDED_CACHE_TTL_MS`); a negative one is not cached.

### 4.4 Answer storage

| Store | What | When |
|---|---|---|
| Channel-context `onboardingIntake` | `cursor`, `collected`, `phase`, `subject`, `asked` (the field keys this conversation is being asked, pinned at the start), advanced by `advanceOnboardingIntake` as a conditional update on the prior cursor, phase and subject | Every answer |
| User profile store (`user-profile-client.ts`) | `UserProfile { personId, onboardedAt, facts, updatedAt }`: `markOnboarded` sets `onboardedAt` once and writes `facts` from `collected` | When the summary is confirmed |

The built-in store is DynamoDB `UserProfileTable` (`conversations-stack.ts`, via `USER_PROFILE_TABLE`); setting `USER_PROFILE_SERVICE_ARN` delegates to an implementer's own Lambda instead. Stored facts reach later turns through the `user-profile` context source when a profile selects it (3.3).

### 4.5 Disabling, changing and testing

- **Disable:** remove `onboarding` from the active version (a draft `patch` setting `onboarding` to `null`, then activate), delete the `onboarding-intake` parameter, and leave `ONBOARDING_INTAKE` unset; or write an intake whose every field is asserted. A version carrying `onboarding` keeps the intake running whatever the parameter says. There is no on/off flag. Group conversations never run it.
- **Change:** activate a version with the new `onboarding`, or, for a profile whose active version carries none, write the new JSON to the parameter. Conversations opened more than 30 seconds later get the new intake; a conversation already part-way through an intake keeps the questions it was asked.
- **Re-test a user:** remove `onboardedAt` from that user's profile item, then wait out the 5-minute positive cache or use a new user.
- **Tests:** unit tests `backend/test/lib/onboarding-intake.test.ts`, `backend/test/lib/an-intake-asks-only-what-is-unknown.test.ts`, `backend/test/lib/an-intake-answer-lands-on-the-question-asked.test.ts`, `backend/test/lib/an-intake-is-advanced-only-by-its-subject.test.ts`, `backend/test/lib/user-profile-client.test.ts`; e2e `tests/e2e/onboarding-intake.spec.ts` (gated on `ONBOARDING_E2E=1`, the optional `onboarding` phase of `backend/scripts/validate.mjs`).

---

## 5. Adding a classification

Use case: a deployer wants a further conversational classification (say `enterprise`), served by a new profile (say `enterprise-advisor`) with its own model selection, retrieval scope, guardrail and Lex bot. The profile name must differ from every classification value: `validateProfilesConfig` refuses a profile named `enterprise` and synthesis fails.

**Adding a classification deploys one stack, `<prefix>Assistants-enterprise`, and nothing else.** That stack holds everything the classification adds: its processor, router, its acting roles and model grants, its clearance groups, its Battle and Experiments wiring where the deployment declares them, its row of the runtime registry (`${SSM_ROOT}/registry/classification/enterprise`), and the seed that asks the provisioner for its declared assistants (1.6). The assistants themselves, their identities and Amazon Lex bots, are the provisioner's (in `Messaging`), which that seed asks for on the first deploy; every bot runs as the provisioner's one Amazon Lex runtime role. Every other stack reads the set of classifications from those rows at runtime (`loadProfileRegistry`), and its grants name a tag, never a list, so no other stack changes ([ADR-057](../../design/decisions/057-assistant-stacks-come-from-the-registry.md), [STACKS](../../overview/STACKS.md#additivity)). The deploy matrix holds this: `C7-custom+research` adds a battle-capable classification beside a deployment with Battle and a guest issuer, and `backend/test/deploy-matrix/c7-custom-battle-plus-research.test.ts` fails on any change outside its stack, in either direction.

Two paths declare it. A deployment declares its own classifications with no code change through `profiles` in `deploy.config.json` (1.5); this is the path to use. The other path edits the shipped catalog in `backend/lib/config/profiles.ts`, for a change to the sample itself. Either way the steps below are the same, and only the file differs.

### 5.1 Config entries

Add the classification with the set it reaches, its profile, its models and the group that clears for it. The shipped rows are shown in full so the edit is unambiguous:

```ts
classifications: [
  { value: 'basic', profile: 'concierge', grants: ['basic'], displayName: 'Basic', models: { selected: ['haiku'], default: 'haiku' } },
  { value: 'standard', profile: 'analyst', grants: ['basic', 'standard'], battleCapable: true, produces: ['document'], displayName: 'Standard',
    models: { selected: ['haiku', 'sonnet', 'titan', 'gpt_oss_20b', 'deepseek_v3', 'deepseek_r1'], default: 'sonnet' } },
  { value: 'premium', profile: 'advisor', grants: ['basic', 'standard', 'premium'], battleCapable: true, roles: ['primary', 'ops'], roleContext: { ops: ['basic', 'standard'] }, produces: ['document'], displayName: 'Premium',
    models: { selected: ['haiku', 'sonnet', 'opus', 'titan', 'gpt_oss_20b', 'gpt_oss_120b', 'deepseek_v3', /* ...every image model */], default: 'opus' } },
  // Add. The shipped sample happens to nest its grant sets, so this one declares the three it should reach plus
  // itself; a classification that reaches only itself (say `legal`) declares `grants: ['legal']`.
  { value: 'enterprise', profile: 'enterprise-advisor', grants: ['basic', 'standard', 'premium', 'enterprise'], battleCapable: true, produces: ['document'], displayName: 'Enterprise',
    models: { selected: ['haiku', 'sonnet', 'opus'], default: 'opus' } },
],
profiles: [
  // ...concierge / analyst / advisor / ops-premium / admin-agent...
  { name: 'enterprise-advisor', displayName: 'Enterprise Advisor', modelKey: 'opus', classifierMode: 'llm', timeoutSeconds: 90,
    contextScope: 'granted', rateLimitPerHour: 480, attachmentsReadable: true },
],
groupClearance: { basic: 'basic', standard: 'standard', premium: 'premium', enterprise: 'enterprise', admins: 'admin' },
```

The admin plane needs no edit: it grants itself alone, and admin access reaches `enterprise` conversations through the console once its row is published. `battleCapable` and `produces` must agree with what the topology wires (5.3); whether it produces images is its model selection (5.2); turning battle on is a runtime setting rather than a deploy. Declaring a classification that fewer holders reach than `premium` (here only `enterprise` holders reach `enterprise`) moves `failClosedContentValue` to `enterprise`, so untagged content is stamped `enterprise` and is not retrievable in `basic`, `standard` or `premium` conversations; set `RAG_DEFAULT_CLASSIFICATION` if that is not intended.

### 5.2 Model selection

`models` is the classification's choice from the instance's catalog ([MODEL_STRATEGY](./MODEL_STRATEGY.md#three-layers)): `selected` lists the catalog keys it may use, and `default` is the Bedrock text model its assistant answers on. Its stack grants exactly the selection, and its profile versions may use nothing else. Selecting an image model wires image generation for it (the grant, the image guardrail, the provider keys and `produces: image`); selecting `deepseek_api` creates the external adapter's key secret in its stack, and is accepted only on a classification that routes by context and does not select `deepseek_v3`, the one shape in which a turn reaches it. The catalog names no classification, so nothing outside the entry changes. Synth refuses an empty selection, a key the catalog does not list, a repeated key, a default that is not a selected Bedrock text model, a profile `modelKey` the selection lacks, and a profile `modelKey` that is not a Bedrock text model. No context key overrides it.

### 5.3 Topology

There is no per-profile processor to copy and no stack file to write. Give the `enterprise` entry from 5.1 its `topology`; the profile name comes from the registry:

```ts
{
  value: 'enterprise', profile: 'enterprise-advisor', /* ...the fields from 5.1 */
  topology: {
    timeoutSeconds: 90, memorySize: 1024, reservedConcurrency: 20, maxTokens: 4096,
    streaming: true, contextRouting: false, systemPromptParam: true, intentPackParam: true,
    richProcessor: true, handlerExperimentsIndex: false,
  },
},
```

Every capability the profile does not want is a `false` flag, not deleted code: the shared body reads the flags, and the shared processor self-gates on the env each flag sets, so the profile's execution stays inside its own IAM role. Battle capability is not a topology flag; it is the classification's `battleCapable` from 5.1.

### 5.4 Stack wiring

Nothing to edit in `backend/bin/backend.ts`: it creates one `${STACK_PREFIX}Assistants-<classification>` stack for every classification that declares a `topology`, here `${STACK_PREFIX}Assistants-enterprise`. The channel flow, post-processing, the admin read plane and email find its router and task service through the runtime registry and the identifiers it publishes. `STACK_PREFIX = AE_STACK_PREFIX || pascal(AE_INSTANCE_NAME)`: `AgentEchelon` for the default instance, `Stratum` for `AE_INSTANCE_NAME=stratum`. `cdk deploy` with a stack name that matches nothing **exits 0 and deploys nothing**, so deploy one stack with `npm run deploy:stack -- <Stack>`, which checks the name against `cdk list`.

### 5.5 Synth test

In `backend/test/cdk-synth.test.ts`, mirror the existing per-classification block, building the stack through `assistantsOf` (`backend/test/helpers/assistants.ts`). The runtime identifiers are keyed by the classification value:

```ts
it('should synthesize AgentEchelonAssistants-enterprise (no Bedrock Agent)', () => {
  const stack = assistantsOf('enterprise')(new cdk.App(), 'AgentEchelonAssistants-enterprise', classificationBasicProps);
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::Bedrock::Agent', 0);
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/agent-echelon/assistant/enterprise/processor-arn' });
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/agent-echelon/assistant/enterprise/bot-arn' });
});
```

A classification declared only in `deploy.config.json` needs no test of its own: the deploy matrix synthesizes custom sets, and the classification-independence check covers adding and removing one.

### 5.6 Frontend gating

The chat client reads `custom:tier` from the ID token, and the deployment's classifications from `GET /classifications` once signed in (`clientClassifications` in `backend/lib/config/profiles.ts`, read from the runtime registry). Before sign-in, the registration screen offers the member classifications from the build's `VITE_CLASSIFICATIONS`, which `gen-frontend-env.mjs` writes from the same registry rows for the chat package alone. Each entry carries the classification's `displayName`, `audience`, `badgeToken`, `grants` and `models`, so a declared `enterprise` classification needs no client edit: the New conversation picker offers it to every holder whose classification grants it (`creatableClassifications` in `frontend/packages/shared/src/config/classifications.ts`), by its display name and in its badge color, and the conversation header and the sidebar name and color it the same way. Give it a `displayName` and, to choose its color, a `badgeToken` (`cls-1` to `cls-8`; absent, it takes the first token no classification declares). The card's description and access details are copy, `newConversation.class.<value>.*` in the locale; a classification with none shows the generic description. **This is an affordance, never the enforcement**: it decides which options a person is OFFERED, and `lib/channel-creation.ts` refuses a classification the caller does not clear for. A signed-in app renders a classification added later when it next loads, with no build; the registration screen offers it once `gen-frontend-env.mjs` and `npm run deploy-frontend` run (5.8).

The frontend model catalog `frontend/packages/shared/src/config/modelStrategy.ts` mirrors the backend's Bedrock text model list and names no classification. The admin console shows which classifications select each model, and the New conversation picker shows each classification's default, from `models` on each entry of `GET /classifications`. Nothing imports across the packages; `backend/test/lib/model-catalog-mirror.test.ts` fails when the two catalogs disagree. A new classification needs no catalog edit; a new Bedrock model is added to both.

### 5.7 Hand edits

None for the classification itself: a classification is configuration. Runtime code, the CDK app, the operator scripts and the frontends read which classifications exist from the registry (`ProfileRegistry`, and on the client `GET /classifications`), a classification value is a `string` checked against it (`isKnownClassification`, `isConversational`), and an undeclared value is refused where it arrives rather than mapped to a sample name. The router refuses the turn, company context does not load a document under an undeclared prefix (`classificationFromKey`), and a classification's default model is its own `models.default` (`ProfileRegistry.defaultModelOf`), so an undeclared one has none. `backend/test/no-code-names-a-sample-classification.test.ts` fails on a sample classification name written as a code literal outside the sample's own configuration, seed data and checks, and lists each exemption with its reason. `backend/test/a-deployment-of-other-names-runs-on-its-own-classifications.test.ts` runs those paths on a deployment that declares `internal`, `partner` and `customer`.

The copy a classification shows is the locale's, keyed by its value: the New conversation card (`newConversation.class.<value>.*`), the empty-state welcome (`newConversation.class.<value>.greeting`) and the sign-up option's model line (`auth.register.classModels.<value>`). A classification with none shows the generic text, or nothing.

One shape does not announce itself: a roster-naming test. An identity-pool group count, a registry ordering list, or a fail-closed default that names `premium` where the property is "the conversational classification the fewest holders reach" reports a correct tightening as a failure. Derive such expectations from `DEFAULT_PROFILES_CONFIG`. `tsc` does not typecheck `test/`, so a fixture that must be exhaustive over the declared set fails only when the suite runs.

### 5.8 Deploy and verify

```bash
# <prefix> is the instance name in PascalCase (AgentEchelon for the default instance);
# `npx cdk list` under the deploy context prints the exact stack names.
cd backend
npm run deploy:stack -- <prefix>Assistants-enterprise --diff-only   # look first
npm run deploy:stack -- <prefix>Assistants-enterprise
```

`deploy:stack` applies every key in the gitignored `backend/deploy.config.json`, checks the stack name against `cdk list` under that context, and refuses a rollback; a raw `cdk deploy` is refused by the repository's deploy guard. No other stack deploys. Handlers pick the new row up within the registry cache's five minutes. A signed-in app shows the classification the next time it loads `GET /classifications`; the chat registration screen, which renders before sign-in, offers it once its `VITE_CLASSIFICATIONS` fallback is regenerated from the rows and shipped: `node scripts/gen-frontend-env.mjs`, then `npm run deploy-frontend`. The frontend never ships through `cdk deploy`.

Confirm the row, the runtime identifiers and the seeded primary exist, create an enterprise-classification conversation, and confirm the processor's CloudWatch logs show its invocations:

```bash
aws ssm get-parameter --name /agent-echelon/registry/classification/enterprise --query Parameter.Value --output text
aws s3 cp s3://agent-echelon-registry-<account>-<region>/registry/classification/enterprise -
aws ssm get-parameter --name /agent-echelon/assistant/enterprise/processor-arn --query Parameter.Value --output text
aws ssm get-parameter --name /agent-echelon/assistant-directory/enterprise-advisor --query Parameter.Value --output text
```

The directory entry reads `"origin":"declared","status":"active"` once the seed has built the primary.

---

## 5c. Removing a classification

Removing a classification deletes one stack, `<prefix>Assistants-<classification>`, and changes no other. The deploy matrix holds the removal direction as well as the addition.

1. **Retire the assistants created in the console.** No stack owns an assistant ([ADR-048](../../design/decisions/048-an-assistant-is-not-a-classification.md)). The stack's seed has the provisioner remove the assistants it declared when the stack is deleted (1.6), and never one created in the console, which would be left with no classification to act in. The delete does not fail for one (a stack's delete must always be able to finish); the seed's log names any still active, and `npm run deploy` refuses the configuration of step 3 while one is. Retire each one at the classification first (Assistants, Retire on its row, or `POST /admin/roster/{assistantId}/retire`).
2. **Delete the stack**, while `deploy.config.json` still declares the classification: `aws cloudformation delete-stack --stack-name <prefix>Assistants-<classification>`, then `aws cloudformation wait stack-delete-complete --stack-name <prefix>Assistants-<classification>`. The seed never fails the delete: an assistant it could not remove is named in its log and its directory entry keeps what is left, for a retire or the teardown sweep to remove.
3. **Remove it from the configuration**: its entry in `profiles` (its classification, its profile and its `groupClearance` line), and every other name of it. Synth refuses an issuer's listed set, a conversation type's `linkClassifications` or any other field that names a classification the deployment no longer declares (`backend/lib/config/declared-classifications.ts`). No stack deploys for this edit.
4. **Regenerate the chat app's fallback** with `node scripts/gen-frontend-env.mjs`, then `npm run deploy-frontend`, so the registration screen stops offering it.

**What the stack delete removes:** its registry row and the row's S3 copy (handlers drop the classification within the registry cache's five minutes), its processor, router and task service, its acting roles and their model grants, its vend, its clearance groups (members lose that group, and their accounts stay), its Battle and Experiments grants, its runtime identifiers under `${SSM_ROOT}/assistant/<classification>/`, and the external adapter's key secret where it selected `deepseek_api` (keep a copy of the key first if it is needed again). Its seed's delete removes every assistant it declared, the alts included: each identity, Amazon Lex bot, assignment record and directory entry, so declaring the classification again seeds them afresh.

**What stays**, because it is data rather than the classification's compute:

| What | Where | Why it stays |
|---|---|---|
| Conversations tagged with the classification | Amazon Chime SDK channels with `classification=<classification>` | A channel is the record of a conversation. No assistant answers in it, and the router refuses a turn at a classification the registry does not declare |
| Company context | `context/<classification>/` in the attachments bucket | Content a deployment wrote; no role reads it once no classification grants the prefix |
| A console-created assistant's tombstone | Its directory entry, `retired` (step 1) | A retired name is never reused; analytics and profile history are keyed by it |
| Profile versions | `${SSM_ROOT}/assistant/<profile>/` | Written at runtime; analytics and profile history are keyed by the name |
| Archive rows | The conversations archive, partition `user_type=<classification>` | The archive is absolute; queries over past turns keep working, and the partition is registered once and needs no table change ([SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP](../../specs/interaction/conversation/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md) Appendix D) |
| Retained resources | The persona and intent pack parameters, the intent pack bodies under `classification-packs/<classification>/`, and in production the turn-routing table | Their removal policy is `RETAIN`, and nothing deletes a pack body; delete them by hand when the data is no longer wanted |

Declaring the classification again later deploys a fresh stack beside that data.

---

## 5b. Adding a role

A role is a second **job** inside a classification: another assistant, with its own identity, its own profile, and its own scope. The role is infrastructure (its reach, context, tags and IAM), declared and deployed. The assistant filling it is data: the deploy that declares the role seeds its declared assistant once (1.6), and further assistants in a deployed role are created in the console with no deploy. It is much smaller than adding a classification (no Cognito group, no credential-exchange role, no new stack, no frontend gating) and it is the thing to reach for when one classification needs an assistant that reaches something its sibling must not. The design is [`DESIGN-ADDING-AN-ASSISTANT-ROLE.md`](../../specs/interaction/assistants/DESIGN-ADDING-AN-ASSISTANT-ROLE.md); this is the procedure.

The shipped example is `ops` on `premium`: it reads the deployment's own CloudWatch metrics and alarm state, and the premium primary is denied the same reads.

1. **Declare the role** on the classification in `backend/lib/config/profiles.ts`: `roles: ['primary', 'ops']`. `primary` is implicit if omitted. In the shipped catalog this OFFERS the role, and a deployment deploys it by naming its assistant (step 6); in a custom set it declares the role. This creates no IAM role: the role name joins the classification's declared roles, and the acting role (`assistantActingRole`) accepts it as the `role` session tag: the trust policy pins `aws:RequestTag/role` to the classification's declared roles (`deployedRoles`, `assistant-profile-stack.ts`). Narrow its context with `roleContext` if it should read less than the classification grants.
2. **Declare its assistant** as a profile in the same file, named so it cannot be mistaken for a classification value (`ops-premium`, not `premium`; synthesis refuses the collision). Its model is its own, and so are its `classifierMode` and `rateLimitPerHour`: the router reads both from the profile of the assistant a turn is addressed to (2.15). Its processor timeout is the classification stack's topology.
3. **Scope the role.** Give the role its scope on the acting role (`assistantActingRole`, `roleContextStatements` and `observabilityRoles` in `agent-classification-common.ts`). Every statement carries `StringEquals` on `aws:PrincipalTag/role`, which the vend stamps on every session. If the reach is something the boundary denies for other roles, the boundary's Deny must exclude this role too, because a boundary caps and grants nothing.
4. **Write a tool.** Write a tool that uses the scope, and select it in the profile's `tools`. A grant with no tool is a reach the assistant cannot exercise. The tool takes the assistant's session credentials from `actingCredentials()`; see `read_deployment_health`.
5. **Seed its own copy.** A role gets an identity, a reach, a tool and a boundary from the steps above, and none of them give it anything to say. Persona, intent pack, workflow selection, welcome, onboarding intake and classifier model resolve from the assistant's own version first, and its lines from its own message templates, (the router finds the assistant from the bot the turn was addressed as, 2.15). The classification-keyed fallbacks for the persona, the welcome and the onboarding intake apply only to the classification's primary (`backend/lambda/src/lib/deployment-copy-scope.ts`), so a role carrying none of them gets the built-in persona, the generic welcome and no intake rather than the primary's words. Seed the role's own copy onto its VERSION: `seedAllProfileDefinitions` in `backend/lambda/src/lib/seed-profile-definitions.ts`, called from `backend/scripts/seed-demo.ts`, is the worked example, and seeds `ops-premium` a persona, intent pack, boundary and welcome but no onboarding intake. Do not write it into the classification parameter, which is one config for every assistant of that classification.
6. **Declare it in the deployment and deploy.** A role in a custom set is declared by step 1. A role the shipped catalog offers is declared by naming its assistant in `profiles` in `backend/deploy.config.json`, beside its classification: `"profiles": ["basic", "standard", "premium", "ops-premium"]` deploys the premium ops assistant. `npm run add-assistant-role` (`backend/scripts/add-assistant-role.mjs`) writes that one name and runs `npm run deploy:stack -- <prefix>Assistants-premium`; `--dry-run` prints the change and the command without doing either, and `--remove` takes the name back out and deploys again. The deploy's diff shows the role's reach (the acting role's trust and grants, the boundary) and the seed's declaration; the seed then asks the provisioner to build `ops-premium` when no directory entry names it. Once built it is the console's: renamed, owned and retired there like any assistant, and a retire sticks, so a later deploy does not recreate it and says so.

   **Removing the role withdraws the role, not its assistants.** A role and the assistants filling it are separate, so `--remove` is refused while any assistant, `ops-premium` or one created in the console, still fills the role: it reads the assistant directory before it writes anything and names them, and the deploy's provisioner refuses the same withdrawal. Retire each in the console first (Assistants, Retire on its row, with a reason), then run `--remove`. The withdrawal then releases the retired `ops-premium`'s tombstone, so adding the role again seeds a fresh `ops-premium` (a new identity and Amazon Lex bot, on the profile versions it already had).
7. **Verify by denial.** Prove the boundary by denial, not by reading the policy. `tests/e2e/an-assistant-boundary-refuses-cloudwatch.spec.ts` asserts the role-tagged session is allowed, the primary is denied, an untagged session is denied, and the boundary grants no write.

### Role traps

Each of these presents as something other than what it is, and each is latent for exactly as long as a classification hosts one assistant.

**Env is per function.** An environment variable is the right carrier for what a FUNCTION is and the wrong one for anything a TURN is. One runtime serves every role a classification declares, so any per-turn fact read from the env reports the primary's value. Which profile resolves the turn's behavior and which assistant analytics attributes the turn to come from the assistant the turn acts as: the routing record names the bot, the vend resolves the assistant and its role from the assignment records (`assistantForBot`, `assistant-vend.ts`), and the processor reads them from that session (`adoptTurnIdentity`, `assistant-async-processor.ts`), falling back to the function's own profile only when that assistant has no published profile. The router does the same from the assignment records (2.15). The deployment-time fields follow the same rule as the env: `requireProfileFor(classification)` answers the classification's primary, so it is the wrong lookup for any per-turn setting, and the router reads `classifierMode` and `rateLimitPerHour` from the assistant's profile instead. The assistant's name and the Lex alias it is wired to are fixed per role at deploy, because each role gets its own Lex bot (next item).

**Lex bot per assistant.** A shared Amazon Lex bot cannot say which assistant was addressed: a Lex turn carries `CHIME.channel.arn` and `CHIME.sender.arn` and nothing else. So every assistant gets its own Lex bot from the provisioner, and its assignment record names the Lex bot id. Without that the handler falls back to the primary, and because the Amazon Chime SDK authorizes a channel read on **membership**, the fallback identity is the one not in the room: the turn dies on a refused `DescribeChannel` and the room shows `{"Code":500}`, which reads as a model fault.

**Property, not code.** A custom resource re-runs on a PROPERTY change, never on a code change. The seed's one property is the declaration, so fixing the provisioner or the seed's handler and redeploying rebuilds nothing; an assistant that exists is the console's to change, and a declared one is rebuilt only by retiring it in the console, withdrawing its role, and declaring it again.

**Path authorization.** `GetParametersByPath` authorizes against the path itself, not only the parameters beneath it, so a grant carrying `…/{classification}/*` alone is denied on the call that enumerates.

---

## 6. Managing an existing profile

### 6.1 Version lifecycle

A profile is a set of immutable versions plus one `active` pointer. Nothing edits a live version in place, and nothing activates itself. The write path is `manage-profiles.ts` behind `.../admin/profiles`, gated per route by the `view-profiles`, `edit-profiles`, `activate-profiles`, `import-golden-set` and `activate-past-golden-gate` capabilities (`backend/lib/config/admin-capabilities.ts`), with the handler checking the caller again (`callerCanManageProfiles`; admins by default, narrowed with `MANAGE_PROFILES_GROUP_NAMES`), and every mutation emits an audit line.

| Step | API (`POST`) | What happens |
|---|---|---|
| Create a draft | `.../profiles/version` with `profileName` | `createDraft` copies the active version (or the seed) into `${SSM_ROOT}/assistant/<profile>/draft`, with the model bundle backfilled |
| Edit the draft | `.../profiles/draft` with `profileName` and `patch` | `editDraft` merges runtime-editable fields and re-hashes `configId` |
| Validate | `.../profiles/validate` | `validateDraft`: schema, model catalog, published context sources, published guardrails, per-intent routes against the DEPLOYMENT pack (`deploymentRouteErrors`, for a version carrying no pack of its own), and the 4096-character storage boundary |
| Run the golden set | `.../profiles/golden-run` with `profileName` | Aurora mode. Answers every live entry of the assistant's golden set 3 times with the draft and 3 times with the active version on the classification's GoldenRun function, posting nothing, and records each attempt (`202` with the `runId`). Spends model calls, so it is an `edit-profiles` route ([ADR-065](../../design/decisions/065-a-draft-answers-the-golden-set-before-it-is-activated.md)) |
| Read the golden gate | `.../profiles/golden-gate` with `profileName` | The set's size, the latest run for the draft's `configId`, the set's coverage of each intent of the draft's pack, the active version's `goldenSet.minRegressionPerIntent` where it declares one, and what Activate will decide. A `view-profiles` route |
| Upload golden entries | `.../profiles/golden-set-import` with `profileName`, `format` (`jsonl` or `csv`) and `content` | Aurora mode. Checks every line at once (`400` naming each bad line), then answers `202` with the batch's id and adds the entries as capability entries in the background (see [The golden set a draft is measured on](#the-golden-set-a-draft-is-measured-on)). An `import-golden-set` route |
| Read a batch | `.../profiles/golden-set-batch` with `profileName` and `batchId` | How an upload or a generation ended: `running`, `complete` with what was written, `refused` with the code and values, or `failed`. A `view-profiles` route; the console reads it when the batch's channel says it ended |
| Retire an upload | `.../profiles/golden-set-retire-upload` with `profileName` and `uploadId` | Retires the live capability entries of one upload; a promoted entry stays. An `import-golden-set` route |
| Generate golden entries | `.../profiles/golden-set-generate` with `profileName`, optional `intents` (at most 12), `perIntent` (1 to 5) and `generationId` | Aurora mode. The utility model writes requests for each intent from its description; with no intents named, the 12 the set covers least. Answers `202` with the batch's id and runs in the background; stored as capability entries marked generated. An `edit-profiles` route; `.../golden-set-retire-generation` retires one |
| Activate | `.../profiles/activate` | Refused `409` while the set holds fewer regression entries for an intent of the draft than the active version's minimum (`GOLDEN_SET_THIN`, naming each intent), or while the assistant's golden set holds a live regression entry and the draft's run is missing (`GOLDEN_RUN_REQUIRED`), running (`GOLDEN_RUN_RUNNING`), failed (`GOLDEN_RUN_FAILED`) failed an entry (`GOLDEN_SET_REFUSED`, with each entry and attempt), or did not answer an entry nominated after it (`GOLDEN_RUN_OUTDATED`); each refusal carries `code` and `params`. A draft saved after the gate read it is refused rather than activated. Then `activateDraft` re-runs validation, writes a new version of `.../definition`, offloads the persona and intent pack to S3, and moves the `active` label. No deploy |
| Activate past the gate | `.../profiles/activate-past-golden-gate` with `profileName`, the draft's `configId`, the refusal shown (`code`, `params`, and `runId` when a run exists) and a `reason` of 10 to 500 characters | Activates a draft the golden gate refuses. An `activate-past-golden-gate` route: held by the admin role alone, with no team route, and the handler checks the caller's groups again. The new version records the refusal and the reason as `activatedPastGate` |
| Roll back | `.../profiles/rollback` with `version` | `activateExistingVersion` moves the label onto an existing version; no content is written |
| Discard the draft | `.../profiles/discard` with `profileName` and `configId` | `discardDraft` deletes `.../draft` only while it holds that `configId`; a draft saved since is kept and refused `409 DRAFT_CHANGED` with its `configId`, no draft is `404 NO_DRAFT`, no `configId` is `400 CONFIG_ID_REQUIRED`. Bodies and the layout stay (content-addressed). An `edit-profiles` route |
| Export | `.../profiles/export`, optional `version` | Returns a manifest (2.13) |
| Import | `.../profiles/import` with `manifest` and `targetProfileName` | Validates against this instance and lands a **draft** of the target, never active. Without a target it is refused `400 TARGET_REQUIRED`; a team route lands on the assistant in its path |
| List | `GET .../profiles` | Every profile's versions plus the live processor, role and guardrail identifiers |

#### The golden set a draft is measured on

A draft answers the assistant's golden set before it is activated ([ADR-065](../../design/decisions/065-a-draft-answers-the-golden-set-before-it-is-activated.md)). Entries arrive by nomination from a labeled answer (the Ground Truth tab), by upload, or by generation from the intents of the draft's pack.

- **Upload.** A JSON Lines file, one entry per line, or a CSV file with a header row, with the columns `intent`, `request`, and optionally `reference`, `precedingTurns` (a JSON list of up to six `{ "role": "user" | "assistant", "text" }`) and `replyPreferences` (registry keys and values only). At most 100 entries, the most the set holds, and 1 MB. Every line is checked first, against the intents the assistant's active version and its draft serve, and one bad line refuses the file with each bad line named. The text is then de-identified by the detector the clean copy uses, and the entries are stored as capability, `source = uploaded`, under one `uploadId`. An entry becomes regression after a run the active version passes and a person promotes it. The set holds at most 100 live entries, what one run can answer.
- **A minimum per intent.** A version may declare `"goldenSet": { "minRegressionPerIntent": 2 }` (a whole number from 1 to 100), named with a draft patch (`npm run assistant -- draft <assistant> --patch <file.json>`). The gate reads it from the **active** version, never the draft, so a draft cannot lower the bar it is measured against: a new minimum takes effect once the version that declares it is active. With one in force, Activate is refused `GOLDEN_SET_THIN` until the set holds that many regression entries for every intent of the draft's pack, or an administrator activates past the gate.
- **Coverage.** The console's golden-set row shows, per intent of the draft's pack, the regression, capability and uploaded entries and how many the latest run answered, the entries whose intent the pack does not declare, and the intents a passing run checked nothing for.

**Signed calls.** Every `.../admin/profiles` route is `AWS_IAM`-authorized, so each call is SigV4-signed for service `execute-api` with credentials that hold the route's capability: a console session ([API-GUIDE.md](./API-GUIDE.md) section 2.5), or an operator's own IAM credentials granted `execute-api:Invoke` on it. An unsigned request is refused with `403`. The routes are declared by the assistant administration nested stack of `AdminServices` and served on `AdminApi`, so they exist with the `admin` capability; the base URL is the `AdminApi` output `AdminApiUrl` followed by `/admin/profiles`. The examples below use the profile CLI, which signs each call.

**Without the console.** With no active version, a turn resolves the compiled seed, so the seed is the deployment's declared assistant and a deployment with no admin backend still answers with it. The profile CLI (`backend/scripts/assistant.mjs`, `backend/scripts/lib/assistant-cli.cjs`) manages a version from a terminal. It is a client of the profile API, not a writer of the profile store: each call is SigV4-signed for `execute-api` with the operator's own IAM credentials from the default AWS credential chain (a named profile, SSO or environment keys), and API Gateway refuses credentials that do not hold the route, so the API's validation and audit apply exactly as they do to the console.

```bash
cd backend
# <profile> is an assistant profile name (`analyst` on `standard` in the shipped catalog), never a classification
AWS_PROFILE=<your-profile> npm run assistant -- draft analyst                         # clone the active version into a draft
AWS_PROFILE=<your-profile> npm run assistant -- draft analyst --patch patch.json      # merge a JSON object of runtime-editable fields
AWS_PROFILE=<your-profile> npm run assistant -- draft analyst --set modelKey=sonnet   # one field; the value is JSON when it parses
AWS_PROFILE=<your-profile> npm run assistant -- validate analyst                      # exits 1 when the draft is not valid
AWS_PROFILE=<your-profile> npm run assistant -- activate analyst
AWS_PROFILE=<your-profile> npm run assistant -- rollback analyst --version 3
```

| Command | Route (`POST`) |
|---|---|
| `draft <profile>` | `.../profiles/version` |
| `draft <profile> --patch <file>` or `--set key=value` | `.../profiles/draft` |
| `validate <profile>` | `.../profiles/validate` |
| `activate <profile>` | `.../profiles/activate` |
| `rollback <profile> --version <n>` | `.../profiles/rollback` |

The API is `--api <url>`, else `AE_MANAGE_PROFILES_API_URL`, else the `AdminApiUrl` output of this instance's `AdminApi` stack followed by `/admin/profiles`. The signing region is `--region`, else `AWS_REGION`, else the region in the API URL. A deployment without the `admin` capability has no profile API, and the CLI says so and exits `2` rather than writing the store. A `403` from the gateway is reported as an IAM refusal naming the route the credentials do not hold.

The admin console's Assistants tab (`ProfilesTab.tsx`) drives the same API. A new assistant is created in a wizard of seven steps: Classification and name, then Starting point and models (intent classification, classifier model, default model, turns per hour) make the assistant, and once its build has made the first draft, the page's own Behavioral, Workflows, Scope and models and Tools and context sections shape that draft, ending on Review and activate, the page's draft banner with Discard draft, Validate and Activate. An assistant's page shows the active version or the draft, chosen by the toggle in its header (Edit starts a draft from the active version; Draft (n changed) shows the one that exists), and the draft is edited in the same sections: Behavioral (`displayName`, `persona`), Workflows (the `assistant-joined` welcomes, every other event workflow, and `messages`), Scope and models (`models`, including each intent's route on its card: its Text model and fallback, its Image model and fallback where a step of its workflow produces an image or the intent needs one, and each step of its workflow with what it produces and the model it runs on, the route's by default or an override the draft writes to `models.byIntent[<intent>].steps[<state>]`; a read-only Platform intents group saying which of the universal intents and `platform_question` have their own route and which answer through the general route; and `models.routing`), Tools and context (`tools`, `guardrailId`, `contextSources`), Variables (read-only) and Versions. Each area saves only its own fields, and an edit not yet saved is kept across sections, the toggle and another area's save; the menu marks each section the draft changes and each holding an unsaved edit, and leaving the assistant or activating asks first. The draft's banner shows the diff against the active version, every changed field and those no section edits (`intentPack`, `onboarding`, `boundary`) under Other fields, with Validate and Activate. **Discard draft** (on the banner, also the wizard's last step) throws the draft away without activating it: it asks first, naming the areas whose changes are lost, and sends the `configId` the page was loaded from. A draft saved since (another tab, a teammate, an import) is kept, the console says why and reloads to it; once discarded, Edit is offered again. Validate places each route or step refusal under the card or step it names, from the `errorDetails` the validate response carries beside `errors` (`{ code, path, params, message }`, read by the console from `code` and `params`, never from the message). The header links to Effectiveness for the active version and to Conversations, each intent card to Effectiveness for that intent, and each step to that intent's step and model breakdown narrowed to the step (`&step=<state>`), each narrowed to the assistant. What it does with each version field is declared once in `backend/lambda/src/lib/profile-field-decisions.ts`, served with the listing, and a body field added without a decision fails `profile-field-decisions.test.ts`:

| Kind | Fields | How it is changed |
|---|---|---|
| Control | `models` (base, classifier, per intent, `image`, and the routing rules), `tools`, `guardrailId`, `displayName`, `persona`, `contextSources`, `messages` (picked per message under Workflows, Message templates), `eventWorkflows` (the welcome among them, edited per conversation type under Workflows, Welcome) | In the draft, in place in the page's sections, each area saving its own fields through `.../profiles/draft`; models, guardrails and context sources are offered from the classification's own catalogs, and `eventWorkflows` and `messages` are shape-checked before anything is written (`422` otherwise) |
| JSON | `intentPack`, `workflows`, `onboarding`, `boundary` | A draft `patch` (`npm run assistant -- draft <assistant> --patch <file.json>`; a key patched to `null` is removed), or export, edit the manifest's `body`, and import (6.3). The welcome fields other than the opening texts and prompts (the orientation fields, and a conversation type's fields other than its opening text) are edited the same way |
| Not editable in a version | `machines` (global workflows, 2.9), `systemPromptAddendum` (the instruction an experiment tests, set by experiments; general answer style belongs in the persona's `How to answer:` section, and on a draft **Move into the persona** moves it there and clears it), `modelKey` (the legacy spelling of `models.default`), `copy` (retired, 2.10: shown only where a version still carries lines, with the migration that moves them) | As the page says for each |

The tab offers no control for a deployment-time setting, because activating a version cannot move one; it shows each with what drives it (`deploy.config.json` and a deploy of `Assistants-<classification>`, or the classification's `grants`). Templates are not version fields: `npm run template -- put|activate|rollback|list|check <classification>` manages the bodies under `templates/<classification>/` (2.11).

**Timing.** The `active` pointer is resolved per turn and cached per warm container for 30 seconds, so an activation or rollback converges within about 30 seconds and applies to the next turn of an existing conversation. The deployment-time settings (2.3) and the per-deployment parameters (2.12) do not move with a version.

### 6.2 Change the model

Change the model a profile answers with through a version: set `models.default` (base), `models.byIntent` (per intent), or `models.classifier`. Each must be a model the classification selects (`models.selected`). `model-resolver.ts` checks the selection on the primary and the fallback (an unselected model falls back to the classification default) and otherwise serves the route as written: the served model is the saved route, so a simple intent may be routed to a cheaper model than the base model and is answered on it. An intent with no route is answered on the base model. A standalone `greeting` or `acknowledgment` is answered through a route of its own when the version has one, else through `general`. There is no classification floor; a classification minimum, if one is ever wanted, is an explicit admin setting refused on the write path, not a silent swap (**NOT BUILT**, not planned). Seeds write each platform route cheaper than the base model as the base model, so a version says what it serves ([MODEL_STRATEGY](./MODEL_STRATEGY.md#runtime-model-resolution)).

To change which models a classification may use, edit its `models` (2.2, 5.2) and deploy its `Assistants-<classification>` stack alone: the stack grants exactly the new selection, and a version that names a model outside it is refused on the write path. An active version that names a model the selection no longer holds is served without it, with a logged reason (`confineModelsToClassification`). No context key picks a model. The per-turn base model is the resolved profile `modelKey` (version, else the seed), so to change the default for a profile with no active version, edit the seed `modelKey`. To add a model to the instance, add it to `getModelCatalog` with its ARNs (or to `EXTERNAL_MODELS` for an adapter outside AWS); no classification uses it until it selects it, and the processor role's grant derives from `modelArnsForClassification`, so there is no manual IAM change.

### 6.3 Change the persona or intent pack

- **Versioned persona (preferred):** a draft `patch` with `persona`, then activate. It can be rolled back and exported.
- **Versioned intent pack (preferred):** a draft `patch` with `intentPack`, then activate. Converges within the 30-second profile cache, with no deploy and no cold start, and rolls back the same way. A pack REPLACES the platform taxonomy unless you set `extends: "default"`, which is what lets an assistant recognize only the work it can actually do. Declare every intent that assistant should have.

  Save the patch as `backend/intent-pack-patch.json`:

  ```json
  { "intentPack": { "extends": "default", "intents": [{
    "key": "financial_metric",
    "description": "A single financial figure the assistant can state in a sentence.",
    "keywords": ["arr", "revenue", "margin"],
    "delivery": "PLACEHOLDER_UPDATE",
    "instructions": "Answer with the figure and the period it covers. Name the source. Do not open a task.",
    "tools": ["load_company_context"]
  }] } }
  ```

  ```bash
  cd backend && npm run assistant -- draft analyst --patch intent-pack-patch.json
  ```

  Then `npm run assistant -- validate analyst` before `npm run assistant -- activate analyst`: validate is where an unreachable route, a tool outside the profile's allowlist, an over-long `instructions` or a mistyped `extends` is reported, and it is cheaper to read there than to find out from a turn.

- **Per-deployment fallback:** the persona and intent pack parameters are the fallback seam for a version that carries neither. Set them at deploy through the supported path, which forwards every key in `backend/deploy.config.json` and adds these, then re-seed the definition if the active version carries a persona (3.5):

```bash
cd backend && npm run deploy -- \
  --context assistantSystemPrompt="$(cat persona.txt)" \
  --context assistantIntentPack="$(cat intent-pack.json)"
```

Both keys are listed in `backend/deploy.config.example.json`; set them in `deploy.config.json` instead if every later deploy should carry them. A single-stack deploy is `npm run deploy:stack -- <Stack>`, which applies `deploy.config.json` and confirms the stack name for you.

- **Built-in persona:** the last fallback, the `defaultPersona` the serving profile declares in `backend/lib/config/profiles.ts`, else a generic persona (`defaultPersonaFor` in `assistant-async-processor.ts`).

### 6.4 Change the guardrail

Each profile stack provisions the catalog in `guardrail-catalog.ts` with the `AgentGuardrails` construct (`backend/lib/constructs/bedrock-guardrails.ts`); topic denies, regex filters, PII actions and marker filters are configured there. The construct hashes its config into the `CfnGuardrailVersion` logical id, so a config edit publishes a fresh version on deploy. To switch a profile between provisioned guardrails without a deploy, set `guardrailId` in a version. Verify with `aws bedrock-runtime apply-guardrail`.

### 6.5 Change context retrieval scope

The profile's S3 grant defines what `load_company_context` can return, derived from `ProfileRegistry.contextPrefixesGranted`. To widen or narrow it, change `grants` in `profiles.ts` and redeploy; there is no per-stack prefix list. S3 reach and vector-retrieval reach cannot diverge: the vector-retrieval role set is generated from `ProfileRegistry.grantsFor` in `scopeFunctionSql` (`classification-boundary-sql.ts`), the retrieval filter in `document-retrieval.ts` is built from `grantsFor` and refuses the call when the scope it is handed is not that set, and `contextPrefixesGranted` derives from the same resolver. `backend/test/analytics-aurora/retrieval-reaches-the-grant-set.test.ts` proves the three agree over a registry whose `grants` are not a rank prefix, which is the only shape that could tell them apart.

### 6.6 Change sizing or a capability

Edit the classification's `topology` (2.4) and deploy its `Assistants-*` stack, passing every key from `backend/deploy.config.json` (or run `npm run deploy`). For sizing, CloudWatch Duration and ConcurrentExecutions show whether the values fit: aim for p95 duration at or below 70% of the timeout and reserved concurrency at or above twice the peak observed concurrency. Turn a capability on or off with its flag; express divergence through the topology, never by branching the shared body or processor.

### 6.7 Shared files

Do not edit these from a profile change:

- `agent-classification-common.ts` (the SSM contract keys). Renaming or removing a key breaks every profile and the shared router; add a key if one is needed.
- `assistant-profile-stack.ts` and `assistant-async-processor.ts`. Profile behavior is expressed by the classification's `topology` in the registry.
- `async-processor-core.ts` (the shared assistant logic).
- The shared platform stacks (`conversations-stack.ts`, `experiments-stack.ts`, `battle-stack.ts`). They publish the `/agent-echelon/shared/*` SSM contract; adding a shared resource means publishing a key there, adding it to `resolveSharedSSM`, and granting it in each profile that needs it.

---

## 7. Verifying

```bash
# Deploy through the supported path (forwards every key in backend/deploy.config.json).
cd backend && npm run deploy

# Paths below use the default instance's SSM root, /agent-echelon.
# The classification stack published its runtime identifiers (keyed by CLASSIFICATION)
aws ssm get-parameter --name /agent-echelon/assistant/<classification>/processor-arn \
  --profile <your-profile> --query 'Parameter.Value' --output text

# Which version is active (keyed by PROFILE name; the definition carries configId)
aws ssm get-parameter --name /agent-echelon/assistant/<profile>/definition:active \
  --profile <your-profile> --query 'Parameter.Value' --output text

# Watch the processor while exercising the conversation
aws logs tail /aws/lambda/<Instance>Assistants-<classification>-AsyncProcessor<...> \
  --follow --profile <your-profile>
```

A single-stack deploy is `npm run deploy:stack -- <Instance>Assistants-<classification>`, which forwards every key from `backend/deploy.config.json` and checks the name against `cdk list` with the same context, because a stack name that matches nothing exits 0 and deploys NOTHING.

A turn served by the compiled seed reports `configId: 'seed'`, and a version that failed to resolve logs `[active-profile] '<profile>' active version unresolved; serving seed`.

| What | Tests |
|---|---|
| Config and registry | `backend/test/cdk-synth.test.ts`, `backend/test/lib/model-catalog-mirror.test.ts` |
| Version resolution, and a retired `copy` left off the resolved profile | `backend/test/lib/profile-version-lookup.test.ts` |
| A version carries no deployment-time setting, and tolerates a stored one | `backend/test/versioned-profile-omits-deploy-time-fields.test.ts` |
| Profile lifecycle and ownership end to end | `tests/e2e/admin-profiles.spec.ts`, `tests/e2e/portable-profile-lifecycle.spec.ts`, `tests/e2e/portable-profile-gates.spec.ts`, `tests/e2e/profile-config.spec.ts`, `tests/e2e/profile-ownership.spec.ts` |
| Context | 3.7 |
| Onboarding | 4.5 |

Run backend tests a slice at a time (`npm run test:slice -- <path>`); the full suite is run shard by shard as described in `AGENTS.md`.
