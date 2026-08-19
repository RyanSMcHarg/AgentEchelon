-- 018-classifier-replay.sql
--
-- Storage for the classification shadow gate (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §5).
--
-- A `classification` experiment changes which model LABELS a message. Scoring it on the evaluator's
-- judgement of the ANSWER measures a downstream proxy of that change while real users are routed by
-- the candidate. The gate replaces the proxy: both candidates label the SAME archived messages, the
-- pairs where they disagree are adjudicated by a human, and McNemar's test runs on those.
--
-- Nothing here can live in `ground_truth_scores`. That table records a human SCORE for an answer, and
-- its `classification` column holds the assistant classification, not an intent label. The gate needs
-- two PREDICTED intent labels per message and one adjudicated true label, which is a different grain
-- and a different question.

-- ============================================================================
-- One replay run: two named models over one window of archived traffic.
-- ============================================================================
CREATE TABLE IF NOT EXISTS classifier_replay_runs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- The experiment this gate informs. Nullable: a replay is useful on its own ("would this model
    -- label better?") before anyone commits to running a split.
    experiment_id       VARCHAR(128),
    incumbent_model     VARCHAR(128) NOT NULL,
    challenger_model    VARCHAR(128) NOT NULL,

    -- THE WINDOW IS PART OF THE RESULT (§5.2). A corpus that predates a prompt change, an intent-pack
    -- change or a seasonal shift is not evidence about today's traffic. Stored so the console can
    -- state what was replayed rather than implying currency.
    window_start        TIMESTAMPTZ NOT NULL,
    window_end          TIMESTAMPTZ NOT NULL,

    messages_considered INTEGER NOT NULL DEFAULT 0,
    messages_replayed   INTEGER NOT NULL DEFAULT 0,
    -- Messages skipped because a redaction or deletion retracted them. Counted, never replayed:
    -- a retracted message must not be reprocessed, and a silent skip would overstate the corpus.
    messages_retracted  INTEGER NOT NULL DEFAULT 0,
    -- Messages the classifier answers without asking a model at all (greetings, acknowledgements,
    -- anything under three characters). Excluded from the replay because no model is consulted: both
    -- candidates would "agree" on every one, padding the corpus with pairs that cannot distinguish
    -- them while shrinking the accuracy difference between them. Counted so the exclusion is visible.
    messages_fast_path  INTEGER NOT NULL DEFAULT 0,

    status              VARCHAR(16) NOT NULL DEFAULT 'running',  -- running | complete | failed
    error               TEXT,
    started_by          VARCHAR(256),
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ DEFAULT NOW() + INTERVAL '90 days'
);

CREATE INDEX IF NOT EXISTS idx_replay_runs_experiment ON classifier_replay_runs(experiment_id);
CREATE INDEX IF NOT EXISTS idx_replay_runs_started ON classifier_replay_runs(started_at DESC);

-- ============================================================================
-- One replayed message: both predictions, and the human's verdict when one is needed.
-- ============================================================================
CREATE TABLE IF NOT EXISTS classifier_replay_labels (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id            UUID NOT NULL REFERENCES classifier_replay_runs(id) ON DELETE CASCADE,
    exchange_id       UUID REFERENCES exchanges(id),
    -- The user message that was classified (its Chime id), kept so a label can be traced to the turn
    -- it describes even if the exchange pairing is later rebuilt.
    message_id        VARCHAR(128),

    incumbent_label   VARCHAR(64) NOT NULL,
    challenger_label  VARCHAR(64) NOT NULL,
    -- Stored rather than derived at read time so the adjudication queue can index on it. The two
    -- labels are immutable once written, so this cannot fall out of step with them.
    concordant        BOOLEAN NOT NULL,

    -- ADJUDICATION. The human is the arbiter of record (INV-4): a model may PROPOSE a label to speed
    -- the queue, and that proposal is stored in its own column so it can be displayed as a proposal
    -- and never silently become the answer.
    proposed_label    VARCHAR(64),
    true_label        VARCHAR(64),
    adjudicated_by    VARCHAR(256),
    adjudicated_at    TIMESTAMPTZ,
    -- 'neither' is a real adjudication outcome: both models can be wrong, and forcing the human to
    -- pick one of the two predictions would manufacture a winner from a pair that has none.
    adjudication_note TEXT,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A replay is idempotent per message: re-running a window updates rather than duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS classifier_replay_labels_run_exchange_uniq
  ON classifier_replay_labels (run_id, exchange_id);

-- The adjudication queue is "discordant and not yet adjudicated", which is the only set worth a
-- human's time: concordant pairs carry no comparative signal whatever the truth (§5.3).
CREATE INDEX IF NOT EXISTS idx_replay_labels_queue
  ON classifier_replay_labels (run_id, concordant, adjudicated_at);

COMMENT ON TABLE classifier_replay_labels IS
  'Paired intent predictions from two classifier candidates over archived messages, plus the human-adjudicated true label for discordant pairs. Feeds McNemar (DESIGN-EXPERIMENTS-BATTLE §5.3).';
