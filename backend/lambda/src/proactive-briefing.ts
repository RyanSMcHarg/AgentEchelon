/**
 * Proactive Briefing — EventBridge-triggered proactive workflow.
 *
 * This is the "proactive" half of the Post-1 story (reactive = a user
 * asks; proactive = the system acts on a schedule with no human in the
 * loop). On an EventBridge schedule it:
 *
 *   1. creates a new conversation (bot-owned RESTRICTED/PRIVATE channel,
 *      members added) — same Chime primitives as create-conversation,
 *   2. renders a standalone briefing "dashboard page" to S3 and signs a
 *      GET URL for it (the page is created on the fly per run),
 *   3. emails every member the briefing + links, via the
 *      notification workflow (lib/notification.ts),
 *   4. seeds the new conversation with a message linking the page.
 *
 * Scope: minimal-but-real (a genuine deployed EventBridge feature). NOT
 * hardened for idempotency/dedupe — a scheduled re-fire creates a fresh
 * briefing, which is the intended behaviour for a periodic briefing.
 */
import {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
  AssociateChannelFlowCommand,
  SendChannelMessageCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sendEmailNotifications, type EmailRecipient } from './lib/notification.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const BOT_ARN_PARAM = process.env.BOT_ARN_PARAM || '';
const CHANNEL_FLOW_ARN_PARAM = process.env.CHANNEL_FLOW_ARN_PARAM || '';
const REPORT_BUCKET = process.env.REPORT_BUCKET || '';
const APP_URL = process.env.APP_URL || 'http://localhost:5173';
const REPORT_URL_TTL_SECONDS = 7 * 24 * 3600; // 7 days — the email may be opened later

const messagingClient = new ChimeSDKMessagingClient({ region: AWS_REGION });
const ssmClient = new SSMClient({ region: AWS_REGION });
const s3Client = new S3Client({ region: AWS_REGION });

/** Member to notify + add to the briefing conversation. */
interface BriefingMember {
  userArn: string;
  email: string;
  name: string;
}

let cachedBotArn: string | null = null;
let cachedFlowArn: string | null = null;

async function getSsm(name: string): Promise<string> {
  const r = await ssmClient.send(new GetParameterCommand({ Name: name }));
  return r.Parameter?.Value || '';
}

async function getBotArn(): Promise<string> {
  if (cachedBotArn) return cachedBotArn;
  cachedBotArn = await getSsm(BOT_ARN_PARAM);
  return cachedBotArn;
}

async function getFlowArn(): Promise<string> {
  if (cachedFlowArn !== null) return cachedFlowArn;
  if (!CHANNEL_FLOW_ARN_PARAM) {
    cachedFlowArn = '';
    return '';
  }
  try {
    cachedFlowArn = await getSsm(CHANNEL_FLOW_ARN_PARAM);
  } catch {
    cachedFlowArn = '';
  }
  return cachedFlowArn;
}

/**
 * Members come from the BRIEFING_RECIPIENTS env (JSON array of
 * {userArn,email,name}) — minimal-but-real and deployment-configurable.
 * In the demo this is seeded with the Stratum demo users.
 */
function loadMembers(): BriefingMember[] {
  try {
    const parsed = JSON.parse(process.env.BRIEFING_RECIPIENTS || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is BriefingMember =>
        !!m && typeof m.userArn === 'string' && typeof m.email === 'string' && typeof m.name === 'string',
    );
  } catch (err) {
    console.error('[proactive-briefing] BRIEFING_RECIPIENTS is not valid JSON:', err);
    return [];
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Briefing {
  title: string;
  generatedAt: string;
  triggerSource: string;
  lines: string[];
}

function buildBriefing(event: { source?: string; 'detail-type'?: string } | undefined): Briefing {
  const generatedAt = new Date().toISOString();
  const triggerSource = event?.source ? `${event.source} / ${event['detail-type'] ?? 'Scheduled'}` : 'EventBridge schedule';
  return {
    title: `Proactive Operational Briefing — ${generatedAt.slice(0, 10)}`,
    generatedAt,
    triggerSource,
    lines: [
      `Generated automatically at ${generatedAt} (no user request — triggered by ${triggerSource}).`,
      'This conversation and its briefing page were created on the fly by the proactive workflow.',
      'Reply in this conversation to ask the assistant follow-up questions about anything below.',
    ],
  };
}

function renderReportHtml(b: Briefing, members: BriefingMember[]): string {
  const lis = b.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  const recips = members.map((m) => `<li>${escapeHtml(m.name)} &lt;${escapeHtml(m.email)}&gt;</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(b.title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1c1c1c}
h1{font-size:22px}.meta{color:#666;font-size:13px}ul{padding-left:20px}.tag{display:inline-block;background:#f5a623;color:#1c1c1c;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600}</style>
</head><body>
<span class="tag">PROACTIVE</span>
<h1>${escapeHtml(b.title)}</h1>
<p class="meta">Generated ${escapeHtml(b.generatedAt)} · trigger: ${escapeHtml(b.triggerSource)}</p>
<ul>${lis}</ul>
<h2>Recipients</h2><ul>${recips}</ul>
</body></html>`;
}

export interface ProactiveBriefingResult {
  ok: boolean;
  conversationArn?: string;
  channelId?: string;
  reportUrl?: string;
  emailSent: string[];
  emailFailed: Array<{ email: string; error: string }>;
  emailSkipped?: string;
  error?: string;
}

export const handler = async (
  event?: { source?: string; 'detail-type'?: string },
): Promise<ProactiveBriefingResult> => {
  const members = loadMembers();
  if (members.length === 0) {
    console.warn('[proactive-briefing] No BRIEFING_RECIPIENTS configured — nothing to do.');
    return { ok: true, emailSent: [], emailFailed: [] };
  }

  try {
    const botArn = await getBotArn();
    if (!botArn) throw new Error('Bot ARN not resolvable from SSM');

    const briefing = buildBriefing(event);
    const channelId = `conv-proactive-${Date.now()}`;

    // 1. Bot creates the conversation (RESTRICTED + PRIVATE, like create-conversation).
    const created = await messagingClient.send(
      new CreateChannelCommand({
        AppInstanceArn: APP_INSTANCE_ARN,
        ChannelId: channelId,
        Name: briefing.title.slice(0, 80),
        Mode: 'RESTRICTED',
        Privacy: 'PRIVATE',
        ChimeBearer: botArn,
        // SPEC-CONVERSATION-SECURITY Layer 1: classification tag the fail-closed
        // IAM boundary keys on. Matches modelTier + the standard bot this runs as.
        Tags: [
          { Key: 'classification', Value: 'standard' },
          { Key: 'conversationType', Value: 'briefing' },
        ],
        Metadata: JSON.stringify({
          createdViaProactive: true,
          generatedAt: briefing.generatedAt,
          triggerSource: briefing.triggerSource,
          modelTier: 'standard',
        }),
      }),
    );
    const conversationArn = created.ChannelArn;
    if (!conversationArn) throw new Error('CreateChannel returned no ARN');

    // 2. Add each member.
    for (const m of members) {
      try {
        await messagingClient.send(
          new CreateChannelMembershipCommand({
            ChannelArn: conversationArn,
            MemberArn: m.userArn,
            Type: 'DEFAULT',
            ChimeBearer: botArn,
          }),
        );
      } catch (err) {
        console.error(`[proactive-briefing] Failed to add member ${m.userArn}:`, err);
      }
    }

    // 3. Associate the channel flow (best-effort — @assistant routing).
    const flowArn = await getFlowArn();
    if (flowArn) {
      try {
        await messagingClient.send(
          new AssociateChannelFlowCommand({
            ChannelArn: conversationArn,
            ChannelFlowArn: flowArn,
            ChimeBearer: botArn,
          }),
        );
      } catch (err) {
        console.warn('[proactive-briefing] AssociateChannelFlow failed (non-fatal):', err);
      }
    }

    // 4. Render the briefing page to S3 and sign a GET URL (created on the fly).
    let reportUrl: string | undefined;
    if (REPORT_BUCKET) {
      const key = `briefings/${channelId}.html`;
      await s3Client.send(
        new PutObjectCommand({
          Bucket: REPORT_BUCKET,
          Key: key,
          Body: renderReportHtml(briefing, members),
          ContentType: 'text/html; charset=utf-8',
        }),
      );
      reportUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: REPORT_BUCKET, Key: key }),
        { expiresIn: REPORT_URL_TTL_SECONDS },
      );
    } else {
      console.warn('[proactive-briefing] REPORT_BUCKET unset — skipping the on-the-fly page.');
    }

    const conversationLink = `${APP_URL}?conversation=${channelId}`;

    // 5. Seed the conversation with a message linking the page.
    await messagingClient.send(
      new SendChannelMessageCommand({
        ChannelArn: conversationArn,
        Content:
          `I generated a proactive briefing for you (no request needed — triggered by ${briefing.triggerSource}). ` +
          (reportUrl ? `View the briefing page: ${reportUrl}` : 'The briefing page is unavailable in this deployment.') +
          ` Ask me anything about it here.`,
        Type: ChannelMessageType.STANDARD,
        Persistence: ChannelMessagePersistenceType.PERSISTENT,
        ChimeBearer: botArn,
      }),
    );

    // 6. Email every member via the notification workflow.
    const recipients: EmailRecipient[] = members.map((m) => ({ email: m.email, name: m.name }));
    const bodyText =
      `${briefing.title} is ready. A new conversation has been created for you.\n\n` +
      (reportUrl ? `Briefing page: ${reportUrl}\n` : '') +
      `Open the conversation: ${conversationLink}`;
    const bodyHtml =
      `<p><strong>${escapeHtml(briefing.title)}</strong> is ready — a new conversation was created for you.</p>` +
      (reportUrl ? `<p><a href="${reportUrl}">Open the briefing page</a></p>` : '') +
      `<p><a href="${conversationLink}">Open the conversation</a></p>`;
    const emailResult = await sendEmailNotifications(recipients, {
      subject: briefing.title,
      bodyText,
      bodyHtml,
    });

    console.log('[proactive-briefing] Done', {
      conversationArn,
      reportUrl: !!reportUrl,
      sent: emailResult.sent.length,
      failed: emailResult.failed.length,
    });

    return {
      ok: true,
      conversationArn,
      channelId,
      reportUrl,
      emailSent: emailResult.sent,
      emailFailed: emailResult.failed,
      emailSkipped: emailResult.skipped,
    };
  } catch (err) {
    // Log + return (no throw) so a transient failure doesn't trigger an
    // EventBridge retry storm. Next scheduled fire produces a fresh run.
    const error = err instanceof Error ? err.message : String(err);
    console.error('[proactive-briefing] Failed:', error);
    return { ok: false, emailSent: [], emailFailed: [], error };
  }
};
