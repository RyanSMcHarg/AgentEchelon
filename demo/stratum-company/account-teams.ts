/**
 * STRATUM'S ACCOUNT TEAMS: the people the customer accounts record names as each account's CSM, as demo identities.
 *
 * The record (`context/premium/customer-accounts.json`) names each account's CSM by name (`csm`) and by a key into this
 * list (`csmKey`). `seed-demo` creates each person here (premium-cleared, in the `account-management` group, never `ops`),
 * signs them in through the credential exchange, which names their AppInstanceUser, and uploads the record with that
 * person id written beside the key (`csmPerson`). So an assistant that proposes an account's team for a meeting names
 * the person by the id the record carries, and nothing resolves a person from a name (SPEC-ASSISTANT-MEETINGS FR42).
 *
 * Its own module, as `personas.ts` is, so a test reads it without running the seeder.
 */
export interface AccountTeamPerson {
  /** The key the record's `csmKey` names. */
  key: string;
  /** Their display name, as the record's `csm` gives it. */
  name: string;
  /** The local part of their demo address, on the demo users' domain. */
  local: string;
  /** The account team's lead, the one member of `account-team-lead`, who approves an incident's customer notices. */
  lead?: true;
}

/** The membership group the account teams are in: premium-cleared, and not an ops role, so they join an ops meeting muted. */
export const ACCOUNT_TEAM_GROUP = 'account-management';
/** The group whose one member leads the account team (the `customer-messaging` type's `lead:accounts`). */
export const ACCOUNT_LEAD_GROUP = 'account-team-lead';

export const ACCOUNT_TEAM: readonly AccountTeamPerson[] = [
  { key: 'maria-santos', name: 'Maria Santos', local: 'csm-maria', lead: true },
  { key: 'chris-thompson', name: 'Chris Thompson', local: 'csm-chris' },
  { key: 'nicole-park', name: 'Nicole Park', local: 'csm-nicole' },
];

/** The record's file, under `context/premium/`. */
export const ACCOUNTS_RECORD = 'customer-accounts.json';

/**
 * THE RECORD AS IT IS UPLOADED: each account whose `csmKey` names a person the seed created carries that person's
 * AppInstanceUser ARN as `csmPerson`. An account whose key names nobody here, or whose person was not named, keeps no
 * `csmPerson`, so it is never proposed for a meeting.
 */
export function withAccountTeamPeople(recordJson: string, personByKey: Readonly<Record<string, string>>): string {
  const record = JSON.parse(recordJson) as { topAccountsByARR?: Array<Record<string, unknown>> };
  for (const account of record.topAccountsByARR ?? []) {
    const person = typeof account.csmKey === 'string' ? personByKey[account.csmKey] : undefined;
    if (person) account.csmPerson = person;
    else delete account.csmPerson;
  }
  return `${JSON.stringify(record, null, 2)}\n`;
}
