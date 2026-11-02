/**
 * THE SEAM FACTORY (C1): each trusted issuer's directory adapter and clearance source, chosen ONCE from
 * the registry and never constructed at a call site.
 *
 * Every question the platform asks about a person - their name, where to reach them, the groups they
 * hold, what they are cleared for - is asked of `Directory` (`lib/membership-source.ts`) by
 * AppInstanceUser. The directory finds the person's issuer subjects through `Identities` and asks each
 * subject's ISSUER, through the two seams this file builds for it:
 *
 *  - a DIRECTORY ADAPTER, per the entry's `directory` (C5): `cognito` reads the issuer's pool live,
 *    `claims` reads the contact copy of the last sign-in (`lib/claims-directory.ts`), `none` reads
 *    nothing. The other adapters the plan names are refused at synth as NOT BUILT.
 *  - a CLEARANCE SOURCE, per the entry's Q5 source (`lib/clearance-source.ts`): the pool's groups, a
 *    mapping, a fixed set, or the one-conversation session.
 *
 * So a second issuer is one registry entry, and nothing above the directory branches on which issuer a
 * person came from. A test selects a stub factory once (`__selectSeamsForTests`) and every consumer
 * uses it, which is how "selected once, used everywhere" is proven rather than reviewed.
 *
 * `backend/test/lib/clearance-has-one-provider-seam.test.ts` refuses an adapter constructed anywhere in
 * `backend/lambda` but here and in the adapters' own files.
 */
import { isTranslation, type TrustedIssuer } from '../../../lib/config/issuers.js';
import { cognitoPoolDirectory, type CognitoPoolDirectory, type PoolRecord } from './cognito-pool-directory.js';
import {
  CognitoClearanceSource,
  clearanceClient,
  fixedClearanceSource,
  groupsClearanceSource,
  translatedGroupsClearanceSource,
  mappingClearanceSource,
  oneChannelClearanceSource,
  type ClearanceSource,
  type IssuerClearanceSource,
} from './clearance-source.js';
import { claimsDirectory, type ClaimsDirectory } from './claims-directory.js';

/** What an issuer's store says about one subject. Display attributes and state, never an identity. */
export interface SubjectRecord {
  subject: string;
  enabled: boolean;
  email: string | null;
  /** A display name, or null when the record names nobody. */
  name: string | null;
}

/**
 * ONE ISSUER'S DIRECTORY, asked by subject, in the issuer's own terms. It never resolves identity: who a
 * subject IS is the core's question, answered through `Identities`. A method an adapter does not have is
 * a question its store cannot answer (a claims copy has no groups and no address search).
 */
export interface DirectoryAdapter {
  readonly kind: 'cognito' | 'claims' | 'none';
  readonly issuerId: string;
  /** The store's identity, so two entries reading one pool are asked once. */
  readonly storeKey: string;
  /** A display name for the subject, or null. */
  nameOf?(subject: string): Promise<string | null>;
  /**
   * The subject's contact, for the person it resolved to, or null when the store holds none for them or
   * reports their account disabled. Throws when the store cannot be read.
   */
  contactOf?(subject: string, personArn: string): Promise<{ email: string | null; name: string | null } | null>;
  /**
   * The subject's record with its enabled state, or null when the store has no such subject. Only a store
   * that keeps account state has this; `Directory.accountState` reads it at every vend.
   */
  record?(subject: string): Promise<SubjectRecord | null>;
  /** Every member of a group, enabled or not. Throws when the group cannot be listed. */
  usersInGroup?(group: string): Promise<SubjectRecord[]>;
  /** The store's group names that start with `prefix`. */
  listGroups?(prefix?: string): Promise<string[]>;
  /** The groups a subject holds. Throws when they cannot be read. */
  groupsOf?(subject: string): Promise<string[]>;
  /** The subjects whose address is exactly `address`. Only a store that keeps addresses has this. */
  subjectsByAddress?(address: string): Promise<SubjectRecord[]>;
}

/** The two seams of one issuer. */
export interface IssuerSeam {
  issuer: TrustedIssuer;
  directory: DirectoryAdapter;
  clearance: IssuerClearanceSource;
}

/** Builds the seams of one registry entry. The deployment's is `deployedSeams`; a test selects a stub. */
export type SeamFactory = (issuer: TrustedIssuer) => IssuerSeam;

/** A display name from a pool record, never an address: its name, else its email's local part. */
function nameFrom(record: PoolRecord | null): string | null {
  if (!record) return null;
  return record.name || (record.email || '').split('@')[0].trim() || null;
}

const subjectRecordOf = (r: PoolRecord): SubjectRecord => ({ subject: r.subject, enabled: r.enabled, email: r.email, name: nameFrom(r) });

/** The `cognito` adapter over one pool: its records, groups and address lookup. */
export function cognitoAdapter(issuerId: string, pool: CognitoPoolDirectory, groups: ClearanceSource): DirectoryAdapter {
  return {
    kind: 'cognito',
    issuerId,
    storeKey: `cognito:${pool.poolId}`,
    async nameOf(subject) {
      return nameFrom(await pool.record(subject));
    },
    async contactOf(subject) {
      const record = await pool.record(subject);
      // AN ACCOUNT THE POOL DISABLED IS REACHED BY NOTHING: no notice is sent to it, and a reply from its
      // address is refused, because a reply is accepted only from the address this answers.
      return record && record.enabled ? { email: record.email, name: nameFrom(record) } : null;
    },
    async record(subject) {
      const r = await pool.record(subject);
      return r ? subjectRecordOf(r) : null;
    },
    async usersInGroup(group) {
      return (await pool.usersInGroup(group)).map(subjectRecordOf);
    },
    listGroups: (prefix) => pool.groupNames(prefix),
    groupsOf: (subject) => groups.groupsFor(subject),
    async subjectsByAddress(address) {
      return (await pool.byEmail(address)).map(subjectRecordOf);
    },
  };
}

/** The `claims` adapter: the contact copy of the last sign-in, and nothing else. */
export function claimsAdapter(issuerId: string, copy: ClaimsDirectory): DirectoryAdapter {
  return {
    kind: 'claims',
    issuerId,
    storeKey: `claims:${issuerId}`,
    contactOf: (subject, personArn) => copy.contactOf(subject, personArn),
  };
}

/** The `none` adapter: an issuer whose people are named by their AppInstanceUser alone. */
export function noDirectory(issuerId: string): DirectoryAdapter {
  return { kind: 'none', issuerId, storeKey: `none:${issuerId}` };
}

/** The clearance source an entry's Q5 declaration names. */
export function clearanceSourceFor(issuer: TrustedIssuer, adapter: DirectoryAdapter): IssuerClearanceSource {
  const c = issuer.clearance;
  if ('groups' in c && isTranslation(c.groups)) {
    // A PROVIDER'S GROUPS, TRANSLATED: they arrive on the person's token and nowhere else this deployment
    // reads (a federated pool account's custom:groups is a copy of the last sign-in), so offline the
    // clearance is undetermined, and the exchange's recorded decision is evidence, never a grant.
    return translatedGroupsClearanceSource(issuer.id);
  }
  if ('groups' in c) {
    // THE POOL'S GROUPS, through its adapter. `groups: true` is a cognito-pool's (synth refuses any other),
    // so its adapter reads them; one that somehow cannot is undetermined, never cleared.
    return adapter.groupsOf
      ? groupsClearanceSource(issuer.id, { name: `${issuer.id} groups`, groupsFor: (s) => adapter.groupsOf!(s) })
      : mappingClearanceSource(issuer.id);
  }
  if ('mapping' in c) return mappingClearanceSource(issuer.id);
  if ('fixed' in c) return fixedClearanceSource(issuer.id, c.fixed);
  return oneChannelClearanceSource(issuer.id, c.oneChannel);
}

// ── THE DEPLOYED FACTORY ─────────────────────────────────────────────────────────────────────────

/** One pool adapter per pool per container, whichever entries name it. */
const pools = new Map<string, { pool: CognitoPoolDirectory; groups: ClearanceSource }>();

/** The pool adapter of one pool, for the console that administers it and the offboarding of its accounts. */
export function poolAdapter(poolId: string, client?: { send(command: unknown): Promise<any> }): CognitoPoolDirectory {
  if (client) return cognitoPoolDirectory(poolId, client);
  return poolOf(poolId).pool;
}

/** The pool's clearance groups provider, for the console that administers the pool. */
export function poolGroups(poolId: string, client?: { send(command: unknown): Promise<any> }): ClearanceSource {
  if (client) return new CognitoClearanceSource(client as never, poolId);
  return poolOf(poolId).groups;
}

function poolOf(poolId: string): { pool: CognitoPoolDirectory; groups: ClearanceSource } {
  let hit = pools.get(poolId);
  if (!hit) {
    hit = { pool: cognitoPoolDirectory(poolId), groups: new CognitoClearanceSource(clearanceClient(), poolId) };
    pools.set(poolId, hit);
  }
  return hit;
}

/** The deployment's factory: each entry's declared adapter and source. */
export const deployedSeams: SeamFactory = (issuer) => {
  let directory: DirectoryAdapter;
  if (issuer.directory === 'cognito' && issuer.pool) {
    const { pool, groups } = poolOf(issuer.pool);
    directory = cognitoAdapter(issuer.id, pool, groups);
  } else if (issuer.directory === 'claims') {
    directory = claimsAdapter(issuer.id, claimsDirectory(issuer.id));
  } else {
    directory = noDirectory(issuer.id);
  }
  return { issuer, directory, clearance: clearanceSourceFor(issuer, directory) };
};

/** A factory whose every issuer reads its groups from one provider and names nobody: a test's clearance seam. */
export function groupsOnlySeams(provider: ClearanceSource): SeamFactory {
  return (issuer) => ({ issuer, directory: noDirectory(issuer.id), clearance: groupsClearanceSource(issuer.id, provider) });
}

let selected: SeamFactory | null = null;

/** The factory this container uses, selected once. */
export function selectedSeams(): SeamFactory {
  return selected ?? deployedSeams;
}

/** Test seam: select a factory for every consumer in this container. `null` restores the deployed one. */
export function __selectSeamsForTests(f: SeamFactory | null): void {
  selected = f;
  pools.clear();
}
