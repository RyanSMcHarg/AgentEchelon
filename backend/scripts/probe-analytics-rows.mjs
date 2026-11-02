/**
 * Read-only live probes for analytics questions that only a deployed stack can settle.
 *
 * THROUGH THE SIGNED PATH, never a direct Lambda invoke with hand-crafted claims: the point of a live
 * check is that the request travelled the way a real one does, authorizer included.
 *
 * The analytics plane is IAM-authorized (A14), not bearer-authorized. A JWT in `Authorization` comes
 * back 403 from API Gateway's SigV4 parser, which reads like an auth failure and is not one. So this
 * reuses the console's own two steps (`frontend/packages/admin/src/services/sigv4Fetch.ts`): exchange
 * the Cognito ID token at the credential exchange for a console session, on the console role the
 * caller's groups name, then SigV4-sign the POST. A role whose policy omits a resource is denied at the
 * gateway, so reaching the data is itself evidence the console role grants it.
 *
 *   AWS_PROFILE=<profile> node backend/scripts/probe-analytics-rows.mjs
 *
 * Reads only. It runs no conversation and calls no model, so it costs nothing beyond the queries.
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import * as fs from 'fs';
import { createRequire } from 'module';

const { signInForConsoleSession } = createRequire(import.meta.url)('./lib/sign-in-exchange.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';

/** The deployed values live in the admin package's generated .env, which is the console's own source. */
const ENV_FILE = new URL('../../frontend/packages/admin/.env', import.meta.url);
const env = {};
for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
// The person exchange is on PersonApi; the console session and the analytics query (below `/query`) on AdminApi.
const EXCHANGE = (env.VITE_PERSON_API_URL || '').replace(/\/$/, '');
const ADMIN_EXCHANGE = (env.VITE_ADMIN_API_URL || '').replace(/\/$/, '');
const ANALYTICS = ADMIN_EXCHANGE ? `${ADMIN_EXCHANGE}/query` : '';
if (!EXCHANGE || !ADMIN_EXCHANGE) {
  console.error('admin/.env must carry VITE_PERSON_API_URL and VITE_ADMIN_API_URL');
  process.exit(2);
}

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const RANGE = { start: day(-14), end: day(0) };

async function main() {
  const sm = new SecretsManagerClient({ region: REGION });
  const secret = JSON.parse(
    (await sm.send(new GetSecretValueCommand({ SecretId: 'agent-interface/test-credentials' }))).SecretString,
  );

  // The admin's console session, as the console signs the analytics API with it.
  const credentials = await signInForConsoleSession({
    cognito: new CognitoIdentityProviderClient({ region: REGION }),
    InitiateAuthCommand,
    clientId: secret.cognitoClientId,
    exchangeUrl: EXCHANGE,
    adminExchangeUrl: ADMIN_EXCHANGE,
    email: secret.testAdmin.email,
    password: secret.testAdmin.password,
  });

  const signer = new SignatureV4({ service: 'execute-api', region: REGION, credentials, sha256: Sha256 });
  const u = new URL(ANALYTICS);

  const q = async (queryType, extra) => {
    const payload = JSON.stringify({ queryType, dateRange: RANGE, ...(extra || {}) });
    const signed = await signer.sign({
      method: 'POST',
      protocol: u.protocol,
      hostname: u.hostname,
      path: u.pathname,
      headers: { host: u.host, 'content-type': 'application/json' },
      body: payload,
    });
    const resp = await fetch(ANALYTICS, { method: 'POST', headers: signed.headers, body: payload });
    const text = await resp.text();
    if (!resp.ok) return { error: `${resp.status}: ${text.slice(0, 240)}` };
    try { return JSON.parse(text); } catch { return { error: `unparseable: ${text.slice(0, 200)}` }; }
  };
  const rowsOf = (r) => r.results || r.rows || r.data || (Array.isArray(r) ? r : []);
  /**
   * Never print an AWS account id: probe output gets pasted into notes, and no tracked file in this
   * repo may carry one. Redact by the ACCOUNT SHAPE (a 12-digit ARN field), not by ARN prefix - the
   * first version matched only Chime channel ARNs and a Bedrock inference-profile ARN walked straight
   * through it.
   */
  const redact = (s) => String(s).replace(/(arn:aws[a-z-]*:[^:]*:[^:]*:)\d{12}:/g, '$1<account>:');
  const safe = (o) => redact(JSON.stringify(o));
  /**
   * Assert the column exists before judging its contents. The first version of this probe filtered on
   * `agent_type`, which `intent_effectiveness` does not return, so every row looked unattributed and
   * the probe "confirmed" a defect it had not measured.
   */
  const column = (rows, name) => {
    if (!rows.length) return { present: false, why: 'no rows' };
    if (!(name in rows[0])) return { present: false, why: `no such column (has: ${Object.keys(rows[0]).length} others)` };
    return { present: true };
  };

  console.log(`signed as ${secret.testAdmin.email} (console session from the credential exchange)`);
  console.log(`window ${RANGE.start} .. ${RANGE.end}\n`);

  // ── 419: turns archived with no assistant attributed ────────────────────────────────────────────
  const eff = await q('intent_effectiveness');
  if (eff.error) console.log(`419  intent_effectiveness -> ${eff.error}`);
  else {
    const rows = rowsOf(eff);
    const col = column(rows, 'assistant');
    if (!col.present) {
      console.log(`419  ${rows.length} row(s), but NO \`assistant\` column: ${col.why} - the row's premise cannot be tested here`);
    } else {
      const blank = rows.filter((x) => x.assistant === null || x.assistant === undefined || String(x.assistant).trim() === '');
      console.log(`419  ${rows.length} intent row(s); \`assistant\` present; ${blank.length} blank`);
      for (const x of blank) {
        console.log(`       BLANK intent=${x.intent} exchanges=${x.exchange_count} direct=${x.direct_count} tasks=${x.task_count} defs=${x.assistant_definition_count} answering_assistant=${JSON.stringify(x.answering_assistant)} model=${redact(x.dominant_model)}`);
      }
    }
  }

  // ── 445: is a 0% completion a real zero, or a phase that never ran? ──────────────────────────────
  const flows = await q('evaluation_flows');
  if (flows.error) console.log(`445  evaluation_flows -> ${flows.error}`);
  else {
    const rows = rowsOf(flows);
    console.log(`445  evaluation_flows -> ${rows.length} row(s)`);
    if (!rows.length) {
      console.log('       EMPTY - which is exactly the ambiguity the row names: no flow scored, or the pass never ran');
    } else {
      // The row's question is whether a 0% completion is a real zero or an unrun phase. That is
      // answerable only by looking at whether the completion field is POPULATED, not at its value.
      const statuses = {};
      for (const r of rows) statuses[String(r.status ?? r.flow_status ?? r.state ?? 'no-status-field')] = (statuses[String(r.status ?? r.flow_status ?? r.state ?? 'no-status-field')] || 0) + 1;
      console.log(`       status spread: ${JSON.stringify(statuses)}`);
      console.log(`       keys: ${Object.keys(rows[0]).join(', ')}`);
      console.log(`       sample: ${safe(rows[0]).slice(0, 240)}`);
    }
  }

  // ── adjacent: does the turn ledger carry latency at all in this window? ──────────────────────────
  const lat = await q('latency_metrics');
  if (lat.error) console.log(`     latency_metrics -> ${lat.error}`);
  else {
    const rows = rowsOf(lat);
    console.log(`     latency_metrics -> ${rows.length} row(s)${rows.length ? `; keys: ${Object.keys(rows[0]).slice(0, 12).join(', ')}` : ''}`);
  }
}

main().catch((e) => {
  console.error('probe failed:', e?.name, String(e?.message).slice(0, 300));
  process.exitCode = 2;
});
