-- A JUDGED VERDICT IS AN OPINION UNTIL SOMETHING MEASURES IT.
--
-- Pass C's deterministic half is an observation: a guardrail fired, the rule mapped to it is breached,
-- and nothing needs to agree with that. The JUDGED half is a model's opinion about a rule statement,
-- and an opinion nobody has checked is not evidence - it is a number with a citation.
--
-- Every serious evaluation harness measures its judge against human labels rather than assuming the
-- judge is right. `ground_truth_scores` already exists for exactly that purpose on the RELEVANCE side
-- (`human_score`, `classification`). It carries no compliance label, so compliance agreement cannot be
-- computed at all. This adds one.
--
-- ── WHY A SEPARATE COLUMN AND NOT `classification` ────────────────────────────────────────────────
--
-- `ground_truth_scores.classification` is the relevance label - excellent, good, partial, poor,
-- irrelevant, appropriate_refusal. Compliance asks a different question with a different answer set,
-- and overloading one column with two vocabularies is how a field stops meaning anything. The same
-- reason Pass C did not overload `evaluation_results.classification`.
--
-- ── THE THREE STATES AGAIN, DELIBERATELY ──────────────────────────────────────────────────────────
--
-- `human_is_compliant` is TRUE, FALSE, or NULL - and NULL means the human did not label compliance,
-- not that they found it compliant. A person may score relevance and skip compliance entirely; an
-- agreement rate must exclude those rows rather than count them as agreement, which is the same
-- coalescing mistake the verdict itself exists to avoid.
--
-- `human_compliance_categories` records WHICH rules the person found breached, so disagreement can be
-- read per rule. "The judge and the human disagree 12% of the time" is a number; "they disagree about
-- `scope.stayed-in-remit` and agree about everything else" is actionable.
--
-- Idempotent and additive. No backfill: no human has labelled compliance, so every row is NULL, which
-- is the truthful state.

ALTER TABLE ground_truth_scores ADD COLUMN IF NOT EXISTS human_is_compliant BOOLEAN;
ALTER TABLE ground_truth_scores ADD COLUMN IF NOT EXISTS human_compliance_categories JSONB;

-- Agreement is computed over rows that carry a human compliance label, which is the minority.
CREATE INDEX IF NOT EXISTS idx_ground_truth_compliance
    ON ground_truth_scores(exchange_id)
    WHERE human_is_compliant IS NOT NULL;

COMMENT ON COLUMN ground_truth_scores.human_is_compliant IS
    'A person''s compliance verdict for this exchange, for measuring judge agreement. TRUE = they '
    'found it compliant, FALSE = they found a breach, NULL = they did not label compliance at all '
    '(NOT a pass). Agreement rates must exclude NULL rather than count it as agreement.';

COMMENT ON COLUMN ground_truth_scores.human_compliance_categories IS
    'JSONB array of the compliance rule ids the person found breached, so disagreement with the judge '
    'can be read per rule rather than as one aggregate percentage.';
