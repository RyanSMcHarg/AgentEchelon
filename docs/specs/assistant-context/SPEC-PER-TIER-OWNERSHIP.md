# SPEC: Per-tier ownership (`AgentEchelonTier-*`)

**Status:** Implemented


> The per-tier assistant stacks are organized **tier-as-class**: three classes
> (`BasicTierStack` / `StandardTierStack` / `PremiumTierStack`), one per file,
> with shared constants in `agent-tier-common.ts`. This gives both
> independently-deployable *stacks* and independently-owned *code* - a change to
> one tier touches only that tier's file, not a shared class that would review
> and risk all three tiers at synth time.
>
> The live assistant path is the async-processor's self-hosted Converse tool
> loop - there is **no Bedrock Agent** - so a tier stack owns the
> **processor**, not an agent.

## Purpose

Let each tier be an **independently-deployable, independently-ownable** unit.
A team owns `AgentEchelonTier-Standard` end-to-end - its model choice, system
prompt, tools, guardrail, Lex bot - and ships with `cdk deploy
AgentEchelonTier-Standard` without touching basic, premium, or the shared platform,
and without read/write access to other tiers' resources. A single-account
demo deployer still gets everything with one `cdk deploy --all`.

The cross-stack interface is **SSM only** - no `Fn::importValue`, no direct
construct references between a tier stack and the platform - so a tier deploys
on its own cadence.

## Why there is no Bedrock Agent

The **assistant is the async-processor** - shared-router intent
classification → per-intent model → a Converse `toolConfig` loop that calls the
tier-scoped `load_company_context` retrieval under the processor's own IAM role,
with an out-of-band guardrail on output. There is no `CfnAgent` / alias /
action-group Lambda / Lex `BedrockAgentIntent`; the tier stack centers on the
processor.

## Ownership map

### Shared (deployed once, consumed by all tiers)

| Stack | Stays because |
|---|---|
| `AgentEchelonChimeMessaging` | One AppInstance per account; tiers add bots to it |
| `AgentEchelonCognitoAuth` | One user/identity pool; tier groups are claims, not separate backends |
| `AgentEchelonS3Storage` | One attachments bucket; `context/{tier}/` prefixes are the IAM boundary |
| `AgentEchelonChannelFlow` | One channel-flow processor; dispatches per-tier via channel metadata |
| `AgentEchelonNotifications`, `AgentEchelonAnalytics(Aurora)`, `AgentEchelonIAMPolicies` | Cross-tier; tier is a partition/claim, not a stack boundary |
| **Shared router** (`router-agent-handler`: classify intent → dispatch by `min(userTier,channelTier)`) | Holds tier-comparison + intent→delivery/task logic; a shared router, with per-tier routers a later axis |
| `create-conversation`, DDB (`AgentTasks`/`UserTasks`/`BattleState`/`Experiments`), battle orchestrator | Cross-tier runtime + state |

### Per-tier (`AgentEchelonTier-{Basic,Standard,Premium}`)

| What | Why per-tier |
|---|---|
| **Async-processor** (`{tier}-async-processor.ts`, the Converse tool loop) | The assistant - the team's product surface (model, prompt, tools) |
| **Tier-scoped `context/{tier}/` S3 IAM** | The defense-in-depth isolation boundary (basic→basic; standard→+standard; premium→all) |
| **Tier guardrail** (text; out-of-band ApplyGuardrail on output) | Each team owns its content policy |
| **Lex bot** (WelcomeIntent + FallbackIntent → shared router) | The ownership/blast-radius boundary; bot ARN published to SSM |
| **AppInstanceBot** | The Amazon Chime SDK-side handle for the tier bot |
| **Per-tier model IAM** (InvokeModel[WithResponseStream] on allowed models) | Each tier grants only its models |

Not present in a tier stack: `CfnAgent`, `CfnAgentAlias`, agent role, agent SSM
params, action-group Lambdas, `BedrockAgentIntent`.

## SSM-only cross-stack contract

A tier stack **publishes** (no CFN exports):

| Parameter | Value |
|---|---|
| `/agent-echelon/tier/{tier}/processor-arn` | the tier async-processor Lambda ARN |
| `/agent-echelon/tier/{tier}/bot-arn` | the tier AppInstanceBot ARN |

A tier stack **consumes** (SSM-resolved ARNs / plain props from the composition
root - never `Fn::importValue`):

| Parameter | Source | Used for |
|---|---|---|
| `/agent-echelon/shared/router-arn` | platform | Lex FallbackIntent fulfillment target |
| `/agent-echelon/shared/tables/*-arn` | platform | processor IAM + env (tasks/experiments/battle) |
| `/agent-echelon/shared/battle-orchestrator-arn` | platform | premium processor (battle) |
| `/agent-echelon/app-instance-arn` | platform | AppInstanceBot + Amazon Chime SDK IAM |
| `/agent-echelon/attachments-bucket` | platform | `CONTEXT_BUCKET` + tier S3 grants |

Consumers of the tier contract: the **shared router** resolves
`/agent-echelon/tier/{tier}/processor-arn` to dispatch; **`create-conversation`** resolves
`/agent-echelon/tier/{tier}/bot-arn` to add the right tier bot to a new channel.

## How a per-tier processor reaches shared resources

The processor needs shared DDB tables and (premium) the battle orchestrator.
TierStack resolves those ARNs (SSM at synth or plain props from the
composition root) and grants its processor role IAM on them - a declarative
string, **not** an `Fn::importValue`, so the SSM-only/decoupled-deploy goal
holds. Tier isolation is unchanged: the processor's own role grants
`s3:GetObject` only on its tier's `context/{...}/` prefixes.

## Code layout - tier-as-class

```
backend/
├─ bin/backend.ts                          composition root; instantiates each class
└─ lib/stacks/
   ├─ agent-tier-common.ts                 SHARED: SSM contract keys + thin helpers
   │                                       (resolveSharedSSM, modelArnsForTier,
   │                                        tierBotArnKey, tierProcessorArnKey,
   │                                        legacyBotArnParamArn). No class.
   ├─ basic-tier-stack.ts      class BasicTierStack     ← own file per tier;
   ├─ standard-tier-stack.ts   class StandardTierStack    each hardcoded for its
   └─ premium-tier-stack.ts    class PremiumTierStack     tier; team-owned end-to-end.
```

One class per tier, in its own file, with the SSM contract centralised but
the per-tier IAM/Lambda/Lex/AppInstanceBot wiring inlined per tier. A
basic-team change touches exactly `basic-tier-stack.ts` (and possibly
`basic-async-processor.ts`); standard / premium / the platform are untouched.

### What's in each tier-stack class

```
AgentEchelonTier-{Basic|Standard|Premium}        owned by that tier's file
├─ AsyncProcessor Lambda  (entry: lambda/src/{tier}-async-processor.ts)
│   env: CONTEXT_BUCKET, MODEL_ID/NAME, GUARDRAIL_ID/VERSION,
│        APP_INSTANCE_ARN, *_TABLE_ARN (shared, std/prem), BATTLE_ORCHESTRATOR_ARN (prem)
│   role: ContextS3Read(tier prefixes) + bedrock:InvokeModel[WithResponseStream (prem)]
│         + bedrock:ApplyGuardrail(tier guardrail) + Amazon Chime SDK(send/list/update)
│         + DynamoDB(shared tables, std/prem) + lambda:Invoke(orchestrator, prem)
│         + image-gen + image-guardrail + battle-images S3 (prem)
├─ Tier guardrail            (AgentGuardrails — `agent-echelon-{tier}-guardrail`)
├─ Image-output guardrail    (premium only — `agent-echelon-premium-battle-image-guardrail`)
├─ Lex bot                   (WelcomeIntent + FallbackIntent → shared router)
├─ AppInstanceBot            (→ this tier's Lex bot)
└─ SSM publishes             /agent-echelon/tier/{tier}/{processor-arn,bot-arn}
  NO CfnAgent / CfnAgentAlias / action-group Lambdas.
```

How-to: see [`HOW-TO-ADD-OR-MANAGE-A-TIER.md`](../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-TIER.md)
for the practical steps to add a new tier (e.g. `enterprise`) or change an
existing tier's model / prompt / guardrail / context scope / sizing /
second-assistant.

## Independent deployability

Because the cross-stack contract is SSM-only, each tier stack deploys on its own
cadence: the shared router resolves `/agent-echelon/tier/{tier}/processor-arn` to
dispatch, and `create-conversation` resolves `/agent-echelon/tier/{tier}/bot-arn`
to add the right tier bot to a new channel. A single-account demo still gets
everything with one `cdk deploy --all`. `scripts/validate-tier-context.ts`
verifies tier isolation. Premium is the trickiest coupling because it carries the
`/battle` wiring.

## Invariants & risks

- **Tier isolation** = the per-tier processor role's S3 scope. Keep
  `validate-tier-context.ts` green.
- **No CFN cross-stack refs** between tier and platform - SSM only, or the
  decoupled-deploy property is lost.
- **Router dispatch** enforces `min(userTier, channelTier)` (a security
  invariant).
- **Premium battle wiring** is the trickiest coupling.

## Design decisions

- **`AgentEchelonTier-*` are separate stacks**, not a single shared stack, so
  ownership is independent per tier.
- **Cognito stays shared and decoupled from bots/assistants** - added auth
  methods (SAML/OIDC/custom) don't touch tier stacks.
- **Channel flow stays shared**; per-conversation-type channel flow is a separate
  axis, not per-tier.
