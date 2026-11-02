#!/usr/bin/env node
/**
 * Release the memberships an e2e run created, so test accounts and assistants stay under the Amazon
 * Chime SDK SearchChannels membership limit.
 *
 * WHY. Every e2e conversation adds a membership for the test person and the classification's
 * assistant, and nothing removed them: the premium assistant went from 388 to 1020 memberships in under
 * a week, crossed the limit (measured between 918 and 1020), and drift scoping failed for every
 * conversation whose people were also over it. SearchChannels checks only its bearer, so an assistant
 * or a person past the limit cannot bear a search at all.
 *
 * WHAT IT TOUCHES, and why it can say so precisely:
 *  - only conversations CREATED since `--since` - a conversation id is `conv-<epoch ms>-<suffix>`, so its
 *    creation time is in its name, not inferred;
 *  - only conversations whose every HUMAN member is an e2e test account (the `agent-interface/test-
 *    credentials` secret the e2e reads) - a conversation a real person is in is left alone entirely;
 *  - it removes MEMBERSHIPS (the assistant's and the test accounts'), never the conversation: the archive,
 *    the admin console's reads (an app-instance admin reads without membership) and analytics are kept.
 *
 * Every removal is written to the log BEFORE it is made, so `--restore <log>` puts them back.
 *
 *   node scripts/release-e2e-memberships.mjs --since=<ISO|epoch ms>            # dry run
 *   node scripts/release-e2e-memberships.mjs --since=<ISO|epoch ms> --apply
 *   node scripts/release-e2e-memberships.mjs --restore=<log file>
 *
 * Env: AWS_PROFILE, INSTANCE_NAME (or another instance variable scripts/lib/stack-lookup.cjs reads), TEST_SECRET_NAME.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { resolveInstanceName } = createRequire(import.meta.url)('./lib/stack-lookup.cjs');
const { appInstanceArnOf } = createRequire(import.meta.url)('./lib/person-arn.cjs');

const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const has = (name) => process.argv.includes(`--${name}`);
const aws = (args) => {
  const out = execFileSync('aws', [...args, '--output', 'json'], { env, encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INSTANCE = resolveInstanceName(process.env);
const ADMIN = aws(['ssm', 'get-parameter', '--name', `/${INSTANCE}/app-instance-admin-arn`]).Parameter.Value;
const APP_INSTANCE = appInstanceArnOf(ADMIN);
const here = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(here, '../../private');

if (arg('restore')) {
  const seen = new Set();
  const rows = readFileSync(arg('restore'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((r) => { const k = `${r.member}|${r.channel}`; if (seen.has(k)) return false; seen.add(k); return true; });
  for (const r of rows) {
    execFileSync('aws', ['chime-sdk-messaging', 'create-channel-membership', '--channel-arn', r.channel,
      '--member-arn', r.member, '--type', 'DEFAULT', '--chime-bearer', ADMIN], { env });
    await sleep(150);
  }
  console.log(`restored ${rows.length} membership(s)`);
  process.exit(0);
}

const sinceRaw = arg('since') || process.env.VALIDATE_STARTED_AT;
if (!sinceRaw) throw new Error('--since=<ISO or epoch ms> is required (or VALIDATE_STARTED_AT)');
const since = /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : Date.parse(sinceRaw);
if (!Number.isFinite(since)) throw new Error(`--since is not a time: ${sinceRaw}`);
const apply = has('apply');

// The e2e test accounts, from the same secret the e2e reads. Each entry carries the AppInstanceUser the
// credential exchange minted at its first sign-in (`userArn`, written by provision-test-users.mjs). A person's
// AppInstanceUser id is minted, not their Cognito sub, so it is read rather than derived.
const secret = JSON.parse(aws(['secretsmanager', 'get-secret-value', '--secret-id',
  process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials']).SecretString);
const testArns = new Set();
for (const [key, u] of Object.entries(secret)) {
  const arn = typeof u?.userArn === 'string' ? u.userArn : '';
  if (!u?.email) continue;
  if (!arn || appInstanceArnOf(arn) !== APP_INSTANCE) { console.log(`  skipped test user ${key}: no AppInstanceUser of this app instance in the secret`); continue; }
  testArns.add(arn);
}
if (!testArns.size) throw new Error('no e2e test account resolved; refusing to guess');

// Candidate conversations: those the test accounts belong to, created since `since`.
const candidates = new Set();
for (const arn of testArns) {
  let tok;
  do {
    const r = aws(['chime-sdk-messaging', 'list-channel-memberships-for-app-instance-user',
      '--app-instance-user-arn', arn, '--chime-bearer', arn, '--max-results', '50', ...(tok ? ['--next-token', tok] : [])]);
    for (const m of r.ChannelMemberships || []) {
      const ch = m.ChannelSummary?.ChannelArn || '';
      const created = Number(/\/channel\/conv-(\d{13})-/.exec(ch)?.[1]);
      if (created && created >= since) candidates.add(ch);
    }
    tok = r.NextToken;
  } while (tok);
}

const logFile = path.join(LOG_DIR, `release-e2e-memberships-${new Date().toISOString().replace(/[:.]/g, '-')}.log.jsonl`);
if (apply) mkdirSync(LOG_DIR, { recursive: true });
let kept = 0;
let removed = 0;
for (const ch of candidates) {
  const members = (aws(['chime-sdk-messaging', 'list-channel-memberships', '--channel-arn', ch,
    '--chime-bearer', ADMIN, '--max-results', '50']).ChannelMemberships || []).map((m) => m.Member?.Arn || '');
  const humans = members.filter((a) => a.includes('/user/'));
  if (humans.some((a) => !testArns.has(a))) { kept += 1; continue; } // a real person is in it
  for (const member of members.filter((a) => a.includes('/bot/') || testArns.has(a))) {
    if (!apply) { removed += 1; continue; }
    appendFileSync(logFile, JSON.stringify({ member, channel: ch }) + '\n');
    execFileSync('aws', ['chime-sdk-messaging', 'delete-channel-membership', '--channel-arn', ch,
      '--member-arn', member, '--chime-bearer', ADMIN], { env });
    removed += 1;
    await sleep(150);
  }
}
console.log(`${candidates.size} conversation(s) created since ${new Date(since).toISOString()} by e2e test accounts; `
  + `${kept} left alone (a real person is a member); ${removed} membership(s) ${apply ? 'removed' : 'would be removed'}`
  + (apply ? `; restore with --restore=${logFile}` : ' (dry run; pass --apply)'));
