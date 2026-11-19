/**
 * A NON-MEMBER IS REFUSED A FILE (DESIGN-RELEASE-EVIDENCE section 5, the release smoke item `non-member-file`).
 *
 * In one premium conversation, through `POST /presigned-url` on the person API (the route the chat app signs files
 * on), with each person's own token:
 *  - the owner, a member, is signed an upload, a download of that upload, and a download of a conversation document;
 *  - a premium person who is not a member is refused an upload and the conversation document;
 *  - a basic person, whose clearance does not reach a premium conversation, is refused both.
 *
 * The owner is signed first, so a refusal cannot be a route that refuses everyone. The conversation check reads
 * membership before clearance, so a person who is neither a member nor cleared is answered `NOT_A_MEMBER`; a member
 * whose clearance no longer reaches the conversation (`NOT_CLEARED`) is held by the revocation-windows spec.
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getSecondPremiumUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { PERSON_API_URL } from './helpers/api-urls';
import { idTokenFor } from './helpers/person';
import { archive, openConversation, signDownload, signUpload } from './helpers/person-session';

const REFUSED = ['NOT_A_MEMBER', 'NOT_CLEARED'];

test.describe('a file in a conversation', () => {
  guardBackendErrors('a-non-member-is-refused-a-file');
  test.skip(!PERSON_API_URL, 'VITE_PERSON_API_URL is required');
  test.skip(!hasTestCredentials(), 'needs the provisioned test users');

  test('is signed for a member and refused to a non-member and to a person not cleared for it', async () => {
    test.setTimeout(180_000);
    const creds = await getTestCredentials();
    const outsider = await getSecondPremiumUser();
    test.skip(!creds.premiumUser?.password, missingUserReason('premiumUser'));
    test.skip(!outsider?.password, missingUserReason('secondPremiumUser'));
    test.skip(!creds.basicUser?.password, missingUserReason('basicUser'));

    const clientId = creds.cognitoClientId;
    const ownerToken = idTokenFor(creds.premiumUser.email, creds.premiumUser.password, clientId);
    const outsiderToken = idTokenFor(outsider!.email, outsider!.password, clientId);
    const basicToken = idTokenFor(creds.basicUser.email, creds.basicUser.password, clientId);
    const { channelArn, conversationId } = await openConversation(ownerToken, `Non-member file ${Date.now()}`);

    try {
      // THE MEMBER IS SIGNED, so the refusals below are the route refusing these people, not refusing everyone.
      const upload = await signUpload(ownerToken, conversationId);
      expect(upload.status, `the owner is signed an upload: ${JSON.stringify(upload.body).slice(0, 300)}`).toBe(200);
      const fileKey = String(upload.body?.fileKey || '');
      expect(fileKey, 'the upload signature names its file').toBeTruthy();
      expect((await signDownload(ownerToken, conversationId, fileKey)).status, 'the owner is signed a download of their upload').toBe(200);
      // A conversation-owned key (an assistant's delivered document) passes the key-shape check for anyone naming the
      // conversation, so a refusal on it is the conversation check's. The signature does not need the object to exist.
      const conversationKey = `generated-docs/${conversationId}/release-smoke.md`;
      expect((await signDownload(ownerToken, conversationId, conversationKey)).status, 'the owner is signed a download of a conversation document').toBe(200);

      for (const [who, token] of [['a premium non-member', outsiderToken], ['a basic person', basicToken]] as const) {
        const up = await signUpload(token, conversationId);
        expect(up.status, `${who} is refused an upload signature`).toBe(403);
        expect(REFUSED, `${who}: refused for access (${up.body?.code})`).toContain(up.body?.code);
        const down = await signDownload(token, conversationId, conversationKey);
        expect(down.status, `${who} is refused a download signature`).toBe(403);
        expect(REFUSED, `${who}: refused for access (${down.body?.code})`).toContain(down.body?.code);
      }
    } finally {
      await archive(ownerToken, channelArn).catch(() => undefined);
    }
  });
});
