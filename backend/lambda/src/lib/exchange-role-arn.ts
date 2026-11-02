/**
 * THE VEND ROLE OF A CLASSIFICATION, FOUND BY NAME AT CALL TIME.
 *
 * Each classification's vend role is built and published by the stack that owns it (`ExchangeRole`,
 * `lib/constructs/exchange-role.ts`): `Assistants-<classification>` for a conversational classification,
 * `Identity` for the admin plane. The exchange reads `${EXCHANGE_ROLE_ARN_PARAM_ROOT}/<classification>/exchange-role-arn` when it
 * vends at one, so its environment names no classification and declaring one changes nothing in it (the
 * classification-independence plan, step 4). The shape is `resolveRouterArn`'s (`router-arn.ts`): an explicit
 * map in the environment wins where one is set, then the parameter, cached per container.
 *
 * A classification with no published role is refused by the caller rather than vended another's: nothing
 * substitutes for a missing role.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';

let ssm: SSMClient | undefined;
const byClassification = new Map<string, string>();

/** An explicit `{ classification: roleArn }` map, where the environment carries one. */
function fromEnvironment(): Record<string, string> {
  const raw = (process.env.EXCHANGE_ROLE_ARNS_JSON || '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch (err) {
    console.error('[exchange-role-arn] EXCHANGE_ROLE_ARNS_JSON is not valid JSON; it names no role', err);
    return {};
  }
}

/** The vend role ARN for `classification`, or undefined when none is published or it is not declared. */
export async function resolveExchangeRoleArn(classification: string): Promise<string | undefined> {
  // Only a declared value forms a parameter name, so a token can never name a key outside the root.
  if (!profiles.isKnownClassification(classification)) return undefined;
  const explicit = fromEnvironment()[classification];
  if (explicit) return explicit;
  const cached = byClassification.get(classification);
  if (cached) return cached;
  const root = (process.env.EXCHANGE_ROLE_ARN_PARAM_ROOT || '').trim();
  if (!root) {
    console.error('[exchange-role-arn] EXCHANGE_ROLE_ARN_PARAM_ROOT is not set; no vend role can be found', { classification });
    return undefined;
  }
  const name = `${root}/${classification}/exchange-role-arn`;
  try {
    ssm = ssm ?? new SSMClient({});
    const arn = ((await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value || '').trim();
    if (arn) {
      byClassification.set(classification, arn);
      return arn;
    }
    console.error('[exchange-role-arn] the vend role parameter is empty', { name });
  } catch (err) {
    console.error('[exchange-role-arn] the vend role parameter could not be read', { name, err: (err as Error)?.name });
  }
  return undefined;
}

/** For tests: forget what was found. */
export function resetExchangeRoleArnCache(): void {
  byClassification.clear();
  ssm = undefined;
}
