/**
 * Judge agreement for compliance - Pass C, Step 3 (DESIGN-EVALUATION, Pass C).
 *
 * The deterministic half of a compliance verdict is an observation and needs no corroboration: a
 * guardrail fired, and the rule mapped to it is breached. The JUDGED half is a model's opinion about a
 * rule statement, and **an opinion nobody has checked is not a measurement**. Every serious evaluation
 * harness measures its judge against human labels rather than assuming the judge is right; this is that
 * measurement, and until it has rows the judged half should be described as an opinion with a citation.
 *
 * Read through the existing data-plane seam rather than a new endpoint (tenet D8): the analytics
 * Lambdas already dispatch on an `op`, and this is another question for that dispatcher.
 */
import { query } from './db-client.js';
import { ruleById, type ComplianceSeverity } from '../../../lib/config/compliance-rules.js';

export interface ComplianceAgreement {
  /** Exchanges where BOTH a judge verdict and a human compliance label exist. */
  compared: number;
  /** Both said compliant, or both said breached. */
  agreed: number;
  /** Agreement as a percentage of `compared`, or null when nothing has been labeled. */
  agreementRate: number | null;
  /** The judge said compliant, the person found a breach. The expensive direction. */
  judgeMissedBreach: number;
  /** The judge found a breach, the person did not. */
  judgeOverflagged: number;
  /**
   * Per-rule disagreement, worst first: which rule the judge and the person read differently.
   *
   * `severity` and `scope` are resolved from the rule set so the report says who owns the ambiguity
   * and how much it costs. A `blocking` platform rule the judge and a person keep reading differently
   * is a statement the platform has to rewrite; a `minor` deployment rule is the business's own to
   * tune. Both are NULL for an id the current rule set no longer declares - a verdict stored under an
   * earlier `rule_set_version` - which is a fact worth showing rather than hiding.
   */
  byRule: Array<{
    ruleId: string;
    judgeOnly: number;
    humanOnly: number;
    both: number;
    severity: ComplianceSeverity | null;
    scope: 'platform' | 'deployment' | null;
  }>;
}

/**
 * How often the judge and a person reach the same compliance verdict.
 *
 * ── ONLY LABELLED ROWS COUNT ────────────────────────────────────────────────────────────────────
 *
 * A person may score relevance and never touch compliance, leaving `human_is_compliant` NULL. That is
 * an absent label, not an agreement, and counting it would inflate the rate with rows nobody judged -
 * the same coalescing mistake the verdict itself exists to avoid. Both sides must be non-NULL.
 *
 * ── THE TWO DIRECTIONS ARE NOT EQUALLY EXPENSIVE ────────────────────────────────────────────────
 *
 * They are reported separately because they mean different things. `judgeMissedBreach` is a breach
 * that went unrecorded - the failure that makes a compliance report worthless. `judgeOverflagged` is
 * noise an operator has to triage. A single agreement percentage hides which one is happening.
 */
export async function complianceAgreement(days = 30): Promise<ComplianceAgreement> {
  const overall = await query<{
    compared: string; agreed: string; judge_missed: string; judge_over: string;
  }>(
    `WITH labels AS (
       -- ONE LABEL PER EXCHANGE, THE LATEST. ground_truth_scores has no unique constraint on
       -- exchange_id, by design: two people may score the same exchange, and a re-score appends
       -- rather than replaces. A plain join therefore counts a twice-labelled exchange twice, and
       -- the agreement rate ends up weighted by how much attention each exchange happened to get -
       -- with the most-argued-over exchanges, exactly the ambiguous ones, weighted heaviest.
       --
       -- DISTINCT ON, like every other reader of a re-scorable table here (analytics-query resolves
       -- evaluation_results the same way). The judge side needs no such treatment: migration 028
       -- puts a partial unique index on (exchange_id) WHERE evaluation_type = 'exchange'.
       SELECT DISTINCT ON (exchange_id)
              exchange_id, human_is_compliant, human_compliance_categories
         FROM ground_truth_scores
        WHERE human_is_compliant IS NOT NULL
          AND scored_at >= NOW() - INTERVAL '1 day' * $1
        ORDER BY exchange_id, scored_at DESC
     )
     SELECT COUNT(*)                                                              AS compared,
            COUNT(*) FILTER (WHERE er.is_compliant = g.human_is_compliant)        AS agreed,
            COUNT(*) FILTER (WHERE er.is_compliant IS TRUE
                               AND g.human_is_compliant IS FALSE)                 AS judge_missed,
            COUNT(*) FILTER (WHERE er.is_compliant IS FALSE
                               AND g.human_is_compliant IS TRUE)                  AS judge_over
       FROM evaluation_results er
       JOIN labels g ON g.exchange_id = er.exchange_id
      WHERE er.evaluation_type = 'exchange'
        AND er.is_compliant IS NOT NULL`,
    [days],
  );

  const row = overall.rows[0];
  const compared = Number(row?.compared || 0);
  const agreed = Number(row?.agreed || 0);

  // PER-RULE, because one aggregate percentage cannot tell an operator WHICH rule is being read
  // differently - and a rule the judge and a person consistently disagree about is a rule whose
  // statement is ambiguous, which is a fixable thing rather than a model failing.
  const perRule = await query<{ rule_id: string; judge_only: string; human_only: string; both: string }>(
    `WITH labels AS (
       -- Deduped exactly as the overall query above, and for the same reason: a twice-labelled
       -- exchange would otherwise contribute two rows to every per-rule count.
       SELECT DISTINCT ON (exchange_id)
              exchange_id, human_is_compliant, human_compliance_categories
         FROM ground_truth_scores
        WHERE human_is_compliant IS NOT NULL
          AND scored_at >= NOW() - INTERVAL '1 day' * $1
        ORDER BY exchange_id, scored_at DESC
     ),
     pairs AS (
       SELECT er.compliance_categories AS judge_cats,
              g.human_compliance_categories AS human_cats
         FROM evaluation_results er
         JOIN labels g ON g.exchange_id = er.exchange_id
        WHERE er.evaluation_type = 'exchange'
          AND er.is_compliant IS NOT NULL
     ),
     ids AS (
       SELECT DISTINCT jsonb_array_elements_text(COALESCE(judge_cats, '[]'::jsonb)) AS rule_id FROM pairs
       UNION
       SELECT DISTINCT jsonb_array_elements_text(COALESCE(human_cats, '[]'::jsonb)) AS rule_id FROM pairs
     )
     SELECT i.rule_id,
            COUNT(*) FILTER (WHERE p.judge_cats @> to_jsonb(i.rule_id)
                               AND NOT COALESCE(p.human_cats, '[]'::jsonb) @> to_jsonb(i.rule_id)) AS judge_only,
            COUNT(*) FILTER (WHERE p.human_cats @> to_jsonb(i.rule_id)
                               AND NOT COALESCE(p.judge_cats, '[]'::jsonb) @> to_jsonb(i.rule_id)) AS human_only,
            COUNT(*) FILTER (WHERE p.judge_cats @> to_jsonb(i.rule_id)
                               AND p.human_cats @> to_jsonb(i.rule_id))                            AS both
       FROM ids i CROSS JOIN pairs p
      GROUP BY i.rule_id
      ORDER BY (COUNT(*) FILTER (WHERE p.judge_cats @> to_jsonb(i.rule_id)
                                   AND NOT COALESCE(p.human_cats, '[]'::jsonb) @> to_jsonb(i.rule_id))
              + COUNT(*) FILTER (WHERE p.human_cats @> to_jsonb(i.rule_id)
                                   AND NOT COALESCE(p.judge_cats, '[]'::jsonb) @> to_jsonb(i.rule_id))) DESC`,
    [days],
  );

  return {
    compared,
    agreed,
    // NULL RATHER THAN 100 WHEN NOTHING IS LABELLED. A rate with no denominator has no value, and
    // reporting a confident 100% for an unmeasured judge is precisely the failure this step exists
    // to close.
    agreementRate: compared > 0 ? Math.round((agreed / compared) * 1000) / 10 : null,
    judgeMissedBreach: Number(row?.judge_missed || 0),
    judgeOverflagged: Number(row?.judge_over || 0),
    byRule: perRule.rows.map((r) => {
      // Resolved rather than stored: the counts come from the database, the grading comes from the
      // rule set that is current when the report is read. An id the set no longer declares resolves to
      // nulls, which is how a verdict written under an older rule_set_version announces itself.
      const rule = ruleById(r.rule_id);
      return {
        ruleId: r.rule_id,
        judgeOnly: Number(r.judge_only || 0),
        humanOnly: Number(r.human_only || 0),
        both: Number(r.both || 0),
        severity: rule?.severity ?? null,
        scope: rule?.scope ?? null,
      };
    }),
  };
}
