/**
 * THE DIRECTORY: what the deployment's identity providers say about a PERSON, asked by AppInstanceUser.
 *
 * A person is their AppInstanceUser (README.md:3). An identity provider knows them only as a subject of
 * one issuer, and which subjects sign in as which AppInstanceUser lives only in the `Identities` table
 * (`lib/person-identity.ts`). So every question here is answered in two halves:
 *
 *  - CORE (this file): identity resolution and policy. A subject becomes a person through
 *    `resolvePerson`, a person becomes their subjects through the `byPerson` reverse lookup
 *    (`subjectsOfPerson`), and what a source's answer MEANS (the issuer's classifications, the token) is the registry's.
 *  - SEAMS, one pair per trusted issuer, built from the registry by the seam factory
 *    (`lib/issuer-seams.ts`): a directory adapter (`cognito`, `claims` or `none`) and a clearance source
 *    (the issuer's Q5 source). An adapter never resolves identity, so a second issuer is one registry
 *    entry, and nothing above this file branches on which issuer a person came from.
 *
 * WHETHER AN ACCOUNT MAY STILL SIGN IN is the issuer's answer, asked live (`accountState`) and never
 * copied: the `Identities` table keeps no record of an identity provider's state, so the credential
 * exchange asks this at every vend (SPEC-CREDENTIAL-EXCHANGE §4b, "An account disabled at its issuer").
 *
 * A person whose subjects are all under an issuer the registry no longer declares is a REMOVED ISSUER'S
 * person: they resolve to no clearance (`clearanceOf` answers `none`), no name from a directory and no
 * contact, and the membership audit flags them (C3).
 *
 * ── A CONVERSATION TYPE'S MEMBERSHIP SOURCE (DESIGN-CONVERSATION-TYPES §6) ───────────────────────
 *
 * The allowed set is the members of the type's identity-provider group, the subjects on its list, or the
 * union of both. Each candidate is then ADMITTED against the conversation's classification with the same
 * registry the credential exchange and the router use - the holder token their issuers' sources resolve
 * to must reach the classification - because a group is not a clearance. A person the classification
 * refuses is a SETTLED state: never added, never retried as a discrepancy.
 *
 * THREE OUTCOMES, NOT TWO. A person whose clearance could not be read is UNDETERMINED rather than
 * refused: the reconcile neither adds nor removes them on this pass, because removing somebody over a
 * throttled read would be the access decision failing open in the other direction. A group member with
 * no AppInstanceUser yet (they have never signed in) is undetermined too: there is nobody to add until
 * their first credential exchange mints them. A source whose group cannot be listed at all throws, and
 * the caller refuses the creation or skips the conversation.
 */
import { typeAdmitsIssuers, type MembershipSource } from '../../../lib/config/conversation-types.js';
import { clearanceRecordMaxAgeMs, heldWithinIssuer, isTranslation, type TrustedIssuer } from '../../../lib/config/issuers.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { DescribeAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-identity';
import { isPersonArn, personIdFromArn, userArnFor } from './person-arn.js';
import { resolvePerson, subjectsOfPerson, type ClearanceDecision, type PersonSubject } from './person-identity.js';
import { trustedIssuers } from './trusted-issuers.js';
import { selectedSeams, type IssuerSeam, type SeamFactory } from './issuer-seams.js';
import { chimeIdentityClient } from './chime/clients.js';

/** The one route a contact is resolved for. Email only: no SMS, no preferences. */
export type ContactRoute = 'email';

/** Where to reach a person on one route, resolved at send time and never stored. */
export interface Contact {
  route: ContactRoute;
  address: string;
  /** A display name for a greeting, or null when the record names nobody. */
  name: string | null;
}

/** The ENABLED members of a group, as people. */
export interface PersonsInGroup {
  /** Their AppInstanceUser ARNs. */
  persons: string[];
  /** Group members with no AppInstanceUser yet. Undetermined, never refused. */
  unminted: string[];
}

/**
 * What an issuer says about one subject's account now: `active`, `disabled` (the issuer holds it and
 * refuses its sign-in) or `gone` (the issuer holds no such account, or the registry no longer declares
 * the issuer). An issuer whose directory keeps no account state answers `active`: its signed token is
 * its answer (SPEC-CREDENTIAL-EXCHANGE §4b).
 */
export type AccountState = 'active' | 'disabled' | 'gone';

/**
 * WHAT A PERSON IS CLEARED FOR, read without a token (C3).
 *
 *  - `held`: every trusted issuer they sign in through answered. `token` is the declared classification
 *    standing for the union of what they hold, each issuer's part within its own classifications; undefined
 *    when that union is a combination nobody declared. `admin` is true when an issuer declaring
 *    `admin: true` reports them in one of its admin groups.
 *  - `none`: they sign in through no issuer the registry declares (a removed issuer). No clearance.
 *  - `undetermined`: an issuer of theirs decides only from a token they present (a `mapping`), so there
 *    is nothing to read offline. Never a guess and never a floor. `lastSignIn` carries, for each such
 *    issuer, what the credential exchange recorded it decided at the person's last sign-in through it
 *    (`clearanceDecision`), and whether that record is older than the issuer allows. It is EVIDENCE for a
 *    reader to flag a mismatch or a stale record with; it is never `held`, and nothing grants from it.
 */
export interface ClearanceEvidence {
  issuer: string;
  /** The classification the exchange vended at that sign-in. */
  classification: string;
  /** When it decided, ISO 8601. */
  at: string;
  /** Older than the issuer's `recordMaxAgeDays` (or with no readable time): flag it, do not read it. */
  stale: boolean;
}

export type PersonClearance =
  | {
    state: 'held'; token: string | undefined; held: string[]; groups: string[]; admin: boolean;
    /** Whether the admin plane classification is held beside (or as) the token: admin conversations (`ProfileRegistry.holderOf`). */
    adminPlane?: boolean;
    /** The registry ids of the trusted issuers the person signs in through, for a type's issuer narrowing (T1). */
    issuers?: string[];
  }
  | { state: 'none' }
  | { state: 'undetermined'; issuers: string[]; lastSignIn?: ClearanceEvidence[] };

/** What the identity providers are asked, by person. Injected so the logic is testable without AWS. */
export interface Directory {
  /** The ENABLED members of a group, in every issuer whose directory keeps groups. Throws when one cannot be read. */
  personsInGroup(group: string): Promise<PersonsInGroup>;
  /**
   * The ENABLED admins (C2): the members of each `admin: true` issuer's admin groups (`adminGroups`,
   * default `admins`), or of `groups` when given, in that issuer's own directory.
   */
  admins(groups?: readonly string[]): Promise<PersonsInGroup>;
  /** The person a list entry names: their AppInstanceUser ARN, `<issuer id>|<subject>`, or a subject of this deployment's own pool. */
  personOf(entry: string): Promise<string | null>;
  /**
   * The groups a person holds, in every directory of theirs that keeps groups. Null when they sign in
   * through no such directory. Throws when the groups cannot be read.
   */
  groupsFor(personArn: string): Promise<string[] | null>;
  /**
   * The classifications the groups `groupsFor` reads clear the person for, each directory's groups bounded by its own
   * issuer's classifications (`heldWithinIssuer`): the rule the credential exchange applies to the session it issues,
   * read from the same groups. Null when the person signs in through no directory that keeps groups.
   */
  clearedByGroups(personArn: string): Promise<string[] | null>;
  /** What the person is cleared for, through each of their issuers' clearance sources. Throws when a source fails. */
  clearanceOf(personArn: string): Promise<PersonClearance>;
  /**
   * Whether one subject's account may sign in, asked of its issuer's directory now and never cached.
   * THROWS when the directory cannot be read, so a caller never takes a failed read for `active`.
   */
  accountState(issuer: string, subject: string): Promise<AccountState>;
  /** The group names that start with `prefix`, in every directory that keeps groups (team ownership, C4). */
  listGroups(prefix?: string): Promise<string[]>;
  /** A display name for the person, never an address. Null when nobody names them. */
  displayNameFor(personArn: string): Promise<string | null>;
  /** Where to reach the person on `route`, or null when no trusted directory holds one. Never throws. */
  contactFor(personArn: string, route: ContactRoute): Promise<Contact | null>;
  /**
   * The person an address names within ONE issuer's directory, or null. Never another issuer's, never
   * a binding by address: the address finds that issuer's subject, and the subject resolves through
   * `Identities` like a sign-in. Two subjects carrying the address is ambiguous, and resolves to nobody.
   */
  findByAddress(issuer: string, address: string): Promise<string | null>;
}

// ── THE CORE ──────────────────────────────────────────────────────────────────────────────────────

/** What a directory is built from: the registry, and the factory that chooses each issuer's seams. */
export interface DirectoryConfig {
  appInstanceArn: string;
  /** The registry's entries, as this function was handed them (`TRUSTED_ISSUERS`). */
  issuers: readonly TrustedIssuer[];
  /** Default: the factory selected for this container (`selectedSeams`). */
  seams?: SeamFactory;
  /** Injected for tests; default the `Identities` table. */
  identities?: {
    resolve: (issuer: string, subject: string) => Promise<string | null>;
    subjectsOf: (personArn: string) => Promise<PersonSubject[]>;
  };
  /** The AppInstanceUser's own `Name`, for a person no directory names. Default `DescribeAppInstanceUser`. */
  appInstanceUserName?: (personArn: string) => Promise<string | null>;
}

const NAME_TTL_MS = 5 * 60_000;

let chimeIdentity: ReturnType<typeof chimeIdentityClient> | null = null;
async function describeName(personArn: string): Promise<string | null> {
  chimeIdentity = chimeIdentity ?? chimeIdentityClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const r = await chimeIdentity.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: personArn }));
  const name = (r.AppInstanceUser?.Name || '').trim();
  // THE NAME IS A DISPLAY NAME, never an address (the exchange writes one); refuse one that looks like an
  // address rather than show it.
  return name && !name.includes('@') ? name : null;
}

/**
 * A recorded decision as evidence of the last sign-in through `issuer`: the classification and when, and
 * whether it is older than the issuer allows. Null when nothing was recorded, or the record names another
 * issuer (a row is the subject's own, so that is a corrupt row, and it is not read).
 */
export function evidenceOf(issuer: TrustedIssuer, decision: ClearanceDecision | undefined, nowMs: number = Date.now()): ClearanceEvidence | null {
  if (!decision || decision.issuer !== issuer.id || typeof decision.classification !== 'string' || !decision.classification) return null;
  const at = Date.parse(decision.at);
  const stale = Number.isNaN(at) || nowMs - at > clearanceRecordMaxAgeMs(issuer.clearance);
  return { issuer: issuer.id, classification: decision.classification, at: decision.at, stale };
}

export function createDirectory(config: DirectoryConfig): Directory {
  const factory = config.seams ?? selectedSeams();
  // SELECTED ONCE: one seam pair per registry entry, for the life of this directory.
  const seams = new Map<string, IssuerSeam>(config.issuers.map((t) => [t.id, factory(t)]));
  const identities = config.identities ?? {
    resolve: (issuer: string, subject: string) => resolvePerson(issuer, subject),
    subjectsOf: (arn: string) => subjectsOfPerson(arn, {}),
  };
  const appInstanceUserName = config.appInstanceUserName ?? describeName;
  const names = new Map<string, { name: string | null; until: number }>();

  /** Each store once, with every entry that reads it: two entries can name one pool. */
  function stores(filter: (s: IssuerSeam) => boolean): Array<{ seam: IssuerSeam; ids: string[] }> {
    const byStore = new Map<string, { seam: IssuerSeam; ids: string[] }>();
    for (const s of seams.values()) {
      if (!filter(s)) continue;
      const hit = byStore.get(s.directory.storeKey);
      if (hit) hit.ids.push(s.issuer.id);
      else byStore.set(s.directory.storeKey, { seam: s, ids: [s.issuer.id] });
    }
    return [...byStore.values()];
  }

  /**
   * Whether an entry's people hold AgentEchelon groups through its store's groups. A translating entry's
   * people hold them through their provider (`isTranslation`, lib/config/issuers.ts), so a pool group on a
   * federated person's account is not one they hold, and a listing by group leaves the entry out
   * (SPEC-CREDENTIAL-EXCHANGE §4b).
   */
  const readsStoreGroups = (s: IssuerSeam | undefined): boolean =>
    !!s && !('groups' in s.issuer.clearance && isTranslation(s.issuer.clearance.groups));

  /** The issuer ids whose entries read the same store as `seam`, its own first. */
  const sameStore = (seam: IssuerSeam): string[] => [
    seam.issuer.id,
    ...[...seams.values()].filter((s) => s !== seam && s.directory.storeKey === seam.directory.storeKey).map((s) => s.issuer.id),
  ];

  /** The person a subject of a store signs in as, through any entry reading that store. */
  async function personOfStoreSubject(ids: readonly string[], subject: string): Promise<string | null> {
    for (const id of ids) {
      const arn = await identities.resolve(id, subject);
      if (arn) return arn;
    }
    return null;
  }

  /** The person's subjects, each with its issuer's seams. A subject under an undeclared issuer has none. */
  async function subjectsWithSeams(personArn: string): Promise<{ trusted: Array<{ seam: IssuerSeam; subject: string; decision?: ClearanceDecision }>; any: boolean }> {
    if (!isPersonArn(personArn)) return { trusted: [], any: false };
    const subjects = await identities.subjectsOf(personArn);
    const trusted: Array<{ seam: IssuerSeam; subject: string; decision?: ClearanceDecision }> = [];
    for (const s of subjects) {
      const seam = seams.get(s.issuer);
      if (seam) trusted.push({ seam, subject: s.subject, ...(s.clearanceDecision ? { decision: s.clearanceDecision } : {}) });
    }
    return { trusted, any: subjects.length > 0 };
  }

  async function membersOf(seam: IssuerSeam, ids: readonly string[], group: string, out: PersonsInGroup, seen: Set<string>): Promise<void> {
    for (const record of await seam.directory.usersInGroup!(group)) {
      // A DISABLED user is not in the allowed set: disabling somebody in the directory has to take
      // them out of the rooms their group put them in, not only stop their next sign-in.
      if (!record.enabled || !record.subject) continue;
      const arn = await personOfStoreSubject(ids, record.subject);
      if (arn) {
        if (!seen.has(arn)) { seen.add(arn); out.persons.push(arn); }
      } else if (!out.unminted.includes(record.subject)) out.unminted.push(record.subject);
    }
  }

  return {
    async personsInGroup(group) {
      const out: PersonsInGroup = { persons: [], unminted: [] };
      const seen = new Set<string>();
      for (const { seam, ids } of stores((s) => !!s.directory.usersInGroup && readsStoreGroups(s))) await membersOf(seam, ids, group, out, seen);
      return out;
    },

    async admins(groups) {
      const out: PersonsInGroup = { persons: [], unminted: [] };
      const seen = new Set<string>();
      const asked = new Set<string>();
      for (const seam of seams.values()) {
        if (!seam.issuer.admin || !seam.directory.usersInGroup || !readsStoreGroups(seam)) continue;
        for (const group of groups ?? seam.issuer.adminGroups ?? ['admins']) {
          const key = `${seam.directory.storeKey}\u0000${group}`;
          if (asked.has(key)) continue;
          asked.add(key);
          await membersOf(seam, sameStore(seam).filter((id) => readsStoreGroups(seams.get(id))), group, out, seen);
        }
      }
      return out;
    },

    async personOf(entry) {
      if (!entry) return null;
      if (isPersonArn(entry)) return entry;
      const bar = entry.indexOf('|');
      if (bar > 0 && seams.has(entry.slice(0, bar))) return identities.resolve(entry.slice(0, bar), entry.slice(bar + 1));
      const self = [...seams.values()].find((s) => s.issuer.kind === 'cognito-pool' && s.issuer.id === 'deployment');
      return self ? personOfStoreSubject(sameStore(self), entry) : null;
    },

    async groupsFor(personArn) {
      const { trusted } = await subjectsWithSeams(personArn);
      const withGroups = trusted.filter((t) => t.seam.directory.groupsOf);
      if (!withGroups.length) return null;
      const groups = new Set<string>();
      for (const { seam, subject } of withGroups) for (const g of await seam.directory.groupsOf!(subject)) groups.add(g);
      return [...groups];
    },

    async clearedByGroups(personArn) {
      const { trusted } = await subjectsWithSeams(personArn);
      const withGroups = trusted.filter((t) => t.seam.directory.groupsOf);
      if (!withGroups.length) return null;
      const held = new Set<string>();
      for (const { seam, subject } of withGroups) {
        const named = profiles.clearancesForGroups(await seam.directory.groupsOf!(subject));
        for (const v of heldWithinIssuer(seam.issuer, named, profiles)) held.add(v);
      }
      return [...held];
    },

    async clearanceOf(personArn) {
      const { trusted } = await subjectsWithSeams(personArn);
      if (!trusted.length) return { state: 'none' };
      const held = new Set<string>();
      const groups = new Set<string>();
      const undetermined: string[] = [];
      const lastSignIn: ClearanceEvidence[] = [];
      let admin = false;
      for (const { seam, subject, decision } of trusted) {
        const answer = await seam.clearance.heldFor(subject);
        if (!answer) {
          undetermined.push(seam.issuer.id);
          const evidence = evidenceOf(seam.issuer, decision);
          if (evidence) lastSignIn.push(evidence);
          continue;
        }
        // WHAT THE ANSWER MEANS is the registry's, and each issuer's classifications bind its own part.
        const named = 'groups' in answer ? profiles.clearancesForGroups(answer.groups) : answer.classifications;
        for (const v of heldWithinIssuer(seam.issuer, named, profiles)) held.add(v);
        if ('groups' in answer) {
          for (const g of answer.groups) groups.add(g);
          const adminGroups = seam.issuer.adminGroups ?? ['admins'];
          if (seam.issuer.admin && answer.groups.some((g) => adminGroups.includes(g))) admin = true;
        }
      }
      if (undetermined.length) return { state: 'undetermined', issuers: undetermined, ...(lastSignIn.length ? { lastSignIn } : {}) };
      const list = [...held];
      const issuers = [...new Set(trusted.map((t) => t.seam.issuer.id))];
      const holder = profiles.holderOf(list);
      return { state: 'held', token: holder.token, adminPlane: holder.adminPlane, held: list, groups: [...groups], admin, issuers };
    },

    async accountState(issuer, subject) {
      const seam = seams.get(issuer);
      if (!seam || !subject) return 'gone';
      // A DIRECTORY THAT KEEPS NO ACCOUNT STATE (`claims`, `none`): the signed token, assertion or session
      // the caller presented is the issuer's answer, so there is nothing further to ask.
      if (!seam.directory.record) return 'active';
      const record = await seam.directory.record(subject);
      if (!record) return 'gone';
      return record.enabled ? 'active' : 'disabled';
    },

    async listGroups(prefix = '') {
      const out = new Set<string>();
      for (const { seam } of stores((s) => !!s.directory.listGroups)) for (const g of await seam.directory.listGroups!(prefix)) out.add(g);
      return [...out].sort();
    },

    async displayNameFor(personArn) {
      if (!isPersonArn(personArn)) return null;
      const hit = names.get(personArn);
      if (hit && hit.until > Date.now()) return hit.name;
      let name: string | null = null;
      try {
        const { trusted, any } = await subjectsWithSeams(personArn);
        for (const { seam, subject } of trusted) {
          if (!seam.directory.nameOf) continue;
          name = await seam.directory.nameOf(subject);
          if (name) break;
        }
        // THE APPINSTANCEUSER'S OWN NAME for a person no directory names: a display name the exchange
        // keeps current from the verified token's name claim, never an address (C5).
        if (!name && any) name = await appInstanceUserName(personArn);
      } catch (err) {
        console.warn('[directory] a display name could not be read; the person goes unnamed', {
          personId: personIdFromArn(personArn), err: (err as Error)?.name,
        });
        return null;
      }
      names.set(personArn, { name, until: Date.now() + NAME_TTL_MS });
      return name;
    },

    async contactFor(personArn, route) {
      if (route !== 'email') return null;
      try {
        for (const { seam, subject } of (await subjectsWithSeams(personArn)).trusted) {
          if (!seam.directory.contactOf) continue;
          const contact = await seam.directory.contactOf(subject, personArn);
          if (contact?.email) return { route, address: contact.email, name: contact.name };
        }
      } catch (err) {
        console.warn('[directory] a contact could not be read', {
          personId: personIdFromArn(personArn), err: (err as Error)?.name,
        });
      }
      return null;
    },

    async findByAddress(issuer, address) {
      const seam = seams.get(issuer);
      if (!seam?.directory.subjectsByAddress || !address) return null;
      const matches = await seam.directory.subjectsByAddress(address);
      if (matches.length !== 1 || !matches[0].subject) return null;
      return identities.resolve(issuer, matches[0].subject);
    },
  };
}

/**
 * The deployment's directory, built from the registry this function was handed (`TRUSTED_ISSUERS`) and
 * the factory selected for this container. Rebuilt when either changes.
 */
let defaultDir: { dir: Directory; issuers: readonly TrustedIssuer[]; seams: SeamFactory } | null = null;
let overridden: Directory | null = null;
export function defaultDirectory(): Directory {
  if (overridden) return overridden;
  const issuers = trustedIssuers();
  const seams = selectedSeams();
  if (defaultDir && defaultDir.issuers === issuers && defaultDir.seams === seams) return defaultDir.dir;
  defaultDir = { dir: createDirectory({ appInstanceArn: process.env.APP_INSTANCE_ARN || '', issuers, seams }), issuers, seams };
  return defaultDir.dir;
}

/**
 * WHETHER A PERSON MAY STILL SIGN IN, asked of their issuers now (SPEC-CREDENTIAL-EXCHANGE §4b, "An account
 * disabled at its issuer"). The person's active subjects come from `Identities` (`subjectsOfPerson`, the
 * `byPerson` index) and each is asked of its issuer (`Directory.accountState`); `Identities` keeps no copy
 * of what the issuer says.
 *
 *  - `active` when any subject asked is active at its issuer;
 *  - `disabled` when none is and an issuer holds one disabled;
 *  - `gone` when nobody signs in as the person, or every issuer asked holds no such account.
 *
 * `through` narrows the subjects asked to the issuers it admits (an admin vend asks only the issuers that
 * declare `admin: true`, whose sign-in is the one that holds a console). THROWS when `Identities` or an
 * issuer cannot be read, so a caller refuses on a failed read rather than admit or vend on one.
 */
export async function accountStateOfPerson(
  personArn: string,
  directory: Pick<Directory, 'accountState'>,
  opts: { through?: (issuer: string) => boolean; subjectsOf?: (personArn: string) => Promise<PersonSubject[]> } = {},
): Promise<AccountState> {
  const subjects = (await (opts.subjectsOf ?? ((arn: string) => subjectsOfPerson(arn, {})))(personArn))
    .filter((s) => !opts.through || opts.through(s.issuer));
  if (!subjects.length) return 'gone';
  const states = await Promise.all(subjects.map((s) => directory.accountState(s.issuer, s.subject)));
  if (states.includes('active')) return 'active';
  return states.includes('disabled') ? 'disabled' : 'gone';
}

/** Test seam: replace the deployment's directory. `null` restores it. */
export function __setDefaultDirectoryForTests(d: Directory | null): void {
  overridden = d;
  defaultDir = null;
}

/** The issuer an address is looked up among for a share: this deployment's own pool, when the registry trusts it. */
export function primaryIssuer(): string {
  return trustedIssuers().some((t) => t.id === 'deployment') ? 'deployment' : '';
}

// ── THE ALLOWED SET ──────────────────────────────────────────────────────────────────────────────

export interface AllowedSet {
  /** The people the source names AND the classification admits, as AppInstanceUser ARNs. */
  admitted: Set<string>;
  /** Named by the source and refused by the classification, as AppInstanceUser ARNs. Settled; never retried. */
  refused: string[];
  /** Named by the source and not decidable this pass. Left exactly as they are. */
  undetermined: Set<string>;
  /** Named by the source and never signed in, as subjects. Nobody to add yet; never refused. */
  unminted: string[];
  /**
   * Undetermined people whose last sign-in's recorded decision does not reach the classification
   * (`mismatch`) or is older than its issuer allows (`stale`). Reported, and still left as they are:
   * nothing is added or removed on a record.
   */
  flagged: Array<{ personArn: string; why: 'mismatch' | 'stale'; issuer: string; recorded: string }>;
}

/** Resolve a membership source to the people it admits at `classification`. */
export async function resolveAllowedSet(
  source: MembershipSource,
  classification: string,
  appInstanceArn: string,
  directory: Directory,
  /**
   * The conversation type the set is for, whose issuer list narrows it AFTER the clearance check (T1,
   * FR23): a candidate the classification admits but whose issuers the type does not list is refused,
   * a settled state like any other refusal. Absent: no narrowing.
   */
  typeKey?: string,
): Promise<AllowedSet> {
  const candidates = new Set<string>();
  const unminted: string[] = [];
  if (source.group) {
    const inGroup = await directory.personsInGroup(source.group);
    for (const arn of inGroup.persons) candidates.add(arn);
    unminted.push(...inGroup.unminted);
  }
  for (const entry of source.list ?? []) {
    if (!entry) continue;
    const arn = await directory.personOf(entry);
    if (arn) candidates.add(arn);
    else unminted.push(entry);
  }

  const admitted = new Set<string>();
  const refused: string[] = [];
  const undetermined = new Set<string>();
  const flagged: AllowedSet['flagged'] = [];
  for (const arn of candidates) {
    // A candidate from another app instance is nobody this conversation can hold.
    const id = personIdFromArn(arn);
    if (!id) continue;
    const member = userArnFor(appInstanceArn, id);
    let clearance: PersonClearance;
    try {
      clearance = await directory.clearanceOf(member);
    } catch (err) {
      console.warn('[membership-source] could not read a candidate\'s clearance; leaving them as they are', {
        message: (err as Error)?.message,
      });
      undetermined.add(member);
      continue;
    }
    if (clearance.state === 'undetermined') {
      undetermined.add(member);
      // EVIDENCE, NOT A CLEARANCE: a record is reported against the classification, and decides nothing.
      for (const e of clearance.lastSignIn ?? []) {
        if (e.stale) flagged.push({ personArn: member, why: 'stale', issuer: e.issuer, recorded: e.classification });
        else if (!profiles.reaches(e.classification, classification)) flagged.push({ personArn: member, why: 'mismatch', issuer: e.issuer, recorded: e.classification });
      }
      continue;
    }
    const reaches = clearance.state === 'held'
      && profiles.holderReaches({ token: clearance.token, adminPlane: clearance.adminPlane === true }, classification);
    // THE TYPE'S ISSUER NARROWING, after the clearance check and never in place of it. An answer that names
    // no issuers admits nobody a narrowing type lists.
    const issuers = clearance.state === 'held' ? clearance.issuers ?? [] : [];
    if (reaches && (!typeKey || typeAdmitsIssuers(typeKey, issuers))) admitted.add(member);
    else refused.push(member);
  }
  return { admitted, refused, undetermined, unminted, flagged };
}
