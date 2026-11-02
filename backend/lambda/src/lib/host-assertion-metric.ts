/**
 * THE COUNT OF REFUSED HOST ASSERTIONS, BY CHECK (A9).
 *
 * One metric, `AssertionRefused` in `AgentEchelon/HostAssertion`, dimensioned by the check that refused
 * (`Check`) and by the issuer and the check (`Issuer`, `Check`). The edge authorizer counts what it refuses
 * (a signature, an audience, a lifetime, a missing `jti`, a replay, a route other than the exchange, a
 * subject nobody provisioned) and the credential exchange counts its own (a `jti` it could not consume, a
 * permission set the mapping does not declare, a subject it could not bind). An operator reads which check
 * a host is failing without reading a log line.
 *
 * Written as an EMF log line, so it costs no call and no grant. Nothing else counts these refusals, so this
 * is not a second count of a fact a ledger already holds (tenet D7).
 */
import { emitEmfMetric } from './emf-metrics.js';

export const HOST_ASSERTION_NAMESPACE = 'AgentEchelon/HostAssertion';
export const ASSERTION_REFUSED = 'AssertionRefused';

/** Count one refused assertion. Never throws: a metric is never the reason a request fails. */
export function countAssertionRefused(issuerId: string, check: string): void {
  try {
    emitEmfMetric({
      namespace: HOST_ASSERTION_NAMESPACE,
      metrics: [{ name: ASSERTION_REFUSED, unit: 'Count' }],
      dimensionSets: [['Check'], ['Issuer', 'Check']],
      properties: { Issuer: issuerId, Check: check, [ASSERTION_REFUSED]: 1 },
    });
  } catch {
    /* a metric line that cannot be written is not a refusal of its own */
  }
}
