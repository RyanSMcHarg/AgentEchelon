/**
 * Building a `Directory` in a test, the way a deployment does: from registry entries and the seams the
 * factory chooses for each (`lambda/src/lib/issuer-seams.ts`), with the pools and `Identities` faked at
 * their edges.
 */
import { createDirectory, type Directory } from '../../lambda/src/lib/membership-source';
import { cognitoPoolDirectory } from '../../lambda/src/lib/cognito-pool-directory';
import { CognitoClearanceSource, type ClearanceSource } from '../../lambda/src/lib/clearance-source';
import { clearanceSourceFor, cognitoAdapter, noDirectory, type IssuerSeam } from '../../lambda/src/lib/issuer-seams';
import type { TrustedIssuer } from '../../lib/config/issuers';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import type { PersonSubject } from '../../lambda/src/lib/person-identity';

type Sender = { send(command: unknown): Promise<any> };

/** A registry entry for a Cognito pool, with its pool's groups as clearances by default. */
export function poolIssuer(id: string, pool: string, extra: Partial<TrustedIssuer> = {}): TrustedIssuer {
  return {
    id,
    kind: 'cognito-pool',
    pool,
    iss: `https://cognito-idp.us-east-1.amazonaws.com/${pool}`,
    subject: ['sub'],
    clearance: { groups: true, classifications: profiles.classificationValues() },
    admin: id === 'deployment',
    groupsClaim: 'cognito:groups',
    directory: 'cognito',
    ...extra,
  };
}

/** A registry entry for an OIDC issuer with no directory, reaching `fixed` within its classifications. */
export function oidcIssuer(id: string, clearance: TrustedIssuer['clearance'], extra: Partial<TrustedIssuer> = {}): TrustedIssuer {
  return {
    id, kind: 'oidc', iss: `https://${id}.example`, subject: ['sub'], clearance, admin: false, groupsClaim: 'groups', directory: 'none', ...extra,
  };
}

export interface TestDirectoryOptions {
  appInstanceArn: string;
  /** Each entry, with the pool client its cognito adapter is read through (when it is a pool). */
  issuers: Array<{ issuer: TrustedIssuer; client?: Sender; groups?: ClearanceSource }>;
  identities: {
    resolve: (issuer: string, subject: string) => Promise<string | null>;
    subjectsOf: (personArn: string) => Promise<PersonSubject[]>;
  };
  appInstanceUserName?: (personArn: string) => Promise<string | null>;
}

/** A directory over the given entries, each through the adapter the deployed factory would choose. */
export function testDirectory(o: TestDirectoryOptions): Directory {
  const byId = new Map(o.issuers.map((e) => [e.issuer.id, e]));
  return createDirectory({
    appInstanceArn: o.appInstanceArn,
    issuers: o.issuers.map((e) => e.issuer),
    seams: (issuer): IssuerSeam => {
      const e = byId.get(issuer.id)!;
      const directory = issuer.directory === 'cognito' && issuer.pool && e.client
        ? cognitoAdapter(issuer.id, cognitoPoolDirectory(issuer.pool, e.client), e.groups ?? new CognitoClearanceSource(e.client as never, issuer.pool))
        : noDirectory(issuer.id);
      return { issuer, directory, clearance: clearanceSourceFor(issuer, directory) };
    },
    identities: o.identities,
    appInstanceUserName: o.appInstanceUserName ?? (async () => null),
  });
}

/** A directory answering nothing, with the methods a test names replaced. Every account it is asked about is active. */
export function stubDirectory(overrides: Partial<Directory> = {}): Directory {
  return {
    personsInGroup: async () => ({ persons: [], unminted: [] }),
    admins: async () => ({ persons: [], unminted: [] }),
    personOf: async () => null,
    groupsFor: async () => null,
    clearedByGroups: async () => null,
    clearanceOf: async () => ({ state: 'none' }),
    listGroups: async () => [],
    displayNameFor: async () => null,
    contactFor: async () => null,
    findByAddress: async () => null,
    accountState: async () => 'active',
    ...overrides,
  };
}
