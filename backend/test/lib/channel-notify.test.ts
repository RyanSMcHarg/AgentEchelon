/**
 * Conversation→transport notification fan-out (lib/channel-notify.ts) — SPEC-NOTIFICATION-BRIDGE P1.
 * Pins the parsing + recipient-selection contract, and the email fan-out orchestration (with injected
 * mocks for Chime/Cognito/SES so no AWS is touched).
 */
import {
  parseNotifyDirective,
  selectNotifyRecipients,
  fanOutChannelNotification,
  poolIdFromIssuer,
  resolvePoolForTarget,
} from '../../lambda/src/lib/channel-notify';

const POOL_A = 'us-east-1_AAAA';
const POOL_B = 'us-east-1_BBBB';
const issFor = (pool: string) => `https://cognito-idp.us-east-1.amazonaws.com/${pool}`;

describe('parseNotifyDirective', () => {
  test('no/blank/garbage metadata ⇒ null', () => {
    expect(parseNotifyDirective(undefined)).toBeNull();
    expect(parseNotifyDirective('')).toBeNull();
    expect(parseNotifyDirective('{ not json')).toBeNull();
    expect(parseNotifyDirective(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(parseNotifyDirective(JSON.stringify({ notify: {} }))).toBeNull(); // no transport
  });

  test('legacy notifyTargetSubs ⇒ targets without iss (primary pool)', () => {
    const d = parseNotifyDirective(
      JSON.stringify({ notify: { email: true }, notifySubject: 'Complete vendor sign-off', notifyTargetSubs: ['sub-a'] }),
    );
    expect(d).toEqual({ notify: { email: true, sms: false }, subject: 'Complete vendor sign-off', targets: [{ sub: 'sub-a' }] });
  });

  test('notifyTargets carries per-target issuer (multi-IDP)', () => {
    const d = parseNotifyDirective(
      JSON.stringify({
        notify: { email: true },
        notifyTargets: [{ sub: 'sub-a', iss: issFor(POOL_A) }, { sub: 'sub-b' }, { iss: 'x' }],
      }),
    );
    expect(d).toEqual({
      notify: { email: true, sms: false },
      targets: [{ sub: 'sub-a', iss: issFor(POOL_A) }, { sub: 'sub-b' }],
    });
  });

  test('sms-only directive parses (transport requested) but carries no email', () => {
    expect(parseNotifyDirective(JSON.stringify({ notify: { sms: true } }))).toEqual({
      notify: { email: false, sms: true },
    });
  });
});

describe('selectNotifyRecipients', () => {
  const roster = [
    { sub: 'owner', role: 'owner' },
    { sub: 'sarah', role: 'editor' },
    { sub: 'owner', role: 'dup' }, // duplicate sub
    { role: 'no-sub' } as { sub: string; role: string },
  ];
  test('all participants (deduped, sub required) when no targetSubs', () => {
    expect(selectNotifyRecipients(roster).map((p) => p.sub)).toEqual(['owner', 'sarah']);
  });
  test('filters to targetSubs', () => {
    expect(selectNotifyRecipients(roster, ['sarah']).map((p) => p.sub)).toEqual(['sarah']);
  });
});

describe('poolIdFromIssuer', () => {
  test('extracts the pool id from a Cognito issuer (with/without trailing slash)', () => {
    expect(poolIdFromIssuer(issFor(POOL_A))).toBe(POOL_A);
    expect(poolIdFromIssuer(issFor(POOL_A) + '/')).toBe(POOL_A);
  });
  test('null for non-Cognito / missing issuers', () => {
    expect(poolIdFromIssuer('https://accounts.google.com')).toBeNull();
    expect(poolIdFromIssuer(undefined)).toBeNull();
  });
});

describe('resolvePoolForTarget', () => {
  const pools = { defaultPoolId: POOL_A, allowedPoolIds: new Set([POOL_A, POOL_B]) };
  test('no iss ⇒ default pool', () => {
    expect(resolvePoolForTarget({ sub: 's' }, pools)).toBe(POOL_A);
  });
  test('trusted issuer ⇒ its pool', () => {
    expect(resolvePoolForTarget({ sub: 's', iss: issFor(POOL_B) }, pools)).toBe(POOL_B);
  });
  test('untrusted issuer ⇒ null (not resolved)', () => {
    expect(resolvePoolForTarget({ sub: 's', iss: issFor('us-east-1_EVIL') }, pools)).toBeNull();
  });
  test('non-Cognito issuer ⇒ null', () => {
    expect(resolvePoolForTarget({ sub: 's', iss: 'https://accounts.google.com' }, pools)).toBeNull();
  });
});

describe('fanOutChannelNotification', () => {
  const rosterMeta = JSON.stringify({
    participants: [
      { sub: 'owner', role: 'owner' },
      { sub: 'sarah', role: 'editor' },
    ],
  });
  const chime = { send: async () => ({ Channel: { Metadata: rosterMeta } }) };
  // IDP is the source of truth: AdminGetUser resolves email + name by sub at send time. The mock
  // echoes the pool so we can assert the RIGHT pool was queried per target.
  const calls: Array<{ pool: string; sub: string }> = [];
  const cognito = {
    send: async (cmd: { input: { UserPoolId: string; Username: string } }) => {
      calls.push({ pool: cmd.input.UserPoolId, sub: cmd.input.Username });
      return {
        UserAttributes: [
          { Name: 'email', Value: `${cmd.input.Username}@example.com` },
          { Name: 'name', Value: cmd.input.Username },
        ],
      };
    },
  };

  test('emails only the targeted assignee, resolved from the IDP by sub', async () => {
    calls.length = 0;
    const sent: Array<{ to: string[]; subject: string }> = [];
    const send = async (recipients: Array<{ email: string }>, content: { subject: string; bodyText: string }) => {
      sent.push({ to: recipients.map((r) => r.email), subject: content.subject });
      return { sent: recipients.map((r) => r.email), failed: [] };
    };
    const res = await fanOutChannelNotification({
      channelArn: 'arn:chime:...:channel/fed-standard-context-x',
      bearerArn: 'arn:bot',
      userPoolId: POOL_A,
      messageText: 'Sarah, you are set to complete the vendor sign-off by Jun 22.',
      directive: { notify: { email: true }, subject: 'Action item', targets: [{ sub: 'sarah' }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chime as any, cognito: cognito as any, send: send as any },
    });
    expect(res.emailed).toEqual(['sarah@example.com']);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['sarah@example.com']);
    expect(calls).toEqual([{ pool: POOL_A, sub: 'sarah' }]); // default pool (no iss)
  });

  test('multi-IDP: each target resolved against its issuer pool; untrusted issuer skipped', async () => {
    calls.length = 0;
    const send = async (recipients: Array<{ email: string }>) => ({
      sent: recipients.map((r) => r.email),
      failed: [],
    });
    const res = await fanOutChannelNotification({
      channelArn: 'c',
      bearerArn: 'b',
      userPoolId: POOL_A,
      allowedPoolIds: [POOL_B],
      messageText: 'x',
      directive: {
        notify: { email: true },
        targets: [
          { sub: 'alice', iss: issFor(POOL_A) },
          { sub: 'bob', iss: issFor(POOL_B) },
          { sub: 'mallory', iss: issFor('us-east-1_EVIL') }, // untrusted ⇒ skipped
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chime as any, cognito: cognito as any, send: send as any },
    });
    expect(res.emailed.sort()).toEqual(['alice@example.com', 'bob@example.com']);
    expect(res.skipped).toEqual(['mallory']);
    expect(calls.find((c) => c.sub === 'alice')!.pool).toBe(POOL_A);
    expect(calls.find((c) => c.sub === 'bob')!.pool).toBe(POOL_B);
    expect(calls.find((c) => c.sub === 'mallory')).toBeUndefined(); // never queried
  });

  test('email:false ⇒ no send', async () => {
    let sent = false;
    const send = async () => { sent = true; return { sent: [], failed: [] }; };
    const res = await fanOutChannelNotification({
      channelArn: 'c', bearerArn: 'b', userPoolId: 'p', messageText: 'x',
      directive: { notify: { sms: true } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chime as any, cognito: cognito as any, send: send as any },
    });
    expect(sent).toBe(false);
    expect(res.emailed).toEqual([]);
  });
});
