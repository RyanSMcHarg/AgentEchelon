/**
 * A SHARE REACHES ONLY A VERIFIED ACCOUNT, AND ITS WELCOME NAMES THE CONVERSATION BY ITS OWN NAME.
 *
 * `POST /share-conversation` finds the recipient by address in the deployment's directory, and an address finds only an
 * enabled account the issuer has not marked unverified (`subjectsByAddress`, `verifiedAddress`). The welcome the new
 * member receives, in the room and by email, names the conversation as the conversation is called, whatever title the
 * request body carries.
 *
 * The recipient's `email_verified` is set false for the refusal and restored in `finally`. The conversation is archived.
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getPremiumUser, getSecondPremiumUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { idTokenFor, personArnFromIdToken } from './helpers/person';
import { archive, openConversation, shareWith } from './helpers/person-session';
import { messageRowsVisibleTo } from './helpers/third-party-view';
import { getTestInbox, inboxSkipReason, waitForEmail, emailsTo } from './helpers/test-inbox';
import { awsv } from './helpers/aws';
import { PERSON_API_URL, personApiServes } from './helpers/api-urls';

guardBackendErrors('a-share-reaches-only-a-verified-account');

test.describe('a share reaches only a verified account', () => {
  test.skip(!PERSON_API_URL, 'VITE_PERSON_API_URL is required');
  test.skip(!hasTestCredentials(), 'needs the provisioned test users');

  test('an unverified address finds nobody, and the welcome names the room, not the title the request sent', async () => {
    test.setTimeout(420_000);
    test.skip(!personApiServes('notifications'), 'a share is the notifications capability\'s route (/share-conversation)');
    const creds = await getTestCredentials();
    const owner = await getPremiumUser();
    const recipient = await getSecondPremiumUser();
    test.skip(!owner.password, missingUserReason('premiumUser'));
    test.skip(!recipient?.password, missingUserReason('secondPremiumUser'));
    const inbox = await getTestInbox();
    const noInbox = inboxSkipReason(inbox, recipient!.email);
    test.skip(Boolean(noInbox), noInbox);

    const ownerToken = idTokenFor(owner.email, owner.password, creds.cognitoClientId);
    const ownerArn = await personArnFromIdToken(ownerToken);
    const recipientArn = await personArnFromIdToken(idTokenFor(recipient!.email, recipient!.password, creds.cognitoClientId));
    const run = Date.now().toString(36).toUpperCase();
    const { channelArn } = await openConversation(ownerToken, `Verified share e2e ${run}`);
    const verified = (value: 'true' | 'false') => awsv(['cognito-idp', 'admin-update-user-attributes', '--user-pool-id', creds.cognitoUserPoolId,
      '--username', recipient!.email, '--user-attributes', `Name=email_verified,Value=${value}`]);

    try {
      // ── AN ADDRESS THE ISSUER MARKS UNVERIFIED FINDS NOBODY ──
      verified('false');
      const refused = await shareWith(ownerToken, channelArn, 'Verified share e2e', recipient!.email);
      expect(refused.status, `a share to an unverified address: ${JSON.stringify(refused.body).slice(0, 200)}`).toBe(403);
      // The one answer for every recipient who cannot be added, which names nothing about the person.
      expect(refused.body?.code).toBe('RECIPIENT_NOT_ADDABLE');
      const members = (awsv(['chime-sdk-messaging', 'list-channel-memberships', '--channel-arn', channelArn, '--chime-bearer', ownerArn])?.ChannelMemberships ?? [])
        .map((m: { Member?: { Arn?: string } }) => m.Member?.Arn);
      expect(members, 'the owner reads the membership, so its not naming the recipient means something').toContain(ownerArn);
      expect(members, 'the refused share added the recipient anyway').not.toContain(recipientArn);
    } finally {
      verified('true');
    }

    // ── VERIFIED AGAIN, THE SHARE GOES THROUGH; THE BODY'S TITLE IS NOT WHAT THE WELCOME SAYS ──
    const roomName = String(awsv(['chime-sdk-messaging', 'describe-channel', '--channel-arn', channelArn, '--chime-bearer', ownerArn])?.Channel?.Name ?? '');
    expect(roomName, 'the conversation has a name of its own').toBeTruthy();
    const forged = `FORGED${run}`;
    const since = Date.now() - 5_000;
    try {
      const shared = await shareWith(ownerToken, channelArn, forged, recipient!.email);
      expect(shared.status, JSON.stringify(shared.body).slice(0, 300)).toBe(200);

      let welcome = '';
      for (let i = 0; i < 24 && !welcome; i += 1) {
        await new Promise((r) => setTimeout(r, 5_000));
        welcome = messageRowsVisibleTo(channelArn, recipientArn)
          .filter((m) => m.senderArn.includes('/bot/') && Date.parse(m.createdAt) >= since && /added to/i.test(m.content))
          .map((m) => m.content)[0] ?? '';
      }
      expect(welcome, 'the recipient was welcomed in the room').toBeTruthy();
      expect(welcome, 'the welcome names the conversation').toContain(roomName);
      expect(welcome, 'the welcome repeats the title the request sent').not.toContain(forged);

      const mail = await waitForEmail(inbox!, { to: recipient!.email, since, textIncludes: roomName }, 180_000);
      console.log(`[verified-share] welcome email: "${mail.subject}"`);
      for (const m of emailsTo(inbox!, { to: recipient!.email, since })) {
        expect(`${m.subject}\n${m.text}`, 'an email to the recipient repeats the title the request sent').not.toContain(forged);
      }
    } finally {
      await archive(ownerToken, channelArn);
    }
  });
});
