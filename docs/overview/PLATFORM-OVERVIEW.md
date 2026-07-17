# AgentEchelon: one-page overview

**AgentEchelon is a self-hosted agent control plane: a governed, multi-party agentic AI platform that runs entirely in your own AWS account and serves your internal and customer-facing use cases from one place.** It is the governed layer between your agents and everything they touch (the harness around your models), deciding who may act, which model answers, where the context lives, and what gets recorded. Unlike the agent gateways and control planes emerging in 2026, it does not bolt a new policy engine and a separate agent-identity service onto your stack. It enforces with the cloud's own primitives: every user and every conversation is an AWS resource with an ARN, so access is an IAM decision, and each agent acts under a bearer-pinned identity, never a shared backend credential. This has the added benefit of enabling usage of AWS management tools to track and manage cost. Self-hosted, model-agnostic, MIT-licensed.

The point is centralization. Instead of standing up a separate tool for each use case (a support assistant here, an internal assistant there, another point solution next, each with its own login, data store, bill, and security review), you run one governed platform that serves them all, and a new experience is configuration over the same substrate rather than a new system.

## Where it fits

The category forming around this in 2026 is the *agent control plane* or *agent gateway*: the governed layer between agents and the models, tools, data, and people they reach. AgentEchelon fits it with two differences already visible above. It is **broader** than a tool-call gateway (the same governance covers the multi-party conversation and the surfaces people arrive through, not only an agent's tool calls), and its enforcement is **the cloud's own** (AWS IAM over tagged resources, provable with a deny-test) rather than a policy service you add and then have to trust.

## How it is built: three layers on an AWS foundation

Most agentic systems are a model plus tools, memory, and an orchestration loop. AgentEchelon assumes you have those and supplies the enterprise runtime around them, as three platform layers on a foundation of AWS managed primitives:

- **Interface layer.** The surfaces a participant meets: a web console for users and an admin console today; an embedded widget, phone/voice (PSTN), SMS and integration into existing 3rd party tools are designed and seamed.
- **Communication layer.** The substrate that moves messages and keeps context: a durable conversation that *is* the memory, a server-side hook on every message, and event capture with per-message metadata.
- **Interaction layer.** Who may act, as whom, at what capability, with which assistant, reaching which systems: governance enforced in IAM. Its composition root is the *conversation type*; five pillars (identity and access, assistant configuration, conversation configuration, connectors, auditing) compose every experience.

All three sit on **AWS managed primitives** (Amazon Chime SDK Messaging, Bedrock, S3, Cognito/STS, IAM, Kinesis), so inference, moderation, message delivery, and retention are AWS's to operate, not yours to build. The platform **integrates your identity provider** (Cognito by default, or your SSO/SAML/OIDC) rather than replacing it. Tools and knowledge are first-class: the assistant runs a **self-hosted tool loop** (not a managed agent service) and reads tier-scoped context and RAG from S3. Reaching outside systems of record is a **designed, opt-in connector seam** (the schema ships; it is not yet a shipped runtime path). It is not an MCP gateway today; the connector model is the intended vehicle for that, and governed MCP is a natural next step (see below).

## What it solves

- **Control.** You decide which model answers what; guardrails run on every model turn; retention lives in your account. The core access boundary, identity and classification, is enforced in AWS IAM before a request runs, with a conversation-level policy layer on top: defense in depth, not one check an application path has to remember. Every decision is recorded and queryable.
- **Low latency.** An instant placeholder becomes the answer in place, and analytics are written off the response path, so measuring a reply never slows it.
- **Cost.** Serverless with near-zero idle by default (the heavy analytics database is opt-in and can sleep), and the same routing and tiering that give you control hold down inference, the dominant variable cost.
- **Flexibility.** One control plane for your customer-facing *and* internal use cases: private tiered chat, a shared team room, a routed support case, or an announcement thread, all the same substrate composed differently, no new code.

## What is different

Three properties follow from enforcing in the cloud's own primitives rather than a policy layer on top:

- **Provable, not asserted.** Access is an IAM decision over tagged resources, so you demonstrate the isolation with a deny-test that watches AWS refuse a cross-boundary action, not a code review that hopes every path called the right check.
- **Control that does not degrade as you widen the room.** The substrate is multi-party: several people and more than one assistant in one governed room. Internal users at scale, one-off participants, and (by design) guests and federated externals each act at exactly their capability, because the boundary is enforced per actor.
- **The platform outlives the model.** The model is a swappable function call; swap it for whatever comes next and the control, routing, and record do not change.

And as the platform grows, the governance comes with it. The ecosystem is converging on MCP as the way agents reach tools; because access here is already an IAM decision with bearer-pinned identity, MCP tools plug into the same substrate, their calls scoped by classification, bearer-pinned, and guardrailed like everything else. So you can adopt the tool ecosystem without standing up a separate policy or identity system, and without opening a new ungoverned surface: you get the reach, and you keep the control you already had. The same holds for the customer-facing channels and federated identity. The seams are in place, so each is a configuration step on the governed substrate, not a new system to secure.

## What ships today

The internal, tiered use cases are live and governed: per-tier assistants on a self-hosted tool loop, mention routing, conversation sharing, proactive briefings, A/B experiments, drift detection, the admin console, and analytics. The customer-facing use cases, federated identity providers, and additional channels are **designed for and seamed**: a small build on top of what the project ships, not a re-architecture. All the doors are built; only the internal ones are open.

Deploy it into your AWS account, create a user, and read the code: the stacks are small and independent, and there is no magic.

---

## References: the 2026 enterprise agentic-AI landscape this positions against

*Category and analyst framing (the "agent control plane / agent gateway" that AgentEchelon speaks to):*
- [Agent Gateways Are Becoming The Control Plane For Enterprise AI (Forbes, Jul 2026)](https://www.forbes.com/sites/janakirammsv/2026/07/05/agent-gateways-are-becoming-the-control-plane-for-enterprise-ai/)
- [Google Cloud Next 2026: The Agentic Enterprise Control Plane (Bain & Company)](https://www.bain.com/insights/google_cloud_next_2026_the_agentic_enterprise_control_plane_comes_into_view/)
- [2026 is the year of enterprise AI governance (Speakeasy)](https://www.speakeasy.com/blog/2026-year-of-ai-governance) · [AI control plane architecture (Speakeasy)](https://www.speakeasy.com/resources/ai-control-plane)
- [A Five-Plane Reference Architecture for Runtime Governance of Production AI Agents (arXiv)](https://arxiv.org/html/2606.12320)

*AWS-native (the substrate, and the nearest managed alternative to contrast with):*
- [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/) · [AgentCore Identity: securing agentic AI at scale](https://aws.amazon.com/blogs/machine-learning/introducing-amazon-bedrock-agentcore-identity-securing-agentic-ai-at-scale/)
- [Guidance for Agentic AI Operational Foundations on AWS](https://docs.aws.amazon.com/solutions/agentic-ai-operational-foundations-on-aws/)

*How the gateway/control-plane category defines itself (incl. the MCP-gateway framing):*
- [What Is an Agent Gateway? The Definitive Guide, 2026 (MintMCP)](https://www.mintmcp.com/blog/agent-gateway-definitive-guide) · [Agent Control Plane (MintMCP)](https://www.mintmcp.com/blog/agent-control-plane)
- [Introducing Agent Gateway: A Unified Control Plane for Enterprise AI Agents (TrueFoundry)](https://www.truefoundry.com/blog/introducing-agent-gateway-a-unified-control-plane-for-enterprise-ai-agents)
