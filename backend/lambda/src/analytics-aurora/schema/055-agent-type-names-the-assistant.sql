-- `agent_type` NAMES THE ASSISTANT THAT ANSWERED, NOT THE CLASSIFICATION IT SERVES.
--
-- THE COLUMN WAS ALWAYS RIGHT; THE VALUE WAS THE GAP. `agent_type` is the RESPONDER's handle - the
-- thing every "scope to this assistant" filter, grouping and rollup in the console means - and it was
-- written with the assistant's assigned classification. Those coincided because each classification
-- had exactly one assistant named after it, so the filter separated nothing. Ship a second assistant
-- into one classification with that in place and every metric silently averages two assistants under
-- one label, which defeats the separate-ownership case the design rests on.
--
-- The ROOM's classification did not lose a home: `conversation_classification` (migration 050) is on
-- messages, exchanges and conversations, and this adds it to `intent_flows` so the two halves of the
-- effectiveness query can both be filtered by it.
--
-- WHY THE BACKFILL READS THE JSONB RATHER THAN A MAPPING WRITTEN HERE. Every turn since profile
-- attribution shipped already records `metadata->>'profileName'` - the assistant's own identifier,
-- written by the processor that answered. Mapping from that is deployment-agnostic and needs no list
-- of names in this file: a deployment that renamed its assistants, or that never named them after
-- classifications, backfills correctly without this migration knowing anything about it. A hardcoded
-- basic->concierge table would be this deployment's seed baked into every deployment's history.
--
-- ROWS WITH NO ATTRIBUTION KEEP WHAT THEY HAVE, and that is deliberate rather than lazy. They were
-- written before the assistant was recorded, so the honest options are "leave the classification,
-- which is what was true when it was written" or NULL. Guessing which assistant served them requires
-- assuming one per classification, which is the assumption this whole change exists to stop relying
-- on. `profile-backfill.ts` can populate the JSONB for older rows first; re-running this migration is
-- safe and will pick up anything it filled in.
--
-- IDEMPOTENT AND TRANSACTION-SAFE: every statement is guarded, and the updates only touch rows whose
-- agent_type still differs from the recorded assistant.

ALTER TABLE intent_flows ADD COLUMN IF NOT EXISTS conversation_classification VARCHAR(32);

COMMENT ON COLUMN messages.agent_type IS
  'The ASSISTANT that answered, by its stable identifier (the /assistant/{name} segment). NOT the '
  'classification it serves - that is conversation_classification. See migration 055.';
COMMENT ON COLUMN exchanges.agent_type IS
  'The ASSISTANT that answered, by its stable identifier. NOT the classification - see migration 055.';
COMMENT ON COLUMN intent_flows.conversation_classification IS
  'The ROOM''s classification for this flow, carried so a flow can be filtered by classification '
  'without inferring it from the assistant that answered.';

-- ── BACKFILL: the assistant is already recorded per message, as JSONB ────────────────────────────
--
-- THE SEAT FIRST, THE DEFINITION ONLY AS A FALLBACK, and the difference is a live defect this
-- statement used to cause.
--
-- `agentType` is what the answering processor stamps from `servingAssistant` - the SEAT that
-- answered, which is exactly what `agent_type` groups by. `profileName` is the DEFINITION it served.
-- The processor comment says in terms that the two "are the same string on every ordinary turn and
-- come apart exactly on a cross-assistant variant".
--
-- This read `profileName` alone, with `OR m.agent_type <> m.metadata->>'profileName'`. On a duel row
-- the live write had already put the correct seat in the column, the two strings differed for the one
-- reason they are allowed to differ, and the condition therefore matched and OVERWROTE a correct value
-- with the rival definition's name. This migration is re-runnable by design, so it did so on every
-- cold start, and the rows it damages are the battle rows the separate-assistant work exists to make
-- comparable.
--
-- `058` repairs the rows this left wrong; the fix is here so they are not re-damaged.
UPDATE messages m
   SET agent_type = COALESCE(m.metadata->>'agentType', m.metadata->>'profileName')
 WHERE COALESCE(m.metadata->>'agentType', m.metadata->>'profileName') IS NOT NULL
   AND (m.agent_type IS NULL
        OR m.agent_type <> COALESCE(m.metadata->>'agentType', m.metadata->>'profileName'));

-- Exchanges and conversations derive from the messages that make them up. `sender_arn` is the bot
-- that answered, so the bot message is the one carrying the assistant.
UPDATE exchanges ex
   SET agent_type = src.assistant
  FROM (
        SELECT e.id, MAX(COALESCE(m.metadata->>'agentType', m.metadata->>'profileName')) AS assistant
          FROM exchanges e
          JOIN messages m ON m.channel_arn = e.channel_arn AND m.is_bot = TRUE
         WHERE COALESCE(m.metadata->>'agentType', m.metadata->>'profileName') IS NOT NULL
           AND m.created_at BETWEEN e.created_at - INTERVAL '1 minute' AND e.created_at + INTERVAL '10 minutes'
         GROUP BY e.id
       ) src
 WHERE ex.id = src.id
   AND src.assistant IS NOT NULL
   AND (ex.agent_type IS NULL OR ex.agent_type <> src.assistant);

-- Flows carry the classification from their exchanges, which is where it is already recorded.
UPDATE intent_flows f
   SET conversation_classification = src.classification
  FROM (
        SELECT e.task_id, MAX(e.conversation_classification) AS classification
          FROM exchanges e
         WHERE e.task_id IS NOT NULL AND e.conversation_classification IS NOT NULL
         GROUP BY e.task_id
       ) src
 WHERE f.task_id = src.task_id
   AND f.conversation_classification IS DISTINCT FROM src.classification;

CREATE INDEX IF NOT EXISTS idx_intent_flows_conversation_classification
    ON intent_flows(conversation_classification, first_exchange_at DESC);
