/**
 * Conversation→transport notification fan-out (lib/channel-notify.ts) — SPEC-NOTIFICATION-BRIDGE P1.
 * Pins the parsing + recipient-selection contract, and the email fan-out orchestration, with the
 * directory, the Amazon Chime SDK and SES injected so no AWS is touched.
 *
 * A recipient is a PERSON, by AppInstanceUser ARN. Where to reach them is the directory's answer
 * (`Directory.contactFor`), which reaches their issuer subject through `Identities`; the fan-out reads
 * no id's shape and holds no pool.
 */
import {
  parseNotifyDirective,
  fanOutChannelNotification,
  emailPeople,
  notifyDirective,
} from '../../lambda/src/lib/channel-notify';
import type { Directory } from '../../lambda/src/lib/membership-source';
import { poolIssuer, testDirectory } from '../helpers/directory';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/a';
const user = (id: string) => `${APP}/user/${id}`;
const CHANNEL = `${APP}/channel/c`;

/** A held clearance: `token`, with the admin plane beside it when `adminPlane`. */
const held = (token: string, adminPlane = false) => ({
  state: 'held' as const, token, adminPlane, held: [token], groups: [], admin: false, issuers: ['deployment'],
});

/** A conversation of `classification`, answering its tags; every other read answers `rest`. */
const taggedChime = (classification: string, rest: (cmd: { constructor: { name: string } }) => unknown = () => ({})) => ({
  send: async (cmd: { constructor: { name: string } }) => (cmd.constructor.name === 'ListTagsForResourceCommand'
    ? { Tags: [{ Key: 'classification', Value: classification }] }
    : rest(cmd)),
});

/**
 * A directory whose contacts are `<id>@example.com`, except the ids named as unreachable. Records each ask.
 * Every person is cleared for `premium` and holds the admin plane, unless `clearances` names their own answer.
 */
function directoryOf(
  unreachable: string[] = [],
  asked: string[] = [],
  clearances: Record<string, () => Promise<Awaited<ReturnType<Directory['clearanceOf']>>>> = {},
): Directory {
  return {
    personsInGroup: async () => ({ persons: [], unminted: [] }),
    personOf: async () => null,
    admins: async () => ({ persons: [], unminted: [] }),
    clearanceOf: async (arn) => {
      const own = clearances[arn.split('/').pop() || ''];
      return own ? own() : held('premium', true);
    },
    listGroups: async () => [],
    groupsFor: async () => [],
    clearedByGroups: async () => null,
    displayNameFor: async () => null,
    findByAddress: async () => null,
    accountState: async () => 'active' as const,
    contactFor: async (arn) => {
      const id = arn.split('/').pop() || '';
      asked.push(id);
      return unreachable.includes(id) ? null : { route: 'email', address: `${id}@example.com`, name: id };
    },
  };
}

const sendAll = async (r: Array<{ email: string }>) => ({ sent: r.map((x) => x.email), failed: [] });

describe('parseNotifyDirective', () => {
  test('no/blank/garbage metadata ⇒ null', () => {
    expect(parseNotifyDirective(undefined)).toBeNull();
    expect(parseNotifyDirective('')).toBeNull();
    expect(parseNotifyDirective('{ not json')).toBeNull();
    expect(parseNotifyDirective(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(parseNotifyDirective(JSON.stringify({ notify: {} }))).toBeNull(); // no transport
    expect(parseNotifyDirective(JSON.stringify({ notify: { sms: true } }))).toBeNull(); // not a transport
  });

  test('notifySubject is carried', () => {
    const d = parseNotifyDirective(
      JSON.stringify({ notify: { email: true }, notifySubject: 'Complete vendor sign-off' }),
    );
    expect(d).toEqual({ notify: { email: true }, subject: 'Complete vendor sign-off' });
  });

  test('notifyTargets names people; anything else in the list is dropped', () => {
    const d = parseNotifyDirective(
      JSON.stringify({
        notify: { email: true },
        notifyTargets: [{ person: user('a') }, { person: 'b' }, { sub: 'legacy' }, { iss: 'x' }],
      }),
    );
    expect(d).toEqual({ notify: { email: true }, targets: [{ person: user('a') }, { person: 'b' }] });
  });

  test('the builder writes exactly what the parser reads', () => {
    const md = notifyDirective({ subject: 'S', targets: [user('a')], conversationId: 'conv-1' });
    expect(parseNotifyDirective(JSON.stringify(md))).toEqual({
      notify: { email: true }, subject: 'S', targets: [{ person: user('a') }], conversationId: 'conv-1',
    });
  });
});

describe('fanOutChannelNotification', () => {
  const chime = taggedChime('premium');

  test('emails only the targeted person, resolved by the directory', async () => {
    const asked: string[] = [];
    const sent: Array<{ to: string[]; subject: string }> = [];
    const send = async (recipients: Array<{ email: string }>, content: { subject: string; bodyText: string }) => {
      sent.push({ to: recipients.map((r) => r.email), subject: content.subject });
      return { sent: recipients.map((r) => r.email), failed: [] };
    };
    const res = await fanOutChannelNotification({
      channelArn: CHANNEL,
      bearerArn: `${APP}/bot/advisor`,
      messageText: 'Sarah, you are set to complete the vendor sign-off by Jun 22.',
      directive: { notify: { email: true }, subject: 'Action item', targets: [{ person: user('sarah') }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chime as any, directory: directoryOf([], asked), send: send as any, isEmailConversation: async () => true },
    });
    expect(res.emailed).toEqual(['sarah@example.com']);
    expect(sent).toEqual([{ to: ['sarah@example.com'], subject: 'Action item' }]);
    expect(asked).toEqual(['sarah']);
  });

  test('a target given as a bare id is the person of that id in the channel\'s instance', async () => {
    const asked: string[] = [];
    const res = await fanOutChannelNotification({
      channelArn: CHANNEL, bearerArn: 'b', messageText: 'x',
      directive: { notify: { email: true }, targets: [{ person: 'lead' }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chime as any, directory: directoryOf([], asked), send: sendAll as any },
    });
    expect(res.emailed).toEqual(['lead@example.com']);
  });

  test('a person the directory cannot reach is skipped by id, never dropped silently', async () => {
    const res = await fanOutChannelNotification({
      channelArn: CHANNEL, bearerArn: 'b', messageText: 'x',
      directive: { notify: { email: true }, targets: [{ person: user('alice') }, { person: user('mallory') }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chime as any, directory: directoryOf(['mallory']), send: sendAll as any },
    });
    expect(res.emailed).toEqual(['alice@example.com']);
    expect(res.skipped).toEqual(['mallory']);
  });

  test('email:false ⇒ no send', async () => {
    let sent = false;
    const send = async () => { sent = true; return { sent: [], failed: [] }; };
    const res = await fanOutChannelNotification({
      channelArn: CHANNEL, bearerArn: 'b', messageText: 'x',
      directive: { notify: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chime as any, directory: directoryOf(), send: send as any, isEmailConversation: async () => true },
    });
    expect(sent).toBe(false);
    expect(res.emailed).toEqual([]);
  });
});

/**
 * A PERSON OF ANOTHER ISSUER IS REACHED LIKE ANYONE ELSE.
 *
 * Driven through the REAL directory, with only the reverse lookup and the pools faked: a member who signs
 * in through a second trusted pool resolves to their subject THERE, through `Identities`, and that pool is
 * asked. This used to skip them, because their id was a hash the fan-out could not reverse.
 */
describe('a non-pool person resolves a contact through Identities', () => {
  const HOME = 'us-east-1_HOME';
  const PARTNER = 'us-east-1_PARTNER';
  const iss = (pool: string) => (pool === HOME ? 'deployment' : pool === PARTNER ? 'partner' : 'untrusted');

  const poolClient = (pool: string, asked: Array<{ pool: string; username: string }>) => ({
    send: async (cmd: { input: { UserPoolId: string; Username: string } }) => {
      asked.push({ pool, username: cmd.input.Username });
      return { Username: cmd.input.Username, UserAttributes: [{ Name: 'email_verified', Value: 'true' }, { Name: 'email', Value: `${cmd.input.Username}@${pool}.example` }, { Name: 'name', Value: 'Partner Person' }] };
    },
  });

  test('the member of the partner pool is emailed at the address that pool holds', async () => {
    const asked: Array<{ pool: string; username: string }> = [];
    const directory = testDirectory({
      appInstanceArn: APP,
      issuers: [
        { issuer: poolIssuer('deployment', HOME), client: poolClient(HOME, asked) },
        { issuer: poolIssuer('partner', PARTNER), client: poolClient(PARTNER, asked) },
      ],
      identities: {
        resolve: async () => null,
        subjectsOf: async (arn) => (arn === user('0192f0e0-0000-7000-8000-000000000001')
          ? [{ issuer: iss(PARTNER), subject: 'partner-raw-sub' }]
          : []),
      },
    });
    const res = await emailPeople({
      personArns: [user('0192f0e0-0000-7000-8000-000000000001')],
      kind: 'conversation', subject: 's', bodyText: 'b',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { directory, send: sendAll as any },
    });
    expect(res.emailed).toEqual(['partner-raw-sub@us-east-1_PARTNER.example']);
    // The partner pool was asked, by the subject it knows; the home pool was never asked.
    expect(asked).toEqual([{ pool: PARTNER, username: 'partner-raw-sub' }]);
  });

  test('an untrusted issuer is never asked, and the person is skipped', async () => {
    const asked: Array<{ pool: string; username: string }> = [];
    const directory = testDirectory({
      appInstanceArn: APP,
      issuers: [{ issuer: poolIssuer('deployment', HOME), client: poolClient(HOME, asked) }],
      identities: { resolve: async () => null, subjectsOf: async () => [{ issuer: iss('us-east-1_EVIL'), subject: 'x' }] },
    });
    const res = await emailPeople({
      personArns: [user('p')], kind: 'conversation', subject: 's', bodyText: 'b',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { directory, send: sendAll as any },
    });
    expect(res).toMatchObject({ emailed: [], skipped: ['p'] });
    expect(asked).toEqual([]);
  });
});

/**
 * WHO gets notified comes from live channel MEMBERSHIP, not from the channel's Metadata roster.
 *
 * THE DEFECT. Channel Metadata is member-WRITABLE — a channel's creator is a moderator of their own
 * channel and holds `chime:UpdateChannel`, which rewrites Name and Metadata in ONE call that IAM cannot
 * split. Deriving the recipient list from `Metadata.participants` therefore let any member add a `sub`
 * and have the assistant's messages emailed to that person: a member-controlled path to sending someone
 * else the contents of a conversation, out of band. Membership is not forgeable that way — adding a
 * member is a separate, moderated `CreateChannelMembership` that shows up in the conversation.
 */
describe('recipients come from membership, with contact details from the directory', () => {
  const NATIVE_MEMBER = 'owner';
  const OUTSIDER = 'mallory';

  /** A roster that names an OUTSIDER — exactly what a tampering member would write. */
  const tamperedRoster = JSON.stringify({
    participants: [{ sub: NATIVE_MEMBER, role: 'owner' }, { sub: OUTSIDER, role: 'editor' }],
  });

  const chimeWith = (memberArns: string[], metadata: string) => taggedChime('premium', (cmd) => (
    cmd.constructor.name === 'ListChannelMembershipsCommand'
      ? { ChannelMemberships: memberArns.map((arn) => ({ Member: { Arn: arn } })) }
      : { Channel: { Metadata: metadata } }
  ));

  const run = async (memberArns: string[], metadata: string, asked: string[]) =>
    fanOutChannelNotification({
      channelArn: CHANNEL,
      bearerArn: 'b',
      messageText: 'the assistant said something',
      directive: { notify: { email: true } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chimeWith(memberArns, metadata) as any, directory: directoryOf([], asked), send: sendAll as any, isEmailConversation: async () => true },
    });

  test('a sub in the roster who is NOT a member is never emailed', async () => {
    const asked: string[] = [];
    const res = await run([user(NATIVE_MEMBER)], tamperedRoster, asked);
    expect(res.emailed).toEqual(['owner@example.com']);
    expect(asked).not.toContain(OUTSIDER);
  });

  test('a member absent from the roster is still emailed', async () => {
    const res = await run([user(NATIVE_MEMBER)], JSON.stringify({ participants: [] }), []);
    expect(res.emailed).toEqual(['owner@example.com']);
  });

  test('bots are excluded — they have no directory record to resolve', async () => {
    const asked: string[] = [];
    const res = await run([user('owner'), `${APP}/bot/assistant`], '{}', asked);
    expect(res.emailed).toEqual(['owner@example.com']);
    expect(asked).not.toContain('assistant');
  });

  test('every member is a person, whatever their id looks like: no id is skipped for its shape', async () => {
    // An id that once marked a member as federated is an id like any other; the directory decides.
    const res = await run([user('admin1'), user('fed_' + 'a'.repeat(40))], '{}', []);
    expect(res.emailed.sort()).toEqual(['admin1@example.com', `fed_${'a'.repeat(40)}@example.com`].sort());
  });
});

/**
 * EMAIL IS SENT ONLY IN THE ADMIN CONVERSATION.
 *
 * Decided from the live channel's immutable `aeChannelKind` tag, never from a stored copy or from
 * member-writable Metadata. Every other conversation sends no email, whatever its messages ask for.
 */
describe('only the admin conversation sends email', () => {
  const member = (id: string) => ({ Member: { Arn: user(id) } });
  const chimeTagged = (tags: Array<{ Key: string; Value: string }> | Error, members: string[]) => ({
    send: async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'ListTagsForResourceCommand') {
        if (tags instanceof Error) throw tags;
        return { Tags: tags };
      }
      return { ChannelMemberships: members.map(member) };
    },
  });
  const run = (chime: unknown, sends: string[][]) => fanOutChannelNotification({
    channelArn: `${APP}/channel/admin-notices`, bearerArn: 'b', messageText: 'x',
    directive: { notify: { email: true } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps: { chime: chime as any, directory: directoryOf(), send: (async (r: Array<{ email: string }>) => { sends.push(r.map((x) => x.email)); return { sent: r.map((x) => x.email), failed: [] }; }) as any },
  });

  test('the admin conversation emails its members, resolved by the directory', async () => {
    const sends: string[][] = [];
    const res = await run(chimeTagged([{ Key: 'aeChannelKind', Value: 'admin-notifications' }, { Key: 'classification', Value: 'admin' }], ['admin1']), sends);
    expect(res.emailed).toEqual(['admin1@example.com']);
    expect(sends).toEqual([['admin1@example.com']]);
  });

  test('any other conversation sends nothing, even when a message asks for email', async () => {
    const sends: string[][] = [];
    const res = await run(chimeTagged([{ Key: 'classification', Value: 'premium' }], ['owner']), sends);
    expect(res).toMatchObject({ emailed: [], emailOff: true });
    expect(sends).toEqual([]);
  });

  test('an assistant message addressed to @all emails the members in any conversation, read live from membership', async () => {
    const sends: string[][] = [];
    const res = await fanOutChannelNotification({
      channelArn: `${APP}/channel/ordinary`, bearerArn: 'b', messageText: '@all x', directive: { notify: { email: true } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chimeTagged([{ Key: 'classification', Value: 'premium' }], ['owner']) as any, directory: directoryOf(), send: (async (r: Array<{ email: string }>) => { sends.push(r.map((x) => x.email)); return { sent: r.map((x) => x.email), failed: [] }; }) as any },
    });
    expect(res.emailOff).toBeUndefined();
    expect(sends).toEqual([['owner@example.com']]);
  });

  test('a tag that cannot be read sends nothing (fail closed)', async () => {
    const sends: string[][] = [];
    const res = await run(chimeTagged(Object.assign(new Error('throttled'), { name: 'ThrottledClientException' }), ['owner']), sends);
    expect(res).toMatchObject({ emailed: [], emailOff: true });
    expect(sends).toEqual([]);
  });

  test('no channel-context read: recipients come from live membership only', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'lambda', 'src', 'lib', 'channel-notify.ts'), 'utf8');
    expect(src).not.toMatch(/channel-context-client/);
  });
});

/**
 * A MENTION ADDRESSES THE EMAIL: "The single recipient email should be message with
 * mention triggering single email", from anyone, but only when the directive asks for email.
 */
describe('a mention addresses the email, to members only', () => {
  // An ORDINARY conversation: no admin tag, so only an addressed email can leave it.
  const chime = (members: string[]) => ({
    send: async (cmd: { constructor: { name: string } }) => (cmd.constructor.name === 'ListTagsForResourceCommand'
      ? { Tags: [{ Key: 'classification', Value: 'premium' }] }
      : { ChannelMemberships: members.map((id) => ({ Member: { Arn: user(id) } })) }),
  });
  const run = (over: Partial<Parameters<typeof fanOutChannelNotification>[0]>, members: string[], sent: Array<{ to: string[]; text: string }>) =>
    fanOutChannelNotification({
      channelArn: CHANNEL, bearerArn: 'b', messageText: 'x',
      directive: { notify: { email: true } },
      ...over,
      deps: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chime: chime(members) as any, directory: directoryOf(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        send: (async (r: Array<{ email: string }>, msg: { bodyText: string; subject: string }) => { sent.push({ to: r.map((x) => x.email), text: msg.bodyText, subject: msg.subject } as never); return { sent: r.map((x) => x.email), failed: [] }; }) as any,
      },
    });

  test('an assistant\'s message emails the one member it mentions, in an ordinary conversation', async () => {
    const sent: Array<{ to: string[]; text: string }> = [];
    const res = await run({ messageText: '@<Riley Oncall|riley> Report generation is running slow.' }, ['riley', 'priya'], sent);
    expect(res.emailed).toEqual(['riley@example.com']);
    // The reader sees the name, not the token's grammar or the id.
    expect(sent[0].text).toBe('@Riley Oncall Report generation is running slow.');
  });

  test('a mention of someone who is not a member emails nobody, and says so', async () => {
    const sent: Array<{ to: string[]; text: string }> = [];
    const res = await run({ messageText: '@<Outsider|outsider> hello' }, ['riley'], sent);
    expect(res).toMatchObject({ emailed: [], skipped: ['outsider'] });
    expect(sent).toEqual([]);
  });

  test('a person\'s mention emails the member they mention, and not themselves', async () => {
    const sent: Array<{ to: string[]; text: string }> = [];
    const res = await run({
      personSent: true, senderArn: user('priya'),
      messageText: '@<Riley Oncall|riley> @<Priya Raman|priya> can you look?',
    }, ['riley', 'priya'], sent);
    expect(res.emailed).toEqual(['riley@example.com']);
  });

  test('a person\'s directive cannot name its own targets: only mentioned members are reached', async () => {
    const sent: Array<{ to: string[]; text: string }> = [];
    const res = await run({
      personSent: true, senderArn: user('priya'),
      messageText: '@<Riley Oncall|riley> fyi',
      directive: { notify: { email: true }, targets: [{ person: user('someone-else') }] },
    }, ['riley', 'priya'], sent);
    expect(res.emailed).toEqual(['riley@example.com']);
  });

  test('a person\'s @all emails every other member, and not themselves', async () => {
    const sent: Array<{ to: string[]; text: string }> = [];
    const res = await run({ personSent: true, senderArn: user('priya'), messageText: '@all the plan changed' }, ['riley', 'priya'], sent);
    expect(res.emailed).toEqual(['riley@example.com']);
  });

  test('an assistant\'s @humans notice leaves out the people it excludes, and a person\'s exclusion is not read', async () => {
    const directive = parseNotifyDirective(JSON.stringify(notifyDirective({ conversationId: 'c', exclude: ['priya'] })))!;
    expect(directive.exclude).toEqual(['priya']);
    const sent: Array<{ to: string[]; text: string }> = [];
    const res = await run({ senderArn: `${APP}/bot/b`, messageText: '@humans A meeting has started', directive }, ['riley', 'priya'], sent);
    expect(res.emailed).toEqual(['riley@example.com']);
    const all = await run({ senderArn: `${APP}/bot/b`, messageText: '@humans A meeting has started', directive: { ...directive, exclude: undefined } }, ['riley', 'priya'], []);
    expect(all.emailed.sort()).toEqual(['priya@example.com', 'riley@example.com']);
  });

  test('a person\'s @humans emails every other member, and the email reads without the token', async () => {
    const sent: Array<{ to: string[]; text: string }> = [];
    const res = await run({ personSent: true, senderArn: user('priya'), messageText: '@humans the plan changed' }, ['riley', 'priya'], sent);
    expect(res.emailed).toEqual(['riley@example.com']);
  });

  test.each([
    ['a room address', '.Carol confidential @humans'],
    ['a mention of someone else', '.Carol confidential @<Riley Oncall|riley>'],
  ])('a private message with %s emails nobody', async (_label, messageText) => {
    const sent: Array<{ to: string[]; text: string }> = [];
    const res = await run({ personSent: true, privateMessage: true, senderArn: user('priya'), messageText }, ['riley', 'priya'], sent);
    expect(res).toMatchObject({ emailed: [], emailOff: true });
    expect(sent).toEqual([]);
  });

  test('a person\'s Metadata does not choose where the email links, and an assistant\'s directive does', async () => {
    const asked = async (extra: Record<string, unknown>) => {
      const sent: Array<{ to: string[]; text: string }> = [];
      await run({ appUrl: 'https://app.example', messageText: '@all the plan changed', directive: { notify: { email: true }, conversationId: 'chosen-conversation' }, ...extra }, ['riley', 'priya'], sent);
      return sent[0].text;
    };
    expect(await asked({ senderArn: 'arn:aws:chime:us-east-1:1:app-instance/a/bot/b' })).toContain('chosen-conversation');
    expect(await asked({ personSent: true, senderArn: user('priya') })).not.toContain('chosen-conversation');
  });

  test('a person\'s subject line is not used: their Metadata is theirs to write', async () => {
    const sent: Array<{ to: string[]; text: string }> = [];
    await run({ personSent: true, senderArn: user('priya'), messageText: '@all the plan changed', directive: { notify: { email: true }, subject: 'Reset your password now' } }, ['riley', 'priya'], sent);
    expect(sent).toHaveLength(1);
    expect((sent[0] as unknown as { subject: string }).subject).not.toBe('Reset your password now');
  });

  test('a person who mentions no one sends nothing, even in the admin conversation\'s shape', async () => {
    const sent: Array<{ to: string[]; text: string }> = [];
    const res = await run({ personSent: true, senderArn: user('priya'), messageText: 'no mention here' }, ['riley'], sent);
    expect(res).toMatchObject({ emailed: [], emailOff: true });
    expect(sent).toEqual([]);
  });
});

describe('a notification links into the conversation it is about', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { conversationDeepLink } = require('../../lambda/src/lib/channel-notify');

  it('builds the link from the deployment origin and a channel id, in the shape the share email uses', () => {
    expect(conversationDeepLink('https://chat.example.com', 'conv-ops-1-abc'))
      .toBe('https://chat.example.com?conversation=conv-ops-1-abc');
  });

  it('builds no link without an origin, without an id, or from anything that is not an id', () => {
    expect(conversationDeepLink('', 'conv-1')).toBeUndefined();
    expect(conversationDeepLink('https://chat.example.com', undefined)).toBeUndefined();
    expect(conversationDeepLink('https://chat.example.com', 'x" onclick="evil')).toBeUndefined();
    expect(conversationDeepLink('https://chat.example.com', 'https://elsewhere.example')).toBeUndefined();
  });

  it('reads the conversation id from the directive, and only as a string', () => {
    expect(parseNotifyDirective(JSON.stringify({ notify: { email: true }, notifyConversationId: 'conv-9' }))?.conversationId)
      .toBe('conv-9');
    expect(parseNotifyDirective(JSON.stringify({ notify: { email: true }, notifyConversationId: 42 }))?.conversationId)
      .toBeUndefined();
  });

  it('puts the link in both the text and the HTML body when the directive names a conversation', async () => {
    const sent: Array<{ bodyText: string; bodyHtml?: string }> = [];
    await fanOutChannelNotification({
      channelArn: `${APP}/channel/conv-parent`,
      bearerArn: `${APP}/bot/advisor`,
      appUrl: 'https://chat.example.com',
      messageText: 'Report generation is running slow. A new conversation of type "ops" is open for it.',
      directive: { notify: { email: true }, targets: [{ person: user('lead') }], conversationId: 'conv-ops-new' },
      deps: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chime: taggedChime('premium') as any,
        directory: directoryOf(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        send: (async (_r: unknown, content: { bodyText: string; bodyHtml?: string }) => {
          sent.push(content);
          return { sent: ['lead@example.com'], failed: [] };
        }) as any,
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].bodyText).toContain('View it here: https://chat.example.com?conversation=conv-ops-new');
    expect(sent[0].bodyHtml).toMatch(/<a href="https:\/\/chat\.example\.com\?conversation=conv-ops-new"[^>]*>Open conversation<\/a>/);
  });

  it('sends without a link, rather than a broken one, when the deployment has no origin', async () => {
    const sent: Array<{ bodyText: string; bodyHtml?: string }> = [];
    await fanOutChannelNotification({
      channelArn: `${APP}/channel/conv-parent`,
      bearerArn: `${APP}/bot/advisor`,
      appUrl: '',
      messageText: 'A new conversation is open.',
      directive: { notify: { email: true }, targets: [{ person: user('lead') }], conversationId: 'conv-ops-new' },
      deps: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chime: taggedChime('premium') as any,
        directory: directoryOf(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        send: (async (_r: unknown, content: { bodyText: string; bodyHtml?: string }) => {
          sent.push(content);
          return { sent: ['lead@example.com'], failed: [] };
        }) as any,
      },
    });
    expect(sent[0].bodyText).toBe('A new conversation is open.');
    expect(sent[0].bodyHtml).toBeUndefined();
  });
});

/**
 * THE SHARE EMAIL IS A `conversation-shared` NOTICE.
 *
 * A person added to a conversation is welcomed with an addressed message (`memberWelcome`, built by
 * `noticeMetadata`), and the bridge emails it on the explicit-targets path. That email is sent as kind
 * `conversation-shared`, so a person who muted that kind is not sent it, while their `conversation`
 * mail still goes. Driven from the builder the share path uses, through the parser and the fan-out.
 */
describe('the email to a person added to a conversation is a conversation-shared notice', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { noticeMetadata } = require('../../lambda/src/lib/assistant-notice');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { defaultEmailVoice } = require('../../lambda/src/lib/email-copy');
  const chime = taggedChime('premium');
  const ADDED = user('0192f0e0-0000-7000-8000-0000000000aa');

  const consentMuting = (muted: Record<string, string>, kinds: string[]) => ({
    preferences: async () => ({ muted }),
    unsubscribeUrl: async (a: { kind: string }) => { kinds.push(a.kind); return 'https://test.execute-api.us-east-1.amazonaws.com/email/preferences?t=x'; },
    replyAddress: async () => null,
  });

  const shareDirective = () => {
    const md = noticeMetadata('memberWelcome', { name: 'Riley', recap: 'Q3 plan', notifyPerson: ADDED, notifySubject: "You've been added to Q3 plan" });
    return parseNotifyDirective(JSON.stringify(md))!;
  };

  test('the share path names the kind, and the fan-out sends it as that kind', async () => {
    const directive = shareDirective();
    expect(directive.kind).toBe('conversation-shared');
    const kinds: string[] = [];
    const res = await fanOutChannelNotification({
      channelArn: CHANNEL, bearerArn: `${APP}/bot/advisor`, messageText: 'Welcome, Riley.', directive,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chime as any, directory: directoryOf(), send: sendAll as any, consent: consentMuting({}, kinds) as any, voice: defaultEmailVoice() },
    });
    expect(res.emailed).toEqual(['0192f0e0-0000-7000-8000-0000000000aa@example.com']);
    // The unsubscribe link minted for the mail names the kind it was sent as.
    expect(kinds).toEqual(['conversation-shared']);
  });

  test('the share\'s welcome is emailed under the conversation\'s name, with the email\'s own body and none of the chat\'s instructions', async () => {
    // The share names the conversation as the recap and no subject of its own.
    const md = noticeMetadata('memberWelcome', { name: 'Riley', recap: 'Q3 plan', notifyPerson: ADDED }, { channelArn: CHANNEL });
    const directive = parseNotifyDirective(JSON.stringify(md))!;
    const mails: Array<{ subject: string; bodyText: string }> = [];
    const capture = async (r: Array<{ email: string }>, m: { subject: string; bodyText: string }) => {
      mails.push({ subject: m.subject, bodyText: m.bodyText });
      return { sent: r.map((x) => x.email), failed: [] };
    };
    const chatLine = "Welcome, Riley. You've been added to Q3 plan.\n\n_Only you can see this message. Mention **@assistant** or **@all** to bring in the assistant; other messages are visible to everyone here, but I won't reply unless I'm mentioned._";
    const res = await fanOutChannelNotification({
      channelArn: CHANNEL, bearerArn: `${APP}/bot/advisor`, messageText: chatLine, directive, privateMessage: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chime as any, directory: directoryOf(), send: capture as any, consent: consentMuting({}, []) as any, voice: defaultEmailVoice() },
    });
    expect(res.emailed).toEqual(['0192f0e0-0000-7000-8000-0000000000aa@example.com']);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe("You've been added to Q3 plan");
    expect(mails[0].bodyText).toContain("You've been added to Q3 plan.");
    expect(mails[0].bodyText).not.toMatch(/Only you can see this message|@assistant|@all|\*\*|_Only/);
  });

  test('a person\'s message never chooses its email\'s body', async () => {
    const mails: string[] = [];
    const capture = async (r: Array<{ email: string }>, m: { bodyText: string }) => { mails.push(m.bodyText); return { sent: r.map((x) => x.email), failed: [] }; };
    const directive = parseNotifyDirective(JSON.stringify({ notify: { email: true }, notifyBody: 'Words the person did not write' }))!;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await fanOutChannelNotification({
      channelArn: CHANNEL, bearerArn: user('0192f0e0-0000-7000-8000-0000000000bb'), senderArn: user('0192f0e0-0000-7000-8000-0000000000bb'),
      messageText: '@all The plan is ready.', directive, personSent: true,
      deps: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chime: taggedChime('premium', () => ({ ChannelMemberships: [{ Member: { Arn: user('0192f0e0-0000-7000-8000-0000000000cc') } }] })) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        directory: directoryOf(), send: capture as any, consent: consentMuting({}, []) as any, voice: defaultEmailVoice(),
      },
    });
    log.mockRestore();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toContain('The plan is ready.');
    expect(mails[0]).not.toContain('Words the person did not write');
  });

  test('muting conversation email stops a message addressed to @all', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = await fanOutChannelNotification({
      channelArn: CHANNEL, bearerArn: `${APP}/bot/advisor`, messageText: '@all The brief is ready.', directive: { notify: { email: true } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chime as any, directory: directoryOf(), send: sendAll as any, consent: consentMuting({ 'email:conversation': 't' }, []) as any, voice: defaultEmailVoice() },
    });
    expect(res.emailed).toEqual([]);
    log.mockRestore();
  });

  test('muting conversation-shared stops it; muting conversation does not', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const muted = await fanOutChannelNotification({
      channelArn: CHANNEL, bearerArn: `${APP}/bot/advisor`, messageText: 'Welcome.', directive: shareDirective(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chime as any, directory: directoryOf(), send: sendAll as any, consent: consentMuting({ 'email:conversation-shared': 't' }, []) as any, voice: defaultEmailVoice() },
    });
    expect(muted.emailed).toEqual([]);
    const other = await fanOutChannelNotification({
      channelArn: CHANNEL, bearerArn: `${APP}/bot/advisor`, messageText: 'Welcome.', directive: shareDirective(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { chime: chime as any, directory: directoryOf(), send: sendAll as any, consent: consentMuting({ 'email:conversation': 't' }, []) as any, voice: defaultEmailVoice() },
    });
    expect(other.emailed).toHaveLength(1);
    log.mockRestore();
  });

  test('a directive cannot name a transactional kind, and a broadcast is always conversation', () => {
    expect(parseNotifyDirective(JSON.stringify({ notify: { email: true }, notifyTargets: [{ person: ADDED }], notifyKind: 'invitation' }))!.kind).toBeUndefined();
    expect(parseNotifyDirective(JSON.stringify({ notify: { email: true }, notifyKind: 'conversation-shared' }))!.kind).toBeUndefined();
    expect(notifyDirective({ kind: 'conversation-shared' })).not.toHaveProperty('notifyKind');
  });
});

/**
 * AN EMAIL ABOUT A CONVERSATION REACHES ONLY A PERSON WHOSE CURRENT CLEARANCE REACHES IT (`lib/email-clearance.ts`).
 *
 * Membership is not clearance: a member whose clearance was lowered stays a member until the membership
 * audit acts, and the audit reports by default. So every recipient, however they were named, is checked
 * against the conversation's classification tag with their clearance now, and anything that cannot be
 * read refuses. Each case is on a conversation of its own, so no tag a previous case read is remembered.
 */
describe('an email about a conversation reaches only a person cleared for it', () => {
  let n = 0;
  const conversation = () => `${APP}/channel/clearance-${++n}`;
  const members = (ids: string[]) => (cmd: { constructor: { name: string } }) => (cmd.constructor.name === 'ListChannelMembershipsCommand'
    ? { ChannelMemberships: ids.map((id) => ({ Member: { Arn: user(id) } })) }
    : {});
  const capture = (sent: string[][]) => (async (r: Array<{ email: string }>) => {
    sent.push(r.map((x) => x.email));
    return { sent: r.map((x) => x.email), failed: [] };
  });
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => warn.mockRestore());

  test('a mentioned member whose clearance does not reach the conversation is not emailed; a cleared one is', async () => {
    const sent: string[][] = [];
    const res = await fanOutChannelNotification({
      channelArn: conversation(), bearerArn: `${APP}/bot/advisor`,
      messageText: '@<Riley|riley> @<Dana|dana> the premium figures are in.',
      directive: { notify: { email: true } },
      deps: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chime: taggedChime('premium', members(['riley', 'dana'])) as any,
        directory: directoryOf([], [], { dana: async () => held('basic') }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        send: capture(sent) as any,
      },
    });
    expect(res.emailed).toEqual(['riley@example.com']);
    expect(res.skipped).toEqual(['dana']);
    expect(sent).toEqual([['riley@example.com']]);
  });

  test('an explicit target whose clearance does not reach the conversation is not emailed', async () => {
    const sent: string[][] = [];
    const res = await fanOutChannelNotification({
      channelArn: conversation(), bearerArn: `${APP}/bot/advisor`, messageText: 'Welcome.',
      directive: { notify: { email: true }, targets: [{ person: user('dana') }] },
      deps: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chime: taggedChime('premium') as any,
        directory: directoryOf([], [], { dana: async () => held('basic') }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        send: capture(sent) as any,
      },
    });
    expect(res).toMatchObject({ emailed: [], skipped: ['dana'] });
    expect(sent).toEqual([]);
  });

  test('a member of the admin conversation who does not hold the admin plane is not emailed', async () => {
    const sent: string[][] = [];
    const res = await fanOutChannelNotification({
      channelArn: conversation(), bearerArn: `${APP}/bot/admin`, messageText: 'An alarm fired.',
      directive: { notify: { email: true } },
      deps: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chime: taggedChime('admin', members(['ops', 'former'])) as any,
        directory: directoryOf([], [], { former: async () => held('premium') }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        send: capture(sent) as any,
        isEmailConversation: async () => true,
      },
    });
    expect(res.emailed).toEqual(['ops@example.com']);
    expect(res.skipped).toEqual(['former']);
  });

  test('a clearance that cannot be read, or that only a sign-in token could establish, emails nobody', async () => {
    const sent: string[][] = [];
    const res = await fanOutChannelNotification({
      channelArn: conversation(), bearerArn: `${APP}/bot/advisor`,
      messageText: '@<Riley|riley> @<Dana|dana> update',
      directive: { notify: { email: true } },
      deps: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chime: taggedChime('premium', members(['riley', 'dana'])) as any,
        directory: directoryOf([], [], {
          riley: async () => { throw Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' }); },
          dana: async () => ({ state: 'undetermined' as const, issuers: ['partner'] }),
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        send: capture(sent) as any,
      },
    });
    expect(res).toMatchObject({ emailed: [] });
    expect(res.skipped.sort()).toEqual(['dana', 'riley']);
    expect(sent).toEqual([]);
  });

  test('a conversation whose classification tag cannot be read emails nobody', async () => {
    for (const tags of [
      () => { throw Object.assign(new Error('denied'), { name: 'ForbiddenException' }); },
      () => ({ Tags: [] }),
      () => ({ Tags: [{ Key: 'classification', Value: 'not-a-classification' }] }),
    ]) {
      const sent: string[][] = [];
      const asked: string[] = [];
      const res = await fanOutChannelNotification({
        channelArn: conversation(), bearerArn: `${APP}/bot/advisor`,
        messageText: '@<Riley|riley> update',
        directive: { notify: { email: true }, targets: [{ person: user('riley') }] },
        deps: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          chime: { send: async (cmd: { constructor: { name: string } }) => (cmd.constructor.name === 'ListTagsForResourceCommand' ? tags() : {}) } as any,
          directory: directoryOf([], asked),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          send: capture(sent) as any,
        },
      });
      expect(res).toMatchObject({ emailed: [], skipped: ['riley'] });
      expect(sent).toEqual([]);
      // Nobody's contact is read for a conversation nobody can be cleared for.
      expect(asked).toEqual([]);
    }
  });
});
