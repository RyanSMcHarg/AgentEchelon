-- 025: one task fact per (message, kind), whichever archived event carried it.
--
-- The task kinds (task_opened / task_transition / task_terminal) are projected from the analytics
-- blob the archive merges onto EVERY event of a bot message - the CREATE and its -UPD sibling both
-- carry the same task data, so each wrote its own copy of every task row, and the 024 natural key
-- (source_message_id, source_event_type, occurred_at, kind) admitted both: v_task_resolution
-- double-counted transitions and dated opened_at/terminal_at at the earlier of two instants.
--
-- A task fact is ONE fact per message: the open, the move, the ending. This index makes the database
-- the dedup point, because no per-record writer can know whether a sibling event already wrote the
-- fact (Kinesis order and batching are not its to reason about). The live writer inserts with a bare
-- ON CONFLICT DO NOTHING, which arbitrates against ANY unique index including this partial one; the
-- backfill already did. First-arrival wins, which dates the fact at the CREATE instant - for
-- resolve_ms, measured in minutes to days, a bounded few-seconds skew is immaterial.
--
-- Existing duplicates are collapsed first (keep the earliest arrival), or the index cannot build.

DELETE FROM turn_events a
 USING turn_events b
WHERE a.kind IN ('task_opened', 'task_transition', 'task_terminal')
  AND b.kind = a.kind
  AND b.source_message_id = a.source_message_id
  AND b.ctid < a.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_turn_events_task_fact
  ON turn_events (source_message_id, kind)
  WHERE kind IN ('task_opened', 'task_transition', 'task_terminal');
