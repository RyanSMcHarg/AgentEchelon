/**
 * WHAT THE STORED MESSAGE SAYS ABOUT ITS `Target`, AND THE TWO DECISIONS THAT DEPEND ON IT.
 *
 * The channel-flow callback carries no `Target` (measured 2026-08-14, ADR-029), but the stored message
 * does. Both decisions below read it back through `GetChannelMessage`.
 *
 * ── 1. WHICH ENTRY ANSWERS A COMMAND THAT WAS SENT PRIVATELY IN A ROOM ──
 *
 * An unaddressed command (`/stop`) in a room is dispatched by the channel flow to the primary
 * assistant, because Amazon Chime SDK `AUTO` routes nothing unaddressed to Lex there. The same text
 * sent with a `Target` is private, and it reaches BOTH entries: `TargetedMessages: ALL` invokes the
 * addressed assistant's Lex, and the flow sees it too.
 *
 * The flow cannot tell the two apart from its callback. Measured 2026-09-15 on the private-stop e2e,
 * that made a private `/stop` run as a public one - the flow dispatched it, the Lex entry stood down
 * for a turn the flow owns, and the refusal a private stop must get never ran.
 *
 * So each entry decides from what IT can know, and the two decisions are complements:
 *
 *  - THE LEX ENTRY, in a room, knows the message was targeted by the fact that it was invoked at all
 *    for an unaddressed command. It answers (`lexEntryAnswersCommand`).
 *  - THE FLOW'S DISPATCHED TURN reads the stored message, which does carry `Target`, and stands down
 *    when it was targeted (`inboundWasTargeted`).
 *
 * IN A 1:1 THE FLOW OWNS IT AND ITS DISPATCH ANSWERS. This paragraph used to say the opposite - "the
 * flow does not own a size-branched command there and Lex answers it" - and `flow-bypass.ts` returns
 * `true` for a one-to-one unconditionally, above the size-branched clause, so the flow has always
 * owned it. Both entries standing down on that reading is what made a private `/stop` in a 1:1 stop
 * nothing and say nothing. The router's stand-down is now gated on the same `!isOneToOne` that
 * `lexEntryAnswersCommand` carries, so the two are complements rather than both declining.
 *
 * ── 2. A PRIVATE ADDRESS MUST CARRY THE `Target` ITS TEXT NAMES ──
 *
 * `.Alice hello` resolving to a real member means the sender believes only Alice can read it. Privacy
 * is enforced by the `Target` the ingress sets, never by the text (ADR-034), so the stored message has
 * to agree with the text on TWO counts. The two disagreements are NOT handled the same way, and the
 * difference is the whole of the decision below:
 *
 *  - THE `Target` EXISTS. Absent, the message goes to the whole room while its sender believes it went
 *    to one person. The sender is told, privately; when the address named an ASSISTANT the turn is
 *    routed to it and answered privately as well.
 *  - THE `Target` NAMES THE MEMBER THE TEXT ADDRESSED. Existence alone was the whole check until this
 *    was fixed, so a client could write `.Alice` and set the `Target` to Bob: the message reads as
 *    properly private, and Bob receives words written for Alice while Alice receives nothing. The
 *    sender is told, in a line of its own.
 *
 * ── NEITHER ONE IS DELETED ──
 *
 * Both used to be removed after release, and the reasoning against that is the same on both branches.
 * **The delete never unsends anything.** Release happens before the read - a held message cannot be
 * read - so by the time the stored `Target` comes back, whoever it reached has had it. Deleting takes
 * it out of the conversation without taking it out of anyone's memory, and it never took it out of the
 * archive (ADR-034). What it reliably does is destroy the sender's own words to fix their client's bug,
 * which is not a trade the sender was offered.
 *
 * So the message stays on both branches and the choice to delete it belongs to the person who wrote it.
 * What differs is only what the sender is TOLD, because the two disclosures are different: one message
 * is in front of the whole room, the other in front of exactly one member who should not have it.
 *
 * A consequence worth stating: this path now removes nothing and needs no privileged bearer. The
 * app-instance admin was resolved solely to delete, and is no longer resolved here at all.
 *
 * The web composer always sets the `Target` that matches a resolved dot, so reaching either branch
 * means a client did not: each is recorded as a potential client defect and counted on its OWN metric,
 * because "no target" and "the wrong target" are different client bugs and an operator has to be able
 * to tell which one is happening.
 */
import {
  ChimeSDKMessagingClient,
  GetChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { commandFor } from './flow-bypass.js';
import { isAccessDenial } from './access-denial.js';
import { emitEmfMetric } from './emf-metrics.js';
import type { AssistantCopy } from './active-profile.js';
import { noticeLine, type NoticeCopyKey } from './assistant-notice.js';

/** True when the Lex entry answers this command token rather than standing down for the flow. */
export function lexEntryAnswersCommand(token: string | null | undefined, isOneToOne: boolean): boolean {
  return commandFor(token)?.dispatch === 'primary' && !isOneToOne;
}

/**
 * One read of the stored message's `Target`.
 *
 * `unreadable` keeps NotFound apart from every other failure, because a message read moments after
 * release may simply not be stored yet, and that case has a second chance. The reason is a plain word rather than the SDK's error name: the e2e backend-error guard
 * greps handler logs for `Exception`, and a read that is expected to miss must not look like a fault.
 *
 * `targeted` CARRIES THE MEMBER ARNs, and that is the difference between "a `Target` is set" and "the
 * right `Target` is set". The read used to answer only the first, which let a message whose text says
 * `.Alice` and whose `Target` names Bob pass as properly private. The caller that has the addressee in
 * hand compares them; the caller that only asks "was this private at all" (`inboundWasTargeted`)
 * ignores the list. `Target` holds exactly one member by the AWS API, so the list is a list of one,
 * and it is kept as a list rather than a string because nothing here needs to assume that.
 */
export type StoredTargetRead =
  | { kind: 'targeted'; memberArns: string[] }
  | { kind: 'untargeted' }
  | { kind: 'unreadable'; reason: 'not-found' | 'failed' | 'refused'; errName?: string };

/**
 * IS THIS REPLY ADDRESSED TO THE PERSON WHOSE TURN IT IS?
 *
 * A targeted answer inherits the placeholder's `Target`, and what decided that inheritance was
 * `Target.length > 0` - "is this addressed to somebody" - rather than "is this addressed to the person
 * who ASKED". A placeholder naming a different member would hand that turn's answer to them, and the
 * answer is the longer and more revealing half of the exchange.
 *
 * A PURE PREDICATE ON PURPOSE. The decision lives here rather than inline at the read so it can be
 * asserted directly: inline, the only observable difference was a log line, and a test written against
 * that passes whether or not the comparison is made - which is a guard that does not guard.
 *
 * THE THREE ANSWERS ARE DELIBERATELY DISTINCT, because they are three different situations:
 *  - `'untargeted'`: no `Target` at all. An ordinary broadcast reply, and the common path.
 *  - `'asker'`: the target names the person whose turn this is. Inherit it.
 *  - `'someone-else'`: the target names a member who did not ask. Do NOT inherit, and say so.
 *
 * AN ABSENT ASKER IS `'asker'`, NOT A MISMATCH. A platform-driven turn has nobody to compare against,
 * and treating unconfirmable as mismatched would stop inheriting a target that was set correctly. The
 * caller cannot tell the two apart from the result, which is why "cannot confirm" keeps the permissive
 * answer and the caller logs nothing: a finding nobody can act on is noise.
 */
export function replyTargetAudience(
  targetArns: readonly string[],
  askerArn: string | undefined,
): 'untargeted' | 'asker' | 'someone-else' {
  const named = targetArns.filter((a) => !!a);
  if (named.length === 0) return 'untargeted';
  if (!askerArn) return 'asker';
  return named.includes(askerArn) ? 'asker' : 'someone-else';
}

export async function readStoredTarget(
  client: ChimeSDKMessagingClient,
  channelArn: string,
  messageId: string,
  bearerArn: string,
): Promise<StoredTargetRead> {
  try {
    const res = await client.send(new GetChannelMessageCommand({
      ChannelArn: channelArn,
      MessageId: messageId,
      ChimeBearer: bearerArn,
    }));
    const target = (res.ChannelMessage as { Target?: Array<{ MemberArn?: string }> } | undefined)?.Target;
    const memberArns = Array.isArray(target)
      ? target.map((t) => t?.MemberArn).filter((arn): arn is string => !!arn)
      : [];
    return memberArns.length > 0 ? { kind: 'targeted', memberArns } : { kind: 'untargeted' };
  } catch (err) {
    const errName = (err as Error)?.name;
    // `refused` IS SEPARATED FROM `failed` BECAUSE THEY AGE DIFFERENTLY. `failed` invites the retry
    // this module already does and reads as transient; a refusal from the classification boundary is
    // permanent for this assistant in this room, so retrying it just probes the boundary twice. The
    // turn-ending decision is NOT made here - see `inboundWasTargeted` for why it belongs to the
    // caller - but mislabelling the reason sends the next reader chasing a throttle that never
    // existed (ADR-045 decision 1).
    if (isAccessDenial(err)) return { kind: 'unreadable', reason: 'refused', errName };
    return { kind: 'unreadable', reason: errName === 'NotFoundException' ? 'not-found' : 'failed', errName };
  }
}

/**
 * Whether the stored inbound message carried a `Target`.
 *
 * READ BACK TWICE AT MOST. The flow releases the message and then dispatches, so the read lands moments
 * after the write; a first read that finds nothing is retried once after a short pause. That is a
 * bounded read-after-write, not a schedule: nothing re-derives state an event already delivers.
 *
 * AN UNREADABLE MESSAGE PROCEEDS AS PUBLIC. Standing a public `/stop` down on a failed read would take
 * away the escape hatch for everyone; running a private one as public only skips a courtesy. Logged,
 * so the read failure is the thing to chase.
 *
 * INCLUDING A REFUSED ONE, AND THAT IS NOT THIS FUNCTION DECIDING TO IGNORE THE BOUNDARY. A refusal
 * here means the assistant may not act in this conversation at all, which is a bigger answer than
 * "was this message targeted" and is not expressible in this function's boolean. The router settles
 * it a few lines after this call, at `channel-classification:first-read`, where the turn ends before
 * intent classification, drift or dispatch (ADR-045 decision 1). Widening this return type so the
 * decision could ALSO be taken here would put the same rule in two places and let them disagree,
 * which is the shape ADR-045 is itself about. The reason is recorded as `refused` so the log names
 * the boundary rather than a phantom throttle.
 */
export async function inboundWasTargeted(
  client: ChimeSDKMessagingClient,
  channelArn: string,
  messageId: string,
  bearerArn: string,
  pauseMs = 250,
): Promise<boolean> {
  const target = await inboundTarget(client, channelArn, messageId, bearerArn, pauseMs);
  if (target === 'unreadable') {
    console.warn('[PrivateCommand] could not read the inbound message; treating it as public', { channelArn, messageId });
    return false;
  }
  return target === 'targeted';
}

/**
 * The same bounded read, answering `unreadable` rather than settling it. A caller whose safe direction
 * is PRIVATE takes this: an assistant's reply to a request it cannot prove was public is targeted at
 * the sender (DESIGN-TASK-ACCESS 2.4), where `/stop` above must not lose its public escape hatch.
 */
export async function inboundTarget(
  client: ChimeSDKMessagingClient,
  channelArn: string,
  messageId: string,
  bearerArn: string,
  pauseMs = 250,
): Promise<'targeted' | 'public' | 'unreadable'> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const read = await readStoredTarget(client, channelArn, messageId, bearerArn);
    if (read.kind !== 'unreadable') return read.kind === 'targeted' ? 'targeted' : 'public';
    if (attempt === 2) return 'unreadable';
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  return 'unreadable';
}

/**
 * Who the `.` address NAMED, on a message whose stored form disagreed with it.
 *
 * NOTHING IS DELETED ON EITHER BRANCH, so there is no "how the message left" to
 * describe and this is the only dimension either defect has. The two values differ in whether a turn
 * can follow: an assistant can be routed to and can answer, a person cannot.
 *
 * THIS REPLACED A `post-release-delete` / `post-release-delete-failed` PAIR that both branches shared.
 * Its comment argued for one shared type because the two "leave by the same door and can fail to leave
 * for the same reason"; once neither leaves, the shared type described nothing that happens.
 */
export type PrivateAddressDisposition = 'addressee-is-an-assistant' | 'addressee-is-a-person';

/**
 * What the flow does next with a message whose text resolved to a private address. In every outcome
 * the message has already been released, exactly once, by this check.
 *
 *  - `targeted`: the stored `Target` names the member the text addressed; proceed exactly as before.
 *  - `untargeted`: it carried no `Target`, so the ROOM can read it. The message is KEPT and the caller
 *    routes it; `disposition` says whether the address named an assistant, which is the only case a
 *    turn can follow from.
 *  - `misdirected`: it carried a `Target` naming somebody else, so ONE WRONG MEMBER can read it. The
 *    message is KEPT here too; the caller tells the sender and starts no turn.
 *  - `unverified`: the stored message could not be read; it proceeds as sent, logged.
 */
export type PrivateTargetCheck =
  | { outcome: 'targeted' }
  | { outcome: 'untargeted'; disposition: PrivateAddressDisposition }
  | { outcome: 'misdirected'; disposition: PrivateAddressDisposition }
  | { outcome: 'unverified' };

/**
 * Hold a privately addressed message to the `Target` its text claims.
 *
 * ── RELEASE FIRST, THEN READ ──
 *
 * A message the channel flow is still holding cannot be read: measured 2026-09-15, `GetChannelMessage`
 * during the callback failed for a targeted and an untargeted message alike. So there is no decision
 * to make before release, and no denial path. The message is released once, as it always was, and
 * then read back as the assistant with the bounded read-after-write `inboundWasTargeted` uses.
 *
 * ── NEITHER DISAGREEMENT DELETES THE MESSAGE ──
 *
 * Both branches USED TO DELETE it as the app-instance admin and tell the sender it had been dropped.
 * The reasoning against that is worth keeping, because the deleting version looked like the cautious
 * one:
 *
 *  - THE DELETE DID NOT UNSEND ANYTHING. Release happens first - a held message cannot be read - so by
 *    the time the read comes back, whoever it reached has had it. The delete removes it from the
 *    conversation and never from the archive (ADR-034), so what it actually buys is a shorter window on
 *    a disclosure that already happened, at the cost of destroying the person's words.
 *  - AND ON THE UNTARGETED BRANCH IT COST THEM THEIR TURN. The sender got a notice and no answer, for a
 *    defect in their client.
 *
 * So the message stays either way, and the choice to delete it belongs to the person who wrote it.
 *
 * ── WHAT DIFFERS IS THE NOTICE, BECAUSE THE TWO DISCLOSURES ARE DIFFERENT ──
 *
 * NO `Target`: the message is in front of the WHOLE ROOM. The sender is told that, and when the address
 * named an ASSISTANT the flow routes the turn to it and answers the sender privately - the answer is
 * the longer and more revealing half of the exchange, so it is the half that most needs to be targeted,
 * and it is the half that can still be kept. When the address named a PERSON there is no turn to run.
 *
 * THE WRONG `Target`: `.Alice hello` stored with a `Target` naming Bob went to ONE MEMBER who should
 * not have it, and Alice received nothing. The room cannot see it. The two remaining options are both
 * wrong for that: proceeding tells nobody, so the sender never learns Alice did not hear them, and
 * sending `privateMessageNotPrivate` would tell them the room can see it, which is false. So it gets a
 * line of its own (`privateMessageWrongTarget`), which says the person they named did not receive it
 * and that sending it again is the remedy - and unlike the untargeted branch, re-sending IS the remedy,
 * because that message is not in front of the room. Counted as `private_message_target_mismatch`, a
 * metric distinct from the untargeted one, because the two say different things about the client.
 *
 * THIS FUNCTION DOES NOT ROUTE OR NOTIFY. It returns the outcome with the disposition and the caller
 * acts, because dispatching needs the router, the classification and the stripped text - none of which
 * this module has, and all of which the flow processor already holds.
 *
 * ── UNREADABLE PROCEEDS, AND FOR A PERSON THAT IS THE EXPECTED CASE ──
 *
 * The read is made as the assistant, which can read a message only as its sender or its target.
 * Measured 2026-09-15, a message correctly targeted at another PERSON is unreadable to the assistant
 * (and to the app-instance admin, though nothing here reads as one). So for a `.` address naming a person, "unreadable" is the signature of a message
 * that really was targeted at that person, and proceeding is the correct outcome rather than a gap:
 * an untargeted message is readable by every member, the assistant included, and reads as
 * `untargeted`. For a `.` address naming the ASSISTANT, a targeted message reads as `targeted`, so
 * "unreadable" there is a genuine read failure; it proceeds too, because the check exists to stop a
 * disclosure, not to add a way to lose a person's words. Both are logged with the addressee's kind.
 *
 * ── WHICH MISMATCHES ARE VISIBLE AT ALL, STATED SO THE CHECK IS NOT READ AS MORE THAN IT IS ──
 *
 * The comparison happens only on a message this bearer can READ, and that same measurement says which
 * messages those are: a targeted message is readable by its sender and its target and by nobody else,
 * the app-instance admin included. The flow reads as the assistant, never as the sender, so the mismatches it can
 * see are the ones whose stored `Target` names THE ASSISTANT - `.Alice hello` sent privately to the
 * assistant instead of to Alice. A message targeted at a third PERSON reads as unreadable, which is
 * also how a correct one reads, and no bearer exists that could tell those two apart.
 *
 * That is a limit of the platform rather than of this code, and it is the right answer here anyway:
 * the alternative is to guess from an unreadable read, and guessing would delete correctly targeted
 * private messages - the common case - to catch a client defect, which is a worse failure than the one
 * it prevents. The honest scope is "the wrong target is caught wherever it can be seen, and the
 * assistant is where a misdirected private message actually lands", and the counter is what tells an
 * operator it is happening.
 */
export async function enforcePrivateAddressTarget(args: {
  client: ChimeSDKMessagingClient;
  channelArn: string;
  messageId: string;
  /** The flow's own identity for the read: the conversation's primary assistant. */
  botArn: string;
  /**
   * The member the `.` address RESOLVED to, against this conversation's roster. Already in hand at the
   * only call site - this function is reached solely for an address that resolved to somebody other
   * than the sender - so the comparison costs no read of its own. Required rather than optional, so a
   * caller cannot get the old existence-only check back by leaving it out.
   */
  addresseeArn: string;
  addresseeIsBot: boolean;
  /** Release the pending message unchanged. */
  release: () => Promise<void>;
  pauseMs?: number;
}): Promise<PrivateTargetCheck> {
  const {
    client, channelArn, messageId, botArn, addresseeArn, addresseeIsBot, release,
    pauseMs = 250,
  } = args;

  await release();

  // WHO THE TEXT ADDRESSED, which is the only thing either disagreement has to report now that neither
  // deletes. Resolved once here because both branches below carry it.
  const disposition: PrivateAddressDisposition = addresseeIsBot
    ? 'addressee-is-an-assistant'
    : 'addressee-is-a-person';

  // ── THE RETRY IS FOR AN ASSISTANT ADDRESSEE ONLY ──────────────────────────
  //
  // The second attempt exists for a read that is transiently unreadable. For a PERSON addressee an
  // unreadable read is not transient, it is the correct answer: the message is targeted at two humans
  // and the assistant doing the reading is not one of them. So `.Alice hello` paid an extra
  // `GetChannelMessage` plus `pauseMs` every single time, to re-confirm something that cannot change,
  // on a path that then dispatches nothing at all.
  //
  // WHAT IS NOT LOST. The one outcome worth catching for a person - `untargeted`, their supposedly
  // private message readable by the room - is decided on the FIRST read, because an untargeted message
  // is readable. Only the already-correct case is shortened.
  const attempts = addresseeIsBot ? 2 : 1;
  let last: StoredTargetRead | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, pauseMs));
    last = await readStoredTarget(client, channelArn, messageId, botArn);
    if (last.kind === 'targeted') {
      // EXACT ARN MATCH. Both sides are Amazon Chime SDK member ARNs - one from the stored message, one
      // resolved from the roster read this turn already paid for - so there is nothing to normalize,
      // and a looser comparison would be a way for two spellings to pass as one member.
      if (last.memberArns.includes(addresseeArn)) return { outcome: 'targeted' };
      recordPrivateMessageTargetMismatch({ channelArn, messageId, addresseeIsBot, disposition });
      return { outcome: 'misdirected', disposition };
    }
    if (last.kind === 'untargeted') {
      recordPrivateMessageWithoutTarget({ channelArn, messageId, addresseeIsBot, disposition });
      return { outcome: 'untargeted', disposition };
    }
  }

  // For a person addressee this is the expected shape of a correctly targeted message (see above);
  // for an assistant addressee it is a real read failure, so only that one is a warning. Either way the
  // message proceeds as sent.
  (addresseeIsBot ? console.warn : console.log)('[PrivateAddress] stored message not readable to the assistant; it proceeds as sent', {
    channelArn, messageId, addresseeIsBot, reason: last?.kind === 'unreadable' ? last.reason : null,
  });
  return { outcome: 'unverified' };
}

export const CHANNEL_FLOW_METRIC_NAMESPACE = 'AgentEchelon/ChannelFlow';
export const PRIVATE_MESSAGE_WITHOUT_TARGET_METRIC = 'private_message_without_target';
/**
 * A private address whose `Target` named the WRONG member. Its own metric rather than a third `Path`
 * value on the one above, because the two are different client defects: "the composer set no target"
 * is a message that went to the room, and "the composer set somebody else's" is a message that went to
 * one wrong person. They want different alarms and they point at different client code, and a single
 * series would make the more serious of them invisible inside the noisier one.
 */
export const PRIVATE_MESSAGE_TARGET_MISMATCH_METRIC = 'private_message_target_mismatch';

/**
 * A privately addressed message arrived without a `Target`: a potential client defect, recorded.
 *
 * A structured warning carrying ids and shape, never the content, plus one EMF count. The
 * dimensionless series is the one an alarm watches; the `Path` series says how it was dropped.
 * Never throws: the instrument must not cost the notice it measures.
 */
export function recordPrivateMessageWithoutTarget(args: {
  channelArn: string;
  messageId: string;
  addresseeIsBot: boolean;
  disposition: PrivateAddressDisposition;
}): void {
  const { channelArn, messageId, addresseeIsBot, disposition } = args;
  try {
    console.warn('[PrivateAddress][ClientDefect] a privately addressed message arrived without a Target', {
      channelArn, messageId, addresseeIsBot, disposition,
    });
    emitEmfMetric({
      namespace: CHANNEL_FLOW_METRIC_NAMESPACE,
      metrics: [{ name: PRIVATE_MESSAGE_WITHOUT_TARGET_METRIC, unit: 'Count' }],
      // `Disposition` RATHER THAN `Path`, because the message no longer leaves: the dimension says who
      // the address named, which is what decides whether a turn follows. An alarm still watches the
      // dimensionless series, and that series counts the same client defect it always did.
      dimensionSets: [[], ['Disposition']],
      properties: {
        Disposition: disposition,
        [PRIVATE_MESSAGE_WITHOUT_TARGET_METRIC]: 1,
        ChannelArn: channelArn,
        MessageId: messageId,
        AddresseeIsBot: addresseeIsBot ? 'true' : 'false',
      },
    });
  } catch {
    // Measurement must never cost the notice.
  }
}

/**
 * A privately addressed message was stored with a `Target` naming somebody else: recorded.
 *
 * Deliberately a copy of the shape above rather than a parameter on it. The two emit different metric
 * NAMES, which is the whole point of separating them, and the `Path` dimension means the same thing on
 * both, so a reader comparing the branches sees one difference instead of a flag to follow.
 * Never throws: the instrument must not cost the notice it measures.
 */
export function recordPrivateMessageTargetMismatch(args: {
  channelArn: string;
  messageId: string;
  addresseeIsBot: boolean;
  disposition: PrivateAddressDisposition;
}): void {
  const { channelArn, messageId, addresseeIsBot, disposition } = args;
  try {
    console.warn('[PrivateAddress][ClientDefect] a privately addressed message carried a Target naming another member', {
      channelArn, messageId, addresseeIsBot, disposition,
    });
    emitEmfMetric({
      namespace: CHANNEL_FLOW_METRIC_NAMESPACE,
      metrics: [{ name: PRIVATE_MESSAGE_TARGET_MISMATCH_METRIC, unit: 'Count' }],
      // `Disposition` rather than `Path`: nothing is deleted on this branch either, so there is no
      // way the message "ended" to dimension on. The dimensionless series stays the one to alarm on.
      dimensionSets: [[], ['Disposition']],
      properties: {
        Disposition: disposition,
        [PRIVATE_MESSAGE_TARGET_MISMATCH_METRIC]: 1,
        ChannelArn: channelArn,
        MessageId: messageId,
        AddresseeIsBot: addresseeIsBot ? 'true' : 'false',
      },
    });
  } catch {
    // Measurement must never cost the notice.
  }
}

/**
 * The line sent to the sender when their private address arrived with no `Target`.
 *
 * THE MESSAGE WAS NOT DROPPED, AND THE LINE MUST NOT SAY IT WAS. The previous wording - "That message
 * was not delivered ... Please send it again" - described the behavior that was reversed on 2026-09-16,
 * and left in place it would tell somebody their words had vanished while the room was reading them.
 * Worse, it would invite a re-send, which the room would also read.
 *
 * TWO LINES, BY DISPOSITION, because the two situations differ in what happens next and a person needs
 * to know which one they are in. For an assistant the answer follows, privately; for a person there is
 * no answer coming and the only fact worth telling them is that the message was not private. Both say
 * the message is still there and leave the decision to delete it with the person who wrote it.
 */
export function privateMessageNotPrivateNotice(
  copy: AssistantCopy | undefined,
  disposition: PrivateAddressDisposition,
): string {
  return noticeLine(copy, privateMessageNoticeKind('not-private', disposition));
}

/**
 * The line for the other refusal: the message was private, and private to the wrong member.
 *
 * A SEPARATE LINE, NOT A REUSE. `privateMessageNotPrivateNotice` says everyone in the room can see the
 * message and that it is still there, and on this branch both halves are false: it went privately to
 * one wrong member, and it has been removed. Re-sending IS the remedy here, which is the other reason
 * the lines cannot be shared - saying it on the untargeted branch would put the message in the room a
 * second time.
 */
export function privateMessageWrongTargetNotice(copy: AssistantCopy | undefined): string {
  return noticeLine(copy, 'privateMessageWrongTarget');
}

/**
 * WHICH NOTICE tells the sender what became of their privately addressed message, from `reason`.
 *
 * `wrong-target` is a refusal: the message went privately to the wrong member. `not-private` is a
 * notice: the message is still in the conversation and the room can read it, and for an assistant
 * addressee an answer is already on its way privately. The channel flow hands the kind to the router,
 * which says it as the assistant in that assistant's own copy (`lib/assistant-notice.ts`).
 */
export function privateMessageNoticeKind(
  reason: 'not-private' | 'wrong-target',
  disposition: PrivateAddressDisposition = 'addressee-is-a-person',
): NoticeCopyKey {
  if (reason === 'wrong-target') return 'privateMessageWrongTarget';
  return disposition === 'addressee-is-an-assistant' ? 'privateMessageNotPrivateAnswering' : 'privateMessageNotPrivate';
}

