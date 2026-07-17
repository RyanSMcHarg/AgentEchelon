# AgentEchelon Overview

**AgentEchelon is a governed, multi-party agentic AI platform that runs entirely in your own AWS account and serves internal and customer-facing use cases from one place.** A core feature is that agent governance can be enforced with the cloud's own primitives instead of a bolted-on policy engine. Every user, assistant, and conversation is an AWS resource with an ARN; every actor holds a bearer-pinned identity, never a shared backend credential; access is an IAM decision keyed on an immutable classification tag: fail-closed, evaluated before any request runs, and **provable with a deny test rather than a code review.** Classifications are your labels (`internal`, `confidential`, `restricted`, whatever your data taxonomy already says), and each is served by a capability profile that fixes which model answers, at what depth, with what reach. Because enforcement is AWS-native, cost tracking and management ride the same tags and tools. Self-hosted, model-agnostic, MIT-licensed.

The point is centralization: instead of a separate tool per use case, each with its own login, data store, bill, and security review, one governed platform serves them all, and a new experience is configuration over the same substrate, not a new system.

![The authority plane: people and assistants as peer principals above one IAM decision plane, the conversation as the live context beside governed resources, one denied access, and derived context returning through the same scoping.](authority-plane.svg)
*The authority plane, not the request plane. Every actor (human or assistant) is a principal above one enforcement layer; the conversation is itself the governed resource; the record captures everything, including what was refused. (Channel access is enforced in IAM; derived-context scoping is enforced as a fail-closed metadata filter in the data plane: two mechanisms, one policy.)*

## Where it fits

The category forming in 2026 is the *agent control plane* or *agent gateway*: the governed layer between agents and the models, tools, data, and people they reach. AgentEchelon fits it with two differences. It is **broader** than a tool-call gateway: the same governance covers the multi-party conversation and the surfaces people arrive through, not only an agent's tool calls. And its enforcement is **the cloud's own** (AWS IAM over tagged resources) rather than a policy service you add and then have to trust.

## How it is built: three layers on an AWS foundation

Most agentic systems are a model plus tools, memory, and an orchestration loop. AgentEchelon assumes you have those and supplies the enterprise runtime around them:

- **Interface layer.** The surfaces a participant meets: a web console and admin console today; an embedded widget, phone/voice (PSTN), SMS, and integration into existing third-party tools designed and seamed.
- **Communication layer.** The substrate that moves messages and keeps context: a durable conversation that *is* the memory, a server-side hook on every message, and event capture with per-message metadata.
- **Interaction layer.** Who may act, as whom, at what capability, with which assistant, reaching which systems, enforced in IAM. Its composition root is the *conversation type*; five pillars (identity and access, assistant configuration, conversation configuration, connectors, auditing) compose every experience.

All three sit on **AWS managed primitives** (Amazon Chime SDK Messaging, Bedrock, S3, Cognito/STS, IAM, Kinesis), so inference, moderation, message delivery, and retention are AWS's to operate, not yours to build. The platform **integrates your identity provider** (Cognito by default, or your SSO/SAML/OIDC) rather than replacing it. The assistant runs a **self-hosted tool loop** (not a managed agent service), reading classification-scoped context and RAG from S3. Reaching outside systems of record is a **designed, opt-in connector seam** (the schema ships; the runtime path does not yet), and governed MCP is that seam's intended vehicle (see below).

## What it solves

- **Control.** You decide which model answers what; guardrails run on every model turn; retention lives in your account. Identity and classification are enforced in IAM before a request runs, with a conversation-level policy layer on top: defense in depth, not one check an application path has to remember. Every decision is recorded and queryable.
- **Low latency.** An instant placeholder becomes the answer in place, and analytics are written off the response path, so measuring a reply never slows it.
- **Cost.** Serverless with near-zero idle by default (the heavy analytics database is opt-in and can sleep), and the same routing and capability profiles that give you control hold down inference, the dominant variable cost.
- **Flexibility.** A private assistant scoped to one classification, a shared team room, a routed support case, an announcement thread: the same substrate composed differently, no new code.

## What is different

Three properties follow from enforcing in the cloud's own primitives rather than a policy layer on top:

- **Provable, not asserted.** The deny test: you demonstrate isolation by watching AWS refuse a cross-boundary action, not by a code review that hopes every path called the right check.
- **Governance that widens with the room.** The substrate is multi-party: several people *and several assistants* in one governed room. Each assistant is a member: its own identity, its own scoped credentials, its own attributed and revocable place in the record. Where other multi-agent stacks hide collaborators behind a single principal, here "which agent acted, under what authority" falls out of the substrate. Guests and federated externals (by design) act at exactly their capability, because the boundary is enforced per actor.
- **The platform outlives the model.** The model is a swappable function call; swap it for whatever comes next and the control, routing, and record do not change.

And as the platform grows, the governance comes with it. The ecosystem is converging on MCP as the way agents reach tools; because access here is already an IAM decision with bearer-pinned identity, MCP tools plug into the same substrate, scoped by classification, guardrailed like everything else. You get the reach and keep the control you already had. The same holds for customer-facing channels and federated identity: the seams are in place, so each is a configuration step on the governed substrate, not a new system to secure.

## What ships today

The internal use cases are live and governed: per-profile assistants on a self-hosted tool loop, mention routing, conversation sharing, proactive briefings, A/B experiments, drift detection, the admin console, and analytics. The sample deployment ships three classifications named `basic`/`standard`/`premium`, a tiered-chat example, not the substrate's opinion; name them after your own taxonomy. The customer-facing use cases, federated identity providers, and additional channels are **designed for and seamed**: a small build on top of what the project ships, not a re-architecture. All the doors are built; only the internal ones are open.

Deploy it into your AWS account, create a user, and read the code: the stacks are small and independent, and there is no magic.
