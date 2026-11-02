-- A COMPLIANCE VERDICT HAS TO SAY WHICH RULES PRODUCED IT.
--
-- `evaluation_results.is_compliant` and `compliance_categories` have existed since 001 with three
-- readers and no writer. Nothing ever judged compliance, so every row was NULL and each reader's
-- choice of default decided the number it published - one said 0%, another 100%, a third said there
-- were no violations. All three were artifacts.
--
-- Pass C now writes a verdict. This migration adds the one column that makes a stored verdict mean
-- something a year later: the rule-set version it was judged under.
--
-- ── WHY THE VERSION IS NOT OPTIONAL ───────────────────────────────────────────────────────────────
--
-- Rules move. A rule is added, a statement is sharpened, a deployment adds its own. A compliance rate
-- compared across a rule change is comparing two different questions, and without the version nothing
-- in the data says a change happened. With it, a reader can partition by rule set and know which
-- figures are comparable - the same reason `exchanges.paired_by` records HOW a pairing was made
-- rather than only that one exists.
--
-- ── WHAT THE OTHER TWO COLUMNS NOW MEAN ───────────────────────────────────────────────────────────
--
--   is_compliant           TRUE  = assessed, no rule breached.
--                          FALSE = assessed, at least one rule breached.
--                          NULL  = NOT ASSESSED. Never a default, never coalesced by any reader.
--   compliance_categories  The rule ids breached, as a JSONB array of strings. Empty array on a
--                          compliant verdict; a `false` verdict always cites at least one id.
--
-- NO BACKFILL. Every existing row is NULL and stays NULL: nothing judged those exchanges, and writing
-- a verdict now would be inventing one. They are counted as unassessed, visibly, which is what the
-- readers were changed to do.
--
-- Idempotent and additive.

ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS rule_set_version VARCHAR(32);

-- The questions this column answers are "which verdicts are comparable" and "how much of the window
-- was assessed", both of which scan the assessed rows. Partial: most rows carry no verdict.
CREATE INDEX IF NOT EXISTS idx_evaluation_results_rule_set
    ON evaluation_results(rule_set_version)
    WHERE rule_set_version IS NOT NULL;

COMMENT ON COLUMN evaluation_results.rule_set_version IS
    'The compliance rule-set version this verdict was judged under (config/compliance-rules.ts). '
    'NULL for a row with no compliance verdict. Rules change, so a compliance rate compared across '
    'versions compares two different questions; partition by this column before trending.';

COMMENT ON COLUMN evaluation_results.is_compliant IS
    'TRUE = assessed and no rule breached. FALSE = assessed and at least one rule breached, with the '
    'rule ids in compliance_categories. NULL = NOT ASSESSED - never a default and never coalesced. '
    'Readers must exclude NULL from both halves of a rate and publish the assessed count beside it.';

COMMENT ON COLUMN evaluation_results.compliance_categories IS
    'JSONB array of the compliance rule ids this exchange breached (config/compliance-rules.ts). '
    'Empty array when the verdict is compliant. A FALSE verdict always cites at least one id, so a '
    'finding is traceable to a written rule rather than to free text.';
