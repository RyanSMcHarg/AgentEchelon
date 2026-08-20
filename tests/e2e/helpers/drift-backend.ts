/**
 * Backend reads for the drift flow, so its e2e can assert the SOURCE OF TRUTH rather than the DOM.
 *
 * The rendered welcome tells you what one browser drew. It cannot tell you whether the child channel actually
 * records its parent, whether the topic is real or a placeholder, or whether the parent carries a durable
 * link back - and those are the claims the drift redirect actually makes. A DOM-only assertion also passes
 * happily when the copy is right and the linkage is broken, which is the failure that leaves a user stranded
 * in a conversation with no way back.
 *
 * Uses the Chime SDK directly with the app-instance-admin bearer (the moderator-of-everything), because that
 * is the only vantage point that can read BOTH channels without joining them.
 */
import { execFileSync } from 'child_process';

const REGION = process.env.AWS_REGION || 'us-east-1';

function aws(args: string[]): any {
  const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60_000,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  }).trim();
  return out ? JSON.parse(out) : null;
}

let cachedAdmin: string | null = null;
/** The app-instance-admin ARN, which can read any channel without being a member. */
function adminArn(): string {
  if (cachedAdmin) return cachedAdmin;
  cachedAdmin = String(
    aws(['ssm', 'get-parameter', '--name', '/agent-echelon/app-instance-admin-arn', '--query', 'Parameter.Value']),
  ).trim();
  return cachedAdmin;
}

function appInstanceArn(): string {
  // `…/app-instance/<id>/user/agent-echelon-admin` -> `…/app-instance/<id>`
  return adminArn().split('/user/')[0];
}

/**
 * The AppInstanceUser ARN for a signed-in page's Cognito user, derived the same way the client
 * derives its own (`chimeService`: `${APP_INSTANCE_ARN}/user/${sub}`). Needed wherever a count must
 * be taken AS a member: a TARGETED reply is visible only to its sender and target, so the admin
 * bearer's message list omits it by design, and an assertion counting as admin is blind to exactly
 * the reply shape composer-targeting produces.
 */
export function userArnFromIdToken(idToken: string): string {
  const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
  if (!payload.sub) throw new Error('id token has no sub claim');
  return `${appInstanceArn()}/user/${payload.sub}`;
}

let cachedContextTable: string | null = null;
/** The server-only channel-context table, resolved from CFN so it survives a redeploy. */
function channelContextTable(): string {
  if (cachedContextTable) return cachedContextTable;
  const envName = process.env.CHANNEL_CONTEXT_TABLE;
  if (envName) { cachedContextTable = envName; return cachedContextTable; }
  const out = aws([
    'cloudformation', 'describe-stacks', '--stack-name', 'AgentEchelonFoundations',
    '--query', "Stacks[0].Outputs[?contains(OutputKey,'ChannelContext')].OutputValue|[0]",
  ]);
  const name = typeof out === 'string' ? out.trim() : '';
  if (name && name !== 'None') { cachedContextTable = name; return cachedContextTable; }
  // Fall back to a name lookup — the output key has changed shape before.
  const listed = aws(['dynamodb', 'list-tables', '--query', "TableNames[?contains(@,'ChannelContextTable')]|[0]"]);
  cachedContextTable = typeof listed === 'string' ? listed.trim() : '';
  return cachedContextTable;
}

/**
 * A channel's row in the SERVER-ONLY channel-context store.
 *
 * `priorSubject`/`priorMessage`/`parentRef` moved here from channel Metadata in `d474ad9`, because
 * Metadata is member-WRITABLE (a channel's creator is a moderator of their own channel and holds
 * UpdateChannel), so grounding sourced from it is attacker-controlled. `priorMessage` has NO Metadata
 * fallback by design. Asserting it from Metadata therefore reads `''` on a WORKING flow — which is
 * exactly how `drift-detection.spec.ts:267` began failing after the move.
 *
 * Returns `{}` when absent, so callers assert on fields rather than on shape.
 */
export async function channelContext(channelArn: string): Promise<Record<string, unknown>> {
  const table = channelContextTable();
  if (!table) return {};
  const row = aws([
    'dynamodb', 'get-item', '--table-name', table,
    '--key', JSON.stringify({ channelArn: { S: channelArn } }),
    '--consistent-read',
  ]);
  const item = row?.Item;
  if (!item) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item as Record<string, any>)) {
    out[k] = v.S ?? v.N ?? v.BOOL ?? v;
  }
  return out;
}

/** A channel's parsed Metadata. `{}` when absent or unparseable, so a caller asserts on fields not on shape. */
export async function channelMetadata(channelArn: string): Promise<Record<string, unknown>> {
  const ch = aws(['chime-sdk-messaging', 'describe-channel', '--channel-arn', channelArn, '--chime-bearer', adminArn()]);
  try {
    return JSON.parse(ch?.Channel?.Metadata || '{}');
  } catch {
    return {};
  }
}

/**
 * The drift-created channel whose Metadata names `parentArn` as its parent, or null.
 *
 * Found by scanning for the PARENT POINTER rather than by name or by recency. A name match would pass on a
 * leftover channel from an earlier run, and "most recent drift channel" is a race when suites run in
 * parallel. The parent pointer is the thing under test, so it is also the correct way to find the subject.
 */
export async function driftChannelForParent(parentArn: string): Promise<string | null> {
  // ASK THE PARENT FIRST. The parent's own redirect message names the child, so this is one read
  // regardless of how many channels the account holds.
  //
  // The scan below is the fallback, and on a long-lived account it is the one that fails: it walked a
  // FIXED 12 pages of 50, so it stopped seeing new channels once the instance passed 600 of them.
  // Measured at 864 channels (18 pages) on the dev account, where a drift child created seconds
  // earlier sat beyond the cap and was invisible - the confirm-flow e2e polled 20 times, never saw a
  // channel that demonstrably existed, and timed out looking like a broken drift flow. It had passed
  // on the same code an hour earlier, which is what an accumulation failure looks like: it degrades
  // with the size of the account, not with the change under test.
  const viaParent = await driftRedirectMessage(parentArn);
  if (viaParent?.childChannelArn) return viaParent.childChannelArn;

  const app = appInstanceArn();
  let token: string | undefined;
  const candidates: string[] = [];
  // Paginate to exhaustion rather than to a fixed page count — a cap silently returns "not found" for
  // a channel that exists, which is indistinguishable from the failure this helper exists to detect.
  for (let page = 0; page < 100; page++) {
    const args = ['chime-sdk-messaging', 'list-channels', '--chime-bearer', adminArn(),
      '--app-instance-arn', app, '--max-results', '50'];
    if (token) args.push('--next-token', token);
    const r = aws(args);
    for (const c of r?.Channels || []) {
      if (/\/channel\/conv-drift-/.test(c.ChannelArn)) candidates.push(c.ChannelArn);
    }
    token = r?.NextToken;
    if (!token) break;
  }
  // Newest first: a child created seconds ago is far more likely than an old one, so this usually resolves
  // on the first read even though correctness does not depend on the order.
  for (const arn of candidates.reverse()) {
    const meta = await channelMetadata(arn);
    if (meta.parentChannelArn === parentArn) return arn;
  }
  return null;
}

export interface DriftRedirectLink {
  childChannelArn: string;
  label: string;
}

/**
 * The `driftRedirect` link a parent conversation carries, read from MESSAGE METADATA.
 *
 * Deliberately not a content match. The `NAVIGATE_CHANNEL:` marker that drives the one-shot switch is
 * stripped before display, so content is exactly where this link is NOT durable; metadata is the half that
 * survives a re-read.
 */
export async function driftRedirectMessage(parentArn: string): Promise<DriftRedirectLink | null> {
  const r = aws(['chime-sdk-messaging', 'list-channel-messages', '--channel-arn', parentArn, '--chime-bearer', adminArn()]);
  const msgs: any[] = r?.ChannelMessages || [];
  for (const m of msgs) {
    if (!m.Metadata) continue;
    try {
      const meta = JSON.parse(m.Metadata);
      const link = meta?.driftRedirect;
      if (link?.childChannelArn) return { childChannelArn: link.childChannelArn, label: link.label || '' };
    } catch {
      // A message whose Metadata is not JSON is not this one.
    }
  }
  return null;
}

/** How many assistant (bot) messages a channel holds. The count that matters for "opens with one welcome",
 *  read from the channel rather than the DOM so it does not race a conversation swap in the UI. */
export async function botMessageCount(channelArn: string): Promise<number> {
  const r = aws(['chime-sdk-messaging', 'list-channel-messages', '--channel-arn', channelArn, '--chime-bearer', adminArn()]);
  return (r?.ChannelMessages || []).filter((m: any) => String(m?.Sender?.Arn || '').includes('/bot/')).length;
}

/**
 * How many assistant RESPONSES a channel holds - not how many messages.
 *
 * A long reply does not arrive as one message. `handleLongResponse` splits it at the Chime content cap
 * and sends the tail as consecutive continuation messages, each stamped
 * `{ parentMessageId, responseGroup, continuation: true, part, totalParts }`. So a single turn can
 * legitimately add several messages, and counting messages would report a duplicate for a reply that
 * was merely long.
 *
 * Counting non-continuation bot messages counts RESPONSES: the primary message of each reply (the
 * updated placeholder) carries no `continuation` flag, and every chunk after it does. That is the same
 * rule the client renders by - `ConversationInterface` adds a `continuation` class to exactly these -
 * so a DOM assertion of `.assistant-message:not(.continuation)` and this backend count are the same
 * property measured on two sides.
 */
export async function assistantResponseCount(channelArn: string, bearerArn?: string): Promise<number> {
  // Bearer matters, not just permissions: a TARGETED message is returned only to its sender and its
  // target, so the same channel counts differently per member. Default stays the admin - the
  // broadcast view - and a test asserting on a targeted reply must count AS the target.
  const r = aws(['chime-sdk-messaging', 'list-channel-messages', '--channel-arn', channelArn, '--chime-bearer', bearerArn || adminArn()]);
  return (r?.ChannelMessages || [])
    .filter((m: any) => String(m?.Sender?.Arn || '').includes('/bot/'))
    .filter((m: any) => {
      if (!m?.Metadata) return true; // no metadata at all ⇒ not a continuation
      try {
        return JSON.parse(m.Metadata)?.continuation !== true;
      } catch {
        return true; // unparseable metadata is not a continuation marker
      }
    })
    .length;
}

/** The first bot message's text, Lex envelope unwrapped. The assistant's actual output for a channel,
 *  independent of what any browser rendered. */
export async function firstBotMessage(channelArn: string): Promise<string> {
  const r = aws(['chime-sdk-messaging', 'list-channel-messages', '--channel-arn', channelArn, '--chime-bearer', adminArn()]);
  const bots = ((r?.ChannelMessages || []) as any[])
    .filter((m) => String(m?.Sender?.Arn || '').includes('/bot/'))
    .sort((a, b) => new Date(a.CreatedTimestamp).getTime() - new Date(b.CreatedTimestamp).getTime());
  const raw = bots[0]?.Content || '';
  let content = raw;
  try {
    const j = JSON.parse(raw);
    content = j?.Messages?.[0]?.Content || raw;
  } catch {
    content = raw;
  }
  // DECODE. Amazon Chime SDK stores message content percent-encoded, so this returned
  // `This%20conversation%20picks%20up%20…`. Every caller asserts on PROSE, and a regex with a space in
  // it cannot match `%20` - so `/picks up/i` was unsatisfiable while `/stratum/i` (no space) passed,
  // making the encoding invisible until a multi-word assertion was finally reached.
  //
  // A test that can only pass on single-word patterns is a false pass waiting for someone to write a
  // two-word one. Decoded here, once, rather than at each call site.
  try {
    return decodeURIComponent(content);
  } catch {
    return content; // malformed escape sequence — better the raw text than nothing
  }
}

/**
 * True when `messageId` resolves to a message in `channelArn` whose content matches `expectedContent`.
 *
 * A non-empty `originatingMessageId` is not evidence of a working anchor: a fabricated or stale id produces a
 * deep link that looks live and lands nowhere, which is worse than having no anchor at all. Matching on
 * content additionally pins that the RIGHT message was captured, not merely some message in the channel -
 * "the newest message from this sender" is a heuristic, and a heuristic deserves an assertion.
 */
export async function messageMatches(
  channelArn: string,
  messageId: string,
  expectedContent: string,
): Promise<boolean> {
  if (!messageId) return false;
  const r = aws(['chime-sdk-messaging', 'list-channel-messages', '--channel-arn', channelArn, '--chime-bearer', adminArn()]);
  const m = ((r?.ChannelMessages || []) as any[]).find((x) => x.MessageId === messageId);
  if (!m) return false;
  const content = String(m.Content || '');
  // Chime may URI-encode stored content; compare decoded where possible.
  let decoded = content;
  try {
    decoded = decodeURIComponent(content);
  } catch { /* not encoded */ }
  return decoded.trim() === expectedContent.trim() || content.trim() === expectedContent.trim();
}

/**
 * Every non-continuation BOT message's raw content, oldest first - the same population
 * {@link assistantResponseCount} counts, but readable.
 *
 * Exists because a COUNT cannot distinguish "answered twice" from "answered once, plus the empty Lex
 * envelope Amazon Chime SDK materialises from a silent fulfillment" (verified 2026-08-06; the router's
 * `@all` guard returns exactly such an envelope on the Lex entry in a 1:1). A test that reports the
 * first when the truth is the second sends the next session hunting a duplicate that does not exist.
 */
export async function botMessagesForDiagnosis(channelArn: string): Promise<string[]> {
  const r = aws(['chime-sdk-messaging', 'list-channel-messages', '--channel-arn', channelArn, '--chime-bearer', adminArn()]);
  return ((r?.ChannelMessages || []) as any[])
    .filter((m) => String(m?.Sender?.Arn || '').includes('/bot/'))
    .filter((m) => {
      if (!m?.Metadata) return true;
      try { return JSON.parse(m.Metadata)?.continuation !== true; } catch { return true; }
    })
    .sort((a, b) => new Date(a.CreatedTimestamp).getTime() - new Date(b.CreatedTimestamp).getTime())
    .map((m) => String(m?.Content ?? ''));
}

/**
 * Every string the backend shows a user when a turn FAILED, verbatim from `lambda/src`.
 *
 * WHY THIS LIST EXISTS. `handleProcessingError` does not post a new message - it UPDATES the
 * placeholder with an apology. So a failed turn produces exactly one bot message with non-empty
 * content, which every answer-counting assertion in this suite reads as a real answer. A turn that
 * errored end to end satisfies "answered exactly once".
 *
 * Confirmed by reading the code on 2026-08-12, not by hitting it: an audit of that day's run found 0
 * errors in 29 conversations. The suite could not have told us otherwise, which is the point.
 */
const ERROR_REPLY_SHAPES = [
  'Sorry, I encountered an issue processing your request',
  'I encountered an issue. Could you try rephrasing?',
  "I couldn't start on that just now",
  'We are experiencing unusually high demand',
  // A second `/battle` while one is running. No longer worded as "try again" - the person is now told
  // how to end the running duel, or who can - but it still means their `/battle` did not start, which
  // is the only thing this list cares about. Both wordings share this prefix on purpose.
  'A battle is already running in this conversation',
  // `/battle end` from someone who does not own the duel.
  'This battle belongs to the person who started it',
];

/**
 * Throw if a reply is one of the backend's failure notices rather than an answer.
 *
 * Call this anywhere a spec counts answers. Counting alone cannot distinguish "the assistant replied"
 * from "the assistant apologised", and the second is a failing turn wearing the first one's shape.
 *
 * Content is percent-encoded in the channel, so this decodes first: a substring test against the raw
 * form silently never matches, which would make this guard pass for the wrong reason - the exact
 * failure mode `/picks up/i` vs `picks%20up` already cost this suite once.
 */
export function assertNotAnErrorReply(content: string, context = 'assistant reply'): void {
  let text = content ?? '';
  try { text = decodeURIComponent(text); } catch { /* keep the raw form; still tested below */ }
  try {
    const envelope = JSON.parse(text);
    if (Array.isArray(envelope?.Messages)) {
      text = envelope.Messages.map((m: { Content?: string }) => m?.Content ?? '').join(' ');
      try { text = decodeURIComponent(text); } catch { /* already decoded */ }
    }
  } catch { /* not an envelope */ }

  const hit = ERROR_REPLY_SHAPES.find((shape) => text.includes(shape));
  if (hit) {
    throw new Error(
      `${context}: the assistant returned a FAILURE NOTICE, not an answer - "${hit}". `
      + 'The turn errored; a count of replies cannot see that, which is why this check exists. '
      + `Full text: ${JSON.stringify(text.slice(0, 200))}`,
    );
  }
}
