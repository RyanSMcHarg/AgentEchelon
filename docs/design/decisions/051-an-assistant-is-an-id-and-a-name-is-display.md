---
title: "ADR-051: The analytics axis is named for a category and holds an identity"
status: Accepted 2026-10-12. Step one is built (migration 075 adds `assistant` beside `agent_type`, a trigger keeps them equal, and every writer and reader uses `assistant`); step two, dropping `agent_type`, is OPEN. Proposed 2026-09-21. The column holds the right value under the wrong name; this records the rename and what it costs. A first draft argued the VALUE was also wrong and was withdrawn the same day, for the reason recorded under "A withdrawn argument" below.
date: 2026-09-21
related:
  - "../../specs/interaction/assistants/DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md"
  - "./048-an-assistant-is-not-a-classification.md"
  - "./042-an-assistant-acts-in-exactly-one-classification.md"
  - "./046-classifications-are-a-set-not-a-ladder.md"
  - "../../../backend/lib/config/profiles.ts"
  - "../../../backend/lambda/src/analytics-aurora/schema/055-agent-type-names-the-assistant.sql"
  - "../../../backend/lambda/src/analytics-aurora/schema/056-role-and-version-are-dimensions.sql"
  - "../../../backend/lambda/src/analytics-aurora/kinesis-archival.ts"
  - "../../../frontend/packages/admin/src/components/admin/LatencyTab.tsx"
tracking: |
  The owner, 2026-09-21: "I don't know what agentType means to be honest. An agent has an ID, they have a classification, and they have a role. They do not have a type." That observation is correct and is what this record acts on. The first draft went further and claimed the column's VALUE was wrong too; a review against the tree showed the opposite, and the withdrawal is recorded here rather than deleted, because the mistake is one the codebase has now made twice.
---

# ADR-051: The analytics axis is named for a category and holds an identity

## Status

**Accepted (2026-10-12). Step one is built; step two is OPEN.** Proposed 2026-09-21.

- **Step one, built.** Migration 075 adds `assistant` to `conversations`, `messages`, `exchanges`, `evaluation_results`, `intent_flows` and `agent_scores`, at the same width as `agent_type`; a trigger (`ae_assistant_column_sync`) keeps the two equal whichever one a writer sets; and the backfill runs in bounded, resumable batches. The archival writer, the evaluation runner and the backfills write `assistant`; every analytics query reads it and returns it as the row field `assistant`, in Aurora and Athena mode; the console reads that field. The value is unchanged: `AssistantProfile.name`.
- **Step two, OPEN.** A later migration drops `agent_type` and the trigger, and replaces the views that still output `agent_type` (`v_turn_latency`, `v_queued_exchange`), once no deployed code names the column. The query API's request parameter `agentType` keeps its name until then, because team scoping injects the team's assistant through it and renaming it is a change to that boundary rather than to a column.

Verified by: the analytics-query, archival and evaluation suites, which assert the `assistant` column in the SQL they run, and the console suites, which render the `assistant` row field.

## The problem

`agent_type` is the column every per-assistant filter, grouping and rollup in the console reads. It holds the assistant's stable identifier. Its name promises a category.

That is the whole defect, and it is a naming defect rather than a data one.

## Why the name is wrong now and was right before

The column originally held the classification. `premium`, `standard` and `basic` are types, so the name described the value exactly.

Migration 055 changed the value to the assistant's own identifier, for a good reason: a classification will hold more than one assistant, and averaging two assistants under one label defeats the separate-ownership case the design rests on. Its header records the conclusion it drew:

> `THE COLUMN WAS ALWAYS RIGHT; THE VALUE WAS THE GAP.`

Half of that is true. The value was the gap and 055 closed it. But the column was right only while it held a type, and the migration kept a name that now promises a category over an identity.

**The cost of that is not hypothetical.** A reader cannot tell from the schema whether to write an identifier or a label, because "type" is neither. Working on this axis the same day, that ambiguity produced a whole open work item about whether to store an id or a name, and then an ADR draft that answered it wrongly, before the column's own name was recognized as the thing generating the question.

## A withdrawn argument, recorded because the codebase has now made this mistake twice

The first draft of this record argued that the value is also wrong: that `agent_type` holds a renameable profile name being used as an identifier, and that a rename therefore orphans every historical row.

**That is backwards.** `AssistantProfile.name` is the stable identifier by design:

> THE STABLE IDENTIFIER, and the only thing that keys storage: the SSM segment `/agent-echelon/assistant/{name}/…`, the assignment record's `assistant`, and the dimension analytics groups by. It is never shown to a person and it never changes - renaming it is creating a different assistant, because every key and every historical row is addressed by it.
>
> NOT WHAT ANYONE READS. That is `displayName` below.

`displayName` is the renameable label, and a rename is applied to the `AppInstanceBot` identity rather than to the key.

[`DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md`](../../specs/interaction/assistants/DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md) settled this on 2026-09-19, and records that an earlier draft of ITS OWN section made the same error: "An earlier version of this section said an assistant's name is an identifier and not a label. That is half right and the wrong half was load-bearing."

So the identifier/label split is decided, shipped and correct. The draft that re-opened it was re-deriving a mistake that had already been found and fixed, and every consequence it drew - storing the bot's principal id, a display resolve on every surface, the claim that the id is derivable where the name is not - falls with it. None of that is proposed here.

**What this leaves is the owner's original observation, unchanged and still true:** an assistant has an id, a classification and a role, and "type" names none of them.

## Decision

**Rename the column to say what it holds. Do not change what it holds.**

1. `agent_type` becomes a name that means "which assistant" - `assistant`, matching the assignment record's own field name (`assistant-profile-stack.ts` writes `assistant: <profile name>`).
2. The value stays `AssistantProfile.name`, which is already the stable identifier.
3. `assistant_role` and `profile_version` stay as migration 056 made them.
4. The room's classification stays `conversation_classification`, which is what migration 050 named it and what it is.

## What this deliberately does not claim

**That the assistant's classification is a column.** It is not. `conversation_classification` is the ROOM's, which 055 and the archival typedef both say explicitly. The assistant's classification is derived from compiled-in config through `profiles.classificationFor()`. The first draft asserted "three facts, three columns" and was wrong about the third.

**That anything is derivable from the sender ARN.** Nothing here proposes deriving the axis. `profiles.classificationFor(agent_type)` is not a display reader either - it is the ADR-042 boundary control that reports an assistant acting outside its classification, and it depends on the value being a profile name. Changing the vocabulary would make it return `undefined` on every row, which is the "control that fires on every row is not a strict control, it is a silent one" failure `kinesis-archival.ts` already warns about.

**That the existing guard is wrong.** `a-message-says-which-assistant-sent-it.test.ts` pins `agent_type` as declared and never derived from the ARN. That rule stands; this record does not touch it.

## Costs

**Six tables carry the column** (`schema/001-initial.sql`), plus views. A rename is a mechanical migration with a compatibility window, not a data change.

**Every reader changes name.** `LatencyTab` offers it as the Assistant filter; the effectiveness and battle surfaces group by it; `analytics-query.ts` selects it in several queries. All mechanical.

**Historical rows still hold classification values** where the assistant was never recorded. 055 left them deliberately, for the reason it gives: guessing which assistant served them requires assuming one per classification, which is the assumption being removed. The rename does not change that and should not pretend to.

## What this does not decide

- **Whether to backfill the rows that still hold a classification.** 055 decided not to; nothing here reopens it.
- **Whether `agent_type` should ever be non-null for a bot message.** That is a separate question about declaration reliability, and it is not answered by a rename.
- **The compatibility window.** Whether both names exist for a release or the migration is atomic is an operational call.
