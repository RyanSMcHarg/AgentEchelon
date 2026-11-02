/**
 * ADR-054: a per-deployment parameter keyed by CLASSIFICATION must not become a SECOND assistant's
 * fallback.
 *
 * Measured on the deployment, 2026-10-03, which is why this exists rather than anticipating: neither
 * premium assistant's active version carried a `welcome`, so both resolved
 * `{SSM_ROOT}/assistant/premium/welcome-orientation` and both introduced themselves as the business
 * advisor - once each, one second apart, in the conversation an alert had just opened.
 *
 * The guard is on the RULE rather than on the router, deliberately. The router's own resolution path
 * needs a Lex event, an assignment record and two SSM reads to exercise, and a test that assembled all
 * of that would be asserting the harness. What has to hold is one sentence - the classification's copy
 * belongs to the assistant the classification names - and every call site asks it through this
 * function, so this is where the sentence can be pinned.
 */
import { deploymentCopyAppliesTo, deploymentCopySkipped } from '../../lambda/src/lib/deployment-copy-scope';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';

describe('a second assistant does not inherit the primary assistant\'s deployment copy', () => {
  it('lets the classification\'s OWN assistant use the classification copy', () => {
    // The single-assistant case, which is every classification on most deployments and the case the
    // parameter was seeded for. A fix that broke this would take a deployment's configured persona and
    // welcome away from the assistant they were written for.
    expect(deploymentCopyAppliesTo('advisor', 'advisor')).toBe(true);
  });

  it('REFUSES the classification copy to a second assistant in the same classification', () => {
    expect(deploymentCopyAppliesTo('ops-premium', 'advisor')).toBe(false);
  });

  it('allows it when no assistant was established, which is the pre-roles path', () => {
    // A turn that adopted no assistant is running the path that existed before a classification could hold
    // two assistants, where the only assistant IS the primary. Refusing here would be a regression
    // dressed as a tightening.
    expect(deploymentCopyAppliesTo(undefined, 'advisor')).toBe(true);
    expect(deploymentCopyAppliesTo(null, 'advisor')).toBe(true);
  });

  it('allows it when the primary cannot be identified, rather than refusing on a missing answer', () => {
    // `classificationFor` returns undefined for an assistant the registry does not place (an `alt` occupant
    // is not a published profile). An unknown primary is not evidence of a second assistant.
    expect(deploymentCopyAppliesTo('ops-premium', undefined)).toBe(true);
  });

  /**
   * THE PREMISE THE WHOLE RULE RESTS ON, ASSERTED AGAINST THE SHIPPED CONFIG.
   *
   * If no classification actually declared two assistants, every case above would be arithmetic about
   * a situation that cannot arise, and the guard would pass forever while proving nothing. This reads
   * the registry: some classification must name a primary AND declare a role beyond it.
   */
  it('is not vacuous: the shipped config really does put two assistants in one classification', () => {
    const multiRole = profiles.classificationValues()
      .map((c) => ({ classification: c, roles: profiles.rolesFor(c), primary: profiles.profileFor(c)?.name }))
      .filter((r) => r.roles.length > 1);
    // No message argument: jest's expect takes one value. The explanation lives in the comment above.
    expect(multiRole.length).toBeGreaterThan(0);
    for (const r of multiRole) {
      expect(r.primary).toBeTruthy();
    }
  });

  it('explains the absence where an operator will read it', () => {
    const line = deploymentCopySkipped('welcome orientation', 'ops-premium', 'advisor');
    // The three things an operator needs: who was refused, what they were refused, and what they get
    // instead. A log line that said only "skipped" would make a generic welcome look like a bug.
    expect(line).toContain('ops-premium');
    expect(line).toContain('advisor');
    expect(line).toContain('welcome orientation');
    expect(line).toMatch(/platform default/);
    expect(line).toContain('ADR-054');
  });
});
