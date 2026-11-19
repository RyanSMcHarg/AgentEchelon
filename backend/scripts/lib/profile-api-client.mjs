/**
 * THE PROFILE API, CALLED AS THE OPERATOR: the one client the ops scripts sign their calls through.
 *
 * Every call goes to the admin capability's `AdminApi` (`/admin/profiles/...`), SigV4-signed for `execute-api` with the
 * operator's own IAM credentials, so a script's write is authorized and audited exactly as the console's is. `call`
 * answers `{ status, body }` and never throws on an HTTP status; `must` turns anything but a 200 into an error naming
 * what was being done.
 */
import { createRequire } from 'node:module';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const require = createRequire(import.meta.url);
const { resolveStackPrefix } = require('./stack-lookup.cjs');

/** The deployment's profile API, read from the AdminApi stack's `AdminApiUrl` output. */
export async function profileApiClient({ env = process.env, region = env.AWS_REGION || 'us-east-1' } = {}) {
  const stack = `${resolveStackPrefix(env)}AdminApi`;
  const out = await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stack }));
  const base = (out.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'AdminApiUrl')?.OutputValue || '').replace(/\/$/, '');
  if (!base) throw new Error(`${stack} has no AdminApiUrl output`);
  const signer = new SignatureV4({ credentials: defaultProvider(), region, service: 'execute-api', sha256: Sha256 });

  /** A GET when `body` is undefined, else a JSON POST. */
  async function call(path, body) {
    const url = new URL(`${base}/admin/profiles${path}`);
    const method = body === undefined ? 'GET' : 'POST';
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const signed = await signer.sign({
      method, protocol: url.protocol, hostname: url.hostname, path: url.pathname, query: {},
      headers: { host: url.hostname, ...(payload ? { 'content-type': 'application/json' } : {}) }, body: payload,
    });
    const res = await fetch(url, { method, headers: signed.headers, body: payload });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed };
  }
  return { call, must };
}

/** The answer's body when it is a 200, else an error naming what was being done. */
export function must(r, what) {
  if (r.status !== 200) throw new Error(`${what} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 600)}`);
  return r.body;
}

/**
 * WHAT A `/validate` ANSWER REFUSES, as lines to print: none only when it says `valid: true` and lists no error. An
 * answer that says neither is read as a refusal, so a shape this client does not know never reaches an activate.
 */
export function validationRefusals(valid) {
  const errors = (Array.isArray(valid?.errors) ? valid.errors : []).map((e) => (typeof e === 'string' ? e : JSON.stringify(e)));
  if (valid?.valid === true && !errors.length) return [];
  return errors.length ? errors : [`the validate answer did not say the draft is valid: ${JSON.stringify(valid).slice(0, 300)}`];
}
