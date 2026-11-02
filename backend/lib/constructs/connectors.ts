/**
 * THE CONNECTOR REGISTRY, AS A STACK READS IT: the `connectors` context, checked against the issuers and
 * classifications this deployment declares (`lib/config/connectors.ts`).
 *
 * `bin/backend.ts` validates it once at synth; a stack reads it here rather than being handed it, the same
 * way `issuersOf` reads the trusted-issuer registry, so a construct cannot be given a different list than
 * the one that was checked.
 */
import type { Construct } from 'constructs';
import { connectorRegistry, type ConnectorContext, type ConnectorRegistry } from '../config/connectors';
import { parseCapabilities } from '../config/capabilities';
import { defaultProfileRegistry as profiles } from '../profile-registry';
import { issuersOf } from './trusted-issuers';
import { issuerClassificationsOf, type ClearanceConfig } from '../config/issuers';

/** What the connector registry is checked against, from the issuer and profile registries. */
export function connectorContextOf(issuers: { entries: ReadonlyArray<{ id: string; clearance: ClearanceConfig; admin?: boolean }> }): ConnectorContext {
  return {
    issuers: issuers.entries.map((e) => ({ id: e.id, classifications: issuerClassificationsOf(e, profiles) })),
    isConversational: (c) => profiles.isKnownClassification(c) && profiles.isConversational(c),
    grantsFor: (c) => (profiles.isKnownClassification(c) ? profiles.grantsFor(c) : []),
  };
}

export function connectorsOf(scope: Construct): ConnectorRegistry {
  return connectorRegistry(
    scope.node.tryGetContext('connectors'),
    connectorContextOf(issuersOf(scope)),
    parseCapabilities(scope.node.tryGetContext('capabilities')),
  );
}
