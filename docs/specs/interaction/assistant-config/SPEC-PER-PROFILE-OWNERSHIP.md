# SPEC: Per-profile ownership (`AgentEchelonClassification-*`)

**Status:** Implemented.

**Problem and who it's for:** An organization running several assistant offerings side by side wants each team to own and ship its own - model, prompt, tools, guardrail, processor - end-to-end without touching or gaining access to the others, while a demo deployer still gets everything in one command. This is for the platform developer and AI developer who own a single classification, and the admin/operator who wants independent deploy cadences; the alternative is building your own deploy-isolation and blast-radius controls, or accepting a monolith where one team's change ships everyone's. It organizes the profiles as profile-as-data: one shared parametrized stack body with a thin per-profile subclass, wired across stacks by SSM only so each deploys on its own cadence.

**Site section:** Interaction layer, Assistant Configuration pillar.


> The per-profile assistant stacks are organized **profile-as-data**: one shared body (`AssistantProfileStack`) is parametrized by a `ProfileTopology`, and each profile lives in a thin subclass (`BasicTierStack` / `StandardTierStack` / `PremiumTierStack`, one per file) that supplies its topology, with shared constants in `agent-classification-common.ts`. This gives both independently-deployable *stacks* and independently-owned *config* - a change to one profile touches only that profile's thin descriptor, not the shared body. The live assistant path is the async-processor's self-hosted Converse tool loop - there is **no Bedrock Agent** - so a profile stack owns the **processor** (the shared `assistant-async-processor.ts`, one instance per profile), not an agent.

> The stacks, stack names, and shared-constants module are renamed to classification (`*-classification-stack.ts`, the `AgentEchelonClassification-*` stack names, `agent-classification-common.ts`). A few internal helper symbols and one storage prefix still read `tier` for continuity (`modelArnsForTier`, `tierChannelScopedAllow`, the `context/{tier}/` S3 prefix); the concept they name is a **profile** / **classification**. Any remaining symbol rename is tracked separately and does not change any behavior described here.

## Purpose

Let each profile be an **independently-deployable, independently-ownable** unit. A team owns `AgentEchelonClassification-Standard` end-to-end - its model choice, system prompt, tools, guardrail, Lex bot - and ships with `cdk deploy AgentEchelonClassification-Standard` without touching basic, premium, or the shared platform, and without read/write access to other profiles' resources. A single-account demo deployer still gets everything with one `cdk deploy --all`.

The cross-stack interface is **SSM only** - no `Fn::importValue`, no direct construct references between a profile stack and the platform - so a profile deploys on its own cadence.

## Why there is no Bedrock Agent

The **assistant is the async-processor** - shared-router intent classification → per-intent model → a Converse `toolConfig` loop that calls the tier-scoped `load_company_context` retrieval under the processor's own IAM role, with an out-of-band guardrail on output. There is no `CfnAgent` / alias / action-group Lambda / Lex `BedrockAgentIntent`; the profile stack centers on the processor.

## Ownership map

### Shared (deployed once, consumed by all profiles)

| Stack | Stays because |
|---|---|
| `AgentEchelonChimeMessaging` | One AppInstance per account; profiles add bots to it |
| `AgentEchelonCognitoAuth` | One user/identity pool; tier groups are claims, not separate backends |
| `AgentEchelonS3Storage` | One attachments bucket; `context/{tier}/` prefixes are the IAM boundary |
| `AgentEchelonChannelFlow` | One channel-flow processor; dispatches per-profile via channel metadata |
| `AgentEchelonNotifications`, `AgentEchelonAnalytics(Aurora)` | Cross-profile; classification is a partition/claim, not a stack boundary |
| **Shared router** (`router-agent-handler`: classify intent → dispatch by `min(userTier,channelTier)`) | Holds the tier-comparison + intent→delivery/task logic; the router code is shared and deployed as one Lambda per profile stack |
| `create-conversation`, DDB (`AgentTasks`/`UserTasks`/`BattleState`/`Experiments`), battle orchestrator | Cross-profile runtime + state |

### Per-profile (`AgentEchelonClassification-{Basic,Standard,Premium}`)

| What | Why per-profile |
|---|---|
| **Async-processor** (the shared `assistant-async-processor.ts`, one instance per profile; the Converse tool loop) | The assistant - the team's product surface (model, prompt, tools) |
| **Tier-scoped `context/{tier}/` S3 IAM** | The defense-in-depth isolation boundary (basic→basic; standard→+standard; premium→all) |
| **Tier guardrail** (text; out-of-band ApplyGuardrail on output) | Each team owns its content policy |
| **Lex bot** (WelcomeIntent + FallbackIntent → shared router) | The ownership/blast-radius boundary; bot ARN published to SSM |
| **AppInstanceBot** | The Amazon Chime SDK-side handle for the tier bot |
| **Per-tier model IAM** (InvokeModel[WithResponseStream] on allowed models) | Each tier grants only its models |

Not present in a profile stack: `CfnAgent`, `CfnAgentAlias`, agent role, agent SSM params, action-group Lambdas, `BedrockAgentIntent`.

## SSM-only cross-stack contract

A profile stack **publishes** (no CFN exports):

| Parameter | Value |
|---|---|
| `/agent-echelon/assistant/{tier}/processor-arn` | the profile's async-processor Lambda ARN |
| `/agent-echelon/assistant/{tier}/bot-arn` | the profile's AppInstanceBot ARN |

A profile stack **consumes** (SSM-resolved ARNs / plain props from the composition root - never `Fn::importValue`):

| Parameter | Source | Used for |
|---|---|---|
| `/agent-echelon/shared/router-arn` | platform | Lex FallbackIntent fulfillment target |
| `/agent-echelon/shared/tables/*-arn` | platform | processor IAM + env (tasks/experiments/battle) |
| `/agent-echelon/shared/battle-orchestrator-arn` | platform | premium processor (battle) |
| `/agent-echelon/app-instance-arn` | platform | AppInstanceBot + Amazon Chime SDK IAM |
| `/agent-echelon/attachments-bucket` | platform | `CONTEXT_BUCKET` + tier S3 grants |

Consumers of the profile contract: the **shared router** resolves `/agent-echelon/assistant/{tier}/processor-arn` to dispatch; **`create-conversation`** resolves `/agent-echelon/assistant/{tier}/bot-arn` to add the right profile bot to a new channel.

## How a per-profile processor reaches shared resources

The processor needs shared DDB tables and (premium) the battle orchestrator. The profile stack resolves those ARNs (SSM at synth or plain props from the composition root) and grants its processor role IAM on them - a declarative string, **not** an `Fn::importValue`, so the SSM-only/decoupled-deploy goal holds. Tier isolation is unchanged: the processor's own role grants `s3:GetObject` only on its tier's `context/{...}/` prefixes.

## Code layout - profile-as-data

```
backend/
├─ bin/backend.ts                          composition root; instantiates each profile stack
├─ lib/config/profiles.ts                  the config: classifications + profiles + groupClearance
├─ lib/profile-registry.ts                 the ONLY interpreter of a classification tag / clearance
└─ lib/stacks/
   ├─ agent-classification-common.ts                 SHARED: SSM contract keys + thin helpers
   │                                       (resolveSharedSSM, modelArnsForTier,
   │                                        tierBotArnKey, tierProcessorArnKey). No class.
   ├─ assistant-profile-stack.ts  class AssistantProfileStack   ← the SHARED body, parametrized
   │                                                              by a ProfileTopology descriptor.
   ├─ basic-classification-stack.ts      class BasicTierStack     ← thin wrapper: supplies the profile's
   ├─ standard-classification-stack.ts   class StandardTierStack     ProfileTopology; team-owned.
   └─ premium-classification-stack.ts    class PremiumTierStack
```

One shared stack body, one thin descriptor file per profile. The divergence (model, sizing, guardrails, context routing, persona/pack params, image gen, streaming, battle) is DATA in the `ProfileTopology`, not three code copies. A basic-team change touches exactly its descriptor in `basic-classification-stack.ts`; standard / premium / the shared body / the platform are untouched. One shared `assistant-async-processor.ts` serves every profile and self-gates its capabilities on the env each topology flag sets.

### What each profile stack instantiates

```
AgentEchelonClassification-{Basic|Standard|Premium}        driven by that profile's ProfileTopology
├─ AsyncProcessor Lambda  (entry: lambda/src/assistant-async-processor.ts - shared)
│   env: PROFILE_NAME, BATTLE_ELIGIBLE, MAX_TOKENS, CONTEXT_BUCKET, MODEL_ID/NAME,
│        GUARDRAIL_ID/VERSION, APP_INSTANCE_ARN, *_TABLE (richProcessor), CN/battle env (per flag)
│   role: ContextS3Read(classifications at/below rank) + bedrock:InvokeModel[WithResponseStream (streaming)]
│         + bedrock:ApplyGuardrail(profile guardrail) + Amazon Chime SDK(send/list/update)
│         + DynamoDB(shared tables, richProcessor) + lambda:Invoke(orchestrator, battle)
│         + image-gen + image-guardrail + battle-images S3 (imageGen)
├─ Profile guardrail         (AgentGuardrails - `agent-echelon-{profile}-guardrail`)
├─ Image-output guardrail    (imageGen only - `agent-echelon-premium-battle-image-guardrail`)
├─ Lex bot                   (WelcomeIntent + FallbackIntent → shared router)
├─ AppInstanceBot            (→ this profile's Lex bot)
└─ SSM publishes             /agent-echelon/assistant/{profile}/{processor-arn,bot-arn}
  NO CfnAgent / CfnAgentAlias / action-group Lambdas.
```

How-to: see [`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](../../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) for the practical steps to add a new tier (e.g. `enterprise`) or change an existing tier's model / prompt / guardrail / context scope / sizing / second-assistant.

## Independent deployability

Because the cross-stack contract is SSM-only, each profile stack deploys on its own cadence: the shared router resolves `/agent-echelon/assistant/{tier}/processor-arn` to dispatch, and `create-conversation` resolves `/agent-echelon/assistant/{tier}/bot-arn` to add the right profile bot to a new channel. A single-account demo still gets everything with one `cdk deploy --all`. `scripts/validate-tier-context.ts` verifies tier isolation. Premium is the trickiest coupling because it carries the `/battle` wiring.

## Invariants & risks

- **Tier isolation** = the per-profile processor role's S3 scope. Keep `validate-tier-context.ts` green.
- **No CFN cross-stack refs** between tier and platform - SSM only, or the decoupled-deploy property is lost.
- **Router dispatch** enforces `min(userTier, channelTier)` (a security invariant).
- **Premium battle wiring** is the trickiest coupling.

## Design decisions

- **`AgentEchelonClassification-*` are separate stacks**, not a single shared stack, so ownership is independent per tier.
- **Cognito stays shared and decoupled from bots/assistants** - added auth methods (SAML/OIDC/custom) don't touch profile stacks.
- **Channel flow stays shared**; per-conversation-type channel flow is a separate axis, not per-profile.
- **Behavioral config is runtime-editable as versioned data.** [`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md) extends this spec: a profile's model bundle, persona, intent pack, tool allowlist, and guardrail selection resolve at runtime from the active profile version, so activating, rolling back, or importing a version is a data change, not a stack deploy. The deploy-time framing here describes the security boundary that stays fixed - the context scope (S3 IAM grant), the guardrail resource, the per-profile model `InvokeModel` allowlist, and the bot identity - which a version selects among but never widens.
