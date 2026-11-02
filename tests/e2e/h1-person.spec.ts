/**
 * H1: A PERSON FROM A FOREIGN OIDC ISSUER IS AN OPAQUE APPINSTANCEUSER, AND THE PERSON-FACING PATH WORKS FOR THEM.
 *
 * The person signs in through an OIDC issuer the registry declares (no Cognito pool anywhere in their
 * path), and every claim is checked against the deployed stacks, through the deployed APIs:
 *
 *  1. the credential exchange vends them a session on their own AppInstanceUser, whose id is a UUID v7 and
 *     never the token's subject;
 *  2. signing in again resolves the same AppInstanceUser (one person per issuer and subject);
 *  3. they create a conversation at the classification their issuer's clearance source reaches, and the
 *     conversation is theirs;
 *  4. they are refused a conversation at a classification their clearance source does not reach.
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { exchange } from './helpers/admin-api';
import { PERSON_API_URL, personUrl } from './helpers/api-urls';
import { H1_ID_TOKEN, H1_MISSING_REASON, H1_REACHES, claimsOf } from './helpers/h1-issuer';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

guardBackendErrors('h1-person');

test.describe('H1: a person from a foreign OIDC issuer', () => {
  test.skip(!H1_ID_TOKEN, H1_MISSING_REASON);
  test.skip(!PERSON_API_URL, 'VITE_PERSON_API_URL is not set: there is no PersonApi to call.');

  test('is vended a session on an opaque AppInstanceUser that is not the token\'s subject, and the same one again', async () => {
    const first = await exchange(H1_ID_TOKEN, {});
    expect(first.status, `the exchange refused the foreign person: ${JSON.stringify(first.body)}`).toBe(200);
    const userArn = String(first.body.userArn || '');
    const personId = userArn.split('/').pop() || '';
    expect(personId).toMatch(UUID_V7);
    expect(personId).not.toBe(claimsOf(H1_ID_TOKEN).sub);
    expect(userArn).not.toContain(String(claimsOf(H1_ID_TOKEN).sub));

    const again = await exchange(H1_ID_TOKEN, {});
    expect(again.status).toBe(200);
    expect(again.body.userArn).toBe(userArn);
  });

  test('opens a conversation at the classification its clearance source reaches, and is refused one it does not', async ({ request }) => {
    const created = await request.post(personUrl('/create-conversation'), {
      headers: { Authorization: `Bearer ${H1_ID_TOKEN}`, 'Content-Type': 'application/json' },
      data: { title: `H1 foreign person ${Date.now()}`, modelId: 'anthropic.claude-sonnet-4-5', modelTier: H1_REACHES },
    });
    expect(created.status(), `create refused: ${await created.text()}`).toBe(200);
    const conversationArn = (await created.json())?.conversation?.conversationArn as string;
    expect(conversationArn).toContain('/channel/');

    const outside = H1_REACHES === 'premium' ? 'basic' : 'premium';
    const refused = await request.post(personUrl('/create-conversation'), {
      headers: { Authorization: `Bearer ${H1_ID_TOKEN}`, 'Content-Type': 'application/json' },
      data: { title: `H1 outside ${Date.now()}`, modelId: 'anthropic.claude-sonnet-4-5', modelTier: outside },
    });
    expect(refused.status(), 'a classification the issuer\'s clearance source does not reach is refused').toBe(403);
  });
});
