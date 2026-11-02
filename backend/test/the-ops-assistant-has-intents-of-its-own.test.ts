/**
 * THE `ops` ROLE'S ASSISTANT HAS A TAXONOMY, AND IT IS ITS OWN.
 *
 * `ops-premium` is a second assistant inside the `premium` classification, deployed behind
 * where the deployment declares it (`ops-premium` in `profiles`). It had an identity, its own Amazon Lex bot, its own assignment record and its own boundary,
 * and no intent it recognized: the seeder walked one profile per classification, so nothing wrote it a
 * definition, and the router resolved the pack from the classification's PRIMARY. An operational
 * question therefore reached the classifier as `general` - no delivery class chosen for it, no
 * instructions to answer it by. A health-summary question deserves an intent of its own.
 *
 * These pin the four properties that make the pack actually decide something, rather than merely exist:
 * it validates, it is DECLARED in an order the keyword fallback can live with, it names only tools the
 * profile permits, and a health question is answered in the turn instead of deferred behind a task.
 */
import { OPS_INLINE_INTENTS, opsIntentPack } from '../demo/intent-packs';
import {
  validateIntentPackBody,
  WORK_MANAGEMENT_INTENT_KEYS,
  MAX_INTENT_SUMMARY,
} from '../lambda/src/lib/intent-pack';
import { serializeSeedDefinition } from '../lambda/src/lib/active-profile';
import { TOOL_REGISTRY } from '../lambda/src/lib/tool-registry';

const health = OPS_INLINE_INTENTS.find((i) => i.key === 'deployment_health')!;

describe('the ops intent pack', () => {
  it('validates, so the version carrying it can be edited and activated', () => {
    expect(validateIntentPackBody(opsIntentPack())).toEqual([]);
  });

  it('declares a work-management intent, or manage-profiles would refuse the version', () => {
    // The pack REPLACES the platform taxonomy (no `extends`), and `profile-lifecycle` refuses a
    // replacing pack that carries none of these: an assistant that cannot classify a request as work has
    // no multi-step path at all. Easy to lose in an edit, and the failure lands on an operator trying to
    // publish rather than on whoever wrote the pack.
    const keys = opsIntentPack().intents.map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining([...WORK_MANAGEMENT_INTENT_KEYS]));
  });

  it('answers a health question in the turn rather than opening a task', () => {
    // One tool call and a few lines of numbers. Deferring that behind a TASK_MULTI_STEP would make
    // somebody wait on work that is already done - the ADR-018 failure the per-intent delivery field
    // exists to prevent.
    expect(health.delivery).toBe('PLACEHOLDER_UPDATE');
  });

  it('declares deployment_health BEFORE guided_troubleshooting, because the keyword match is first-wins', () => {
    // `classifyByPackKeywords` returns the first-listed match and the platform troubleshooting intent
    // claims the bare words 'error', 'fail' and 'fix'. Declared second, "what is the error rate" would be
    // classified as a multi-step troubleshooting task instead of a metric read.
    const keys = OPS_INLINE_INTENTS.map((i) => i.key);
    expect(keys.indexOf('deployment_health')).toBeLessThan(keys.indexOf('guided_troubleshooting'));
  });

  it('names only tools the registry knows and the seeded profile allows', () => {
    // An intent's `tools` INTERSECTS the profile allowlist and may never widen it, so a name outside the
    // allowlist is refused at the write path rather than quietly granted. Checked against what the
    // profile is actually seeded with, not against the registry alone.
    const allowed = new Set(
      (JSON.parse(serializeSeedDefinition('ops-premium') as string) as { tools?: string[] }).tools ?? [],
    );
    expect(allowed.size).toBeGreaterThan(0);
    for (const intent of OPS_INLINE_INTENTS) {
      for (const tool of intent.tools ?? []) {
        expect([tool, TOOL_REGISTRY.some((t) => t.name === tool)]).toEqual([tool, true]);
        expect([tool, allowed.has(tool)]).toEqual([tool, true]);
      }
    }
  });

  it('reads the deployment telemetry and nothing else', () => {
    // The narrowing is the point: a health question that could also reach the company-context tools
    // turns into a reading of Stratum's financials, which this assistant is not the one to give.
    expect(health.tools).toEqual(['read_deployment_health']);
  });

  it('advertises itself in one bounded person-facing line that is not the classifier line', () => {
    // `summary` is what a primary assistant reads when it decides where to send something, so an ops
    // assistant with none is an assistant nobody is directed to.
    expect(health.summary).toBeTruthy();
    expect(health.summary!.length).toBeLessThanOrEqual(MAX_INTENT_SUMMARY);
    expect(health.summary).not.toBe(health.description);
  });
});
