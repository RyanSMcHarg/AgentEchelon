/**
 * Backend reads for a duel's state machine, so the owner rule can be asserted against the SOURCE OF
 * TRUTH rather than the DOM.
 *
 * Ownership is enforced server-side and renders nowhere: a non-owner's reply is not refused with an
 * error, it simply resumes nothing and is answered as an ordinary turn. From the browser that looks
 * almost exactly like success - a message was sent, an assistant answered. The claim only has one
 * observable: whether the waiting side's `BattleState` row LEFT `WAITING_FOR_USER`. So this reads it.
 *
 * Uses the `aws` CLI through execFileSync, the same vantage `drift-backend.ts` uses, because the e2e
 * process holds a browser session rather than AWS credentials for these tables.
 */
import { INSTANCE } from './stack-prefix';
import { awsv as aws } from './aws';

const ssmCache = new Map<string, string>();
function ssm(name: string): string {
  const hit = ssmCache.get(name);
  if (hit) return hit;
  const v = String(aws(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value'])).trim();
  ssmCache.set(name, v);
  return v;
}

/** Table names are published to SSM by the Battle stack (SHARED_SSM), which is the stable contract. */
const battleStateTable = () => ssm(`/${INSTANCE}/shared/tables/battle-state-name`);
const channelBattleConfigTable = () => ssm(`/${INSTANCE}/shared/tables/channel-battle-config-name`);

/** `…/app-instance/<id>/user/agent-echelon-admin` -> `…/app-instance/<id>` */
export function appInstanceArn(): string {
  return ssm(`/${INSTANCE}/app-instance-admin-arn`).split('/user/')[0];
}

export function channelArnFor(channelId: string): string {
  return `${appInstanceArn()}/channel/${channelId}`;
}

const s = (v: any): string | undefined => (v && typeof v === 'object' && 'S' in v ? v.S : undefined);

export interface DuelSide {
  battleId: string;
  botArn: string;
  state: string;
  initiatorUserSub?: string;
  waitingMessageId?: string;
  enteredStateAt?: string;
  /** How long the side has spent waiting on the person, accumulated by each resume. */
  waitedMs?: number;
}

/**
 * The channel's in-flight duel AND its owner - the pointer row, which is exactly what the continuation
 * path reads to decide both "which duel is this reply about" and "whose reply counts".
 */
export function readActiveBattle(channelId: string): { battleId?: string; initiatorUserSub?: string } {
  const res = aws([
    'dynamodb', 'get-item',
    '--table-name', channelBattleConfigTable(),
    '--key', JSON.stringify({ channelArn: { S: channelArnFor(channelId) } }),
  ]);
  const item = res?.Item;
  return { battleId: s(item?.activeBattleId), initiatorUserSub: s(item?.activeBattleInitiator) };
}

/** The per-bot rows of one duel. Sentinels (`__round1__`, `__complete__`, …) are not sides. */
export function readDuelSides(battleId: string): DuelSide[] {
  const res = aws([
    'dynamodb', 'query',
    '--table-name', battleStateTable(),
    '--key-condition-expression', 'battleId = :b',
    '--expression-attribute-values', JSON.stringify({ ':b': { S: battleId } }),
  ]);
  return (res?.Items || [])
    .filter((i: any) => s(i.botArn) && !s(i.botArn)!.startsWith('__'))
    .map((i: any) => ({
      battleId: s(i.battleId)!,
      botArn: s(i.botArn)!,
      state: s(i.state)!,
      initiatorUserSub: s(i.initiatorUserSub),
      waitingMessageId: s(i.waitingMessageId),
      enteredStateAt: s(i.enteredStateAt),
      waitedMs: i.waitedMs?.N !== undefined ? Number(i.waitedMs.N) : undefined,
    }));
}

async function poll<T>(fn: () => T | null, timeoutMs: number, everyMs = 5_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = fn();
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Wait for the channel's pointer to name a duel (fan-out stamps it). */
export function waitForActiveBattle(
  channelId: string,
  timeoutMs = 120_000,
): Promise<{ battleId?: string; initiatorUserSub?: string } | null> {
  return poll(() => {
    const a = readActiveBattle(channelId);
    return a.battleId ? a : null;
  }, timeoutMs);
}

/**
 * Wait for the channel's pointer to name NO duel - the conversation is free again.
 *
 * THE INVERSE OF `waitForActiveBattle`, and it exists because ending a duel is not instantaneous.
 * `/battle end` returns a reply as soon as the command is accepted, while releasing the pointer,
 * abandoning the sides and clearing the waiting markers settle after it. A test that fires the next
 * `/battle` on the strength of that reply is racing the release: the new command is refused because
 * a duel is still live, nothing further renders, and the failure reads as "a second duel never
 * started" rather than "the first one had not finished ending".
 *
 * Returns true when the pointer is clear, false on timeout - so a caller can assert the release
 * itself rather than discovering it through whatever it tried to do next.
 */
export async function waitForNoActiveBattle(channelId: string, timeoutMs = 120_000): Promise<boolean> {
  const cleared = await poll(() => (readActiveBattle(channelId).battleId ? null : true), timeoutMs);
  return cleared === true;
}

/** Wait for ANY side of the duel to be blocked on the user. */
export function waitForWaitingSide(battleId: string, timeoutMs = 300_000): Promise<DuelSide | null> {
  return poll(() => readDuelSides(battleId).find((r) => r.state === 'WAITING_FOR_USER') ?? null, timeoutMs);
}

/** The state of one side, now. */
export function sideState(battleId: string, botArn: string): string | undefined {
  return readDuelSides(battleId).find((r) => r.botArn === botArn)?.state;
}

/**
 * Assert a side is STILL waiting for the whole window - the negative half of the owner rule.
 *
 * Deliberately a hold rather than a single read: a resume that happens two seconds after the check
 * would otherwise pass, and "the enforcement is slow" is not "the enforcement worked".
 */
export async function holdsWaiting(battleId: string, botArn: string, forMs: number): Promise<string> {
  const deadline = Date.now() + forMs;
  let last = sideState(battleId, botArn) ?? 'MISSING';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    last = sideState(battleId, botArn) ?? 'MISSING';
    if (last !== 'WAITING_FOR_USER') return last;
  }
  return last;
}

/**
 * Send a reply `Target`-addressed at one bot, AS a given member.
 *
 * The same wire shape as the composer's reply to a side (`Target: [{MemberArn}]`, STANDARD, PERSISTENT).
 * The chat app offers that reply only to the duel's owner, through the side's "Reply to this side"
 * control (B-E7 answers through it), so this is how a test sends what the UI does not offer: a
 * non-owner's targeted reply, which the router must refuse to treat as an answer.
 *
 * Sends with admin IAM credentials and the member's own `ChimeBearer`, which is what makes the message
 * genuinely FROM that person as far as the flow's sender check is concerned.
 */
export function sendTargetedAs(
  channelId: string,
  senderUserArn: string,
  targetBotArn: string,
  content: string,
): string {
  const res = aws([
    'chime-sdk-messaging', 'send-channel-message',
    '--channel-arn', channelArnFor(channelId),
    '--content', content,
    '--type', 'STANDARD',
    '--persistence', 'PERSISTENT',
    '--chime-bearer', senderUserArn,
    '--target', `MemberArn=${targetBotArn}`,
  ]);
  return res?.MessageId as string;
}

/**
 * Answer every side of the channel's duel once all of them are parked on the person, as the person who
 * started it, with a reply targeted at each side.
 *
 * A task-shaped side runs its own chain and asks for its own input (ADR-026), so each side is answered on
 * its own: the image workflow's `confirm` step is presented (ADR-064 decision G), and no image is drawn
 * until the person confirms the brief that side recorded. Waiting for ALL sides first keeps the two
 * answers one exchange apart, never one side's confirmation racing the other side's first leg.
 *
 * Returns the sides as they stood when answered, so a caller can assert there were two of them.
 */
export async function answerEverySide(channelId: string, content: string, timeoutMs = 420_000): Promise<DuelSide[]> {
  const active = await waitForActiveBattle(channelId, 180_000);
  if (!active?.battleId || !active.initiatorUserSub) return [];
  const parked = await poll(() => {
    const sides = readDuelSides(active.battleId!);
    return sides.length >= 2 && sides.every((r) => r.state === 'WAITING_FOR_USER') ? sides : null;
  }, timeoutMs);
  if (!parked) return [];
  const owner = personArnForRecordedId(active.initiatorUserSub);
  for (const side of parked) sendTargetedAs(channelId, owner, side.botArn, content);
  return parked;
}

/**
 * Send an ordinary BROADCAST message as a given member - the shape a person typing into the composer
 * produces, and therefore the shape a command like `/battle end` arrives in.
 *
 * The targeted sibling above cannot stand in for this: a `Target` makes the message a directed reply,
 * which the flow routes down the continuation path instead of the command path.
 */
export function sendAs(channelId: string, senderUserArn: string, content: string): string {
  const res = aws([
    'chime-sdk-messaging', 'send-channel-message',
    '--channel-arn', channelArnFor(channelId),
    '--content', content,
    '--type', 'STANDARD',
    '--persistence', 'PERSISTENT',
    '--chime-bearer', senderUserArn,
  ]);
  return res?.MessageId as string;
}

/** Wait for the channel's pointer to be RELEASED - the duel ended and the channel is free. */
export function waitForPointerCleared(channelId: string, timeoutMs = 120_000): Promise<boolean | null> {
  return poll(() => (readActiveBattle(channelId).battleId ? null : true), timeoutMs);
}

/**
 * Assert the pointer still names `battleId` for the whole window - the negative half of the ownership
 * rule, and a hold rather than a single read for the same reason `holdsWaiting` is: an end that lands
 * two seconds after the check would otherwise pass, and "the refusal is slow" is not "it was refused".
 *
 * Returns the battleId the pointer ended on, or `null` if it was cleared at any point.
 */
export async function holdsPointer(
  channelId: string,
  battleId: string,
  forMs: number,
): Promise<string | null> {
  const deadline = Date.now() + forMs;
  for (;;) {
    const now = readActiveBattle(channelId).battleId ?? null;
    if (now !== battleId) return now;
    if (Date.now() > deadline) return now;
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

/** Wait for one side to reach a given state. */
export function waitForSideState(
  battleId: string,
  botArn: string,
  state: string,
  timeoutMs = 120_000,
): Promise<string | null> {
  return poll(() => (sideState(battleId, botArn) === state ? state : null), timeoutMs);
}

/**
 * The AppInstanceUser ARN for a person id a server record holds (the battle pointer's initiator). A
 * test user's own ARN comes from `helpers/person.ts`, never from here.
 */
export function personArnForRecordedId(personId: string): string {
  return `${appInstanceArn()}/user/${personId}`;
}

/** The human members of a channel, as ARNs (admin bearer reads any channel without joining). */
export function humanMembers(channelId: string): string[] {
  const res = aws([
    'chime-sdk-messaging', 'list-channel-memberships',
    '--channel-arn', channelArnFor(channelId),
    '--chime-bearer', ssm(`/${INSTANCE}/app-instance-admin-arn`),
  ]);
  return (res?.ChannelMemberships || [])
    .map((m: any) => m?.Member?.Arn as string)
    .filter((arn: string) => arn && arn.includes('/user/'));
}

/**
 * The id of the newest message `senderUserArn` sent with exactly this content, read as the sender, or
 * null when none arrived inside the window. For a reply sent through the UI, whose id the test never saw.
 */
export async function messageIdSentBy(
  channelId: string,
  senderUserArn: string,
  content: string,
  timeoutMs = 30_000,
): Promise<string | null> {
  return poll(() => {
    const res = aws([
      'chime-sdk-messaging', 'list-channel-messages',
      '--channel-arn', channelArnFor(channelId),
      '--chime-bearer', senderUserArn,
      '--max-results', '20',
    ]);
    const mine = (res?.ChannelMessages || []).find((m: any) => m?.Sender?.Arn === senderUserArn
      && decodeURIComponent(m?.Content || '') === content);
    return (mine?.MessageId as string | undefined) ?? null;
  }, timeoutMs, 2_000);
}

/**
 * Is a message persisted in the channel, read as the SENDER?
 *
 * The sender's own bearer is the only vantage that settles allowed-vs-denied for a targeted message:
 * Chime shows a targeted message to its sender and its target and NOBODY else, so the app-instance
 * admin - which can read any channel - cannot see it either way, and its absence there means nothing.
 * A DENIED message is never persisted, so presence here IS the difference.
 */
export function messageExistsForSender(channelId: string, senderUserArn: string, messageId: string): boolean {
  try {
    const res = aws([
      'chime-sdk-messaging', 'get-channel-message',
      '--channel-arn', channelArnFor(channelId),
      '--message-id', messageId,
      '--chime-bearer', senderUserArn,
    ]);
    return Boolean(res?.ChannelMessage?.MessageId);
  } catch {
    return false;
  }
}

/**
 * Messages in the channel that EVERYONE can see, newest first.
 *
 * Read with the app-instance-admin bearer, which is a member of nothing: it sees a channel's public
 * messages and cannot see targeted ones. That makes it the right instrument for "is this answer
 * public?" - a targeted message is invisible here by construction.
 */
export function publicMessages(
  channelId: string,
  limit = 10,
): Array<{ sender: string; content: string; createdAtMs: number; metadata: Record<string, any> }> {
  const res = aws([
    'chime-sdk-messaging', 'list-channel-messages',
    '--channel-arn', channelArnFor(channelId),
    '--chime-bearer', ssm(`/${INSTANCE}/app-instance-admin-arn`),
    '--max-results', String(limit),
  ]);
  return (res?.ChannelMessages || []).map((m: any) => {
    let metadata: Record<string, any> = {};
    try { metadata = m?.Metadata ? JSON.parse(m.Metadata) : {}; } catch { /* unreadable metadata reads as none */ }
    return {
      sender: m?.Sender?.Arn || '',
      content: decodeURIComponent(m?.Content || ''),
      createdAtMs: m?.CreatedTimestamp ? Date.parse(m.CreatedTimestamp) : 0,
      metadata,
    };
  });
}

/**
 * When a message was created, on Amazon Chime SDK's clock, read as its sender.
 *
 * The instant every "after the reply" comparison is made against. The battle and task rows are stamped
 * by the backend, so comparing them to this test machine's clock would let a skew decide the result.
 */
export function messageCreatedAtMs(channelId: string, senderUserArn: string, messageId: string): number {
  const res = aws([
    'chime-sdk-messaging', 'get-channel-message',
    '--channel-arn', channelArnFor(channelId),
    '--message-id', messageId,
    '--chime-bearer', senderUserArn,
  ]);
  return Date.parse(res?.ChannelMessage?.CreatedTimestamp || '') || 0;
}

/**
 * Wait for a side to MOVE ON from a reply: a state entered after `sinceMs` that is settled.
 *
 * READ FROM THE ROW'S OWN TIMESTAMP, NOT FROM A STATE SAMPLE. A resumed side is `INVOKED` only while
 * its turn runs, and a task-shaped side whose chain still has a step to go parks again in
 * `WAITING_FOR_USER` when the turn ends. Measured on dev 2026-10-28: resumed at 03:34:06.95, parked
 * again at 03:34:09.76, so a 5 s sample never saw it leave. `enteredStateAt` later than the reply is
 * the record that it did.
 *
 * Settled means `COMPLETED`, `FAILED`, or `WAITING_FOR_USER` again (the side asked its next question).
 * Null when nothing moved inside the window.
 */
export async function waitForSideMovedOn(
  battleId: string,
  botArn: string,
  sinceMs: number,
  timeoutMs = 300_000,
): Promise<DuelSide | null> {
  return poll(() => {
    const row = readDuelSides(battleId).find((r) => r.botArn === botArn);
    const enteredMs = row?.enteredStateAt ? Date.parse(row.enteredStateAt) : 0;
    const settled = row?.state === 'COMPLETED' || row?.state === 'FAILED' || row?.state === 'WAITING_FOR_USER';
    return row && settled && enteredMs > sinceMs ? row : null;
  }, timeoutMs);
}
