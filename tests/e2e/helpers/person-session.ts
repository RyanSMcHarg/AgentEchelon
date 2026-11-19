/**
 * A PERSON ACTING ON THE PERSON API WITH THE TOKEN THEY HOLD, and on Amazon Chime SDK with the credential the exchange
 * vended them: the two paths the chat app uses. Every call here is signed as the person, never as the operator, so a
 * refusal it reads is the refusal a person meets.
 */
import { execFileSync } from 'child_process';
import { expect } from '@playwright/test';
import { personUrl } from './api-urls';
import { exchange, type VendedCredentials } from './admin-api';

const REGION = process.env.AWS_REGION || 'us-east-1';

export interface Answer { status: number; body: any }

/** POST a person route with the person's id token. A refusal is returned, not thrown. */
export async function postAs(token: string, route: string, body: unknown): Promise<Answer> {
  const res = await fetch(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, body: text ? JSON.parse(text) : null }; } catch { return { status: res.status, body: { raw: text.slice(0, 300) } }; }
}

/** Open a conversation as its owner; returns its ARN and id. */
export async function openConversation(ownerToken: string, title: string): Promise<{ channelArn: string; conversationId: string }> {
  const created = await postAs(ownerToken, personUrl('/create-conversation'), {
    title, modelId: 'sonnet', modelName: 'Claude Sonnet', modelTier: 'premium',
  });
  expect(created.status, JSON.stringify(created.body).slice(0, 300)).toBe(200);
  const channelArn = String(created.body?.conversation?.conversationArn || '');
  const conversationId = channelArn.split('/channel/')[1];
  expect(conversationId, 'the creation names its conversation').toBeTruthy();
  return { channelArn, conversationId };
}

/** The owner shares the conversation with a person by email, which makes them a member. */
export function shareWith(ownerToken: string, channelArn: string, title: string, recipientEmail: string): Promise<Answer> {
  return postAs(ownerToken, personUrl('/share-conversation'), { conversationArn: channelArn, conversationTitle: title, recipientEmail });
}

/** The owner removes a member: the one way a removal is driven in these specs. */
export function removeMember(ownerToken: string, channelArn: string, memberArn: string): Promise<Answer> {
  return postAs(ownerToken, personUrl('/conversations/remove-member'), { channelArn, memberArn });
}

/** The owner archives the conversation, which every spec here does when it is done. */
export function archive(ownerToken: string, channelArn: string): Promise<Answer> {
  return postAs(ownerToken, personUrl('/conversations/archive'), { channelArn });
}

/** Ask the presigner for an upload signature on a small text file in the conversation. */
export function signUpload(token: string, conversationId: string): Promise<Answer> {
  return postAs(token, personUrl('/presigned-url'), { action: 'upload', fileName: 'probe.txt', fileType: 'text/plain', conversationId });
}

/** Ask the presigner for a download signature on a file key it issued. */
export function signDownload(token: string, conversationId: string, fileKey: string): Promise<Answer> {
  return postAs(token, personUrl('/presigned-url'), { action: 'download', fileKey, conversationId });
}

/** The chat credential the exchange vends a person for one conversation. */
export async function chatCredentials(idToken: string, channelArn: string): Promise<VendedCredentials> {
  const vend = await exchange(idToken, { channelArn });
  expect(vend.status, `the person is vended a chat credential: ${JSON.stringify(vend.body).slice(0, 300)}`).toBe(200);
  return vend.body.credentials as VendedCredentials;
}

/**
 * Send a message on Amazon Chime SDK with a vended credential, bearing the person, as the chat app does. Returns
 * whether it was accepted and, when refused, the service's error, so a refusal is asserted rather than thrown.
 */
export function sendWithCredential(creds: VendedCredentials, channelArn: string, bearerArn: string, content: string): { ok: boolean; error?: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, MSYS_NO_PATHCONV: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  delete env.AWS_PROFILE;
  env.AWS_ACCESS_KEY_ID = creds.accessKeyId ?? creds.AccessKeyId ?? '';
  env.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey ?? creds.SecretAccessKey ?? '';
  env.AWS_SESSION_TOKEN = creds.sessionToken ?? creds.SessionToken ?? '';
  try {
    execFileSync('aws', [
      'chime-sdk-messaging', 'send-channel-message', '--channel-arn', channelArn, '--content', content,
      '--type', 'STANDARD', '--persistence', 'PERSISTENT', '--chime-bearer', bearerArn, '--region', REGION, '--output', 'json',
    ], { encoding: 'utf8', timeout: 60_000, env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, error: String(e.stderr || e.message || err).slice(0, 400) };
  }
}
