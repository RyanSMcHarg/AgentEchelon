# Performance optimization (reducing latency)

AgentEchelon ships with **cost-lean defaults**, not latency-optimized ones. Out of the box every request path is serverless and scales to zero: Lambdas are on-demand (no provisioned concurrency), Aurora runs at a 0.5 ACU minimum, RDS Proxy is off, and the intent classifier is a live model call. That reduces cost for idle and low-traffic deployments, but it means the first request after a quiet period pays full cold-start cost, and the inbound path carries a model round-trip.

A production deployment with real, sustained traffic should trade some of that cost back for latency. This doc lists the levers, roughly in order of impact. Each is marked as a deploy-time knob (a context flag or profile field), an operator change in CDK (a code edit to the stack), or **NOT BUILT**. Measure before and after on the admin **Latency tab** (see [`LATENCY-TARGETS.md`](LATENCY-TARGETS.md) for what each metric means); the **Inbound** and **TTFF** numbers are where cold-start and classifier cost show up.

## Where the latency goes

A turn's user-perceived wait (the **E2E** metric) breaks into two parts:

1. **Inbound** (user message to async-worker entry): the Amazon Chime SDK ingest, the Lex/router fulfillment Lambda, the intent-classification call, and the invoke of the async-worker Lambda. On an idle deployment this is dominated by **two Lambda cold starts plus a model call**, so it can read several seconds. This is usually the single largest and most reducible chunk.
2. **Worker compute** (processor entry to answer posted): history load, the Converse tool loop, the guardrail, and posting the reply. Reduced mainly by model choice and retrieval efficiency.

The router and the async worker are **not** VPC-attached ([ADR-013](../../design/decisions/013-drift-retrieval-vs-decision.md)). The only VPC hop is the Aurora data-plane Lambda in Aurora mode: the router invokes it for the live drift check (when drift is on) and the worker invokes it for retrieval, so on an idle Aurora deployment a VPC Lambda cold start can add to either part.

## 1. Lambda cold starts

On a low-traffic deployment the router and async-worker Lambdas scale to zero, so most invocations cold-start. The inbound path crosses **two** of them, so cold starts stack.

- **Provisioned concurrency** on the router and per-classification async-worker Lambdas keeps warm execution environments ready so invocations skip init entirely. This is the highest-impact change for a deployment with steady traffic. **NOT BUILT** as a knob: no function in the stacks sets it. It is an operator change in CDK on the router and worker functions (an alias with provisioned concurrency), billed per provisioned environment-hour whether or not it is used; size it to your concurrent-turn volume.
- **Right-size Lambda memory.** More memory also means more CPU, which shortens both init and the tool loop. The worker's memory comes from the classification topology (`memorySize` in `backend/lib/stacks/assistant-profile-stack.ts`); changing it is an operator change in CDK.
- **ARM/Graviton.** **NOT BUILT:** every function runs on the default x86_64 architecture. Switching a function to ARM_64 is an operator change in CDK, worth testing where the runtime and dependencies support it (lower cost per ms, generally faster cold init).
- **Shrink the deployment bundle.** Init time scales with how much code and how many SDK clients load before the handler runs. Import only the AWS SDK v3 clients each function needs, and keep heavy work out of module top-level so it does not run during init.
- **Scheduled warmer.** **NOT BUILT.** A low-frequency scheduled ping that holds one environment open would remove the cold penalty from a demo or low-traffic instance; nothing in the stacks provides one.

Runtime init (module load plus first-call client setup) is what a cold start costs, which is why bundle size and provisioned concurrency matter.

### Opening a conversation

Opening a conversation crosses two functions in a chain: the person-facing API (`backend/lambda/src/create-conversation.ts`, `CreateConversationFunction` in `conversations-stack.ts`), which authorizes the request, and the classification's creator (`backend/lambda/src/create-conversation-at-classification.ts`, built by `lib/constructs/conversation-creator.ts`), which the API invokes synchronously and which assembles the channel. Neither is VPC-attached.

**The baseline, at 256 MB and without the measures below (measured 2026-10-23):** a cold open cost the person about 6.6 s. The API function spent 430 ms in Init and about 2.6 s on first-call work, then the creator spent 700 ms in Init and 2.9 s more. Warm, each function took 0.5 to 0.7 s. The cold path costs what it does for three reasons:

1. **First-call work at a small CPU share.** The first call to each AWS service pays the SDK's middleware, endpoint rules, credential resolution and TLS. At 256 MB a function gets about 0.145 vCPU for that, while Init runs with more.
2. **Every client and every serial read adds its own cost.** Each SDK client pays its own first call, so a module that builds its own SSM client beside the handler's pays twice. Reads awaited one after another add their round trips: the creator needs the registry, the primary assistant, the channel flow and the service admin before it writes the context row and makes eight Amazon Chime SDK calls, and the API needs the registry and the creator's key before its first Lambda call.
3. **Two cold functions in a chain.** A quiet deployment pays both cold starts on the same click.

What the two functions do about it:

- **Both start their reads while the module loads** (`backend/lambda/src/lib/cold-path.ts`). The creator starts the registry and the primary assistant's assignment read (which waits for the registry, because a runtime assistant's record is parsed against it), and beside them the channel flow and the service admin. The API starts the registry and then every member classification's creator key. The first request takes what is already in flight. A primed read is taken once and only within 30 s; every later request reads through the loader's own cache and TTL, so priming changes when a value is first read and never which value a request sees. A priming that failed or found nothing is read again once by the request that takes it, and a second failure takes the path it always took. This is the one exception to keeping work out of module top level: these are network reads every request needs, started without being awaited, so their synchronous setup runs inside Init and their round trips overlap the handler's start. Priming runs only inside a Lambda execution environment.
- **One client per service per function.** Each function builds one SSM client and hands it to the registry (`useProfileRegistrySsmClient`), and the creator also to the assignment records (`useDefaultAgentsSsmClient`) and the service admin's parameter (`useServiceAdminBearerSsmClient`); the API to the creator keys (`useConversationCreatorArnSsmClient`). The creator also hands its messaging client to the shared creator (`useChannelCreationMessagingClient`). Each setter is optional: every other function that loads these modules keeps the client the module builds for itself, which for the assignment records and the service admin is the turn-aware one a router turn needs.
- **The service admin leaves in one round trip.** Dropping its moderator record and its membership run together, because the admin's authority comes from the app instance rather than from either record and the two records are independent (see step 4 in `createConversationCore`, `lib/channel-creation.ts`). A call that fails is tried once more on its own. The adds stay in order: the flow is attached before the assistant becomes a member, and the assistant's membership is what fires its welcome.
- **1024 MB on both functions**, for the CPU it buys rather than the memory. Billed by GB-second, one cold open of both functions at about a second each costs about $0.00003 more than at 256 MB.
- **One timing line per request.** Each function logs one JSON line per request (`_timing: "create-conversation"` and `_timing: "conversation-creator"`) with `cold`, `totalMs` and the duration of each phase: the registry, the creator key and the invoke in the API; the registry, the primary assistant, the channel flow, the service admin, the context write, the primary tag, `CreateChannel`, the flow association, the assistant and opener adds and the admin's leave in the creator. Compare cold and warm lines in CloudWatch Logs Insights to read the effect of a change rather than infer it.

**Provisioned concurrency is not used for these functions.** One provisioned environment at 1024 MB bills about $10.80 a month whether or not anyone opens a conversation, so warming the API and one creator per classification is about $43 a month on a three-classification deployment. It is the owner's decision for a deployment whose traffic justifies it, made in CDK on an alias of each function.

## 2. Classifier latency

On the default path the router runs `classifyIntent()`, which for the default **LLM classifier** is a **synchronous Bedrock call** in the inbound window, before the async worker is invoked. That is often a second or more added to every turn's Inbound and TTFF.

- **Keyword classifier.** For classifications that do not need model-grade routing, set the profile's `classifierMode: 'keyword'` (`backend/lib/config/profiles.ts`). This removes the model call from the inbound path. The three default classification profiles use `'llm'`; the opt-in `ops-premium` role uses `'keyword'` as a cost control.
- **Classification caching.** **NOT BUILT:** the classifier does not cache results; every non-trivial turn makes the call.
- **Classifier model.** The classifier runs on Haiku (`CLASSIFIER_MODEL_ID`, set by `assistant-profile-stack.ts`), independent of the answering model. Changing the default is an operator change in CDK; a `classification` experiment (`resolveClassificationExperiment` in `backend/lambda/src/lib/experiment-manager.ts`) swaps the classifier model for a share of turns, which is how to measure a faster one before adopting it.

## 3. Database capacity

The analytics, admin and retrieval paths query Aurora. Cold database connections and low capacity add latency to those paths.

- **RDS Proxy** pools and reuses database connections, so a Lambda does not pay full connection setup on a cold or bursty invocation, and connection storms do not exhaust the cluster. It is **opt-in and off by default** (`--context enableRdsProxy=true`) because on Serverless v2 it bills a fixed 8-ACU floor, roughly **$88 / month** even when idle (see [`INFRASTRUCTURE-COST.md`](../admin/INFRASTRUCTURE-COST.md)). Turn it on for a production deployment with high Lambda concurrency; leave it off for a cost-sensitive or demo one.
- **Raise the Aurora minimum capacity (ACU).** The cluster is set to `serverlessV2MinCapacity: 0.5` in `backend/lib/stacks/archive-stack-aurora.ts`, which is cheap but slow to absorb a sudden query burst. Raising it is an operator change in CDK (there is no context flag), and each extra 0.5 ACU adds about $44 / month.
- **Reuse connections within a warm Lambda.** Hold the client across invocations (module scope) so a warm environment reuses an open connection rather than reconnecting per call.

## 4. Model inference (worker compute)

The Converse tool loop is usually the largest share of worker compute. It scales with the model and the output.

- **Match the model to the classification.** A faster default model for a classification cuts worker compute directly (its `models.default`; see [`MODEL_STRATEGY.md`](MODEL_STRATEGY.md#three-layers)). Review the routing against your latency targets.
- **Bedrock latency-optimized inference**, where available for your model and region, reduces per-call inference time. **NOT BUILT:** no Bedrock call sets `performanceConfig`, so enabling it is a code change.
- **Keep the region close** to Bedrock and to your users to cut network round-trip.
- **Trim retrieval.** A RAG-heavy turn shows up as **Tool** time, not model time. Return only the context the turn needs; oversized context reads slow the loop and inflate token cost.

## 5. Delivery and frontend

- The chat and admin frontends are served through CloudFront. Keep cache behaviors sensible so static assets are edge-cached and only API calls reach the origin.
- The placeholder-then-update delivery pattern means **TTFF** (time to the placeholder), not the full answer, is the responsiveness a user feels. Removing the router's cold start (section 1) and its classifier call (section 2) improves TTFF the most, because the router posts the placeholder itself (`postAsAssistant` in `router-agent-handler.ts`) after classifying the turn and before it dispatches to the async worker, so a router cold start or classifier call sits in front of it and the worker does not.

## Measuring impact

Every lever here is visible on the admin **Latency tab**:

- **Inbound** falls when you remove cold starts (section 1) and the classifier call (section 2).
- **TTFF** falls with the router's own time (its cold start and the classifier call), since the router posts the placeholder before the worker starts; see `router_ms` in [LATENCY-TARGETS](LATENCY-TARGETS.md).
- **Worker compute** / **Model** / **Tool** fall with model and retrieval changes (section 4).
- **E2E** is the end-to-end result and the number a user-facing SLA should track.

See [`LATENCY-TARGETS.md`](LATENCY-TARGETS.md) for the precise definition of each metric and the target bands.

## A note on cost

None of this is free. Provisioned concurrency, RDS Proxy, a higher Aurora floor, and latency-optimized inference all raise the baseline bill in exchange for lower latency. That is the deliberate trade the defaults leave to the operator: AgentEchelon defaults to low cost, and a production deployment decides how much of that to spend back on speed. Size each change to your actual traffic and targets rather than enabling everything.
