/**
 * WHAT A DEMO RESET TOUCHES, decided from data alone so it can be tested without AWS.
 *
 * A demo creates assistants in the console and conversations as the demo cast. A reset returns the
 * deployment to the state the demo started from: the assistants the console created during the demo are
 * retired, and the demo cast's conversations from the same window are deleted. Everything the deployment
 * declares stays exactly as the deploy made it.
 *
 * Only console-created assistants are selected. A declared assistant comes from `deploy.config.json`, and
 * retiring one is a tombstone its next deploy respects, so a reset never touches it. A duel's alt belongs to
 * its experiment and is removed with it.
 */

/** Statuses an assistant can be retired from. A retired one is already a tombstone. */
const RETIRABLE_STATUS = new Set(['active', 'provisioning', 'failed']);

/**
 * The assistants a reset retires: created in the console at or after `since`, not an experiment's alt, and
 * not already retired. `directory` is the assistant directory as `[name, entry]` pairs.
 */
function assistantsToRetire(directory, since) {
  const from = since.getTime();
  return directory
    .filter(([, e]) => (e.origin ?? 'console') === 'console')
    .filter(([, e]) => e.occupancy !== 'alt')
    .filter(([, e]) => RETIRABLE_STATUS.has(e.status))
    .filter(([, e]) => {
      const at = Date.parse(e.createdAt ?? '');
      return Number.isFinite(at) && at >= from;
    })
    .map(([name, e]) => ({ name, classification: e.classification, status: e.status, createdAt: e.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** A standing team room: one per type and classification, its id fixed (`teamRoomChannelId`, lambda/src/lib/event-triggers.ts). */
function isTeamRoom(channelArn) {
  return /\/channel\/team-[A-Za-z0-9-]+$/.test(String(channelArn || ''));
}

/** At or after `since`, read from an ISO time or a Date; an unreadable time selects nothing. */
function atOrAfter(value, since) {
  const at = value instanceof Date ? value.getTime() : Date.parse(value ?? '');
  return Number.isFinite(at) && at >= since.getTime();
}

/** Who wrote a message, as a reset reads it: a cast member, an assistant (an AppInstanceBot), or anyone else. */
function authorKind(arn, cast) {
  if (cast.has(arn)) return 'cast';
  if (String(arn || '').includes('/bot/')) return 'assistant';
  return 'other';
}

/**
 * WHAT A RESET CLEARS FROM A TEAM ROOM. The room stands across demos, so it is kept and only the demo's footprint
 * goes, read by who wrote it:
 *
 *  - a message a cast member posted in the window goes;
 *  - an assistant's message from the window goes only when every person in the room is in the cast, since in a room a
 *    real person is in an assistant's message (an incident card, a reply) may be theirs;
 *  - a message anyone else posted never goes.
 *
 * The task rows created in the window go only when every person in the room is in the cast, and then a task from the
 * window that is still open holds its workflow run, so the room is not cleared and the reset names it instead.
 *
 * `messages` are `{ MessageId, CreatedTimestamp, author }` (a message listed to several bearers counts once); `tasks`
 * are `{ taskId, createdAt, terminal }`; `cast` is the cast's AppInstanceUser ARNs; `onlyCastInRoom` is whether every
 * person in the room is in the cast. `authors` says, per author, how many of their messages go and how many stay.
 */
function teamRoomClearing(messages, tasks, since, { cast = new Set(), onlyCastInRoom = false } = {}) {
  const inWindow = onlyCastInRoom ? tasks.filter((t) => atOrAfter(t.createdAt, since)) : [];
  const open = [...new Set(inWindow.filter((t) => !t.terminal).map((t) => t.taskId))];
  if (open.length) return { clear: false, open, messageIds: [], taskIds: [], authors: [] };
  const seen = new Map();
  for (const m of messages) if (m.MessageId && atOrAfter(m.CreatedTimestamp, since) && !seen.has(m.MessageId)) seen.set(m.MessageId, m);
  const messageIds = [];
  const authors = new Map();
  for (const m of seen.values()) {
    const kind = authorKind(m.author, cast);
    const goes = kind === 'cast' || (kind === 'assistant' && onlyCastInRoom);
    if (goes) messageIds.push(m.MessageId);
    const a = authors.get(m.author) ?? { author: m.author ?? '', kind, included: 0, kept: 0 };
    a[goes ? 'included' : 'kept'] += 1;
    authors.set(m.author, a);
  }
  return { clear: true, open: [], messageIds, taskIds: [...new Set(inWindow.map((t) => t.taskId))], authors: [...authors.values()] };
}

/** The options a reset runs with. `--since` is required, so a reset always names its window. */
function parseResetArgs(argv) {
  const value = (flag) => argv.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);
  const sinceArg = value('since');
  if (!sinceArg) throw new Error('Name the demo window: --since=<ISO time>, for example --since=2026-10-27T09:00:00Z.');
  const since = new Date(sinceArg);
  if (Number.isNaN(since.getTime())) throw new Error(`--since is not a time: ${sinceArg}`);
  return {
    since,
    apply: argv.includes('--apply'),
    assistants: !argv.includes('--skip-assistants'),
    conversations: !argv.includes('--skip-conversations'),
    teamRooms: !argv.includes('--skip-team-rooms'),
    secret: value('secret') || 'agent-interface/demo-credentials',
    reason: value('reason') || `Demo reset: assistants created since ${since.toISOString()}`,
  };
}

/** The group the seed puts the demo's account teams in (`demo/stratum-company/account-teams.ts`, ACCOUNT_TEAM_GROUP). */
const ACCOUNT_TEAM_GROUP = 'account-management';

/** The domain `seed-demo` puts the demo's addresses on when neither TEST_EMAIL_DOMAIN nor a test inbox names one (`demoEmailDomain`). */
const DEMO_DEFAULT_EMAIL_DOMAIN = 'stratum.example.com';

/**
 * THE SEED'S ACCOUNT TEAMS ARE PART OF THE CAST: the CSMs `seed-demo` creates in {@link ACCOUNT_TEAM_GROUP}, on the domain it
 * puts the demo's addresses on (`demoEmailDomain`): TEST_EMAIL_DOMAIN when set (`emailDomain`), the test inbox's domain the
 * secret records, the domain of the seed's tier users where the secret holds them (the test-credentials secret), and
 * {@link DEMO_DEFAULT_EMAIL_DOMAIN}. The demo-credentials secret holds its cast by role and no tier users, and a cast
 * member's own address may be a real person's, so no domain is taken from one. A member of the group on any other domain
 * is a real person and is never named. Answers the addresses, lowercased.
 */
function seededAccountTeamEmails(secret, groupEmails, { emailDomain } = {}) {
  const seeded = [secret?.premiumUser, secret?.standardUser, secret?.basicUser]
    .map((u) => (u && typeof u === 'object' && typeof u.email === 'string' ? u.email.toLowerCase() : ''))
    .filter((e) => e.includes('@'));
  const declared = [emailDomain, secret?.testInbox?.domain]
    .map((d) => (typeof d === 'string' ? d.trim().toLowerCase() : ''))
    .filter(Boolean);
  const domains = new Set([...seeded.map((e) => e.slice(e.lastIndexOf('@') + 1)), ...declared, DEMO_DEFAULT_EMAIL_DOMAIN]);
  return groupEmails
    .map((e) => String(e || '').toLowerCase())
    .filter((e) => e.includes('@') && domains.has(e.slice(e.lastIndexOf('@') + 1)));
}

module.exports = { assistantsToRetire, parseResetArgs, isTeamRoom, teamRoomClearing, authorKind, seededAccountTeamEmails, ACCOUNT_TEAM_GROUP, DEMO_DEFAULT_EMAIL_DOMAIN, RETIRABLE_STATUS };
