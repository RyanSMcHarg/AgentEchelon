# Developer Guide

**Audience:** engineers building on or extending AgentEchelon. **Status:** hub / index. Points to the authoritative doc for each task; it does not restate them.

Start with the architecture, then jump to the change you are making. If you only read two things first, read [`../../overview/ARCHITECTURE.md`](../../overview/ARCHITECTURE.md) and [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md).

## Orient

- [`../../overview/ARCHITECTURE.md`](../../overview/ARCHITECTURE.md) - the whole system end to end.
- [`../../overview/TENETS.md`](../../overview/TENETS.md) - the principles a change must not break.
- [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md) - how a message travels: channel flow, shared router, intent classifier, the per-classification async processor, guardrails, Bedrock.
- [`CHIME_SDK_INTEGRATION.md`](CHIME_SDK_INTEGRATION.md) - the messaging-substrate integration.

## Common extensions

- **Add or change a tier** (model, prompt, guardrail, context scope, second assistant): [`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](HOW-TO-ADD-OR-MANAGE-A-PROFILE.md).
- **Add an assistant ROLE within existing classifications** (a second job, with its own scope and its own reports): [`../../specs/interaction/assistants/DESIGN-ADDING-AN-ASSISTANT-ROLE.md`](../../specs/interaction/assistants/DESIGN-ADDING-AN-ASSISTANT-ROLE.md). A role is not a classification and is much smaller: no Cognito group, no credential-exchange role (a classification has one; there is no Identity Pool), no new stack, no frontend tier gating. Adding one is a deploy because a role declares a new scope boundary; assigning an assistant into it is runtime.
- **Add or configure an identity provider** (who signs in, and what their groups reach): the steps are [`../user/IDENTITY-PROVIDER-GUIDE.md`](../user/IDENTITY-PROVIDER-GUIDE.md), each named with the e2e test that runs it; the design is [SPEC-CREDENTIAL-EXCHANGE §4b](../../specs/interaction/governance/SPEC-CREDENTIAL-EXCHANGE.md#4b-issuers-and-the-person-id). In code, an entry is validated at synth by `issuerErrors` and a provider's groups are translated by `groupsOf` (`backend/lib/config/issuers.ts`), the one function every clearance, console role and team scope reads; tokens are verified at the edge (`backend/lambda/src/lib/token-verification.ts`, configured by `backend/lib/config/edge-verification.ts`), and each issuer's directory and offline clearance are chosen once in `backend/lambda/src/lib/issuer-seams.ts`. A new kind of provider is one adapter and one registry entry ([Other issuers](../user/IDENTITY-PROVIDER-GUIDE.md#other-issuers)).
- **Change model routing** (which intent uses which model, and how classification access is enforced): [`MODEL_STRATEGY.md`](MODEL_STRATEGY.md).
- **Assistant context and retrieval** (what the assistant is allowed to see; RAG): [`GUIDE-ASSISTANT-CONTEXT.md`](GUIDE-ASSISTANT-CONTEXT.md) and [`RAG.md`](RAG.md).
- **Produce or extend channel messages** (read before writing any assistant message): Amazon Chime SDK's encoded-length caps, the CJK multiplier, and the split/attachment helpers in [`MESSAGE-DELIVERY-GUIDE.md`](MESSAGE-DELIVERY-GUIDE.md).
- **Frontend** (design tokens and component conventions): [`DESIGN-SYSTEM.md`](DESIGN-SYSTEM.md).
- **Call the platform from your own client** (authentication, the two identities, the four limits, error codes, CORS): [`API-GUIDE.md`](API-GUIDE.md), with the generated route inventory in [`../../reference/api-contract.md`](../../reference/api-contract.md).

## Build, test, deploy

- **Contribution workflow, code style, PRs:** [`../../../CONTRIBUTING.md`](../../../CONTRIBUTING.md).
- **Dependency safety** (blocked install scripts, lockfile pinning, supply-chain checks): [`SECURITY-NPM-SUPPLY-CHAIN.md`](SECURITY-NPM-SUPPLY-CHAIN.md).
- **Frontend deploy:** [`../user/FRONTEND-DEPLOY.md`](../user/FRONTEND-DEPLOY.md).
- **E2E listeners** (operator alerts, live backend errors and stalls fail the running test; declaring expected alarms, errors and waits): [`E2E-WATCHDOG.md`](E2E-WATCHDOG.md).
- **Performance budgets:** [`LATENCY-TARGETS.md`](LATENCY-TARGETS.md).
- **Cost impact of a change:** [`../admin/INFRASTRUCTURE-COST.md`](../admin/INFRASTRUCTURE-COST.md) (the single source of truth for cost).

## Specs and decisions

The precise behavior and boundaries of each subsystem live in the specs under [`../../specs/`](../../specs/), organized by the four layers the platform is built as, so the directory itself shows where AgentEchelon ends and your own client, channel or system of record begins; the *why* behind the choices lives in the decision records under [`../../design/decisions/`](../../design/decisions/). Each spec states its build status in its first lines, so you can tell shipped behavior from forward-looking design before you rely on it.

The layers, and what belongs in each:

- [`../../specs/interface/`](../../specs/interface/) - the client surfaces: the web chat client and the operator console. Both ship with the platform and both are replaceable with your own.
- [`../../specs/communication/`](../../specs/communication/) - how a client or an outside system reaches the engine: the message wire format, outbound notification channels, and connectors to your systems of record. This is the seam to build against.
- [`../../specs/interaction/`](../../specs/interaction/) - the engine, subdivided: [assistants](../../specs/interaction/assistants/) (what an assistant is and how it behaves, the group a vertical team works in), [conversation](../../specs/interaction/conversation/) (types, membership, tasks, the turn queue), [governance](../../specs/interaction/governance/) (identity, the credential exchange, the classification boundary, auditing) and [quality](../../specs/interaction/quality/) (evaluation, battle, experiments).
- [`../../specs/foundations/`](../../specs/foundations/) - how the platform is deployed and operated: the analytics mode, cost controls, abuse controls.
- [`../../specs/demos/`](../../specs/demos/) - the demo implementation the repo ships as a worked example.
