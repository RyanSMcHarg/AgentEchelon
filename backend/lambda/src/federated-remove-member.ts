// Federated remove-member (ADR-0014 — federated context sharing). Evicts a federated user from a
// context-bound conversation when the host revokes their access. Invoked DIRECTLY
// (lambda:InvokeFunction) by the host backend after its own ACL change — IAM is the
// authorization boundary, never bare channel membership. Idempotent.

import {
  ChimeSDKMessagingClient,
  DeleteChannelMembershipCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { deriveFederatedSub } from './lib/federated-identity';

const messaging = new ChimeSDKMessagingClient({});
const ssm = new SSMClient({});

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN!;
const TIER = (process.env.ASSISTANT_TIER || 'basic').trim();
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const BOT_ARN_PARAM = process.env.BOT_ARN_PARAM || `${SSM_ROOT}/tier/${TIER}/bot-arn`;

let cachedBotArn: string | null = null;
async function getBotArn(): Promise<string> {
  if (cachedBotArn !== null) return cachedBotArn;
  const r = await ssm.send(new GetParameterCommand({ Name: BOT_ARN_PARAM }));
  cachedBotArn = r.Parameter?.Value || '';
  if (!cachedBotArn) throw new Error(`per-tier bot ARN ${BOT_ARN_PARAM} is empty`);
  return cachedBotArn;
}

function channelIdFor(contextType: string, contextId: string): string {
  return `fed-${TIER}-${contextType}-${contextId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

interface RemoveMemberEvent {
  contextType?: string;
  contextId?: string;
  iss?: string;
  sub?: string;
}

export const handler = async (event: RemoveMemberEvent) => {
  const contextType = String(event.contextType || '').trim();
  const contextId = String(event.contextId || '').trim();
  const iss = String(event.iss || '').trim();
  const sub = String(event.sub || '').trim();
  if (!contextType || !contextId || !iss || !sub) {
    return { ok: false, error: 'contextType, contextId, iss and sub are required' };
  }

  const userArn = `${APP_INSTANCE_ARN}/user/${deriveFederatedSub(iss, sub)}`;
  const conversationArn = `${APP_INSTANCE_ARN}/channel/${channelIdFor(contextType, contextId)}`;

  try {
    const botArn = await getBotArn();
    try {
      await messaging.send(new DeleteChannelMembershipCommand({
        ChannelArn: conversationArn, MemberArn: userArn, ChimeBearer: botArn,
      }));
    } catch (err) {
      // Already gone (never joined, or channel/membership absent) — revocation is idempotent.
      const name = (err as { name?: string }).name;
      if (name !== 'NotFoundException' && name !== 'ConflictException') throw err;
    }
    return { ok: true, conversationArn, userArn };
  } catch (err) {
    console.error('[FederatedRemoveMember] failed:', err);
    return { ok: false, error: 'Federated remove-member failed' };
  }
};
