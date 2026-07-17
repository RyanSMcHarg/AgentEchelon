# How to add or manage an assistant profile

A practical guide for two adjacent tasks the capability-profiles model
([SPEC-PER-TIER-OWNERSHIP.md](../../specs/assistant-context/SPEC-PER-TIER-OWNERSHIP.md))
makes routine:

1. **Add a brand-new profile** (e.g. `enterprise`) alongside the shipped
   `basic` / `standard` / `premium`.
2. **Manage an existing profile's assistant**: change its model, prompt,
   guardrail, retrieval scope, or sizing without touching the others.

The shipped platform separates the word "tier" into three config concepts
(see `backend/lib/config/profiles.ts`):

- a **classification** is the channel's immutable `classification` tag value plus a
  declared rank (the min-cap and RAG-scope order);
- a **profile** is a named capability bundle (model, classifier mode, timeout, task
  depth, RAG scope, rate limit, battle eligibility) bound to a classification;
- **clearance** maps a Cognito group to the classification it clears for.

The stack topology is **profile-as-data**: one shared
`AssistantProfileStack` is parametrized by a `ProfileTopology` descriptor, and each
profile lives in a thin subclass
(`backend/lib/stacks/{basic,standard,premium}-tier-stack.ts`) that supplies its
descriptor. One shared assistant Lambda (`assistant-async-processor.ts`) serves every
profile and self-gates its capabilities on the profile's env. A profile-team change
edits its descriptor and ships exactly that profile.

> The architectural rationale, SSM contract, and phasing live in
> [SPEC-PER-TIER-OWNERSHIP.md](../../specs/assistant-context/SPEC-PER-TIER-OWNERSHIP.md). This file
> is the **how**.

---

## Map of moving parts

```
backend/
├── bin/backend.ts                        ← composition root; instantiates each profile stack
├── lib/
│   ├── config/
│   │   ├── profiles.ts                    ← classifications + profiles + groupClearance (the config)
│   │   └── model-strategy.ts             ← model catalog + per-profile model selection
│   ├── profile-registry.ts               ← the ONLY interpreter of a classification tag / clearance
│   └── stacks/
│       ├── assistant-profile-stack.ts    ← AssistantProfileStack + ProfileTopology (the shared body)
│       ├── basic-tier-stack.ts           ← BasicTierStack: a thin ProfileTopology wrapper
│       ├── standard-tier-stack.ts        ← StandardTierStack
│       ├── premium-tier-stack.ts         ← PremiumTierStack
│       └── agent-tier-common.ts          ← shared SSM keys + thin helpers (no class)
└── lambda/src/
    ├── assistant-async-processor.ts      ← the ONE config-driven assistant (entry for every profile)
    └── lib/
        ├── async-processor-core.ts       ← shared assistant logic (Converse tool loop, /battle, etc.)
        └── company-context.ts            ← classification-scoped S3 retrieval
```

Ownership: a profile team owns its thin `*-tier-stack.ts` descriptor. The shared
`assistant-profile-stack.ts` body, `assistant-async-processor.ts`,
`async-processor-core.ts`, and `agent-tier-common.ts` change rarely; PRs touching them
should ping every profile owner.

---

## 1. Adding a new profile

Use case: a deployer wants a fourth profile (say `enterprise`) with its own model
selection, retrieval scope, guardrail, and Lex bot.

### 1.1 Add the classification + profile to config

`backend/lib/config/profiles.ts` is the single source. Add the classification (with a
rank above premium), its profile, and the Cognito group that clears for it:

```ts
classifications: [
  { value: 'basic', rank: 1, profile: 'basic' },
  { value: 'standard', rank: 2, profile: 'standard' },
  { value: 'premium', rank: 3, profile: 'premium' },
  { value: 'enterprise', rank: 4, profile: 'enterprise' },     // ← add
],
profiles: [
  // ...basic/standard/premium...
  { name: 'enterprise', modelKey: 'opus', classifierMode: 'llm', timeoutSeconds: 90,
    taskSupport: 'full', contextScope: 'own-rank-and-below', rateLimitPerHour: 480, battleEligible: true },
],
groupClearance: { basic: 'basic', standard: 'standard', premium: 'premium', enterprise: 'enterprise' },
```

`validateProfilesConfig` runs at synth and rejects a malformed config (duplicate rank,
unknown profile, `failClosedTo` that is not the lowest rank). This one edit drives the
Cognito groups, the Identity-Pool auth roles, the Layer-1 IAM classification boundary,
the RAG scope ladder, the rate limit, and battle eligibility, because every runtime and
synth site reads through `ProfileRegistry`.

### 1.2 Add the model selection slot

Pick the profile's default model. `backend/lib/config/model-strategy.ts`:

```ts
export interface TierModelSelection {
  basic: BackendModelKey;
  standard: BackendModelKey;
  premium: BackendModelKey;
  enterprise: BackendModelKey;      // ← add
}

export const DEFAULT_TIER_MODEL_SELECTION: TierModelSelection = {
  basic: 'haiku', standard: 'sonnet', premium: 'opus',
  enterprise: 'opus',               // ← add
};
```

For every model in `getModelCatalog`, decide whether `enterprise` is in its
`allowedTiers`. By default it is a strict superset of premium. Also add `enterprise`
to the `Tier` union in `agent-tier-common.ts` and the `ModelTier` union in
`model-strategy.ts`.

### 1.3 Add the ProfileTopology descriptor + thin stack

There is no per-profile processor to copy: the one `assistant-async-processor.ts`
serves every profile. Create `backend/lib/stacks/enterprise-tier-stack.ts` mirroring
`premium-tier-stack.ts`, and supply the descriptor:

```ts
const ENTERPRISE_TOPOLOGY: ProfileTopology = {
  name: 'enterprise',
  modelSelectionKey: 'enterprise',
  timeoutSeconds: 90, memorySize: 1024, reservedConcurrency: 20, maxTokens: 4096,
  streaming: true,          // InvokeModelWithResponseStream
  imageGen: true,           // /battle image generation-out + image guardrail (drop if not in scope)
  contextRouting: false,    // external/CN routing (standard only, by default)
  systemPromptParam: true,  // per-deployment persona in SSM
  intentPackParam: true,    // per-deployment intent taxonomy in SSM
  richProcessor: true,      // multi-turn tasks + docs + experiments + attachment-in
  battleCapable: true,
  handlerExperimentsIndex: false,
  componentTag: 'Tier-Enterprise',
};

export class EnterpriseTierStack extends AssistantProfileStack {
  constructor(scope: Construct, id: string, props: EnterpriseTierStackProps) {
    super(scope, id, { ...props, topology: ENTERPRISE_TOPOLOGY });
  }
}
```

Every capability the profile does not want is a `false` flag, not deleted code: the
shared body reads the flags, and the shared processor self-gates its code paths on the
env each flag sets (a profile that sets no `ATTACHMENTS_BUCKET` / battle / context-routing
env leaves those paths off, so its execution stays inside its own IAM role).

### 1.4 Wire the stack in `bin/backend.ts`

```ts
import { EnterpriseTierStack } from '../lib/stacks/enterprise-tier-stack';

const tierEnterpriseStack = new EnterpriseTierStack(app, `${STACK_PREFIX}Tier-Enterprise`, {
  ...tierSharedProps,
  description: 'enterprise-profile assistant',
});
tierEnterpriseStack.addDependency(foundationsStack);
tierEnterpriseStack.addDependency(experimentsStack);
```

Every profile stack is named `${STACK_PREFIX}Tier-*`, where
`STACK_PREFIX = AE_STACK_PREFIX || pascal(AE_INSTANCE_NAME)`. The prefix is
instance-derived: `AgentEchelon` for the default instance, and (e.g.) `Acme` for
`AE_INSTANCE_NAME=acme`.

### 1.5 Add a synth test

In `backend/test/cdk-synth.test.ts`, mirror the existing per-profile block:

```ts
it('should synthesize AgentEchelonTier-Enterprise (no Bedrock Agent)', () => {
  const stack = new EnterpriseTierStack(new cdk.App(), 'AgentEchelonTier-Enterprise', tierBasicProps);
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::Bedrock::Agent', 0);
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/agent-echelon/assistant/enterprise/processor-arn' });
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/agent-echelon/assistant/enterprise/bot-arn' });
});
```

### 1.6 Frontend gating

The frontend reads `custom:tier` from the JWT and gates the model picker by it. Add a
card entry in `NewConversationModal` to surface the new classification, and follow the
existing `isPremium` pattern to gate any profile-specific UI.

### 1.7 Deploy + verify

```bash
# <Instance> = ${STACK_PREFIX}; AgentEchelon for the default instance.
cd backend && AWS_PROFILE=<your-profile> \
  npx cdk deploy <Instance>Tier-Enterprise --require-approval never
```

The shared router (`router-agent-handler.ts`) is SSM-first and picks up
`/agent-echelon/assistant/enterprise/processor-arn` without a redeploy. Confirm the SSM
key exists, then create an enterprise-classification channel from the UI and confirm the
processor's CloudWatch logs show its invocations.

```bash
aws ssm get-parameter --name /agent-echelon/assistant/enterprise/processor-arn \
  --profile <your-profile> --query 'Parameter.Value' --output text
```

---

## 2. Managing an existing profile's assistant

The profile team owns its thin descriptor file. The most common changes:

### 2.1 Change the model

The default model comes from `tierModelSelection` in `bin/backend.ts`; the model itself
is defined in `model-strategy.ts` (catalog) and gated by `allowedTiers`.

```ts
// bin/backend.ts
const tierModelSelection: TierModelSelection = {
  ...DEFAULT_TIER_MODEL_SELECTION,
  premium: 'sonnet',                  // ← override
};
```

If the new model is not in the catalog, add it to `getModelCatalog` with the correct
ARNs and `allowedTiers`. The processor role's `BedrockPolicy` derives its allowed ARNs
from `modelArnsForTier`, so there is no manual IAM update.

To intent-route within a profile (cheap model for greetings, expensive for analysis),
edit `INTENT_ROUTE_STRATEGY` in `model-strategy.ts`. The min-cap clamp,
`min(callerClearance, channelClassification)`, is resolved through `ProfileRegistry` in
`router-agent-handler.ts`, so a mismatched route is downgraded before dispatch;
`model-resolver.ts` then enforces only the per-profile floor.

### 2.2 Change the system prompt

The per-turn prompt is assembled inside `assistant-async-processor.ts` (which calls the
shared `async-processor-core.ts`). Each turn it composes, in order:

1. **Base persona**: what the assistant is for this deployment
   (`resolveBaseSystemPrompt()`; see "Per-deployment persona" below), defaulting to the
   profile's built-in persona keyed by `PROFILE_NAME`.
2. **Host context sections**: registered resolvers (domain context, user profile) via
   the registry + composer.
3. **Dynamic sections**: S3 knowledge, task state, RAG hints, anti-repeat, appended by
   the pipeline.
4. **Persona addendum / battle constraints**: from the bound /battle variant, appended
   last.

#### Per-deployment persona + intent pack (SSM-backed, preserve-on-absent)

A rich persona/pack exceeds Lambda's 4 KB env cap, so they live in SSM
(`${SSM_ROOT}/assistant/{profile}/assistant-{system-prompt,intent-pack}`); the processor
(persona) and handler (pack) hydrate them by name at cold start. Set them at deploy via
context:

```bash
npx cdk deploy <Instance>Tier-Standard --require-approval never \
  -c assistantSystemPrompt="$(cat persona.txt)" \
  -c assistantIntentPack="$(cat intent-pack.json)"
```

The persona param exists for `systemPromptParam` profiles; the intent pack for
`intentPackParam` profiles. Both are stored as SSM `String` (not `SecureString`), and
this path routes them through shell history and, when merged, into `cdk.context.json` (a
committable file). Keep secrets OUT of persona/pack.

**Preserve-on-absent (decision 012):** an `AwsCustomResource` writes the params only when
a non-empty value is supplied and never deletes, so a deploy that omits the context does
not blank a live persona. A profile that carries `systemPromptParam` with an empty
persona emits a loud synth warning. A changed value re-PUTs reliably (a content hash in
the resource's physical id busts the CFN no-op).

#### Config attribution

Every turn's analytics is stamped with a `configId` = hash(persona + intent-pack + base
system prompt) so quality is sliceable by config, not just by model
(`lib/config-identity.ts`). The stamped fields are short hashes, never the config text.

To change a profile's built-in persona in code (the fallback default, used when no SSM
persona is set), edit the profile's entry in `DEFAULT_PROMPTS` in
`assistant-async-processor.ts`.

### 2.3 Change the guardrail

Each profile owns its own Bedrock Guardrail (construct
`backend/lib/constructs/bedrock-guardrails.ts`, `AgentGuardrails`). Topic denies, regex
filters, PII actions, and metadata-marker filters are configured there. The construct
hashes its config into the `CfnGuardrailVersion` logical id, so a config edit
automatically publishes a fresh version. Deploy only the affected profile, then verify
with `aws bedrock-runtime apply-guardrail`.

### 2.4 Change context retrieval scope

The profile's S3 read IAM defines what `load_company_context` can return. The
`AssistantProfileStack` derives the allowed prefixes from `classificationsAllowedFor`
(the `ProfileRegistry` scope ladder), so a profile reads `context/{classifications at or
below its rank}/*`. To widen or narrow the scope, change the classification ranks in
`profiles.ts`; there is no per-stack prefix list to hand-edit. The shared
`loadCompanyContext` walks every prefix the IAM allows, with no Lambda-side change.

### 2.5 Change sizing (timeout / memory / concurrency / token ceiling)

Edit the profile's `ProfileTopology` in its thin stack file:

```ts
const PREMIUM_TOPOLOGY: ProfileTopology = {
  // ...
  timeoutSeconds: 120,        // was 90
  memorySize: 2048,           // was 1024
  reservedConcurrency: 30,    // was 20
  maxTokens: 4096,            // the response ceiling (MAX_TOKENS env)
  // ...
};
```

Deploy only the affected profile. CloudWatch Duration and ConcurrentExecutions tell you
whether the values fit; aim for p95 duration <= 70% of timeout and reserved concurrency
>= peak observed concurrency x 2.

### 2.6 Change a capability

Turn a capability on or off through the `ProfileTopology` flags
(`contextRouting`, `systemPromptParam`, `intentPackParam`, `richProcessor`, `imageGen`,
`streaming`, `battleCapable`). The shared stack body wires the matching resources + IAM,
and the shared processor self-gates the runtime path on the env the flag sets. Express
divergence through the descriptor, never by branching the shared body or the shared
processor.

---

## Deploy + verification cheat sheet

```bash
# Deploy only one profile. <Instance> = ${STACK_PREFIX}; AgentEchelon for the default instance.
cd backend && AWS_PROFILE=<your-profile> \
  npx cdk deploy <Instance>Tier-<Profile> --require-approval never

# Confirm the profile published its SSM contract
aws ssm get-parameter --name /agent-echelon/assistant/<profile>/processor-arn \
  --profile <your-profile> --query 'Parameter.Value' --output text
aws ssm get-parameter --name /agent-echelon/assistant/<profile>/bot-arn \
  --profile <your-profile> --query 'Parameter.Value' --output text

# Watch the processor's logs while exercising the channel
aws logs tail /aws/lambda/<Instance>Tier-<Profile>-AsyncProcessor<...> \
  --follow --profile <your-profile>

# Confirm the synth still passes
cd backend && npx jest cdk-synth
```

---

## What NOT to touch from a profile file

- `agent-tier-common.ts` (the SSM contract keys). Changing a key here silently breaks
  every profile and the shared router. Add a key if you genuinely need one; never rename
  or remove.
- `assistant-profile-stack.ts` (the shared stack body) and `assistant-async-processor.ts`
  (the shared assistant). Profile behavior is expressed by the `ProfileTopology` a thin
  stack passes in, not by branching the shared body or processor.
- `async-processor-core.ts` (the shared assistant logic).
- The shared platform stacks (`foundations-stack.ts`, `experiments-stack.ts`,
  `battle-stack.ts`). They publish the `/agent-echelon/shared/*` SSM contract every
  profile reads. Adding a shared resource means publishing another SSM key there AND
  adding it to `resolveSharedSSM` AND granting it in each profile that needs it.

See [SPEC-PER-TIER-OWNERSHIP.md](../../specs/assistant-context/SPEC-PER-TIER-OWNERSHIP.md) for the
full architectural contract.
