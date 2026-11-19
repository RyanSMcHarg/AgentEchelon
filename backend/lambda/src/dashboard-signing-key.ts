/**
 * THE DASHBOARD DISTRIBUTION'S SIGNING KEY (DESIGN-CONVERSATION-DASHBOARDS section 4), made once at deploy.
 *
 * A CloudFormation custom resource. On create it generates an RSA key pair, stores the private half in the stack's
 * secret, and returns the public half for the distribution's key group. An update returns the public half again from the
 * stored private key, so a redeploy never rotates the key out from under links already signed. Nothing else reads the
 * secret but the link function.
 */
import { createPublicKey, generateKeyPairSync } from 'crypto';
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const secrets = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });

interface CustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: { SecretArn: string };
}

export async function handler(event: CustomResourceEvent): Promise<{ PhysicalResourceId: string; Data?: Record<string, string> }> {
  const secretArn = event.ResourceProperties.SecretArn;
  const id = event.PhysicalResourceId || `dashboard-signing-key-${Date.now()}`;
  if (event.RequestType === 'Delete') return { PhysicalResourceId: id };
  const stored = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }))
    .then((s) => s.SecretString ?? '')
    .catch(() => '');
  let privatePem = stored.includes('PRIVATE KEY') ? stored : '';
  if (!privatePem) {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await secrets.send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: privatePem }));
  }
  const publicPem = createPublicKey(privatePem).export({ type: 'spki', format: 'pem' }).toString();
  return { PhysicalResourceId: id, Data: { PublicKeyPem: publicPem } };
}
