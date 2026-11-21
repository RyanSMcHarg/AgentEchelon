---
title: "ADR-068: The deployment's own app is a connector over its own bus, and a fact's person or conversation is trusted by the receiver's record"
status: "Accepted 2026-11-19. Built and proven by unit tests; its dev run is owed. Status lives in SPEC-WORKFLOWS-AND-TASKS (WT84)."
date: 2026-11-19
related:
  - "./067-a-workflow-is-triggered-by-an-event-or-an-intent-and-its-steps-create-tasks.md"
  - "../../specs/interaction/conversation/DESIGN-EVENT-TARGETS.md"
  - "../../specs/interaction/conversation/SPEC-WORKFLOWS-AND-TASKS.md"
  - "../../specs/communication/SPEC-CONNECTORS.md"
  - "../../overview/TENETS.md"
  - "../../../backend/lib/stacks/connectors-stack.ts"
  - "../../../backend/lib/config/connectors.ts"
  - "../../../backend/lambda/src/lib/connectors/vendors.ts"
  - "../../../backend/lambda/src/connector-ingest.ts"
  - "../../../backend/lambda/src/lib/connector-fact-record.ts"
  - "../../../backend/lambda/src/router-agent-handler.ts"
---

# ADR-068: The deployment's own app is a connector over its own bus, and a fact's person or conversation is trusted by the receiver's record

## Status

Accepted 2026-11-19. Built and proven by unit tests (`an-own-app-event-from-another-principal-is-refused`); its dev run is owed. Status for the requirement lives in [SPEC-WORKFLOWS-AND-TASKS](../../specs/interaction/conversation/SPEC-WORKFLOWS-AND-TASKS.md) (WT84).

## Context

Any principal in an account can put an event on its default EventBridge bus with any source but `aws.*`. A platform function's `events:PutEvents` grant conditioned on its own source restricts that function only, so a look-alike `ae.connector` fact from another principal reaches every rule that matches it. Two things a workflow wants from an event cannot be taken from such a fact: the person it concerns, to open or post into that person's conversation, and the conversation it concerns, which chooses where a run happens. The deployment's own application also needs a way to put events that no other principal can forge (WT84).

## Decision

**The app is a connector, over a bus of its own.** The `app` vendor (`VENDORS` in `lib/config/connectors.ts`) declares a source `ae.app.<name>` and an `appPrincipal`, the IAM role or user the application runs as. Its bus (`appEventBus` in `connectors-stack.ts`) carries three resource-policy statements: allow `events:PutEvents` from `appPrincipal` for that source; deny every other principal (`ArnNotEquals aws:PrincipalArn`); deny every other source. The denies outweigh any principal's own IAM allow, so an event on that bus is the application's. Its events reach the connector receiver through a rule on that bus, as a vendor's do through its partner bus, and the app adapter reads its declared schema: people by the app's own immutable user id, and an optional conversation as a channel id.

**The receiver's record is what a consumer trusts.** The receiver already claims each event in its replay table, which only it writes. On publishing a fact it now records there whom it admitted, the classification, and the conversation an app event named. A consumer takes a person or a conversation from a connector fact only where that record agrees (`connectorRecordConfirms`): the event was published, at the consumer's classification, admitting exactly that one person, or naming exactly that conversation. The router reads that record by the table named in an SSM parameter the connectors stack writes, and nothing else of the receiver's.

**What that enables** (DESIGN-EVENT-TARGETS 11.2 and 11.3): a pattern may name `{person}`, and a trigger may run in the conversation a fact names. Both are attached only on an `ae.connector` trigger, and the router checks the record before anything is created or run; a named conversation must also be of the rule's type at the router's classification, read from its own tags.

## Consequences

- No new trust path: the app's events take the vendor path's replay, resolution and admission, and a person the app names is admitted against the connector's classification as any vendor's is.
- A fact's person or conversation costs one consistent `GetItem` on the receiver's record per event.
- A replay record expires after the replay window, so a trigger's run verifies its fact as the event arrives, never later.
- Tenet D3: a named conversation passes two checks, the receiver's record and the conversation's own tags; a `{person}` passes the record and the receiver's admission at the connector's classification.

## Verified by

`backend/test/an-own-app-event-from-another-principal-is-refused.test.ts`: the synthesized bus policy (the allow and both denies), the app adapter's schema, the record check's every refusal, and the router's refusals for a person or a named conversation from another source or without the record's agreement.
