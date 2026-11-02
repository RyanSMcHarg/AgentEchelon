# Assistants - directory index

**Site section:** Interaction layer, assistants.

This is an index, not a spec. It says what belongs in this folder and points at the document that owns each question.

## What belongs here

Everything about **what an assistant is and what it knows**: its configuration and versioning, the context it answers from, how it opens a conversation, how work reaches the right one of several, and how it reaches systems the platform does not own. The surfaces a person uses live in [`../../interface`](../../interface), the platform-wide contracts in [`../governance`](../governance), and the sample deployment in [`../../demos`](../../../specs/demos).

A `SPEC-` document states requirements and what is delivered against them. A `DESIGN-` document states how something is built, for a decision a spec has already made.

## Documents

**What an assistant is, and how it is configured**

- [SPEC-ASSISTANT-CONFIG.md](./SPEC-ASSISTANT-CONFIG.md) - the per-experience configuration bundle: models, tools, workflow selection and guardrail selection, carried on the versioned profile definition.
- [SPEC-CAPABILITY-PROFILES.md](./SPEC-CAPABILITY-PROFILES.md) - classifications and assistant profiles as deployment configuration, and the one module that interprets a classification value.
- [SPEC-CONFIGURABLE-ASSISTANTS.md](./SPEC-CONFIGURABLE-ASSISTANTS.md) - the three per-assistant configuration axes on one governed boundary.
- [SPEC-PORTABLE-PROFILES.md](./SPEC-PORTABLE-PROFILES.md) - an assistant as a portable, versioned artifact: create, edit, activate, roll back, export and import.
- [SPEC-PER-PROFILE-OWNERSHIP.md](./SPEC-PER-PROFILE-OWNERSHIP.md) - the per-classification stack that owns the runtime and grants of every assistant its classification declares.
- [SPEC-CONFIGURABLE-INTENT-PACK.md](./SPEC-CONFIGURABLE-INTENT-PACK.md) - the per-deployment intent taxonomy an assistant classifies against.
- [SPEC-CAPABILITY-REFUSAL.md](./SPEC-CAPABILITY-REFUSAL.md) and [DESIGN-CAPABILITY-REFUSAL.md](./DESIGN-CAPABILITY-REFUSAL.md) - recognizing and refusing a request for an output the classification does not produce, and telling the person where to get it.

**What an assistant knows**

- [SPEC-CONTEXT-SOURCES-AND-STORES.md](./SPEC-CONTEXT-SOURCES-AND-STORES.md) - every grounding path, the store behind it, and the guard that restricts it.
- [SPEC-WELCOME-AND-CONTEXT.md](./SPEC-WELCOME-AND-CONTEXT.md) - how a conversation opens, and the whole set of context sources assembled per turn.
- [SPEC-CONNECTORS.md](../../communication/SPEC-CONNECTORS.md) - the connector contract: one governed integration per vendor, declared as configuration, reading each source of truth live.
- [SPEC-CONTEXT-AWARE-MODEL-ROUTING.md](./SPEC-CONTEXT-AWARE-MODEL-ROUTING.md) - which model answers a turn, and the provider-adapter seam behind that choice.
- [SPEC-BILINGUAL-CONVERSATIONS.md](./SPEC-BILINGUAL-CONVERSATIONS.md) - reply language, the inference pivot and dual delivery.

**How a turn is handled, and by which assistant**

- [SPEC-TURN-QUEUE.md](../conversation/SPEC-TURN-QUEUE.md) - several requests arriving at one assistant in one conversation, and how the queue drains.
- [SPEC-DRIFT-CONVERGENCE.md](./SPEC-DRIFT-CONVERGENCE.md) - detecting that a conversation has moved on, and the offer to continue it elsewhere.
- [DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md](./DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md) - several separately owned assistants in one conversation, and how work reaches the right one.
- [DESIGN-MULTI-ASSISTANT-TURN-ENGINE.md](./DESIGN-MULTI-ASSISTANT-TURN-ENGINE.md) - the turn engine that serves more than one assistant.
- [DESIGN-MULTI-AGENT-ORCHESTRATION.md](./DESIGN-MULTI-AGENT-ORCHESTRATION.md) - an alignment document for sub-agent orchestration, with its open decisions named.
- [DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING.md](../conversation/DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING.md) - the task-access seam and where the queue's work happens.
- [DESIGN-ADDING-AN-ASSISTANT-ROLE.md](./DESIGN-ADDING-AN-ASSISTANT-ROLE.md) - the worked case: adding a second assistant role end to end.
- [DESIGN-MULTI-AGENT-STRANDS-RUNTIME.md](./DESIGN-MULTI-AGENT-STRANDS-RUNTIME.md) - a proposed runtime for sub-agent fan-out on Strands, **NOT BUILT**.

**Meetings and sub-agents**

- [SPEC-ASSISTANT-MEETINGS.md](./SPEC-ASSISTANT-MEETINGS.md) and [DESIGN-ASSISTANT-MEETINGS.md](./DESIGN-ASSISTANT-MEETINGS.md) - the meetings assistant: a draft design, with the invitation chase built.
- [DESIGN-MEETING-ONBOARDING-AND-INCIDENT-SUBAGENTS.md](./DESIGN-MEETING-ONBOARDING-AND-INCIDENT-SUBAGENTS.md) - sub-agents for onboarding and live incident work; the incident first look and the alarm event are built.

## Where requirements and delivery status live

**Requirements are in the documents, one table each.** A `SPEC-` document's `## Functional Requirements and Acceptance Criteria` table is the authority for what that capability promises. Its `Delivered` column is the authority for what ships, and it is the only place a delivery claim belongs, so prose and diagrams elsewhere do not carry one.

**Status and end-to-end coverage are collected in one generated view.** [`../../../reference/e2e-coverage-matrix.md`](../../../reference/e2e-coverage-matrix.md) lists every spec document with its declared status and the end-to-end specs that prove it. It is generated from the `# ` title, `**Status:**` and `**Coverage:**` lines of each document, so it is never edited by hand and never disagrees with them.

**The vertical map is [`../../../overview/SITE-MAP.md`](../../../overview/SITE-MAP.md)**, and the people these documents serve are defined once in [`../../../overview/PERSONAS.md`](../../../overview/PERSONAS.md).
