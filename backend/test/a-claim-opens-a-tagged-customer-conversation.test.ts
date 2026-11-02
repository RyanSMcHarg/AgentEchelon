/**
 * PATH B (B6, PLAN §16.6 P-12): a visitor registers, the claim rides in the sign-in link emailed to the
 * address they gave, and the signed-in account redeems it, which opens a `customer-engagement`
 * conversation for the account tagged with the visitor's conversation.
 *
 * The B6 deny-tests for path B, as units against an in-memory `Tokens`: a claim is never found or bound
 * by email (it is found by its token's hash alone, and an email in the body is ignored); a claim redeems
 * once; a registration is the visitor's own and is made only with a guest token; an account whose
 * clearance does not reach the target consumes nothing; a creator that fails leaves the claim
 * redeemable. The live proof is `scripts/deny-test-upgrade.mjs`.
 */
import { register, claim } from '../lambda/src/guest-upgrade';
import { tokenKey } from '../lambda/src/lib/tokens';
import { registrationKeyOf } from '../lambda/src/lib/upgrade';
import { claimTargetOf, GUEST_VISITOR_TYPE } from '../lib/config/conversation-types';
import { edgeContext } from './helpers/edge-context';
import { defaultEmailVoice } from '../lambda/src/lib/email-copy';
import { sendTransactionalMail, type TransactionalMail } from '../lambda/src/lib/transactional-mail';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const GUEST_ISS = 'https://guest.example.com/guest';
const CUSTOMER_ISS = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Customers';
const STAFF_ISS = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Deployment';
const VISITOR_ID = '0190c0de-0000-7000-8000-00000000000a';
const ACCOUNT_ID = '0190c0de-0000-7000-8000-00000000000b';
const NOW = 1_800_000_000;

beforeAll(() => {
  process.env.APP_INSTANCE_ARN = APP;
  process.env.TRUSTED_ISSUERS = JSON.stringify([
    { id: 'deployment', kind: 'cognito-pool', pool: 'us-east-1_Deployment', iss: STAFF_ISS, subject: ['sub'], clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true, groupsClaim: 'cognito:groups' },
    { id: 'customers', kind: 'cognito-pool', pool: 'us-east-1_Customers', iss: CUSTOMER_ISS, subject: ['sub'], clearance: { fixed: ['customer'], classifications: ['customer'] }, admin: false, groupsClaim: 'cognito:groups' },
    { id: 'guest', kind: 'guest', iss: GUEST_ISS, subject: ['sub'], clearance: { fixed: ['guest'], classifications: ['guest'] }, admin: false, groupsClaim: 'cognito:groups' },
  ]);
});

function tokens() {
  const rows = new Map<string, Record<string, any>>();
  const ccf = () => Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
  return {
    rows,
    async send(cmd: any) {
      const name = cmd.constructor.name;
      const i = cmd.input;
      if (name === 'GetCommand') return { Item: rows.get(i.Key.pk) };
      if (name === 'PutCommand') {
        const prev = rows.get(i.Item.pk);
        if (prev && (i.ConditionExpression === 'attribute_not_exists(pk)' || !['open', 'awaiting-approval'].includes(prev.status) || prev.personArn !== i.Item.personArn)) throw ccf();
        rows.set(i.Item.pk, i.Item);
        return {};
      }
      if (name === 'UpdateCommand') {
        const row = rows.get(i.Key.pk);
        const v = i.ExpressionAttributeValues ?? {};
        if (i.UpdateExpression.startsWith('REMOVE')) {
          if (!row || row.claimedBy !== v[':me']) throw ccf();
          delete row.consumedAt; delete row.claimedBy;
          return {};
        }
        if (i.UpdateExpression.includes(':claimed')) {
          if (!row || row.status !== 'open') throw ccf();
          Object.assign(row, { status: 'claimed', claimedBy: v[':me'], conversationArn: v[':c'] });
          return {};
        }
        // A redemption, or a revocation: both set consumedAt once.
        if (!row || row.consumedAt !== undefined || (v[':now'] !== undefined && i.ConditionExpression.includes('expiresAt') && !(row.expiresAt > v[':now']))) throw ccf();
        row.consumedAt = v[':now'];
        if (i.ExpressionAttributeNames) for (const [k, n] of Object.entries(i.ExpressionAttributeNames)) row[n as string] = v[`:x${k.slice(2)}`];
        return { Attributes: row };
      }
      throw new Error(name);
    },
  };
}

/** The creators: the customer one opens the conversation; the guest one assesses (no assessment here) and retires the visit. */
const creatorOk = () => ({
  calls: [] as any[],
  async send(cmd: any) {
    const req = JSON.parse(new TextDecoder().decode(cmd.input.Payload));
    if (req.kind === 'assess') return { Payload: new TextEncoder().encode(JSON.stringify({ ok: false, code: 'NO_ASSESSMENT', error: 'none' })) };
    if (req.kind === 'retire') return { Payload: new TextEncoder().encode(JSON.stringify({ ok: true })) };
    this.calls.push(req);
    return { Payload: new TextEncoder().encode(JSON.stringify({ ok: true, channelArn: `${APP}/channel/customer-1` })) };
  },
});

/** The claim email, captured: its one recipient and the link it carries. */
const mails: Array<{ personArns: string[]; kind: string; bodyText: string; address: string | null }> = [];
const mailer = async (args: any) => {
  const contact = await args.deps.directory.contactFor(args.personArns[0], 'email');
  mails.push({ personArns: args.personArns, kind: args.kind, bodyText: args.bodyText, address: contact?.address ?? null });
  return { emailed: args.personArns, skipped: [], failed: [], muted: [] };
};
/** The claim token the last email's link carries. */
const mailedToken = (): string => decodeURIComponent(/#claim=([^\s]+)/.exec(mails[mails.length - 1].bodyText)![1]);

const guestEvent = (body: unknown, ch = 'guest-ch-1') => ({
  httpMethod: 'POST', resource: '/guest/register',
  requestContext: { authorizer: edgeContext({ claims: { sub: 'g-sub', iss: GUEST_ISS, ch }, personId: VISITOR_ID }) },
  body: JSON.stringify(body),
});
const accountEvent = (body: unknown, iss = CUSTOMER_ISS, personId = ACCOUNT_ID) => ({
  httpMethod: 'POST', resource: '/upgrade/claim',
  requestContext: { authorizer: edgeContext({ claims: { sub: 'c-sub', iss }, personId }) },
  body: JSON.stringify(body),
});

const funnelEvents: Array<{ eventType: string; personId: string; properties: Record<string, unknown> }> = [];
const deps = (doc: ReturnType<typeof tokens>, lambda = creatorOk()) => ({
  doc, lambda, tokensTable: 'tokens', appInstanceArn: APP, creators: { customer: 'creator-customer' }, now: () => NOW * 1000,
  guestCreator: 'creator-guest', guestClassification: 'guest', approval: 'none' as const, appUrl: 'https://chat.example.com',
  mail: (m: TransactionalMail) => sendTransactionalMail(m, { email: mailer as never, voice: async () => defaultEmailVoice() }),
  funnel: async (e: { eventType: string; personId: string; properties: Record<string, string | number | boolean> }) => { funnelEvents.push(e); },
});
const parse = (r: { body: string }) => JSON.parse(r.body);

describe('the shipped types declare path B', () => {
  it('guest-visitor claims into customer-engagement, at the customer classification', () => {
    expect(claimTargetOf(GUEST_VISITOR_TYPE)).toEqual({ typeKey: 'customer-engagement', classification: 'customer' });
  });
});

describe('a visitor registers', () => {
  it('writes the one registration of their conversation and emails its claim, which the answer never carries', async () => {
    const doc = tokens();
    const r = await register(guestEvent({ fields: { name: 'Ada', company: 'Example', email: 'ada@example.com' }, email: 'ada@example.com' }), deps(doc));
    expect(r.statusCode).toBe(200);
    expect(parse(r)).toEqual({ registrationId: expect.any(String), status: 'sent', into: 'customer-engagement' });
    const claimToken = mailedToken();
    // THE TOKEN IS THE LINK: the chat app's sign-in, carrying it in the fragment, to the address given.
    expect(mails[mails.length - 1]).toMatchObject({ kind: 'claim', personArns: [`${APP}/user/${VISITOR_ID}`], address: 'ada@example.com' });
    expect(mails[mails.length - 1].bodyText).toContain(`https://chat.example.com/#claim=${claimToken}`);
    expect(r.body).not.toContain(claimToken);
    const reg = doc.rows.get(registrationKeyOf(`${APP}/channel/guest-ch-1`))!;
    expect(reg).toMatchObject({ kind: 'registration', status: 'open', personArn: `${APP}/user/${VISITOR_ID}`, claimKey: tokenKey('claim', claimToken) });
    expect(doc.rows.get(tokenKey('claim', claimToken))!.expiresAt).toBe(NOW + 30 * 86_400);
    // NEVER KEYED, OR HELD, BY AN EMAIL: an address in the fields is dropped, and the delivery address is not stored.
    expect(reg.fields).toEqual({ name: 'Ada', company: 'Example' });
    expect(JSON.stringify([...doc.rows.values()])).not.toContain('ada@example.com');
    expect(JSON.stringify([...doc.rows.values()])).not.toContain(claimToken);
  });

  it('re-registering revokes the claim shown before', async () => {
    const doc = tokens();
    await register(guestEvent({ fields: { name: 'Ada' }, email: 'ada@example.com' }), deps(doc));
    const first = mailedToken();
    await register(guestEvent({ fields: { name: 'Ada L' }, email: 'ada@example.com' }), deps(doc));
    const second = mailedToken();
    expect(doc.rows.get(tokenKey('claim', first))!.consumedAt).toBe(NOW);
    expect(doc.rows.get(tokenKey('claim', second))!.consumedAt).toBeUndefined();
    const r = await claim(accountEvent({ claimToken: first }), deps(doc));
    expect(r.statusCode).toBe(409);
  });

  it('is refused to anyone but a guest, and without a name or an address to send the link to', async () => {
    const doc = tokens();
    const staff = { ...accountEvent({ fields: { name: 'x' }, email: 'x@example.com' }, STAFF_ISS), resource: '/guest/register' };
    expect((await register(staff, deps(doc))).statusCode).toBe(403);
    expect((await register(guestEvent({ fields: {}, email: 'ada@example.com' }), deps(doc))).statusCode).toBe(400);
    expect((await register(guestEvent({ fields: { name: 'Ada' } }), deps(doc))).statusCode).toBe(400);
    expect((await register(guestEvent({ fields: { name: 'Ada' }, email: 'not an address' }), deps(doc))).statusCode).toBe(400);
    expect(doc.rows.size).toBe(0);
  });
});

describe('an account claims', () => {
  async function registered() {
    const doc = tokens();
    await register(guestEvent({ fields: { name: 'Ada', note: 'pricing' }, email: 'ada@example.com' }), deps(doc));
    return { doc, claimToken: mailedToken() };
  }

  it('opens a customer-engagement conversation for the account, tagged with the visit, once', async () => {
    const { doc, claimToken } = await registered();
    const lambda = creatorOk();
    const r = await claim(accountEvent({ claimToken }), deps(doc, lambda));
    expect(r.statusCode).toBe(200);
    expect(parse(r)).toEqual({ conversationArn: `${APP}/channel/customer-1`, type: 'customer-engagement', sourceChannelArn: `${APP}/channel/guest-ch-1` });
    expect(lambda.calls).toEqual([{
      kind: 'upgrade', classification: 'customer', userArn: `${APP}/user/${ACCOUNT_ID}`,
      sourceChannelArn: `${APP}/channel/guest-ch-1`, sourcePersonArn: `${APP}/user/${VISITOR_ID}`,
      seed: { upgradedFrom: 'guest-visitor', registration: { name: 'Ada', note: 'pricing' } },
    }]);
    expect(doc.rows.get(registrationKeyOf(`${APP}/channel/guest-ch-1`))).toMatchObject({ status: 'claimed', claimedBy: `${APP}/user/${ACCOUNT_ID}` });
    // A SECOND REDEMPTION IS REFUSED, and opens nothing.
    const again = await claim(accountEvent({ claimToken }), deps(doc, lambda));
    expect(again.statusCode).toBe(409);
    expect(lambda.calls).toHaveLength(1);
  });

  it('is never found by an email: a body naming one and no token is refused, and an unknown token finds nothing', async () => {
    const { doc } = await registered();
    const lambda = creatorOk();
    expect((await claim(accountEvent({ email: 'ada@example.com' }), deps(doc, lambda))).statusCode).toBe(400);
    expect((await claim(accountEvent({ claimToken: 'not-a-claim', email: 'ada@example.com' }), deps(doc, lambda))).statusCode).toBe(404);
    expect(lambda.calls).toEqual([]);
  });

  it('an account whose clearance does not reach the target consumes nothing', async () => {
    const { doc, claimToken } = await registered();
    const lambda = creatorOk();
    const r = await claim(accountEvent({ claimToken }, STAFF_ISS), deps(doc, lambda));
    expect(r.statusCode).toBe(403);
    expect(parse(r).code).toBe('NOT_CLEARED_FOR_TARGET');
    expect(doc.rows.get(tokenKey('claim', claimToken))!.consumedAt).toBeUndefined();
    expect(lambda.calls).toEqual([]);
  });

  it('a guest token cannot claim, its own registration least of all', async () => {
    const { doc, claimToken } = await registered();
    const asGuest = { ...guestEvent({ claimToken }), resource: '/upgrade/claim' };
    expect((await claim(asGuest, deps(doc))).statusCode).toBe(401);
  });

  it('a creator that fails leaves the claim redeemable', async () => {
    const { doc, claimToken } = await registered();
    const failing = { calls: [] as any[], async send() { return { FunctionError: 'Unhandled' }; } };
    expect((await claim(accountEvent({ claimToken }), deps(doc, failing as never))).statusCode).toBe(503);
    expect(doc.rows.get(tokenKey('claim', claimToken))!.consumedAt).toBeUndefined();
    expect((await claim(accountEvent({ claimToken }), deps(doc))).statusCode).toBe(200);
  });

  it('an expired claim is refused', async () => {
    const { doc, claimToken } = await registered();
    const later = { ...deps(doc), now: () => (NOW + 31 * 86_400) * 1000 };
    expect((await claim(accountEvent({ claimToken }), later)).statusCode).toBe(410);
  });
});

describe('the target type narrows the claim by issuer (T1, FR23)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CONVERSATION_TYPES } = require('../lib/config/conversation-types');
  const withAdmits = async (ids: string[] | undefined, run: () => Promise<void>) => {
    const prior = CONVERSATION_TYPES['customer-engagement'].admitsIssuers;
    CONVERSATION_TYPES['customer-engagement'].admitsIssuers = ids;
    try { await run(); } finally { CONVERSATION_TYPES['customer-engagement'].admitsIssuers = prior; }
  };

  it('an account of an issuer the type does not list consumes nothing, after the clearance check', async () => {
    await withAdmits(['partner'], async () => {
      const doc = tokens();
      await register(guestEvent({ fields: { name: 'Ada' }, email: 'ada@example.com' }), deps(doc));
      const claimToken = mailedToken();
      const lambda = creatorOk();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const r = await claim(accountEvent({ claimToken }), deps(doc, lambda));
      warn.mockRestore();
      expect(r.statusCode).toBe(403);
      expect(parse(r).code).toBe('ISSUER_NOT_ADMITTED');
      expect(doc.rows.get(tokenKey('claim', claimToken))!.consumedAt).toBeUndefined();
      expect(lambda.calls).toEqual([]);
    });
  });

  it('a listed issuer claims as before, and the narrowing never admits an account the clearance refuses', async () => {
    await withAdmits(['customers', 'deployment'], async () => {
      const doc = tokens();
      await register(guestEvent({ fields: { name: 'Ada' }, email: 'ada@example.com' }), deps(doc));
      const claimToken = mailedToken();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      // The staff pool is listed, but its clearance does not reach customer: refused for that, not admitted.
      const staff = await claim(accountEvent({ claimToken }, STAFF_ISS), deps(doc));
      warn.mockRestore();
      expect(parse(staff).code).toBe('NOT_CLEARED_FOR_TARGET');
      expect((await claim(accountEvent({ claimToken }), deps(doc))).statusCode).toBe(200);
    });
  });
});

describe('the funnel stages path B records (B12)', () => {
  beforeEach(() => { funnelEvents.length = 0; });

  it('a registration is claim_sent on the visitor, and a claim is claim_redeemed on the account, both on the journey of the visit', async () => {
    const doc = tokens();
    await register(guestEvent({ fields: { name: 'Ada', email: 'ada@example.com' }, email: 'ada@example.com' }), deps(doc));
    const claimToken = mailedToken();
    expect((await claim(accountEvent({ claimToken }), deps(doc))).statusCode).toBe(200);
    expect(funnelEvents).toEqual([
      { eventType: 'claim_sent', personId: VISITOR_ID, properties: { journey: 'guest-ch-1', path: 'B' } },
      { eventType: 'claim_redeemed', personId: ACCOUNT_ID, properties: { journey: 'guest-ch-1', path: 'B' } },
    ]);
    // Joined by the conversation, never by an address.
    expect(JSON.stringify(funnelEvents)).not.toContain('@');
  });

  it('a refused claim records nothing', async () => {
    const doc = tokens();
    await register(guestEvent({ fields: { name: 'Ada' }, email: 'ada@example.com' }), deps(doc));
    const claimToken = mailedToken();
    funnelEvents.length = 0;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await claim(accountEvent({ claimToken }, STAFF_ISS), deps(doc));
    warn.mockRestore();
    expect(funnelEvents).toEqual([]);
  });
});
