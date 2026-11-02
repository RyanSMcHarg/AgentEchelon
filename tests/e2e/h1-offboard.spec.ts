/**
 * H1: THE CONTACT COPY KEPT FOR A PERSON OF A CLAIMS-ONLY ISSUER IS ERASED WHEN THE PERSON IS OFFBOARDED.
 *
 * An OIDC issuer with no directory of its own declares `directory: 'claims'`, and the credential exchange
 * keeps the contact claims of the person's last sign-in, encrypted, in the user-profile table under
 * `<personId>#contact#<issuerId>`. Against the deployed stacks:
 *
 *  1. after the person signs in, the copy exists and holds no address in the clear;
 *  2. an administrator offboards the person through the signed console route;
 *  3. no copy for the person remains, and their next sign-in is refused.
 *
 * This spec offboards the person it signs in. Run it with a token for a person minted for it.
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { consoleSession, exchange, signedCall } from './helpers/admin-api';
import { ADMIN_API_URL, PERSON_API_URL, adminUrl } from './helpers/api-urls';
import { H1_ID_TOKEN, H1_ISSUER_ID, H1_MISSING_REASON, claimsOf } from './helpers/h1-issuer';
import { aws, awsOrNull } from './helpers/aws';
import { stackName } from './helpers/stack-prefix';
import { getAdminUser, getTestCredentials, missingUserReason } from './helpers/test-credentials';
import { idTokenFor } from './helpers/person';

function profileTable(): string {
  const outputs: Array<{ OutputKey: string; OutputValue: string }> =
    aws(`cloudformation describe-stacks --stack-name ${stackName('Conversations')}`)?.Stacks?.[0]?.Outputs ?? [];
  const name = outputs.find((o) => o.OutputKey === 'UserProfileTableName')?.OutputValue;
  expect(name, 'the Conversations stack names its user-profile table').toBeTruthy();
  return name!;
}

const copyOf = (table: string, personId: string) => awsOrNull(
  `dynamodb get-item --table-name ${table} --consistent-read --key "{\\"personId\\":{\\"S\\":\\"${personId}#contact#${H1_ISSUER_ID}\\"}}"`,
)?.Item ?? null;

guardBackendErrors('h1-offboard');

test.describe('H1: the claims copy is erased with the person', () => {
  test.skip(!H1_ID_TOKEN, H1_MISSING_REASON);
  test.skip(!PERSON_API_URL || !ADMIN_API_URL, 'VITE_PERSON_API_URL and VITE_ADMIN_API_URL are both needed to sign in and offboard.');

  test('a contact copy written at sign-in is gone after the person is offboarded', async () => {
    const signedIn = await exchange(H1_ID_TOKEN, {});
    expect(signedIn.status, `the exchange refused the foreign person: ${JSON.stringify(signedIn.body)}`).toBe(200);
    const personArn = String(signedIn.body.userArn);
    const personId = personArn.split('/').pop()!;

    const table = profileTable();
    const copy = copyOf(table, personId);
    expect(copy, 'the exchange keeps the contact claims of this sign-in').toBeTruthy();
    const email = String(claimsOf(H1_ID_TOKEN).email || '');
    if (email) expect(JSON.stringify(copy)).not.toContain(email);

    let admin;
    try { admin = await getAdminUser(); } catch { test.skip(true, missingUserReason('testAdmin')); return; }
    const adminToken = idTokenFor(admin.email, admin.password, (await getTestCredentials()).cognitoClientId);
    const session = await consoleSession(adminToken);
    expect(session.status, 'the administrator gets a console session').toBe(200);
    const res = await signedCall(adminUrl('user-management', '/users/delete'), session.body.credentials, 'POST', {
      personArn, reason: 'e2e: H1 claims copy erasure',
    });
    expect(res.status, `offboarding refused: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body?.removed?.contactCopies).toBe(1);

    expect(copyOf(table, personId), 'no contact copy remains for the offboarded person').toBeNull();
    const after = await exchange(H1_ID_TOKEN, {});
    expect(after.status, 'the offboarded person is refused at their next sign-in').toBe(403);
  });
});
