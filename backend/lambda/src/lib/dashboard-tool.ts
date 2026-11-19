/**
 * PUBLISH A CONVERSATION'S DASHBOARD (DESIGN-CONVERSATION-DASHBOARDS section 4), as the assistant whose version declares
 * the tool.
 *
 * Two tools, one publisher. `publish_dashboard` writes `snapshot.json`, which the chat app reads with each member's own
 * credential; `publish_dashboard_page` writes `page.html`, which the dashboard distribution serves on a signed URL. Both
 * read the telemetry as the assistant, render through the platform renderer, and keep ONE dashboard message in the
 * conversation, updated in place, so members' clients read again on the update event and nothing polls.
 *
 * IT WRITES ONLY ITS OWN CONVERSATION. The key is built here from the turn's channel and classification, never from the
 * model's input, and the session's `dashboard` edge allows only `dashboards/<its classification>/`, so a turn cannot
 * write another conversation's dashboard even by asking.
 */
import { S3Client, PutObjectCommand, HeadObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { DescribeChannelCommand, UpdateChannelMessageCommand, type ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import { readDashboardData } from './dashboard-data.js';
import { renderDashboardFragment, renderDashboardPage, type DashboardLabels } from './dashboard-render.js';
import { templateLine, type VersionWords } from './message-lines.js';
import { botMessageMetadata } from './bot-message-attribution.js';
import { sendChannelMessage } from './chime/send.js';
import { conversationIdOf, dashboardKey, type DashboardMode } from './dashboard-keys.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

export const DASHBOARD_TOOL = 'publish_dashboard';
export const DASHBOARD_PAGE_TOOL = 'publish_dashboard_page';

/** Every word the dashboard shows, from the assistant's `dashboard` template. */
export function dashboardLabels(words: VersionWords | undefined, time: string, conversation = ''): DashboardLabels {
  const l = (section: string) => templateLine('dashboard', words, { section: `label.${section}`, values: { time, conversation } });
  return {
    // TITLED FOR ITS CONVERSATION, so a reader knows which incident the tab is; unnamed, it says what it is.
    title: l('title') || l('titleUnnamed'), about: l('about'), deployment: l('deployment'), updated: l('updated'), related: l('related'), stateAlarm: l('stateAlarm'), stateOk: l('stateOk'), stateInsufficient: l('stateInsufficient'),
    threshold: l('threshold'), invocations: l('invocations'), errors: l('errors'), throttles: l('throttles'), durationMs: l('durationMs'),
    noData: l('noData'), unavailable: l('unavailable'), values: l('values'), time: l('time'), stateUnread: l('stateUnread'),
  };
}

/** What a dashboard message carries, which the chat app reads to open it. References only, never the figures. */
export interface DashboardMessageMetadata {
  kind: DashboardMode;
  conversationId: string;
  classification: string;
  updatedAt: string;
  state?: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
}

export interface PublishDashboardDeps {
  s3?: S3Client;
  messaging: Pick<ChimeSDKMessagingClient, 'send'>;
  read?: typeof readDashboardData;
  now?: () => number;
}

export async function publishDashboard(args: {
  mode: DashboardMode;
  credentials: AwsCredentialIdentity | null;
  bucket: string;
  channelArn: string;
  classification: string;
  botArn: string;
  assistant: string;
  watchedAlarm?: string;
  words?: VersionWords;
  /** The conversation's language, which the page is tagged with and its numbers are written in. */
  language?: string;
}, deps: PublishDashboardDeps): Promise<Record<string, unknown>> {
  const conversationId = conversationIdOf(args.channelArn);
  const key = dashboardKey(args.classification, conversationId, args.mode);
  if (!args.credentials || !args.bucket || !key || !args.botArn) {
    return { published: false, unavailable: 'This turn cannot publish a dashboard: it is not acting as an assistant that holds the dashboard tool here. Say so plainly.' };
  }
  const now = deps.now?.() ?? Date.now();
  const s3 = deps.s3 ?? new S3Client({ region: AWS_REGION, credentials: args.credentials });
  // THE ONE MESSAGE, read from the object's own metadata, so a refresh updates it rather than posting another. Read beside the
  // telemetry, which it does not depend on.
  const [data, previous] = await Promise.all([
    (deps.read ?? readDashboardData)(args.credentials, { ...(args.watchedAlarm ? { watchedAlarm: args.watchedAlarm } : {}), now: () => now }),
    s3.send(new HeadObjectCommand({ Bucket: args.bucket, Key: key })).then((h) => h.Metadata?.['message-id']).catch(() => undefined),
  ]);
  if (!data) return { published: false, unavailable: 'The telemetry could not be read as this assistant. Say so plainly.' };
  const time = new Date(now).toISOString().slice(11, 16);
  // THE CONVERSATION'S NAME, read as the assistant, which is a member: the dashboard's title says which conversation it is.
  const conversation = await deps.messaging.send(new DescribeChannelCommand({ ChannelArn: args.channelArn, ChimeBearer: args.botArn }))
    .then((r) => (r as { Channel?: { Name?: string } }).Channel?.Name ?? '').catch(() => '');
  const labels = dashboardLabels(args.words, time, conversation);

  const state = data.alarm?.state;
  // NO ALARM READING IS SAID AS ONE, never as the dashboard's title standing in for a state.
  const stateWord = labels[state === 'ALARM' ? 'stateAlarm' : state === 'OK' ? 'stateOk' : state === 'INSUFFICIENT_DATA' ? 'stateInsufficient' : 'stateUnread'] || templateLine('dashboard', undefined, { section: 'label.stateUnread' });
  const metadata: DashboardMessageMetadata = {
    kind: args.mode, conversationId, classification: args.classification, updatedAt: data.readAt, ...(state ? { state } : {}),
  };
  const content = encodeURIComponent(templateLine('dashboard', args.words, { values: { state: stateWord, time } }));
  // A NOTIFICATION, NOT AN ANSWER: the client counts no reply from it and the archive no response, as for a workflow's sends.
  const messageMetadata = botMessageMetadata({ agentType: args.assistant, classification: args.classification, turnKind: 'notification' }, { dashboard: metadata });

  // WHAT A MEMBER READS: the rendered dashboard, and nothing the reader does not draw.
  const body = args.mode === 'snapshot'
    ? JSON.stringify({ version: 1, ...metadata, html: renderDashboardFragment(data, labels, args.language) })
    : renderDashboardPage(data, labels, args.language);
  const contentType = args.mode === 'snapshot' ? 'application/json' : 'text/html; charset=utf-8';
  // WRITTEN BEFORE THE MESSAGE IS POSTED OR UPDATED, so a member whose client reads on that message finds this dashboard there.
  await s3.send(new PutObjectCommand({
    Bucket: args.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'no-store',
    ...(previous ? { Metadata: { 'message-id': previous } } : {}),
  }));
  let messageId = previous;
  if (messageId) {
    const updated = await deps.messaging.send(new UpdateChannelMessageCommand({
      ChannelArn: args.channelArn, MessageId: messageId, Content: content, Metadata: messageMetadata, ChimeBearer: args.botArn,
    })).then(() => true).catch(() => false);
    if (!updated) messageId = undefined;
  }
  if (!messageId) {
    const posted = await sendChannelMessage(deps.messaging as ChimeSDKMessagingClient, {
      ChannelArn: args.channelArn, Content: content, Metadata: messageMetadata, ChimeBearer: args.botArn,
    });
    messageId = posted.MessageId;
    // THE MESSAGE IT IS SHOWN IN, attached in place by a copy that replaces only the object's metadata, never by writing the
    // body again.
    if (messageId) {
      await s3.send(new CopyObjectCommand({
        Bucket: args.bucket, Key: key, CopySource: `${args.bucket}/${key}`, MetadataDirective: 'REPLACE',
        Metadata: { 'message-id': messageId }, ContentType: contentType, CacheControl: 'no-store',
      }));
    }
  }
  return { published: true, kind: args.mode, updatedAt: data.readAt, ...(state ? { alarmState: state } : {}), ...(data.metricsUnavailable ? { metricsUnavailable: true } : {}) };
}
