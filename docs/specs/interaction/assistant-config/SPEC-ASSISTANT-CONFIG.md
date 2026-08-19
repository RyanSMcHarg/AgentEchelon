# Assistant Configuration - what the assistant *is*, per experience

**Status:** Implemented. The per-classification config seams ship, and the unified `AssistantConfig` bundle rides the versioned profile definition ([`SPEC-PORTABLE-PROFILES.md`](SPEC-PORTABLE-PROFILES.md)). The versioned definition carries a per-profile **`models` bundle** (`default` plus optional `classifier` / `complex` / `byIntent` overrides), a per-profile **`tools`** surface, a per-profile **`machines`** override, and a **`guardrailId`** selection - so **model selection is PROFILE-level, not a global strategy table**. The schema is additive and byte-identical (the seed sets `models.default` to the base model); resolution reads `models.byIntent` / `models.classifier` from the active profile version, seeding `byIntent` from the global `model-strategy` table. The three per-assistant config axes (context scope, task machines, guardrail selection) are collected in [`SPEC-CONFIGURABLE-ASSISTANTS.md`](SPEC-CONFIGURABLE-ASSISTANTS.md).

**Coverage:** `tests/e2e/profile-config.spec.ts`, `tests/e2e/admin-profiles.spec.ts`

**Verified by:** `backend/test/lib/active-profile.test.ts` (a version's models/tools/machines/guardrailId surface on the resolved profile and fail closed to the seed on an invalid version), `backend/test/lib/guardrail-catalog.test.ts` (default vs strict guardrail policy), `backend/test/task-state-machines.test.ts` and `backend/test/lib/task-loop-machines.test.ts` (task-machine graph validation + a profile's machines override the deployment pack at loop time), and `backend/test/cdk-synth.test.ts` (describe 'Layer 4 / §7 - IAM resource boundaries (deny-by-absence...)': the S3 context prefix boundary excludes higher classifications, the channel-context store is router `GetItem`-only, and `bedrock:ApplyGuardrail` is scoped to provisioned guardrails).

> **Model selection is per-profile, with classification-level DEFAULTS.** The former global `IntentRouteDefinition[]` table (one strategy shared by every profile) gave the wrong level of control: a portable, versioned assistant must decide its OWN per-intent models. So **per-intent routing + classifier + base override live on the profile version** (`models.byIntent` / `models.classifier` / `models.default`), bounded by the classification's `bedrock:InvokeModel` allowlist (the security ceiling). What stays at the CLASSIFICATION level are the **defaults**: the default base model per classification (`DEFAULT_PROFILE_MODEL_SELECTION`) and the default classifier model (Haiku / `CLASSIFIER_MODEL`). A profile that wants a default records it **explicitly** as the sentinel value `'default'` rather than leaving the field absent. The distinction is deliberate: `'default'` is a visible, self-documenting choice to **follow the classification-set model as it changes over time**, whereas materializing today's concrete key would silently pin the profile to a snapshot. So the seed writes `models.classifier: 'default'` (never the bare Haiku key); resolution treats `'default'` exactly like unset (falls back to the classification default) and the write-path allowlist check skips it, since it names no catalog model. A per-intent override falls back to the base; a per-intent `'default'` primary means "use the base for this intent". Consequence: the admin **Model Strategy** surface is NOT retired but **repurposed** - it shows the *available* model catalog and the *per-classification defaults* (the fallback values); everything profile-specific (per-intent, classifier, base override, tools, guardrail) is seen and edited at the profile level.

**Problem and who it's for:** A business wants to shape distinct assistants for distinct experiences - each with its own model, persona, tools, guardrail, and readable context - by declaring what an assistant *is* as data a conversation type selects by name, not by writing or forking code for every variant. This is for the AI developer who tunes assistants and the admin/operator who needs one place that defines each assistant's model, cost, and capabilities; the alternative is a single-experience chatbot builder that hard-wires one assistant, or a home-grown config layer they build and maintain themselves. It gives the assistant definition a single home - the bundle a conversation type selects by name, riding the versioned profile definition (models, tools, machines, guardrail selection, context scope).

**Site section:** Interaction layer, Assistant Configuration pillar.


**What's built:** the per-classification assistant capabilities (model strategy, per-profile guardrail selection, per-classification context scope, the Converse tool loop), the two externalised config seams - persona (`ASSISTANT_SYSTEM_PROMPT`) and intent taxonomy (`ASSISTANT_INTENT_PACK`) - the `configId` fingerprint (`buildConfigIdentity`, `lib/config-identity.ts`) that hashes the running config for quality attribution, and the **unified `AssistantConfig` bundle** a conversation type selects, riding the versioned profile definition (models, tools, machines, guardrail selection). This spec is the **Assistant Configuration** pillar of the interaction layer (`docs/specs/interaction/SPEC-INTERACTION-LAYER.md` is the map); it gives the assistant definition a single home.

**Related:** `docs/specs/interaction/SPEC-INTERACTION-LAYER.md` (the model) · `docs/specs/interaction/conversation-config/SPEC-CONVERSATION-TYPES.md` (selects an assistant via `defaultAgents`) · `docs/specs/interaction/identity-access/core/SPEC-CREDENTIAL-EXCHANGE.md` (the assistant is also an identity) · `backend/lib/config/model-strategy.ts` · `backend/lambda/src/lib/async-processor-core.ts` (the Converse tool loop) · `backend/lib/constructs/bedrock-guardrails.ts`.

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
    byIntent?: Record<string, { primary: string; fallback?: string }>; // per-profile per-intent overrides
                                           //   (replaces the global strategy table; carries the fallback too)
  };
  systemPrompt: string;          // kept out of code. As built this is `personaRef` - an S3 key plus the
                                 //   version's configId, never the bucket (a stored bucket would aim an
                                 //   importing instance at the exporter's account). Definitions written
                                 //   before the pointer carry the text inline and still resolve.
  tools: string[];               // the Converse tool surface (e.g. load_context, schedule, syncRecord)
  guardrailId: string;           // the content guardrail applied out-of-band on the final reply
  contextScope: string;          // context the assistant may read: an ARN-able resource (S3 prefix today), keyed to classification
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
- **Context scope is IAM, not prompt** - an assistant's context is any ARN-able AWS resource (an S3 prefix today; equally a DynamoDB table, a Bedrock knowledge base, a Secrets Manager secret), and its role is granted read access only to what its `contextScope` names; out-of-scope reads get AccessDenied. The boundary is infrastructure, not the prompt.
- **Assistant identity** is bearer-pinned to an assistant identity (never a user ARN), so a compromised or buggy assistant cannot impersonate a person.

## 7. As built

- **Built - per-profile assistants:** `model-strategy.ts` (`ProfileModelSelection`, the intent→model strategy), the shared `assistant-profile-stack.ts` (thin per-profile subclasses supply a `ProfileTopology`; each profile owns its guardrail and context S3 scope) served by the one shared `assistant-async-processor.ts`, and the self-hosted Converse tool loop.
- **Built - per-deployment config seams:** the **persona** (`systemPrompt`) via `ASSISTANT_SYSTEM_PROMPT` / `-c assistantSystemPrompt`, and the **intent taxonomy** via `ASSISTANT_INTENT_PACK` / `-c assistantIntentPack` (`docs/specs/interaction/assistant-config/SPEC-CONFIGURABLE-INTENT-PACK.md`). Both let a deployment define *what its assistant is* without forking the agent loop. The **persona rides the versioned bundle** - it lives on the profile version as a body in S3, editable with no deploy ([`SPEC-PORTABLE-PROFILES.md`](SPEC-PORTABLE-PROFILES.md), "Where it lives") - and this parameter is its fallback rather than its home. The intent taxonomy still resolves from its own per-deployment parameter; moving it onto the bundle is open (§8).
- **Built - config fingerprint:** `buildConfigIdentity` (`lib/config-identity.ts`) hashes the assembled config (persona + intent pack + per-intent response settings) into a `configId`, so quality can be sliced by which configuration produced it. This is the attribution key the versioned bundle carries.
- **Built - the named bundle:** the per-tier settings ride named `AssistantConfig`s on the versioned profile definition, referenced by `ConversationTypeConfig.defaultAgents`, so a new experience picks an assistant by name. The three per-assistant config axes (context scope, task machines, guardrail selection) are collected in [`SPEC-CONFIGURABLE-ASSISTANTS.md`](SPEC-CONFIGURABLE-ASSISTANTS.md).

## 8. Open questions

- ~~Where the config lives and how the system prompt is stored (S3 vs inline) + versioned.~~ **Settled:** the definition is an SSM parameter whose native versions are the version history, and the system prompt is an S3 body the definition points at ([`SPEC-PORTABLE-PROFILES.md`](SPEC-PORTABLE-PROFILES.md), "Where it lives"). What remains open is the same question for the **intent pack**, which still stores its taxonomy inline in its own per-deployment parameter.
- Whether multiple assistants can be enrolled in one conversation (e.g. an internal-assist alongside the customer-facing one) - and how their identities/visibility separate.
- How per-assistant tool grants reconcile with the conversation type's `connectors[]` (the tool surface must be a subset of what the type makes available).
- **Per-classification channel flows (roadmap).** The Amazon Chime SDK `AssociateChannelFlow` primitive is per-channel, but the deployment provisions ONE shared app-instance channel flow (`/channel-flow-arn`) and associates it with every channel at creation. That shared flow is load-bearing routing infrastructure (it fans out `@all`, routes `/battle`, and reads the immutable classification tag), so it MUST remain - the roadmap is NOT to swap it per classification (that would break those routing flows) but to slim it to a MINIMAL routing flow and layer ADDITIONAL per-classification or per-profile flows on top for experience-specific pre/post-processing. Making that added flow a selection the unified bundle owns (alongside model/tools/guardrail) is the config axis to explore.
