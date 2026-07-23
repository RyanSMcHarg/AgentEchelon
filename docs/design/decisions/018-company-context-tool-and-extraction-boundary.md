# ADR-018: Company-context tool selection and the extraction boundary

> **Status:** Accepted. Extends [ADR-011](011-agent-routing-mechanism.md) (tool-use retrieval) and the welcome/context design ([SPEC-WELCOME-AND-CONTEXT](../../specs/interaction/assistant-config/SPEC-WELCOME-AND-CONTEXT.md), [GUIDE-ASSISTANT-CONTEXT](../../guides/developer/GUIDE-ASSISTANT-CONTEXT.md)). Records why a company or financial question must be answered inline via a single company-context tool, and why a single-fact lookup must NOT be routed to a multi-step extraction task.

## Context

A business wants its assistant to answer questions from the company's own documents - "what was our Q2 ARR?" - by stating the figure inline, at the asker's classification, and to do it reliably: not "the context has no financials" when the data is right there, and not a deferred "I'll work on that" task for what is really a one-sentence answer. Getting that right otherwise means hand-tuning tool selection and intent classification yourself until a single-fact lookup stops being mistaken for a bulk extraction job.

Per-classification business and financial documents (`context/{classification}/*.json`) are read by a model-invoked tool, `load_company_context`, and are IAM-isolated by classification prefix (ADR-011 Appendix F: "use tool-use retrieval, RAG, and prompt caching; don't paste whole docs"). A second tool, `load_platform_info`, was later split out for platform self-knowledge (the AgentEchelon product itself), kept separate so a business question never loads platform docs and vice versa.

The canary for this area is the premium "exact ARR figure" question (`tier-context.spec.ts`, "premium CAN access financial data"): a leadership user asks for a single financial figure and must get it stated inline. Two distinct failure modes have been observed and traced:

1. **Tool not called / wrong tool.** The model answers "the context does not contain financials" without calling `load_company_context`, or reaches for `load_platform_info`. The `load_platform_info` split is the documented prime suspect for degrading `load_company_context` selection: two similarly-shaped "load..." tools make the choice less reliable.
2. **Answer deferred behind a task.** The model DOES call `load_company_context` and has the figure, but the turn was classified `data_extraction` (delivery `TASK_MULTI_STEP`), so the response is a task acknowledgement ("here's the exact figure:" + an `ACTIVE_TASK` marker) instead of the figure. The `data_extraction` intent was too broad: its description and keywords ("look up", "retrieve", "get data") caught a single-fact lookup that is really just a question.

Failure mode 2 is the current one on the live deploy: logs show `intent: data_extraction`, `load_company_context` called, and the figure deferred rather than stated.

## Decision

1. **One tool for company/product/pricing/financial reads: `load_company_context`.** It is the single entry point the model calls before answering ANY company question. `load_platform_info` is strictly platform self-knowledge and its description explicitly excludes company/product/pricing/financials. The two must not compete for company questions.

2. **A single fact or figure is `GENERAL`, not `data_extraction`.** `data_extraction` (a `TASK_MULTI_STEP` task) is reserved for STRUCTURED / BULK extraction: a table, list, spreadsheet, or dataset ("extract the churn-risk accounts as a table", "export the roster"). A request answerable in a sentence ("what was our Q2 ARR?") is `GENERAL` and is answered inline. Encoded in the default intent pack (`lib/intent-pack.ts`) `data_extraction` description and keywords.

3. **A context digest makes the fetch deterministic AND selective.** `seed-demo` writes a per-classification `context/{classification}/_digest.json` (a manifest of which docs exist, with each doc's `file` + title + description, IAM-scoped like the docs); `loadContextDigest` + `buildDigestHint` inject an `## AVAILABLE COMPANY CONTEXT` block so the model knows what exists. The tool takes a `documents` argument: the model names the specific file(s) it needs from the digest, and `loadCompanyContext` fetches ONLY those, rather than dumping the whole corpus each turn (the input-token cost driver). An empty or unmatched selection falls back to loading all permitted docs (recall-safe). The model - which already understands the query and the digest - makes the relevance call; no code-side keyword heuristic. Semantic ranking is the router's RAG pre-fetch (embeddings), which already passes relevant chunks in, so the tool is for the whole-document case. (`company-context.ts`, `async-processor-core.ts`.)

## Consequences

- A leadership user's financial-figure question is answered inline. Bulk/structured extraction still becomes a tracked task (the `data_extraction` / task-state-machine flows are unaffected - they use table/export phrasing).
- Intent classification is an LLM call and remains probabilistic; the narrowed `data_extraction` description plus temperature-0 classification make the single-fact-vs-bulk split reliable, but premium-ARR remains the canary to watch, and the `load_platform_info` split stays a suspect if tool selection regresses.
- This ADR is the durable public record of a finding previously captured only in a private working plan.

## Amendment: intent and delivery are separate axes (do NOT collapse domain intents to `general`)

Decision 2 ("a single fact is `GENERAL`, not `data_extraction`") solved a **delivery** problem - a one-sentence answer was being deferred behind a `TASK_MULTI_STEP` task - by changing the **intent**. Read narrowly that is correct: a single fact must not route to the bulk-extraction task. Read broadly it is a trap: pushing every single-turn business question into `general` throws away the classification signal (a revenue figure and "what is the capital of France?" land in the same bucket), which degrades the admin console's intent analytics and per-intent model routing.

These are two independent axes:

- **Intent** - what the request is about. The analytics bucket + the `INTENT_ROUTE_STRATEGY` routing signal.
- **Delivery** - how the turn is returned. The per-intent `delivery` field: `DIRECT` / `PLACEHOLDER_UPDATE` (one inline turn) / `TASK_MULTI_STEP` (tracked multi-step).

The intent pack already carries `delivery` per `IntentDef`, so a domain intent can be answered inline: give it `delivery: 'PLACEHOLDER_UPDATE'`. The correct rule is therefore:

- A single-turn business question (a revenue figure, one account's status, a product-plan detail) is its **own domain intent with `delivery: 'PLACEHOLDER_UPDATE'`** - bucketed for analytics AND answered inline. It is NOT `general`.
- `general` stays for genuinely generic questions with no domain bucket.
- Only genuinely multi-step work (a compiled report, a bulk table export) is `TASK_MULTI_STEP` (`report_generation`, `data_extraction`).

`general` was only reached for single facts because the DEFAULT `data_extraction` / `report_generation` are hardwired to `TASK_MULTI_STEP` - so the general bucket was the only way to avoid the task. The per-intent `delivery` field is the real lever; `general` is not.

The Stratum demo intent pack (`seed-demo.ts`) is the worked example: `financial_metric`, `account_status`, `competitive_intel`, `directory_lookup`, `process_lookup`, and `product_info` are all `PLACEHOLDER_UPDATE` domain intents (answered inline, still bucketed), while `report_generation` and `data_extraction` remain the `TASK_MULTI_STEP` keys for compiled reports and bulk exports. The premium-ARR canary still passes - the figure is stated inline - and it now lands in `financial_metric` instead of `general`.

Open follow-up: a report or extraction that is genuinely answerable in one turn still cannot be delivered inline under its own key, because `delivery` is static per intent key. Expressing "this key is usually multi-step but inline when the answer fits one turn" would need a runtime delivery decision where `deliveryClassForIntent` is consumed (a small, additive change), rather than a second intent key. Deferred until a use case needs it.
