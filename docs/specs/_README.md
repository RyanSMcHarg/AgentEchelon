# Specs, by layer

**Site section:** Specs index.

The platform is built as four layers, each running on the one below ([PLATFORM-OVERVIEW.md](../overview/PLATFORM-OVERVIEW.md)). This tree is organized the same way, for one reason: **a developer should be able to tell from the directory where AgentEchelon ends and their own client, channel or system of record begins.**

| Directory | The layer | Who owns what is in it |
|---|---|---|
| [interface/](./interface/) | **Interface** - the thin clients | **Replaceable.** A client renders, holds a bearer-pinned identity, and calls the APIs. It decides nothing: every rule it appears to apply is enforced again where the request is served. The web chat client and the operator console ship with the platform and are swappable for your own |
| [communication/](./communication/) | **Communication** - the connectivity that wires a client or an outside system to the engine | **The seam.** Messaging over WebSocket and REST today, outbound email, and connectors to your systems of record. Each channel is a provider you choose rather than one the platform hard-codes |
| [interaction/](./interaction/) | **Interaction** - the engine | **The platform.** AgentEchelon's own code over the AWS services it composes, where access is enforced in IAM before a request runs. This is what you configure rather than replace |
| [foundations/](./foundations/) | **Foundations** - how the platform is deployed and operated | **Yours to run.** The CDK stacks that provision every resource, the analytics mode, the cost controls |
| [demos/](./demos/) | Not a layer | The demo implementation shipped as a worked example |

## Where the platform ends

Everything in `interface/` and `communication/` is a seam: bringing your own chat client, your own admin surface, a voice or SMS channel, or a connector to a system you already run changes what sits there, and nothing in `interaction/` has to change to accept it.

**If you are building against the platform rather than on it, the guides are the place to start, not these specs.** [`API-GUIDE.md`](../guides/developer/API-GUIDE.md) and the generated [route inventory](../reference/api-contract.md) are the contract a client is owed - authentication, the limits, the refusals, every method and path. The specs here exist for someone changing the platform itself: they carry the *why*, the requirements a change must keep true, and the boundary each layer is responsible for. Reach for them when a guide leaves you asking why the seam is shaped the way it is.

Everything in `interaction/` is the engine, and it is configuration rather than code: an assistant is assembled from a capability profile, not written. That is why the interaction layer is subdivided rather than flat - it holds most of the platform, and a single folder would tell a reader nothing about where to look.

| Inside interaction/ | What it answers |
|---|---|
| [assistants/](./interaction/assistants/) | What an assistant is, and how it behaves. The group a vertical team works in |
| [conversation/](./interaction/conversation/) | The conversation and the work carried inside it: types, membership, tasks, the turn queue |
| [governance/](./interaction/governance/) | Who may act and how much, refused before the request runs: identity, the credential exchange, the classification boundary, moderation, auditing, the rate and spend limits |
| [quality/](./interaction/quality/) | Whether what the engine produced was any good: evaluation, battle, experiments |

## Two places the layers are not clean, stated rather than implied

**Governance is enforced by what foundations provisions, and that is the design.** The governance specs cite `backend/lib/stacks/` as often as they cite the engine, because the IAM policies and permissions boundaries that refuse a request are authored in CDK. That is tenet P4 working as intended - access is infrastructure rather than a policy engine an application path has to remember to call - so the documents sit with the question they answer, not with the file that emits the policy.

**The APIs are a layer apart from the clients that call them, and no spec is written along that line yet.** `interface/` holds the clients - the chat app and the operator console, both of them replaceable. The APIs they call belong to the interaction layer, and the contract they publish lives in the generated [route inventory](../reference/api-contract.md) and [`API-GUIDE.md`](../guides/developer/API-GUIDE.md) rather than in a spec. The residue is that the client specs still describe both halves: the chat-app pair carries the one-responder rule and the turn queue, which are engine, and the console pair carries what each surface serves and from which store alongside its nav and drill. An API spec per surface, with a thin-client spec that references it, is a rewrite rather than a move and has not been done - so a reader should take a client spec as covering the surface end to end for now, not as the boundary.

**The communication seam is specified further than it is separated.** A deployment bringing its own channel or its own system of record reads `communication/`, and the code behind those documents is only partly separated: the connector runtime is its own stack (`Connectors`) with PagerDuty and Salesforce adapters (`backend/lambda/src/lib/connectors/`), enabled only where a deployment declares a connector, while the message wire format lives in the analytics metadata helper. The contract is real and worth building against; the rest of the separation is a specification ahead of its implementation, and a reader should know that before planning around it.

## Reading one of these documents

A `SPEC-` states what the platform does for whom and why, with a requirements table carrying a priority, a delivery status and the specific test behind each row. A `DESIGN-` states how, and references its spec. Together they answer a contributor's two questions; a guide answers a caller's. The delivery status of anything lives in the spec's `Delivered` column and nowhere else, so a document's prose describes the design rather than its build state.

[e2e-coverage-matrix.md](../reference/e2e-coverage-matrix.md) is generated from every spec's `Status` and `Coverage` lines and collects what is proven end to end.
