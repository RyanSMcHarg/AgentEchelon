/**
 * THE AMAZON COGNITO USER POOL ADAPTER: the bytes a pool holds about its own subjects.
 *
 * An adapter answers questions about ONE issuer, in that issuer's own terms: which subjects are in a
 * group, what a subject's record says, which subjects carry an address. It never resolves identity. Who
 * a subject IS (their AppInstanceUser) is the core's question, answered through `Identities`
 * (`lib/person-identity.ts`), and `Directory` (`lib/membership-source.ts`) is where the two meet.
 *
 * The groups a subject holds are asked of the clearance seam (`lib/clearance-source.ts`), not here, so
 * the one provider-specific step of a clearance decision stays where its guard looks for it.
 *
 * `backend/test/lib/clearance-has-one-provider-seam.test.ts` refuses a pool read anywhere in
 * `backend/lambda` but this file, the clearance adapter and the post-confirmation trigger.
 */
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  GetGroupCommand,
  ListGroupsCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type AttributeType,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { issuerIdForPool, issuerIdsForPool } from './trusted-issuers.js';

type Sender = { send(command: unknown): Promise<any> };

/** The issuer a pool's tokens carry as `iss`. A pool id carries its region before the `_`. */
export function poolIssuer(poolId: string): string {
  return poolId ? `https://cognito-idp.${poolId.split('_')[0]}.amazonaws.com/${poolId}` : '';
}

/** The pool a Cognito issuer names, or null for any other issuer. */
export function poolIdFromIssuer(iss?: string | null): string | null {
  if (!iss) return null;
  const m = /cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/([A-Za-z0-9_-]+)\/?$/.exec(iss);
  return m ? m[1] : null;
}

/** What a pool's record says about one subject. Display attributes and state, never an identity. */
export interface PoolRecord {
  /** The subject a token from this pool carries as `sub`: the key `Identities` rows are written under. */
  subject: string;
  /** The pool's own username, for the console that administers the pool. */
  username: string;
  enabled: boolean;
  email: string | null;
  /** `name`, else given and family name joined. Null when the record names nobody. */
  name: string | null;
  attributes: Record<string, string>;
  status?: string;
  createdAt?: string;
}

function attributesOf(list: AttributeType[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of list || []) if (a.Name && a.Value !== undefined) out[a.Name] = a.Value;
  return out;
}

function recordOf(username: string, attrs: Record<string, string>, extra: Partial<PoolRecord> = {}): PoolRecord {
  const name = (attrs.name || '').trim()
    || [attrs.given_name, attrs.family_name].filter(Boolean).join(' ').trim()
    || null;
  return {
    subject: attrs.sub || username,
    username,
    enabled: extra.enabled ?? true,
    email: attrs.email || null,
    name,
    attributes: attrs,
    ...(extra.status ? { status: extra.status } : {}),
    ...(extra.createdAt ? { createdAt: extra.createdAt } : {}),
  };
}

function fromUser(u: UserType): PoolRecord {
  return recordOf(u.Username || '', attributesOf(u.Attributes), {
    enabled: u.Enabled !== false,
    status: u.UserStatus,
    createdAt: u.UserCreateDate?.toISOString(),
  });
}

/** An address the pool's filter grammar can carry safely: no quote, backslash, control or space. */
const SAFE_FILTER_VALUE = /^[^\s"\\\x00-\x1f]{1,254}$/;

const isUserNotFound = (err: unknown): boolean => (err as { name?: string } | null)?.name === 'UserNotFoundException';

/**
 * THE POOL USERNAME A SUBJECT IS ADDRESSED BY, or null when the pool holds no user with that `sub`.
 *
 * Every Cognito Admin call takes a `Username`, and Cognito accepts a `sub` there for a LOCAL user only
 * ("must be the sub of a local user or the username of a user from a third-party IdP",
 * AdminListGroupsForUser). A person who signed in through a provider on the pool (`cognito-federated`)
 * is addressed by the username the provider sign-in created (`<providerName>_<id>`), found here by
 * `ListUsers` on the `sub` attribute.
 */
export async function usernameOfSubject(client: Sender, poolId: string, subject: string): Promise<string | null> {
  if (!SAFE_FILTER_VALUE.test(subject)) return null;
  const res = await client.send(new ListUsersCommand({ UserPoolId: poolId, Filter: `sub = "${subject}"`, Limit: 1 }));
  return res.Users?.[0]?.Username || null;
}

/**
 * An Admin call addressed by a subject or a username. When the pool does not know the name, it is looked
 * up as a federated person's `sub` and the call is made once more by their pool username; when no user
 * has that `sub` either, the first `UserNotFoundException` is thrown. A failed lookup throws, so a caller
 * never reads "no account" from a pool it could not ask (SPEC-CREDENTIAL-EXCHANGE §4b).
 */
export async function bySubjectOrUsername<T>(client: Sender, poolId: string, subjectOrUsername: string, call: (username: string) => Promise<T>): Promise<T> {
  // A FEDERATED PERSON RESOLVED ONCE IS ASKED FOR BY USERNAME AFTER: otherwise every read of them costs a
  // refused call, a ListUsers (whose quota is low) and the call again, and a sweep or an audit over many
  // federated people is throttled. A cached name that no longer exists falls through to the full path.
  const cacheKey = `${poolId}|${subjectOrUsername}`;
  const known = federatedUsernames.get(cacheKey);
  if (known) {
    try {
      return await call(known);
    } catch (err) {
      if (!isUserNotFound(err)) throw err;
      federatedUsernames.delete(cacheKey);
    }
  }
  try {
    return await call(subjectOrUsername);
  } catch (err) {
    if (!isUserNotFound(err)) throw err;
    const username = await usernameOfSubject(client, poolId, subjectOrUsername);
    if (!username || username === subjectOrUsername) throw err;
    if (federatedUsernames.size >= FEDERATED_USERNAME_CACHE_MAX) federatedUsernames.clear();
    federatedUsernames.set(cacheKey, username);
    return call(username);
  }
}

/** A federated person's pool username by pool and `sub`, for this container. A pool username never changes. */
const federatedUsernames = new Map<string, string>();
const FEDERATED_USERNAME_CACHE_MAX = 10_000;

/** Forget every resolved name. For tests. */
export function __clearFederatedUsernamesForTests(): void {
  federatedUsernames.clear();
}

export interface CognitoPoolDirectory {
  readonly poolId: string;
  /**
   * The pool's REGISTRY id (`lib/config/issuers.ts`): the issuer half of every `Identities` key its
   * subjects sign in under. A pool the registry does not trust has no id, and answers its `iss` URL
   * instead, under which no row is ever written, so its subjects resolve to nobody.
   */
  readonly issuer: string;
  /**
   * Every registry id whose people are accounts in this pool: `issuer` first, then each
   * `cognito-federated` entry on the pool. A federated person's `Identities` row is keyed under their own
   * entry's id, so "this pool's people" is every id here. Empty when the registry does not trust the pool.
   */
  readonly issuers: string[];
  /** Every member of a group, enabled or not. Throws when the group cannot be listed. */
  usersInGroup(group: string): Promise<PoolRecord[]>;
  /** One subject's record, or null when the pool has no such user. Throws on any other failure. */
  record(subjectOrUsername: string): Promise<PoolRecord | null>;
  /** The subjects whose verified-or-not `email` attribute is exactly `address`. */
  byEmail(address: string): Promise<PoolRecord[]>;
  /** The subject a username names, or null. */
  byUsername(username: string): Promise<PoolRecord | null>;
  /** One page of the pool's users, for the console that administers it. */
  listPage(paginationToken?: string): Promise<{ users: PoolRecord[]; next?: string }>;
  /** The pool's group names that start with `prefix`. */
  groupNames(prefix?: string): Promise<string[]>;
  /** Whether the group exists. */
  groupExists(group: string): Promise<boolean>;
}

const clients = new Map<string, Sender>();
function defaultClient(): Sender {
  const key = 'default';
  let c = clients.get(key);
  if (!c) {
    // THE FUNCTION'S OWN ROLE, never a turn's assistant session: a pool read is the platform asking its
    // directory, and the role is what holds the pool grant.
    c = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-east-1', requestHandler: BOUNDED_REQUEST_HANDLER });
    clients.set(key, c);
  }
  return c;
}

export function cognitoPoolDirectory(poolId: string, client?: Sender): CognitoPoolDirectory {
  const cognito = (): Sender => client ?? defaultClient();
  return {
    poolId,
    get issuer() { return issuerIdForPool(poolId) ?? poolIssuer(poolId); },
    get issuers() { return issuerIdsForPool(poolId); },
    async usersInGroup(group) {
      const out: PoolRecord[] = [];
      let NextToken: string | undefined;
      do {
        const res = await cognito().send(new ListUsersInGroupCommand({ UserPoolId: poolId, GroupName: group, NextToken }));
        for (const u of res.Users || []) out.push(fromUser(u));
        NextToken = res.NextToken;
      } while (NextToken);
      return out;
    },
    async record(subject) {
      try {
        const u = await bySubjectOrUsername(cognito(), poolId, subject,
          (Username) => cognito().send(new AdminGetUserCommand({ UserPoolId: poolId, Username })));
        return recordOf(u.Username || subject, attributesOf(u.UserAttributes), {
          enabled: u.Enabled !== false,
          status: u.UserStatus,
          createdAt: u.UserCreateDate?.toISOString?.(),
        });
      } catch (err) {
        if (isUserNotFound(err)) return null;
        throw err;
      }
    },
    async byEmail(address) {
      if (!SAFE_FILTER_VALUE.test(address)) return [];
      const res = await cognito().send(new ListUsersCommand({ UserPoolId: poolId, Filter: `email = "${address}"`, Limit: 2 }));
      return (res.Users || []).map(fromUser);
    },
    async byUsername(username) {
      if (!SAFE_FILTER_VALUE.test(username)) return null;
      const res = await cognito().send(new ListUsersCommand({ UserPoolId: poolId, Filter: `username = "${username}"`, Limit: 1 }));
      const u = res.Users?.[0];
      return u ? fromUser(u) : null;
    },
    async listPage(paginationToken) {
      const res = await cognito().send(new ListUsersCommand({ UserPoolId: poolId, Limit: 60, PaginationToken: paginationToken }));
      return { users: (res.Users || []).map(fromUser), ...(res.PaginationToken ? { next: res.PaginationToken } : {}) };
    },
    async groupNames(prefix = '') {
      const out: string[] = [];
      let NextToken: string | undefined;
      do {
        const page = await cognito().send(new ListGroupsCommand({ UserPoolId: poolId, Limit: 60, NextToken }));
        for (const g of page.Groups || []) if (g.GroupName && g.GroupName.startsWith(prefix)) out.push(g.GroupName);
        NextToken = page.NextToken;
      } while (NextToken);
      return out;
    },
    async groupExists(group) {
      try {
        await cognito().send(new GetGroupCommand({ UserPoolId: poolId, GroupName: group }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'ResourceNotFoundException') return false;
        throw err;
      }
    },
  };
}
