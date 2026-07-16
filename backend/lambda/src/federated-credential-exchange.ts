// Federated credential exchange — vends bearer-pinned Chime creds for a user
// authenticated against a FOREIGN IdP (a host app's own Cognito pool), so a host
// can embed the assistant without migrating its users. Additive to the native
// exchange. Identity comes ONLY from the validated authorizer claims; the foreign
// `sub` maps to a disjoint, charset-safe AppInstanceUser id via deriveFederatedSub,
// used as BOTH the AppInstanceUser id and the `sub` session tag (bearer pin holds).
// Federated users are admitted at the 'restricted' rung (channel admission scoped).

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { ChimeSDKIdentityClient, CreateAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-identity';
import { deriveFederatedSub } from './lib/federated-identity';

const sts = new STSClient({});
const identity = new ChimeSDKIdentityClient({});
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN!;
const ROLE_ARN = process.env.EXCHANGE_ROLE_RESTRICTED!;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function cors(): Record<string, string> {
  return { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Content-Type': 'application/json' };
}

async function ensureAppInstanceUser(id: string, name: string): Promise<void> {
  try {
    await identity.send(new CreateAppInstanceUserCommand({
      AppInstanceArn: APP_INSTANCE_ARN,
      AppInstanceUserId: id,
      Name: name.slice(0, 100),
      ClientRequestToken: ('fed-' + id).slice(0, 64),
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConflictException') throw err;
  }
}

export const handler = async (
  event: { httpMethod?: string; requestContext?: { authorizer?: { claims?: Record<string, string> } } },
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => {
  if (event?.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  const claims = event?.requestContext?.authorizer?.claims || {};
  const rawSub = claims.sub;
  const iss = claims.iss;
  if (!rawSub || !iss) {
    return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: 'Unauthenticated' }) };
  }
  const fedSub = deriveFederatedSub(iss, rawSub);
  const displayName = (claims.name || claims['cognito:username'] || fedSub).toString();
  try {
    await ensureAppInstanceUser(fedSub, displayName);
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: ROLE_ARN,
      RoleSessionName: ('fed-' + fedSub).slice(0, 64),
      DurationSeconds: 3600,
      Tags: [{ Key: 'sub', Value: fedSub }],
    }));
    const c = assumed.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
      throw new Error('AssumeRole returned no credentials');
    }
    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({
        credentials: {
          AccessKeyId: c.AccessKeyId,
          SecretAccessKey: c.SecretAccessKey,
          SessionToken: c.SessionToken,
          Expiration: c.Expiration ? new Date(c.Expiration).toISOString() : undefined,
        },
        userArn: APP_INSTANCE_ARN + '/user/' + fedSub,
        tier: 'restricted',
      }),
    };
  } catch (err) {
    console.error('[FederatedExchange] failed:', err);
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'Federated exchange failed' }) };
  }
};
