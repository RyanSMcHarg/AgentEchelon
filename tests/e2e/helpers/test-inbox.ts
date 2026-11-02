/**
 * THE TEST INBOX: read the mail the test users actually received.
 *
 * Without it a notification test can only show a send was ATTEMPTED (a log line, an IAM simulation).
 * With it the test reads the delivered message and asserts who got it, what it says and where its link
 * goes. An SES receipt rule writes every message for the inbox domain, raw, to S3; this lists and parses
 * them.
 *
 * WHERE IT COMES FROM is the deployer's choice, and the suite does not care which: an existing domain and
 * bucket they already receive into (`testInboxDomain`, `testInboxBucket`, `testInboxPrefix` in
 * deploy.config.json, or TEST_EMAIL_DOMAIN, TEST_INBOX_BUCKET, TEST_INBOX_PREFIX at provisioning), or the
 * opt-in TestInbox stack (`-c testInboxDomain=...`). Either way
 * `provision-test-users` writes it into the test secret as `testInbox` and puts the test users on its
 * domain. See README "Test inbox".
 *
 * Messages are only ever matched by recipient AND by arrival after the test started, so an inbox shared
 * with other projects or earlier runs is safe to read. Nothing here deletes mail: the bucket's own
 * lifecycle expires it.
 */
import { execFileSync } from 'child_process';
import { getTestCredentials } from './test-credentials';

export interface TestInbox { bucket: string; prefix: string; domain: string }

export interface ReceivedEmail {
  key: string;
  to: string[];
  subject: string;
  /** The From header, encoded words decoded: `"<display name>" <address>`. */
  from: string;
  text: string;
  html: string;
}

const AWS_PROFILE = process.env.AWS_PROFILE || '';
const REGION = process.env.AWS_REGION || 'us-east-1';

/** The configured inbox, or null when this deployment has none. */
export async function getTestInbox(): Promise<TestInbox | null> {
  const inbox = (await getTestCredentials()).testInbox;
  return inbox?.bucket && inbox?.domain ? inbox : null;
}

/**
 * Why a delivery test cannot run here, or '' when it can. Stated as a skip reason, which a validate run
 * (E2E_REQUIRE_ALL) turns into a failure: a deployment with no inbox has not proven delivery.
 */
export function inboxSkipReason(inbox: TestInbox | null, ...addresses: string[]): string {
  if (!inbox) {
    return 'no test inbox is configured, so delivery cannot be read. Either deploy one '
      + '(-c testInboxDomain=<a domain used only for tests>) or declare an existing one in deploy.config.json '
      + '(testInboxDomain, testInboxBucket, testInboxPrefix), then re-run provision-test-users. README "Test inbox"';
  }
  const elsewhere = addresses.filter((a) => !a.toLowerCase().endsWith(`@${inbox.domain}`));
  return elsewhere.length
    ? `${elsewhere.join(', ')} is not on the inbox domain ${inbox.domain}; re-run provision-test-users to move the test users onto it`
    : '';
}

function aws(args: string[]): string {
  return execFileSync('aws', [...args, '--region', REGION], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60_000,
    env: { ...process.env, ...(AWS_PROFILE ? { AWS_PROFILE } : {}), MSYS_NO_PATHCONV: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
}

/** Keys written at or after `sinceMs`. Listed with an argument vector, so the JMESPath arrives intact. */
function keysSince(inbox: TestInbox, sinceMs: number): string[] {
  const iso = new Date(sinceMs).toISOString();
  const out = aws(['s3api', 'list-objects-v2', '--bucket', inbox.bucket, '--prefix', inbox.prefix,
    '--query', `Contents[?LastModified>=\`${iso}\`].Key`, '--output', 'json']).trim();
  const keys = out && out !== 'null' ? JSON.parse(out) : [];
  return Array.isArray(keys) ? keys.map(String) : [];
}

const parsed = new Map<string, ReceivedEmail>();

function read(inbox: TestInbox, key: string): ReceivedEmail {
  const hit = parsed.get(key);
  if (hit) return hit;
  const mail = { key, ...parseEmail(aws(['s3', 'cp', `s3://${inbox.bucket}/${key}`, '-'])) };
  parsed.set(key, mail);
  return mail;
}

export interface EmailQuery {
  /** The recipient, matched against To and Cc. */
  to: string;
  /** Only mail stored at or after this time (epoch ms): the test's own start, not earlier runs. */
  since: number;
  /** A string the subject must contain, to tell this test's mail from anything else to the same person. */
  subjectIncludes?: string;
}

/** Every message matching the query that has arrived so far. */
export function emailsTo(inbox: TestInbox, q: EmailQuery): ReceivedEmail[] {
  const to = q.to.toLowerCase();
  return keysSince(inbox, q.since)
    .map((k) => read(inbox, k))
    .filter((m) => m.to.includes(to) && (!q.subjectIncludes || m.subject.includes(q.subjectIncludes)));
}

/** The first message matching the query, waiting up to `timeoutMs` for it. Throws when none arrives. */
export async function waitForEmail(inbox: TestInbox, q: EmailQuery, timeoutMs = 120_000): Promise<ReceivedEmail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = emailsTo(inbox, q)[0];
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`no email to ${q.to}${q.subjectIncludes ? ` with "${q.subjectIncludes}" in the subject` : ''} `
        + `reached s3://${inbox.bucket}/${inbox.prefix} within ${Math.round(timeoutMs / 1000)}s`);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

// ── MIME ──────────────────────────────────────────────────────────────────────────────────────────
// SES stores the message exactly as it arrived. Enough of RFC 5322 / 2045 / 2047 to read what this
// platform sends: headers, multipart/alternative, base64 and quoted-printable parts, encoded subjects.

function headersOf(block: string): Map<string, string> {
  const h = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0 && !h.has(line.slice(0, i).trim().toLowerCase())) h.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return h;
}

function split(raw: string): { headers: Map<string, string>; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? { headers: headersOf(raw.slice(0, m.index)), body: raw.slice(m.index + m[0].length) } : { headers: headersOf(raw), body: '' };
}

function quotedPrintable(s: string): Buffer {
  const bytes: number[] = [];
  const soft = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < soft.length; i += 1) {
    if (soft[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(soft[i], 'utf8'));
    }
  }
  return Buffer.from(bytes);
}

/** RFC 2047 encoded words, as an encoded Subject arrives. */
function decodeWords(v: string): string {
  return v.replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=\s*/g, (_, enc: string, text: string) => (enc.toUpperCase() === 'B'
    ? Buffer.from(text, 'base64') : quotedPrintable(text.replace(/_/g, ' '))).toString('utf8'));
}

function decodeBody(body: string, encoding: string): string {
  const e = encoding.toLowerCase();
  if (e === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (e === 'quoted-printable') return quotedPrintable(body).toString('utf8');
  return body;
}

function walk(raw: string, into: { text: string; html: string }): void {
  const { headers, body } = split(raw);
  const type = (headers.get('content-type') || 'text/plain').toLowerCase();
  const boundary = /boundary="?([^";]+)"?/i.exec(headers.get('content-type') || '')?.[1];
  if (type.startsWith('multipart/') && boundary) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith('--')) break;
      walk(part.replace(/^\r?\n/, ''), into);
    }
    return;
  }
  const decoded = decodeBody(body, headers.get('content-transfer-encoding') || '');
  if (type.startsWith('text/html')) into.html += decoded;
  else if (type.startsWith('text/plain')) into.text += decoded;
}

/** A raw message as SES stored it: recipients, subject, and its plain and HTML bodies decoded. */
export function parseEmail(raw: string): Omit<ReceivedEmail, 'key'> {
  const { headers } = split(raw);
  const to = [headers.get('to') || '', headers.get('cc') || ''].join(',')
    .match(/[^\s<>,"]+@[^\s<>,"]+/g)?.map((a) => a.toLowerCase()) ?? [];
  const bodies = { text: '', html: '' };
  walk(raw, bodies);
  return { to, subject: decodeWords(headers.get('subject') || ''), from: decodeWords(headers.get('from') || ''), ...bodies };
}
