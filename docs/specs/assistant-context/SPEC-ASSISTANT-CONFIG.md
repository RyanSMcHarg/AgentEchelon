# Assistant Configuration - what the assistant *is*, per experience

**Status:** In progress (unification underway). The per-classification config seams shipped; the unified
`AssistantConfig` bundle is now landing on the **versioned profile definition** (SPEC-PORTABLE-VERSIONED-PROFILES).
As of U1 the versioned definition carries a per-profile **`models` bundle** (`default` + optional
`classifier` / `complex` / `byIntent` overrides), a per-profile **`tools`** surface, and a **`guardrailId`**
selection - so **model selection is PROFILE-level, not a global strategy table**. U1 landed the schema
additively and byte-identically (the seed sets `models.default` = the base model; resolution still reads
the legacy path); U2 migrates resolution to read `models.byIntent` / `models.classifier` from the active
profile version and seeds `byIntent` from the retiring global `model-strategy` table.

> **Model selection is per-profile, with classification-level DEFAULTS.** The former global
> `IntentRouteDefinition[]` table (one strategy shared by every profile) gave the wrong level of control:
> a portable, versioned assistant must decide its OWN per-intent models. So **per-intent routing +
> classifier + base override live on the profile version** (`models.byIntent` / `models.classifier` /
> `models.default`), bounded by the classification's `bedrock:InvokeModel` allowlist (the security
> ceiling). What stays at the CLASSIFICATION level are the **defaults**: the default base model per
> classification (`DEFAULT_PROFILE_MODEL_SELECTION`) and the default classifier model (Haiku /
> `CLASSIFIER_MODEL`). A profile that wants a default records it **explicitly** as the sentinel value
> `'default'` rather than leaving the field absent. The distinction is deliberate: `'default'` is a
> visible, self-documenting choice to **follow the classification-set model as it changes over time**,
> whereas materializing today's concrete key would silently pin the profile to a snapshot. So the seed
> writes `models.classifier: 'default'` (never the bare Haiku key); resolution treats `'default'` exactly
> like unset (falls back to the classification default) and the write-path allowlist check skips it, since
> it names no catalog model. A per-intent override falls back to the base; a per-intent `'default'` primary
> means "use the base for this intent". Consequence: the admin
> **Model Strategy** surface is NOT retired but **repurposed** - it shows the *available* model catalog
> and the *per-classification defaults* (the fallback values); everything profile-specific (per-intent,
> classifier, base override, tools, guardrail) is seen and edited at the profile level.


**What's built:** the per-tier assistant capabilities (model strategy, per-tier guardrail/context scope, the Converse tool loop) and the two externalised config seams - persona (`ASSISTANT_SYSTEM_PROMPT`) and intent taxonomy (`ASSISTANT_INTENT_PACK`) - plus the `configId` fingerprint (`buildConfigIdentity`, `lib/config-identity.ts`) that hashes the running config for quality attribution. The **unified `AssistantConfig` bundle** a conversation type selects is the **design target**. The **Assistant Configuration** pillar of the interaction layer (`docs/specs/conversation-messaging/SPEC-INTERACTION-LAYER.md` is the map). Today the settings live across `model-strategy.ts` and the per-tier stacks; this spec gives them a home.

**Related:** `docs/specs/conversation-messaging/SPEC-INTERACTION-LAYER.md` (the model) · `docs/specs/conversation-messaging/SPEC-CONVERSATION-TYPES.md` (selects an assistant via `defaultAgents`) · `docs/specs/identity-access/SPEC-CREDENTIAL-EXCHANGE.md` (the assistant is also an identity) · `backend/lib/config/model-strategy.ts` · `backend/lambda/src/lib/async-processor-core.ts` (the Converse tool loop) · `backend/lib/constructs/bedrock-guardrails.ts`.

---

## 1. Why

Different experiences need different assistants. A triage assistant is trained on runbooks and reaches observability data; a sales assistant knows the catalog and the account; a basic-tier chat assistant is a cheap, fast generalist. **What the assistant *is*** - its model, system prompt, tools, guardrail, and the context it can read - should be **configuration a conversation type selects**, not behavior wired per code path. Then a new experience gets the right assistant by naming it, not by forking the agent loop.

## 2. Who benefits

- **The business** tailors the assistant per experience (prompt, model, tools, guardrail) without editing orchestration code.
- **Customers & internal users** get an assistant that actually fits the conversation they're in.
- **Operators** see one place that defines each assistant's model, cost, and capabilities.

## 3. Experiences enabled

- A **cost-control tier** chat assistant (fast/cheap model, general prompt) vs a **premium** one (stronger model, deeper context).
- A **triage** assistant (runbook prompt, `fetchContext` tool for live data, incident-shaped guardrail).
- A **support** assistant (product knowledge, case-creation tool) distinct from a **sales** assistant.

## 4. The model

An assistant configuration is the bundle a conversation type's `defaultAgents` resolves to:

```ts
interface AssistantConfig {
  id: string;
  model: {
    default?: string;                      // base model; blank or 'default' => the classification default
    classifier?: string;                   // LLM intent-classifier model; seeded as the 'default' sentinel
                                           //   (explicit choice to follow the classification-set classifier)
    complex?: string;                      // heavier model for complex turns
    byIntent?: Record<string, { primary: string; fallback?: string }>; // PER-PROFILE per-intent overrides
                                           //   (replaces the global strategy table; carries the fallback too)
  };
  systemPrompt: string;          // S3 key or inline template (kept out of code)
  tools: string[];               // the Converse tool surface (e.g. load_context, schedule, syncRecord)
  guardrailId: string;           // the content guardrail applied out-of-band on the final reply
  contextScope: string;          // which company-context the assistant may read (S3 prefix / classification)
  maxTokensPerResponse?: number;
  rateLimits?: { perUser: number; global: number };
}
```

Each assistant runs the **self-hosted Converse tool loop** (`async-processor-core.ts`): intent classification → per-intent model selection → optional tool calls → out-of-band guardrail on the final reply. The tool surface (`tools`) is the same schema the loop exposes; adding a tool is a config + a tool implementation, not an orchestration rewrite.

## 5. How it composes with the other pillars

- **← Conversation Configuration** selects the assistant via `defaultAgents`; the experience decides which assistant participates.
- **→ Identity & Access:** an assistant is **also an identity** - it acts as its own per-tier assistant identity (bearing an assistant identity, never a user), classification-gated like every actor, bearer-pinned (`SPEC-CREDENTIAL-EXCHANGE.md` §7). So Assistant Configuration defines *behavior*; Identity defines *what it may do as a principal*. The two together fully describe the assistant.
- **→ Connectors:** an assistant's `tools` can include connector-backed actions (`syncRecord`, `fetchContext`) that the conversation type's `connectors[]` make available.

## 6. Security

- **Guardrail per assistant** - applied out-of-band on the final reply (a transient guardrail outage must fail *open*, never drop a reply). Default guardrail must not over-block legitimate technical answers; the real data boundary is the context IAM, not the prompt.
- **Context scope is IAM, not prompt** - the assistant's role grants `s3:GetObject` only on its `contextScope` prefix; out-of-scope reads get AccessDenied. The boundary is infrastructure.
- **Assistant identity** is bearer-pinned to an assistant identity (never a user ARN), so a compromised or buggy assistant cannot impersonate a person.

## 7. Where we are

- **Built (as code/CDK, not yet a config bundle):** per-profile assistants - `model-strategy.ts` (`TierModelSelection`, the intent→model strategy), the shared `assistant-profile-stack.ts` (thin per-profile subclasses supply a `ProfileTopology`; each profile owns its guardrail and context S3 scope) served by the one shared `assistant-async-processor.ts`, and the self-hosted Converse tool loop. So the *capabilities* exist; what's missing is the **`AssistantConfig` bundle** a conversation type selects.
- **Built - per-deployment config seams (the precursors to the bundle):** the **persona** (`systemPrompt`) via `ASSISTANT_SYSTEM_PROMPT` / `-c assistantSystemPrompt`, and the **intent taxonomy** via `ASSISTANT_INTENT_PACK` / `-c assistantIntentPack` (`docs/specs/assistant-context/SPEC-CONFIGURABLE-INTENT-PACK.md`). These are two fields of the eventual `AssistantConfig`, already externalised from code as deploy-time config - a deployment defines *what its assistant is* (persona + intents) without forking the agent loop. Folding them into the named bundle is the remaining step.
- **Built - config fingerprint:** `buildConfigIdentity` (`lib/config-identity.ts`) hashes the assembled config (persona + intent pack + per-intent response settings) into a `configId`, so quality can be sliced by which configuration produced it. This is the attribution key the eventual bundle would carry.
- **Target:** lift the scattered per-tier settings into named `AssistantConfig`s referenced by `ConversationTypeConfig.defaultAgents`, so a new experience picks an assistant by name.

## 8. Open questions

- Where the config lives (a registry in code like `conversation-types.ts`, or deploy-time config) and how the system prompt is stored (S3 vs inline) + versioned.
- Whether multiple assistants can be enrolled in one conversation (e.g. an internal-assist alongside the customer-facing one) - and how their identities/visibility separate.
- How per-assistant tool grants reconcile with the conversation type's `connectors[]` (the tool surface must be a subset of what the type makes available).
- **Per-classification channel flows (roadmap).** The Amazon Chime SDK `AssociateChannelFlow` primitive is per-channel, but the deployment provisions ONE shared app-instance channel flow (`/channel-flow-arn`) and associates it with every channel at creation. That shared flow is load-bearing routing infrastructure (it fans out `@all`, routes `/battle`, and reads the immutable classification tag), so it MUST remain - the roadmap is NOT to swap it per classification (that would break those routing flows) but to slim it to a MINIMAL routing flow and layer ADDITIONAL per-classification or per-profile flows on top for experience-specific pre/post-processing. Making that added flow a selection the unified bundle owns (alongside model/tools/guardrail) is the config axis to explore.
