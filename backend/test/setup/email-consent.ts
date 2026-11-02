/**
 * AN EMAIL'S CONSENT AND VOICE, WITHOUT THE TABLES, FOR EVERY SUITE.
 *
 * Every mail the fan-out sends first reads the recipient's preferences, mints an unsubscribe link and a
 * reply address (`lib/email-consent.ts`), and reads the conversation assistant's copy
 * (`emailVoiceForRoom`, `lib/email-copy.ts`). A suite about who is emailed would otherwise need the
 * user-profile table, the token store and the profile parameters it is not about. Here the consent says
 * nothing is muted and mints fixed placeholder links, and the voice is the shipped stand-in copy.
 *
 * Both are tested for real, unmocked, by `test/lib/email-preferences-and-unsubscribe.test.ts` and
 * `test/lib/email-reply-tokens.test.ts`.
 */
jest.mock('../../lambda/src/lib/email-consent', () => {
  const actual = jest.requireActual('../../lambda/src/lib/email-consent');
  const standIn = {
    preferences: async () => ({ muted: {} }),
    unsubscribeUrl: async () => 'https://test.execute-api.us-east-1.amazonaws.com/email/preferences?t=test',
    replyAddress: async () => null,
  };
  return { ...actual, defaultEmailConsent: () => standIn };
});

jest.mock('../../lambda/src/lib/email-copy', () => {
  const actual = jest.requireActual('../../lambda/src/lib/email-copy');
  return { ...actual, emailVoiceForRoom: async () => actual.defaultEmailVoice() };
});
