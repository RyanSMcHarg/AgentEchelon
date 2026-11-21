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
import { S3Client, PutObjectCommand, HeadObjectCommand, CopyObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { DescribeChannelCommand, UpdateChannelMessageCommand, type ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import { readDashboardData } from './dashboard-data.js';
import { renderDashboardFragment, renderDashboardPage, type DashboardLabels } from './dashboard-render.js';
import { templateLine, type VersionWords } from './message-lines.js';
import { botMessageMetadata } from './bot-message-attribution.js';
import { sendChannelMessage } from './chime/send.js';
import { conversationIdOf, dashboardKey, runbookKey, type DashboardMode } from './dashboard-keys.js';
import { toolOfferedToRole } from './tool-registry.js';
import { isRunbookProgress, runbookNow, runbookStanding, MAX_PINNED_PEOPLE, MAX_PINNED_TEXT, type RunbookProgress } from './runbook-progress.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

export const DASHBOARD_TOOL = 'publish_dashboard';
export const DASHBOARD_PAGE_TOOL = 'publish_dashboard_page';

/** The intent an assistant advertises to be given a run's runbook to draw (DESIGN-CONVERSATION-DASHBOARDS section 8.1). */
export const DASHBOARD_RUNBOOK_INTENT = 'dashboard_runbook';

/**
 * WHETHER AN ASSISTANT IS GIVEN A RUN'S RUNBOOK TO DRAW (section 8.1), from what it declares, with no model call: its role is
 * one the dashboard tool is offered to, its served version's tool allowlist is absent or lists the tool, and it advertises
 * the `dashboard_runbook` intent. `unadvertised` is the one refusal said aloud, once per run: the assistant could draw it
 * and has not consented.
 */
export function runbookConsent(args: {
  role: string;
  versionTools: readonly string[] | undefined;
  advertised: readonly string[];
}): 'consents' | 'no-tool' | 'unadvertised' {
  if (!toolOfferedToRole(DASHBOARD_TOOL, args.role)) return 'no-tool';
  if (args.versionTools && !args.versionTools.includes(DASHBOARD_TOOL)) return 'no-tool';
  return args.advertised.includes(DASHBOARD_RUNBOOK_INTENT) ? 'consents' : 'unadvertised';
}

/** Every word the dashboard shows, from the assistant's `dashboard` template. */
export function dashboardLabels(words: VersionWords | undefined, time: string, conversation = ''): DashboardLabels {
  const l = (section: string) => templateLine('dashboard', words, { section: `label.${section}`, values: { time, conversation } });
  return {
    // TITLED FOR ITS CONVERSATION, so a reader knows which incident the tab is; unnamed, it says what it is.
    title: l('title') || l('titleUnnamed'), about: l('about'), deployment: l('deployment'), updated: l('updated'), related: l('related'), stateAlarm: l('stateAlarm'), stateOk: l('stateOk'), stateInsufficient: l('stateInsufficient'),
    threshold: l('threshold'), invocations: l('invocations'), errors: l('errors'), throttles: l('throttles'), durationMs: l('durationMs'),
    noData: l('noData'), unavailable: l('unavailable'), values: l('values'), time: l('time'), stateUnread: l('stateUnread'),
    runbook: l('runbook'), runbookAbout: l('runbookAbout'), heldBy: l('heldBy'), openCard: l('openCard'),
    // A STEP'S TIMES, worded by the template with each step's own values.
    stepTimes: (started: string, settled?: string) => templateLine('dashboard', words, {
      section: settled ? 'label.stepTimes' : 'label.stepSince', values: { time, conversation, started, settled: settled ?? '' },
    }),
    status: {
      'not-started': l('statusNotStarted'), 'in-progress': l('statusInProgress'), waiting: l('statusWaiting'), done: l('statusDone'),
      skipped: l('statusSkipped'), 'timed-out': l('statusTimedOut'), failed: l('statusFailed'),
    },
  };
}

/** What a dashboard message carries, which the chat app reads to open it. References only, never the figures. */
export interface DashboardMessageMetadata {
  kind: DashboardMode;
  conversationId: string;
  classification: string;
  updatedAt: string;
  state?: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  /**
   * WHAT THE CONVERSATION PINS AT ITS TOP: the step its run is on now, and who holds its roles. Declared words
   * and members' names only, clipped, so the message stays within the service's Metadata limit.
   */
  now?: { label: string; status: string; holder?: string };
  people?: Array<{ role: string; name: string }>;
  /** Where the conversation stands, from its pinned step. */
  standing?: 'open' | 'resolved' | 'ended';
  /** Who may decide the pinned step and its choices now: the band offers them to those people (`decidedBy`). */
  decide?: { taskId: string; state: string; choices: string[]; by: string[]; reopen?: true };
}

export interface PublishDashboardDeps {
  s3?: S3Client;
  messaging: Pick<ChimeSDKMessagingClient, 'send'>;
  read?: typeof readDashboardData;
  now?: () => number;
}

/** The pinned step's decision as the message carries it: ids and declared state names, clipped to the Metadata limit. */
function decideOf(runbook: RunbookProgress | undefined): DashboardMessageMetadata['decide'] {
  const d = runbook?.decide;
  if (!d?.taskId || !d.state || !d.choices?.length || !d.by?.length) return undefined;
  return { taskId: d.taskId.slice(0, 128), state: d.state.slice(0, 64), choices: d.choices.slice(0, 4).map((c) => c.slice(0, 64)), by: d.by.slice(0, 16).map((p) => p.slice(0, 64)), ...(d.reopen ? { reopen: true as const } : {}) };
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
  /** The run's progress as the router read it (section 8), stored beside the dashboard unless a newer one already is. */
  runbook?: RunbookProgress;
  /** A refresh, not a publish: where this dashboard has not been published yet, nothing is drawn or posted. */
  onlyIfPublished?: boolean;
}, deps: PublishDashboardDeps): Promise<Record<string, unknown>> {
  const conversationId = conversationIdOf(args.channelArn);
  const key = dashboardKey(args.classification, conversationId, args.mode);
  if (!args.credentials || !args.bucket || !key || !args.botArn) {
    return { published: false, unavailable: 'This turn cannot publish a dashboard: it is not acting as an assistant that holds the dashboard tool here. Say so plainly.' };
  }
  const now = deps.now?.() ?? Date.now();
  const s3 = deps.s3 ?? new S3Client({ region: AWS_REGION, credentials: args.credentials });
  // THE RUNBOOK DRAWN IS THE NEWEST ONE READ: what this call carries where it is newer than the stored one, which it then
  // replaces, else the stored one, so a publish for the alarm keeps the runbook section and an older read never wins.
  const runbook = await currentRunbook(s3, args.bucket, runbookKey(args.classification, conversationId), args.runbook);
  // THE ONE MESSAGE, read from the object's own metadata, so a refresh updates it rather than posting another.
  const previous = await s3.send(new HeadObjectCommand({ Bucket: args.bucket, Key: key })).then((h) => h.Metadata?.['message-id']).catch(() => undefined);
  if (args.onlyIfPublished && !previous) return { published: false, reason: 'not-published' };
  const data = await (deps.read ?? readDashboardData)(args.credentials, { ...(args.watchedAlarm ? { watchedAlarm: args.watchedAlarm } : {}), now: () => now });
  if (!data) return { published: false, unavailable: 'The telemetry could not be read as this assistant. Say so plainly.' };
  const time = new Date(now).toISOString().slice(11, 16);
  // THE CONVERSATION'S NAME, read as the assistant, which is a member: the dashboard's title says which conversation it is.
  const conversation = await deps.messaging.send(new DescribeChannelCommand({ ChannelArn: args.channelArn, ChimeBearer: args.botArn }))
    .then((r) => (r as { Channel?: { Name?: string } }).Channel?.Name ?? '').catch(() => '');
  const labels = dashboardLabels(args.words, time, conversation);

  const state = data.alarm?.state;
  // NO ALARM READING IS SAID AS ONE, never as the dashboard's title standing in for a state.
  const stateWord = labels[state === 'ALARM' ? 'stateAlarm' : state === 'OK' ? 'stateOk' : state === 'INSUFFICIENT_DATA' ? 'stateInsufficient' : 'stateUnread'] || templateLine('dashboard', undefined, { section: 'label.stateUnread' });
  const onNow = runbookNow(runbook);
  const people = (runbook?.people ?? []).slice(0, MAX_PINNED_PEOPLE).map((p) => ({ role: p.role.slice(0, 40), name: p.name.slice(0, MAX_PINNED_TEXT) }));
  const metadata: DashboardMessageMetadata = {
    kind: args.mode, conversationId, classification: args.classification, updatedAt: data.readAt, ...(state ? { state } : {}),
    ...(onNow ? { now: onNow } : {}), ...(people.length ? { people } : {}),
    ...(runbookStanding(runbook) ? { standing: runbookStanding(runbook) } : {}),
    ...(decideOf(runbook) ? { decide: decideOf(runbook) } : {}),
  };
  const content = encodeURIComponent(templateLine('dashboard', args.words, { values: { state: stateWord, time } }));
  // A NOTIFICATION, NOT AN ANSWER: the client counts no reply from it and the archive no response, as for a workflow's sends.
  const messageMetadata = botMessageMetadata({ agentType: args.assistant, classification: args.classification, turnKind: 'notification' }, { dashboard: metadata });

  // WHAT A MEMBER READS: the rendered dashboard, and nothing the reader does not draw.
  const body = args.mode === 'snapshot'
    ? JSON.stringify({ version: 1, ...metadata, html: renderDashboardFragment(data, labels, args.language, { ...(runbook ? { runbook } : {}), linkConversation: conversationId }) })
    : renderDashboardPage(data, labels, args.language, runbook ? { runbook } : {});
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

/**
 * THE RUNBOOK TO DRAW, AND THE STORED ONE KEPT CURRENT. Never throws: a runbook that cannot be read or written leaves the
 * dashboard without its section, never without its telemetry.
 */
async function currentRunbook(s3: S3Client, bucket: string, key: string | null, given: RunbookProgress | undefined): Promise<RunbookProgress | undefined> {
  if (!key) return given;
  const stored = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    .then(async (o) => { const v: unknown = JSON.parse(await o.Body!.transformToString()); return isRunbookProgress(v) ? v : undefined; })
    .catch(() => undefined);
  if (!given || (stored && stored.asOf >= given.asOf)) return stored ?? given;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(given), ContentType: 'application/json', CacheControl: 'no-store' }))
    .catch((err) => console.warn('[dashboard] the runbook could not be stored', { err: (err as Error)?.name }));
  return given;
}

/**
 * A RUN'S STEP MOVED (section 8.1): each of the conversation's dashboards already published is drawn again with the runbook,
 * and its one message updated in place. Run as the declared action of the platform's quiet `dashboard_runbook` step, so no
 * model and no chat line; a conversation with no dashboard yet only has the runbook stored, which its first publish draws.
 */
export async function refreshDashboardRunbook(
  args: Omit<Parameters<typeof publishDashboard>[0], 'mode' | 'onlyIfPublished'> & { runbook: RunbookProgress; modes: DashboardMode[] },
  deps: PublishDashboardDeps,
): Promise<Array<Record<string, unknown>>> {
  // NOTHING THE SECTION SHOWS CHANGED, NOTHING IS DRAWN: a run claims several steps per move (a step, its going on, its end),
  // and redrawing for each updated the dashboard message every few seconds, which re-rendered every member's conversation.
  const key = runbookKey(args.classification, conversationIdOf(args.channelArn));
  if (key && args.credentials && args.bucket) {
    const s3 = deps.s3 ?? new S3Client({ region: AWS_REGION, credentials: args.credentials });
    const stored = await s3.send(new GetObjectCommand({ Bucket: args.bucket, Key: key }))
      .then(async (o) => { const v: unknown = JSON.parse(await o.Body!.transformToString()); return isRunbookProgress(v) ? v : undefined; })
      .catch(() => undefined);
    // AN OLDER READ NEVER DRAWS: two refreshes taken up out of order leave the newer one standing.
    if (stored && stored.asOf >= args.runbook.asOf) return [{ published: false, reason: 'not-newer' }];
    if (stored && stored.workflow === args.runbook.workflow && JSON.stringify(stored.steps) === JSON.stringify(args.runbook.steps)
      && JSON.stringify(stored.people ?? []) === JSON.stringify(args.runbook.people ?? [])
      && JSON.stringify(stored.decide ?? null) === JSON.stringify(args.runbook.decide ?? null)) {
      return [{ published: false, reason: 'unchanged' }];
    }
  }
  const out: Array<Record<string, unknown>> = [];
  for (const mode of args.modes) {
    out.push(await publishDashboard({ ...args, mode, onlyIfPublished: true }, deps).catch((err) => ({ published: false, error: (err as Error)?.name })));
  }
  return out;
}
