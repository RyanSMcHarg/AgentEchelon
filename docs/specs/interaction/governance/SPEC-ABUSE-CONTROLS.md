# SPEC: Abuse Controls (rate limiting, spend budgets, request dedup)

**Status:** Partial. The five controls and the shared table they ride are in place; the requirements table states what is delivered, what is partial and what each is validated by.

**Coverage:** `e2e/abuse-controls.spec.ts` - asserts the shared control table is wired to the deployed handler (without it every limit refuses and dedup is off), and that a user at the hourly limit receives the rate-limit notice instead of a model answer. The spend budgets and the SSM circuit are on by default and are asserted at synthesis rather than end to end, since an hourly limit cannot be reached inside a test run.

**Verified by:** `backend/test/lib/abuse-controls.test.ts` asserts the control-plane behavior against a mocked table - request dedup (first-claim true, duplicate false, fail-open), the per-user + global spend budget and the per-user hourly rate limit (each refusing on a store error and when set with no table, and admitting at a limit of 0), the inbound length cap, and the shared `evaluateAbuseGate` order (rate before budget, message selection, admin exemption). `backend/test/cdk-synth.test.ts` asserts the wiring: the shared table env + DynamoDB write grant + length cap on the classification handlers and the channel-flow processor, and that the spend budget and the SSM circuit are on by default with an explicit `0` turning them off. `backend/test/abuse-controls-wiring-requires-its-table.test.ts` asserts that synthesis refuses a wiring with no table name.

**Related:** [ADR-022](../../../design/decisions/022-message-identity-is-established-at-the-channel-flow.md) - where a message's identity is established. [SPEC-ADMIN-IDENTITY.md](./SPEC-ADMIN-IDENTITY.md) - the admin identity plane the exemption reads a group from. [SPEC-PER-PROFILE-OWNERSHIP.md](../assistants/SPEC-PER-PROFILE-OWNERSHIP.md) - the per-classification ownership model these checks are shared across.

**Site section:** Interaction layer, governance.

---

## Overview

**This is a cost-and-abuse control plane, and it is deliberately separate from the reliability layer beside it.** `bedrock-resilience.ts` owns what happens when a model call fails: retry with backoff, a per-model circuit breaker, model fallback, and a tool-loop iteration cap. This layer owns whether the call is allowed to happen at all. The two compose in one place, and neither is expressed in terms of the other.

**One small DynamoDB table backs all five controls, which is what makes them cheap enough to be on by default.** `AbuseControlsTable` is owned by the Conversations stack and published on the shared SSM contract next to the task tables. Its schema is one namespaced partition key plus a TTL, so a dedup claim, a rate-limit counter and an hourly spend counter are the same row shape with different prefixes and every entry self-expires within minutes to two hours. Because the table is in the foundations stack rather than the analytics stack, every control runs identically in both analytics modes and no requirement below carries a mode.

**Every limit fails closed; idempotency keeps its own policy.** The rate limit, the per-user budget and the global budget are limits: each refuses when its store errors or its table is unset, because a control-table outage must not become an unbounded-spend or unbounded-request path. Dedup and the placeholder mapping are idempotency, not limits: their worst case is one duplicate, so they fail open. A limit set above 0 that applies to the call refuses with no table (`backend/lambda/src/lib/abuse-controls.ts:180-182,267-269`) and on a store error (`backend/lambda/src/lib/abuse-controls.ts:206-207,279-280`), and synthesis refuses a wiring with no table name (`abuseControlsWiring`, `backend/lib/stacks/agent-classification-common.ts`). A limit configured as 0 is off, which is policy rather than a failure. **NOT BUILT:** the rate limit is off when the person key is empty (`backend/lambda/src/lib/abuse-controls.ts:264`).

**An unauthenticated route carries its own controls, in the handler.** A route a person reaches before holding a session (a guest start, an invitation redeemed in `link` mode) has no user identity to count against, so the handler enforces four controls before it does any work: a captcha verified server-side, a per-IP limit, a per-person message limit once the guest's AppInstanceUser exists, and a kill switch. All four fail closed, and no bypass token exists in a production configuration. HTTP API route throttling caps each of those routes as well. There is no AWS WAF on the API: AWS WAF does not associate with an HTTP API, so the controls live in the handler. The accepted cost is that an abusive request still reaches and bills the Lambda, and a flood throttles legitimate visitors. If traffic shows the in-handler limits are not enough, the fallback is a small REST API with AWS WAF carrying only the unauthenticated routes. The two HTTP APIs carry a throttle per route and no AWS WAF (`RouteTableApi`, `backend/lib/constructs/http-api.ts`). **No vendor reaches an unauthenticated route:** a connector receives its vendor's events through the vendor's Amazon EventBridge partner event source, on a rule pinned to that source, and no HTTP route serves a vendor ([SPEC-CONNECTORS.md](../../communication/SPEC-CONNECTORS.md)). **NOT BUILT:** `link` redemption and its controls, and `IngressApi`, the HTTP API a vendor with no EventBridge integration (Twilio) would need.

**Deduplication is the hard part, and it is two claims at two layers guarding two different things.** The channel flow claims the inbound message by the Amazon Chime SDK `MessageId` for every message that dispatches a turn, which is the only stable message identity anything sees. The shared pipeline claims the dispatch by its correlation id, which collapses a replay of one dispatch such as an asynchronous Lambda retry. In between, the router claims the turn's derived correlation id, so two Amazon Lex fulfillments of one message resolve to one turn. A fulfillment that loses that claim replays the same placeholder and the same marker rather than going silent, because Amazon Chime SDK materializes one message per turn from the last fulfillment response, so silencing the second attempt can silence the only response that reaches the channel.

**The gate keys on the conversation's classification, never on the sender's credential.** The channel's `classification` tag is what the turn is metered at, whatever grants the sender holds, and the async-processor event carries it. The sender's clearance is resolved only to decide the admin exemption and as a mismatch signal. The `admin` classification is admin-plane only and is never a conversation's classification, so an admin who is chatting is metered at the conversation's classification unless the deployment opted into the exemption.

## Business Problem

A deployment with no limits is one bug, one automated client or one traffic spike away from an unbounded model bill, and nothing in the account will stop it. At the same time a single heavy user can monopolize an assistant, so everyone else waits longer and pays for it. Duplicate message deliveries make both worse: Amazon Chime SDK and Amazon Lex deliver at least once, so one user message can be fulfilled twice, which bills twice and can corrupt task state when two fulfillments of one turn carry two independent identities. The alternative to this layer is assembling a rate limiter, a spend budget and a deduplication store per deployment and keeping them in step with every path that reaches a model.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. Three of them meet this layer, and they meet it at different moments: one sets the limits, one is stopped by them, and one answers for the paths a duplicate can arrive on.

### Admin / operator

**How this relates to them:** they own the account, its bill and the decision about how much a deployment is allowed to spend in an hour. Every limit in this document is theirs to set, and the failure they cannot accept is a control that silently permits everything.

| What they need | Requirement |
|---|---|
| A spend limit that is in force without being configured, so a new deployment is bounded from the first turn | FR3, FR4 |
| A per-user request limit that does not need a code change to tune | FR2 |
| A control-table outage that cannot become unbounded spend | FR11 |
| Unauthenticated routes that refuse a flood and can be closed at once | FR13, FR14, FR15, FR16, FR17 |
| An edge signal to shed load once the account-level limit is crossed | FR5 |
| An exemption for administrators that never extends to the account's own limit | FR6 |
| One control table with no accumulation to manage | FR1 |

### End user

**How this relates to them:** they never configure anything here and only meet the layer when it stops them, so what matters is that a refusal is legible and that a duplicate delivery does not produce two answers to one question.

| What they need | Requirement |
|---|---|
| A plain notice saying the limit was reached and when to retry, rather than silence or an error | FR2 |
| One answer to one message, even when the platform delivers that message twice | FR7, FR9 |
| A long pasted prompt handled rather than rejected, up to a stated cap | FR10 |
| A neutral high-demand reply rather than a raw failure when a limit is crossed | FR3, FR4 |

### Platform developer

**How this relates to them:** they answer for the paths a turn can arrive on, and deduplication is the one control whose correctness depends on that map being complete. A key derived differently on two paths is a control that looks present and collapses nothing.

| What they need | Requirement |
|---|---|
| A dedup key that is stable across a retry of the same turn on every path | FR7, FR8 |
| One shared library and one shared pipeline, so a new classification inherits every control | FR12 |
| A duplicate that cannot leave a stranded placeholder above the answer | FR9 |
| The claim taken before the work, so a stranded claim expires and a stranded placeholder does not | FR7 |

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

No `Mode` column appears below: the control table lives in the Conversations stack and every control behaves identically in both analytics modes.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | One shared DynamoDB table backs every control, with a namespaced partition key, a TTL on every entry so nothing accumulates, and publication on the shared SSM contract; what a control does when its table env is unset is FR11's failure direction | Enabler | Yes | `cdk-synth` (unit, behavior), `abuse-controls` (unit, behavior), `abuse-controls` (e2e, behavior) |
| FR2 | A per-user hourly request limit is enforced before the answer model call, metered at the conversation's classification against that classification's profile `rateLimitPerHour`, and an over-limit turn receives a notice naming when to retry instead of reaching the answer model. The intent classifier, itself a model call, runs before the limit and is not counted ([MESSAGE-FLOW §6.19](../../../guides/developer/MESSAGE-FLOW.md#619-the-abuse-gate)) | Table stakes | Yes | `abuse-controls` (unit, behavior), `abuse-controls` (e2e, behavior) |
| FR3 | A global hourly model-spend limit is in force by default, counts every sender including administrators, and returns the canned response to everyone once crossed | Table stakes | Yes | `abuse-controls` (unit, behavior), `cdk-synth` (unit, behavior) |
| FR4 | A per-user hourly model-spend limit is in force by default and returns the canned response to that user alone | Table stakes | Yes | `abuse-controls` (unit, behavior), `cdk-synth` (unit, behavior) |
| FR5 | Crossing the global trip threshold flips an SSM circuit parameter that an edge intake can read to shed load before a request reaches a model | Differentiator | Partly - the parameter is written and granted, and no edge consumer reads it yet | `abuse-controls` (unit, behavior), `cdk-synth` (unit, behavior) |
| FR6 | An opt-in admin exemption releases a sender in a trusted, server-verified Cognito group from the per-user rate limit and the per-user budget only, and never from the global budget | Differentiator | Yes | `abuse-controls` (unit, behavior), `cdk-synth` (unit, behavior) |
| FR7 | Two deliveries of one user message produce one turn and one answer, keyed on an identity that is stable across a retry rather than minted per delivery | Table stakes | Partly - the flow path is driven through the runtime derivation on a redelivered message; the Lex path's derived key is asserted against a mocked table with the key passed in, so no test drives a duplicate Lex fulfillment through it | `flow-dedup-survives-a-cold-container` (unit, behavior), `abuse-controls` (unit, behavior) |
| FR8 | Two executions of one dispatch collapse to one, claimed at the top of the shared pipeline before any model or task work | Table stakes | Yes | `abuse-controls` (unit, behavior) |
| FR9 | A fulfillment that loses the turn's claim replays the same placeholder and the same correlation marker rather than posting a second placeholder or going silent, and the flow denies a second placeholder for a turn already in flight | Table stakes | Partly - the placeholder mapping claim is driven; the replay and the gate-blocked silence are pinned in source text only | `the-sender-records-where-it-sent` (unit, behavior), `the-reading-contract-names-only-what-the-prompt-showed` (unit, source text) |
| FR10 | An inbound message longer than the configured cap is truncated before it reaches the model, and the truncation is logged | Table stakes | Yes | `abuse-controls` (unit, behavior), `cdk-synth` (unit, behavior) |
| FR11 | Each control states its runtime-failure direction and holds to it: every limit (the rate limit, the per-user budget, the global budget) refuses when its store errors or its table is unset, and dedup and the placeholder mapping, which are idempotency rather than limits, fail open | Table stakes | Yes - each limit refuses on a store error and when it is set with no table (`backend/lambda/src/lib/abuse-controls.ts:180-182,206-207,267-280`), synthesis refuses a wiring with no table name, and dedup and the placeholder mapping fail open | `abuse-controls` (unit, behavior), `abuse-controls-wiring-requires-its-table` (unit, synthesized wiring) |
| FR12 | The checks live in one shared library called from one shared pipeline and from the router, so every classification and every dispatching path inherits them from one code path | Enabler | Yes | `abuse-controls` (unit, behavior), `cdk-synth` (unit, behavior) |
| FR13 | Every unauthenticated route (guest start, `link` invitation redemption) verifies a captcha server-side before any work, and refuses when the verifier is unavailable | Table stakes | Partly - guest start verifies Cloudflare Turnstile server-side before anything is minted or signed, and refuses `unavailable` when the verifier cannot answer (`backend/lambda/src/lib/guest-abuse.ts`); `link` invitation redemption runs the same kill switch, per-address limit (its own `link-ip#` rows) and captcha first, with an `invitation-link` issuer declared (`backend/lambda/src/lib/invitation-redemption.ts`). No vendor route exists: connector events arrive through EventBridge partner event sources (`backend/lib/stacks/connectors-stack.ts`) | `the-guest-session-fails-closed` (unit, behavior), `an-invitation-is-redeemed-once-in-its-mode` (unit, behavior), `connectors-hold-only-their-own-reach` (synth) |
| FR14 | Every unauthenticated route enforces a per-IP limit, and a guest's turns meet a per-person message limit keyed by the guest's AppInstanceUser; both refuse when their store errors or is unset | Table stakes | Partly - guest start counts an IPv4 address or an IPv6 /64 per window, as a salted hash, and refuses `unavailable` when its store errors or is unset; a guest's turns are metered by the router at the `greeter` profile's `rateLimitPerHour`, keyed by the guest's AppInstanceUser, as FR2 meters every turn. `link` invitation redemption counts the same way under its own `link-ip#` rows and salt (10 per 60 minutes by default), and a link session's turns are metered as every person's are | `the-guest-session-fails-closed` (unit, behavior), `an-invitation-is-redeemed-once-in-its-mode` (unit, behavior) |
| FR15 | A kill switch closes every unauthenticated route at once without a deploy, and an unreadable switch reads as closed | Table stakes | Partly - the guest issuer's switch (an SSM parameter under `SSM_ROOT`, `backend/scripts/guest-switch.mjs`) closes guest start and guest refresh, and an unreadable value refuses `unavailable`; the `invitation-link` issuer's own switch (`<SSM_ROOT>/invitation-link/<issuer id>/paused`) closes `link` redemption the same way. **NOT BUILT:** one switch closing both at once, and a script that changes the link switch | `the-guest-session-fails-closed` (unit, behavior), `an-invitation-is-redeemed-once-in-its-mode` (unit, behavior) |
| FR16 | No bypass token for these controls exists in a production configuration | Table stakes | Yes for guest start and `link` redemption - no bypass exists in any configuration: synth refuses a guest or `invitationLink` setting it does not know, and in production refuses the captcha test keys, a missing captcha secret and a limit of 0 | `the-guest-issuer-is-declared-with-its-controls` (unit, behavior), `an-invitation-link-issuer-is-declared-with-its-controls` (unit, behavior) |
| FR17 | HTTP API route throttling caps each unauthenticated route, and there is no AWS WAF on the API | Table stakes | Partly - the two HTTP APIs carry a throttle per route and no AWS WAF (`backend/lib/constructs/http-api.ts`); guest start (5 per second, burst 10), guest refresh (20, burst 40), the invitation landing page's read (10, burst 20) and `link` redemption (5, burst 10) each carry their own | `the-guest-session-reaches-one-conversation` (unit, behavior), `each-route-is-served-once-on-its-api` (synth) |

**Reading the "Validated by" column.** Each entry is one specific test, named by its filename without its extension. Backend unit tests live in `backend/test/` (this layer's under `backend/test/lib/`); end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists.

**Known limits on the delivered rows.** FR7's Lex-path tests pass the claim key in directly, so they pass whether or not the derived key is stable, which is why the row reads `Partly`: the flow path has the coverage that drives a redelivery through the derivation, and the Lex path does not. FR5's parameter has no reader in this repository, so the trip is observable in SSM and shed nothing at the edge. FR13 to FR17 describe the routes a person reaches before holding a session: guest start and `link` invitation redemption, each built with the controls those rows state.

**OPEN:** whether the spend budget should be token-weighted rather than a request count. A request count is what ships and it is a proxy: two turns of very different size consume one unit each. A token-weighted counter tracks real spend and needs a second write after the call rather than a check before it.

**OPEN:** how the circuit resets. An hourly window reset is implicit in the key, and an explicit administrator reset is not built.

**OPEN:** whether the rate-limit refusal should be a structured control message the frontend can render distinctly rather than a plain reply.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| Model-failure handling: retry, backoff, per-model circuit breaking, model fallback | A different question with a different answer. This layer decides whether a call may happen; that layer decides what to do when one fails | `backend/lambda/src/lib/bedrock-resilience.ts` owns it, and the two compose in the shared pipeline |
| A token-weighted spend budget | A request-count proxy is one atomic increment before the call; weighting by tokens needs the call's result and a second write | The OPEN item above |
| An edge consumer of the circuit parameter | Writing the signal and reading it are separate changes with separate owners, and the signal is useful in SSM on its own | FR5 states what is delivered; the reader belongs to whatever intake fronts a deployment |
| A billing-threshold trigger that sheds load on cost rather than on volume | Cost arrives hours late, so it cannot gate a request. It can, however, pause an idle deployment | [SPEC-COST-SLEEP-MODE](../../foundations/SPEC-COST-SLEEP-MODE.md) |
| Per-user quotas expressed anywhere but the profile | A second place to set a limit is a second answer to one question (tenet D7) | FR2 reads the profile's `rateLimitPerHour`, and no environment variable carries a limit |
| Deduplication by message content | Two deliberate identical messages are a legitimate conversation; the window is sized for a retry, not for a conversation | FR7 keys on the message identity and a bounded time window, and the trade is stated in Appendix B |
| An admin exemption from the global budget | An exemption that reaches the account limit is a path to unbounded spend, which is the one thing this layer exists to prevent | FR6 scopes the exemption to the two per-user controls |
| AWS WAF in front of the API | AWS WAF associates with REST APIs and CloudFront, not with HTTP APIs, and the person-facing API is one HTTP API, `PersonApi`, with no web ACL. The managed-rules web ACL on the frontend's CloudFront distribution (`backend/lib/constructs/frontend-distribution.ts`) protects the static site, not the API | FR13 to FR17, in the handler. If traffic shows those limits are not enough, a small REST API with AWS WAF carries only the unauthenticated routes |
| A bypass token for testing in production | A token that skips the captcha or the limits is a credential that defeats every control on the route it opens | FR16. A test deployment configures its own verifier |

## User Experience Description and Mocks

This layer has no surface of its own. It is configured at deploy time and met, when it is met at all, as a reply the assistant sends instead of an answer.

### The end user's journey

1. **Ordinary turns are untouched.** Every control is a read or a counter increment ahead of the model call, and none of them adds a message.
2. **At the hourly request limit, the assistant says so** (FR2). The reply names the limit and when to try again, and no model call is made.
3. **At a spend limit, the assistant reports high demand** (FR3, FR4). The wording is neutral because the cause is the deployment's budget rather than anything the person did.
4. **A very long message is answered rather than refused** (FR10), truncated at the cap and logged.
5. **A duplicated delivery still produces one answer** (FR7, FR9). The second fulfillment replays the same waiting message, so nothing appears twice and no waiting bubble is left above the answer.

### The admin / operator's journey

1. **Deploy and be bounded already** (FR3, FR4). Both spend limits carry a default, so the account has a limit before anyone has tuned anything.
2. **Tune the limits by context, not by code** (FR2, FR3, FR4, FR10), and set an explicit `0` where a deployment means to run without one.
3. **Decide whether administrators are metered** (FR6). The default is that they are.
4. **Watch the circuit parameter for the account-level trip** (FR5).
5. **Read the refusal path as a cost control, not an outage** (FR11). A global-budget failure serves the canned response by design.

## Related Documents

- [ADR-022](../../../design/decisions/022-message-identity-is-established-at-the-channel-flow.md) - where a message's identity is established, which is what FR7 rests on
- [SPEC-ADMIN-IDENTITY.md](./SPEC-ADMIN-IDENTITY.md) - the separate admin identity plane, and why the `admin` classification is admin-plane only
- [SPEC-PER-PROFILE-OWNERSHIP.md](../assistants/SPEC-PER-PROFILE-OWNERSHIP.md) - the per-classification ownership model the shared pipeline serves
- [SPEC-COST-SLEEP-MODE.md](../../foundations/SPEC-COST-SLEEP-MODE.md) - the other cost control, which sheds idle spend rather than bounding request volume
- [TENETS.md](../../../overview/TENETS.md) - tenet P5 for fine-grained cost control and tenet D8 for reusing the shared table and the shared pipeline
- [MESSAGE-FLOW.md](../../../guides/developer/MESSAGE-FLOW.md) - the paths a turn arrives on, which is the map deduplication has to cover

## Appendix A - The shared control table

One DynamoDB table, `AbuseControlsTable`, owned by `backend/lib/stacks/conversations-stack.ts` and published on the shared SSM contract next to the task tables. One generic schema backs every control:

| Key namespace | Written by | What it is |
|---|---|---|
| `dedup#flow-<MessageId>` | the channel flow, and the task-answer repair path for the message it repairs | the inbound delivery claim, taken for every message that dispatches a turn |
| `dedup#fulfil-<correlationId>#p{pass}#f{fold}` | the router | the turn's fulfillment claim, scoped to the triage pass and the amendment fold so each legitimate re-entry keys apart |
| `dedup#fulfil-blocked-<correlationId>#p{pass}#f{fold}` | the router | written when the claim's winner was refused by the gate, so a losing duplicate stays silent and lets the notice stand rather than replaying a placeholder |
| `dedup#<correlationId>[.p<pass>][.f<fold>][.a<attempt>][.fail]` | the shared pipeline | the dispatch claim, with the same discriminators as suffixes |
| `dedup#drift-suggest-<MessageId>`, `dedup#repair-<MessageId>` | the live drift flow; the task-answer repair path | one suggestion per originating message; one repair per message |
| `corr#<correlationId>` | the channel flow | the placeholder mapping, so the processor can resolve the message to update ([ADR-022](../../../design/decisions/022-message-identity-is-established-at-the-channel-flow.md)) |
| a one-action-per-message claim | the post-processing consumer | a conditional put, so two Kinesis deliveries on two containers cannot both act |
| `ratelimit#<personId>#<hourKey>` | the router and the channel flow | the hourly request counter |
| `budget#user#<personId>#<hourKey>` | the shared pipeline | the per-user hourly model-call counter |
| `budget#global#<hourKey>` | the shared pipeline | the account-wide hourly model-call counter |

Every entry carries a `ttl` in epoch seconds with DynamoDB TTL enabled, so the table never accumulates. Billing is `PAY_PER_REQUEST`, and the removal policy follows the data policy the task tables use. Each handler that can dispatch a model call carries the table name as `ABUSE_CONTROLS_TABLE` plus `dynamodb:GetItem`, `dynamodb:PutItem` and `dynamodb:UpdateItem` on it; the post-processing consumer, which takes only its one-action-per-message claim by conditional put, carries `dynamodb:PutItem` alone.

The control logic lives in one shared library, `backend/lambda/src/lib/abuse-controls.ts`, called from `runSharedPipeline` in `async-processor-core.ts` and, for the rate limit, from the router and the channel flow before either opens a task or invokes a processor. `evaluateAbuseGate` is the shared entry point and fixes the order: the rate limit first, then the budget, so a blocked turn never consumes budget.

## Appendix B - How deduplication works

Deduplication needs a key that is the same for both deliveries of one message. An Amazon Lex fulfillment does not receive the Amazon Chime SDK `MessageId`, so the key cannot simply be the message id on every path ([ADR-022](../../../design/decisions/022-message-identity-is-established-at-the-channel-flow.md)).

**The inbound delivery claim (channel flow).** The flow holds the only stable message identity anything sees, so it claims `dedup#flow-<MessageId>` for every message that dispatches a turn. The predicate is a dispatch predicate rather than a list of bypass tokens: `@all`, `/battle`, a mention resolving to an assistant, a command dispatched to the primary, a turn the flow owns that carries no token at all, an addressed message whose roster could not be read, and a reference target. A message that loses the claim is still called back, because the claim says the message was handled rather than that its callback was resolved. Two branches that return above the shared claim take it themselves, so a redelivered misdirected private address does not tell its sender twice.

**The fulfillment claim (router).** A claim collapses two fulfillments only if both carry the same key, so the router derives the turn's correlation id rather than minting a random one. A caller that can declare the identity does: a bypass supplies the inbound `MessageId`, which is stable across a redelivery, and `/battle` mints a fully declared id per side because the battle state row keys on it. Only a turn that reaches Amazon Lex with nothing declared falls back to `turnCorrelationId`, a hash over the channel, the sender, the message text and a 90-second bucket. The Amazon Lex `sessionId` is deliberately excluded: it discriminates nothing that the channel and sender do not, and including it would make the control depend on Amazon Chime SDK replaying the same session. The key carries a suffix for the two re-entries that are legitimately a second turn on one correlation id - a later triage pass and an amendment fold - so a genuine retry of a fold still deduplicates against that fold while the fold itself is not read as a redelivery of the turn it amends.

**A losing fulfillment replays the placeholder.** Amazon Chime SDK materializes one message per turn from the last fulfillment response, so returning nothing can suppress the only message that reaches the channel. The loser therefore returns the same placeholder carrying the same `<!--corr:-->` marker and does no work: the two attempts are interchangeable, and whichever materializes is the one the single dispatched processor updates in place. The exception is a winner that took the claim and was then refused by the gate: it dispatched nothing and returned a notice rather than a placeholder, so the duplicate stays silent and lets the notice stand.

**Claiming before the work is a deliberate trade.** A fulfillment that fails midway is not retried until the claim expires. It is chosen because a claim expires and a stranded placeholder does not.

**Duplicate placeholder suppression (channel flow).** A retried fulfillment still causes Amazon Chime SDK to post a second placeholder. The flow writes the `corr#<correlationId>` mapping conditionally when a bot message carrying the marker passes through; if the key already exists this is a second placeholder for a turn already in flight, and the flow denies it. Denying a bot message is safe, and the result is one placeholder updated in place.

**The pipeline claim (async processor).** At the top of `runSharedPipeline`, before any model or task work, the delivery is claimed under `dedup#<correlationId>`, suffixed `.p<pass>` for a later triage pass, `.f<fold>` for an amendment fold, `.a<attempt>` for a recovery attempt and `.fail` for a failure announcement, so that each re-entry that is legitimately a second delivery on one correlation id keys apart while a genuine retry of any of them still collides. This collapses a replay of one dispatch, such as an asynchronous Lambda retry carrying an identical event and therefore an identical correlation id. It is not redundant with the fulfillment claim: that one collapses two fulfillments of one user message, and this one collapses two executions of one dispatch.

**The trade the window makes.** Two byte-identical messages from the same sender inside the same 90-second bucket, on a path that derives rather than declares the identity, resolve to one turn and receive one answer. The window is sized for a retry, not for a conversation.

## Appendix C - Enforcement points and configuration

| Layer | What it enforces |
|---|---|
| Channel flow (`channel-flow-processor.ts`) | the inbound delivery claim on the Amazon Chime SDK `MessageId` for every message that dispatches a turn; the `corr#<correlationId>` placeholder mapping when a bot message passes through; the rate limit for the dispatches it makes itself |
| Router (`router-agent-handler.ts`) | the turn's correlation id, derived or read from a declaration; the fulfillment claim on it; the rate limit before a task is opened or a processor invoked |
| Shared pipeline (`async-processor-core.ts`, `runSharedPipeline`) | the dispatch claim; the spend budget before the model call; the length cap on the inbound user message before it reaches the model |

A duel is gated once as a whole, before the fan-out, because it is up to four model invocations. A resumed duel turn, where a person answers a waiting side, arrives as an ordinary turn that nothing upstream gated and is metered by the router like any other; only a battle context declared by the flow, which already paid for the duel, skips the router's gate.

A join recap (a person was just added and the room's assistant catches them up, privately) is metered against nobody's allowance: the turn names the new member, who asked for nothing, so it spends neither their hourly rate limit nor their per-user budget (`machineWritten` on `evaluateAbuseGate`). It still calls a model, so the global budget counts it and can refuse it, as it can every turn; a refused recap is skipped and logged rather than answered with a budget line the new member never prompted.

**The same rule meters every turn no person asked for (NOT BUILT beyond the join recap).** [ADR-061](../../../design/decisions/061-a-welcome-is-a-workflow-an-event-starts.md)'s `agent` steps, its `voice` renders and the `prompt` welcome are metered as the join recap is: `machineWritten`, against the global budget and no person's allowance, one rule for all of them, with a refused charge taking the step's platform fallback. Their volume is bounded where they start rather than by a second meter: one run per event's natural key, one schedule per timed thing, at most one nudge per person per meeting or invitation, and a capped audience.

| Setting | Where it comes from | Default |
|---|---|---|
| `ABUSE_CONTROLS_TABLE` | the shared SSM contract | the foundations table |
| the per-user hourly request limit | the `rateLimitPerHour` field on the profile serving the conversation's classification (`backend/lib/config/profiles.ts`) | set per profile: 60 on `concierge`, 120 on `analyst`, 240 on `advisor`, 120 on the opt-in `ops-premium` role, 20 on `greeter` and 40 on `liaison`, in the profile set the repository ships |
| `BEDROCK_USER_HOURLY_BUDGET` | `-c bedrockUserHourlyBudget` | 100 model calls per user per hour |
| `BEDROCK_GLOBAL_HOURLY_BUDGET` | `-c bedrockGlobalHourlyBudget` | 500 model calls per hour, account-wide |
| `ABUSE_CIRCUIT_PARAM`, `ABUSE_CIRCUIT_TRIP_THRESHOLD` | wired whenever a global budget is set; the threshold is `-c bedrockCircuitTripThreshold` | the shared per-instance circuit parameter, tripping at the global budget |
| `BUDGET_CANNED_RESPONSE` | `-c budgetCannedResponse` | a neutral high-demand message; an assistant's own `budgetExhausted` copy is said in its place |
| the refusal wording | the answering assistant's message templates: `rate-limited` (`{{minutes}}`) and `budget-exhausted` (`lib/assistant-notice.ts`, ADR-062) | the classification's template, then the deployment's `budgetCannedResponse` for a spend refusal, then shipped English |
| `MAX_USER_MESSAGE_LENGTH` | `-c maxUserMessageLength` | 16000 characters, roughly 4000 tokens; `0` disables the cap |
| the admin exemption | `-c abuseExemptAdmins=true`, optionally `-c abuseExemptAdminGroups=admins,staff` | off, with `admins` as the group list when it is on |

An explicit `0` on either budget switches that limit off, and switching the global budget off also removes the circuit parameter and its grant, because there is nothing left to trip. A control whose environment variable is absent is simply off, so a partial rollout is safe.
