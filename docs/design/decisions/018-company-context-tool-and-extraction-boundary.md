# ADR-018: Company-context tool selection and the extraction boundary

> **Status:** Accepted. Extends [ADR-011](011-agent-routing-mechanism.md) (tool-use retrieval) and the
> welcome/context design ([SPEC-WELCOME-AND-CONTEXT](../../specs/conversation-messaging/SPEC-WELCOME-AND-CONTEXT.md),
> [GUIDE-ASSISTANT-CONTEXT](../../guides/developer/GUIDE-ASSISTANT-CONTEXT.md)). Records why a company or
> financial question must be answered inline via a single company-context tool, and why a single-fact
> lookup must NOT be routed to a multi-step extraction task.

## Context

Per-classification business and financial documents (`context/{classification}/*.json`) are read by a
model-invoked tool, `load_company_context`, and are IAM-isolated by classification prefix (ADR-011
Appendix F: "use tool-use retrieval, RAG, and prompt caching; don't paste whole docs"). A second tool,
`load_platform_info`, was later split out for platform self-knowledge (the AgentEchelon product itself),
kept separate so a business question never loads platform docs and vice versa.

The canary for this area is the premium "exact ARR figure" question (`tier-context.spec.ts`, "premium CAN
access financial data"): a leadership user asks for a single financial figure and must get it stated
inline. Two distinct failure modes have been observed and traced:

1. **Tool not called / wrong tool.** The model answers "the context does not contain financials" without
   calling `load_company_context`, or reaches for `load_platform_info`. The `load_platform_info` split is
   the documented prime suspect for degrading `load_company_context` selection: two similarly-shaped
   "load..." tools make the choice less reliable.
2. **Answer deferred behind a task.** The model DOES call `load_company_context` and has the figure, but
   the turn was classified `data_extraction` (delivery `TASK_MULTI_STEP`), so the response is a task
   acknowledgement ("here's the exact figure:" + an `ACTIVE_TASK` marker) instead of the figure. The
   `data_extraction` intent was too broad — its description and keywords ("look up", "retrieve", "get
   data") caught a single-fact lookup that is really just a question.

Failure mode 2 is the current one on the live deploy: logs show `intent: data_extraction`,
`load_company_context` called, and the figure deferred rather than stated.

## Decision

1. **One tool for company/product/pricing/financial reads: `load_company_context`.** It is the single
   entry point the model calls before answering ANY company question. `load_platform_info` is strictly
   platform self-knowledge and its description explicitly excludes company/product/pricing/financials.
   The two must not compete for company questions.

2. **A single fact or figure is `GENERAL`, not `data_extraction`.** `data_extraction` (a
   `TASK_MULTI_STEP` task) is reserved for STRUCTURED / BULK extraction — a table, list, spreadsheet, or
   dataset ("extract the churn-risk accounts as a table", "export the roster"). A request answerable in a
   sentence ("what was our Q2 ARR?") is `GENERAL` and is answered inline. Encoded in the default intent
   pack (`lib/intent-pack.ts`) `data_extraction` description and keywords.

3. **A context digest makes the fetch deterministic AND selective.** `seed-demo` writes a per-classification
   `context/{classification}/_digest.json` (a manifest of which docs exist, with each doc's `file` + title +
   description, IAM-scoped like the docs); `loadContextDigest` + `buildDigestHint` inject an
   `## AVAILABLE COMPANY CONTEXT` block so the model knows what exists. The tool takes a `documents` argument:
   the model names the specific file(s) it needs from the digest, and `loadCompanyContext` fetches ONLY those,
   rather than dumping the whole corpus each turn (the input-token cost driver). An empty/unmatched selection
   falls back to loading all permitted docs (recall-safe). The model — which already understands the query and
   the digest — makes the relevance call; no code-side keyword heuristic. Semantic ranking is the router's RAG
   pre-fetch (embeddings), which already passes relevant chunks in, so the tool is for the whole-document case.
   (`company-context.ts`, `async-processor-core.ts`.)

## Consequences

- A leadership user's financial-figure question is answered inline. Bulk/structured extraction still
  becomes a tracked task (the `data_extraction` / task-state-machine flows are unaffected — they use
  table/export phrasing).
- Intent classification is an LLM call and remains probabilistic; the narrowed `data_extraction`
  description plus temperature-0 classification make the single-fact-vs-bulk split reliable, but
  premium-ARR remains the canary to watch, and the `load_platform_info` split stays a suspect if tool
  selection regresses.
- This ADR is the durable public record of a finding previously captured only in a private working plan.
