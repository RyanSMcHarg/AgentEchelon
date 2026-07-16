# How to add or manage a tier

A practical guide for two adjacent tasks the per-tier ownership model
([SPEC-PER-TIER-OWNERSHIP.md](../../specs/assistant-context/SPEC-PER-TIER-OWNERSHIP.md))
makes routine:

1. **Add a brand-new tier** (e.g. `enterprise`) alongside the existing
   `basic` / `standard` / `premium`.
2. **Manage an existing tier's assistant**: change its model, prompt,
   guardrail, retrieval scope, or sizing without touching the other
   tiers.

The carve is **tier-as-class**: each tier lives in its own file
(`backend/lib/stacks/{basic,standard,premium}-tier-stack.ts`), with
shared constants centralised in
`backend/lib/stacks/agent-tier-common.ts`. A tier-team change reviews
and ships exactly that tier.

> The architectural rationale, SSM contract, and rollout phasing live in
> [SPEC-PER-TIER-OWNERSHIP.md](../../specs/assistant-context/SPEC-PER-TIER-OWNERSHIP.md). This file
> is the **how**.

---

## Map of moving parts

```
backend/
├── bin/backend.ts                       ← composition root; instantiates each tier
├── lib/
│   ├── stacks/
│   │   ├── agent-tier-common.ts         ← shared SSM keys + thin helpers (no class)
│   │   ├── basic-tier-stack.ts          ← BasicTierStack
│   │   ├── standard-tier-stack.ts       ← StandardTierStack
│   │   └── premium-tier-stack.ts        ← PremiumTierStack
│   └── config/model-strategy.ts         ← model catalog + tier-allowed lists
└── lambda/src/
    ├── basic-async-processor.ts         ← entry; thin wrapper over async-processor-core
    ├── standard-async-processor.ts
    ├── premium-async-processor.ts
    └── lib/
        ├── async-processor-core.ts      ← shared assistant logic (Converse tool loop, /battle, etc.)
        └── company-context.ts           ← tier-scoped S3 retrieval
```

Per-tier file ownership: a tier team owns its own `*-tier-stack.ts` and
`*-async-processor.ts`. The shared `async-processor-core.ts` and
`agent-tier-common.ts` change rarely; PRs touching them should ping
every tier owner.

---

## 1. Adding a new tier

Use case: deployer wants a fourth tier (say `enterprise`) with its
own model selection, S3 scope, guardrail, and Lex bot.

There are six pieces. Skip none; each one is what keeps the tier
isolated end-to-end.

### 1.1 Add the tier to the user-facing type system

Cognito group, frontend tier union, backend tier union.

```bash
# Frontend
frontend/src/providers/AuthProvider.tsx       # export type UserTier
frontend/src/types/index.ts                   # any tier-aware types

# Backend
backend/lib/stacks/agent-tier-common.ts       # export type Tier
backend/lib/config/model-strategy.ts          # export type ModelTier
backend/lambda/src/lib/async-processor-core.ts # AsyncProcessorConfig['userType']

# Security controls that hardcode the tier set (NOT just types)
backend/lambda/src/membership-audit.ts         # TIER_RANK (:54) + TIER_GROUPS (:~92)
backend/lambda/src/credential-exchange.ts      # resolveRoleKey (:107-114)
```

In the Cognito User Pool stack (`backend/lib/stacks/cognito-auth-stack.ts`)
add an `enterprise` group with precedence between admins and premium.
Update the post-confirmation trigger and `user-management.ts` to mirror
`custom:tier=enterprise` into the new group.

The last two files are SECURITY controls, not conveniences, and they fail
UNSAFE if the new tier is omitted:

- `membership-audit.ts` `TIER_RANK` (:54) and `TIER_GROUPS` (:~92): a tier
  missing from `TIER_RANK` ranks as `0` and a tier missing from `TIER_GROUPS`
  resolves to `basic`, so the Layer 6 membership audit UNDER-ENFORCES and any
  tier-ceiling check for the new tier collapses to `basic`.
- `credential-exchange.ts` `resolveRoleKey` (:107-114): a user on the new tier
  that is not handled here is vended `basic` exchange credentials, silently
  under-provisioning them.

Prefer deriving tier rank from the shared `Tier` union so a single edit covers
every consumer, rather than re-listing the tiers in each control.

### 1.2 Add the model selection slot

Pick which model `enterprise` uses by default.
`backend/lib/config/model-strategy.ts`:

```ts
export interface TierModelSelection {
  basic: BackendModelKey;
  standard: BackendModelKey;
  premium: BackendModelKey;
  enterprise: BackendModelKey;      // ← add
}

export const DEFAULT_TIER_MODEL_SELECTION: TierModelSelection = {
  basic: 'haiku',
  standard: 'sonnet',
  premium: 'opus',
  enterprise: 'opus',               // ← add
};
```

For every model in `getModelCatalog`, decide whether `enterprise` is
in its `allowedTiers`. By default it's a strict superset of premium.

### 1.3 Create the tier processor entry-point Lambda

Mirror `premium-async-processor.ts` (it's the thinnest). Copy +
rename to `backend/lambda/src/enterprise-async-processor.ts`. Set
`userType: 'enterprise'` in the config it builds; everything else
flows through `async-processor-core.ts`.

If the new tier behaves identically to an existing tier just with a
different name, a re-export is fine for now, but the moment behavior
diverges (special model routing, extra tools, different sizing), copy
the entire entry so the tier team can edit freely.

### 1.4 Create the tier stack class

Copy the closest existing class (usually `premium-tier-stack.ts`)
into `backend/lib/stacks/enterprise-tier-stack.ts` and rename:

```ts
export class EnterpriseTierStack extends cdk.Stack { ... }
```

Inside the class, change every literal `'premium'` to `'enterprise'`
(or the new tier's name). Specifically:

- `const tier = 'enterprise' as const;`
- `props.tierModelSelection.enterprise`
- `name: 'agent-echelon-enterprise-guardrail'`
- `name: 'agent-echelon-enterprise-battle-image-guardrail'` (if /battle is in scope)
- S3 prefix list: include every prefix the tier may read
  (e.g. `['context/basic/*', 'context/standard/*', 'context/premium/*', 'context/enterprise/*']`)
  on both `s3:ListBucket` and `s3:GetObject`.
- `entry: '../../lambda/src/enterprise-async-processor.ts'`
- Sizing: `timeout`, `memorySize`, `reservedConcurrentExecutions`.
  Default to a copy of the closest tier; tune later from CloudWatch.
- `BOT_NAME: 'Assistant-enterprise'`
- `Tags Component: 'Tier-Enterprise'`

Drop anything the tier doesn't need. If `enterprise` doesn't use
/battle, delete the image-guardrail block, the image-gen IAM, the
`battle-images/*` S3 grant, and the `BATTLE_*` env vars; that's the
upside of class-per-tier, you don't carry inherited dead code.

### 1.5 Wire the stack in `bin/backend.ts`

```ts
import { EnterpriseTierStack } from '../lib/stacks/enterprise-tier-stack';

const tierEnterpriseStack = new EnterpriseTierStack(app, `${STACK_PREFIX}Tier-Enterprise`, {
  ...tierSharedProps,
  description: 'enterprise-tier assistant',
});
tierEnterpriseStack.addDependency(foundationsStack);
tierEnterpriseStack.addDependency(experimentsStack);
```

Match the existing three: every tier stack is named `${STACK_PREFIX}Tier-*`,
where `STACK_PREFIX = AE_STACK_PREFIX || pascal(AE_INSTANCE_NAME)`
(`bin/backend.ts:407-415`, `agent-tier-common.ts:199`). The prefix is
INSTANCE-DERIVED, not literal: it is `AgentEchelon` only for the default
instance, and (e.g.) `Acme` for `AE_INSTANCE_NAME=acme`. Add the stack to the
deploy-order loop alongside the existing three.

### 1.6 Add a synth test

In `backend/test/cdk-synth.test.ts`, mirror the existing per-tier
test block:

```ts
it('should synthesize AgentEchelonTier-Enterprise (no Bedrock Agent)', () => {
  const app = new cdk.App();
  const stack = new EnterpriseTierStack(app, 'AgentEchelonTier-Enterprise', tierBasicProps);
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::Bedrock::Agent', 0);
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/agent-echelon/tier/enterprise/processor-arn',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/agent-echelon/tier/enterprise/bot-arn',
  });
});
```

### 1.7 Frontend tier gating

The frontend already reads `custom:tier` from the JWT and gates
the model picker by it. To surface the new tier in
`NewConversationModal`, add a card entry there. To gate the admin
button or /battle-related UI on the new tier, follow the same
pattern as the existing `isPremium` checks.

### 1.8 Deploy + verify

```bash
# <Instance> = ${STACK_PREFIX} = AE_STACK_PREFIX || pascal(AE_INSTANCE_NAME);
# AgentEchelon for the default instance.
cd backend && AWS_PROFILE=<your-profile> \
  npx cdk deploy <Instance>Tier-Enterprise --require-approval never
```

The shared router (`router-agent-handler.ts`) is already SSM-first
and will pick up `/agent-echelon/tier/enterprise/processor-arn`
without redeploy. Verify the SSM key exists:

```bash
aws ssm get-parameter --name /agent-echelon/tier/enterprise/processor-arn \
  --profile <your-profile> --query 'Parameter.Value' --output text
```

Then create an enterprise-tier channel from the UI and confirm the
processor's CloudWatch logs show its invocations.

---

## 2. Managing an existing tier's assistant

The tier team owns the entire file. The most common changes:

### 2.1 Change the model

Default model for the tier comes from `tierModelSelection` in
`bin/backend.ts`. The model itself is defined in `model-strategy.ts`
(catalog) and gated by `allowedTiers`.

To switch premium from Opus to Sonnet:

```ts
// bin/backend.ts
const tierModelSelection: TierModelSelection = {
  ...DEFAULT_TIER_MODEL_SELECTION,
  premium: 'sonnet',                  // ← override
};
```

If the new model isn't in the catalog yet, add it to `getModelCatalog`
in `model-strategy.ts` with the correct ARNs and `allowedTiers`. The
processor role's `BedrockPolicy` derives its allowed ARNs from
`modelArnsForTier`, no manual IAM update needed.

To intent-route to different models within a tier (e.g. cheap model
for greetings, expensive model for analysis), edit
`INTENT_ROUTE_STRATEGY` in `model-strategy.ts`. The `min(userTier,
channelTier)` clamp is computed in `router-agent-handler.ts` (`minTier`
at :98/:454), so a mismatched route gets downgraded before dispatch;
`model-resolver.ts` then enforces only the per-tier FLOOR (never below
the tier's default model).

### 2.2 Change the system prompt

The per-turn prompt is assembled inside the async-processor (the tier
entry, e.g. `standard-async-processor.ts`, → shared
`async-processor-core.ts`). Each turn it composes, in order:

1. **Base persona**: what the assistant *is* for this deployment
   (`resolveBaseSystemPrompt()`; see "Per-deployment persona" below).
2. **Host context sections**: registered resolvers (domain context,
   user profile, …) via the registry + composer (see
   "Context resolvers" below).
3. **Dynamic sections**: S3 knowledge, task state, RAG hints, anti-
   repeat, appended by the pipeline.
4. **Persona addendum / battle constraints**: from the bound /battle
   variant, appended last (SPEC-BATTLE.md "Prompt Addendum Sanitization").

#### Per-deployment persona + intent pack (SSM-backed, preserve-on-absent)

A rich persona/pack exceeds Lambda's 4 KB env cap, so they live in SSM
(`${SSM_ROOT}/tier/{tier}/assistant-{system-prompt,intent-pack}`); the
processor (persona) and handler (pack) hydrate them by name at cold
start. Set them at deploy via context, usually merged into
`cdk.context.json` (see your deployment's config notes):

```bash
npx cdk deploy <Instance>Tier-Standard --require-approval never \
  -c assistantTier=standard \
  -c assistantSystemPrompt="$(cat persona.txt)" \
  -c assistantIntentPack="$(cat intent-pack.json)"
```

Persona and intent pack are stored as SSM `String` (not `SecureString`), and
this deploy path routes them through shell history and, when merged, into
`cdk.context.json` (a committable file). Keep secrets OUT of persona/pack. If a
value ever must be sensitive, store it as `SecureString` and do not commit it to
`cdk.context.json`.

**Preserve-on-absent (decision 012):** the params are written by an
`AwsCustomResource` that `PutParameter`s **only when a non-empty value
is supplied** and **never deletes**. So a deploy that *omits*
`-c assistantSystemPrompt` does not blank a live persona. A
standard/premium synth with an empty persona/pack emits a loud **synth
warning** (WS1a). A *changed* value re-PUTs reliably (a content hash in
the resource's physical id busts the CFN "no changes" no-op).

#### Per-intent response settings

A pack intent may carry `maxTokens` + coarse `verbosity` ('tight' |
'normal' | 'long'). The handler forwards the classified intent's
settings in the dispatch event; the processor clamps `maxTokens` to the
tier ceiling (`CONFIG.maxTokens`) and the reasoning-turn floor. Tune
answer sizes **per intent via config, no code** (e.g. tight `logistics`,
longer `research`). See `SPEC-CONFIGURABLE-INTENT-PACK.md`.

#### Config attribution

Every turn's analytics (and every eval row / battle outcome) is stamped
with a `configId` = hash(persona + intent-pack + base system prompt) so
quality is sliceable **by config**, not just by model
(`lib/config-identity.ts`; the pack hash already covers per-intent
response settings). The stamped fields are short hashes, never the
config text.

#### Context resolvers

Host per-turn context is registered, not hardwired: a
`contextType → resolver` registry (`lib/context-framework.ts`) +
host resolvers (`lib/host-context-resolvers.ts`) the processor builds at
cold start and composes every turn via the defensive `buildSystemPrompt`
(ordered, empty-section-filtered, one throwing resolver isolated). To add
a host context section, register a resolver, don't add a `+=` branch.

To change a tier's base persona *in code* (the fallback default, used
when no SSM persona is set), edit `DEFAULT_SYSTEM_PROMPT` in the tier's
entry processor.

### 2.3 Change the guardrail

Each tier owns its own Bedrock Guardrail. The construct is
`backend/lib/constructs/bedrock-guardrails.ts` (`AgentGuardrails`).
Topic denies, regex filters, PII actions, and metadata-marker filters
are configured there.

If you change config, the construct hashes the config into the
`CfnGuardrailVersion` logical id, so a config edit *automatically*
publishes a fresh version (consumers pin to version number, so an
in-place edit would silently no-op without the hash trick).

After editing, deploy only the affected tier:

```bash
npx cdk deploy AgentEchelonTier-Premium --require-approval never
```

Verify the new version is live:

```bash
aws bedrock-runtime apply-guardrail \
  --guardrail-identifier <id> --guardrail-version <new-version> \
  --source OUTPUT --content '[{"text":{"text":"hello world"}}]' \
  --profile <your-profile>
```

`action: NONE` means clean; `action: GUARDRAIL_INTERVENED` with the
filtered text means the rule fired.

### 2.4 Change context retrieval scope

The tier's S3 read IAM defines what `load_company_context` can return.
Each tier-stack hardcodes its allowed prefixes inline (e.g. premium has
basic + standard + premium). To add a new prefix the tier may read:

```ts
// premium-tier-stack.ts ContextS3Read inline policy
conditions: {
  StringLike: {
    's3:prefix': [
      'context/basic/*',
      'context/standard/*',
      'context/premium/*',
      'context/legal/*',          // ← add
    ],
  },
},
// AND the GetObject statement:
resources: [
  `${props.attachmentsBucketArn}/context/basic/*`,
  `${props.attachmentsBucketArn}/context/standard/*`,
  `${props.attachmentsBucketArn}/context/premium/*`,
  `${props.attachmentsBucketArn}/context/legal/*`,   // ← add
],
```

The shared `loadCompanyContext` (`lambda/src/lib/company-context.ts`)
walks every prefix the IAM allows, no Lambda-side change.

### 2.5 Change sizing (timeout / memory / concurrency)

In the tier-stack file, edit the `NodejsFunction` props directly:

```ts
const asyncProcessor = new lambdaNodeJs.NodejsFunction(this, 'AsyncProcessor', {
  ...
  timeout: cdk.Duration.seconds(120),       // was 90
  memorySize: 2048,                          // was 1024
  reservedConcurrentExecutions: 30,          // was 20
  ...
});
```

Deploy only the affected tier. CloudWatch's *Duration* and
*ConcurrentExecutions* metrics for the function tell you whether the
new values fit; aim for p95 duration ≤ 70% of timeout, reserved
concurrency ≥ peak observed concurrency × 2.

### 2.6 Multiple assistants in a single tier

If you want the same tier to expose two different assistants (different
Lex bots / different AppInstanceBots / different personas), keep one
tier processor and add a second Lex+AppInstanceBot pair in the same
tier-stack:

```ts
// inside StandardTierStack, alongside the existing Lex bot block
const lexResourceB = new cdk.CustomResource(this, 'CreateLexBotResourceB', {
  serviceToken: lexProvider.serviceToken,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  properties: { tier: 'standard', botName: 'Assistant-standard-research' },
});
const botResourceB = new cdk.CustomResource(this, 'CreateBotResourceB', { ... });
```

Both AppInstanceBots route to the same `routerHandlerArn` → same async
processor. Differentiate behavior by setting different `Metadata` on
channels created by each bot (e.g. `metadata.assistantRole='research'`)
and branching in the processor.

Or, if the two assistants need genuinely different code paths and
sizing, split the tier into two stack classes (e.g. `StandardCoreTierStack`
and `StandardResearchTierStack`). The carve was designed for exactly this
kind of growth.

---

## Deploy + verification cheat sheet

```bash
# Deploy only one tier. <Instance> = ${STACK_PREFIX} = AE_STACK_PREFIX ||
# pascal(AE_INSTANCE_NAME); AgentEchelon for the default instance.
cd backend && AWS_PROFILE=<your-profile> \
  npx cdk deploy <Instance>Tier-<Tier> --require-approval never

# Confirm the tier published its SSM contract
aws ssm get-parameter --name /agent-echelon/tier/<tier>/processor-arn \
  --profile <your-profile> --query 'Parameter.Value' --output text

aws ssm get-parameter --name /agent-echelon/tier/<tier>/bot-arn \
  --profile <your-profile> --query 'Parameter.Value' --output text

# Watch the processor's logs while exercising the channel
aws logs tail /aws/lambda/<Instance>Tier-<Tier>-AsyncProcessor<...> \
  --follow --profile <your-profile>

# Confirm the synth still passes
cd backend && npx jest cdk-synth
```

If a tier deploy drifts the cross-stack export graph (rare; usually
when retiring legacy blocks), deploy the **consumer** stack alone with
`--exclusively` first to release the export, then redeploy the
producer:

```bash
npx cdk deploy <consumer> --exclusively
npx cdk deploy <producer>
```

---

## What NOT to touch from a tier file

- `agent-tier-common.ts` (the SSM contract keys). Changing a key here
  silently breaks every tier and the shared router. If you genuinely
  need a new key, add it; never rename or remove.
- `async-processor-core.ts` (the shared assistant logic). Tier
  behavior should be expressed by what the tier-stack passes in
  (model, guardrail, env, IAM), not by branching inside the core.
- The shared platform stacks (`foundations-stack.ts` for the
  task-tracking tables + create-conversation, `experiments-stack.ts`,
  `battle-stack.ts`). They publish the `/agent-echelon/shared/*` SSM
  contract every tier reads. Adding a new shared resource (e.g. another
  DynamoDB table) means publishing another SSM key there AND adding it
  to `resolveSharedSSM` AND granting it in each tier that needs it.

See [SPEC-PER-TIER-OWNERSHIP.md](../../specs/assistant-context/SPEC-PER-TIER-OWNERSHIP.md) for the
full architectural contract.
