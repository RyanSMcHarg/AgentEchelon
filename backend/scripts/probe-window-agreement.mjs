/**
 * IS THE WINDOW-WIDTH DISAGREEMENT A DEFECT, OR IS IT TODAY STILL MOVING?
 *
 * `analytics-accuracy.spec.ts` asserts that one day carries the same numbers however wide the window
 * around it - a real invariant, because a disagreement means the window is changing the aggregation and
 * each window on its own looks plausible. It failed on 2026-09-29 with differences as large as
 * `assistant_turn_count: narrow=49 wide=5`.
 *
 * That run happened while this session was driving heavy live traffic through the deployment, so the
 * confound is obvious and has to be removed before anything is called a defect: the archival pipeline is
 * asynchronous, and a partial day is still being written. A day that is CLOSED cannot have that excuse.
 *
 * So this asks the same question of a settled day. Same query, same two window widths, no traffic being
 * generated into it.
 *
 *   AWS_PROFILE=<profile> node backend/scripts/probe-window-agreement.mjs [YYYY-MM-DD]
 *
 * Reads only, through the signed path: a console session from the credential exchange.
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import * as fs from 'fs';
import { createRequire } from 'module';

const { signInForConsoleSession } = createRequire(import.meta.url)('./lib/sign-in-exchange.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const env = {};
for (const line of fs.readFileSync(new URL('../../frontend/packages/admin/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
// The analytics query is on AdminApi, below `/query`.
const ADMIN_API = (env.VITE_ADMIN_API_URL || '').replace(/\/$/, '');
const ANALYTICS = ADMIN_API ? `${ADMIN_API}/query` : '';

/** The day under test: a CLOSED day by default (two days back), never today. */
const day = process.argv[2] || new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);

const iso = (d) => d.toISOString();
const at = (dayStr, h) => new Date(`${dayStr}T${String(h).padStart(2, '0')}:00:00.000Z`);

async function main() {
  const sm = new SecretsManagerClient({ region: REGION });
  const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: 'agent-interface/test-credentials' }))).SecretString);
  // The admin's console session, as the console signs the analytics API with it.
  const credentials = await signInForConsoleSession({
    cognito: new CognitoIdentityProviderClient({ region: REGION }),
    InitiateAuthCommand,
    clientId: secret.cognitoClientId,
    exchangeUrl: env.VITE_PERSON_API_URL,
    adminExchangeUrl: env.VITE_ADMIN_API_URL,
    email: secret.testAdmin.email,
    password: secret.testAdmin.password,
  });
  const signer = new SignatureV4({ service: 'execute-api', region: REGION, credentials, sha256: Sha256 });
  const u = new URL(ANALYTICS);

  const metrics = async (start, end) => {
    const payload = JSON.stringify({ queryType: 'latency_metrics', dateRange: { start: iso(start), end: iso(end) } });
    const signed = await signer.sign({
      method: 'POST', protocol: u.protocol, hostname: u.hostname, path: u.pathname,
      headers: { host: u.host, 'content-type': 'application/json' }, body: payload,
    });
    const resp = await fetch(ANALYTICS, { method: 'POST', headers: signed.headers, body: payload });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`${resp.status}: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text);
    return parsed.results || parsed.rows || parsed.data || [];
  };

  // NARROW: the day itself. WIDE: the day with three days of padding either side. The spec's own shape.
  const narrow = await metrics(at(day, 0), at(day, 23));
  const wideStart = new Date(at(day, 0).getTime() - 3 * 86400000);
  const wideEnd = new Date(at(day, 23).getTime() + 3 * 86400000);
  const wide = await metrics(wideStart, wideEnd);

  const key = (r) => `${String(r.date).slice(0, 10)}|${r.assistant}|${r.delivery_option}`;
  const onDay = (rows) => rows.filter((r) => String(r.date).slice(0, 10) === day);
  const byKey = (rows) => new Map(onDay(rows).map((r) => [key(r), r]));

  const n = byKey(narrow);
  const w = byKey(wide);
  const fields = ['assistant_turn_count', 'unpaired_turn_count', 'avg_total_ms'];
  const diffs = [];
  for (const [k, nr] of n) {
    const wr = w.get(k);
    if (!wr) { diffs.push(`${k}: present in NARROW, ABSENT from wide`); continue; }
    for (const f of fields) {
      if (String(nr[f]) !== String(wr[f])) diffs.push(`${k} ${f}: narrow=${nr[f]} wide=${wr[f]}`);
    }
  }
  for (const k of w.keys()) if (!n.has(k)) diffs.push(`${k}: present in WIDE, ABSENT from narrow`);

  console.log(`day under test: ${day}  (closed day, no traffic generated into it by this session)`);
  console.log(`rows on that day: narrow=${n.size}  wide=${w.size}`);
  if (!n.size && !w.size) {
    console.log('\nNO ROWS on that day in either window - this settles nothing. Pick a day with traffic.');
    return;
  }
  if (!diffs.length) {
    console.log('\nAGREE on every field. So the 2026-09-29 disagreement is a PARTIAL-DAY artifact, not a');
    console.log('window bug: that day was still being written while the spec read it twice.');
    return;
  }
  console.log(`\nDISAGREE on ${diffs.length} field(s) for a CLOSED day - this is a real window defect:`);
  for (const d of diffs.slice(0, 20)) console.log('  ' + d);
}

main().catch((e) => { console.error('probe failed:', e?.name, String(e?.message).slice(0, 300)); process.exitCode = 2; });
