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
import { execFileSync } from 'child_process';

const REGION = process.env.AWS_REGION || 'us-east-1';
const INSTANCE = process.env.E2E_INSTANCE_NAME || 'agent-echelon';

function aws(args: string[]): any {
  const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60_000,
    // PYTHONIOENCODING/PYTHONUTF8: the AWS CLI is Python, and on Windows its stdout encoder is the
    // console codepage - a battle row whose content carries a non-ANSI character (a real answer
    // used U+2192 '→') crashes the CLI itself with "'charmap' codec can't encode character",
    // failing the poll that read it. Force UTF-8 so row CONTENT can never break row READS.
    env: { ...process.env, MSYS_NO_PATHCONV: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  }).trim();
  return out ? JSON.parse(out) : null;
}

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
 * Not through the composer, deliberately. A side parked by a task step carries no
 * `<!--battlewaiting-->` marker (the task-step branch writes no `waitingMessageId` and posts nothing),
 * so `battleWaitingBots` is empty and NO member - owner included - is offered the targeted-reply
 * affordance. The message shape is identical to the composer's targeted send (`Target: [{MemberArn}]`,
 * STANDARD, PERSISTENT), so this exercises the server path the UI would exercise if it could.
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

/** A member's app-instance-user ARN from their Cognito sub. */
export function userArnFor(sub: string): string {
  return `${appInstanceArn()}/user/${sub}`;
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
export function publicMessages(channelId: string, limit = 10): Array<{ sender: string; content: string }> {
  const res = aws([
    'chime-sdk-messaging', 'list-channel-messages',
    '--channel-arn', channelArnFor(channelId),
    '--chime-bearer', ssm(`/${INSTANCE}/app-instance-admin-arn`),
    '--max-results', String(limit),
  ]);
  return (res?.ChannelMessages || []).map((m: any) => ({
    sender: m?.Sender?.Arn || '',
    content: decodeURIComponent(m?.Content || ''),
  }));
}

/** Wait for a side to LEAVE the waiting state (the owner's reply resuming it). */
export async function waitForResume(battleId: string, botArn: string, timeoutMs = 240_000): Promise<string> {
  const seen = await poll(() => {
    const st = sideState(battleId, botArn);
    return st && st !== 'WAITING_FOR_USER' ? st : null;
  }, timeoutMs);
  return seen ?? 'WAITING_FOR_USER';
}

/**
 * Wait for a side to reach a TERMINAL state (COMPLETED/FAILED).
 *
 * The distinction from waitForResume matters and is the whole reason this exists: a resumed side
 * used to leave WAITING_FOR_USER (INVOKED) and then strand forever, because the resumed turn ran
 * without battleContext and every terminal write sits behind it. "It resumed" was true while the
 * duel still never finished; only a terminal state proves the resumed turn ran AS a battle turn.
 */
export async function waitForSideTerminal(battleId: string, botArn: string, timeoutMs = 300_000): Promise<string> {
  const seen = await poll(() => {
    const st = sideState(battleId, botArn);
    return st === 'COMPLETED' || st === 'FAILED' ? st : null;
  }, timeoutMs);
  return seen ?? (sideState(battleId, botArn) ?? 'MISSING');
}
