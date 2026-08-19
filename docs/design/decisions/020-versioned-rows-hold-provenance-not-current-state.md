---
title: "ADR-020: A versioned row holds provenance, never current state"
status: Accepted 2026-07-29
date: 2026-07-29
related:
  - "../../overview/TENETS.md"
  - "019-conversation-summary-seeded-on-first-turn.md"
  - "../../../backend/lambda/src/analytics-aurora/summary-updater.ts"
  - "../../../backend/lambda/src/analytics-aurora/kinesis-archival.ts"
tracking: |
  Applied to `conversation_summaries`: `name` and `participant_count` are written NULL, asserted by
  tests in `backend/test/lib/summary-updater.test.ts`. The wider schema audit (other denormalised
  copies of live state, e.g. `conversations` overlapping `channel_registry`) is roadmap, not done.
---

# ADR-020: A versioned row holds provenance, never current state

## Status

Accepted. Surfaced when a well-intentioned "fix" populated two columns that should stay empty.

## Context

`conversation_summaries` is append-only and versioned: each summarisation writes a new row and earlier
versions are never rewritten. It carries `name` and `participant_count` columns that were being
written as a literal `NULL` and `0`.

Read as bugs, these look trivial - the writer simply is not filling them in, so the obvious repair is
to fill them: ask the summariser for a conversation name, query a participant count at write time.
Both repairs are wrong, and the second is wrong in a more instructive way than the first.

**Why the values cannot be correct.** The row is never rewritten, so anything copied into it is frozen
at one summarisation:

- **Membership changes continuously.** A count written during one Bedrock call is wrong from the next
  join or leave onward. There is no version of this code that keeps it accurate; the storage shape
  forbids it.
- **The name is worse than stale, it can DIVERGE.** The Amazon Chime SDK channel is authoritative for
  the conversation's name, it is set on the first turn and the user can rename it afterwards, and
  `channel_registry.channel_name` already mirrors it live from the Kinesis channel events. Having the
  summariser generate its own name creates a SECOND name that can disagree with the one the user sees
  in the UI.

Both values already have a continuously-maintained home, fed by events (`syncChannelRegistryRecords`,
`syncMembershipRecords`). The columns were duplicating live state into an immutable record.

## Decision

**A versioned or append-only row may store PROVENANCE - a fact about what this version covered - and
must not store CURRENT STATE - a fact about what is true now.**

Applied here:

| Column | Verdict | Why |
|---|---|---|
| `name` | **NULL** | Current state. Authoritative in the Amazon Chime SDK; mirrored in `channel_registry.channel_name` |
| `participant_count` | **NULL** | Current state. Authoritative in `channel_membership` |
| `message_count` | **NULL** | Current state. It stored the channel TOTAL, not a fact about this version, and no consumer read it |

> **`message_count` gets no exemption, and the argument for exempting it is worth examining.** The
> case for keeping it is a provenance one - "how much conversation this version covers" - which sounds
> principled and is false twice over. The code stored `COUNT(*)` of the whole channel, so it described the conversation, not
> the summary. And nothing read it: every "messages" figure in the console either counts live or reads
> `conversations.message_count`. The incremental updater uses the `updated_at` watermark, not a count.
> One rule, three columns, no exceptions. Beware the plausible-sounding carve-out: verify that the
> stored value IS what the justification claims, and that something actually reads it.

Consumers needing current state join the live table at read time:

```sql
SELECT COUNT(*) FROM channel_membership WHERE channel_arn = $1
```

A column that cannot hold a correct value should hold no value. `NULL` removes a wrong answer; it does
not remove a useful one.

## Consequences

- Nothing read either column, so there is no migration and no backfill. Existing rows keep their
  historical values; no consumer is entitled to trust them.
- Any future consumer pays a join for participant count. That is the correct cost: it buys an answer
  that is right.
- **Applies beyond this table.** Before adding a column to a versioned store, ask whether the value
  describes THIS VERSION or describes NOW. If it describes now, it belongs in the live table that
  events already maintain, and the versioned row should reference it rather than copy it.
- The wider audit of denormalised copies of live state across the analytics schema is open (roadmap):
  `conversations` overlapping `channel_registry` is the next candidate.

**Guarding against the reverse error.** "The column is empty" is not evidence of a bug. Before filling
one, establish that the value is knowable and stable at write time. A test asserting the ABSENCE of a
write is the durable guard, and is what `summary-updater.test.ts` now does.
