/**
 * AN INVITATION NAMES ITS INVITEE BY THE AppInstanceUser MINTED FOR IT, NEVER BY AN ADDRESS (M-10, K2, B8).
 *
 * The invitations function (`lambda/src/invitations.ts`), as units against an in-memory `Tokens`, an Amazon
 * Chime SDK that knows who is a member and who moderates, and an exchange that mints:
 *
 *  - every refusal before anything is minted: a non-member, an archived conversation, a type that declares
 *    no invitations (or a context row that cannot say), a mode the type does not declare, a link where no
 *    `invitation-link` issuer reaches or the type's `linkClassifications` does not hold the classification, an
 *    inviter whose clearance does not reach it, a guest, a malformed address, and no landing page;
 *  - an issued invitation mints the invitee through the exchange, adds it as a DEFAULT member as the
 *    service admin, and writes a record naming the conversation, the inviter and the invitee, with no
 *    address in it anywhere; the email goes through the one fan-out as the transactional `invitation`
 *    kind, with no reply address (so its holder cannot post as the invitee before redeeming), to the
 *    address the inviter typed and nobody else; the link reaches the inviter only when no email carried it;
 *  - a record that cannot be written takes the membership back;
 *  - a member sees the invitations they issued, a moderator all of them; revoking marks the record and
 *    removes the invitee's membership, by the inviter or a moderator and nobody else; the console's two
 *    operations list and revoke the same way, recording the administrator.
 */
import { createInvitation, listForMember, revokeForMember, adminOperation, inviteeDirectory, type InvitationsDeps } from '../../lambda/src/invitations';
import { INVITATION_CHANNEL_ATTRIBUTE, INVITATIONS_BY_CHANNEL } from '../../lambda/src/lib/invitations';
import { edgeContext } from '../helpers/edge-context';
import { sendTransactionalMail } from '../../lambda/src/lib/transactional-mail';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const POOL_ISS = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Deployment';
const GUEST_ISS = 'urn:agentechelon:test:issuer:guest';
const INVITER = '0190c0de-0000-7000-8000-000000000001';
const OTHER = '0190c0de-0000-7000-8000-000000000002';
const MOD = '0190c0de-0000-7000-8000-000000000003';
const INVITEE = `${APP}/user/0190c0de-0000-7000-8000-0000000000ee`;
const CH = `${APP}/channel/room-1`;
const ADMIN = `${APP}/user/test-admin`;
const NOW = 1_800_000_000;

beforeAll(() => {
  process.env.APP_INSTANCE_ARN = APP;
  process.env.TRUSTED_ISSUERS = JSON.stringify([
    { id: 'deployment', kind: 'cognito-pool', pool: 'us-east-1_Deployment', iss: POOL_ISS, subject: ['sub'], clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true, groupsClaim: 'cognito:groups' },
    { id: 'guest', kind: 'guest', iss: GUEST_ISS, subject: ['sub'], clearance: { fixed: ['guest'], classifications: ['guest'] }, admin: false, groupsClaim: 'groups' },
  ]);
});

const ccf = () => Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });

function world(opts: { classification?: string; type?: string | null; archived?: boolean; members?: string[]; moderators?: string[]; failPut?: boolean } = {}) {
  const rows = new Map<string, Record<string, any>>();
  const members = new Set((opts.members ?? [INVITER, OTHER, MOD]).map((id) => `${APP}/user/${id}`));
  const moderators = new Set((opts.moderators ?? [MOD]).map((id) => `${APP}/user/${id}`));
  const added: any[] = [];
  const removed: any[] = [];
  const minted: any[] = [];
  const emails: any[] = [];
  const named: any[] = [];
  const doc = {
    async send(cmd: any) {
      const name = cmd.constructor.name;
      const i = cmd.input;
      if (name === 'GetCommand' && i.TableName === 'Context') {
        return { Item: opts.type === null ? undefined : { channelArn: CH, conversationType: opts.type ?? 'general' } };
      }
      if (name === 'PutCommand') {
        if (opts.failPut) throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
        if (rows.has(i.Item.pk)) throw ccf();
        rows.set(i.Item.pk, { ...i.Item });
        return {};
      }
      if (name === 'QueryCommand') {
        expect(i.IndexName).toBe(INVITATIONS_BY_CHANNEL);
        const c = i.ExpressionAttributeValues[':c'];
        return { Items: [...rows.values()].filter((r) => r[INVITATION_CHANNEL_ATTRIBUTE] === c).reverse() };
      }
      if (name === 'UpdateCommand') {
        const row = rows.get(i.Key.pk);
        if (!row) throw ccf();
        const v = i.ExpressionAttributeValues;
        if (i.UpdateExpression.includes('revokedAt')) {
          if (row.revokedAt !== undefined) throw ccf();
          Object.assign(row, { revokedAt: v[':now'], revokedBy: v[':by'] });
          return { Attributes: { ...row } };
        }
        if (i.UpdateExpression.includes('emailed')) { row.emailed = true; return {}; }
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const messaging = {
    async send(cmd: any) {
      const name = cmd.constructor.name;
      const i = cmd.input;
      if (name === 'DescribeChannelCommand') {
        if (!members.has(i.ChimeBearer)) throw Object.assign(new Error('no'), { name: 'ForbiddenException' });
        return { Channel: { ChannelArn: CH, Name: 'Quarterly plan' } };
      }
      if (name === 'ListTagsForResourceCommand') {
        return { Tags: [{ Key: 'classification', Value: opts.classification ?? 'standard' }, ...(opts.archived ? [{ Key: 'archived', Value: 'true' }] : [])] };
      }
      if (name === 'DescribeChannelModeratorCommand') {
        expect(i.ChimeBearer).toBe(ADMIN);
        if (!moderators.has(i.ChannelModeratorArn)) throw Object.assign(new Error('no'), { name: 'NotFoundException' });
        return { ChannelModerator: {} };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const lambda = {
    async send(cmd: any) {
      const payload = JSON.parse(new TextDecoder().decode(cmd.input.Payload));
      minted.push({ fn: cmd.input.FunctionName, ...payload });
      return { Payload: new TextEncoder().encode(JSON.stringify({ ok: true, personArn: INVITEE })) };
    },
  };
  const deps: InvitationsDeps = {
    doc, messaging, lambda,
    tokensTable: 'Tokens', contextTable: 'Context', appInstanceArn: APP, exchangeFunction: 'arn:exchange',
    landingOrigin: 'https://widget.example.com', linkReach: ['basic', 'standard'],
    adminBearer: async () => ADMIN,
    now: () => NOW * 1000,
    addMember: async (input) => { added.push(input); },
    removeMember: async (input) => { removed.push(input); },
    nameEvent: async (classification, channelArn, invitationId) => {
      named.push({ classification, channelArn, invitationId, emailsBefore: emails.length, rowsBefore: rows.size });
      return true;
    },
    mail: (m) => sendTransactionalMail(m, { email: (async (args: any) => {
      emails.push(args);
      const contact = await args.deps.directory.contactFor(args.personArns[0], 'email');
      return { emailed: contact ? [args.personArns[0]] : [], skipped: [], failed: [], muted: [] };
    }) as never,
    voice: async () => ({ copy: { ...(await import('../../lambda/src/lib/email-copy')).DEFAULT_EMAIL_COPY }, assistantName: 'Analyst' }) }),
  };
  return { rows, added, removed, minted, emails, named, deps };
}

const asCaller = (personId: string, body: unknown, opts: { groups?: string[]; method?: string; resource?: string; iss?: string; query?: Record<string, string> } = {}) => ({
  httpMethod: opts.method ?? 'POST',
  resource: opts.resource ?? '/invitations',
  queryStringParameters: opts.query ?? null,
  requestContext: { authorizer: edgeContext({ claims: { sub: `sub-${personId}`, iss: opts.iss ?? POOL_ISS, 'cognito:groups': opts.groups ?? ['standard'], name: 'Riley Inviter' }, personId }) },
  body: body === undefined ? null : JSON.stringify(body),
});

const parse = (res: { body: string }) => JSON.parse(res.body);
const invite = (w: ReturnType<typeof world>, body: Record<string, unknown> = {}, opts = {}) =>
  createInvitation(asCaller(INVITER, { channelArn: CH, name: 'Jordan', email: 'jordan@example.org', ...body }, opts), w.deps);

describe('issuing an invitation: every refusal comes before anything is minted', () => {
  it.each([
    ['a conversation the caller is not in', { members: [OTHER] }, {}, {}, 403, 'NOT_A_MEMBER'],
    ['an archived conversation', { archived: true }, {}, {}, 409, 'CONVERSATION_ARCHIVED'],
    ['a type that declares no invitations', { type: 'ops' }, {}, {}, 403, 'INVITATIONS_NOT_DECLARED'],
    ['a conversation whose type cannot be read', { type: null }, {}, {}, 403, 'INVITATIONS_NOT_DECLARED'],
    ['a mode the type does not declare', {}, { mode: 'carrier-pigeon' }, {}, 400, 'INVITATION_INVALID'],
    ['a link at a classification the type\'s link classifications does not hold', { classification: 'premium' }, { mode: 'link' }, { groups: ['premium'] }, 403, 'LINK_NOT_AVAILABLE'],
    ['an inviter whose clearance does not reach the conversation', { classification: 'standard' }, {}, { groups: ['basic'] }, 403, 'NOT_CLEARED'],
    ['an address that is not one', {}, { email: 'not-an-address' }, {}, 400, 'INVITATION_INVALID'],
    ['no display name', {}, { name: '  ' }, {}, 400, 'INVITATION_INVALID'],
  ])('refuses %s', async (_what, worldOpts, body, callerOpts, status, code) => {
    const w = world(worldOpts as never);
    const res = await invite(w, body as never, callerOpts);
    expect({ status: res.statusCode, code: parse(res).code }).toEqual({ status, code });
    expect(w.minted).toEqual([]);
    expect(w.added).toEqual([]);
    expect(w.rows.size).toBe(0);
  });

  it('refuses a link where the deployment declares no invitation-link issuer', async () => {
    const w = world();
    w.deps.linkReach = [];
    const res = await invite(w, { mode: 'link' });
    expect(parse(res).code).toBe('LINK_NOT_AVAILABLE');
    expect(w.minted).toEqual([]);
  });

  it('refuses a guest, and issues nothing with no landing page', async () => {
    const w = world();
    const guest = await createInvitation(asCaller(INVITER, { channelArn: CH, name: 'Jordan' }, { iss: GUEST_ISS }), w.deps);
    expect(guest.statusCode).toBe(401);
    w.deps.landingOrigin = '';
    const res = await invite(w);
    expect({ status: res.statusCode, code: parse(res).code }).toEqual({ status: 503, code: 'INVITATIONS_UNAVAILABLE' });
    expect(w.minted).toEqual([]);
  });
});

describe('issuing an invitation', () => {
  it('mints the invitee through the exchange, adds it, and records it by person, with no address anywhere', async () => {
    const w = world();
    const res = await invite(w);
    expect(res.statusCode).toBe(201);
    expect(w.minted).toEqual([{ fn: 'arn:exchange', op: 'mint-invitee', name: 'Jordan', expirationDays: 7, classification: 'standard', inviterArn: `${APP}/user/${INVITER}` }]);
    expect(w.added).toEqual([{ channelArn: CH, inviteeArn: INVITEE, bearerArn: ADMIN }]);
    const [record] = [...w.rows.values()];
    expect(record).toMatchObject({
      kind: 'invitation', channelArn: CH, personArn: INVITEE, inviterArn: `${APP}/user/${INVITER}`, mode: 'sign-in',
      classification: 'standard', conversationType: 'general', conversationName: 'Quarterly plan', inviteeName: 'Jordan',
      [INVITATION_CHANNEL_ATTRIBUTE]: CH, expiresAt: NOW + 7 * 86_400, emailed: true,
    });
    expect(record.pk).toMatch(/^invitation#[0-9a-f]{64}$/);
    // K2: the address is the email's delivery route and is stored nowhere.
    expect(JSON.stringify(record)).not.toContain('jordan@example.org');
    // The link travelled in the email alone.
    const body = parse(res);
    expect(body.emailed).toBe(true);
    expect(body).not.toHaveProperty('link');
    expect(JSON.stringify(body)).not.toContain('jordan@example.org');
  });

  it('emails the invitee through the one fan-out, as the transactional kind, with no reply address, to the typed address alone', async () => {
    const w = world();
    await invite(w);
    expect(w.emails).toHaveLength(1);
    const [mail] = w.emails;
    expect(mail.kind).toBe('invitation');
    expect(mail.personArns).toEqual([INVITEE]);
    // No `channelArn`, so the fan-out mints no reply address for the invitee.
    expect(mail).not.toHaveProperty('channelArn');
    expect(mail.bodyText).toMatch(/https:\/\/widget\.example\.com\/invite\.html#t=[A-Za-z0-9_-]{43}/);
    expect(mail.subject).toBe('Riley Inviter invited you to a conversation');
    expect(await mail.deps.directory.contactFor(INVITEE, 'email')).toEqual({ address: 'jordan@example.org', name: 'Jordan' });
    expect(await mail.deps.directory.contactFor(`${APP}/user/${OTHER}`, 'email')).toBeNull();
    expect(await mail.deps.directory.findByAddress('deployment', 'jordan@example.org')).toBeNull();
  });

  it('hands the inviter the link only when no email carried it', async () => {
    const w = world();
    const res = await invite(w, { email: undefined });
    const body = parse(res);
    expect(body.emailed).toBe(false);
    expect(body.link).toMatch(/^https:\/\/widget\.example\.com\/invite\.html#t=[A-Za-z0-9_-]{43}$/);
    expect(w.emails).toEqual([]);
  });

  it('issues a link invitation where the issuer and the type both reach the classification', async () => {
    const w = world({ classification: 'basic' });
    const res = await invite(w, { mode: 'link' });
    expect(res.statusCode).toBe(201);
    expect([...w.rows.values()][0].mode).toBe('link');
  });

  it('takes the membership back when the record cannot be written', async () => {
    const w = world({ failPut: true });
    const res = await invite(w);
    expect(res.statusCode).toBe(503);
    expect(w.removed).toEqual([{ channelArn: CH, inviteeArn: INVITEE, bearerArn: ADMIN }]);
    expect(w.emails).toEqual([]);
  });

  it('the invitee directory answers for the invitee alone', async () => {
    const d = inviteeDirectory(INVITEE, 'a@b.example', 'A');
    expect(await d.displayNameFor(INVITEE)).toBe('A');
    expect(await d.contactFor(INVITEE, 'sms' as never)).toBeNull();
    expect(await d.personOf('a@b.example')).toBeNull();
  });
});

describe('seeing and revoking invitations', () => {
  async function seeded() {
    const w = world();
    await invite(w);
    await createInvitation(asCaller(MOD, { channelArn: CH, name: 'Sam' }, {}), w.deps);
    return w;
  }

  it('a member sees the invitations they issued; a moderator sees every one', async () => {
    const w = await seeded();
    const mine = parse(await listForMember(asCaller(INVITER, undefined, { method: 'GET', query: { channelArn: CH } }), w.deps));
    expect(mine.invitations.map((i: any) => i.inviteeName)).toEqual(['Jordan']);
    expect(mine.invitations[0]).toMatchObject({ status: 'pending', mode: 'sign-in', emailed: true });
    expect(mine.invitations[0]).not.toHaveProperty('pk');
    const all = parse(await listForMember(asCaller(MOD, undefined, { method: 'GET', query: { channelArn: CH } }), w.deps));
    expect(all.invitations.map((i: any) => i.inviteeName).sort()).toEqual(['Jordan', 'Sam']);
  });

  it('refuses a list to somebody not in the conversation', async () => {
    const w = await seeded();
    const res = await listForMember(asCaller('0190c0de-0000-7000-8000-000000000009', undefined, { method: 'GET', query: { channelArn: CH } }), w.deps);
    expect(res.statusCode).toBe(403);
  });

  it('revoking marks the record and removes the invitee, by the inviter or a moderator only', async () => {
    const w = await seeded();
    const id = [...w.rows.values()].find((r) => r.inviteeName === 'Jordan')!.invitationId;
    const refused = await revokeForMember(asCaller(OTHER, { channelArn: CH, invitationId: id }, { resource: '/invitations/revoke' }), w.deps);
    expect(refused.statusCode).toBe(403);
    expect(w.removed).toEqual([]);
    const res = await revokeForMember(asCaller(INVITER, { channelArn: CH, invitationId: id }, { resource: '/invitations/revoke' }), w.deps);
    expect(res.statusCode).toBe(200);
    expect(parse(res).invitation).toMatchObject({ status: 'revoked', revokedBy: `${APP}/user/${INVITER}` });
    expect(w.removed).toEqual([{ channelArn: CH, inviteeArn: INVITEE, bearerArn: ADMIN }]);
    const samId = [...w.rows.values()].find((r) => r.inviteeName === 'Sam')!.invitationId;
    const byMod = await revokeForMember(asCaller(MOD, { channelArn: CH, invitationId: samId }, { resource: '/invitations/revoke' }), w.deps);
    expect(byMod.statusCode).toBe(200);
  });

  it('the console lists every invitation and revokes one, recording the administrator', async () => {
    const w = await seeded();
    const listed = await adminOperation({ op: 'admin-list', channelArn: CH }, w.deps);
    expect((listed.body as any).invitations).toHaveLength(2);
    const id = [...w.rows.values()][0].invitationId;
    expect((await adminOperation({ op: 'admin-revoke', channelArn: CH, invitationId: id }, w.deps)).status).toBe(400);
    const revoked = await adminOperation({ op: 'admin-revoke', channelArn: CH, invitationId: id, actor: '0190c0de-0000-7000-8000-0000000000ad' }, w.deps);
    expect(revoked.status).toBe(200);
    expect((revoked.body as any).invitation.revokedBy).toBe('admin:0190c0de-0000-7000-8000-0000000000ad');
    expect(w.removed).toHaveLength(1);
    expect((await adminOperation({ op: 'admin-revoke', channelArn: CH, invitationId: 'nope', actor: 'x' }, w.deps)).status).toBe(404);
  });
});

describe('an invitation records why it was made, and names invitation-sent to its router by ids (ADR-061 decision 1)', () => {
  it('records the one line the inviter gave, its whitespace folded, and refuses one that is not text or too long', async () => {
    const w = world();
    expect((await invite(w, { reason: '  to review\n the  budget ' })).statusCode).toBe(201);
    expect([...w.rows.values()][0].reason).toBe('to review the budget');
    expect([...w.rows.values()][0]).not.toHaveProperty('role');
    const none = world();
    await invite(none);
    expect([...none.rows.values()][0]).not.toHaveProperty('reason');
    for (const reason of [42, 'x'.repeat(281)]) {
      const r = world();
      const res = await invite(r, { reason });
      expect(res.statusCode).toBe(400);
      expect(parse(res).code).toBe('INVITATION_INVALID');
      expect(r.minted).toEqual([]);
    }
  });

  it('refuses a participant role before anything is minted: no conversation type declares one invitable yet', async () => {
    const w = world();
    const res = await invite(w, { role: 'reviewer' });
    expect(res.statusCode).toBe(400);
    expect(parse(res).code).toBe('ROLE_NOT_DECLARED');
    expect(w.minted).toEqual([]);
    expect(w.rows.size).toBe(0);
  });

  it('names the event once the record is written and the email sent, with the conversation and the invitation id alone', async () => {
    const w = world();
    const res = await invite(w);
    const [record] = [...w.rows.values()];
    expect(w.named).toEqual([{ classification: 'standard', channelArn: CH, invitationId: record.invitationId, emailsBefore: 1, rowsBefore: 1 }]);
    // The invitation's one email is the invitations function's own, whether or not a workflow runs.
    expect(w.emails).toHaveLength(1);
    expect(res.statusCode).toBe(201);
  });

  it('names nothing when the invitation was not made, and a naming that fails does not fail the invitation', async () => {
    const refused = world({ failPut: true });
    await invite(refused);
    expect(refused.named).toEqual([]);
    const w = world();
    w.deps.nameEvent = async () => { throw new Error('throttled'); };
    expect((await invite(w)).statusCode).toBe(201);
  });
});
