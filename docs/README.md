# AgentEchelon documentation

The navigable map of everything under `docs/`, organized by **what you are trying to do**. The
authoritative project overview and quickstart live in the root [`README.md`](../README.md); start there if
you have not.

Every spec states its build status in its first lines (Implemented / partially implemented / design).
Design-only specs live under [`design/`](design/).

---

## Deploy it (evaluate and stand up an instance)

- [`overview/PLATFORM-OVERVIEW.md`](overview/PLATFORM-OVERVIEW.md) - what AgentEchelon is and why.
- [`overview/ARCHITECTURE.md`](overview/ARCHITECTURE.md) - the whole system end to end: flows, stack dependencies, routing. Read before any change.
- [`overview/TENETS.md`](overview/TENETS.md) - the non-negotiables every architectural decision traces back to.
- [`guides/user/FRONTEND-DEPLOY.md`](guides/user/FRONTEND-DEPLOY.md) - deploy the SPA to CloudFront + S3; build-then-publish, origins, WAF, teardown.
- [`guides/user/IDENTITY-PROVIDER-GUIDE.md`](guides/user/IDENTITY-PROVIDER-GUIDE.md) - integrate an external IdP (OIDC, SAML, custom) and how tier authorization is derived.
- [`guides/user/DEMO-AND-VALIDATION.md`](guides/user/DEMO-AND-VALIDATION.md) - seed a demo environment and validate it.
- [`guides/user/TROUBLESHOOTING.md`](guides/user/TROUBLESHOOTING.md) - operational runbook (Symptom to Diagnosis to Root Cause to Fix). Start here when something is broken.

## Operate it (run a deployment day to day)

- [`guides/admin/ADMIN-GUIDE.md`](guides/admin/ADMIN-GUIDE.md) - the admin console: sections, administration surface, Athena-vs-Aurora behavior.
- [`guides/admin/ADMIN-INTEGRATION-GUIDE.md`](guides/admin/ADMIN-INTEGRATION-GUIDE.md) - run the operator surface behind your own admin console and admin auth.
- [`guides/admin/AURORA-MODE-GUIDE.md`](guides/admin/AURORA-MODE-GUIDE.md) - deploy and operate the opt-in Aurora mode (RAG, drift, evaluation).
- [`guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md`](guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md) - run an A/B experiment and the `/battle` head-to-head flow.
- [`guides/admin/IMAGE-GEN-PROVIDERS.md`](guides/admin/IMAGE-GEN-PROVIDERS.md) - the pluggable image-generation providers and how to supply keys.
- [`guides/admin/INFRASTRUCTURE-COST.md`](guides/admin/INFRASTRUCTURE-COST.md) - **the single source of truth for cost.** Every cost figure lives here; other docs link to it rather than restating numbers.
- [`guides/admin/TAGGING.md`](guides/admin/TAGGING.md) - per-instance cost-attribution tagging so several instances bill apart.

## Extend it (build on the platform)

- [`guides/developer/DEVELOPER-GUIDE.md`](guides/developer/DEVELOPER-GUIDE.md) - **start here.** The map of how to change and extend AgentEchelon; it links out to the tier, model-strategy, message-flow, RAG, delivery, and design-system docs so you do not have to hunt for them.

## Understand it (specs and decisions)

Specs, grouped by domain (each with its build-status header):

- [`specs/identity-access/`](specs/identity-access/) - who may act, as whom: admin identity, credential exchange, conversation security, access controls and auditing, moderation, add-user escalation, and the identity/access model with a worked example.
- [`specs/conversation-messaging/`](specs/conversation-messaging/) - conversation types, the interaction layer, welcome/context, the message-metadata codebook, the notification bridge, cross-channel tasks, and conversation archive and membership.
- [`specs/assistant-context/`](specs/assistant-context/) - assistant config, configurable intent packs, bilingual conversations, per-tier ownership.
- [`specs/analytics-eval/`](specs/analytics-eval/) - Aurora/VPC mode, drift convergence, cost sleep mode, and abuse/spend controls.
- [`specs/experiments-battle/`](specs/experiments-battle/) - the `/battle` design.
- [`specs/admin-console/`](specs/admin-console/) - the admin-console design behind `ADMIN-GUIDE.md`.

Design record:

- [`design/decisions/`](design/decisions/) - the numbered architecture decision records (ADRs): the rationale behind the choices above.
- [`design/`](design/) - forward-looking design specs (context-aware routing, federated participants, the demo company).

## Conventions

- **Single source of truth.** A number lives in exactly one doc. Cost lives in
  [`guides/admin/INFRASTRUCTURE-COST.md`](guides/admin/INFRASTRUCTURE-COST.md); everything else links to it.
- **Build status.** Every spec declares Implemented / Partial / Design in its first lines; design-only
  specs live under `design/`.
- **Audience-first.** This index is organized by what you are doing (deploy / operate / extend /
  understand), not by filename.

See also the root [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`SECURITY.md`](../SECURITY.md).
