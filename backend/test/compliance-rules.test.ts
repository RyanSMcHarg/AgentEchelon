/**
 * THE COMPLIANCE RULE SET, and the verdict it produces.
 *
 * Pass C (DESIGN-EVALUATION, Pass C). The rules are config so a finding can cite a statement a
 * person can read; these tests pin the properties that make a stored verdict mean something later.
 *
 * The behavior most worth protecting is the one that caused the original defect: **an absent
 * judgement is never a verdict**. Three queries once coalesced a NULL in three directions and
 * published 0%, 100% and "no violations" from the same unjudged data.
 */
import {
  COMPLIANCE_RULE_SET_VERSION,
  DEFAULT_COMPLIANCE_RULES,
  deterministicBreaches,
  deterministicRules,
  judgedRules,
  ruleById,
  validateComplianceRules,
  type ComplianceRule,
} from '../lib/config/compliance-rules';
import { INTERNAL_MARKER_FINDING_IDS } from '../lib/config/guardrail-masks';

describe('the shipped rule set', () => {
  it('is valid by its own validator', () => {
    expect(() => validateComplianceRules(DEFAULT_COMPLIANCE_RULES)).not.toThrow();
  });

  it('gives every rule a stable id and a statement somebody could defend', () => {
    for (const r of DEFAULT_COMPLIANCE_RULES) {
      expect(r.id).toMatch(/^[a-z0-9][a-z0-9.\-]*$/);
      // A statement that cannot be read aloud to the person flagged is too vague to judge against.
      expect(r.statement.trim().length).toBeGreaterThan(20);
    }
  });

  it('declares a version, because rules move', () => {
    // A compliance rate compared across a rule change compares two different questions. The verdict
    // records this so a reader can tell which figures are comparable.
    expect(COMPLIANCE_RULE_SET_VERSION).toBeTruthy();
  });

  it('splits deterministic from judged, and neither set is empty', () => {
    // If everything were judged, nothing would be reproducible. If everything were deterministic,
    // the rules would be limited to what a guardrail happens to express.
    expect(deterministicRules().length).toBeGreaterThan(0);
    expect(judgedRules().length).toBeGreaterThan(0);
  });

  it('rejects a deterministic rule that can never fire', () => {
    // A rule with nothing to match on sits in the set implying coverage it does not provide - the
    // exact failure this design exists to prevent.
    const bad: ComplianceRule[] = [
      { id: 'x.y', statement: 'A statement long enough to pass the length check.', check: 'deterministic', severity: 'minor', scope: 'platform' },
    ];
    expect(() => validateComplianceRules(bad)).toThrow(/findingPrefixes/);
  });

  it('rejects duplicate ids', () => {
    const dup: ComplianceRule[] = [
      { id: 'a.b', statement: 'A statement long enough to pass the length check.', check: 'judged', severity: 'minor', scope: 'platform' },
      { id: 'a.b', statement: 'Another statement long enough to pass it too.', check: 'judged', severity: 'minor', scope: 'platform' },
    ];
    // A stored verdict points at an id forever; two rules sharing one makes a finding unresolvable.
    expect(() => validateComplianceRules(dup)).toThrow(/duplicate/);
  });

  it('resolves a finding back to the rule it cites', () => {
    const rule = ruleById(DEFAULT_COMPLIANCE_RULES[0].id);
    expect(rule?.statement).toBeTruthy();
  });
});

describe('deterministic breaches, from what the guardrail actually did', () => {
  it('maps a guardrail finding to its rule by prefix', () => {
    // Prefix, so one rule covers a policy family and a newly configured entity type does not silently
    // fall outside the rule.
    expect(deterministicBreaches(['guardrail.output.topic.competitor-pricing'])).toContain('guardrail.topic');
    expect(deterministicBreaches(['guardrail.output.content.hate'])).toContain('guardrail.content');
  });

  it('finds nothing when no policy intervened', () => {
    expect(deterministicBreaches([])).toEqual([]);
    expect(deterministicBreaches(['guardrail.input.unmapped.thing'])).toEqual([]);
  });

  it('never breaches on an INPUT-side finding, whatever the policy', () => {
    // Compliance asks whether the REPLY stayed within the rules. An input finding is a fact about what
    // the person typed, and the assistant's response to it - a refusal, a masked prompt - is the
    // control working. Counting it flagged the assistant hardest on the turns it handled correctly,
    // and made the compliance rate fall as abuse rose.
    for (const finding of [
      'guardrail.input.topic.competitor-pricing',
      'guardrail.input.content.prompt_attack',
      'guardrail.input.word.custom',
      'guardrail.input.pii.email',
    ]) {
      expect(deterministicBreaches([finding])).toEqual([]);
    }
  });

  it('treats PII disclosure as an OUTPUT-side rule only', () => {
    // A person may put their own PII in a question. Penalising the assistant for what the USER typed
    // would make the metric measure the wrong party; disclosure in a REPLY is the assistant's conduct.
    expect(deterministicBreaches(['guardrail.output.pii.email'])).toContain('guardrail.sensitive-information');
    expect(deterministicBreaches(['guardrail.input.pii.email'])).not.toContain('guardrail.sensitive-information');
  });

  it('does not read the platform masking its OWN control marker as a disclosure', () => {
    // Bedrock declares regex filters inside the sensitive-information policy, so the internal-marker
    // filter reports as a PII finding - on a reply where the model echoed a marker the platform itself
    // writes. That is scaffolding being cleaned up, and it would otherwise have been the single most
    // common compliance breach in the system.
    for (const id of INTERNAL_MARKER_FINDING_IDS) {
      expect(deterministicBreaches([id])).toEqual([]);
      // And the exclusion is scoped to that one id, not to the PII family it sits in.
      expect(deterministicBreaches([id, 'guardrail.output.pii.email']))
        .toContain('guardrail.sensitive-information');
    }
  });

  it('cites a rule for a word-policy intervention on the reply', () => {
    // The word policy was measured on every turn and named by no rule, so a reply the guardrail had to
    // intervene on passed compliance clean.
    expect(deterministicBreaches(['guardrail.output.word.profanity'])).toContain('guardrail.word');
    expect(deterministicBreaches(['guardrail.output.word.custom'])).toContain('guardrail.word');
  });

  it('rejects an exclusion that no prefix covers', () => {
    // An exclusion sitting under no prefix excludes nothing, and reads in review as coverage being
    // narrowed when it is not.
    const bad: ComplianceRule[] = [{
      id: 'x.y',
      statement: 'A statement long enough to pass the length check.',
      check: 'deterministic',
      severity: 'minor',
      scope: 'platform',
      findingPrefixes: ['guardrail.output.topic'],
      findingExclusions: ['guardrail.output.pii.something'],
    }];
    expect(() => validateComplianceRules(bad)).toThrow(/no findingPrefix covers/);
  });

  it('returns ids in rule-set order, not in the order findings arrived', () => {
    // A verdict's category list should be stable across runs rather than reflecting the order Bedrock
    // happened to report its assessments in.
    const a = deterministicBreaches(['guardrail.output.content.hate', 'guardrail.input.topic.x']);
    const b = deterministicBreaches(['guardrail.input.topic.x', 'guardrail.output.content.hate']);
    expect(a).toEqual(b);
  });
});
