# Developer Guide

**Audience:** engineers building on or extending AgentEchelon.
**Status:** hub / index. Points to the authoritative doc for each task; it does not restate them.

Start with the architecture, then jump to the change you are making. If you only read two things first,
read [`../../overview/ARCHITECTURE.md`](../../overview/ARCHITECTURE.md) and
[`MESSAGE-FLOW.md`](MESSAGE-FLOW.md).

## Orient

- [`../../overview/ARCHITECTURE.md`](../../overview/ARCHITECTURE.md) - the whole system end to end.
- [`../../overview/TENETS.md`](../../overview/TENETS.md) - the principles a change must not break.
- [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md) - how a message travels: channel flow, tier router, intent
  classifier, per-tier async processor, guardrails, Bedrock.
- [`CHIME_SDK_INTEGRATION.md`](CHIME_SDK_INTEGRATION.md) - the messaging-substrate integration.

## Common extensions

- **Add or change a tier** (model, prompt, guardrail, context scope, second assistant):
  [`HOW-TO-ADD-OR-MANAGE-A-TIER.md`](HOW-TO-ADD-OR-MANAGE-A-TIER.md).
- **Change model routing** (which intent uses which model, and how tier access is enforced):
  [`MODEL_STRATEGY.md`](MODEL_STRATEGY.md).
- **Assistant context and retrieval** (what the assistant is allowed to see; RAG):
  [`GUIDE-ASSISTANT-CONTEXT.md`](GUIDE-ASSISTANT-CONTEXT.md) and [`RAG.md`](RAG.md).
- **Produce or extend channel messages** (read before writing any bot message): Amazon Chime SDK's encoded-length
  caps, the CJK multiplier, and the split/attachment helpers in
  [`MESSAGE-DELIVERY-GUIDE.md`](MESSAGE-DELIVERY-GUIDE.md).
- **Frontend** (design tokens and component conventions): [`DESIGN-SYSTEM.md`](DESIGN-SYSTEM.md).

## Build, test, deploy

- **Contribution workflow, code style, PRs:** [`../../../CONTRIBUTING.md`](../../../CONTRIBUTING.md).
- **Dependency safety** (blocked install scripts, lockfile pinning, supply-chain checks):
  [`SECURITY-NPM-SUPPLY-CHAIN.md`](SECURITY-NPM-SUPPLY-CHAIN.md).
- **Frontend deploy:** [`../user/FRONTEND-DEPLOY.md`](../user/FRONTEND-DEPLOY.md).
- **Performance budgets:** [`LATENCY-TARGETS.md`](LATENCY-TARGETS.md).
- **Cost impact of a change:** [`../admin/INFRASTRUCTURE-COST.md`](../admin/INFRASTRUCTURE-COST.md)
  (the single source of truth for cost).

## Specs and decisions

The precise behavior and boundaries of each subsystem live in the specs, grouped by domain under
[`../../specs/`](../../specs/); the *why* behind the choices lives in the decision records under
[`../../design/decisions/`](../../design/decisions/). Each spec states its build status in its first
lines, so you can tell shipped behavior from forward-looking design before you rely on it.

Common starting points:

- Identity and access: [`../../specs/identity-access/`](../../specs/identity-access/) (credential
  exchange, conversation security, the access model with a worked example).
- Conversation and messaging: [`../../specs/conversation-messaging/`](../../specs/conversation-messaging/)
  (conversation types, the interaction layer, message metadata).
- Assistant and context: [`../../specs/assistant-context/`](../../specs/assistant-context/) (assistant
  config, intent packs, per-tier ownership).
- Analytics and evaluation: [`../../specs/analytics-eval/`](../../specs/analytics-eval/) (Aurora mode,
  drift, cost sleep).
