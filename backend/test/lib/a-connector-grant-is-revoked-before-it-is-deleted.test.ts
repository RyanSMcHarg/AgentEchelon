/**
 * A PERSON'S CONNECTOR GRANT IS REVOKED AT THE VENDOR BEFORE IT IS DELETED, BY THE PERSON OR AT
 * OFFBOARDING, AND A FAILED REVOCATION IS RETRIED AND RECORDED (K3).
 *
 * With the table, the key and the vendor faked (no vendor account exists, so a live
 * revocation is NOT VERIFIED here):
 *
 *  - a link stores the tokens sealed under the person and connector as encryption context, keyed by person id;
 *  - a revocation calls the vendor first and deletes only once the vendor confirms (or says the token is
 *    already invalid); one that keeps failing is retried with backoff and left `revoke-failed`;
 *  - the sweep retries a `revoke-failed` grant, and after `MAX_SWEEP_ATTEMPTS` deletes it and raises an alert;
 *  - the person's own routes act on the caller's grant and nobody else's;
 *  - offboarding revokes a person's grants and records both counts in its `offboarding` event.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  linkGrant, readGrant, retryFailedRevocations, revokeGrant, revokePersonGrants,
  MAX_SWEEP_ATTEMPTS, REVOKE_ATTEMPTS, type GrantDeps, type GrantItem,
} from '../../lambda/src/lib/connector-grants';
import { handleRevoker } from '../../lambda/src/connector-grant-revoker';
import { handleGrantRoute } from '../../lambda/src/connector-grant-routes';
import { connectorGrantsRevoker, OFFBOARDED_STORES } from '../../lambda/src/lib/offboarding';
import type { RuntimeConnector } from '../../lib/config/connectors';
import { edgeContext } from '../helpers/edge-context';

const JANE = '0192a000-0000-7000-8000-00000000000a';
const OMAR = '0192a000-0000-7000-8000-00000000000b';

const SF: RuntimeConnector = {
  id: 'crm', vendor: 'salesforce', capabilities: ['actForPerson'], subscribes: [], namespace: 'crm',
  grants: { redirectUris: ['https://app.example.com/connectors/callback'], scopes: [], tokenUrl: 'https://login.example.com/services/oauth2/token', revokeUrl: 'https://login.example.com/services/oauth2/revoke', revokeAuth: 'token-only' },
};
const PD: RuntimeConnector = {
  id: 'oncall', vendor: 'pagerduty', capabilities: ['actForPerson'], subscribes: [], namespace: 'oncall',
  grants: { redirectUris: ['https://app.example.com/connectors/callback'], scopes: [], tokenUrl: 'https://identity.example.com/oauth/token', revokeUrl: 'https://identity.example.com/oauth/revoke', revokeAuth: 'client-credentials' },
};

type Answer = { status: number; json?: unknown } | 'throw';

function world(vendor: (url: string, body: URLSearchParams) => Answer = () => ({ status: 200, json: {} })) {
  const items = new Map<string, GrantItem>();
  const key = (k: { personId: string; connectorId: string }) => `${k.personId}|${k.connectorId}`;
  const calls: Array<{ url: string; body: Record<string, string> }> = [];
  const doc = {
    send: jest.fn(async (cmd: { constructor: { name: string }; input: any }) => {
      const i = cmd.input;
      switch (cmd.constructor.name) {
        case 'PutCommand': items.set(key(i.Item), { ...i.Item }); return {};
        case 'GetCommand': return { Item: items.get(key(i.Key)) };
        case 'DeleteCommand': items.delete(key(i.Key)); return {};
        case 'UpdateCommand': {
          const it = items.get(key(i.Key));
          if (!it) throw Object.assign(new Error('gone'), { name: 'ConditionalCheckFailedException' });
          it.status = 'revoke-failed';
          it.revokeAttempts = (it.revokeAttempts ?? 0) + 1;
          return {};
        }
        case 'QueryCommand': return { Items: [...items.values()].filter((x) => x.personId === i.ExpressionAttributeValues[':p']) };
        case 'ScanCommand': return { Items: [...items.values()].filter((x) => x.status === 'revoke-failed') };
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    }),
  };
  const kms = {
    send: jest.fn(async (cmd: { constructor: { name: string }; input: any }) => {
      const ctx = JSON.stringify(cmd.input.EncryptionContext);
      if (cmd.constructor.name === 'EncryptCommand') {
        return { CiphertextBlob: Buffer.from(JSON.stringify({ ctx, plain: Buffer.from(cmd.input.Plaintext).toString('utf8') })) };
      }
      const sealed = JSON.parse(Buffer.from(cmd.input.CiphertextBlob).toString('utf8'));
      if (sealed.ctx !== ctx) throw Object.assign(new Error('context'), { name: 'InvalidCiphertextException' });
      return { Plaintext: Buffer.from(sealed.plain) };
    }),
  };
  const fetch = jest.fn(async (url: string, init: { body: URLSearchParams }) => {
    calls.push({ url, body: Object.fromEntries(init.body.entries()) });
    const a = vendor(url, init.body);
    if (a === 'throw') throw new Error('network');
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json ?? {} };
  });
  const deps: GrantDeps = {
    doc, kms, table: 'Grants', keyArn: 'arn:aws:kms:us-east-1:111122223333:key/k',
    connectors: [SF, PD],
    oauthClient: async () => ({ clientId: 'cid', clientSecret: 'csecret' }),
    fetch: fetch as unknown as GrantDeps['fetch'],
    sleep: async () => {},
    now: () => new Date('2026-10-19T12:00:00Z'),
  };
  return { deps, items, calls, kms };
}

const tokenAnswer = (url: string): Answer => (url.endsWith('/token') ? { status: 200, json: { access_token: 'at-1', refresh_token: 'rt-1' } } : { status: 200, json: {} });

describe('linking', () => {
  it('stores the tokens sealed under the person and the connector, keyed by person id', async () => {
    const { deps, items, calls } = world(tokenAnswer);
    await linkGrant(JANE, 'crm', { code: 'c', redirectUri: SF.grants!.redirectUris[0], codeVerifier: 'v' }, deps);
    const item = items.get(`${JANE}|crm`)!;
    expect(item.status).toBe('active');
    expect(item.ciphertext).not.toContain('at-1'.split('').reverse().join('')); // sanity: stored as a blob
    expect(JSON.stringify(item)).not.toMatch(/"accessToken"|"refreshToken"/);
    expect(calls[0]).toEqual({ url: SF.grants!.tokenUrl, body: expect.objectContaining({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v', client_id: 'cid' }) });
    // The ciphertext opens only under its own person and connector.
    const moved = { ...item, personId: OMAR };
    await expect(deps.kms.send({ constructor: { name: 'DecryptCommand' }, input: { CiphertextBlob: Buffer.from(moved.ciphertext, 'base64'), EncryptionContext: { personId: OMAR, connectorId: 'crm', purpose: 'connector-grant' } } } as never)).rejects.toThrow('context');
  });

  it('refuses a redirect URI the connector does not declare, and a connector that takes no grant, before asking the vendor', async () => {
    const { deps, calls } = world(tokenAnswer);
    await expect(linkGrant(JANE, 'crm', { code: 'c', redirectUri: 'https://evil.example.com/cb', codeVerifier: 'v' }, deps)).rejects.toThrow(/redirect-not-declared/);
    await expect(linkGrant(JANE, 'nope', { code: 'c', redirectUri: SF.grants!.redirectUris[0], codeVerifier: 'v' }, deps)).rejects.toThrow(/unknown-connector/);
    expect(calls).toEqual([]);
  });

  it('revokes the grant a new link replaces, so a person never holds two for one connector', async () => {
    const { deps, items, calls } = world(tokenAnswer);
    await linkGrant(JANE, 'crm', { code: 'c1', redirectUri: SF.grants!.redirectUris[0], codeVerifier: 'v' }, deps);
    await linkGrant(JANE, 'crm', { code: 'c2', redirectUri: SF.grants!.redirectUris[0], codeVerifier: 'v' }, deps);
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['token', 'token', 'revoke']);
    expect(calls[2].body).toEqual({ token: 'rt-1' });
    expect(items.size).toBe(1);
  });
});

describe('revoking', () => {
  async function linked(vendor: (url: string, body: URLSearchParams) => Answer, connector = 'crm') {
    const w = world((url, body) => (url.endsWith('/token') ? tokenAnswer(url) : vendor(url, body)));
    await linkGrant(JANE, connector, { code: 'c', redirectUri: SF.grants!.redirectUris[0], codeVerifier: 'v' }, w.deps);
    w.calls.length = 0;
    return w;
  }

  it('calls the vendor first, then deletes', async () => {
    const { deps, items, calls } = await linked(() => ({ status: 200 }));
    expect(await revokeGrant((await readGrant(JANE, 'crm', deps))!, deps)).toBe('revoked');
    expect(calls).toEqual([{ url: SF.grants!.revokeUrl, body: { token: 'rt-1' } }]);
    expect(items.size).toBe(0);
  });

  it('sends the client credentials where the vendor revokes with them (PagerDuty)', async () => {
    const { deps, calls } = await linked(() => ({ status: 200 }), 'oncall');
    await revokeGrant((await readGrant(JANE, 'oncall', deps))!, deps);
    expect(calls).toEqual([{ url: PD.grants!.revokeUrl, body: { token: 'rt-1', client_id: 'cid', client_secret: 'csecret' } }]);
  });

  it('treats a token the vendor says is already invalid as revoked', async () => {
    const { deps, items } = await linked(() => ({ status: 400, json: { error: 'invalid_token' } }));
    expect(await revokeGrant((await readGrant(JANE, 'crm', deps))!, deps)).toBe('revoked');
    expect(items.size).toBe(0);
  });

  it('retries a failing vendor, then keeps the grant revoke-failed rather than deleting it', async () => {
    const { deps, items, calls } = await linked(() => ({ status: 503 }));
    expect(await revokeGrant((await readGrant(JANE, 'crm', deps))!, deps)).toBe('failed');
    expect(calls).toHaveLength(REVOKE_ATTEMPTS);
    expect(items.get(`${JANE}|crm`)).toEqual(expect.objectContaining({ status: 'revoke-failed', revokeAttempts: 1 }));
  });

  it('the sweep retries a revoke-failed grant, and abandons it to an alert after the last attempt', async () => {
    let up = false;
    const { deps, items } = await linked(() => (up ? { status: 200 } : 'throw'));
    await revokeGrant((await readGrant(JANE, 'crm', deps))!, deps);
    expect((await retryFailedRevocations(deps))).toEqual({ revoked: 0, failed: 1, abandoned: [] });
    up = true;
    expect((await retryFailedRevocations(deps))).toEqual({ revoked: 1, failed: 0, abandoned: [] });
    expect(items.size).toBe(0);

    up = false;
    await linkGrant(JANE, 'crm', { code: 'c', redirectUri: SF.grants!.redirectUris[0], codeVerifier: 'v' }, { ...deps, fetch: (async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'a' }) })) as never });
    items.get(`${JANE}|crm`)!.status = 'revoke-failed';
    items.get(`${JANE}|crm`)!.revokeAttempts = MAX_SWEEP_ATTEMPTS;
    const alerts: string[] = [];
    const out = await handleRevoker({ 'detail-type': 'Scheduled Event' }, deps, async (p, c) => { alerts.push(`${c}:${p}`); });
    expect(out).toEqual({ revoked: 0, failed: 0, abandoned: [{ personId: JANE, connectorId: 'crm' }] });
    expect(alerts).toEqual([`crm:${JANE}`]);
    expect(items.size).toBe(0);
  });

  it('offboarding revokes every grant a person holds and counts what is left for the retry', async () => {
    const w = world((url) => (url.endsWith('/token') ? tokenAnswer(url) : url.includes('identity.example.com') ? { status: 500 } : { status: 200 }));
    await linkGrant(JANE, 'crm', { code: 'c', redirectUri: SF.grants!.redirectUris[0], codeVerifier: 'v' }, w.deps);
    await linkGrant(JANE, 'oncall', { code: 'c', redirectUri: PD.grants!.redirectUris[0], codeVerifier: 'v' }, w.deps);
    await linkGrant(OMAR, 'crm', { code: 'c', redirectUri: SF.grants!.redirectUris[0], codeVerifier: 'v' }, w.deps);
    expect(await handleRevoker({ personId: JANE }, w.deps)).toEqual({ revoked: 1, failed: 1 });
    expect([...w.items.keys()].sort()).toEqual([`${JANE}|oncall`, `${OMAR}|crm`].sort());
    expect(w.items.get(`${JANE}|oncall`)!.status).toBe('revoke-failed');
    expect(await revokePersonGrants(OMAR, w.deps)).toEqual({ revoked: 1, failed: 0 });
  });

  it('refuses an offboarding call that names no person id', async () => {
    const { deps } = world();
    await expect(handleRevoker({ personId: 'jane@example.com' }, deps)).rejects.toThrow(/not a person id/);
    await expect(handleRevoker({} as never, deps)).rejects.toThrow(/neither/);
  });
});

describe('the person\'s own routes', () => {
  const event = (method: string, personId: string | null, connectorId: string, body?: unknown): APIGatewayProxyEvent => ({
    httpMethod: method,
    pathParameters: { connectorId },
    headers: {},
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: personId ? { authorizer: edgeContext({ claims: { sub: `subject-of-${personId}`, token_use: 'id' }, personId }) } : {},
  }) as unknown as APIGatewayProxyEvent;

  it('links and revokes the caller\'s grant, never one the body names', async () => {
    const { deps, items } = world(tokenAnswer);
    const link = await handleGrantRoute(event('POST', JANE, 'crm', { code: 'c', redirectUri: SF.grants!.redirectUris[0], codeVerifier: 'v', personId: OMAR }), deps);
    expect(link.statusCode).toBe(204);
    expect([...items.keys()]).toEqual([`${JANE}|crm`]);
    expect((await handleGrantRoute(event('DELETE', JANE, 'crm'), deps)).statusCode).toBe(204);
    expect(items.size).toBe(0);
  });

  it('refuses a request that names no person, and a connector that takes no grant', async () => {
    const { deps } = world(tokenAnswer);
    expect((await handleGrantRoute(event('POST', null, 'crm', {}), deps)).statusCode).toBe(401);
    expect((await handleGrantRoute(event('POST', JANE, 'nope', {}), deps)).statusCode).toBe(404);
    expect((await handleGrantRoute(event('POST', JANE, 'crm', { code: 'c' }), deps)).statusCode).toBe(400);
  });

  it('answers 202 when the vendor has not confirmed a revocation, keeping the grant for the retry', async () => {
    const { deps, items } = world((url) => (url.endsWith('/token') ? tokenAnswer(url) : { status: 502 }));
    await linkGrant(JANE, 'crm', { code: 'c', redirectUri: SF.grants!.redirectUris[0], codeVerifier: 'v' }, deps);
    const r = await handleGrantRoute(event('DELETE', JANE, 'crm'), deps);
    expect(r.statusCode).toBe(202);
    expect(items.get(`${JANE}|crm`)!.status).toBe('revoke-failed');
  });
});

describe('offboarding reaches the grants through the revoker', () => {
  it('lists connectorGrants among the stores it removes from, before the identity is touched', () => {
    expect(OFFBOARDED_STORES.indexOf('connectorGrants')).toBeGreaterThan(-1);
    expect(OFFBOARDED_STORES.indexOf('connectorGrants')).toBeLessThan(OFFBOARDED_STORES.indexOf('identities'));
  });

  it('invokes the revoker by name with the person id, and refuses an answer with no counts', async () => {
    const sent: unknown[] = [];
    const ok = connectorGrantsRevoker('ae-connector-grant-revoker', 'us-east-1', { send: async (cmd: any) => { sent.push(cmd.input); return { Payload: Buffer.from(JSON.stringify({ revoked: 2, failed: 1 })) }; } });
    expect(await ok(JANE)).toEqual({ revoked: 2, failed: 1 });
    expect(sent).toEqual([expect.objectContaining({ FunctionName: 'ae-connector-grant-revoker' })]);
    expect(JSON.parse(Buffer.from((sent[0] as { Payload: Uint8Array }).Payload).toString())).toEqual({ personId: JANE });
    const broken = connectorGrantsRevoker('f', 'us-east-1', { send: async () => ({ FunctionError: 'Unhandled', Payload: Buffer.from('{}') }) });
    await expect(broken(JANE)).rejects.toThrow(/failed/);
    const empty = connectorGrantsRevoker('f', 'us-east-1', { send: async () => ({ Payload: Buffer.from('{}') }) });
    await expect(empty(JANE)).rejects.toThrow(/no counts/);
  });
});
