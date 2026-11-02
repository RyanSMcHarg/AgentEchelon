/**
 * WHO A VENDOR NAMES, AS A PERSON THIS DEPLOYMENT ADMITS (K1, K2, K4).
 *
 * A connector names a person and never authenticates one (K1). The vendor adapter hands over a vendor user
 * id (`VendorPerson.subject`); this file is the ONE place that id becomes an AppInstanceUser, and it does so
 * only through `Identities`:
 *
 *  - the key is `<namespace>|<subject>`, where the namespace is the connector's `personIssuer` (a registry
 *    issuer whose declared subject is that vendor id, through the same single sign-on, V8) or the
 *    connector's own id (a row the person adds for their vendor account from a session already pinned to
 *    them, P-13);
 *  - the read is `resolvePerson`, which never mints, refuses a row that is not `active` and a row whose
 *    AppInstanceUser is gone.
 *
 * NEVER BY EMAIL (K2). Nothing here, and nothing in the adapters, reads an address. `Directory.findByAddress`
 * exists for the share-by-email path and is deliberately not reachable from here:
 * `test/lib/a-connector-names-a-person-only-through-identities.test.ts` refuses it, and any address-shaped
 * lookup, in every connector source file.
 *
 * A PERSON WITH NO `Identities` ROW:
 *
 *  - under a `provisioned-only` registry issuer (the connector's `personIssuer`, a `host-assertion` host,
 *    V8): pre-assigned through the connector subject provisioner (`provisionSubject`, P-13), which writes
 *    a `pending` row naming a new person. They are reported as `pending`: a pre-provisioned person reaches
 *    nothing, and is admitted nowhere, until their first sign-in binds the row;
 *  - otherwise (the connector's own namespace, an issuer that mints at first sign-in): reached by an
 *    invitation (M-10). A connector issuing one is **NOT BUILT**, so they are reported as `unresolved` and
 *    nothing is created.
 *
 * ADMISSION IS THE NARROWER OF TWO LIMITS (K4): a resolved person is admitted only when the classification
 * their issuers' clearance sources give them, each within its own issuer's classifications, reaches the
 * classification of the conversation the event concerns. A clearance that cannot be read is `undetermined`,
 * never admitted.
 *
 * AND ONLY A PERSON WHO MAY STILL SIGN IN (SPEC-CREDENTIAL-EXCHANGE §4b): their issuers are asked now
 * (`accountStateOfPerson`, `Directory.accountState`), since an `Identities` row keeps no copy of what
 * the issuer says. A person none of whose sign-ins is active is `refused`; a read that fails is
 * `undetermined`, never admitted.
 */
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import type { RuntimeConnector } from '../../../lib/config/connectors.js';
import { resolvePerson, type PersonSubject } from './person-identity.js';
import { accountStateOfPerson, type Directory } from './membership-source.js';
import type { VendorPerson } from './connectors/vendors.js';

export type ParticipantOutcome =
  | { role: string; state: 'admitted'; personArn: string }
  | { role: string; state: 'refused'; personArn: string }
  | { role: string; state: 'undetermined'; personArn: string }
  /** No `Identities` row: an invitation would reach them, and a connector issuing one is NOT BUILT. */
  | { role: string; state: 'unresolved' }
  /** Pre-assigned under a provisioned-only issuer and not signed in yet: admitted nowhere until they do (V8). */
  | { role: string; state: 'pending' };

export interface ParticipantDeps {
  /** `Identities`, read-only. Default `resolvePerson`. */
  resolve?: (namespace: string, subject: string) => Promise<string | null>;
  directory: Pick<Directory, 'clearanceOf' | 'accountState'>;
  /** The person's issuer subjects, read-only. Default `subjectsOfPerson` (the `byPerson` index). */
  subjectsOf?: (personArn: string) => Promise<PersonSubject[]>;
  /**
   * The namespaces whose unknown subjects are pre-assigned (the provisioned-only issuers this receiver's
   * provisioner serves), and the call that does it. Absent: nobody is pre-assigned.
   */
  provision?: {
    namespaces: readonly string[];
    /** Pre-assign the subject. True when a `pending` row now exists for it (written now, or before). */
    subject(namespace: string, subject: string, connectorId: string): Promise<boolean>;
  };
}

/** Resolve one vendor-named person through `Identities`, then admit them against `classification`. */
export async function resolveParticipant(
  connector: Pick<RuntimeConnector, 'namespace'> & Partial<Pick<RuntimeConnector, 'id'>>,
  person: VendorPerson,
  classification: string,
  deps: ParticipantDeps,
): Promise<ParticipantOutcome> {
  const resolve = deps.resolve ?? ((ns: string, subject: string) => resolvePerson(ns, subject));
  const personArn = await resolve(connector.namespace, person.subject);
  if (!personArn) {
    // PRE-ASSIGNED, NEVER ADMITTED: a provisioned person reaches nothing until they sign in (V8).
    if (deps.provision?.namespaces.includes(connector.namespace)) {
      try {
        if (await deps.provision.subject(connector.namespace, person.subject, connector.id ?? connector.namespace)) return { role: person.role, state: 'pending' };
      } catch (err) {
        console.warn('[connector-participants] a named person could not be pre-assigned; reported unresolved', { message: (err as Error)?.message });
      }
    }
    return { role: person.role, state: 'unresolved' };
  }
  try {
    if (await accountStateOfPerson(personArn, deps.directory, deps.subjectsOf ? { subjectsOf: deps.subjectsOf } : {}) !== 'active') {
      return { role: person.role, state: 'refused', personArn };
    }
  } catch (err) {
    console.warn('[connector-participants] whether a resolved person may sign in could not be read; not admitted', { message: (err as Error)?.message });
    return { role: person.role, state: 'undetermined', personArn };
  }
  let clearance;
  try {
    clearance = await deps.directory.clearanceOf(personArn);
  } catch (err) {
    console.warn('[connector-participants] a resolved person\'s clearance could not be read; not admitted', { message: (err as Error)?.message });
    return { role: person.role, state: 'undetermined', personArn };
  }
  if (clearance.state === 'undetermined') return { role: person.role, state: 'undetermined', personArn };
  return clearance.state === 'held' && profiles.holderReaches({ token: clearance.token, adminPlane: clearance.adminPlane === true }, classification)
    ? { role: person.role, state: 'admitted', personArn }
    : { role: person.role, state: 'refused', personArn };
}

/** Every person an event names, each resolved and admitted on its own. One failing read never admits another. */
export async function resolveParticipants(
  connector: Pick<RuntimeConnector, 'namespace'> & Partial<Pick<RuntimeConnector, 'id'>>,
  people: readonly VendorPerson[],
  classification: string,
  deps: ParticipantDeps,
): Promise<ParticipantOutcome[]> {
  const out: ParticipantOutcome[] = [];
  // Distinct subjects only: a vendor naming one person twice is one person.
  const seen = new Set<string>();
  for (const p of people) {
    if (seen.has(`${p.role}|${p.subject}`)) continue;
    seen.add(`${p.role}|${p.subject}`);
    out.push(await resolveParticipant(connector, p, classification, deps));
  }
  return out;
}
