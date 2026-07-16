# Assistant Configuration - what the assistant *is*, per experience

**Status:** Partial (the per-tier config seams ship; the unified `AssistantConfig` bundle is the design target)


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
  model: { default: string; complex?: string; classifier?: string };  // per-intent model selection
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

- **Built (as code/CDK, not yet a config bundle):** per-tier assistants - `model-strategy.ts` (`TierModelSelection`, the intent→model strategy), the per-tier stacks (each owns its guardrail, context S3 scope, async-processor), and the self-hosted Converse tool loop. So the *capabilities* exist; what's missing is the **`AssistantConfig` bundle** a conversation type selects.
- **Built - per-deployment config seams (the precursors to the bundle):** the **persona** (`systemPrompt`) via `ASSISTANT_SYSTEM_PROMPT` / `-c assistantSystemPrompt`, and the **intent taxonomy** via `ASSISTANT_INTENT_PACK` / `-c assistantIntentPack` (`docs/specs/assistant-context/SPEC-CONFIGURABLE-INTENT-PACK.md`). These are two fields of the eventual `AssistantConfig`, already externalised from code as deploy-time config - a deployment defines *what its assistant is* (persona + intents) without forking the agent loop. Folding them into the named bundle is the remaining step.
- **Built - config fingerprint:** `buildConfigIdentity` (`lib/config-identity.ts`) hashes the assembled config (persona + intent pack + per-intent response settings) into a `configId`, so quality can be sliced by which configuration produced it. This is the attribution key the eventual bundle would carry.
- **Target:** lift the scattered per-tier settings into named `AssistantConfig`s referenced by `ConversationTypeConfig.defaultAgents`, so a new experience picks an assistant by name.

## 8. Open questions

- Where the config lives (a registry in code like `conversation-types.ts`, or deploy-time config) and how the system prompt is stored (S3 vs inline) + versioned.
- Whether multiple assistants can be enrolled in one conversation (e.g. an internal-assist alongside the customer-facing one) - and how their identities/visibility separate.
- How per-assistant tool grants reconcile with the conversation type's `connectors[]` (the tool surface must be a subset of what the type makes available).
