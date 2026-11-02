/**
 * Proactive Briefing — EventBridge-triggered proactive workflow.
 *
 * This is the "proactive" half of the Post-1 story (reactive = a user
 * asks; proactive = the system acts on a schedule with no human in the
 * loop). On an EventBridge schedule it:
 *
 *   1. creates a new conversation through the shared creator
 *      (`lib/channel-creation.ts`): the service admin creates it, the
 *      channel flow is attached, the primary assistant of the deployment's
 *      classification that declares `holdsBriefing` and the recipients are added, and the admin leaves,
 *   2. names the seed line to the router, which says it as the
 *      conversation's assistant: the briefing lives in the conversation,
 *   3. emails every member a link INTO that conversation, through the one
 *      fan-out (lib/channel-notify.ts `emailPeople`), which resolves each
 *      member's address by person at send time, honors their preferences
 *      (kind `briefing`) and words the mail in the assistant's own copy.
 *
 * THE LINK IS THE CONVERSATION, NOT A PRESIGNED PAGE. A presigned S3 URL is a
 * bearer credential: whoever holds the email holds the page for seven days,
 * forwarded or not. The conversation link opens nothing without the
 * recipient's own sign-in and membership.
 *
 * Scope: minimal-but-real (a genuine deployed EventBridge feature). NOT
 * hardened for idempotency/dedupe — a scheduled re-fire creates a fresh
 * briefing, which is the intended behavior for a periodic briefing.
 */
import { primaryAssignmentOf } from './lib/conversation-primary.js';
import { createConversationForBriefing } from './lib/channel-creation.js';
import { conversationNameFor } from './lib/conversation-name.js';
import { loadMessageTemplateSet } from './lib/message-template-selection.js';
import { resolveServiceAdminBearer } from './lib/service-admin-bearer.js';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { emailPeople } from './lib/channel-notify.js';
import { isPersonArn } from './lib/person-arn.js';
import { escapeHtml } from './lib/notification.js';
import { sayThroughRouter } from './lib/say-through-router.js';
import { emailLine, emailVoiceForRoom } from './lib/email-copy.js';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import { loadProfileRegistry } from '../../lib/profile-registry';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const CHANNEL_FLOW_ARN_PARAM = process.env.CHANNEL_FLOW_ARN_PARAM || '';
const APP_URL = process.env.APP_URL || 'http://localhost:5173';

const ssmClient = new SSMClient({ region: AWS_REGION });

/** A member to add to the briefing conversation and email. */
interface BriefingMember {
  userArn: string;
}

let cachedBotArn: string | null = null;
let cachedFlowArn: string | null = null;

async function getSsm(name: string): Promise<string> {
  const r = await ssmClient.send(new GetParameterCommand({ Name: name }));
  return r.Parameter?.Value || '';
}

/**
 * THE ROOM'S PRIMARY: the classification's primary assistant, from the assignment records
 * (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8). Not the `/assistant/{classification}/bot-arn` pointer.
 */
async function getBotArn(classification: string): Promise<string> {
  if (cachedBotArn) return cachedBotArn;
  const primary = await primaryAssignmentOf(classification);
  cachedBotArn = primary.botArn;
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
 * THE PEOPLE A BRIEFING IS FOR, from `BRIEFING_RECIPIENT_ARNS` (AppInstanceUser ARNs, comma-separated):
 * deployment configuration that names people, never their addresses. Anything that is not a person ARN
 * is dropped. Names come from the directory, for the page; addresses are resolved at send time.
 */
export function briefingRecipientArns(raw: string = process.env.BRIEFING_RECIPIENT_ARNS || ''): string[] {
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((arn) => isPersonArn(arn)))];
}

function loadMembers(): BriefingMember[] {
  return briefingRecipientArns().map((userArn) => ({ userArn }));
}

interface Briefing {
  generatedAt: string;
  triggerSource: string;
}

function buildBriefing(event: { source?: string; 'detail-type'?: string } | undefined): Briefing {
  const generatedAt = new Date().toISOString();
  const triggerSource = event?.source ? `${event.source} / ${event['detail-type'] ?? 'Scheduled'}` : 'EventBridge schedule';
  return { generatedAt, triggerSource };
}

export interface ProactiveBriefingResult {
  ok: boolean;
  conversationArn?: string;
  channelId?: string;
  emailSent: string[];
  emailFailed: Array<{ email: string; error: string }>;
  emailSkipped?: string;
  error?: string;
}

export const handler = async (
  event?: { source?: string; 'detail-type'?: string },
): Promise<ProactiveBriefingResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const members = loadMembers();
  if (members.length === 0) {
    console.warn('[proactive-briefing] No BRIEFING_RECIPIENT_ARNS configured — nothing to do.');
    return { ok: true, emailSent: [], emailFailed: [] };
  }

  // THE CLASSIFICATION IS THE ONE THE DEPLOYMENT DECLARES `holdsBriefing` ON, never a name assumed here. A
  // deployment that declares none, or one this registry does not hold as a conversational classification,
  // creates nothing.
  const classification = defaultProfileRegistry.briefingClassification();
  if (!classification || !defaultProfileRegistry.isConversational(classification)) {
    console.error('[proactive-briefing] no conversational classification of this deployment declares holdsBriefing; nothing is created', { classification });
    return { ok: false, emailSent: [], emailFailed: [], error: 'no briefing classification is declared' };
  }

  try {
    const botArn = await getBotArn(classification);
    if (!botArn) throw new Error('Bot ARN not resolvable from SSM');

    const briefing = buildBriefing(event);
    const channelId = `conv-proactive-${Date.now()}`;

    // 1-3. Created through the shared creator, as the service admin, as every conversation is
    //    (`lib/channel-creation.ts`). The flow is attached before the assistant is a member, so its
    //    welcome passes through the flow. The room is held at the briefing classification (the tag the
    //    fail-closed Layer 1 IAM keys on), its primary is that classification's primary assistant, and it is the ordinary
    //    `general` type: the registry has no briefing type. Every recipient is added as a member and
    //    none as a moderator; one that cannot be added is logged and does not stop the run. With no
    //    service admin nothing is created (`NoServiceAdminError`): a conversation is never created as
    //    an assistant.
    // THE ROOM'S NAME IS WORDED BY THE CLASSIFICATION'S STORED TEMPLATES, read beside the other two, so a console edit of
    // `conversation-name` names the next briefing. A store that cannot be read leaves the shipped wording.
    const [flowArn, serviceAdmin, templates] = await Promise.all([
      getFlowArn(),
      resolveServiceAdminBearer(),
      loadMessageTemplateSet({ classification }).catch((err) => {
        console.warn('[proactive-briefing] the name templates could not be read; the shipped wording names the room', { err: (err as Error)?.name });
        return undefined;
      }),
    ]);
    const { channelArn: conversationArn } = await createConversationForBriefing({
      appInstanceArn: APP_INSTANCE_ARN,
      botArn,
      memberArns: members.map((m) => m.userArn),
      classification,
      channelId,
      // NAMED FOR WHAT IT IS AND WHEN (`conversation-name.ts`): the `conversation-name` template's `label.briefing` section,
      // with the date in ISO form, which reads the same in every language. The email's subject is the assistant's.
      title: conversationNameFor({ kind: 'briefing', values: { date: briefing.generatedAt.slice(0, 10) }, ...(templates ? { words: { templates } } : {}) }),
      metadataExtras: {
        createdViaProactive: true,
        generatedAt: briefing.generatedAt,
        triggerSource: briefing.triggerSource,
      },
      channelFlowArn: flowArn || undefined,
      creatorBearerArn: serviceAdmin,
    });

    // 4. Seed the conversation. NAMED, NOT SAID: the conversation's assistant says it through the router of
    //    the classification this conversation was created at (above), in its own copy. This function speaks
    //    as no assistant.
    await sayThroughRouter(classification, { kind: 'briefingReady', channelArn: conversationArn, botArn, to: [], vars: { source: briefing.triggerSource } });

    // 5. Email every member a link into the conversation, through the one fan-out, in the words of the
    //    conversation's assistant.
    const voice = await emailVoiceForRoom(conversationArn);
    const bodyText = voice.copy.briefingBody;
    const emailResult = await emailPeople({
      personArns: members.map((m) => m.userArn),
      kind: 'briefing',
      subject: emailLine(voice, 'briefingSubject', { date: briefing.generatedAt.slice(0, 10) }),
      bodyText,
      bodyHtml: `<p>${escapeHtml(bodyText)}</p>`,
      conversationId: channelId,
      channelArn: conversationArn,
      voice,
      appUrl: APP_URL,
    });

    console.log('[proactive-briefing] Done', {
      conversationArn,
      sent: emailResult.emailed.length,
      skipped: emailResult.skipped.length,
      failed: emailResult.failed.length,
    });

    return {
      ok: true,
      conversationArn,
      channelId,
      emailSent: emailResult.emailed,
      emailFailed: emailResult.failed.map((email) => ({ email, error: 'send failed' })),
      ...(emailResult.notSentBecause ? { emailSkipped: emailResult.notSentBecause } : {}),
    };
  } catch (err) {
    // Log + return (no throw) so a transient failure doesn't trigger an
    // EventBridge retry storm. Next scheduled fire produces a fresh run.
    const error = err instanceof Error ? err.message : String(err);
    console.error('[proactive-briefing] Failed:', error);
    return { ok: false, emailSent: [], emailFailed: [], error };
  }
};
