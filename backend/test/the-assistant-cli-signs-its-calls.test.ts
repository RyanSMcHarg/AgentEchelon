/**
 * THE ASSISTANT PROFILE CLI SIGNS EVERY CALL WITH THE OPERATOR'S IAM CREDENTIALS.
 *
 * `npm run assistant -- draft|validate|activate|rollback` manages an assistant's profile with no console.
 * The profile routes are IAM-authorized admin routes, so the CLI is a SigV4 client of the profile API and
 * never a writer of the profile store. These tests drive it with stub credentials, a pinned clock and a
 * stub `fetch`: no AWS call is made, and what is asserted is the request the CLI would send.
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cli = require('../scripts/lib/assistant-cli.cjs') as {
  run: (opts: Record<string, unknown>) => Promise<{ exitCode: number; output: string }>;
  parseArgs: (argv: string[], deps?: { readFile?: (p: string) => string }) => Record<string, unknown>;
  requestFor: (api: string, parsed: Record<string, unknown>) => { url: string; body: unknown };
};

const API = 'https://test.execute-api.us-east-1.amazonaws.com/prod/admin/profiles';
const CREDS = { accessKeyId: 'AKIDSTUBEXAMPLE', secretAccessKey: 'stub-secret', sessionToken: 'stub-session-token' };
const AT = new Date('2026-10-18T12:00:00Z');

type Sent = { url: string; init: { method: string; headers: Record<string, string>; body: string } };

/** Run the CLI against a stub API that answers `status` with `answer`, and return what it sent. */
async function drive(argv: string[], { status = 200, answer = {}, env = {}, resolveApi }: {
  status?: number; answer?: unknown; env?: Record<string, string>; resolveApi?: () => Promise<string>;
} = {}) {
  const sent: Sent[] = [];
  const fetchImpl = async (url: string, init: Sent['init']) => {
    sent.push({ url, init });
    const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
    return { ok: status < 400, status, text: async () => text };
  };
  const result = await cli.run({
    argv, env, credentials: async () => CREDS, fetchImpl, resolveApi,
    readFile: () => '{"displayName":"Ops"}', SignatureV4, Sha256, signingDate: AT,
  });
  return { ...result, sent };
}

describe('the assistant CLI signs every call', () => {
  it('sends a SigV4 POST for execute-api in the API region, with the session token and the body hashed in', async () => {
    const { exitCode, sent } = await drive(['activate', 'standard', '--api', API]);
    expect(exitCode).toBe(0);
    expect(sent).toHaveLength(1);
    const [{ url, init }] = sent;
    expect(url).toBe(`${API}/activate`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ profileName: 'standard' });
    expect(init.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDSTUBEXAMPLE\/20261018\/us-east-1\/execute-api\/aws4_request, SignedHeaders=[^,]*host[^,]*, Signature=[0-9a-f]{64}$/,
    );
    expect(init.headers['x-amz-date']).toBe('20261018T120000Z');
    expect(init.headers['x-amz-security-token']).toBe('stub-session-token');
    // The operator's own credentials sign it: no bearer token, no API key.
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toEqual(expect.arrayContaining(['x-api-key']));
    expect(init.headers.authorization).not.toMatch(/^Bearer/);
  });

  it('signs the body: the same request signs the same, and a different body signs differently', async () => {
    const a = (await drive(['validate', 'standard', '--api', API])).sent[0].init.headers.authorization;
    const b = (await drive(['validate', 'standard', '--api', API])).sent[0].init.headers.authorization;
    const c = (await drive(['validate', 'premium', '--api', API])).sent[0].init.headers.authorization;
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('routes each command to its profile route', () => {
    const parse = (argv: string[]) => cli.requestFor(API, cli.parseArgs(argv, { readFile: () => '{"displayName":"Ops"}' }));
    expect(parse(['draft', 'standard'])).toEqual({ url: `${API}/version`, body: { profileName: 'standard' } });
    expect(parse(['draft', 'standard', '--patch', 'p.json', '--set', 'temperature=0.2']))
      .toEqual({ url: `${API}/draft`, body: { profileName: 'standard', patch: { displayName: 'Ops', temperature: 0.2 } } });
    expect(parse(['validate', 'standard'])).toEqual({ url: `${API}/validate`, body: { profileName: 'standard' } });
    expect(parse(['activate', 'standard'])).toEqual({ url: `${API}/activate`, body: { profileName: 'standard' } });
    expect(parse(['rollback', 'standard', '--version', '3'])).toEqual({ url: `${API}/rollback`, body: { profileName: 'standard', version: 3 } });
  });

  it('reads the API from the environment, then the stack output, and only asks the stack when nothing names it', async () => {
    let asked = 0;
    const resolveApi = async () => { asked += 1; return API; };
    await drive(['validate', 'standard'], { env: { AE_MANAGE_PROFILES_API_URL: API }, resolveApi });
    expect(asked).toBe(0);
    const viaStack = await drive(['validate', 'standard'], { resolveApi });
    expect(asked).toBe(1);
    expect(viaStack.sent[0].url).toBe(`${API}/validate`);
  });

  it('says there is no profile API on a deployment without admin, and sends nothing', async () => {
    const r = await drive(['validate', 'standard'], { resolveApi: async () => '' });
    expect(r.exitCode).toBe(2);
    expect(r.output).toMatch(/no profile API/);
    expect(r.sent).toEqual([]);
  });

  it('refuses a malformed command line before signing anything', async () => {
    for (const argv of [[], ['publish', 'standard'], ['activate'], ['rollback', 'standard'], ['rollback', 'standard', '--version', '0'], ['validate', 'standard', '--set', 'a=1']]) {
      const r = await drive([...argv, '--api', API]);
      expect([argv.join(' '), r.exitCode, r.sent.length]).toEqual([argv.join(' '), 2, 0]);
    }
  });

  it('names an IAM refusal as one, and fails a draft that does not validate', async () => {
    const refused = await drive(['activate', 'standard', '--api', API], {
      status: 403, answer: { Message: 'User: arn:aws:sts::111122223333:assumed-role/x/y is not authorized to perform: execute-api:Invoke' },
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.output).toMatch(/refused by IAM/);
    const invalid = await drive(['validate', 'standard', '--api', API], { answer: { valid: false, errors: ['model not in catalog'] } });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.output).toMatch(/not valid/);
  });
});
