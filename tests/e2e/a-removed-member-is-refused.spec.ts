/**
 * A REMOVED MEMBER IS REFUSED (DESIGN-RELEASE-EVIDENCE section 5, the release smoke item `removal`).
 *
 * A member is removed from a conversation by its owner. On the token and the chat credential they held BEFORE the
 * removal, their next send is refused by Amazon Chime SDK, and their next file request (an upload signature, and a
 * download signature for the file they uploaded while a member) is refused by the presigner's conversation check.
 *
 * Every refused action is first shown to succeed while the person is a member, so a refusal cannot be an action
 * that never worked. Removal is driven through `removeMember`, the same helper the revocation-windows spec uses.
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getSecondPremiumUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { PERSON_API_URL, personApiServes } from './helpers/api-urls';
import { idTokenFor, personArnFromIdToken } from './helpers/person';
import {
  archive, chatCredentials, openConversation, removeMember, sendWithCredential, shareWith, signDownload, signUpload,
} from './helpers/person-session';

test.describe('a removed member', () => {
  guardBackendErrors('a-removed-member-is-refused');
  test.skip(!PERSON_API_URL, 'VITE_PERSON_API_URL is required');
  test.skip(!hasTestCredentials(), 'needs the provisioned test users');

  test('is refused their next send and their next file request, on what they already hold', async () => {
    test.setTimeout(300_000);
    test.skip(!personApiServes('notifications'), 'membership is given by a share, the notifications capability\'s route (/share-conversation)');
    const creds = await getTestCredentials();
    const member = await getSecondPremiumUser();
    test.skip(!creds.premiumUser?.password, missingUserReason('premiumUser'));
    test.skip(!member?.password, missingUserReason('secondPremiumUser'));

    const ownerToken = idTokenFor(creds.premiumUser.email, creds.premiumUser.password, creds.cognitoClientId);
    const memberToken = idTokenFor(member!.email, member!.password, creds.cognitoClientId);
    const memberArn = await personArnFromIdToken(memberToken);
    const title = `Removed member ${Date.now()}`;
    const { channelArn, conversationId } = await openConversation(ownerToken, title);

    try {
      expect((await shareWith(ownerToken, channelArn, title, member!.email)).status, 'the owner shares the conversation').toBe(200);

      // AS A MEMBER: each action the spec later expects refused is admitted now.
      const chat = await chatCredentials(memberToken, channelArn);
      const sent = sendWithCredential(chat, channelArn, memberArn, 'Hello from a member.');
      expect(sent.ok, `a member sends: ${sent.error ?? ''}`).toBe(true);
      const upload = await signUpload(memberToken, conversationId);
      expect(upload.status, `a member is signed an upload: ${JSON.stringify(upload.body).slice(0, 300)}`).toBe(200);
      const fileKey = String(upload.body?.fileKey || '');
      expect(fileKey, 'the upload signature names its file').toBeTruthy();
      expect((await signDownload(memberToken, conversationId, fileKey)).status, 'a member is signed a download of their file').toBe(200);

      // REMOVED by the owner.
      const removed = await removeMember(ownerToken, channelArn, memberArn);
      expect(removed.status, JSON.stringify(removed.body).slice(0, 300)).toBe(200);

      // REFUSED, on the credential and token held before the removal.
      const after = sendWithCredential(chat, channelArn, memberArn, 'Hello after removal.');
      expect(after.ok, 'a removed member\'s send is refused').toBe(false);
      expect(after.error ?? '', 'the send is refused for access, not for a malformed request').toMatch(/Forbidden|AccessDenied|not a member|NotFound/i);

      const uploadAfter = await signUpload(memberToken, conversationId);
      expect(uploadAfter.status, 'a removed member is refused an upload signature').toBe(403);
      expect(uploadAfter.body?.code).toBe('NOT_A_MEMBER');
      const downloadAfter = await signDownload(memberToken, conversationId, fileKey);
      expect(downloadAfter.status, 'a removed member is refused a download of the file they uploaded').toBe(403);
      expect(downloadAfter.body?.code).toBe('NOT_A_MEMBER');
    } finally {
      await archive(ownerToken, channelArn).catch(() => undefined);
    }
  });
});
