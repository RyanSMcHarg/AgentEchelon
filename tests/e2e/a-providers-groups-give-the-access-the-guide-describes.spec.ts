/**
 * A PROVIDER'S GROUPS GIVE EXACTLY THE ACCESS THE IDENTITY-PROVIDER GUIDE DESCRIBES.
 *
 * docs/guides/user/IDENTITY-PROVIDER-GUIDE.md, "Groups from your provider", has a deployer verify an
 * organization's OIDC provider directly and translate its groups into AgentEchelon groups. Each test here
 * is one of that section's steps or claims, run against the deployed stacks through the deployed APIs, with
 * the fixture provider (`helpers/idp-fixture.ts`) playing the organization's:
 *
 *  - step 4 (sign in): a person in the provider group mapped to `standard` is vended a session and opens a
 *    `standard` conversation, and is refused a `premium` one (the map does not reach it);
 *  - step 5 (admins): a person in the provider group mapped to `admins` gets a console session;
 *  - "what an unmapped group reaches": a person in the provider's own group named `admins`, which the map
 *    leaves out, is vended nothing and gets no console session;
 *  - "removing someone": a person removed from their only mapped group is vended nothing at their next sign-in.
 *
 * SPEC-CREDENTIAL-EXCHANGE §4b ("A person's groups") is the design. Two of these tests are refusals, which the
 * exchange logs as security events by design; the backend-error guard reads the turn path's log groups, not
 * the exchange's, and each test asserts its refusal itself.
 */
import { test, expect } from './helpers/fixtures';
import { consoleSession, exchange } from './helpers/admin-api';
import { ADMIN_API_URL, PERSON_API_URL, adminUrl, personUrl } from './helpers/api-urls';
import { IDP_MISSING_REASON, PROVIDER_GROUPS, UNMAPPED_ADMINS_GROUP, idpFixture, providerPerson, removeProviderPeople } from './helpers/idp-fixture';
import { guardBackendErrors } from './helpers/turn-guards';

const fixture = idpFixture();

test.describe('a provider\'s groups, translated into AgentEchelon groups', () => {
  guardBackendErrors('a-providers-groups-give-the-access-the-guide-describes');
  test.skip(!fixture, IDP_MISSING_REASON);
  test.skip(!PERSON_API_URL, 'VITE_PERSON_API_URL is not set: there is no PersonApi to call.');
  test.afterAll(() => removeProviderPeople());

  const create = (request: import('@playwright/test').APIRequestContext, token: string, classification: string) =>
    request.post(personUrl('/create-conversation'), {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // `modelId` is required beside the classification (MISSING_REQUIRED_FIELDS, create-conversation.ts).
      data: { title: `IdP groups ${classification} ${Date.now()}`, modelId: 'anthropic.claude-sonnet-4-5', modelTier: classification },
    });

  test('step 4: a person in the group mapped to standard opens a standard conversation, and nothing the map does not reach', async ({ request }) => {
    const person = providerPerson(fixture!, 'standard', [PROVIDER_GROUPS.standard]);
    const token = person.signIn();
    const vended = await exchange(token, {});
    expect(vended.status, `the exchange refused a mapped provider group: ${JSON.stringify(vended.body)}`).toBe(200);

    const inside = await create(request, token, 'standard');
    expect(inside.status(), `create refused: ${await inside.text()}`).toBe(200);
    const outside = await create(request, token, 'premium');
    expect(outside.status(), 'a classification the mapped group does not reach is refused').toBe(403);
  });

  test('step 5: a person in the group mapped to admins gets a console session', async () => {
    test.skip(!ADMIN_API_URL, 'VITE_ADMIN_API_URL is not set: the deployment declares no admin capability.');
    const person = providerPerson(fixture!, 'admin', [PROVIDER_GROUPS.admins]);
    const session = await consoleSession(person.signIn());
    expect(session.status, `no console session for a provider group mapped to admins: ${JSON.stringify(session.body)}`).toBe(200);
  });

  test('an unmapped provider group named admins reaches nothing: no session, no console', async () => {
    const outsider = providerPerson(fixture!, 'unmapped-admins', [UNMAPPED_ADMINS_GROUP]);
    const token = outsider.signIn();
    const vended = await exchange(token, {});
    expect(vended.status, 'a provider group the map leaves out is vended nothing').toBe(403);
    if (ADMIN_API_URL) {
      // ASKED OF THE ADMIN EXCHANGE ITSELF: `consoleSession` stops at the person exchange's refusal, which would
      // prove nothing here. The role check runs before the person is resolved, so the refusal names it.
      const resp = await fetch(adminUrl('admin-exchange', '/exchange-credentials'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: 'console' }),
      });
      expect(resp.status, 'and gets no console session').toBe(403);
      expect((await resp.json()).code).toBe('NO_ADMIN_CAPABILITY');
    }
  });

  test('removing someone from their only mapped group: their next sign-in is vended nothing', async () => {
    const person = providerPerson(fixture!, 'leaver', [PROVIDER_GROUPS.standard]);
    expect((await exchange(person.signIn(), {})).status).toBe(200);
    person.leave(PROVIDER_GROUPS.standard);
    const after = await exchange(person.signIn(), {});
    expect(after.status, 'a person in no mapped group is vended nothing at their next sign-in').toBe(403);
  });
});
