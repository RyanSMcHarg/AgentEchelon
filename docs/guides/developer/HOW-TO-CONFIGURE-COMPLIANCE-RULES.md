# How to configure compliance rules

**Status: BUILT.** The rule set is `backend/lib/config/compliance-rules.ts`. The verdict is computed by `complianceVerdictFor` and written as `is_compliant` in the same `evaluation_results` insert as the relevance score, inside the evaluation runner's Pass A loop (`backend/lambda/src/analytics-aurora/evaluation-runner.ts`); the judged breaches come back from the same Pass A judge call. No reader coalesces an unjudged row, and no rollup weights one as a zero. One piece is built but **unmeasured**: judge agreement (`complianceAgreement`, a data-plane op, run via `backend/scripts/compliance-judge-agreement.mjs`) returns a NULL rate until a person labels compliance on some exchanges. Without those labels, the judged half is an opinion with a citation rather than a measurement.

**Verified by:** `backend/test/compliance-rules.test.ts` (rule-set validation), `backend/test/analytics-aurora/an-unjudged-row-is-not-a-verdict.test.ts` (no reader coalesces NULL, no rollup weights it as zero).

**Pass letters.** [DESIGN-EVALUATION](../../specs/interaction/quality/DESIGN-EVALUATION.md) names the compliance step Pass C. The runner's own comments use the letter C for drift-offer judging and compute compliance inside Pass A, so key on the pass name rather than the letter.

Specification: [DESIGN-EVALUATION, compliance](../../specs/interaction/quality/DESIGN-EVALUATION.md), with the product position in [SPEC-EVALUATION](../../specs/interaction/quality/SPEC-EVALUATION.md). Runtime enforcement, which this sits beside and takes evidence from: [SPEC-CONVERSATION-SECURITY](../../specs/interaction/governance/SPEC-CONVERSATION-SECURITY.md) Layer 5.

---

## Scope

| | Runs | Answers |
|---|---|---|
| **Guardrails** | in-band, before and after the model | may this turn proceed |
| **Compliance evaluation** | after the fact, over the archive | did the reply stay within the rules |

A guardrail stops a turn. An evaluation tells you what happened across thousands of turns, including the ones no guardrail was written for. You need both.

Compliance is also **not relevance**. Pass A scores whether a reply addressed the request; a reply can address it perfectly and still breach a rule. The two are separate verdicts on the same row.

## The rule set

Rules live in `backend/lib/config/compliance-rules.ts`, beside `profiles.ts` and the intent packs. **Not prompt text** - a rubric buried in a prompt string is unversioned, unreviewable, and invisible to the people it protects. The judged rules are rendered *into* the prompt from this config at module load, so adding one changes what the judge is asked with no prompt edit.

```ts
interface ComplianceRule {
  id: string;                              // stable, cited in every verdict, never reused
  statement: string;                       // what the rule requires, in defensible words
  check: 'deterministic' | 'judged';
  severity: 'blocking' | 'major' | 'minor';
  scope: 'platform' | 'deployment';
  findingPrefixes?: string[];              // deterministic rules only
  findingExclusions?: string[];            // ids under a prefix that do NOT establish a breach
}
```

Three properties are load-bearing:

- **Versioned.** `COMPLIANCE_RULE_SET_VERSION` is recorded on every verdict as `evaluation_results.rule_set_version`. Rules move, and a rate compared across a rule change compares two different questions. Bump it whenever a rule is added, removed, or its meaning changes.
- **Stable ids.** `compliance_categories` stores ids, so a finding resolves to a written statement rather than to free text that drifts.
- **Per-deployment extension.** Platform rules ship fixed; a business adds its own with `scope: 'deployment'`. There is one rule source: a deployment rule is an entry added to the same `DEFAULT_COMPLIANCE_RULES` array in `backend/lib/config/compliance-rules.ts`, which the evaluation runner and the analytics query both import, and every shipped rule is `scope: 'platform'`. **NOT BUILT:** a separate per-deployment rule file or config key.

`validateComplianceRules` rejects a malformed set at construction: a duplicate id, a missing statement, a deterministic rule with nothing to match on (it could never fire, so it would imply coverage it does not provide), a judged rule carrying prefixes or exclusions, or an exclusion no prefix covers. The evaluation runner calls it at module load, so a mis-declared set stops the runner rather than producing a window of verdicts citing ids nothing resolves.

### Adding a rule

**Deterministic** - decided by looking at what the guardrail actually did:

```ts
{
  id: 'guardrail.topic',
  statement: 'A reply must not engage with a topic the deployment has denied.',
  check: 'deterministic',
  severity: 'blocking',
  scope: 'platform',
  findingPrefixes: ['guardrail.output.topic'],
}
```

`findingPrefixes` match the ids the turn recorded, shaped `guardrail.<input|output>.<policy>.<label>`. Prefix matching means one rule covers a policy family, so a newly configured PII entity or denied topic does not silently fall outside the rule.

`findingExclusions` carve an id back out, and match as a prefix too. They exist because a guardrail policy is not organized around who is at fault: Bedrock declares regex filters inside the sensitive-information policy, so the platform's own internal-marker mask arrives looking exactly like the assistant disclosing PII. Widening the prefix to dodge it would drop real entity types with it. Every exclusion must sit under one of the rule's own prefixes, or `validateComplianceRules` refuses it as dead config.

### Output-side only

Compliance asks whether the **reply** stayed within the rules. An input-side finding is a fact about what the person typed, and the assistant's response to it (a refusal, a masked prompt) is the control working. Counting it as a breach flags the assistant hardest on precisely the turns it handled correctly, and makes the compliance rate fall as abuse rises.

Input-side interventions are still recorded on the turn: `guardrailFindings` keeps both sides. They are an abuse signal, and they are not this metric.

**Judged** - assessed by the evaluator from the exchange text. No prefixes; the statement is handed to the judge as a criterion.

### Writing rules

- **One obligation per rule.** A rule bundling two requirements produces a verdict you cannot act on.
- **Write the statement as the finding.** If it cannot be read aloud to the person whose reply was flagged, it is too vague to judge against.
- **Choose `deterministic` whenever a check can express it.** Reproducible, free, and not subject to the judge's own drift.
- **Set `severity` by consequence.** `blocking` should mean somebody needs to know today.
- **Pick the right side.** Every deterministic rule matches output-side findings only, for the reason above: a person may put their own PII (or a denied topic) in a question, and penalizing the assistant for what the *user* typed would measure the wrong party.

## Verdict logic

**Deterministic first.** Deterministic evidence comes first, and it cannot be overturned. A guardrail intervention is an observed fact recorded when the turn ran. If a policy fired, the rule mapped to it is breached; no judgment is consulted about it.

The evidence lives on the message **update** row, not the create row: the assistant posts a placeholder and rewrites it when the reply is ready, so everything the turn learned while it ran is stamped on the update row. The evaluator joins the message's latest update and merges the two metadata objects, update winning - the same latest-update join the archival SQL uses.

**The judge only adds.** Judged rules can add breaches; they can never clear a deterministic one. The two sets are unioned.

**Silence is not a pass.** If the judge returns nothing usable *and* no guardrail fired, the verdict is `NULL` - not assessed. A deterministic breach still produces a real `false` in that case, because it was observed regardless of whether a model ran.

| `is_compliant` | Meaning |
|---|---|
| `true` | Assessed against rule-set version *v*; no rule breached. |
| `false` | Assessed; rules breached, ids in `compliance_categories`. |
| `NULL` | **Not assessed.** |

**Never coalesce NULL.** Defaulting it to `true` invents a pass for something never judged; defaulting to `false` invents a violation, and two readers that default differently report 0% and 100% from the same data. `an-unjudged-row-is-not-a-verdict.test.ts` fails the build if any reader coalesces it.

## Console surfaces

- **Compliance rate** over assessed exchanges only.
- **Coverage** beside it, always - "N of M assessed", and "Not assessed" when none are.
- **Blocking breaches called out separately**, because the rule set grades them and one rate throws that away. A week with two minor scope findings and a week with two disclosed card numbers produce the same percentage.
- **Per-exchange verdict** in the exchange list, so an operator reaches the reply behind a number.

Which tab depends on the analytics mode, and the two differ because the drill does:

| Mode | Rate and coverage | Per-exchange verdict |
|---|---|---|
| Aurora | Effectiveness, on the per-intent header | Effectiveness, in the L2 exchange list |
| Athena | Evaluations, always "Not assessed" | not served |

The Evaluations tab is Athena-only: in Aurora the Effectiveness drill supersedes it, which is why the compliance cards live there. **Athena mode computes no compliance verdict.** The verdict is written only by the Aurora evaluation runner (`evaluation-runner.ts`), and the Athena analytics query (`backend/lambda/src/analytics-query.ts`) returns no compliance counts, so the Evaluations tab's compliance card reads "Not assessed" on every Athena deployment. **NOT BUILT:** compliance evaluation in Athena mode.

A `blocking` breach also raises an **Alerts** entry. That is the one alert in the console that is not a threshold: `blocking` means "somebody needs to know today", so one occurrence is the alert rather than a percentage of a good week. Non-blocking breaches deliberately raise nothing - promoting every minor finding is how an alert list stops being read.

## Measuring the judge

`complianceAgreement` (data-plane op, `days` input) compares judge verdicts against human labels in `ground_truth_scores.human_is_compliant`, and reports the two directions separately: `judgeMissedBreach` is a breach that went unrecorded; `judgeOverflagged` is noise an operator must triage. A single percentage hides which is happening. `byRule` shows per-rule disagreement with each rule's `severity` and `scope`, because a rule the judge and a person consistently read differently is an ambiguous *statement* - a fixable thing - and the scope says whose statement it is to fix.

Run it with:

```
node backend/scripts/compliance-judge-agreement.mjs [--days=30] [--json]
```

The script invokes the data-plane Lambda, so it needs that Lambda's ARN: `dataPlaneArn` in `backend/deploy.config.json`, or `AURORA_DATA_PLANE_ARN` in the environment. It exits with `missing context` when neither is set. `backend/deploy.config.json` must exist either way: the script reads its `region` from that file (falling back to `AWS_REGION`, then `us-east-1`) and exits when the file is absent. The Aurora stack publishes the ARN to SSM at `/<instance-name>/shared/analytics/data-plane-arn` (`SHARED_SSM.auroraDataPlaneArn` in `agent-classification-common.ts`):

```
export AURORA_DATA_PLANE_ARN=$(aws ssm get-parameter --name /agent-echelon/shared/analytics/data-plane-arn --query Parameter.Value --output text)
```

Replace `agent-echelon` with your `AE_INSTANCE_NAME` if you set one.

A script rather than a dashboard card, because the number is meaningless until somebody has labeled compliance on a sample - deliberate, occasional work, not something an operator watches. A permanent "not assessed" card teaches people to ignore it.

It returns `agreementRate: null` until labels exist. That is deliberate: reporting a confident number for an unmeasured judge is the failure this step closes.

## External evaluators

This step has no dataset workbench and no metric library. Human compliance labels are entered per exchange on the Ground Truth tab (Aurora mode), and a draft profile version is compared with the active one on the assistant's golden set before it is activated ([HOW-TO-ADD-OR-MANAGE-A-PROFILE](HOW-TO-ADD-OR-MANAGE-A-PROFILE.md#the-golden-set-a-draft-is-measured-on)). For anything beyond those, point an external evaluator at the S3/Athena archive, which holds the full event sequence for that purpose.

## Change checklist

- [ ] `COMPLIANCE_RULE_SET_VERSION` bumped if any rule was added, removed, or redefined.
- [ ] Every `false` verdict still cites at least one rule id.
- [ ] The rule is output-side, or you can say why the assistant is the party at fault for an input.
- [ ] No reader coalesces NULL, and no rollup weights it as a zero (`an-unjudged-row-is-not-a-verdict.test.ts`).
- [ ] `validateComplianceRules` passes (`compliance-rules.test.ts`).
- [ ] Coverage is displayed wherever a rate is.
