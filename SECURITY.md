# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in AgentEchelon, report it privately through GitHub:

- Open the repository's **Security** tab and choose **Report a vulnerability**. This opens a private advisory that only the reporter and the maintainers can see.

Do not open a public issue, pull request or discussion about it.

Include enough detail to reproduce the issue (affected component, steps, and impact). The maintainers aim to acknowledge reports within a few days. Please allow reasonable time to investigate and ship a fix before any public disclosure.

AgentEchelon is deployed into **your own AWS account**; there is no shared hosted service. A vulnerability report therefore concerns the code and infrastructure templates in this repository, not a multi-tenant service operated by the maintainers.

## Security model

AgentEchelon enforces access with AWS primitives - infrastructure, not just application code - so a misrouted request or an application bug cannot exceed what the assumed role and the channel's policy already permit.

- **Clearance from the trusted issuer, enforced by IAM.** Each identity provider is an entry in the trusted-issuer registry (`backend/lib/config/issuers.ts`) that declares where its people's clearance comes from and which classifications it may grant; for the deployment's own Amazon Cognito pool the source is its groups (`basic` / `standard` / `premium` / `admins`). The credential exchange vends the role of a classification the person is cleared for, and model access is gated by each classification's own IAM policies.
- **Classification-tagged channels (fail-closed).** Every channel is tagged with a `classification` at creation. IAM grants channel actions only on channels whose classification is one the caller's clearance grants; a classification is a declared set of grants, not a ladder. An untagged channel, or one outside that set, carries no matching grant, so the action is implicitly denied.
- **Bearer-pinned credentials.** The backend Credential Exchange vends short-lived, classification-bound Amazon Chime SDK credentials pinned to the caller's own identity - an actor can only ever act as itself. It is the sole source of Amazon Chime SDK credentials (there is no Identity-Pool over-grant fallback).
- **Guardrails.** The per-tier processors apply a Bedrock Guardrail out of band on **both sides** of an assistant turn: `source:'INPUT'` before the model call (prompt-injection / `PROMPT_ATTACK`
  + input content filters - Bedrock scores these only on input) and `source:'OUTPUT'` after (PII anonymize/block, content filters, internal metadata-marker masking). Guardrails cover assistant turns; conversation-level defense on non-assistant messages is the channel flow (runs on every message) plus archival with proactive analysis - see [`./docs/specs/interaction/governance/IDENTITY-AND-ACCESS-MODEL.md`](./docs/specs/interaction/governance/IDENTITY-AND-ACCESS-MODEL.md) §6b.
- **Least-privilege Lambdas.** Handlers are scoped to their own resources (per-tier context S3 prefixes, their own async processor, the specific tables they use), with reserved concurrency per tier.
- **Supply-chain hardening.** Install-time scripts are blocked (`.npmrc` `ignore-scripts`), dependencies are exact-pinned with committed lockfiles and installed with `npm ci`. See [`docs/guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md`](docs/guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md).

## Deploying securely

- Supply required configuration (`senderEmail`, `appUrl`, and any provider keys) via CDK context or environment - never commit secrets. `.env` is gitignored; use `.env.example` as the template.
- External image-generation keys are read from AWS Secrets Manager at runtime (`-c imageGenKeysSecretArn=…`) rather than baked into Lambda configuration.
- The default frontend distribution ships with a managed-rules WAF enabled; lock it to known IPs with `-c wafAllowedIps=…` for a private deployment.
- Amazon SES starts in sandbox mode for new accounts - verify sender and recipient identities before relying on email delivery.

For the deeper design of the identity and channel-security layers, see [`./docs/specs/interaction/governance/SPEC-CONVERSATION-SECURITY.md`](./docs/specs/interaction/governance/SPEC-CONVERSATION-SECURITY.md) and [`./docs/specs/interaction/governance/SPEC-CREDENTIAL-EXCHANGE.md`](./docs/specs/interaction/governance/SPEC-CREDENTIAL-EXCHANGE.md).
