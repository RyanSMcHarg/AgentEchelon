-- A CONVERSATION'S OWN SUBJECTS, NOT THE AVERAGE OF THEM (SPEC-DRIFT-CONVERGENCE FR5).
--
-- FR5 is a Differentiator and has shipped at "Partly" since 044: the only rows in
-- `conversation_topic_embeddings` are the subjects of DECLINED OFFERS, because the summarizer writes
-- no per-topic rows. So step 6b compares a message against whatever the person happened to decline,
-- and against nothing at all in a conversation where nobody declined anything.
--
-- WHY THE AVERAGE IS NOT ENOUGH, which is the whole reason FR5 exists (spec section 258): the summary
-- embedding is an average over everything a conversation covers, so in a genuinely multi-subject
-- conversation every individual subject sits some distance from that average. Distance from the
-- summary therefore rises whenever somebody moves between the conversation's OWN subjects, and the
-- cosine step alone fires each time they switch back and forth. A Q3 revenue report and a Q2 revenue
-- report are two points a long way apart; the conversation that covered both is one point between
-- them, close to neither.
--
-- This migration opens the table to the summarizer. The writer lands with it
-- (`embedding-writer.ts`), and the READ needs no change beyond the status rule below because
-- `loadAdoptedTopicEmbeddings` never filtered on `origin`.

-- ── 1. THE SUMMARIZER IS A SECOND ORIGIN ────────────────────────────────────────────────────────
--
-- 044 admitted `drift_offer` alone and its own comment anticipated this: "The summariser's rows would
-- use their own prefix." The CHECK is what made that a wish rather than a wiring - a summarizer INSERT
-- would have been refused by the constraint, which is why FR5's second half could not be built without
-- a migration. Named `summary_topic` rather than `summary`: the row is one SUBJECT of a summary, not a
-- summary.
ALTER TABLE conversation_topic_embeddings DROP CONSTRAINT IF EXISTS conversation_topic_embeddings_origin_check;
ALTER TABLE conversation_topic_embeddings
    ADD CONSTRAINT conversation_topic_embeddings_origin_check
    CHECK (origin IN ('drift_offer', 'summary_topic'));

-- ── 2. `established` - A SUBJECT WITH NO OFFER BEHIND IT ────────────────────────────────────────
--
-- `status` tracks an OFFER's lifecycle: `offered` means we proposed a split and are waiting;
-- `adopted` means the person declined, so the subject became this conversation's own. A summarizer
-- topic has neither half - it was never offered and never declined, it is simply a subject the
-- conversation covers.
--
-- SO IT DOES NOT REUSE `adopted`, and that is a deliberate refusal of the cheaper diff. Writing
-- summarizer rows as `adopted` would have needed no migration and no read change, and it would have
-- made the word mean two things in the one place the comparison is gated - after which "how many
-- subjects did people decline here" is no longer answerable from the column that appears to answer it.
-- A third value costs one CHECK and keeps both facts.
ALTER TABLE conversation_topic_embeddings DROP CONSTRAINT IF EXISTS conversation_topic_embeddings_status_check;
ALTER TABLE conversation_topic_embeddings
    ADD CONSTRAINT conversation_topic_embeddings_status_check
    CHECK (status IN ('offered', 'adopted', 'established'));

-- ── 3. THE VERSION THE SUBJECTS CAME FROM ───────────────────────────────────────────────────────
--
-- Spec section 311 asks for the summarizer's rows to be "replaced at the same version", and the table
-- had no version at all, so "replace" had no key to be idempotent against. NULLABLE because a
-- `drift_offer` row has no summary version behind it - it is a subject from a single message - and a
-- NOT NULL default would have to invent one.
--
-- It mirrors `summary_embeddings.embedded_from_version`, so the same skip-if-fresher rule applies to
-- both and a re-delivered summary run re-embeds neither.
ALTER TABLE conversation_topic_embeddings
    ADD COLUMN IF NOT EXISTS embedded_from_version INTEGER;

-- The replace-per-version write deletes this channel's summarizer rows and inserts the new set, so it
-- reads by (channel_arn, origin). The existing index is on `channel_arn` alone, which the step-6b read
-- uses; this one keeps the delete from scanning a channel's drift rows to find its summarizer rows.
CREATE INDEX IF NOT EXISTS idx_topic_embeddings_channel_origin
    ON conversation_topic_embeddings (channel_arn, origin);

-- NO BACKFILL, DELIBERATELY. Existing conversations have no per-subject rows and cannot be given any
-- without re-reading and re-embedding every stored summary, which is a model spend proportional to
-- history for a signal that regenerates on the next summary run anyway. Each conversation gains its
-- subjects the next time it is summarized; until then step 6b behaves exactly as it does today, which
-- is the current shipped behaviour and not a regression.
