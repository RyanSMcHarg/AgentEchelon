/**
 * A CONNECTOR'S SECRET, BY NAME, READ ON FIRST USE AND CACHED FOR FIVE MINUTES (the shared cache,
 * `lib/secret-cache.ts`).
 *
 * A connector that takes per-person grants has one Secrets Manager secret the operator creates
 * (`connectorSecretNames`, `lib/config/connectors.ts`), so a teardown never deletes a vendor credential:
 * `<instance>/connector/<id>/oauth-client`, `{ "clientId": "...", "clientSecret": "..." }`. Receiving a
 * vendor's events needs no secret: they arrive through its EventBridge partner event source.
 *
 * A secret that cannot be read, or reads empty, THROWS: the caller fails closed (a refused grant route; a
 * revocation left for the retry).
 */
import { SecretUnavailable, __resetSecretCacheForTests as resetSharedSecretCache, readCachedSecret } from '../secret-cache.js';
import { connectorSecretNames } from '../../../../lib/config/connectors.js';

type Sender = { send(command: unknown): Promise<any> };

export { SECRET_CACHE_MS } from '../secret-cache.js';

/** A secret that could not be read, or holds nothing usable. */
export class ConnectorSecretUnavailable extends Error {
  constructor(readonly secretName: string, detail: string) {
    super(`connector secret ${secretName}: ${detail}`);
    this.name = 'ConnectorSecretUnavailable';
  }
}

export function __resetConnectorSecretsForTests(): void {
  resetSharedSecretCache();
}

/** The instance's resource prefix the secrets are named under. */
export function resourcePrefix(): string {
  return (process.env.CONNECTOR_SECRET_PREFIX || '').trim();
}

async function read(name: string, client: Sender | undefined, now: number): Promise<string> {
  try {
    return await readCachedSecret({ secretId: name }, { secrets: client, now });
  } catch (err) {
    if (!(err instanceof SecretUnavailable)) throw err;
    throw new ConnectorSecretUnavailable(name, err.reason === 'empty' ? 'is empty' : `could not be read (${err.cause || 'error'})`);
  }
}

/** A connector's OAuth client, for the per-person grants. */
export async function oauthClient(connectorId: string, deps: { client?: Sender; now?: number; prefix?: string } = {}): Promise<{ clientId: string; clientSecret: string }> {
  const name = connectorSecretNames(deps.prefix ?? resourcePrefix(), connectorId).oauthClient;
  const raw = await read(name, deps.client, deps.now ?? Date.now());
  let parsed: { clientId?: unknown; clientSecret?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConnectorSecretUnavailable(name, 'is not JSON');
  }
  if (typeof parsed?.clientId !== 'string' || !parsed.clientId || typeof parsed.clientSecret !== 'string' || !parsed.clientSecret) {
    throw new ConnectorSecretUnavailable(name, 'names no clientId and clientSecret');
  }
  return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
}
