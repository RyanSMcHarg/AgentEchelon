/**
 * The assistant profile CLI: draft, validate, activate and roll back an assistant's profile from a
 * terminal, with no console.
 *
 *   npm run assistant -- draft <profile>                       clone the active version into a draft
 *   npm run assistant -- draft <profile> --patch <file.json>   edit the draft's runtime-editable fields
 *   npm run assistant -- draft <profile> --set key=value ...   the same, one field at a time
 *   npm run assistant -- validate <profile>                    validate the draft
 *   npm run assistant -- activate <profile>                    promote the draft to a new active version
 *   npm run assistant -- rollback <profile> --version <n>      move `active` onto an existing version
 *
 * EVERY CALL IS A SIGNED CALL TO THE PROFILE API, never a write to the profile store. The profile routes
 * are IAM-authorized admin routes on `AdminApi`, and the management API is the only
 * sanctioned write path to the profile namespace, so this CLI is that API's client: it SigV4-signs each
 * request with the operator's own IAM credentials (the default AWS credential chain: a profile, SSO,
 * environment keys), and API Gateway refuses a principal that does not hold the route. The CLI holds no
 * grant of its own and no shortcut around the API's validation and audit.
 *
 * The API base is `--api <url>`, else `AE_MANAGE_PROFILES_API_URL`, else the profile routes on this
 * instance's `AdminApi` (its `AdminApiUrl` output, then `/admin/profiles`). A deployment
 * without the `admin` capability has no profile API, and the CLI says so rather than reaching for the
 * store.
 *
 * Everything here is a pure function of what it is handed (credentials, the clock, `fetch`, the stack
 * lookup), so `test/the-assistant-cli-signs-its-calls.test.ts` drives it with stubs and makes no AWS call.
 */

const USAGE = [
  'usage: npm run assistant -- <command> <profile> [options]',
  '',
  'commands:',
  '  draft <profile>                      clone the active version into a fresh draft',
  '  draft <profile> --patch <file.json>  edit the draft (a JSON object of runtime-editable fields)',
  '  draft <profile> --set key=value      edit one field of the draft (repeatable; the value is JSON when it parses)',
  '  validate <profile>                   validate the draft',
  '  activate <profile>                   promote the draft to a new active version',
  '  rollback <profile> --version <n>     move active onto an existing version',
  '',
  'options:',
  '  --api <url>      the profile API (.../admin/profiles); default AE_MANAGE_PROFILES_API_URL or the AdminApi output',
  '  --region <name>  the region the API is signed for; default AWS_REGION or the region in the API URL',
].join('\n');

class UsageError extends Error {}

/** The value of `--set key=value`: JSON when it parses (`true`, `3`, `{"a":1}`), else the string. */
function setValue(raw) {
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * The command line, read. Throws a UsageError naming what is wrong. `readFile` reads a `--patch` file
 * (injected, so the test reads none).
 */
function parseArgs(argv, { readFile } = {}) {
  const [command, profileName, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') throw new UsageError(USAGE);
  if (!['draft', 'validate', 'activate', 'rollback'].includes(command)) throw new UsageError(`unknown command '${command}'\n\n${USAGE}`);
  if (!profileName || profileName.startsWith('--')) throw new UsageError(`${command} needs a profile name\n\n${USAGE}`);
  const out = { command, profileName };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!['--patch', '--set', '--version', '--api', '--region'].includes(flag)) throw new UsageError(`unknown option '${flag}'\n\n${USAGE}`);
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    i += 1;
    if (flag === '--patch') {
      if (!readFile) throw new UsageError('--patch cannot be read here');
      let patch;
      try { patch = JSON.parse(readFile(value)); } catch (e) { throw new UsageError(`--patch ${value} is not a JSON file: ${e.message}`); }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new UsageError(`--patch ${value} must hold a JSON object`);
      out.patch = { ...(out.patch || {}), ...patch };
    } else if (flag === '--set') {
      const eq = value.indexOf('=');
      if (eq < 1) throw new UsageError(`--set takes key=value, not '${value}'`);
      out.patch = { ...(out.patch || {}), [value.slice(0, eq)]: setValue(value.slice(eq + 1)) };
    } else if (flag === '--version') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new UsageError(`--version takes a version number (1 or more), not '${value}'`);
      out.version = n;
    } else if (flag === '--api') {
      out.api = value;
    } else {
      out.region = value;
    }
  }
  if (command === 'rollback' && out.version === undefined) throw new UsageError(`rollback needs --version <n>\n\n${USAGE}`);
  if (command !== 'rollback' && out.version !== undefined) throw new UsageError('--version is for rollback only');
  if (command !== 'draft' && out.patch) throw new UsageError('--patch and --set are for draft only');
  return out;
}

/**
 * The route and body a parsed command sends, relative to the profile API base (`.../admin/profiles`).
 * The base already ends at `admin/profiles`.
 */
function requestFor(apiBase, parsed) {
  const base = String(apiBase).replace(/\/+$/, '');
  const { command, profileName } = parsed;
  if (command === 'draft' && !parsed.patch) return { url: `${base}/version`, body: { profileName } };
  if (command === 'draft') return { url: `${base}/draft`, body: { profileName, patch: parsed.patch } };
  if (command === 'rollback') return { url: `${base}/rollback`, body: { profileName, version: parsed.version } };
  return { url: `${base}/${command}`, body: { profileName } };
}

/** The region an execute-api URL is served from (`<id>.execute-api.<region>.amazonaws.com`), or undefined. */
function regionOfApiUrl(url) {
  const m = /\.execute-api\.([a-z0-9-]+)\.amazonaws\.com/.exec(String(url));
  return m ? m[1] : undefined;
}

/**
 * A SigV4-signed POST of `body` to `url` for API Gateway (`execute-api`), on `credentials`. Returns what
 * `fetch` is handed. `SignatureV4` and `Sha256` are passed in so this file needs no SDK of its own, and
 * `signingDate` lets a test pin the clock.
 */
async function signedPost({ url, body, credentials, region, SignatureV4, Sha256, signingDate }) {
  const u = new URL(url);
  const payload = JSON.stringify(body);
  const signer = new SignatureV4({ service: 'execute-api', region, credentials, sha256: Sha256 });
  const signed = await signer.sign({
    method: 'POST',
    protocol: u.protocol,
    hostname: u.hostname,
    ...(u.port ? { port: Number(u.port) } : {}),
    path: u.pathname,
    query: Object.fromEntries(u.searchParams),
    headers: { host: u.host, 'content-type': 'application/json' },
    body: payload,
  }, signingDate ? { signingDate } : undefined);
  return { url: u.toString(), init: { method: 'POST', headers: signed.headers, body: payload } };
}

/**
 * Run one command. Returns `{ exitCode, output }` and never exits the process. Every dependency is
 * handed in: `credentials` (an object or a provider function), `fetchImpl`, `resolveApi` (the stack
 * output lookup, called only when neither `--api` nor `AE_MANAGE_PROFILES_API_URL` names the API).
 */
async function run({ argv, env = {}, credentials, fetchImpl, resolveApi, readFile, SignatureV4, Sha256, signingDate }) {
  let parsed;
  try {
    parsed = parseArgs(argv, { readFile });
  } catch (e) {
    if (e instanceof UsageError) return { exitCode: 2, output: e.message };
    throw e;
  }
  const api = parsed.api || env.AE_MANAGE_PROFILES_API_URL || (resolveApi ? await resolveApi() : '');
  if (!api) {
    return {
      exitCode: 2,
      output: 'no profile API to call: this instance publishes no AdminApiUrl (the profile routes are part of the '
        + "admin capability's AdminApi stack). Deploy with admin in capabilities, or pass --api <url>.",
    };
  }
  const region = parsed.region || env.AWS_REGION || regionOfApiUrl(api);
  if (!region) return { exitCode: 2, output: 'no region to sign for: pass --region or set AWS_REGION' };
  const creds = typeof credentials === 'function' ? await credentials() : credentials;
  const { url, body } = requestFor(api, parsed);
  const req = await signedPost({ url, body, credentials: creds, region, SignatureV4, Sha256, signingDate });
  const res = await fetchImpl(req.url, req.init);
  const text = await res.text();
  let answer;
  try { answer = text ? JSON.parse(text) : {}; } catch { answer = { raw: text.slice(0, 500) }; }
  const pretty = JSON.stringify(answer, null, 2);
  if (!res.ok) {
    const refusedByGateway = res.status === 403 && /not authorized to perform|explicit deny|no identity-based policy/i.test(text);
    return {
      exitCode: 1,
      output: refusedByGateway
        ? `refused by IAM: your credentials do not hold POST ${new URL(url).pathname} on the profile API (${res.status}).\n${pretty}`
        : `${parsed.command} ${parsed.profileName} failed (${res.status}).\n${pretty}`,
    };
  }
  // A validation answers 200 with `valid: false`, which is a result the operator acts on, not a success.
  if (parsed.command === 'validate' && answer.valid === false) {
    return { exitCode: 1, output: `${parsed.profileName}'s draft is not valid.\n${pretty}` };
  }
  return { exitCode: 0, output: pretty };
}

module.exports = { USAGE, UsageError, parseArgs, requestFor, regionOfApiUrl, signedPost, run };
