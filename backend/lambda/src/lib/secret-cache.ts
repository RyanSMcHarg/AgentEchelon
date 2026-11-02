/**
 * A SECRET'S VALUE, BY NAME, READ ON FIRST USE AND CACHED FOR FIVE MINUTES. The one cache every Lambda
 * reads its secrets through: the guest and invitation-link abuse controls (`guest-abuse.readSecret`), a
 * connector's OAuth client (`connectors/secrets.ts`), the image providers' keys (`image-gen-models.ts`) and
 * an external model provider's key (`providers/external-llm.ts`).
 *
 * A secret is named by a Secrets Manager id (`secretId`) or an SSM SecureString (`parameter`). Five minutes
 * bounds both the calls a warm container makes and how long a rotated value takes to be read.
 *
 * A secret that cannot be read, or reads empty, THROWS `SecretUnavailable`, and nothing is cached for it, so
 * the next call tries again. Each caller turns that into its own refusal and fails closed.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

type Sender = { send(command: unknown): Promise<any> };

export const SECRET_CACHE_MS = 5 * 60_000;

export interface SecretRef {
  /** A Secrets Manager secret id or ARN. */
  secretId?: string;
  /** An SSM SecureString parameter name. */
  parameter?: string;
}

/** Why a secret has no value: none was named, the read failed, or it holds nothing. */
export class SecretUnavailable extends Error {
  constructor(readonly reason: 'unnamed' | 'unreadable' | 'empty', readonly secretName: string, readonly cause?: string) {
    super(reason === 'unnamed' ? 'no secret is named'
      : reason === 'empty' ? `secret ${secretName} is empty`
      : `secret ${secretName} could not be read (${cause || 'error'})`);
    this.name = 'SecretUnavailable';
  }
}

const cache = new Map<string, { at: number; value: string }>();
let defaultSecrets: Sender | null = null;
let defaultSsm: Sender | null = null;

export function __resetSecretCacheForTests(): void {
  cache.clear();
}

/** The value a secret holds, from the cache when it was read in the last five minutes. */
export async function readCachedSecret(ref: SecretRef, deps: { secrets?: Sender; ssm?: Sender; now?: number } = {}): Promise<string> {
  const key = ref.secretId ? `sm:${ref.secretId}` : ref.parameter ? `ssm:${ref.parameter}` : '';
  if (!key) throw new SecretUnavailable('unnamed', '');
  const name = ref.secretId || ref.parameter!;
  const now = deps.now ?? Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < SECRET_CACHE_MS) return hit.value;
  const region = process.env.AWS_REGION || 'us-east-1';
  let value: string | undefined;
  try {
    value = ref.secretId
      ? (await (deps.secrets ?? (defaultSecrets ??= new SecretsManagerClient({ region }))).send(new GetSecretValueCommand({ SecretId: ref.secretId })))?.SecretString
      : (await (deps.ssm ?? (defaultSsm ??= new SSMClient({ region }))).send(new GetParameterCommand({ Name: ref.parameter!, WithDecryption: true })))?.Parameter?.Value;
  } catch (err) {
    throw new SecretUnavailable('unreadable', name, (err as Error)?.name || 'error');
  }
  if (!value) throw new SecretUnavailable('empty', name);
  cache.set(key, { at: now, value });
  return value;
}
