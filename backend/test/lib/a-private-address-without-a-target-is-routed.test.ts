/**
 * A PRIVATE ADDRESS MUST CARRY THE `Target` ITS TEXT NAMES, AND THE TWO WAYS IT CAN FAIL ARE HANDLED
 * DIFFERENTLY.
 *
 * `.Bob hello` resolving to a real member tells the sender only Bob can read it. The `Target` decides
 * that, and the channel-flow callback does not carry one. A message the flow is still HOLDING cannot be
 * read (measured 2026-09-15), so the flow releases it once and then reads the stored message back:
 *
 *   no Target                 KEPT. The sender is told, privately, that the ROOM can see it. If the
 *                             address named an ASSISTANT the turn is routed to it and answered
 *                             privately to the sender; if it named a PERSON, the notice is all there is
 *   a Target naming SOMEBODY  KEPT. The sender is told a DIFFERENT line, because ONE WRONG MEMBER can
 *     ELSE                    see it and the person they named received nothing. No turn starts
 *   the Target names the      proceeds exactly as before
 *     addressee
 *   not readable              proceeds exactly as before - for a person addressee that IS a real Target
 *
 * ── NOTHING IS DELETED ON ANY BRANCH, WHICH IS WHAT THIS FILE IS NAMED FOR ──
 *
 * Both disagreements used to delete the message and tell the sender it had been dropped. The delete
 * never unsent anything: release happens first, so by the time the read comes back whoever it reached
 * has had it, and the delete only shortens the window on a disclosure that already happened - at the
 * cost of destroying the person's words, which is not a trade they were offered. On the untargeted
 * branch it also cost them their turn, for a defect in their client.
 *
 * So the message stays either way and the choice to delete it belongs to whoever wrote it. What differs
 * is the NOTICE, because the two disclosures are different: one message is in front of the whole room,
 * the other in front of exactly one member who should not have it. Only the untargeted branch can route
 * a turn, because only there did the text address somebody who actually received it.
 *
 * A notice goes to the sender ONLY, in the deployment's configured words, and each defect is counted on
 * its own metric so "no target" and "the wrong target" are told apart. See `lib/private-command.ts`.
 */
import { ownWords } from '../helpers/own-templates';
import {
  DeleteChannelMessageCommand,
  GetChannelMessageCommand,
  SendChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import * as fs from 'fs';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import * as path from 'path';
import {
  CHANNEL_FLOW_METRIC_NAMESPACE,
  PRIVATE_MESSAGE_TARGET_MISMATCH_METRIC,
  PRIVATE_MESSAGE_WITHOUT_TARGET_METRIC,
  enforcePrivateAddressTarget,
  privateMessageNotPrivateNotice,
  privateMessageWrongTargetNotice,
  privateMessageNoticeKind,
} from '../../lambda/src/lib/private-command';

const INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${INSTANCE}/channel/c1`;
const BOT = `${INSTANCE}/bot/basic-bot`;
const ADMIN = `${INSTANCE}/user/service-admin`;
const ALICE = `${INSTANCE}/user/alice`;
const BOB = `${INSTANCE}/user/bob`;

const notFound = () => Object.assign(new Error('not yet'), { name: 'NotFoundException' });
const throttled = () => Object.assign(new Error('slow down'), { name: 'ThrottledClientException' });
const forbidden = () => Object.assign(new Error('no'), { name: 'ForbiddenException' });

/** A client whose GetChannelMessage answers in order; every other command succeeds. */
function clientReading(...reads: Array<unknown | Error>) {
  const queue = [...reads];
  const send = jest.fn((cmd: unknown) => {
    if (cmd instanceof GetChannelMessageCommand) {
      const next = queue.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }
    return Promise.resolve({});
  });
  return { send };
}

const untargeted = { ChannelMessage: { MessageId: 'm-1', Content: '.Bob hello' } };
/** `.Bob hello` stored with the Target that matches it. The addressee below is BOB throughout. */
const targeted = { ChannelMessage: { MessageId: 'm-1', Content: '.Bob hello', Target: [{ MemberArn: BOB }] } };
/**
 * `.Bob hello` stored with a Target naming the ASSISTANT instead.
 *
 * This is the shape the mismatch is actually VISIBLE in: a targeted message is readable by its sender
 * and its target and nobody else, and the flow reads as the assistant, so the wrong targets it can see
 * are the ones pointed at itself. Bob's words, delivered to the assistant, with Bob's name on them.
 */
const misdirected = { ChannelMessage: { MessageId: 'm-1', Content: '.Bob hello', Target: [{ MemberArn: BOT }] } };

function emfDocs(spy: jest.SpyInstance): Array<Record<string, any>> {
  return spy.mock.calls
    .map(([line]) => { try { return JSON.parse(String(line)); } catch { return null; } })
    .filter((d) => d && d._aws);
}

describe('holding a private address to its Target', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { log.mockRestore(); warn.mockRestore(); });

  const run = (client: { send: jest.Mock }, addresseeIsBot = false) => {
    const release = jest.fn().mockResolvedValue(undefined);
    const result = enforcePrivateAddressTarget({
      // The member `.Bob` resolved to. Every case here addresses BOB, so a stored Target naming anyone
      // else is a mismatch and one naming BOB is the match.
      client: client as never, channelArn: CHANNEL, messageId: 'm-1', botArn: BOT, addresseeArn: BOB,
      addresseeIsBot, release, pauseMs: 0,
    });
    return { result, release };
  };

  const sent = (client: { send: jest.Mock }) => client.send.mock.calls.map(([c]) => c);

  it('releases the message once, before it reads anything back', async () => {
    const client = clientReading(untargeted);
    const { result, release } = run(client);
    await result;

    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(client.send.mock.invocationCallOrder[0]);
    // Read as the assistant, which is the flow's own identity.
    const read = client.send.mock.calls[0][0] as GetChannelMessageCommand;
    expect(read.input).toEqual({ ChannelArn: CHANNEL, MessageId: 'm-1', ChimeBearer: BOT });
  });

  // ── NO `Target`: THE MESSAGE IS KEPT ───────────────────────────────────────────────────

  it('KEEPS an untargeted message rather than deleting it', async () => {
    const client = clientReading(untargeted);
    const { result } = run(client);

    await expect(result).resolves.toEqual({ outcome: 'untargeted', disposition: 'addressee-is-a-person' });
    expect(sent(client).some((c) => c instanceof DeleteChannelMessageCommand)).toBe(false);
  });

  it('KEEPS a misdirected message too, and deletes NOTHING on any branch', async () => {
    // The owner's correction, 2026-09-16: the wrong-target branch does not delete either. The delete
    // never unsent anything there either - the wrong member has already had the message - so all it
    // reliably did was destroy the sender's words. The check now issues NO delete at all, which is
    // asserted across every branch at once rather than case by case, because "somebody re-added a
    // delete" is the regression worth catching and it could be re-added on either side.
    for (const stored of [untargeted, misdirected, targeted]) {
      const client = clientReading(stored);
      await run(client).result;
      expect(sent(client).some((c) => c instanceof DeleteChannelMessageCommand)).toBe(false);
    }
  });

  it('reports an assistant addressee distinctly, because only that one can be routed to', async () => {
    const { result } = run(clientReading(untargeted), true);
    await expect(result).resolves
      .toEqual({ outcome: 'untargeted', disposition: 'addressee-is-an-assistant' });
  });

  it('retries the read once before deciding, for an ASSISTANT addressee', async () => {
    // The retry is for a read that is transiently unreadable, which is a real possibility when the
    // assistant is the addressee and therefore entitled to read the message.
    const client = clientReading(notFound(), untargeted);
    const { result, release } = run(client, true);
    await expect(result).resolves.toEqual({ outcome: 'untargeted', disposition: 'addressee-is-an-assistant' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(sent(client).length).toBe(2);
  });

  it('does NOT retry for a person addressee, because unreadable is the correct answer there', async () => {
    // `.Alice hello` targeted at two humans is unreadable to the assistant BY DESIGN - that is what
    // privacy means - so a second read re-confirms something that cannot change. It cost an extra
    // GetChannelMessage plus the pause on every such message, on a path that then dispatches nothing.
    const client = clientReading(notFound(), untargeted);
    const { result } = run(client, false);
    await expect(result).resolves.toEqual({ outcome: 'unverified' });
    expect(sent(client).length).toBe(1);
  });

  it('still catches an UNTARGETED message for a person on the first read', async () => {
    // WHAT THE SHORTCUT MUST NOT LOSE. The outcome worth catching for a person is their supposedly
    // private message being readable by the room, and an untargeted message IS readable - so it is
    // decided on read one. Only the already-correct case got shorter.
    const client = clientReading(untargeted);
    const { result } = run(client, false);
    await expect(result).resolves.toEqual({ outcome: 'untargeted', disposition: 'addressee-is-a-person' });
    expect(sent(client).length).toBe(1);
  });

  it('lets a message whose Target NAMES ITS ADDRESSEE proceed', async () => {
    // The non-vacuity case for everything below: if the check refused every message, the refusals
    // would all pass and the feature would be a way to delete private messages.
    const client = clientReading(targeted);
    const { result, release } = run(client);
    await expect(result).resolves.toEqual({ outcome: 'targeted' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(sent(client).some((c) => c instanceof DeleteChannelMessageCommand)).toBe(false);
    expect(emfDocs(log)).toHaveLength(0);
  });

  // ── THE `Target` HAS TO NAME THE MEMBER THE TEXT ADDRESSED, not merely exist ──────────────────────
  //
  // `.Bob hello` whose stored Target names the assistant is private, and private to the wrong member:
  // Bob never sees it and somebody else does. Refused, because proceeding is a disclosure and the
  // untargeted branch's wording ("everyone here can see it") would be false here.

  it('REPORTS a message whose Target names somebody other than the member the text addressed', async () => {
    const client = clientReading(misdirected);
    const { result, release } = run(client);

    await expect(result).resolves.toEqual({ outcome: 'misdirected', disposition: 'addressee-is-a-person' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('counts a mismatch on its OWN metric, so it is not hidden inside the missing-target count', async () => {
    await run(clientReading(misdirected)).result;
    const docs = emfDocs(log);
    expect(docs).toHaveLength(1);
    const [doc] = docs;
    expect(doc._aws.CloudWatchMetrics[0].Namespace).toBe(CHANNEL_FLOW_METRIC_NAMESPACE);
    expect(doc._aws.CloudWatchMetrics[0].Metrics)
      .toEqual([{ Name: PRIVATE_MESSAGE_TARGET_MISMATCH_METRIC, Unit: 'Count' }]);
    expect(doc._aws.CloudWatchMetrics[0].Dimensions).toEqual([[], ['Disposition']]);
    expect(doc[PRIVATE_MESSAGE_TARGET_MISMATCH_METRIC]).toBe(1);
    expect(doc.Disposition).toBe('addressee-is-a-person');
    expect(doc.Path).toBeUndefined();
    // Distinct from the other defect, not a third Path value on it.
    expect(doc[PRIVATE_MESSAGE_WITHOUT_TARGET_METRIC]).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain('hello');
    const [, detail] = warn.mock.calls.find(([m]) => String(m).includes('Target naming another member'))!;
    expect(detail).toEqual({ channelArn: CHANNEL, messageId: 'm-1', addresseeIsBot: false, disposition: 'addressee-is-a-person' });
  });

  it('never drops a message whose stored form cannot be read: for a person that is a real Target', async () => {
    const client = clientReading(forbidden(), forbidden());
    const { result } = run(client);
    await expect(result).resolves.toEqual({ outcome: 'unverified' });
    expect(sent(client).some((c) => c instanceof DeleteChannelMessageCommand)).toBe(false);
    expect(log.mock.calls.some(([m]) => String(m).includes('proceeds as sent'))).toBe(true);
    expect(emfDocs(log)).toHaveLength(0);
  });

  it('warns when the unreadable message was addressed to the ASSISTANT, which can always read its own', async () => {
    await run(clientReading(throttled(), throttled()), true).result;
    expect(warn.mock.calls.some(([m]) => String(m).includes('proceeds as sent'))).toBe(true);
  });

  it('counts each missing target on a metric an alarm can watch, carrying no content', async () => {
    await run(clientReading(untargeted), true).result;
    const [doc] = emfDocs(log);
    expect(doc._aws.CloudWatchMetrics[0].Namespace).toBe(CHANNEL_FLOW_METRIC_NAMESPACE);
    expect(doc._aws.CloudWatchMetrics[0].Metrics).toEqual([{ Name: PRIVATE_MESSAGE_WITHOUT_TARGET_METRIC, Unit: 'Count' }]);
    // The dimensionless series is what an alarm watches; the second says who was addressed. It is
    // `Disposition` rather than the old `Path` because the message no longer leaves the conversation,
    // so there is no longer a way it "ended" to dimension on.
    expect(doc._aws.CloudWatchMetrics[0].Dimensions).toEqual([[], ['Disposition']]);
    expect(doc[PRIVATE_MESSAGE_WITHOUT_TARGET_METRIC]).toBe(1);
    expect(doc.Disposition).toBe('addressee-is-an-assistant');
    expect(doc.Path).toBeUndefined();
    expect(doc.AddresseeIsBot).toBe('true');
    expect(JSON.stringify(doc)).not.toContain('hello');
    const [, detail] = warn.mock.calls.find(([m]) => String(m).includes('[ClientDefect]'))!;
    expect(detail).toEqual({
      channelArn: CHANNEL, messageId: 'm-1', addresseeIsBot: true, disposition: 'addressee-is-an-assistant',
    });
  });
});

describe('telling the sender, and only the sender', () => {
  it('names the notice by what happened, and the flow hands it to the assistant for the sender alone', () => {
    expect(privateMessageNoticeKind('wrong-target')).toBe('privateMessageWrongTarget');
    expect(privateMessageNoticeKind('not-private', 'addressee-is-a-person')).toBe('privateMessageNotPrivate');
    expect(privateMessageNoticeKind('not-private', 'addressee-is-an-assistant')).toBe('privateMessageNotPrivateAnswering');
    const flow = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'channel-flow-processor.ts'), 'utf8');
    expect(flow).toContain("kind: privateMessageNoticeKind('wrong-target'),");
    expect(flow).toContain("kind: privateMessageNoticeKind('not-private', check.disposition),");
    // To the sender alone: a notice about a misdirected message must not be a second delivery of it.
    for (const at of [flow.indexOf("privateMessageNoticeKind('wrong-target')"), flow.indexOf("privateMessageNoticeKind('not-private'")]) {
      expect(flow.slice(at, at + 120)).toContain('to: [senderArn],');
    }
  });

  it("uses the assistant's own templates, and the answering line only when an assistant was addressed", () => {
    const copy = ownWords({
      privateMessageNotPrivate: 'Configured: seen by everyone.',
      privateMessageNotPrivateAnswering: 'Configured: seen by everyone, answering privately.',
      privateMessageWrongTarget: 'Configured: it went to somebody else.',
    });
    expect(privateMessageNotPrivateNotice(copy, 'addressee-is-a-person')).toBe('Configured: seen by everyone.');
    expect(privateMessageNotPrivateNotice(copy, 'addressee-is-an-assistant')).toBe('Configured: seen by everyone, answering privately.');
    expect(privateMessageWrongTargetNotice(copy)).toBe('Configured: it went to somebody else.');
  });

  it('NEVER tells the sender the message was dropped, because it was not', () => {
    // A person told their message "was not delivered" while the room is reading it would send it again,
    // and the room would read that too.
    for (const d of ['addressee-is-a-person', 'addressee-is-an-assistant'] as const) {
      const line = privateMessageNotPrivateNotice(undefined, d);
      expect(line).not.toMatch(/not delivered|was dropped|send it again/i);
      expect(line).toMatch(/everyone here can see it/i);
    }
    expect(privateMessageNotPrivateNotice(undefined, 'addressee-is-an-assistant'))
      .not.toBe(privateMessageNotPrivateNotice(undefined, 'addressee-is-a-person'));
    // Only the answering line may promise a reply.
    expect(privateMessageNotPrivateNotice(undefined, 'addressee-is-an-assistant')).toMatch(/answering you privately/i);
    expect(privateMessageNotPrivateNotice(undefined, 'addressee-is-a-person')).not.toMatch(/answering/i);
  });

  it('the wrong-target line says the person named did not get it and asks again, and claims no removal', () => {
    const wrong = privateMessageWrongTargetNotice(undefined);
    expect(wrong).not.toBe(privateMessageNotPrivateNotice(undefined, 'addressee-is-a-person'));
    expect(wrong).toMatch(/did not reach the person you named/i);
    expect(wrong).toMatch(/send it again/i);
    expect(wrong).not.toMatch(/has been removed/i);
  });

  it('declares every key on AssistantCopy, so a deployment can configure any of them', () => {
    const profile = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lambda', 'src', 'lib', 'active-profile.ts'), 'utf8',
    );
    expect(profile).toMatch(/^\s*privateMessageNotPrivate\?: string;$/m);
    expect(profile).toMatch(/^\s*privateMessageNotPrivateAnswering\?: string;$/m);
    expect(profile).toMatch(/^\s*privateMessageWrongTarget\?: string;$/m);
    // The replaced key is no longer DECLARED: a deployment configuring it would get no effect and no
    // warning, and its documented contract ("say the message was NOT delivered") is now the opposite
    // of what happens. Matched as a declaration rather than as a substring, because the comment above
    // it names the old key deliberately - that is the record of what was replaced and why.
    expect(profile).not.toMatch(/^\s*privateMessageLackedTarget\?: string;$/m);
  });

  it('the profile guide documents the keys beside the one they must not be confused with', () => {
    const guide = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'docs', 'guides', 'developer', 'HOW-TO-ADD-OR-MANAGE-A-PROFILE.md'),
      'utf8',
    );
    expect(guide).toMatch(/\|\s*`privateMessageWrongTarget`\s*\|/);
    expect(guide).toMatch(/\|\s*`privateMessageNotPrivate`\s*\|/);
    expect(guide).toMatch(/\|\s*`privateMessageNotPrivateAnswering`\s*\|/);
    expect(guide).not.toContain('privateMessageLackedTarget');
  });
});

describe('the channel flow is wired to it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'channel-flow-processor.ts'), 'utf8');
  const stack = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'stacks', 'channel-flow-stack.ts'), 'utf8');

  it('checks only a resolved private address that names somebody other than the sender', () => {
    expect(src).toContain('if (privateTo && privateTo.arn !== senderArn) {');
  });

  it('hands the check the member the text addressed, so the Target is compared and not just counted', () => {
    // Without this the check can only ask whether SOME Target is set, which is what let `.Alice` ride
    // a Target naming somebody else. The ARN comes from the roster read this turn already made.
    expect(src).toContain('addresseeArn: privateTo.arn,');
  });

  it('tells the sender which of the two happened, with the disposition on the kept one', () => {
    expect(src).toContain("if (check.outcome === 'misdirected') {");
    expect(src).toContain("kind: privateMessageNoticeKind('wrong-target'),");
    expect(src).toContain("if (check.outcome === 'untargeted') {");
    expect(src).toContain("kind: privateMessageNoticeKind('not-private', check.disposition),");
  });

  it('claims the kept branch, so a redelivery does not notify and answer twice', () => {
    // This branch returns ABOVE the shared `dispatchesATurn` claim, so nothing else covers it. Without
    // its own claim a cross-container redelivery sends two notices and runs two turns - the same defect
    // recorded at the shared claim for a redelivered `/stop`.
    const branch = src.indexOf("if (check.outcome === 'untargeted') {");
    const claim = src.indexOf('claimCorrelation(flowDeliveryKey(MessageId))', branch);
    const notice = src.indexOf('sayNotice(', branch);
    expect(branch).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(branch);
    // Claimed BEFORE the notice, or a duplicate still gets a second notice.
    expect(claim).toBeLessThan(notice);
  });

  it('routes to the addressed ASSISTANT with the answer targeted at the sender', () => {
    expect(src).toContain('if (!privateTo.isBot) return;');
    expect(src).toContain('const privateMessage = stripPrivatePrefix(decodedContent, privateTo);');
    // `requestWasPrivate` is what targets the acknowledgment at the sender; the answer inherits that
    // Target. Omitting it would put the answer to a message meant to be private in front of the room.
    //
    // IT REPLACED `broadcast: false`, which said only "the answer is for the asker, not the room" and
    // was read everywhere as "this exchange is private" - so an ordinary 1:1 turn, dispatched with the
    // same flag for the other reason, opened private tasks and drew "I have replied to you privately."
    // receipts in a conversation of two. This flag is about the REQUEST, and only this dispatch sets it.
    const dispatch = src.indexOf('botArn: privateTo.arn,');
    expect(dispatch).toBeGreaterThan(-1);
    expect(src.slice(dispatch, dispatch + 400)).toContain('requestWasPrivate: true,');
  });

  it('lets the check release the message, and does not release it twice', () => {
    // THE FINAL RELEASE IS GUARDED BY EVERY PATH THAT MAY HAVE RELEASED ALREADY. Two can: the
    // private-address check, which releases before reading the stored `Target` back, and ADR-041
    // rule 4, which releases before the roster read for a message that cannot be private. Matching
    // the guard by its flags rather than by one literal line means adding a third release path fails
    // here instead of silently double-releasing.
    const check = src.indexOf('await enforcePrivateAddressTarget(');
    const release = src.indexOf('if (!releasedByPrivateCheck && !releasedEarly)');
    expect(check).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(check);

    // Every `callbackAllow` on the person pass is either a terminal bail (it returns immediately),
    // the check's own `release:` callback, rule 4's early release, or the guarded final one. If a
    // bare unguarded call appears after the check, the message is released twice.
    const guarded = src.slice(release);
    expect(guarded).not.toContain('\n  await callbackAllow(');
  });

  it('rule 4 releases before the roster read, and a private message is no longer excluded', () => {
    // ADR-041 rule 4: the read that decides who answers goes after `callbackAllow`. The flow is
    // synchronous, so until the callback resolves the person has not seen their own message.
    //
    // THE PRIVATE EXCLUSION IS GONE, and its reason went first. It existed while
    // `enforcePrivateAddressTarget` could DELETE a misdirected message - you cannot un-release - and
    // that check now reports on every outcome and deletes nothing. What the exclusion still cost was
    // real: a private message waited for `resolveChannelSize` before its own sender could see it,
    // while every other message was already out. A missing Target is an edge case and the normal path
    // was paying for it.
    //
    // ONE EXCLUSION REMAINS, for a different reason. A message whose Metadata names an open item is
    // the shape `task-answer-repair` acts on, and that component competes for `flow-<MessageId>` to
    // decide which of the two dispatches; the flow can only win reliably if it has claimed before the
    // message reaches the stream, and the claim needs the roster.
    const earlyRelease = src.indexOf('if (!mightBeRepaired) {');
    const rosterRead = src.indexOf('size = await resolveChannelSize(');
    expect(earlyRelease).toBeGreaterThan(-1);
    expect(rosterRead).toBeGreaterThan(earlyRelease);
    expect(src).toContain('releasedEarly = true;');
    expect(src).toContain('const mightBeRepaired = !!extractTaskAnswerHint(Metadata)?.taskId;');
    // The old exclusion is not merely unused - it is absent, so it cannot be reinstated by a rename.
    expect(src).not.toContain('if (!mightBePrivate && !mightBeRepaired) {');
  });

  it('still releases exactly once when the check runs, which is what the exclusion protected', () => {
    // The property the old ordering guaranteed, kept without the wait: the check is handed a no-op
    // when the message is already out, so no path releases twice.
    expect(src).toContain('release: releasedEarly');
    expect(src).toContain('? async () => {}');
  });

  it('resolves NO app-instance admin, because the flow no longer removes anything', () => {
    // The resolver, its cache, its parameter and the env var that pointed at it are all gone with the
    // delete they existed for. Asserted as absence in BOTH the handler and the stack, so a future
    // change cannot restore the privileged bearer on one side and leave the other looking clean.
    expect(src).not.toContain('resolveAdminArn');
    expect(src).not.toMatch(/ADMIN_ARN_PARAM = process\.env\.ADMIN_ARN_PARAM/);
    expect(src).not.toContain('appInstanceAdminArnCache');
    expect(stack).not.toContain('ADMIN_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn');
  });

  it('holds NO delete permission, and no admin bearer, because nothing is removed', () => {
    // THE ABSENCE IS THE ENFORCEMENT. The flow deleted a disagreeing private message as the
    // app-instance admin until 2026-09-16; neither branch deletes now, so the grant and the parameter
    // read behind it are withdrawn with the behavior. Re-adding a delete without re-deciding the
    // policy then fails on permissions instead of quietly working, which is the second layer tenet D3
    // asks for.
    expect(stack).not.toContain("'chime:DeleteChannelMessage'");
    expect(stack).not.toContain('parameter${INSTANCE_SSM.appInstanceAdminArn}');
    expect(src).not.toContain('DeleteChannelMessageCommand');
    // The reads it still needs: the stored Target, and the configured copy for the notices.
    expect(stack).toContain("'chime:GetChannelMessage'");
    expect(stack).toMatch(/ProfileRead:[\s\S]{0,600}\/assistant\/\*\/definition/);
  });
});

// ── THE HANDLER, END TO END THROUGH MOCKED SERVICES ──────────────────────────────────────────────────
describe('a private message through the channel flow', () => {
  const mockSend = jest.fn();
  const mockLambdaSend = jest.fn();
  let handler: (e: any) => Promise<void>;

  const ROSTER = [
    { Member: { Arn: ALICE, Name: 'Alice' } },
    { Member: { Arn: BOB, Name: 'Bob' } },
    { Member: { Arn: BOT, Name: 'Atlas' } },
  ];

  const event = (content: string) => ({
    CallbackId: 'cb-1',
    EventType: 'CHANNEL_MESSAGE',
    ChannelMessage: { MessageId: 'm-1', Content: content, Sender: { Arn: ALICE, Name: 'Alice' }, ChannelArn: CHANNEL },
  });

  const commands = () => mockSend.mock.calls.map(([c]) => c as { __type: string; input: any });
  const callbacks = () => commands().filter((c) => c.__type === 'Callback');
  const posted = () => commands().filter((c) => c.__type === 'SendMessage');
  const deletes = () => commands().filter((c) => c.__type === 'DeleteMessage');
  const invokes = () => mockLambdaSend.mock.calls.map(([c]) => c as { input: any });
  const payloadOf = (c: { input: any }) => JSON.parse(String(c.input.Payload));
  /** The turns the flow handed the router. */
  const turns = () => invokes().filter((c) => payloadOf(c).aeTurn);
  /** The notices the flow handed the router to say, as the assistant, in its own words. */
  const notices = () => invokes().map(payloadOf).filter((p) => p.aeNotice).map((p) => p.aeNotice);

  let reads: Array<unknown | Error>;
  let deleteResult: () => Promise<unknown>;

  beforeEach(async () => {
    jest.resetModules();
    mockSend.mockReset();
    mockLambdaSend.mockReset();
    deleteResult = () => Promise.resolve({});
    process.env.BASIC_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:basic-router';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.doMock('@aws-sdk/client-chime-sdk-messaging', () => ({
      ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
      ChannelFlowCallbackCommand: jest.fn().mockImplementation((input) => ({ __type: 'Callback', input })),
      SendChannelMessageCommand: jest.fn().mockImplementation((input) => ({ __type: 'SendMessage', input })),
      ListChannelMembershipsCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListMemberships', input })),
      ListTagsForResourceCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListTags', input })),
      GetChannelMessageCommand: jest.fn().mockImplementation((input) => ({ __type: 'GetMessage', input })),
      DeleteChannelMessageCommand: jest.fn().mockImplementation((input) => ({ __type: 'DeleteMessage', input })),
      ChannelMessageType: { STANDARD: 'STANDARD' },
      ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
    }));
    // The router hands a reply BACK here, as it does when its own send could not run, so this proves
    // the flow notes it and never posts it in the assistant's name.
    mockLambdaSend.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({ messages: [{ content: 'One moment... <!--corr:c1-->' }] })),
    });
    jest.doMock('@aws-sdk/client-lambda', () => ({
      LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
      InvokeCommand: jest.fn().mockImplementation((input) => ({ input })),
      InvocationType: { Event: 'Event', RequestResponse: 'RequestResponse' },
    }));
    // The bot ARN and the app-instance admin ARN come from DIFFERENT parameters, and the delete must
    // carry the admin: a mock that answered both with the same value could not tell them apart.
    jest.doMock('@aws-sdk/client-ssm', () => ({
      SSMClient: jest.fn().mockImplementation(() => ({
        send: jest.fn((cmd: { Name?: string }) => Promise.resolve({
          Parameter: { Value: String(cmd?.Name || '').includes('app-instance-admin-arn') ? ADMIN : JSON.stringify({ role: 'primary', occupancy: 'live', botArn: BOT }) },
        })),
      })),
      GetParameterCommand: jest.fn().mockImplementation((input) => input),
    }));
    jest.doMock('../../lambda/src/lib/active-profile.js', () => ({
      ...jest.requireActual('../../lambda/src/lib/active-profile.js'),
      resolveActiveProfile: jest.fn().mockResolvedValue({
        copy: {
          privateMessageNotPrivate: 'CONFIGURED NOTICE',
          privateMessageNotPrivateAnswering: 'CONFIGURED ANSWERING NOTICE',
          privateMessageWrongTarget: 'CONFIGURED MISMATCH NOTICE',
        },
      }),
    }));
    mockSend.mockImplementation((cmd: { __type: string }) => {
      if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'basic' }] });
      if (cmd.__type === 'ListMemberships') return Promise.resolve({ ChannelMemberships: ROSTER });
      if (cmd.__type === 'DeleteMessage') return deleteResult();
      if (cmd.__type === 'GetMessage') {
        const next = reads.shift();
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }
      return Promise.resolve({});
    });
    ({ handler } = await import('../../lambda/src/channel-flow-processor.js'));
  });

  afterEach(() => { jest.restoreAllMocks(); delete process.env.BASIC_ROUTER_ARN; });

  it('KEEPS a message addressed to a person, releases once, and tells only the sender', async () => {
    reads = [untargeted];
    await handler(event('.Bob hello'));

    expect(callbacks()).toHaveLength(1);
    expect(callbacks()[0].input.DeleteResource).toBeUndefined();
    expect(deletes()).toHaveLength(0);
    // The flow says nothing itself: it hands the notice to the router, for the sender alone.
    expect(posted()).toHaveLength(0);
    expect(notices()).toEqual([{ kind: 'privateMessageNotPrivate', channelArn: CHANNEL, botArn: BOT, to: [ALICE] }]);
    // Nobody answers a message written for Bob.
    expect(turns()).toHaveLength(0);
  });

  it('ROUTES to the addressed assistant and answers the sender privately', async () => {
    // The whole defect: the sender's client dropped the Target, the room can see the question,
    // and the person still gets their answer - privately, which is the half that can still be kept.
    reads = [untargeted];
    await handler(event('.Atlas what is a feature flag'));

    expect(deletes()).toHaveLength(0);
    expect(turns()).toHaveLength(1);
    // The PREFIX IS STRIPPED: the turn is about feature flags, not about the assistant's own name.
    const turn = payloadOf(turns()[0]).aeTurn;
    expect(turn.userMessage).toBe('what is a feature flag');
    expect(turn.senderArn).toBe(ALICE);
    expect(turn.userMessageId).toBe('m-1');

    expect(notices().map((n) => [n.kind, n.to])).toEqual([['privateMessageNotPrivateAnswering', [ALICE]]]);
    // The flow says nothing itself, not even a placeholder the router hands back. The turn DECLARES the
    // request private, and the router posts its own placeholder targeted at the sender alone, which is
    // what makes the ANSWER private, because the answer inherits it.
    expect(posted()).toHaveLength(0);
    expect(turn.targeted).toBe(true);
  });

  it('answers an address with no request in it with nothing, rather than stranding a placeholder', async () => {
    // `.<Atlas>` RATHER THAN `.Atlas`, and the difference is why this case is written this way. The
    // bare pattern requires trailing whitespace, so `.Atlas` alone resolves to nobody and is ordinary
    // text - correctly, because a dot-word with nothing after it is a typo and answering typos is
    // worse than silence. The delimited form is self-terminating, so it IS an address with an empty
    // request, which is the only way to reach the guard below.
    reads = [untargeted];
    await handler(event('.<Atlas>'));
    expect(turns()).toHaveLength(0);
    // The sender is still told their message was not private; only the turn is skipped.
    expect(notices().map((n) => n.kind)).toEqual(['privateMessageNotPrivateAnswering']);
    expect(posted()).toHaveLength(0);
  });

  it('treats a bare `.Atlas` with nothing after it as ordinary text, addressing nobody', async () => {
    // The complement of the case above, and the one the owner named: a token that only LOOKS like an
    // address is a typo. Nothing is read back, nobody is told anything, and no turn starts.
    reads = [];
    await handler(event('.Atlas'));
    expect(commands().some((c) => c.__type === 'GetMessage')).toBe(false);
    expect(posted()).toHaveLength(0);
    expect(invokes()).toHaveLength(0);
    expect(callbacks()).toHaveLength(1);
  });

  it('releases a private message whose Target names its addressee exactly once and says nothing', async () => {
    reads = [targeted];
    await handler(event('.Bob hello'));

    expect(callbacks()).toHaveLength(1);
    expect(callbacks()[0].input.DeleteResource).toBeUndefined();
    expect(posted()).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
  });

  it('KEEPS a message whose Target names the wrong member, and tells the sender the OTHER line', async () => {
    // `.Bob hello` stored with the assistant as its Target: Bob's words went to the assistant. The
    // sender must not be told the room can see it, because the room cannot - and the message is not
    // removed, because removing it would not take it back from the member who already has it.
    reads = [misdirected];
    await handler(event('.Bob hello'));

    expect(callbacks()).toHaveLength(1);
    expect(deletes()).toHaveLength(0);
    expect(posted()).toHaveLength(0);
    expect(notices()).toEqual([{ kind: 'privateMessageWrongTarget', channelArn: CHANNEL, botArn: BOT, to: [ALICE] }]);
    // No turn: the text addressed Bob, and Bob is not an assistant that was asked anything.
    expect(turns()).toHaveLength(0);
  });

  it('lets a message the assistant cannot read proceed, released once and untouched', async () => {
    reads = [forbidden(), forbidden()];
    await handler(event('.Bob hello'));

    expect(callbacks()).toHaveLength(1);
    expect(deletes()).toHaveLength(0);
    expect(posted()).toHaveLength(0);
  });

  it('does not read anything back for an ordinary message', async () => {
    reads = [];
    await handler(event('.env is missing'));
    expect(commands().some((c) => c.__type === 'GetMessage')).toBe(false);
    expect(callbacks()).toHaveLength(1);
  });
});

// ── WHO `.Atlas` MEANS WHEN TWO MEMBERS CARRY THAT NAME ──────────────────────────────────────────
describe('a private address resolves deterministically, not by roster order', () => {
  const mem = (name: string, arn: string, isBot: boolean) => ({ name, arn, isBot });
  const BOT_ATLAS = mem('Atlas', BOT, true);
  const PERSON_ATLAS = mem('Atlas', ALICE, false);

  it('prefers the ASSISTANT over a person sharing the name, whichever is listed first', () => {
    // The defect this replaces: a single first-match `find` across every member, so the answer came
    // from the order the membership page happened to return. Asserted from BOTH orderings, because a
    // test that only builds the roster one way passes against the old code half the time.
    const { resolvePrivateTarget } = require('../../lambda/src/lib/private-prefix');
    expect(resolvePrivateTarget('.Atlas hello', [PERSON_ATLAS, BOT_ATLAS])).toBe(BOT_ATLAS);
    expect(resolvePrivateTarget('.Atlas hello', [BOT_ATLAS, PERSON_ATLAS])).toBe(BOT_ATLAS);
  });

  it('still resolves a person when no assistant carries that name', () => {
    // Non-vacuity: if it always returned a bot, the case above would prove nothing.
    const { resolvePrivateTarget } = require('../../lambda/src/lib/private-prefix');
    const bob = mem('Bob', BOB, false);
    expect(resolvePrivateTarget('.Bob hello', [bob, BOT_ATLAS])).toBe(bob);
  });

  it('resolves nobody for a name no member carries', () => {
    const { resolvePrivateTarget } = require('../../lambda/src/lib/private-prefix');
    expect(resolvePrivateTarget('.Zzz hello', [PERSON_ATLAS, BOT_ATLAS])).toBeNull();
  });

  it('stops the false MISDIRECTED report that ordering produced', () => {
    // The consequence, end to end in miniature. The composer targeted the ASSISTANT, and the text says
    // `.Atlas`. With first-match resolution and the person listed first, the addressee resolved to the
    // person, the stored Target named the bot, and the check called the sender's correct message
    // misdirected. Now the addressee IS the bot, so the Target matches and nothing is reported.
    const { resolvePrivateTarget } = require('../../lambda/src/lib/private-prefix');
    const resolved = resolvePrivateTarget('.Atlas hello', [PERSON_ATLAS, BOT_ATLAS])!;
    const storedTargetArns = [BOT];
    expect(storedTargetArns.includes(resolved.arn)).toBe(true);
  });
});
