/**
 * TEST-FIXTURE ISSUERS: registry entries the e2e suite signs in through, whose pools the opt-in
 * `TestIssuer` stack creates (`lib/stacks/test-issuer-stack.ts`).
 *
 * An entry of the trusted-issuer registry (`issuers` in deploy.config.json) that declares
 * `owner: "test-fixture"` is a fixture: a non-pool person the suite needs (the H1 rows of the plan) and
 * nobody else. Declaring one is the opt-in, so there is no separate switch: the `TestIssuer` stack exists
 * exactly when the registry holds a fixture, with one user pool per fixture.
 *
 * ── A FIXTURE IS TRUSTED ONLY ONCE IT NAMES ITS POOL ────────────────────────────────────────────────
 *
 * The pool a fixture signs in through is created by `TestIssuer`, so its id exists only after the first
 * deploy of that stack. Until the entry carries the values the edge checks a token against (a
 * `cognito-pool` its `pool`; an `oidc` entry its `issuer`, `discoveryUrl` and `audience`), it is left out
 * of the registry the app is built from, and nothing accepts its tokens. Filling them in, from the
 * stack's outputs, is the second pass that admits it. Fail closed: a half-declared fixture reaches nothing.
 *
 * ── NEVER IN PRODUCTION ─────────────────────────────────────────────────────────────────────────────
 *
 * A fixture is a pool whose users the suite creates with known passwords. Synth refuses one when
 * `environment` is `production`, whether or not it names its pool yet.
 */
import { parseIssuersContext, type IssuerConfig } from './issuers';
import { parseEnvironment } from './environment';

/** The `owner` value that marks a registry entry as a test fixture. */
export const TEST_FIXTURE_OWNER = 'test-fixture';

/** The kinds a fixture may be: a Cognito pool, or that same pool declared as a foreign OIDC issuer. */
export const TEST_FIXTURE_KINDS = ['cognito-pool', 'oidc'] as const;

export interface TestFixtureSplit {
  /** Every fixture entry: the `TestIssuer` stack creates one pool for each. */
  fixtures: IssuerConfig[];
  /** The entries the app's registry is built from: every non-fixture entry, and the fixtures that name their pool. */
  trusted: unknown[];
  /** The fixtures left out of the registry because they do not name their pool yet. */
  pending: string[];
}

const ownerOf = (e: unknown): unknown => (e && typeof e === 'object' ? (e as { owner?: unknown }).owner : undefined);

/** True when a fixture carries the values its tokens are verified against. */
export function fixtureNamesItsPool(e: IssuerConfig): boolean {
  if (e.kind === 'cognito-pool') return typeof e.pool === 'string' && e.pool.length > 0;
  return Boolean(e.issuer && e.discoveryUrl && e.audience);
}

/**
 * Split a parsed `issuers` list into fixtures and the entries the registry is built from, or throw naming
 * every reason a fixture cannot be declared here. `raw` undefined is the default registry, which holds no
 * fixture.
 */
export function splitTestFixtures(raw: unknown[] | undefined, environment: string): TestFixtureSplit | undefined {
  if (raw === undefined) return undefined;
  const errors: string[] = [];
  const fixtures: IssuerConfig[] = [];
  const trusted: unknown[] = [];
  const pending: string[] = [];
  raw.forEach((r, i) => {
    const owner = ownerOf(r);
    if (owner === undefined) { trusted.push(r); return; }
    const e = r as IssuerConfig;
    const at = `issuer "${typeof e.id === 'string' ? e.id : `[${i}]`}"`;
    if (owner !== TEST_FIXTURE_OWNER) {
      errors.push(`${at}: owner is "${TEST_FIXTURE_OWNER}" or absent; "${String(owner)}" marks nothing`);
      return;
    }
    if (environment === 'production') {
      errors.push(`${at}: a test-fixture issuer is refused in production; its pool's users are created by the test suite`);
      return;
    }
    if (!(TEST_FIXTURE_KINDS as readonly string[]).includes(e.kind)) {
      errors.push(`${at}: a test-fixture issuer is a ${TEST_FIXTURE_KINDS.join(' or an ')} entry, not ${String(e.kind)}`);
      return;
    }
    if (e.pool === 'self') {
      errors.push(`${at}: a test-fixture issuer signs in through its own TestIssuer pool, never this deployment's own`);
      return;
    }
    // A FIXTURE MAY DECLARE admin: true, because a provider's administrators are a path the identity-provider
    // guide tells a deployer to follow (a provider group mapped to `admins`), and the suite proves it there.
    // A fixture is refused in production above, and its people exist for the run that made them.
    if (e.admin === true && e.kind !== 'oidc') {
      errors.push(`${at}: a test-fixture issuer declares admin: true only as an oidc fixture, the provider whose administrators the guide maps`);
      return;
    }
    fixtures.push(e);
    if (fixtureNamesItsPool(e)) trusted.push(r);
    else pending.push(e.id);
  });
  if (errors.length) throw new Error(`issuers cannot be synthesized:\n  ${errors.join('\n  ')}`);
  return { fixtures, trusted, pending };
}

/**
 * The entries the registry is built from, given the raw `issuers` and `environment` context: every
 * entry but the test fixtures that do not name their pool yet. Undefined when no registry is declared.
 * `bin/backend.ts` and every stack that reads the registry (`issuersOf`) read it through this, so they
 * agree on which fixtures are trusted.
 */
export function trustedIssuerEntries(rawIssuers: unknown, rawEnvironment: unknown): unknown[] | undefined {
  return splitTestFixtures(parseIssuersContext(rawIssuers), parseEnvironment(rawEnvironment))?.trusted;
}
