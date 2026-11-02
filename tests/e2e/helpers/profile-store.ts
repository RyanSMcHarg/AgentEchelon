/**
 * THE USER-PROFILE STORE AS A TEST READS AND RESETS IT: one row per person, keyed by `personId`.
 *
 * The key is the person id the credential exchange minted (`helpers/person.ts`), never a Cognito sub,
 * so a row written under a sub is one the router never reads. Every spec that resets, reads or
 * pre-onboards a profile goes through here, so the key and the table resolve one way.
 */
import { SSM_ROOT } from './stack-prefix';
import { personArnForEmail, personIdOf } from './person';
import { awsvText as aws } from './aws';

let cachedTable = '';
/** The profile table's name, from SSM. Throws when this deployment publishes none. */
export function profileTable(): string {
  if (cachedTable) return cachedTable;
  const name = aws(['ssm', 'get-parameter', '--name', `${SSM_ROOT}/shared/tables/user-profile-name`,
    '--query', 'Parameter.Value', '--output', 'text']);
  if (!name || name === 'None') throw new Error('this deployment publishes no user-profile table');
  cachedTable = name;
  return name;
}

/** The profile key for a test user, by email. Throws when the test secret carries no such user. */
export async function profileKeyFor(email: string): Promise<{ personId: { S: string } }> {
  const arn = await personArnForEmail(email);
  const personId = arn ? personIdOf(arn) : '';
  if (!personId) throw new Error(`${email} is not a test user in the test secret`);
  return { personId: { S: personId } };
}

/** The stored profile row for a test user, as DynamoDB returns it, or null when there is none. */
export async function readProfileItem(email: string): Promise<Record<string, any> | null> {
  const raw = aws(['dynamodb', 'get-item', '--table-name', profileTable(),
    '--key', JSON.stringify(await profileKeyFor(email)), '--output', 'json']);
  return (raw ? JSON.parse(raw)?.Item : undefined) ?? null;
}

/** Delete a test user's profile row, so a spec starts from a person who was never onboarded. */
export async function deleteProfile(email: string): Promise<void> {
  aws(['dynamodb', 'delete-item', '--table-name', profileTable(), '--key', JSON.stringify(await profileKeyFor(email))]);
}

/**
 * Mark a test user onboarded, keeping a real `onboardedAt` and any collected facts. Returns false when
 * the store cannot be reached, so a caller can say so instead of guessing.
 */
export async function ensureOnboarded(email: string): Promise<boolean> {
  try {
    const key = JSON.stringify(await profileKeyFor(email));
    aws(['dynamodb', 'update-item', '--table-name', profileTable(), '--key', key,
      '--update-expression', 'SET onboardedAt = if_not_exists(onboardedAt, :now), updatedAt = :now',
      '--expression-attribute-values', JSON.stringify({ ':now': { S: new Date().toISOString() } })]);
    return Boolean((await readProfileItem(email))?.onboardedAt?.S);
  } catch {
    return false;
  }
}
