# How to add or manage an assistant profile

A practical guide for two adjacent tasks the capability-profiles model ([SPEC-PER-PROFILE-OWNERSHIP.md](../../specs/interaction/assistant-config/SPEC-PER-PROFILE-OWNERSHIP.md)) makes routine:

1. **Add a brand-new profile** (e.g. `enterprise`) alongside the shipped `basic` / `standard` / `premium`.
2. **Manage an existing profile's assistant**: change its model, prompt, guardrail, retrieval scope, or sizing without touching the others.

The shipped platform separates the word "tier" into three config concepts (see `backend/lib/config/profiles.ts`):

- a **classification** is the channel's immutable `classification` tag value plus a declared rank (the min-cap and RAG-scope order);
- a **profile** is a named capability bundle (model, classifier mode, timeout, task depth, RAG scope, rate limit, battle eligibility) bound to a classification;
- **clearance** maps a Cognito group to the classification it clears for.

The stack topology is **profile-as-data**: one shared `AssistantProfileStack` is parametrized by a `ProfileTopology` descriptor, and each profile lives in a thin subclass (`backend/lib/stacks/{basic,standard,premium}-classification-stack.ts`) that supplies its descriptor. One shared assistant Lambda (`assistant-async-processor.ts`) serves every profile and self-gates its capabilities on the profile's env. A profile-team change edits its descriptor and ships exactly that profile.

> The architectural rationale, SSM contract, and phasing live in [SPEC-PER-PROFILE-OWNERSHIP.md](../../specs/interaction/assistant-config/SPEC-PER-PROFILE-OWNERSHIP.md). This file is the **how**.

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
│       ├── basic-classification-stack.ts           ← BasicClassificationStack: a thin ProfileTopology wrapper
│       ├── standard-classification-stack.ts        ← StandardClassificationStack
│       ├── premium-classification-stack.ts         ← PremiumClassificationStack
│       └── agent-classification-common.ts          ← shared SSM keys + thin helpers (no class)
└── lambda/src/
    ├── assistant-async-processor.ts      ← the ONE config-driven assistant (entry for every profile)
    └── lib/
        ├── async-processor-core.ts       ← shared assistant logic (Converse tool loop, /battle, etc.)
        └── company-context.ts            ← classification-scoped S3 retrieval
```

Ownership: a profile team owns its thin `*-classification-stack.ts` descriptor. The shared `assistant-profile-stack.ts` body, `assistant-async-processor.ts`, `async-processor-core.ts`, and `agent-classification-common.ts` change rarely; PRs touching them should ping every profile owner.

---

## How an assistant hears a channel

Three layers must all be in place before an assistant can take a turn. Getting one wrong produces
silence rather than an error, which is why they are listed together. What happens to a message *after*
it is routed is [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md).

| Layer | What it is | Why it exists |
|---|---|---|
| **1. Lex bot** | A Lex V2 bot with two intents - `WelcomeIntent` (fires when the bot joins) and `FallbackIntent` (the catch-all that carries every real user turn) - both with a **fulfillment code hook** pointing at that classification's handler Lambda | Lex is the **entry trigger + session**. AgentEchelon does not use Lex for NLU beyond "something was said"; request classification happens downstream in the handler. Lex provides the managed Amazon Chime SDK to Lambda bridge and the per-turn session. |
| **2. `AppInstanceBot` `InvokedBy`** | `StandardMessages: AUTO \| NONE` and `TargetedMessages: ALL` | The **routing policy**: which messages Amazon Chime SDK forwards to Lex. It is the single switch between "answer everything in this room" and "answer only when addressed". |
| **3. Channel membership** | The bot is added to the channel (`CreateChannelMembership`) as the classification-matched bot | A bot only receives messages for channels it belongs to. **Order matters:** set `InvokedBy` *before* the bot joins, or Amazon Chime SDK may not route standard messages for that channel until the membership is re-created. |

**One bot per classification.** Each runs its own Lex bot, model, guardrail and `context/{classification}/`
scope. Channel creation binds the classification-matched bot (`create-conversation`), so which assistant
is in a room is fixed to the room's `classification`.

**The `InvokedBy` switch is what makes one substrate serve several use cases:**

| Use case | `StandardMessages` | Effect |
|---|---|---|
| Private AI assistant (1:1) | `AUTO` | The assistant answers every turn |
| Shared team room | `AUTO` + `@<assistant>` mentions | The assistant answers only when addressed; humans talk freely |
| Announcement or comment thread (read-mostly) | `NONE` | The assistant stays silent unless explicitly mentioned (`TargetedMessages: ALL` still routes a mention) |

Nothing else changes between these: the channel flow, the handler, the async processor and every
enforcement layer are identical.

**`AUTO` counts OTHER NON-HIDDEN MEMBERS, and bots count.** The rule is one other member versus more than
one, from this bot's perspective, so **adding a second bot to a 1:1 flips the first bot from answering
everything to answering only mentions**, silently. A hidden membership does not avoid it, because a
hidden member cannot send messages and an assistant has to.

---

## 1. Adding a new profile

Use case: a deployer wants a fourth profile (say `enterprise`) with its own model selection, retrieval scope, guardrail, and Lex bot.

### 1.1 Add the classification + profile to config

`backend/lib/config/profiles.ts` is the single source. Add the classification (with a rank above premium), its profile, and the Cognito group that clears for it:

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

`validateProfilesConfig` runs at synth and rejects a malformed config (duplicate rank, unknown profile, `failClosedTo` that is not the lowest rank). This one edit drives the Cognito groups, the Identity-Pool auth roles, the Layer-1 IAM classification boundary, the RAG scope ladder, the rate limit, and battle eligibility, because every runtime and synth site reads through `ProfileRegistry`.

### 1.2 Add the model selection slot

Pick the profile's default model. `backend/lib/config/model-strategy.ts`:

```ts
export interface ProfileModelSelection {
  basic: BackendModelKey;
  standard: BackendModelKey;
  premium: BackendModelKey;
  enterprise: BackendModelKey;      // ← add
}

export const DEFAULT_PROFILE_MODEL_SELECTION: ProfileModelSelection = {
  basic: 'haiku', standard: 'sonnet', premium: 'opus',
  enterprise: 'opus',               // ← add
};
```

For every model in `getModelCatalog`, decide whether `enterprise` is in its `allowedClassifications`. By default it is a strict superset of premium. Also add `enterprise` to the `Classification` union in `agent-classification-common.ts` and the `Classification` union in `model-strategy.ts`.

### 1.3 Add the ProfileTopology descriptor + thin stack

There is no per-profile processor to copy: the one `assistant-async-processor.ts` serves every profile. Create `backend/lib/stacks/enterprise-classification-stack.ts` mirroring `premium-classification-stack.ts`, and supply the descriptor:

```ts
const ENTERPRISE_TOPOLOGY: ProfileTopology = {
  name: 'enterprise',
  modelSelectionKey: 'enterprise',
  timeoutSeconds: 90, memorySize: 1024, reservedConcurrency: 20, maxTokens: 4096,
  streaming: true,          // InvokeModelWithResponseStream
  imageGen: true,           // image_generation capability: models.image on normal turns + experiments/battles + image guardrail (drop if not in scope)
  contextRouting: false,    // external/CN routing (standard only, by default)
  systemPromptParam: true,  // per-deployment persona in SSM
  intentPackParam: true,    // per-deployment intent taxonomy in SSM
  richProcessor: true,      // multi-turn tasks + docs + experiments + attachment-in
  battleCapable: true,
  handlerExperimentsIndex: false,
  componentTag: 'Classification-Enterprise',
};

export class EnterpriseClassificationStack extends AssistantProfileStack {
  constructor(scope: Construct, id: string, props: EnterpriseClassificationStackProps) {
    super(scope, id, { ...props, topology: ENTERPRISE_TOPOLOGY });
  }
}
```

Every capability the profile does not want is a `false` flag, not deleted code: the shared body reads the flags, and the shared processor self-gates its code paths on the env each flag sets (a profile that sets no `ATTACHMENTS_BUCKET` / battle / context-routing env leaves those paths off, so its execution stays inside its own IAM role).

### 1.4 Wire the stack in `bin/backend.ts`

```ts
import { EnterpriseClassificationStack } from '../lib/stacks/enterprise-classification-stack';

const classificationEnterpriseStack = new EnterpriseClassificationStack(app, `${STACK_PREFIX}Classification-Enterprise`, {
  ...classificationSharedProps,
  description: 'enterprise-profile assistant',
});
classificationEnterpriseStack.addDependency(foundationsStack);
classificationEnterpriseStack.addDependency(experimentsStack);
```

Every profile stack is named `${STACK_PREFIX}Classification-*`, where `STACK_PREFIX = AE_STACK_PREFIX || pascal(AE_INSTANCE_NAME)`. The prefix is instance-derived: `AgentEchelon` for the default instance, and (e.g.) `Stratum` for `AE_INSTANCE_NAME=stratum`. Get the name exactly right: `cdk deploy` with a stack name that matches nothing **exits 0 and deploys nothing**, so a typo (or a stale `Tier-*` name) looks like a successful deploy. Run `npx cdk list` with your full context and grep the output for the stack before deploying.

### 1.5 Add a synth test

In `backend/test/cdk-synth.test.ts`, mirror the existing per-profile block:

```ts
it('should synthesize AgentEchelonClassification-Enterprise (no Bedrock Agent)', () => {
  const stack = new EnterpriseClassificationStack(new cdk.App(), 'AgentEchelonClassification-Enterprise', classificationBasicProps);
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::Bedrock::Agent', 0);
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/agent-echelon/assistant/enterprise/processor-arn' });
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/agent-echelon/assistant/enterprise/bot-arn' });
});
```

### 1.6 Frontend gating

The frontend reads `custom:tier` from the JWT and gates the model picker by it. Add a card entry in `NewConversationModal.tsx` to surface the new classification, extend its `TIER_RANK` map, and set the card's `minTier`; `canAccessClassification` compares the user's rank against the card's `minTier`, which is how profile-specific UI is gated.

### 1.7 Deploy + verify

```bash
# <Instance> = ${STACK_PREFIX}; AgentEchelon for the default instance.
cd backend && AWS_PROFILE=<your-profile> \
  npx cdk deploy <Instance>Classification-Enterprise --require-approval never
```

The shared router (`router-agent-handler.ts`) is SSM-first and picks up `/agent-echelon/assistant/enterprise/processor-arn` without a redeploy. Confirm the SSM key exists, then create an enterprise-classification channel from the UI and confirm the processor's CloudWatch logs show its invocations.

```bash
aws ssm get-parameter --name /agent-echelon/assistant/enterprise/processor-arn \
  --profile <your-profile> --query 'Parameter.Value' --output text
```

---

## 1.8 What a profile is made of, and which parts travel

A profile is not one object. It is a **compiled seed**, a **versioned definition**, and the
**infrastructure the definition selects among** - and the split between them is the whole security
model. Behaviour is data and can be edited at runtime; the boundary is infrastructure and can only be
changed by a deploy.

| Component | Where it lives | Who writes it | Travels in an export? |
|---|---|---|---|
| Profile seed (`name`, `contextScope`) | Compiled into the stack from `lib/config/profiles.ts` | Deploy | No - the target's own seed applies |
| Versioned definition (models, limits, `taskSupport`, `battleEligible`, guardrail selection, machines, plus a pointer to the persona) | SSM parameter `/<instance>/assistant/<profile>/definition`, one native SSM version per profile version | `manage-profiles` API at runtime | Yes - this IS the manifest body |
| `active` pointer | The `active` **label** on that SSM parameter | Activate / rollback | No - an import always lands as a draft |
| Draft in progress | SSM parameter `.../definition` draft slot | Create/edit draft | No |
| **Persona body** | S3, at `profiles/<profile>/<configId>/persona` in the attachments bucket; the definition holds a `personaRef` | `manage-profiles` (the only sanctioned writer), on draft save and activate | Yes - export **inlines** the body and import writes it into the target's own bucket. A pointer would name this instance's storage |
| Doc-set corpus | S3, under the classification's context prefix | Deploy or admin upload | The reference travels; the corpus does not |
| Guardrail | A Bedrock guardrail provisioned by the deploy; the definition names a **catalog selection key** (`strict`), never a resolved id | Deploy provisions, definition selects | The KEY travels; the target resolves it to its own guardrail id |
| Model | A Bedrock model in the deployment's catalog, allow-listed in the handler role | Deploy provisions, definition selects | The key travels; import REJECTS a model the target does not provision |
| Context sources | Keys published in the classification's context-source catalog | Deploy publishes, definition selects | The key travels; import rejects an unpublished key |
| **Handler IAM role** | The per-classification stack (`AgentHandlerRole`) | **Deploy only** | **Never** |
| Task machines (`machines`) | Inside the versioned definition | `manage-profiles` API | Yes |

### Why the IAM role is not part of the profile

The role is what makes the rest safe to edit at runtime. It grants `bedrock:InvokeModel` on the
allow-listed models, `ssm:GetParameter` on that profile's own parameters, and S3 reads scoped to the
classification's prefix - and a profile version cannot alter any of it. So the worst an activated
version can do is select a different option the deployment already provisioned and already permitted.

That is why an export carries a guardrail's *selection key* rather than the id this instance resolved
it to: a resolved id names nothing on any other account, so a manifest carrying one could not be
imported anywhere. It is also why import is fail-closed - a manifest naming a model, guardrail, or
context key the target does not provision is rejected with the valid keys named, rather than landing
a definition that would fail at the first turn.

### How the pieces resolve at a turn

1. The handler reads `/<instance>/assistant/<profile>/definition:active` (label, not version number).
2. Missing or unparseable, it serves the **compiled seed** - fail-closed, never a partial definition.
3. Boundary fields (`name`, `contextScope`) always come from the seed, whatever the version says.
4. Everything else - persona, model, limits, guardrail selection, machines - comes from the version. The
   persona is fetched from S3 via the version's `personaRef` (cached per warm container with the rest of
   the resolution) unless the version carries it inline, which is the shape written before the pointer
   existed. A version with no persona at all falls back to the per-deployment seam in 2.2.
5. The role decides whether the selected model, guardrail, and prefix are actually reachable.

The practical consequence: **a profile version is portable because it contains only selections.** Move
it to another instance and it re-resolves against that instance's catalog, guardrails, and role. Move
infrastructure and you have moved nothing a version can see.

---

## 2. Managing an existing profile's assistant

The profile team owns its thin descriptor file. The most common changes:

### 2.0 How a version becomes live, and when

A profile is a set of immutable versions plus one `active` pointer. Nothing edits a live version in place, and nothing activates itself.

The sequence:

1. **Create a draft** (`Assistants > Profiles`, or `POST /profiles/version`). The draft starts as a copy of the active version.
2. **Edit the draft**, then **validate** it. Validation checks the schema, the model/ARN boundary, the published context-source catalog, and the SSM size limit.
3. **Activate.** A new immutable version is written and the `active` pointer moves onto it. Activation re-runs validation itself, because a caller can skip the validate step. **No deploy, no restart.**
4. **Rollback** moves the `active` pointer onto an existing version. It writes no new content, so rolling back is as cheap as activating and the version you left is still there.

**Importing never activates.** A manifest lands as a *draft*, always, so bringing a profile in from another instance cannot change what serves traffic. Promotion stays a human step.

**Timing.** The `active` pointer is resolved per turn and cached per warm handler, so an activation - or a rollback - converges **within about 30 seconds**. It applies to the next TURN, not the next conversation: an existing conversation picks up the new persona, model, or limits mid-thread, with no reconnect and no interruption to a reply already in flight. Backing out a bad activation has the same ~30-second tail.

**What activation can and cannot change.** Only the runtime-editable subset moves with a version. Boundary fields - the profile's `name` and `contextScope` - always come from the compiled seed, and resolution is fail-closed: if a version cannot be read or parsed, the handler serves the pure seed rather than a partial definition. So a version can change how an assistant behaves, but it cannot widen what it is allowed to reach.

**Interaction with experiments.** While an A/B experiment is live for a classification, it takes precedence over the active profile for the model it governs. When that experiment ends, traffic falls back to whatever version is active *then* - see [A/B testing and battles](../admin/GUIDE-AB-TESTING-AND-BATTLES.md#when-a-change-takes-effect), which covers the experiment side and its separate ~60-second convergence.

### 2.1 Change the model

The default model comes from `profileModelSelection` in `bin/backend.ts`; the model itself is defined in `model-strategy.ts` (catalog) and gated by `allowedClassifications`.

```ts
// bin/backend.ts
const profileModelSelection: ProfileModelSelection = {
  ...DEFAULT_PROFILE_MODEL_SELECTION,
  premium: 'sonnet',                  // ← override
};
```

If the new model is not in the catalog, add it to `getModelCatalog` with the correct ARNs and `allowedClassifications`. The processor role's `BedrockPolicy` derives its allowed ARNs from `modelArnsForClassification`, so there is no manual IAM update.

To intent-route within a profile (cheap model for greetings, expensive for analysis), edit `INTENT_ROUTE_STRATEGY` in `model-strategy.ts`. The min-cap clamp, `min(callerClearance, channelClassification)`, is resolved through `ProfileRegistry` in `router-agent-handler.ts`, so a mismatched route is downgraded before dispatch; `model-resolver.ts` then checks `allowedClassifications` on both the primary and the fallback model (an unallowed model falls back to the classification default) and enforces the classification floor, so a non-trivial intent never resolves below the classification's default model.

### 2.2 Change the system prompt

The per-turn prompt is assembled inside `assistant-async-processor.ts` (which calls the shared `async-processor-core.ts`). Each turn it composes, in order:

1. **Base persona**, resolved from the first of these that has one:
   1. the **active profile version's** persona - the no-deploy path, edited in the admin Profiles tab or
      through `manage-profiles`, stored in S3 and reached by the definition's `personaRef` (§1's table).
      This is the one to change if you want a persona you can version, roll back, and export;
   2. the **per-deployment** persona parameter (`resolveBaseSystemPrompt()`; see "Per-deployment persona"
      below), which is the deploy-time seam and the fallback when a version carries no persona;
   3. the profile's **built-in** persona keyed by `PROFILE_NAME`, compiled into the code.
2. **Host context sections**: registered resolvers (domain context, user profile) via the registry + composer.
3. **Dynamic sections**: S3 knowledge, task state, RAG hints, anti-repeat, appended by the pipeline.
4. **Persona addendum / battle constraints**: from the bound /battle variant, appended last.

#### Per-deployment persona + intent pack (SSM-backed, preserve-on-absent)

A rich persona/pack exceeds Lambda's 4 KB env cap, so they live in SSM (`${SSM_ROOT}/assistant/{profile}/assistant-{system-prompt,intent-pack}`); the processor (persona) and handler (pack) hydrate them by name at cold start. Set them at deploy via context:

```bash
npx cdk deploy <Instance>Classification-Standard --require-approval never \
  -c assistantSystemPrompt="$(cat persona.txt)" \
  -c assistantIntentPack="$(cat intent-pack.json)"
```

The persona param exists for `systemPromptParam` profiles; the intent pack for `intentPackParam` profiles. Both are stored as SSM `String` (not `SecureString`), and this path routes them through shell history and, when merged, into `cdk.context.json` (a committable file). Keep secrets OUT of persona/pack.

**Preserve-on-absent (decision 012):** an `AwsCustomResource` writes the params only when a non-empty value is supplied and never deletes, so a deploy that omits the context does not blank a live persona. A profile that carries `systemPromptParam` with an empty persona emits a loud synth warning. A changed value re-PUTs reliably (a content hash in the resource's physical id busts the CFN no-op).

#### Config attribution

Every turn's analytics is stamped with a `configId` = hash(persona + intent-pack + base system prompt) so quality is sliceable by config, not just by model (`lib/config-identity.ts`). The stamped fields are short hashes, never the config text.

To change a profile's built-in persona in code - the last fallback, used only when neither the active version nor the per-deployment parameter supplies one - edit the profile's entry in `DEFAULT_PROMPTS` in `assistant-async-processor.ts`.

### 2.3 Change the guardrail

Each profile owns its own Bedrock Guardrail (construct `backend/lib/constructs/bedrock-guardrails.ts`, `AgentGuardrails`). Topic denies, regex filters, PII actions, and metadata-marker filters are configured there. The construct hashes its config into the `CfnGuardrailVersion` logical id, so a config edit automatically publishes a fresh version. Deploy only the affected profile, then verify with `aws bedrock-runtime apply-guardrail`.

### 2.4 Change context retrieval scope

The profile's S3 read IAM defines what `load_company_context` can return. The `AssistantProfileStack` derives the allowed prefixes from `classificationsAllowedFor` (the `ProfileRegistry` scope ladder), so a profile reads `context/{classifications at or below its rank}/*`. To widen or narrow the scope, change the classification ranks in `profiles.ts`; there is no per-stack prefix list to hand-edit. The shared `loadCompanyContext` walks every prefix the IAM allows, with no Lambda-side change.

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

Deploy only the affected profile. CloudWatch Duration and ConcurrentExecutions tell you whether the values fit; aim for p95 duration <= 70% of timeout and reserved concurrency
> = peak observed concurrency x 2.

### 2.6 Change a capability

Turn a capability on or off through the `ProfileTopology` flags (`contextRouting`, `systemPromptParam`, `intentPackParam`, `richProcessor`, `imageGen`, `streaming`, `battleCapable`). The shared stack body wires the matching resources + IAM, and the shared processor self-gates the runtime path on the env the flag sets. Express divergence through the descriptor, never by branching the shared body or the shared processor.

---

## Deploy + verification cheat sheet

```bash
# Deploy only one profile. <Instance> = ${STACK_PREFIX}; AgentEchelon for the default instance.
# A stack name that matches nothing exits 0 and deploys NOTHING; verify with `npx cdk list` first.
cd backend && AWS_PROFILE=<your-profile> \
  npx cdk deploy <Instance>Classification-<Profile> --require-approval never

# Confirm the profile published its SSM contract
aws ssm get-parameter --name /agent-echelon/assistant/<profile>/processor-arn \
  --profile <your-profile> --query 'Parameter.Value' --output text
aws ssm get-parameter --name /agent-echelon/assistant/<profile>/bot-arn \
  --profile <your-profile> --query 'Parameter.Value' --output text

# Watch the processor's logs while exercising the channel
aws logs tail /aws/lambda/<Instance>Classification-<Profile>-AsyncProcessor<...> \
  --follow --profile <your-profile>

# Confirm the synth still passes
cd backend && npx jest cdk-synth
```

---

## What NOT to touch from a profile file

- `agent-classification-common.ts` (the SSM contract keys). Changing a key here silently breaks every profile and the shared router. Add a key if you genuinely need one; never rename or remove.
- `assistant-profile-stack.ts` (the shared stack body) and `assistant-async-processor.ts` (the shared assistant). Profile behavior is expressed by the `ProfileTopology` a thin stack passes in, not by branching the shared body or processor.
- `async-processor-core.ts` (the shared assistant logic).
- The shared platform stacks (`foundations-stack.ts`, `experiments-stack.ts`, `battle-stack.ts`). They publish the `/agent-echelon/shared/*` SSM contract every profile reads. Adding a shared resource means publishing another SSM key there AND adding it to `resolveSharedSSM` AND granting it in each profile that needs it.

See [SPEC-PER-PROFILE-OWNERSHIP.md](../../specs/interaction/assistant-config/SPEC-PER-PROFILE-OWNERSHIP.md) for the full architectural contract.
