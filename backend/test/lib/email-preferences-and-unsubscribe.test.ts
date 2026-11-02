/**
 * B9: EMAIL GOES ONLY WITH CONSENT, AND EVERY MAIL A PERSON CAN STOP CARRIES ITS UNSUBSCRIBE HEADERS.
 *
 *  - preferences are keyed by the person's AppInstanceUser, never by an address;
 *  - a send without consent for that route is refused: a muted kind, every kind muted, an unreadable
 *    preference, and any SMS (no consent record exists, and no SMS sender is built);
 *  - the transactional set (invitation, claim, reply receipt) is sent whatever is muted, with no headers;
 *  - a non-transactional send carries `List-Unsubscribe` and `List-Unsubscribe-Post`, and is not sent at
 *    all when its link cannot be minted;
 *  - the preference page is authenticated by the link's token, acts for the token's person and kind only,
 *    and never changes anything on a `GET`;
 *  - its two layers: the route has no authorizer, and the function's role reaches only `unsubscribe#*`
 *    tokens and `<personId>#notices` items.
 *
 * The consent and voice are the real modules here, not the suite-wide stand-ins (`test/setup/email-consent.ts`).
 */
jest.unmock('../../lambda/src/lib/email-consent');

import * as cdk from 'aws-cdk-lib';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template } from 'aws-cdk-lib/assertions';
import { createHash } from 'crypto';
import { mayNotify, readNoticePreferences, setNoticeMute, noticePreferencesKey, NOTICE_KINDS, MUTABLE_KINDS } from '../../lambda/src/lib/notice-preferences';
import { deployedEmailConsent, UNSUBSCRIBE_MUTE_RETENTION_SECONDS, UNSUBSCRIBE_TOKEN_TTL_SECONDS, type EmailConsent } from '../../lambda/src/lib/email-consent';
import { headersOf, sendEmailInput } from '../../lambda/src/lib/email-message';
import { emailPeople } from '../../lambda/src/lib/channel-notify';
import { composeEmail } from '../../lambda/src/lib/notification';
import { defaultEmailVoice, emailCopyOfLines } from '../../lambda/src/lib/email-copy';
import { handlePreferences } from '../../lambda/src/email-preferences';
import { tokenRecordOf } from '../../lambda/src/lib/tokens';
import { NotificationStack } from '../../lib/stacks/notification-stack';
import { assistantClassifications } from '../../lib/config/profiles';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const RILEY = `${APP}/user/0192f0e0-0000-7000-8000-000000000001`;
const SAM = `${APP}/user/0192f0e0-0000-7000-8000-000000000002`;
const CHANNEL = `${APP}/channel/c1`;
const named = (name: string) => Object.assign(new Error(name), { name });
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

/** A DynamoDB document client over two tables, interpreting the few expressions these modules write. */
function memoryDoc() {
  const tables = new Map<string, Map<string, Record<string, any>>>();
  const table = (n: string) => { if (!tables.has(n)) tables.set(n, new Map()); return tables.get(n)!; };
  const keyOf = (k: Record<string, string>) => k.pk ?? k.personId;
  const calls: Array<{ kind: string; input: any }> = [];
  const doc = {
    calls,
    tables,
    async send(cmd: any) {
      const kind = cmd.constructor.name;
      const i = cmd.input;
      calls.push({ kind, input: i });
      const t = table(i.TableName);
      if (kind === 'GetCommand') return { Item: t.get(keyOf(i.Key)) };
      if (kind === 'PutCommand') {
        const k = i.Item.pk ?? i.Item.personId;
        if (i.ConditionExpression === 'attribute_not_exists(pk)' && t.has(k)) throw named('ConditionalCheckFailedException');
        t.set(k, { ...i.Item });
        return {};
      }
      if (kind === 'UpdateCommand') {
        const k = keyOf(i.Key);
        const row = t.get(k);
        const v = i.ExpressionAttributeValues;
        if (i.ConditionExpression?.startsWith('attribute_not_exists(personArn)')) {
          if (row && row.personArn !== v[':p']) throw named('ConditionalCheckFailedException');
          const next = row ?? { personId: k };
          next.muted = next.muted ?? {};
          next.personArn = v[':p'];
          next.updatedAt = v[':at'];
          t.set(k, next);
          return {};
        }
        if (!row || row.personArn !== v[':p']) throw named('ConditionalCheckFailedException');
        const key = i.ExpressionAttributeNames['#k'];
        if (i.UpdateExpression.startsWith('SET muted.#k')) row.muted[key] = v[':at'];
        else delete row.muted[key];
        row.updatedAt = v[':at'];
        return {};
      }
      throw new Error(`unexpected ${kind}`);
    },
  };
  return doc;
}

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const env = { NOTICE_PREFERENCES_TABLE: 'UserProfile', TOKENS_TABLE: 'Tokens', PERSON_API_URL: 'https://test.execute-api.us-east-1.amazonaws.com' };

describe('consent, per route and kind (M-7)', () => {
  it('a muted kind, every kind muted, an unreadable preference and any SMS are each refused', () => {
    expect(mayNotify({ muted: {} }, 'email', 'conversation')).toEqual({ ok: true });
    expect(mayNotify({ muted: { 'email:briefing': 't' } }, 'email', 'briefing')).toEqual({ ok: false, reason: 'muted' });
    expect(mayNotify({ muted: { 'email:briefing': 't' } }, 'email', 'conversation')).toEqual({ ok: true });
    expect(mayNotify({ muted: { 'email:*': 't' } }, 'email', 'alarm')).toEqual({ ok: false, reason: 'muted' });
    expect(mayNotify(null, 'email', 'conversation')).toEqual({ ok: false, reason: 'unreadable' });
    expect(mayNotify({ muted: {} }, 'sms', 'conversation')).toEqual({ ok: false, reason: 'no-consent' });
  });

  it('the transactional set is sent whatever is muted, and no one can mute it', async () => {
    const transactional = Object.entries(NOTICE_KINDS).filter(([, v]) => v.transactional).map(([k]) => k).sort();
    expect(transactional).toEqual(['claim', 'invitation', 'reply-receipt']);
    for (const kind of transactional) {
      expect(mayNotify({ muted: { 'email:*': 't' } }, 'email', kind as never)).toEqual({ ok: true });
      expect(MUTABLE_KINDS).not.toContain(kind);
      await expect(setNoticeMute(memoryDoc(), 'UserProfile', { personArn: RILEY, route: 'email', kind: kind as never, muted: true })).rejects.toThrow(/transactional/);
    }
  });

  it('is keyed by the person, never by an address, and an item naming another person mutes nothing', async () => {
    const doc = memoryDoc();
    await setNoticeMute(doc, 'UserProfile', { personArn: RILEY, route: 'email', kind: 'briefing', muted: true, now: new Date(NOW) });
    const item = doc.tables.get('UserProfile')!.get(noticePreferencesKey('0192f0e0-0000-7000-8000-000000000001'))!;
    expect(item).toMatchObject({ personArn: RILEY, muted: { 'email:briefing': expect.any(String) } });
    expect(JSON.stringify(item)).not.toContain('@');
    expect(await readNoticePreferences(doc, 'UserProfile', RILEY)).toEqual({ muted: { 'email:briefing': expect.any(String) } });
    // Someone else's item under this key is not this person's preferences: unreadable, so refused.
    doc.tables.get('UserProfile')!.get(noticePreferencesKey('0192f0e0-0000-7000-8000-000000000001'))!.personArn = SAM;
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await readNoticePreferences(doc, 'UserProfile', RILEY)).toBeNull();
    err.mockRestore();
  });
});

describe('the fan-out refuses a send without consent, and a stoppable send carries both headers', () => {
  const directory = {
    contactFor: async (arn: string) => ({ route: 'email' as const, address: arn === RILEY ? 'riley@example.com' : 'sam@example.com', name: '' }),
  };
  const sendAll = jest.fn(async (r: Array<{ email: string }>) => ({ sent: r.map((x) => x.email), failed: [] }));
  beforeEach(() => sendAll.mockClear());

  it('a person who muted the kind is not sent it, and is counted', async () => {
    const consent: EmailConsent = {
      preferences: async (arn) => ({ muted: (arn === RILEY ? { 'email:conversation': 't' } : {}) as Record<string, string> }),
      unsubscribeUrl: async () => 'https://test.execute-api.us-east-1.amazonaws.com/email/preferences?t=x',
      replyAddress: async () => null,
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = await emailPeople({ personArns: [RILEY, SAM], kind: 'conversation', subject: 's', bodyText: 'b', deps: { directory: directory as never, send: sendAll as never, consent } });
    log.mockRestore();
    expect(res.emailed).toEqual(['sam@example.com']);
    expect(res.muted).toEqual(['0192f0e0-0000-7000-8000-000000000001']);
    expect(sendAll.mock.calls[0][0]).toEqual([expect.objectContaining({ email: 'sam@example.com', unsubscribeUrl: expect.stringContaining('/email/preferences?t=') })]);
  });

  it('preferences that cannot be read send nothing a person could stop', async () => {
    const consent: EmailConsent = { preferences: async () => null, unsubscribeUrl: async () => 'u', replyAddress: async () => null };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = await emailPeople({ personArns: [RILEY], kind: 'briefing', subject: 's', bodyText: 'b', deps: { directory: directory as never, send: sendAll as never, consent } });
    log.mockRestore();
    expect(res).toMatchObject({ emailed: [], muted: ['0192f0e0-0000-7000-8000-000000000001'] });
    expect(sendAll).not.toHaveBeenCalled();
  });

  it('a stoppable mail whose link cannot be minted is not sent at all', async () => {
    const consent: EmailConsent = { preferences: async () => ({ muted: {} }), unsubscribeUrl: async () => null, replyAddress: async () => null };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await emailPeople({ personArns: [RILEY], kind: 'alarm', subject: 's', bodyText: 'b', deps: { directory: directory as never, send: sendAll as never, consent } });
    warn.mockRestore();
    expect(res.emailed).toEqual([]);
    expect(sendAll).not.toHaveBeenCalled();
  });

  it('a transactional mail is sent to a person who muted everything, with no unsubscribe link', async () => {
    const consent: EmailConsent = {
      preferences: jest.fn(async () => ({ muted: { 'email:*': 't' } })),
      unsubscribeUrl: jest.fn(async () => 'u'),
      replyAddress: async () => null,
    };
    const res = await emailPeople({ personArns: [RILEY], kind: 'invitation', subject: 's', bodyText: 'b', deps: { directory: directory as never, send: sendAll as never, consent } });
    expect(res.emailed).toEqual(['riley@example.com']);
    expect(sendAll.mock.calls[0][0][0]).not.toHaveProperty('unsubscribeUrl');
    expect(consent.preferences).not.toHaveBeenCalled();
    expect(consent.unsubscribeUrl).not.toHaveBeenCalled();
  });

  it('the message carries List-Unsubscribe and List-Unsubscribe-Post (RFC 8058) when it can be stopped, and neither when not', () => {
    const url = 'https://test.execute-api.us-east-1.amazonaws.com/email/preferences?t=abc';
    const stoppable = headersOf({ from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't', html: 'h', unsubscribeUrl: url });
    expect(stoppable).toEqual(expect.arrayContaining([['List-Unsubscribe', `<${url}>`], ['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click']]));
    const transactional = headersOf({ from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't', html: 'h' });
    expect(transactional.map(([k]) => k)).not.toEqual(expect.arrayContaining(['List-Unsubscribe']));
    expect(transactional.map(([k]) => k)).not.toContain('List-Unsubscribe-Post');
    // A header value cannot smuggle a header.
    const input = sendEmailInput({
      from: 'a@example.com', to: 'b@example.com\r\nBcc: x@evil.example', subject: 'hi\r\nBcc: x@evil.example', text: 't', html: 'h',
      replyTo: 'r@example.com\nBcc: y@evil.example', unsubscribeUrl: 'https://x/u\r\nBcc: z@evil.example', language: 'en\r\nBcc: w@evil.example',
    });
    const values = [input.FromEmailAddress, ...(input.Destination?.ToAddresses ?? []), ...(input.ReplyToAddresses ?? []),
      input.Content?.Simple?.Subject?.Data, ...(input.Content?.Simple?.Headers ?? []).map((h) => h.Value)];
    expect(values.length).toBeGreaterThan(5);
    for (const v of values) expect(v).not.toMatch(/[\r\n]/);
  });

  it('is wrapped in the assistant\'s own copy and language, signed with its name, never fixed English', () => {
    const voice = { copy: emailCopyOfLines({ language: 'pt-BR', greeting: 'Olá {name},', signOff: 'Abraços,' }), assistantName: 'Aurora' };
    const parts = composeEmail({ email: 'r@example.com', name: 'Riley', unsubscribeUrl: 'https://x/u' }, { subject: 's', bodyText: 'corpo', voice });
    expect(parts.text).toMatch(/^Olá Riley,/);
    expect(parts.text).toContain('Abraços,\nAurora');
    expect(parts.text).not.toContain('AgentEchelon');
    expect(parts.html).toContain('<html lang="pt-BR">');
    expect(parts.language).toBe('pt-BR');
    // An unset key falls back per key, not as a whole.
    expect(voice.copy.manageEmail).toBe(defaultEmailVoice().copy.manageEmail);
  });
});

describe('the deployed consent mints a link per person and kind, and keeps only its hash', () => {
  it('an unsubscribe link is an `unsubscribe` token naming the person and the kind, with the page copy it speaks in', async () => {
    const doc = memoryDoc();
    const consent = deployedEmailConsent(env as never, { doc, ssm: { send: async () => ({}) }, now: () => NOW });
    const url = await consent.unsubscribeUrl({ personArn: RILEY, kind: 'briefing', copy: defaultEmailVoice().copy });
    const token = new URL(url!).searchParams.get('t')!;
    expect(url!.startsWith('https://test.execute-api.us-east-1.amazonaws.com/email/preferences?t=')).toBe(true);
    const rec = doc.tables.get('Tokens')!.get(`unsubscribe#${sha(token)}`)!;
    expect(rec).toMatchObject({ kind: 'unsubscribe', personArn: RILEY, noticeKind: 'briefing', redemption: 'bounded', expiresAt: NOW / 1000 + UNSUBSCRIBE_TOKEN_TTL_SECONDS });
    expect(rec.page).toMatchObject({ preferencesTitle: 'Email preferences', language: 'en' });
    expect(JSON.stringify([...doc.tables.get('Tokens')!.values()])).not.toContain(token);
  });

  it('a deployment that takes no replies gives no reply address', async () => {
    const consent = deployedEmailConsent(env as never, { doc: memoryDoc(), ssm: { send: async () => ({}) }, now: () => NOW });
    expect(await consent.replyAddress({ personArn: RILEY, channelArn: CHANNEL, noticeId: 'n1', kind: 'conversation' })).toBeNull();
  });
});

describe('the preference page: authenticated by the token, for its person and kind only', () => {
  const T = 'unsubscribe-token-abc_123';
  function world(expiresAt = NOW / 1000 + 3600, muteUntil?: number) {
    const doc = memoryDoc();
    doc.tables.set('Tokens', new Map([[`unsubscribe#${sha(T)}`, tokenRecordOf('unsubscribe', T, {
      channelArn: '', personArn: RILEY, issuer: '', expiresAt, noticeKind: 'briefing', page: { stopKind: 'Parar estes emails', language: 'pt-BR' },
      ...(muteUntil !== undefined ? { muteUntil } : {}),
    })]]));
    const deps = { doc, tokensTable: 'Tokens', preferencesTable: 'UserProfile', now: () => NOW };
    const prefs = () => doc.tables.get('UserProfile')?.get(noticePreferencesKey('0192f0e0-0000-7000-8000-000000000001'))?.muted ?? {};
    return { doc, deps, prefs };
  }
  const quiet = () => [jest.spyOn(console, 'log').mockImplementation(() => undefined)];

  it('GET shows the page in the email\'s copy and changes nothing', async () => {
    const w = world();
    const res = await handlePreferences({ httpMethod: 'GET', queryStringParameters: { t: T } }, w.deps);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('lang="pt-BR"');
    expect(res.body).toContain('Parar estes emails');
    expect(w.doc.calls.filter((c) => c.kind === 'UpdateCommand' || c.kind === 'PutCommand')).toEqual([]);
  });

  it('a one-click POST stops the kind the mail was, for the token\'s person, whatever the body names', async () => {
    const spies = quiet();
    const w = world();
    const res = await handlePreferences({
      httpMethod: 'POST', queryStringParameters: { t: T }, body: `List-Unsubscribe=One-Click&person=${encodeURIComponent(SAM)}&kind=conversation`,
    }, w.deps);
    spies.forEach((s) => s.mockRestore());
    expect(res.statusCode).toBe(200);
    expect(w.prefs()).toEqual({ 'email:briefing': expect.any(String) });
    expect(w.doc.tables.get('UserProfile')!.size).toBe(1);
  });

  it('a form post stops every kind, and resumes one', async () => {
    const spies = quiet();
    const w = world();
    await handlePreferences({ httpMethod: 'POST', queryStringParameters: { t: T }, body: 'action=stopAll' }, w.deps);
    expect(w.prefs()).toEqual({ 'email:*': expect.any(String) });
    await handlePreferences({ httpMethod: 'POST', queryStringParameters: { t: T }, body: 'action=stop&kind=alarm' }, w.deps);
    await handlePreferences({ httpMethod: 'POST', queryStringParameters: { t: T }, body: 'action=resume&kind=alarm' }, w.deps);
    spies.forEach((s) => s.mockRestore());
    expect(w.prefs()).toEqual({ 'email:*': expect.any(String) });
  });

  it('refuses to mute a transactional kind', async () => {
    const w = world();
    const res = await handlePreferences({ httpMethod: 'POST', queryStringParameters: { t: T }, body: 'action=stop&kind=invitation' }, w.deps);
    expect(res.statusCode).toBe(400);
    expect(w.prefs()).toEqual({});
  });

  it('an unknown or malformed token, or one past its mute retention, changes nothing', async () => {
    const spies = quiet();
    const w = world(NOW / 1000 - 1);
    for (const t of [T, 'not-a-token-we-minted', '../../etc', '']) {
      const res = await handlePreferences({ httpMethod: 'POST', queryStringParameters: { t }, body: 'List-Unsubscribe=One-Click' }, w.deps);
      expect(res.statusCode).toBe(404);
    }
    spies.forEach((s) => s.mockRestore());
    expect(w.doc.calls.filter((c) => c.kind === 'UpdateCommand')).toEqual([]);
  });
});

describe('an expired but genuine link still stops its own email, and only that', () => {
  const T = 'expired-unsubscribe-token';
  const expired = () => {
    const doc = memoryDoc();
    doc.tables.set('Tokens', new Map([[`unsubscribe#${sha(T)}`, tokenRecordOf('unsubscribe', T, {
      channelArn: '', personArn: RILEY, issuer: '', expiresAt: NOW / 1000 - 86_400, muteUntil: NOW / 1000 + 86_400, noticeKind: 'briefing', page: {},
    })]]));
    // The person had muted alarms and nothing else.
    doc.tables.set('UserProfile', new Map([[noticePreferencesKey('0192f0e0-0000-7000-8000-000000000001'), {
      personId: noticePreferencesKey('0192f0e0-0000-7000-8000-000000000001'), personArn: RILEY, muted: { 'email:alarm': 't' },
    }]]));
    const deps = { doc, tokensTable: 'Tokens', preferencesTable: 'UserProfile', now: () => NOW };
    const prefs = () => doc.tables.get('UserProfile')!.get(noticePreferencesKey('0192f0e0-0000-7000-8000-000000000001'))!.muted;
    return { doc, deps, prefs };
  };
  const quiet = () => jest.spyOn(console, 'log').mockImplementation(() => undefined);

  it('a one-click POST mutes its own kind, and the page says it is stopped and to sign in for the rest', async () => {
    const spy = quiet();
    const w = expired();
    const res = await handlePreferences({ httpMethod: 'POST', queryStringParameters: { t: T }, body: 'List-Unsubscribe=One-Click' }, w.deps);
    spy.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(w.prefs()).toEqual({ 'email:alarm': 't', 'email:briefing': expect.any(String) });
    expect(res.body).toContain('These emails are stopped.');
    expect(res.body).toContain('sign in to the app');
    // The signed-in preferences screen is not built, so nothing links to it.
    expect(res.body).not.toMatch(/<a\s/);
  });

  it('the page\'s single stop action mutes the same kind', async () => {
    const spy = quiet();
    const w = expired();
    const res = await handlePreferences({ httpMethod: 'POST', queryStringParameters: { t: T }, body: 'action=stop&kind=briefing' }, w.deps);
    spy.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(w.prefs()['email:briefing']).toEqual(expect.any(String));
  });

  it('cannot unmute, stop every kind, stop another kind, or read the other preferences', async () => {
    const spy = quiet();
    const w = expired();
    for (const body of ['action=resume&kind=alarm', 'action=stopAll', 'action=stop&kind=conversation', 'action=resume&kind=briefing']) {
      const res = await handlePreferences({ httpMethod: 'POST', queryStringParameters: { t: T }, body }, w.deps);
      expect(res.statusCode).toBe(403);
    }
    const page = await handlePreferences({ httpMethod: 'GET', queryStringParameters: { t: T } }, w.deps);
    spy.mockRestore();
    expect(w.prefs()).toEqual({ 'email:alarm': 't' });
    // The page offers its own kind's stop and nothing else: no other kind, no resume, no stop-all.
    expect(page.body).toContain('value="briefing"');
    expect(page.body).not.toMatch(/value="(alarm|conversation|conversation-shared|resume|stopAll)"/);
  });

  it('a GET changes nothing', async () => {
    const w = expired();
    const res = await handlePreferences({ httpMethod: 'GET', queryStringParameters: { t: T } }, w.deps);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('This link has expired, but it can still stop the emails it came with.');
    expect(w.doc.calls.filter((c) => c.kind === 'UpdateCommand' || c.kind === 'PutCommand')).toEqual([]);
  });

  it('points to the signed-in preferences screen, before and after its one action', async () => {
    const w = expired();
    const prior = process.env.APP_URL;
    process.env.APP_URL = 'https://app.example.com';
    try {
      const offer = await handlePreferences({ httpMethod: 'GET', queryStringParameters: { t: T } }, w.deps);
      expect(offer.body).toContain('href="https://app.example.com?settings=email-preferences"');
      const spy = quiet();
      const done = await handlePreferences({ httpMethod: 'POST', queryStringParameters: { t: T }, body: 'List-Unsubscribe=One-Click' }, w.deps);
      spy.mockRestore();
      expect(done.body).toContain('href="https://app.example.com?settings=email-preferences"');
    } finally {
      if (prior === undefined) delete process.env.APP_URL; else process.env.APP_URL = prior;
    }
    // With no app origin the page names the screen in words and links nowhere.
    const plain = await handlePreferences({ httpMethod: 'GET', queryStringParameters: { t: T } }, expired().deps);
    expect(plain.body).not.toContain('settings=email-preferences');
  });

  it('an unknown token changes nothing', async () => {
    const spy = quiet();
    const w = expired();
    const res = await handlePreferences({ httpMethod: 'POST', queryStringParameters: { t: 'never-minted' }, body: 'List-Unsubscribe=One-Click' }, w.deps);
    spy.mockRestore();
    expect(res.statusCode).toBe(404);
    expect(w.prefs()).toEqual({ 'email:alarm': 't' });
  });

  it('a minted link is kept for its mute retention, past its live window, before TTL reclaims it', async () => {
    const doc = memoryDoc();
    const consent = deployedEmailConsent(env as never, { doc, ssm: { send: async () => ({}) }, now: () => NOW });
    const url = await consent.unsubscribeUrl({ personArn: RILEY, kind: 'briefing', copy: defaultEmailVoice().copy });
    const rec = doc.tables.get('Tokens')!.get(`unsubscribe#${sha(new URL(url!).searchParams.get('t')!)}`)!;
    expect(rec.muteUntil).toBe(NOW / 1000 + UNSUBSCRIBE_MUTE_RETENTION_SECONDS);
    expect(rec.muteUntil).toBeGreaterThan(rec.expiresAt);
    expect(rec.reclaimAt).toBeGreaterThan(rec.muteUntil);
    expect(rec.page).toMatchObject({ expiredStopped: 'These emails are stopped.' });
  });
});

describe('the preference route\'s two layers, at synth', () => {
  const app = new cdk.App();
  const env2 = { account: '111122223333', region: 'us-east-1' };
  const host = new cdk.Stack(app, 'Host', { env: env2 });
  const stack = new NotificationStack(app, 'N', {
    env: env2, appInstanceArn: APP, userPoolId: 'us-east-1_PRIMARY', classifications: assistantClassifications(),
    senderEmail: 'assistant@example.com', appUrl: 'https://app.example.com',
    messageStream: kinesis.Stream.fromStreamArn(host, 'S', 'arn:aws:kinesis:us-east-1:111122223333:stream/s'),
    tokens: dynamodb.Table.fromTableArn(host, 'T', 'arn:aws:dynamodb:us-east-1:111122223333:table/tokens'),
  });
  const t = Template.fromStack(stack);
  const policies = t.findResources('AWS::IAM::Policy');
  const statementsOfRole = (logicalPrefix: string) => Object.values(policies)
    .filter((p: any) => JSON.stringify(p.Properties.Roles).includes(logicalPrefix))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);

  it('is served with no authorizer, on GET and POST', () => {
    expect(stack.routes.filter((r) => r.path === '/email/preferences').map((r) => `${r.method} ${r.auth}`).sort()).toEqual(['GET none', 'POST none']);
  });

  it('reaches only `unsubscribe#*` tokens and `<personId>#notices` items, and writes only their preference attributes', () => {
    const s = statementsOfRole('EmailPreferencesFunction');
    const dynamo = s.filter((x: any) => JSON.stringify(x.Action).includes('dynamodb:'));
    expect(dynamo.length).toBe(3);
    for (const x of dynamo) {
      const keys = x.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];
      expect(keys).toEqual(expect.arrayContaining([expect.stringMatching(/^(unsubscribe#\*|\*#notices)$/)]));
      expect(keys.length).toBe(1);
    }
    const write = dynamo.find((x: any) => x.Action === 'dynamodb:UpdateItem');
    expect(write.Condition['ForAllValues:StringEquals']['dynamodb:Attributes'].sort()).toEqual(['muted', 'personArn', 'personId', 'updatedAt']);
    expect(JSON.stringify(s)).not.toMatch(/ses:|chime:|kms:/);
  });

  it('every sender may write its own two token kinds and nothing else there', () => {
    // The senders' consent grants are one managed policy each (`grantEmailFanOut`), beside their inline ones.
    const all = { ...policies, ...t.findResources('AWS::IAM::ManagedPolicy') };
    const tokenWrites = Object.values(all).flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((x: any) => JSON.stringify(x.Action).includes('dynamodb:PutItem') && JSON.stringify(x.Resource).includes('tokens'));
    expect(tokenWrites.length).toBeGreaterThan(0);
    for (const x of tokenWrites) expect(x.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'].sort()).toEqual(['reply#*', 'unsubscribe#*']);
  });
});
