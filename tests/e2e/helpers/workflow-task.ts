/**
 * What the ADR-063 specs share: activating a version of the premium primary whose welcome runs a task step, rolling it
 * back, opening a conversation as the premium test user, and reading the messages that user sees with their Metadata.
 */
import { expect } from '@playwright/test';
import { getTestCredentials, missingUserReason } from './test-credentials';
import { signedCall } from './admin-api';
import { channelArnFor } from './battle-state-backend';
import { idTokenFor, personArnOf } from './person';
import { aws } from './aws';
import { adminUrl, personUrl } from './api-urls';
import { trackConversation } from './watchdog/current';
import { untilRoomChanges } from './watchdog/wire-wait';

export const PROFILE = 'advisor';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The active version now, to roll back to. */
export async function activeVersionOf(admin: unknown): Promise<number | undefined> {
  const listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), admin as never);
  return (listing.body?.profiles ?? []).find((p: any) => p.profileName === PROFILE)?.activeVersion ?? undefined;
}

/** Create a version, patch its event workflows, validate and return the validation body (errors and warnings). */
export async function draftWith(admin: unknown, eventWorkflows: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<any> {
  const created = await signedCall(adminUrl('assistant-admin', '/admin/profiles/version'), admin as never, 'POST', { profileName: PROFILE });
  expect(created.status, JSON.stringify(created.body).slice(0, 400)).toBe(200);
  const edited = await signedCall(adminUrl('assistant-admin', '/admin/profiles/draft'), admin as never, 'POST', { profileName: PROFILE, patch: { eventWorkflows, ...extra } });
  if (edited.status !== 200) return { errors: [JSON.stringify(edited.body)] };
  const valid = await signedCall(adminUrl('assistant-admin', '/admin/profiles/validate'), admin as never, 'POST', { profileName: PROFILE });
  return valid.body ?? {};
}

export async function activate(admin: unknown): Promise<void> {
  const activated = await signedCall(adminUrl('assistant-admin', '/admin/profiles/activate'), admin as never, 'POST', { profileName: PROFILE });
  expect(activated.status, JSON.stringify(activated.body).slice(0, 400)).toBe(200);
}

export async function rollBack(admin: unknown, version: number | undefined): Promise<void> {
  if (version === undefined) return;
  await signedCall(adminUrl('assistant-admin', '/admin/profiles/rollback'), admin as never, 'POST', { profileName: PROFILE, version }).catch(() => undefined);
}

/** A new conversation as the premium test user, created the way the chat client creates one. */
export async function openConversation(title: string): Promise<{ channelId: string; channelArn: string; personArn: string; token: string }> {
  const creds = await getTestCredentials();
  const premium = creds.premiumUser;
  if (!premium?.password) throw new Error(missingUserReason('premiumUser'));
  const personArn = await personArnOf(premium);
  const token = idTokenFor(premium.email, premium.password, creds.cognitoClientId);
  const conv = await fetch(personUrl('/create-conversation'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, modelId: 'sonnet', modelName: 'Claude Sonnet', modelTier: 'premium', userArn: personArn }),
  });
  expect(conv.status).toBe(200);
  const channelArn = (await conv.json()).conversation.conversationArn as string;
  return { channelId: channelArn.split('/channel/')[1], channelArn, personArn, token };
}

export interface Seen { messageId: string; sender: string; content: string; target: string[]; metadata: Record<string, any> }

/** Messages a person can see, with whom each is targeted to and its Metadata. */
export function messagesSeenBy(channelId: string, userArn: string): Seen[] {
  trackConversation(channelId);
  const res = aws(`chime-sdk-messaging list-channel-messages --channel-arn ${channelArnFor(channelId)} --chime-bearer ${userArn} --max-results 50`);
  return (res?.ChannelMessages || []).map((m: any) => {
    let metadata: Record<string, any> = {};
    try { metadata = JSON.parse(m?.Metadata || '{}'); } catch { metadata = {}; }
    return { messageId: m?.MessageId || '', sender: m?.Sender?.Arn || '', content: decodeURIComponent(m?.Content || ''), target: (m?.Target || []).map((t: any) => t?.MemberArn || ''), metadata };
  });
}

/** Wait until a message matching `pick` is seen, or the deadline passes; woken by the room's message events. */
export async function waitFor(channelId: string, userArn: string, pick: (m: Seen) => boolean, ms = 150_000): Promise<{ hit?: Seen; seen: Seen[] }> {
  const seen = await untilRoomChanges(channelArnFor(channelId), userArn, () => messagesSeenBy(channelId, userArn), (s) => s.some(pick), { timeoutMs: ms });
  const hit = seen.find(pick);
  return hit ? { hit, seen } : { seen };
}

/** Press a choice on a task card, as the person the token names. */
export async function pressCard(token: string, body: { channelArn: string; taskId: string; state: string; choice: string }): Promise<{ status: number; body: any }> {
  const resp = await fetch(personUrl('/tasks/advance'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

/** The open work items the person owns (`GET /tasks/mine`). */
export async function openWorkOf(token: string): Promise<any[]> {
  const resp = await fetch(personUrl('/tasks/mine'), { headers: { Authorization: `Bearer ${token}` } });
  return ((await resp.json().catch(() => ({}))).items ?? []) as any[];
}
