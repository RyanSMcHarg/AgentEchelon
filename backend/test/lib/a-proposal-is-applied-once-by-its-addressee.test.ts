/**
 * A PROPOSAL IS APPLIED ONCE, BY THE PERSON IT IS ADDRESSED TO (ADR-061 decision 8, rules 5 to 8).
 *
 * What it proves, as ADR-061 "What proves it" lists for proposals: an agent step that proposes executes nothing and is
 * held to one op, the events that op is proposed at and one addressee; a draft that would reach a person outside the
 * room carries no link, handle or address; the apply endpoint refuses another member and an assistant's session (the
 * deny test), applies once and refuses a second apply and an expired one, and re-reads a role holder's holding at
 * apply time; the reminder is sent once per invitation, under a fresh link, as the `nudge` kind a person may stop; and
 * a confirmed `open_conversation` records the person who confirmed as the holder of each `{ creator: true }` role.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { PROPOSAL_OPS, agentStepIsNarrowed, eventWorkflowErrors, proposalOf, PLATFORM_EVENT_WORKFLOWS, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { PROPOSAL_TTL_SECONDS, proposalDraft, proposalDraftRefusal, proposalRecordOf, proposalRefusal } from '../../lambda/src/lib/proposals';
import { TOKEN_KINDS, tokenKey } from '../../lambda/src/lib/tokens';
import { NOTICE_KINDS, MUTABLE_KINDS } from '../../lambda/src/lib/notice-preferences';
import { applyProposal } from '../../lambda/src/proposals-api';
import { nudgeOperation } from '../../lambda/src/invitations';
import { sendTransactionalMail, transactionalMailOf } from '../../lambda/src/lib/transactional-mail';
import { defaultEmailVoice } from '../../lambda/src/lib/email-copy';
import { holdingsAtCreation } from '../../lambda/src/lib/participant-roles';
import { NOT_BUILT_ROLE_SOURCES, participantRoleDeclarationErrors } from '../../lib/config/participant-roles';
import { CONVERSATION_TYPES } from '../../lib/config/conversation-types';
import { runAgentStep } from '../../lambda/src/lib/event-agent-step';
import { edgeContext } from '../helpers/edge-context';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const APP = process.env.APP_INSTANCE_ARN || 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const CHANNEL = `${APP}/channel/ch-1`;
const RILEY = 'riley';
const SAM = 'sam';
const RILEY_ARN = `${APP}/user/${RILEY}`;
const NOW = 1_800_000_000;
const ID = '0b7f2a52-0000-4000-8000-000000000001';
const CHASE = PLATFORM_EVENT_WORKFLOWS['chase-unredeemed'];

describe('an agent step that proposes (decision 8, rules 5 to 8)', () => {
  it('proposes one registered op, at an event that op is proposed at, to the one person who confirms it', () => {
    expect(Object.keys(PROPOSAL_OPS)).toEqual(['send_nudge', 'open_conversation']);
    expect(proposalOf(CHASE.states['draft-nudge'].agent)).toBe('send_nudge');
    const wf = clone(CHASE) as any;
    wf.states['draft-nudge'].agent.propose = ['send_nudge', 'open_conversation'];
    expect(eventWorkflowErrors('x', wf).join()).toMatch(/propose names exactly one of send_nudge, open_conversation/);
    wf.states['draft-nudge'].agent.propose = ['send_nudge'];
    wf.states['draft-nudge'].agent.to = 'room';
    expect(eventWorkflowErrors('x', wf).join()).toMatch(/names the one person a proposal is addressed to/);
  });

  it('a reminder is proposed to the inviter alone, and its turn reads only declared values, so it runs no tools', () => {
    expect(agentStepIsNarrowed(CHASE.states['draft-nudge'].agent)).toBe(true);
    const wf = clone(CHASE) as any;
    wf.states['draft-nudge'].agent.tools = ['load_company_context'];
    expect(eventWorkflowErrors('x', wf).join()).toMatch(/reads only its declared values, so it runs no tools/);
  });

  it('a proposal to a participant role names a one-holder role every declared type declares', () => {
    const ops: EventWorkflow = clone(PLATFORM_EVENT_WORKFLOWS['ops-room']);
    (ops.states['first-look'].agent as any) = {
      prompt: 'ops-first-look', to: { participantRole: 'lead' }, deadlineMs: 20_000, propose: ['open_conversation'], opens: 'ops',
      fallback: { send: { to: { participantRole: 'lead' }, template: 'ops-first-look-unavailable' } },
    };
    expect(eventWorkflowErrors('x', ops)).toEqual([]);
    (ops.states['first-look'].agent as any).to = { participantRole: 'responder' };
    expect(eventWorkflowErrors('x', ops).join()).toMatch(/participant role responder, which every type the workflow declares must give one holder/);
  });

  it('open_conversation names a declared type the platform does not open on its own, and opens is for it alone', () => {
    const ops: any = clone(PLATFORM_EVENT_WORKFLOWS['ops-room']);
    ops.states['first-look'].agent = { ...ops.states['first-look'].agent, to: { participantRole: 'lead' }, propose: ['open_conversation'], opens: 'nope', fallback: { send: { to: 'room', template: 'ops-first-look-unavailable' } } };
    expect(eventWorkflowErrors('x', ops).join()).toMatch(/opens names the declared conversation type/);
    ops.states['first-look'].agent.opens = 'ops-team';
    expect(eventWorkflowErrors('x', ops).join()).toMatch(/opens on its own \(initiation: system\)/);
    const c = clone(CHASE) as any;
    c.states['draft-nudge'].agent.opens = 'ops';
    expect(eventWorkflowErrors('x', c).join()).toMatch(/opens is for open_conversation only/);
  });

  it('a draft that carries a link, a handle or an address is not sent on: the step posts its fallback (rule 6)', async () => {
    expect(proposalDraftRefusal('Hope to see you there!')).toBeUndefined();
    expect(proposalDraftRefusal('Join here: https://evil.example.com')).toBe('link');
    expect(proposalDraftRefusal('see www.evil.example.com')).toBe('link');
    expect(proposalDraftRefusal('write to me@evil.example.com')).toBe('address');
    expect(proposalDraftRefusal('ask @ops-assistant')).toBe('handle');
    const claims: string[] = [];
    const out = await runAgentStep({ template: { name: 'p', kind: 'prompt', messageSections: { prompt: 'Draft.' } } as never, values: {}, deadlineMs: 1000 }, {
      meter: async () => true,
      invoke: async () => ({ response: 'Open https://evil.example.com now' }),
      claim: async (o) => { claims.push(o); return true; },
      postOutput: async () => { throw new Error('a refused draft is never offered'); },
      postFallback: async () => undefined,
      vet: (t) => !proposalDraftRefusal(t),
    });
    expect(out.outcome).toBe('fallback:bounds');
    expect(claims).toEqual(['fallback:bounds']);
  });
});

describe('the proposal record', () => {
  it('is a single-use token kind the processor writes, bound to its conversation and its one addressee', () => {
    expect(TOKEN_KINDS.proposal).toEqual({ writer: 'assistant', redemption: 'single-use', built: true });
    const made = proposalRecordOf({
      channelArn: CHANNEL, addresseeArn: RILEY_ARN, now: NOW, notAfter: NOW + 3600, token: 'handle-1',
      fields: { op: 'send_nudge', classification: 'standard', addressedAs: 'invitation:inviter', workflow: 'chase', step: 'draft-nudge', runKey: 'k', draft: 'Hi', invitationId: ID },
    });
    expect(made.record).toMatchObject({ pk: tokenKey('proposal', 'handle-1'), kind: 'proposal', personArn: RILEY_ARN, channelArn: CHANNEL, redemption: 'single-use', expiresAt: NOW + 3600 });
    expect(made.card).toEqual({ id: 'handle-1', op: 'send_nudge', expiresAt: NOW + 3600 });
    // No address and no token in the clear: the key is the handle's hash.
    expect(JSON.stringify(made.record)).not.toContain('handle-1');
    expect(proposalRecordOf({ channelArn: CHANNEL, addresseeArn: RILEY_ARN, now: NOW, fields: made.record as never }).record.expiresAt).toBe(NOW + PROPOSAL_TTL_SECONDS);
    expect(proposalDraft('  a\n\nlabel  that is long  ', 'open_conversation')).toBe('a label that is long');
  });

  it('may be decided by its addressee alone, before it is decided and before it expires', () => {
    const r = { kind: 'proposal', op: 'send_nudge', classification: 'standard', addressedAs: 'invitation:inviter', personArn: RILEY_ARN, expiresAt: NOW + 10 } as never;
    expect(proposalRefusal(r, RILEY_ARN, NOW)).toBeUndefined();
    expect(proposalRefusal(r, `${APP}/user/${SAM}`, NOW)).toBe('not-addressee');
    expect(proposalRefusal(r, `${APP}/bot/standard`, NOW)).toBe('assistant');
    expect(proposalRefusal({ ...(r as object), consumedAt: NOW - 1 } as never, RILEY_ARN, NOW)).toBe('decided');
    expect(proposalRefusal(r, RILEY_ARN, NOW + 10)).toBe('expired');
    expect(proposalRefusal(null, RILEY_ARN, NOW)).toBe('unknown');
  });
});

/** A token store and a context row in memory, with the conditional update `redeemToken` makes. */
function world(opts: { record: Record<string, unknown>; members?: string[]; holdings?: Record<string, unknown>; conversationType?: string; act?: Record<string, unknown>; actThrows?: boolean }) {
  const items = new Map<string, Record<string, any>>([[String(opts.record.pk), { ...opts.record }]]);
  const invoked: Array<{ fn: string; payload: any }> = [];
  const doc = {
    send: async (cmd: any) => {
      const name = cmd.constructor.name;
      if (name === 'GetCommand') {
        if (cmd.input.TableName === 'Context') return { Item: { conversationType: opts.conversationType, participantRoles: opts.holdings } };
        return { Item: items.get(cmd.input.Key.pk) };
      }
      if (name === 'UpdateCommand' && String(cmd.input.ConditionExpression).includes(':applying')) {
        // THE OUTCOME OF A CLAIMED APPLY: settled or released, only from the addressee's own claim.
        const item = items.get(cmd.input.Key.pk);
        const v = cmd.input.ExpressionAttributeValues;
        if (!item || item.decision !== 'applying' || item.personArn !== v[':p']) throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
        if (String(cmd.input.UpdateExpression).startsWith('REMOVE')) { delete item.consumedAt; delete item.decision; } else item.decision = v[':d'];
        return {};
      }
      if (name === 'UpdateCommand') {
        const item = items.get(cmd.input.Key.pk);
        const v = cmd.input.ExpressionAttributeValues;
        const names = cmd.input.ExpressionAttributeNames ?? {};
        const matches = Object.entries(names).filter(([k]) => k.startsWith('#m')).every(([k, field]) => item?.[field as string] === v[`:m${k.slice(2)}`]);
        if (!item || item.consumedAt !== undefined || !(item.expiresAt > v[':now']) || item.channelArn !== v[':channel'] || !matches) {
          throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
        }
        item.consumedAt = v[':now'];
        for (const [k, field] of Object.entries(names)) if (k.startsWith('#x')) item[field as string] = v[`:x${k.slice(2)}`];
        return { Attributes: item };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const messaging = {
    send: async (cmd: any) => {
      if (cmd.constructor.name === 'DescribeChannelCommand') {
        if (!(opts.members ?? []).includes(cmd.input.ChimeBearer)) throw Object.assign(new Error('no'), { name: 'ForbiddenException' });
        return { Channel: { Name: 'Plan' } };
      }
      return { Tags: [{ Key: 'classification', Value: 'standard' }] };
    },
  };
  const lambda = { send: async (cmd: any) => { invoked.push({ fn: cmd.input.FunctionName, payload: JSON.parse(Buffer.from(cmd.input.Payload).toString()) }); if (opts.actThrows) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); return { Payload: Buffer.from(JSON.stringify(opts.act ?? { ok: true, status: 200, body: { sent: true } })) }; } };
  const deps = { doc, messaging, lambda, tokensTable: 'Tokens', contextTable: 'Context', appInstanceArn: APP, invitationsFunction: 'Invitations', creatorOf: (c: string) => `Prefix-${c}-TypedCreator`, now: () => NOW * 1000 };
  return { deps, items, invoked };
}

const event = (personId: string, body: unknown): APIGatewayProxyEvent => ({
  httpMethod: 'POST', path: '/proposals/apply', headers: {}, body: JSON.stringify(body),
  requestContext: { authorizer: edgeContext({ claims: { sub: `subject-of-${personId}`, token_use: 'id' }, personId }) },
}) as unknown as APIGatewayProxyEvent;

describe('the apply endpoint (rule 8)', () => {
  const nudge = () => proposalRecordOf({
    channelArn: CHANNEL, addresseeArn: RILEY_ARN, now: NOW, token: 'handle-1',
    fields: { op: 'send_nudge', classification: 'standard', addressedAs: 'invitation:inviter', workflow: 'chase', step: 'draft-nudge', runKey: 'k', draft: 'Hope you can join us.', invitationId: ID },
  }).record;

  it('DENY: another member, and an assistant\'s session, are refused applying a proposal addressed to the inviter, and nothing is consumed or sent', async () => {
    const w = world({ record: nudge(), members: [RILEY_ARN, `${APP}/user/${SAM}`] });
    const other = await applyProposal(event(SAM, { proposal: 'handle-1', decision: 'apply', address: 'friend@example.com' }), w.deps);
    expect(other.statusCode).toBe(403);
    expect(JSON.parse(other.body).code).toBe('NOT_ADDRESSEE');
    const bot = await applyProposal(event('../bot/standard', { proposal: 'handle-1', decision: 'apply', address: 'friend@example.com' }), w.deps);
    expect(bot.statusCode).toBe(403);
    expect(w.items.get(tokenKey('proposal', 'handle-1'))!.consumedAt).toBeUndefined();
    expect(w.invoked).toEqual([]);
    // The consuming update names the addressee too, so a race past the handler's check is refused by the store.
    expect(read('proposals-api.ts')).toMatch(/match: \{ personArn: callerArn \}, extra: \{ decision \}/);
  });

  it('the addressee applies it once: the reminder is asked of the invitations function, with them as who confirmed', async () => {
    const w = world({ record: nudge(), members: [RILEY_ARN] });
    const first = await applyProposal(event(RILEY, { proposal: 'handle-1', decision: 'apply', address: 'friend@example.com' }), w.deps);
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({ applied: true, op: 'send_nudge', sent: true });
    expect(w.invoked).toEqual([{ fn: 'Invitations', payload: { op: 'nudge', channelArn: CHANNEL, invitationId: ID, confirmedBy: RILEY_ARN, address: 'friend@example.com', note: 'Hope you can join us.' } }]);
    expect(w.items.get(tokenKey('proposal', 'handle-1'))).toMatchObject({ consumedAt: NOW, decision: 'applied' });
    const again = await applyProposal(event(RILEY, { proposal: 'handle-1', decision: 'apply', address: 'friend@example.com' }), w.deps);
    expect(again.statusCode).toBe(409);
    expect(w.invoked).toHaveLength(1);
  });

  it('is refused once it expires, without an address for a reminder, and to someone who left the conversation', async () => {
    const expired = world({ record: { ...nudge(), expiresAt: NOW }, members: [RILEY_ARN] });
    expect((await applyProposal(event(RILEY, { proposal: 'handle-1', decision: 'apply', address: 'a@b.co' }), expired.deps)).statusCode).toBe(410);
    const live = world({ record: nudge(), members: [RILEY_ARN] });
    expect(JSON.parse((await applyProposal(event(RILEY, { proposal: 'handle-1', decision: 'apply' }), live.deps)).body).code).toBe('ADDRESS_INVALID');
    const left = world({ record: nudge(), members: [] });
    expect(JSON.parse((await applyProposal(event(RILEY, { proposal: 'handle-1', decision: 'apply', address: 'a@b.co' }), left.deps)).body).code).toBe('NOT_A_MEMBER');
    expect([expired, live, left].flatMap((w) => w.invoked)).toEqual([]);
  });

  it('a decline is recorded once and does nothing else', async () => {
    const w = world({ record: nudge(), members: [RILEY_ARN] });
    const out = await applyProposal(event(RILEY, { proposal: 'handle-1', decision: 'decline' }), w.deps);
    expect(JSON.parse(out.body)).toEqual({ declined: true, op: 'send_nudge' });
    expect(w.items.get(tokenKey('proposal', 'handle-1'))).toMatchObject({ decision: 'declined' });
    expect(w.invoked).toEqual([]);
  });

  it('an act refused outright releases the claim: the proposal is undecided again and its addressee applies it once more', async () => {
    const w = world({ record: nudge(), members: [RILEY_ARN], act: { ok: false, status: 503, body: { code: 'MAIL_DOWN', error: 'the mail could not be sent' } } });
    const failed = await applyProposal(event(RILEY, { proposal: 'handle-1', decision: 'apply', address: 'friend@example.com' }), w.deps);
    expect(failed.statusCode).toBe(503);
    const record = w.items.get(tokenKey('proposal', 'handle-1'))!;
    expect(record.consumedAt).toBeUndefined();
    expect(record.decision).toBeUndefined();
    // The same person retries, the act is done this time, and the proposal is applied once.
    const retried = world({ record: { ...record }, members: [RILEY_ARN] });
    const ok = await applyProposal(event(RILEY, { proposal: 'handle-1', decision: 'apply', address: 'friend@example.com' }), retried.deps);
    expect(ok.statusCode).toBe(200);
    expect(retried.items.get(tokenKey('proposal', 'handle-1'))).toMatchObject({ consumedAt: NOW, decision: 'applied' });
    expect((await applyProposal(event(RILEY, { proposal: 'handle-1', decision: 'apply', address: 'friend@example.com' }), retried.deps)).statusCode).toBe(409);
  });

  it('an act that did not answer is recorded failed where asking again could do it twice, and the audit says so', async () => {
    const opened = proposalRecordOf({
      channelArn: CHANNEL, addresseeArn: RILEY_ARN, now: NOW, token: 'handle-3',
      fields: { op: 'open_conversation', classification: 'standard', addressedAs: 'invitation:inviter', workflow: 'w', step: 's', runKey: 'k', draft: 'Follow-up', conversationType: 'ops' },
    }).record;
    const w = world({ record: opened, members: [RILEY_ARN], actThrows: true });
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const out = await applyProposal(event(RILEY, { proposal: 'handle-3', decision: 'apply' }), w.deps);
    const audits = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('proposal_decided'));
    log.mockRestore();
    expect(out.statusCode).toBe(502);
    expect(w.items.get(tokenKey('proposal', 'handle-3'))).toMatchObject({ decision: 'failed' });
    expect(audits.map((l) => JSON.parse(l).decision)).toEqual(['failed']);
    // Not tried again: the claim stands as failed.
    expect((await applyProposal(event(RILEY, { proposal: 'handle-3', decision: 'apply' }), w.deps)).statusCode).toBe(409);
    expect(w.invoked).toHaveLength(1);
  });

  it('a reminder that did not answer is released, because the invitations function sends one at most', async () => {
    const w = world({ record: nudge(), members: [RILEY_ARN], actThrows: true });
    expect((await applyProposal(event(RILEY, { proposal: 'handle-1', decision: 'apply', address: 'friend@example.com' }), w.deps)).statusCode).toBe(502);
    expect(w.items.get(tokenKey('proposal', 'handle-1'))!.decision).toBeUndefined();
  });

  it('the claim is applying while the act runs, and the audit records applied only after the act was done', () => {
    const api = read('proposals-api.ts');
    expect(api).toMatch(/const decision = body\.decision === 'apply' \? 'applying' : 'declined';/);
    expect(api.indexOf('act = await performAct(')).toBeLessThan(api.indexOf('audit(outcome);'));
  });

  it('a proposal to a role\'s holder is applied only while the caller still holds the role, read from the context row now', async () => {
    const opened = proposalRecordOf({
      channelArn: CHANNEL, addresseeArn: RILEY_ARN, now: NOW, token: 'handle-2',
      fields: { op: 'open_conversation', classification: 'standard', addressedAs: 'participantRole:lead', workflow: 'ops-room', step: 'first-look', runKey: 'k', draft: 'Follow-up', conversationType: 'ops' },
    }).record;
    const lost = world({ record: opened, members: [RILEY_ARN], conversationType: 'ops', holdings: { lead: { [SAM]: { origin: 'event' } } } });
    expect(JSON.parse((await applyProposal(event(RILEY, { proposal: 'handle-2', decision: 'apply' }), lost.deps)).body).code).toBe('ROLE_NOT_HELD');
    expect(lost.invoked).toEqual([]);
    const held = world({ record: opened, members: [RILEY_ARN], conversationType: 'ops', holdings: { lead: { [RILEY]: { origin: 'event' } } }, act: { ok: true, channelArn: `${APP}/channel/new` } });
    const out = await applyProposal(event(RILEY, { proposal: 'handle-2', decision: 'apply' }), held.deps);
    expect(JSON.parse(out.body)).toEqual({ applied: true, op: 'open_conversation', channelArn: `${APP}/channel/new` });
    // THE CREATOR OPENS IT FOR THE PERSON WHO CONFIRMED, and records them as its creator.
    expect(held.invoked).toEqual([{ fn: 'Prefix-standard-TypedCreator', payload: { detail: { conversationType: 'ops', concernedChannelArn: CHANNEL, forUserArn: RILEY_ARN, confirmedBy: RILEY_ARN, topicLabel: 'Follow-up' } } }]);
  });
});

describe('the reminder, once per invitation (ADR-061 decision 8; "at most one nudge per person per invitation")', () => {
  const INVITEE = `${APP}/user/jordan`;
  const record = {
    pk: 'invitation#old', kind: 'invitation', channelArn: CHANNEL, personArn: INVITEE, invitationId: ID, inviterArn: RILEY_ARN, inviterName: 'Riley',
    inviteeName: 'Jordan', mode: 'sign-in', classification: 'standard', conversationType: 'general', conversationName: 'Plan',
    invitationChannel: CHANNEL, expiresAt: NOW + 86_400, issuer: 'deployment', redemption: 'single-use', reclaimAt: 0, createdAt: '2027-01-01T00:00:00Z',
  };
  function invitations(stored: Record<string, unknown>, transact?: (cmd: any) => void) {
    const mail: any[] = [];
    const doc = {
      send: async (cmd: any) => {
        if (cmd.constructor.name === 'QueryCommand') return { Items: [stored] };
        if (cmd.constructor.name === 'TransactWriteCommand') { transact?.(cmd); return {}; }
        throw new Error(cmd.constructor.name);
      },
    };
    return { mail, deps: { doc, tokensTable: 'Tokens', appInstanceArn: APP, landingOrigin: 'https://widget.example.com', now: () => NOW * 1000, mail: async (m: any) => { mail.push(m); return true; } } };
  }
  const op = { op: 'nudge' as const, channelArn: CHANNEL, invitationId: ID, confirmedBy: RILEY_ARN, address: 'friend@example.com', note: 'Hope you can join.' };

  it('adds a second link beside the first in one transaction, marks the invitation reminded, then emails the invitee as the nudge kind', async () => {
    let tx: any;
    const w = invitations(record, (cmd) => { tx = cmd.input; });
    const out = await nudgeOperation(op, w.deps as never);
    expect(out).toEqual({ ok: true, status: 200, body: { sent: true } });
    const [put, mark] = tx.TransactItems;
    // THE SECOND LINK IS AN ALIAS of the one record: no invitation id, no mode, no index key, so nothing lists or reads
    // it as an invitation of its own, and offboarding finds it by the people it names.
    expect(put.Put.Item).toEqual(expect.objectContaining({ kind: 'invitation', aliasOf: 'invitation#old', personArn: INVITEE, inviterArn: RILEY_ARN, expiresAt: record.expiresAt }));
    expect(put.Put.Item).not.toHaveProperty('invitationId');
    expect(put.Put.Item).not.toHaveProperty('mode');
    expect(put.Put.Item).not.toHaveProperty('invitationChannel');
    expect(put.Put.Item.pk).toMatch(/^invitation#[0-9a-f]{64}$/);
    expect(put.Put.ConditionExpression).toBe('attribute_not_exists(pk)');
    // THE FIRST LINK STAYS: the record is updated, never deleted, on condition it is pending and never reminded.
    expect(mark.Update.Key).toEqual({ pk: 'invitation#old' });
    expect(mark.Update.UpdateExpression).toBe('SET nudgedAt = :now');
    expect(mark.Update.ConditionExpression).toMatch(/attribute_not_exists\(consumedAt\) AND attribute_not_exists\(revokedAt\) AND attribute_not_exists\(nudgedAt\)/);
    expect(tx.TransactItems.some((i: any) => i.Delete)).toBe(false);
    expect(w.mail).toEqual([expect.objectContaining({ mail: 'nudge', personArn: INVITEE, address: 'friend@example.com', note: 'Hope you can join.', sender: 'Riley', title: 'Plan' })]);
    expect(w.mail[0].link).toMatch(/^https:\/\/widget\.example\.com\/invite\.html#t=/);
  });

  it('a second reminder of the same invitation is refused by the transaction, and nothing is emailed', async () => {
    const w = invitations(record, () => { throw Object.assign(new Error('x'), { name: 'TransactionCanceledException' }); });
    expect(await nudgeOperation(op, w.deps as never)).toMatchObject({ ok: false, status: 409, body: { code: 'ALREADY_NUDGED' } });
    expect(w.mail).toEqual([]);
  });

  it('DENY: a reminder confirmed by anyone but the inviter, or for an invitation no longer pending, sends nothing', async () => {
    const other = invitations(record);
    expect(await nudgeOperation({ ...op, confirmedBy: `${APP}/user/${SAM}` }, other.deps as never)).toMatchObject({ status: 403, body: { code: 'NOT_YOURS' } });
    const redeemed = invitations({ ...record, consumedAt: NOW - 5 });
    expect(await nudgeOperation(op, redeemed.deps as never)).toMatchObject({ status: 409, body: { code: 'INVITATION_NOT_PENDING' } });
    expect([...other.mail, ...redeemed.mail]).toEqual([]);
  });

  it('is a kind the invitee may stop: it honors their preference and carries the one-click unsubscribe', async () => {
    expect(NOTICE_KINDS.nudge).toEqual({ transactional: false });
    expect(MUTABLE_KINDS).toContain('nudge');
    expect(transactionalMailOf({ mail: 'nudge', personArn: `${APP}/user/jordan`, address: 'a@b.co', name: 'J', channelArn: CHANNEL, link: 'https://x/invite.html#t=1', note: 'n' })).toMatchObject({ mail: 'nudge', note: 'n' });
    const email = jest.fn().mockResolvedValue({ emailed: ['jordan'] });
    expect(await sendTransactionalMail({ mail: 'nudge', personArn: `${APP}/user/jordan`, address: 'a@b.co', name: 'J', channelArn: CHANNEL, link: 'https://x/l', sender: 'Riley', title: 'Plan', note: 'See you.' }, { email, voice: async () => defaultEmailVoice() })).toBe(true);
    const args = email.mock.calls[0][0];
    expect(args.kind).toBe('nudge');
    expect(args.subject).toBe('A reminder: Riley invited you to a conversation');
    expect(args.bodyText).toContain('See you.');
    expect(args.bodyText).toContain('https://x/l');
  });
});

describe('the creator participant-role source (DESIGN-CONVERSATION-TYPES section 6.1)', () => {
  it('is built: the person whose confirmation opened the conversation holds each { creator: true } role', () => {
    expect(NOT_BUILT_ROLE_SOURCES.creator).toBeUndefined();
    const types = { ...CONVERSATION_TYPES, followup: { ...CONVERSATION_TYPES.general, initiation: 'user', participants: { ...(CONVERSATION_TYPES.general.participants ?? {}), participantRoles: { owner: { from: [{ creator: true }], holders: 'one' } } } } } as never;
    const original = CONVERSATION_TYPES as Record<string, unknown>;
    original.followup = (types as Record<string, unknown>).followup;
    try {
      expect(holdingsAtCreation('followup', { forPerson: RILEY_ARN, creator: RILEY_ARN })).toEqual({ owner: { [RILEY]: { origin: 'creator' } } });
      expect(holdingsAtCreation('followup', { forPerson: RILEY_ARN })).toEqual({});
      expect(participantRoleDeclarationErrors(types).filter((e) => e.includes('followup'))).toEqual([]);
      const system = { ...CONVERSATION_TYPES, sys: { ...(original.followup as object), initiation: 'system' } } as never;
      expect(participantRoleDeclarationErrors(system).join()).toMatch(/a creator source needs a type a person's confirmed proposal opens/);
    } finally {
      delete original.followup;
    }
  });

  it('the creator records it only for the person the conversation is for, and refuses a confirmation naming anyone else', () => {
    const creator = read('typed-conversation-from-event.ts');
    expect(creator).toMatch(/detail\.confirmedBy !== undefined && detail\.confirmedBy !== forUserArn/);
    expect(creator).toMatch(/\.\.\.\(detail\.confirmedBy \? \{ creator: detail\.confirmedBy \} : \{\}\)/);
  });
});

describe('the processor drafts and offers it, and executes nothing (rules 5 and 6)', () => {
  const processor = read('assistant-async-processor.ts');

  it('a narrowed turn has the persona alone as its system prompt and no tools', () => {
    expect(processor).toMatch(/narrowed\n\s*\? invokeBedrockWithFallback\(\n\s*persona,\n\s*\[\{ role: 'user', content: prompt \}\],\n\s*\{ \.\.\.invokeConfig, tools: \[\], userTurnText: '' \}/);
    expect(processor).toMatch(/enableCompanyContextTool: false/);
  });

  it('the draft is vetted, written as a proposal, and offered to its one addressee on a card; nothing runs it', () => {
    expect(processor).toMatch(/\.\.\.\(op \? \{ vet: \(text: string\) => !proposalDraftRefusal\(text\) \} : \{\}\)/);
    expect(processor).toMatch(/postOutput: \(content\) => \(op \? offerProposal\(content\) : post\(content, targetsOf\(def\.to\), 'posted'\)\)/);
    const offer = processor.slice(processor.indexOf('const offerProposal = async'), processor.indexOf('// THE BRIEF THE ADDRESSED PERSON'));
    expect(offer.indexOf('writeProposal(')).toBeGreaterThan(-1);
    expect(offer.indexOf('writeProposal(')).toBeLessThan(offer.indexOf('await post('));
    expect(offer).toMatch(/await post\(content \|\| draft, \[addressee\], 'posted', made\.card\)/);
    expect(processor).toMatch(/\.\.\.\(proposal \? \{ proposal \} : \{\}\)/);
  });
});
