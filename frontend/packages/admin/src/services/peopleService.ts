/**
 * THE CONSOLE'S PEOPLE, from `GET /users` (user-management.ts).
 *
 * A person is an AppInstanceUser that somebody signs in as, whichever issuer that is, named by
 * `personArn`; offboarding takes it. A pool account that has never signed in has no AppInstanceUser
 * yet, so its `personArn` is null and only the pool's administration applies to it. `displayName` is
 * present only for a caller who may be told who a person is (`see-user-identity`).
 */
import { adminRequest } from './sigv4Fetch';
import { adminApiConfigured, adminUrl } from './adminApi';

export interface PersonEntry {
  personArn: string | null;
  personId: string | null;
  displayName: string | null;
  /** `pool`: this deployment's pool holds an account for them. `other`: they sign in through another issuer only. */
  account: 'pool' | 'other';
  username: string | null;
  email: string;
  tier: string;
  approved: string;
  status: string;
  /** Whether their issuer lets them sign in, read from the issuer's own record when the list is fetched. */
  enabled: boolean;
  createdAt: string;
  membershipGroups?: string[];
  /** The console teams the person is in, by team name. */
  teams?: string[];
  /** The registry ids of the issuers they sign in through (E6). */
  issuers?: string[];
  /** An unbound visitor: they sign in through the guest issuer alone. Hidden by default. */
  guest?: boolean;
}

export interface PeopleList {
  users: PersonEntry[];
  membershipGroups: Array<{ name: string; requires: string }>;
}

/** The people list route on `AdminApi`, or '' when the admin API is unconfigured. */
export function userManagementUrl(): string {
  return adminApiConfigured() ? adminUrl('user-management', '/users') : '';
}

export async function listPeople(): Promise<PeopleList> {
  const data = await adminRequest<Partial<PeopleList>>('GET', userManagementUrl());
  return {
    users: Array.isArray(data?.users) ? data.users : [],
    membershipGroups: Array.isArray(data?.membershipGroups) ? data.membershipGroups : [],
  };
}

/** Each person's display name by AppInstanceUser id, for a surface that holds only the id. */
export function namesByPersonId(people: PersonEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of people) if (p.personId && p.displayName) out.set(p.personId, p.displayName);
  return out;
}
