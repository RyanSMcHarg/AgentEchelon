---
title: "ADR-011: Agent routing mechanism - self-hosted vs managed agent runtime"
status: Accepted - Option D (Converse + native tool use)
related:
  - SPEC-PER-PROFILE-OWNERSHIP.md
  - ../../backend/lib/stacks/basic-classification-stack.ts
  - ../../backend/lib/stacks/standard-classification-stack.ts
  - ../../backend/lib/stacks/premium-classification-stack.ts
  - ../../backend/lib/stacks/agent-classification-common.ts
  - ../../backend/lambda/src/router-agent-handler.ts
  - ../../backend/lambda/src/lib/async-processor-core.ts
---

# ADR-011: Agent routing mechanism

> **Reading guide.** The body is the decision: issue, recommendation, rationale, options-at-a-glance. All depth - what Converse/InvokeAgent actually are, per-option detail, flow diagrams, the spike data, cost levers, the AWS-doc verification, and sources - lives in the appendices.

## Issue & current state

What a team wants from this layer is an assistant that answers grounded in the right, access-appropriate company knowledge, while the deployer keeps fine-grained control over which model (and which provider) handles each kind of request and what it costs. The build-vs-adopt question underneath is whether to hand that orchestration to a managed runtime (Bedrock Agents) or keep it in AE's own pipeline - the decision this ADR makes. Current state is what forces the question: AE's per-tier Bedrock Agents and their action groups - notably the tier-scoped `load_company_context` (PR #16) - are **deployed but never executed at runtime**. The terminal model call is the **Converse API with no tool loop**, so the tool never fires. That breaks the product's defense-in-depth story (basic should decline product questions; premium should cite financials) because nothing invokes the tier-scoped retrieval.

Today's path (full diagram in [Appendix C](#appendix-c--flow-diagrams)):

```
Amazon Chime SDK → Lex (FallbackIntent) → router-agent-handler
        (classify intent → delivery option + task tracking + per-intent model)
      → tier async-processor → invokeBedrock = Converse(chosen model)   ← no tools
```

**Fixed premise - Amazon Chime SDK Messaging.** This ADR takes Amazon Chime SDK Messaging as fixed: it is AE's message transport *and* conversation store. AE's app-instance bot participates as a channel member and replies **asynchronously** by editing a placeholder message - there is no synchronous user request/response. That is what dictates the Lex → router → async-processor → placeholder-update shape above; this ADR decides only the **terminal model call**, not the transport.

Three constraints shape the fix:

- **OSS, pure-IaC.** A deployer must reach a working assistant with `git clone && cdk deploy` - no manual console steps. This rules out the Lex-native `AMAZON.BedrockAgentIntent`, which is **console-only** (verified; [Appendix B](#appendix-b--options-in-detail)).
- **The assistant is the orchestration.** One classified intent drives five downstream decisions - delivery option, task tracking, context retrieval, A/B experiment, *and* model selection (code-cited in [Appendix D](#appendix-d--spike-results--code-evidence)). The per-intent model is AE's deliberate quality↔cost↔latency control. Any fix that throws this away is not actually an upgrade.
- **Provider-agnostic, fine-grained model control (hard requirement).** Choosing the best model per intent must extend *beyond AWS* when that's the right call. AE already calls non-AWS providers for image generation (OpenAI `gpt-image-1`, FAL.ai FLUX - see `OPENAI_API_KEY` / `FAL_KEY`), and the same freedom must hold for text reasoning: route an intent to the best model **regardless of provider**. A Bedrock Agent forecloses this - its reasoning model must be a Bedrock foundation model. Only keeping the terminal call in AE's own pipeline preserves the option to reach an external provider when one is genuinely better for a given intent.

## Recommendation - Option D: Converse + native tool use

Option D keeps a **self-hosted agent loop** - Converse plus a tool loop AE runs in its own `async-processor` Lambda - instead of adopting the managed **Bedrock Agents** runtime. Concretely: keep the assistant = **AE's orchestration pipeline**, and add **native Converse tool use** (`toolConfig`) so `load_company_context` fires - with the *same* tier-scoped IAM isolation - while `intent → {delivery option, task state machine, per-intent model}` stays intact. Layer **prompt caching**, **selective tool invocation**, and the **existing RAG path** to be cost/latency-competitive with (or better than) a managed agent.

- **Unwind** the built-but-uncommitted Option-B swap (the InvokeAgent terminal call in `agent-invoke.ts` + the processor `InvokeAgent` IAM).
- **Keep** the `tier-stack.ts` agent-role IAM fix (`InvokeModel` + `InvokeModelWithResponseStream` + `ApplyGuardrail`) and the guardrail-ARN export - correct regardless, and doc-corroborated ([Appendix G](#appendix-g--aws-feature-reference)).
- **Reserve** Bedrock Agents / multi-agent collaboration for a *future, explicit* decision to cede orchestration to the managed layer.

## Why (high-level rationale)

In one line: AE chooses a **self-hosted agent runtime** over a managed one to keep model/provider choice, per-intent routing, and state/telemetry ownership
 - accepting that it maintains the loop.

1. **A single agent's terminal hand-off discards the orchestration.** An InvokeAgent call answers with the agent's *one* model and its *own* instruction - so AE's per-intent model choice is thrown away and the task-aware system prompt is ignored. Making the tool fire is not worth losing the thing that makes an AE assistant an assistant.
2. **Converse tool use closes the capability gap without that cost.** Converse has a first-class tool loop (`stopReason: tool_use` → invoke the same tier-scoped Lambda → `toolResult` → answer). "Tools don't run today" is a gap we haven't wired, not a Converse limitation.
3. **Cost/latency favors evolved Converse.** A managed agent re-sends its instruction + tool schemas on every orchestration step (why the spike's tool turns cost ~2.7× a plain turn). Evolved Converse keeps the per-intent model knob, can **skip the tool when the intent obviously needs none**, and can apply **prompt caching** (up to ~90% input-cost / ~85% latency reduction on long stable prefixes) with more control than inside an agent. See [Appendix F](#appendix-f--efficiency--cost-levers).
4. **Provider lock-in: managed agents foreclose non-AWS models.** A Bedrock Agent's reasoning model must be a model **hosted in Bedrock** - you can't point an agent at an external provider's API (OpenAI / Google / Anthropic-direct), so Options B/E can't route an intent off-AWS. AE already reaches outside AWS where it's the right model (OpenAI/FAL for image generation), and that freedom must remain available for text. Owning the terminal call (C/D) keeps the door open; adopting an agent shuts it.
5. **The managed direction is real but not a free upgrade.** AWS is steering toward managed agents, and they offer per-*phase* model override, Intelligent Prompt Routing (two same-family models), and multi-agent collaboration (GA). None of these reproduce AE's per-*intent* routing across the Haiku→Sonnet→Opus tier ladder (let alone across providers) without adopting the heavier multi-agent pattern. Details + citations in [Appendix G](#appendix-g--aws-feature-reference).
6. **Managed agents' only clear win is less code to own** - you don't maintain the tool loop. That is the real tradeoff: engineering surface vs. control.

## Options at a glance

| | C - Converse today | **D - Converse + tools (REC)** | B - InvokeAgent (terminal swap) | E - Multi-agent |
|---|---|---|---|---|
| `load_company_context` fires | ✗ | ✓ | ✓ | ✓ |
| Per-intent model (cost/quality knob) | ✓ | ✓ | ✗ (one model; per-*phase* only) | ✓ (per collaborator) |
| Provider-agnostic model choice (incl. non-AWS) | ✓ | ✓ | ✗ (Bedrock models only) | ✗ (Bedrock models only) |
| Task-aware prompting / state machine | ✓ | ✓ | ✗ (agent's own instruction) | needs wiring |
| Guardrails on the live path | manual | manual (`ApplyGuardrail`) | ✓ automatic | ✓ automatic |
| Orchestration owner | AE | AE | AWS (agent) | AWS (supervisor) |
| Tool-turn cost (equal tool work) | n/a (no tools) | ≈ B; lower via caching + per-intent model | ~2.7× a *plain* turn (measured) | + supervisor/collaborator calls |
| Code to own | low | + tool loop (~tens of lines) | low (managed) | low logic, heavy infra |
| Pure-IaC `cdk deploy` | ✓ | ✓ | ✓ (needs agent-role IAM fix) | ✓ |

One-liners (full detail in [Appendix B](#appendix-b--options-in-detail)):

- **A - Lex `BedrockAgentIntent`:** ruled out - console-only, not IaC-able.
- **B - InvokeAgent terminal swap:** tools + guardrails for free, but cedes the per-intent model and task-aware prompt. Built, uncommitted.
- **C - Converse today:** the status quo; tools never fire.
- **D - Converse + native tool use (recommended):** tools fire *and* orchestration kept; we own a small tool loop.
- **E - Multi-agent collaboration:** the way to regain per-intent multi-model *inside* the managed layer; heaviest infra; future option.

## Decision & status

**Accepted: Option D.** Option B (a blanket InvokeAgent terminal swap) was considered and rejected: it fires the tool but sheds AE's orchestration (per-intent model routing and task-aware prompting), so making the tool fire that way is not an upgrade. Option D fires the tier-scoped tool while keeping the orchestration.

**Reversibility.** The terminal model call is a single seam (`async-processor-core.ts` `invokeBedrock`). Options C/D/B all swap only that call, so moving between them stays a localized change - which is why committing to D is low-risk.

**What's implemented:** Option D is code-complete - the Converse self-hosted tool loop (`async-processor-core.ts` `invokeBedrock`), the shared `company-context.ts` retrieval, tier-scoped `context/{tier}/` S3 grants on the per-tier processor roles (the isolation boundary), enabled on normal text turns only (vision + `/battle` stay tool-less), with unit tests. The per-tier agent-role IAM (`InvokeModel` + `InvokeModelWithResponseStream` + `ApplyGuardrail`) and guardrail-ARN export are kept (correct regardless). **Follow-ups:** runtime validation (exercise the tool firing end-to-end) and guardrail parity (out-of-band `ApplyGuardrail` on the tool-loop output).

---

# Appendices

## Appendix A - Converse vs InvokeAgent (what they are)

One sentence: **Converse calls the raw model and you do the orchestration; InvokeAgent calls a configured agent that does the tool-use, guardrails, and memory for you.**

| | `bedrock-runtime:Converse` | `bedrock-agent-runtime:InvokeAgent` |
|---|---|---|
| **What you pass** | System prompt + a bounded recent-history window + inference config, each call. `loadChannelHistory` (`async-processor-core.ts`) fetches the last 20 Amazon Chime SDK messages and caps to ~5 turns (`slice(-10)`) - not the full channel | `agentId` + `aliasId` + the user's input text + a `sessionId` |
| **Where orchestration lives** | In *our* Lambda: we assemble the prompt and run any tool loop (see [Appendix F](#appendix-f--efficiency--cost-levers) for how to do this efficiently) | In the *agent* (server-side): instruction, tools, and the decide→call→observe loop are configured on the agent |
| **Tools / action groups** | Run **if** we pass `toolConfig` and run the loop ourselves in the `async-processor` Lambda (server-side). They don't run today only because `toolConfig` isn't wired - this is Option D | Run automatically; the agent calls `load_company_context`, reads the result, answers |
| **Guardrails** | Applied if we call `ApplyGuardrail` (out-of-band) | Attached to the agent → always enforced |
| **Memory** | Stateless - we re-send the recent-history window each turn | Stateful per `sessionId` - agent retains context server-side |
| **Telemetry** | Token usage + stop reason returned inline (easy capture) | Final answer streamed; per-step detail only via `enableTrace` |
| **Context grounding** | We fetch + supply context; do it well via tool-use retrieval or RAG, not blind whole-doc paste ([Appendix F](#appendix-f--efficiency--cost-levers)) | The agent fetches via its own tools |

**Terminology in this doc.** *Agent* = AE's assistant (the orchestration pipeline). *Bedrock Agent* = the managed AWS runtime (`InvokeAgent`). *Agent loop* = the reason → `tool_use` → observe → answer cycle. AE's agent loop runs **server-side in the `async-processor` Lambda** - it is *self-hosted*, not managed. (AWS's Converse docs label tool use "client-side," meaning the Bedrock API *caller* runs the loop rather than the managed agent - but that caller is our backend Lambda, so it is server-side relative to the user, not browser-side.)

Sources for the API behaviors above: [Appendix H](#appendix-h--sources--references).

## Appendix B - Options in detail

### A - Lex `AMAZON.BedrockAgentIntent` (+ manual console activation) - RULED OUT
Per-tier Lex bots route to the agent natively. **Decisive con:** the BedrockAgentIntent activation is **console-only** - the Lex Models V2 SDK has no `bedrockAgentIntentConfiguration` field (verified: `CreateIntent` rejects it; the bot-locale build fails "missing required bedrockAgentIntentConfiguration"). Requires a manual click per bot per deploy, which breaks `cdk deploy`-only for OSS deployers.

### B - Router calls InvokeAgent (terminal swap) - BUILT, UNCOMMITTED
The async-processor's terminal Converse call becomes `InvokeAgent(tierAgent)`.
- **Pro:** fully IaC; makes the tool fire; guardrails enforced on the live path automatically.
- **Con (decisive):** the agent answers with its single model and its own instruction, so AE's per-intent model routing and task-aware prompting are discarded (see [Appendix D](#appendix-d--spike-results--code-evidence)).
- **Con:** Bedrock-only - an agent's reasoning model must be a Bedrock foundation model, foreclosing AE's requirement to reach non-AWS providers for the right model per intent (the same limit applies to Option E).
- **Con:** resilience changes - `invokeBedrockWithFallback` does *model* fallback, which has no meaning for an alias; the fallback arm must become "retry agent, then fall back to direct Converse."
- Agents support per-*phase* model override but **not** per-*intent* ([Appendix G](#appendix-g--aws-feature-reference)).

### C - Direct Converse (status quo)
Smallest footprint, fully IaC, already tier-aware - but the agents/action groups remain dead code and tools never fire.

### D - Converse + native tool use - RECOMMENDED
A **self-hosted agent loop** (ReAct-style: reason → `tool_use` → observe → answer) running in the `async-processor` Lambda. Keep the pipeline; add `toolConfig` so the model can call `load_company_context` mid-Converse (`stopReason: tool_use` → invoke the same tier-scoped Lambda → `toolResult` → answer).
- **Pro:** tool fires **and** per-intent model + delivery option + task state machine are preserved; fully IaC; cost/latency-competitive (Appendix F).
- **Pro:** the tier-isolation boundary is unchanged - it's the action-group Lambda's per-tier S3 IAM, invoked identically.
- **Con:** we own the tool loop (~tens of lines) and must apply the guardrail out-of-band (`ApplyGuardrail`) for parity with B.
- Refines the old "Option C" (which assumed blind context-paste); tool-use lets the *model* decide when to fetch.

### E - Multi-agent collaboration (future)
A supervisor agent routes by topic to specialist collaborator agents, each with its own model/tools/guardrails - the managed-layer way to regain per-intent multi-model. GA; up to 10 collaborators. Heaviest infra; revisit only if AE decides to cede orchestration.

## Appendix C - Flow diagrams

### Flow A - today (direct Converse). Orchestration intact; tools never fire.
```
user ─► Amazon Chime SDK ─► channel-flow ─► Lex (FallbackIntent)
                                      │
  router-agent-handler  ── ORCHESTRATION ROUTER ──────────────┐
    classifyIntent (Haiku: std/prem) | keyword (basic)        │
    intent ┬─► delivery option                                │ bespoke
           ├─► task create / resume (taskType)                │ AE logic
           ├─► context retrieval                              │ (the
           └─► A/B experiment                                 │  assistant)
            │                                                 │
  tier async-processor                                        │
    resolveModelForIntent(intent) ─► model per intent ◄ COST/QUALITY knob
    build TASK-AWARE system prompt                            │
    [TERMINAL] invokeBedrock = Converse(chosen model) ────────┘
            │            └─ load_company_context: NEVER RUNS ✗ (dead agent)
            ▼
          reply
```

### Flow B - Option B (blanket InvokeAgent). Tools fire; control surrendered.
```
  router (orchestration): classify + delivery + task CREATE  (unchanged)
            │
  tier async-processor
    resolveModelForIntent(intent) ─► chosen model   ✗ DISCARDED on happy path
    TASK-AWARE system prompt                         ✗ IGNORED (agent uses its
            │                                           own instruction)
    [TERMINAL] InvokeAgent(tier agent)
        ├─ agent's ONE reasoning model (per-phase override only, not per-intent)
        ├─ agent tool loop ─► load_company_context FIRES ✓
        └─ guardrail auto-enforced ✓
        (Converse fallback only if the agent errors)
            ▼
          reply
  GAIN: tools fire, guardrails on the live path.
  LOSE: per-intent model (the cost/quality knob) + task-aware prompting.
```

### Flow D - Option D (Converse + native tool use). RECOMMENDED.
```
  router (orchestration): classify + delivery + task CREATE  (unchanged)
            │
  tier async-processor
    resolveModelForIntent(intent) ─► model per intent ✓ KEPT (cost knob)
    TASK-AWARE system prompt                          ✓ KEPT
    [TERMINAL] Converse(chosen model, toolConfig=[load_company_context])
        ├─ stopReason = tool_use ─► invoke tier-scoped retrieval Lambda
        │                            (SAME per-tier S3 IAM isolation) ─► FIRES ✓
        └─ send toolResult back ─► final answer
        (apply guardrail out-of-band - ApplyGuardrail - for parity with B)
            ▼
          reply
  GAIN: tools fire + tier isolation + per-intent model + task orchestration.
  COST: we own the tool loop (~a few lines); guardrails are not automatic.
```

## Appendix D - Spike results & code evidence

### The assistant IS the orchestration (code-cited, `router-agent-handler.ts`)

| One intent drives | Code |
|---|---|
| Delivery option | `intentToDeliveryOption(intent)` (472); `selectDeliveryOption(intent, hasActiveTask)` (535) |
| Task tracking | active-task lookup (524-529); `TASK_MULTI_STEP` → `taskType` from intent → `createTask` (548-567) |
| Context retrieval | `maybeRetrieveContext(userMessage, tier, intent)` (545) |
| A/B experiment | `resolveExperimentModel(tier, intent, …)` (482) |
| **Model** | `resolveModelForIntent(intent)` (in the async-processor) |

Model is just one consumer; the per-intent classification is the orchestration router (not "just" a model picker).

**Why a per-turn classifier instead of letting the main model self-route?** Its output drives the task state machine, delivery option, and the (multi-provider) model map - folding that into the primary model would couple those decisions to one model's output format and forfeit per-intent provider choice. The hop is cheap and bounded - Haiku, sub-second, cacheable - and the basic tier skips it entirely (keyword-only, no model call).

### InvokeAgent measurement (basic agent)

Measured with `backend/scripts/spike-invoke-agent.ts` (`InvokeAgent` + `enableTrace`, 6 prompts). 5/6 succeeded (one transient Bedrock "retry" - covered by the existing retry wrapper).

| case | tool? | fired | TTFR | steps | model calls | in/out tok | cost |
|---|---|---|---|---|---|---|---|
| ack (non-tool) | no | - | 3.7s | 4 | 1 | 1102 / 159 | $0.0005 |
| products | yes | ✅ | 6.6s | 8 | 2 | 3881 / 267 | $0.0013 |
| company | yes | ✅ | 5.5s | 8 | 2 | 3889 / 275 | $0.0013 |
| faq | yes | ✅ | 4.6s | 8 | 2 | 3857 / 187 | $0.0012 |
| out-of-tier (financials) | yes | ✅ | 5.7s | 9 | 2 | 3871 / 281 | $0.0013 |

- **TTFR:** tool turns avg 5.6s (max 6.6s); 0/5 breached the 15s/30s/45s thresholds. *Caveat: N=5, warm account, low concurrency - tail latency unproven.*
- **Telemetry:** per-step token usage recovered from the trace on every turn.
- **Cost:** tool turn ≈ 2.7× a plain turn - the re-sent instruction + schemas (~2,700 of the ~3,880 input tokens). This is the cost evolved-Converse attacks with prompt caching + per-intent model + skip-when-unneeded.

### IAM gaps the spike found (now doc-corroborated)

The agent execution role created in CDK granted only `bedrock:InvokeModel`; every InvokeAgent call fast-failed `AccessDenied` until both were added:
1. `bedrock:InvokeModelWithResponseStream` - InvokeAgent streams the model.
2. `bedrock:ApplyGuardrail` - the agent enforces its attached guardrail.

AWS docs confirm the agent service role needs exactly these, and that the console/managed creation flow adds them automatically - which is why AE's hand-rolled CDK role failed. The `tier-stack.ts` fix matches the documented requirement and **stays regardless of the C/D/B decision** ([Appendix H](#appendix-h--sources--references)).

## Appendix E - Cross-cutting requirements

### Path consistency
Every assistant-reply path should share one chokepoint. Conversational turns (normal, `@all`/`@assistant`, `/battle`) converge on `invokeBedrockWithFallback` → `invokeBedrock` (`async-processor-core.ts`)
 - so the tool-use change lands in **one** function. The lightweight one-shot utterances (welcome, share recap, channel-title derive) stay on a single guarded direct-model helper and apply the guardrail out-of-band, so there is one agent/tool path and one utility path - not six bespoke calls.

### Security requirement (hard invariant)
Tier data isolation is enforced by the per-tier action-group Lambda's IAM role (basic's `load_company_context` physically cannot read `context/premium/*`). This holds under Option D because the router already dispatches to the `min(userTier, channelTier)` tier processor, which invokes *its* tier's tool. Keep this as a tested invariant, not a convention.

### Operational characteristics
- **Telemetry:** Converse returns usage inline (today's scorecard reads it directly); the tool loop sums usage across the 1 - 2 Converse calls. No trace parser needed (unlike InvokeAgent).
- **Streaming:** `ConverseStream` supports progressive reveal for long answers; the existing encoded-length-aware `splitIntoChunks` carries over.
- **TTFR:** a tool turn adds one Converse round-trip + the Lambda + S3 read - comparable to the spike's agent tool turns, on *our* chosen model.

### State & memory
Two concerns, deliberately separated. **Conversation history** is a derived cache: we re-load a bounded window from **Amazon Chime SDK (the fixed store)** each turn, so the terminal model call is stateless and nothing is lost if no warm cache exists. **Application state** (active task IDs, routing / decline flags) lives in **DynamoDB** (`AgentTasks` / `UserTasks`), never in a model session. A "stateless model call" is therefore a property of the history path, not a gap
 - durable state has its own home, independent of the model or the transport.

## Appendix F - Efficiency & cost levers (answers to the inline questions)

Addressing the three notes left in the Primer:

**"How do we make the self-hosted agent loop efficient, and how does it compare?"**
- **Prompt caching** is the big lever: cache the stable prefix (instruction + tool schemas + any always-on context) so it isn't re-billed each turn. On Bedrock this gives up to ~90% input-cost and ~85% latency reduction on long prompts. *Caveat:* a minimum cache-checkpoint size applies - Claude 4.5 models need ≥4,096 tokens, Claude 3.7 Sonnet ≥1,024. The spike's tool turn was ~3,880 input tokens - just under 4,096 - so on a 4.5 model the cached prefix must clear 4,096 to qualify (RAG context pushes it over).
- **Per-intent model** - route trivial turns to Haiku, hard ones to Opus (the knob a single agent lacks).
- **Skip the tool when the intent obviously needs none** - we classify intent *up front*, so many turns go straight to one Converse call.
- **`ConverseStream`** for first-token latency; **parallel tool calls** when several are needed.
- **Comparison:** structurally the same round-trips as a managed agent, but on our chosen model and with caching control the agent doesn't expose - so evolved Converse is cost/latency-competitive, and lower with caching.

**"Tools don't run on Converse - what's our alternative?"** Native Converse tool use (`toolConfig`). It's Option D; the loop is client-side (`stopReason: tool_use` → we invoke the Lambda → `toolResult`).

**"Pasting docs into the prompt is inefficient - alternative?"** Don't paste whole docs. Use **tool-use retrieval** (fetch only when the model asks), **RAG** (top-k relevant chunks; AE already has a RAG path - `RAG.md`), and **prompt caching** for context that genuinely is always needed.

## Appendix G - AWS feature reference

| Claim | Verdict | Note |
|---|---|---|
| Converse native tool use (`toolConfig`→`stopReason: tool_use`→`toolResult`) | ✅ current | Client-side tool calling; `toolChoice` can force a tool. |
| Prompt caching cuts cost/latency | ✅ current (stronger than assumed) | Up to ~90% cost / ~85% latency on long prompts; GA for Claude 4.5 + Nova; 1-hr TTL available. Min checkpoint: 4.5 ≥4,096 tok, 3.7 Sonnet ≥1,024. |
| "Agent = one model" | ⚠️ corrected | Agents support per-*phase* model override (`promptOverrideConfiguration.promptConfigurations[].foundationModel` across PRE_PROCESSING/ORCHESTRATION/POST_PROCESSING/KB/MEMORY). Per *phase*, **not** per semantic intent. |
| Intelligent Prompt Routing replaces model-resolver | ⚠️ limited | GA, but routes between **two models in the same family** (~30% savings). A complement, not a tier-ladder substitute. |
| Multi-agent collaboration (supervisor + specialists) | ✅ GA | Up to 10 collaborators, each a full agent. The managed way to regain per-intent multi-model. |
| Agent service role needs `InvokeModelWithResponseStream` + `ApplyGuardrail` | ✅ confirmed | Managed creation adds them automatically; AE's hand-rolled CDK role didn't - corroborates the spike. |

## Appendix H - Sources & references

### AWS documentation
- Converse tool use: https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use.html
- Converse API reference: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
- Prompt caching: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
- Agent advanced prompts / per-phase model: https://docs.aws.amazon.com/bedrock/latest/userguide/configure-advanced-prompts.html
- `PromptConfiguration` (foundationModel per prompt type): https://docs.aws.amazon.com/bedrock/latest/APIReference/API_agent_PromptConfiguration.html
- Intelligent Prompt Routing: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html
- Multi-agent collaboration: https://docs.aws.amazon.com/bedrock/latest/userguide/agents-multi-agent-collaboration.html
- Agent service-role permissions: https://docs.aws.amazon.com/bedrock/latest/userguide/agents-permissions.html

### Internal code references
- Terminal model call: `async-processor-core.ts` (`invokeBedrock`, which issues the `ConverseCommand`)
- History window: `async-processor-core.ts` (`loadChannelHistory`)
- Orchestration router: `router-agent-handler.ts` (lines cited in [Appendix D](#appendix-d--spike-results--code-evidence))
- Resilience: `bedrock-resilience.ts` (`invokeBedrockWithFallback`)
- Agent-role IAM: the per-tier stacks (`lib/stacks/{basic,standard,premium}-classification-stack.ts` + `agent-classification-common.ts`); guardrail ARN: `lib/constructs/bedrock-guardrails.ts`
- Measurement script: `backend/scripts/spike-invoke-agent.ts`

## Open questions

1. **History window vs. agent session memory** - moot under Option D: we keep our explicit recent-history window (Amazon Chime SDK is the durable source of truth); no agent session to reconcile.
2. **Tool-loop resilience** - wrap the Converse tool loop in the existing retry/circuit-breaker; on tool-Lambda failure, answer without the tool rather than failing the turn.
3. **/battle** - `/battle` is a user-facing A/B test of **assistants** (full pipeline configs: instruction + intent→model map + tools), not raw models. Under Option D it naturally compares pipeline variants. Revisit the "assistant as a first-class armable object" question separately; multi-agent (Option E) would change this.
