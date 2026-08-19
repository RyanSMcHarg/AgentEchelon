/**
 * Stratum DEMO intent packs, per classification.
 *
 * Extracted from seed-demo.ts so their SIZE can be measured without running a seed. The seeder
 * invokes main() at import, so nothing could import these to check them, and the only way to learn
 * that a pack had outgrown its parameter was to run a deploy and watch the seed die part way through -
 * after basic and standard were already written, so the retry reported those as "already set" and died
 * on the same one. `test/demo-seed-budget.test.ts` measures them here instead, before any deploy.
 *
 * Same split as demo/personas.ts: demo CONTENT lives under demo/, the seeder stays the mechanism.
 */
/**
 * Stratum DOMAIN intent pack (per tier). Beyond the universal greeting/acknowledgment/general and the
 * platform DEFAULT task intents (guided_troubleshooting / data_extraction / image_generation /
 * report_generation, reused verbatim so they never drift from the platform), the demo adds Stratum's
 * everyday questions as their OWN intents so the admin console segments them into meaningful buckets
 * instead of one fat `general` bar.
 *
 * KEY DESIGN POINT (ADR-018): intent and DELIVERY are separate axes. These inline intents carry
 * `delivery: 'PLACEHOLDER_UPDATE'` (one grounded reply, answered in the turn) — NOT `TASK_MULTI_STEP`.
 * So a single-fact revenue/account/product question is bucketed AND answered inline (no deferral behind
 * a task), which is exactly what ADR-018 wanted; collapsing it to `general` (and losing the signal) was
 * never required — the per-intent delivery field is the real lever. Genuinely multi-step work stays on
 * the DEFAULT task intents (report_generation / data_extraction, both TASK_MULTI_STEP), which the
 * per-tier packs keep so existing task flows + e2e + taskType routing are unchanged.
 *
 * Scoped per tier to match each tier's data access (basic sees product info; standard the directory /
 * processes; premium financials / accounts / competitive intel), so a tier's classifier only offers the
 * intents that tier can actually satisfy.
 */
export type InlineIntent = { key: string; description: string; keywords: string[]; delivery: 'PLACEHOLDER_UPDATE' };
export const STRATUM_INLINE_INTENTS: Record<'basic' | 'standard' | 'premium', InlineIntent[]> = {
  basic: [
    {
      key: 'product_info',
      description:
        'User asks about Stratum products, plans, pricing, features, integrations, or the public FAQ — '
        + 'answerable inline from the company overview (e.g. "what is in the StratumFlow Professional plan?", '
        + '"which integrations are supported?"). A single-turn answer, not a compiled report.',
      keywords: ['pricing', 'how much', 'feature', 'integration', 'stratumflow'],
      delivery: 'PLACEHOLDER_UPDATE',
    },
  ],
  standard: [
    {
      key: 'directory_lookup',
      description:
        'User asks who someone is, who leads or owns a team, a person\'s role or manager, or how to reach a '
        + 'team — answerable inline from the employee directory (e.g. "who leads Platform Core?"). Exporting the '
        + 'whole roster as a table is data_extraction, not this.',
      keywords: ['who leads', 'who owns', 'reports to', 'contact for', 'directory'],
      delivery: 'PLACEHOLDER_UPDATE',
    },
    {
      key: 'process_lookup',
      description:
        'User asks about an internal process, runbook, escalation path, response-time SLA, or operating '
        + 'procedure — answerable inline from internal processes (e.g. "what is the escalation path for a Sev-1?").',
      keywords: ['runbook', 'escalation', 'sla', 'on-call', 'policy'],
      delivery: 'PLACEHOLDER_UPDATE',
    },
  ],
  premium: [
    {
      key: 'financial_metric',
      description:
        'User asks for a SINGLE financial figure or SaaS metric, stated inline — ARR, NRR / net revenue '
        + 'retention, churn rate, revenue by plan, gross margin, a specific quarter\'s number (e.g. "what was our '
        + 'Q2 ARR?", "current net revenue retention?"). Answer the figure directly in one turn. Compiling these '
        + 'into a written report is report_generation; exporting many rows is data_extraction.',
      keywords: ['arr', 'nrr', 'churn', 'gross margin', 'runway'],
      delivery: 'PLACEHOLDER_UPDATE',
    },
    {
      key: 'account_status',
      description:
        'User asks about ONE customer account\'s health, renewal, ARR, or churn risk, stated inline (e.g. "is '
        + 'Acme at risk?", "when does Globex renew?"). Exporting all at-risk accounts as a table is data_extraction.',
      keywords: ['at risk', 'churn risk', 'renewal', 'account health', 'upsell'],
      delivery: 'PLACEHOLDER_UPDATE',
    },
    {
      key: 'competitive_intel',
      description:
        'User asks how Stratum compares to a competitor, competitor positioning / pricing, or win/loss reasons — '
        + 'answerable inline from competitive intelligence (e.g. "how do we compare to Competitor X?", "why do we '
        + 'lose deals to Y?").',
      keywords: ['competitor', 'win rate', 'win/loss', 'positioning', 'differentiat'],
      delivery: 'PLACEHOLDER_UPDATE',
    },
  ],
};

/**
 * A classification's pack: its Stratum intents, INHERITING the platform task intents rather than
 * copying them (`extends: 'default'`, resolved in `intent-pack.ts:getIntentPack`). The resolved
 * taxonomy is identical to the copy this used to emit - own intents first, then the platform ones -
 * so classification behaviour is unchanged. Universal greeting/acknowledgment/general are added
 * implicitly by the classifier.
 *
 * The copy cost 3183 characters in each of three 4096-character parameters, before the deployment said
 * anything of its own; premium was 356 over and took the seed down with it, part way through. What is
 * stored now is only what Stratum ADDS, which is also the more honest description of what it is.
 */
export function stratumIntentPack(tier: 'basic' | 'standard' | 'premium'): {
  extends: 'default'; intents: unknown[];
} {
  return { extends: 'default', intents: [...STRATUM_INLINE_INTENTS[tier]] };
}
