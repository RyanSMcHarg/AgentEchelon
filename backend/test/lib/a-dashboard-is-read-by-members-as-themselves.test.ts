/**
 * A CONVERSATION'S DASHBOARD IS WRITTEN BY ITS ASSISTANT AS ITSELF AND READ BY ITS MEMBERS AS THEMSELVES
 * (DESIGN-CONVERSATION-DASHBOARDS).
 *
 * The refusals section 6 names, each where it is enforced: the session edge an assistant without the tool never holds,
 * the key a turn cannot choose, the member's single-conversation read, the role that reads only its own classification, the
 * link signed for members only, and a page that carries no script.
 */
import { createPublicKey, createVerify, generateKeyPairSync } from 'crypto';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { grantEdgesFor, type GrantCatalog } from '../../lambda/src/lib/assistant-grant';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { assistantGrantCatalog, dashboardRoles } from '../../lib/stacks/agent-classification-common';
import { exchangeVendStatements } from '../../lib/constructs/exchange-role';
import { dashboardPagesReadStatement } from '../../lib/constructs/dashboard-distribution';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { publishDashboard } from '../../lambda/src/lib/dashboard-tool';
import { DASHBOARD_PAGE_OBJECTS, dashboardKey, dashboardPageUrl, dashboardPrefix } from '../../lambda/src/lib/dashboard-keys';
import { renderDashboardFragment, renderDashboardPage, DASHBOARD_CSP } from '../../lambda/src/lib/dashboard-render';
import { dashboardObjectOf } from '../../lambda/src/credential-exchange';
import { signCannedUrl } from '../../lambda/src/dashboard-link';
import { toolListErrors } from '../../lambda/src/lib/step-fields';
import { DEFAULT_TASK_STATE_MACHINES, PLATFORM_MACHINE_KEYS } from '../../lambda/src/lib/task-state-machines';
import { SHIPPED_EVENT_WORKFLOWS, eventWorkflowErrors } from '../../lambda/src/lib/event-workflow';
import type { DashboardData } from '../../lambda/src/lib/dashboard-data';

const APP = 'arn:aws:chime:us-east-1:111111111111:app-instance/i';
const ROOM = `${APP}/channel/esc-1`;
const BUCKET_ARN = 'arn:aws:s3:::ae-attachments';

const catalog: GrantCatalog = { edges: new Set(['base', 'utility', 'context', 'platform', 'telemetry', 'dashboard', 'models-all']), alwaysModelKeys: [] } as unknown as GrantCatalog;

const labels = {
  title: 'Incident dashboard', updated: 'Updated 13:00 UTC', stateAlarm: 'In alarm', stateOk: 'OK', stateInsufficient: 'Insufficient data',
  threshold: 'Threshold', invocations: 'Invocations', errors: 'Errors', throttles: 'Throttles', durationMs: 'Average duration (ms)', related: 'Related metrics',
  noData: 'No data', unavailable: 'Could not be read', values: 'Values', time: 'Time (UTC)', stateUnread: 'State not read',
};
const data = (alarmName = 'router-errors'): DashboardData => ({
  readAt: '2026-11-08T13:00:00.000Z', windowMinutes: 180,
  alarm: { name: alarmName, state: 'ALARM', since: null, reason: '', metric: 'AWS/Lambda/Errors', threshold: 5 },
  series: [
    { key: 'alarmMetric', points: [{ t: '2026-11-08T12:50:00.000Z', v: 2 }, { t: '2026-11-08T12:55:00.000Z', v: 9 }] },
    { key: 'invocations', points: [{ t: '2026-11-08T12:55:00.000Z', v: 1200 }] },
    { key: 'errors', points: [] }, { key: 'throttles', points: [] }, { key: 'durationMs', points: [] },
  ],
});

describe('the assistant publishes as itself, and only where its version declares the tool', () => {
  it('a version that declares a dashboard tool selects the dashboard edge, which carries the telemetry it reads in place of a second', () => {
    const edges = grantEdgesFor({ tools: ['publish_dashboard', 'read_deployment_health'] } as never, undefined, catalog);
    expect(edges).toContain('dashboard');
    expect(edges).not.toContain('telemetry');
    expect(grantEdgesFor({ tools: ['publish_dashboard_page'] } as never, undefined, catalog)).toContain('dashboard');
  });

  it('DENY: a version that does not declare one holds no dashboard edge', () => {
    expect(grantEdgesFor({ tools: ['read_deployment_health'] } as never, undefined, catalog)).not.toContain('dashboard');
  });

  it('DENY: every session but the dashboard edge is refused the dashboards prefix, to read and to write', () => {
    const stack = new cdk.Stack(new cdk.App(), 'Grants', { env: { account: '111111111111', region: 'us-east-1' } });
    assistantGrantCatalog(stack, {
      classification: 'premium', modelCatalog: {} as never, classificationModelArns: ['arn:aws:bedrock:us-east-1::foundation-model/x'],
      contextRoutingArns: [], imageModelArns: {}, streaming: false,
    });
    const policies = Object.values(Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties: { ManagedPolicyName?: string; PolicyDocument: { Statement: Array<Record<string, unknown>> } } }>)
      .filter((r) => r.Type === 'AWS::IAM::ManagedPolicy');
    const base = policies.find((p) => String(p.Properties.ManagedPolicyName).endsWith('-base'))!.Properties.PolicyDocument.Statement;
    expect(base.find((s) => s.Sid === 'EverythingNoDefinitionFieldSelects')!.NotAction).toEqual(expect.arrayContaining(['s3:GetObject', 's3:PutObject']));
    expect(base.find((s) => s.Sid === 'ObjectsOutsideTheNarrowedPrefixes')!.NotResource).toContain('arn:aws:s3:::*/dashboards/*');
    expect(base.find((s) => s.Sid === 'WritesOutsideTheDashboards')!.NotResource).toEqual('arn:aws:s3:::*/dashboards/*');
    const edge = policies.find((p) => String(p.Properties.ManagedPolicyName).endsWith('-dashboard'))!.Properties.PolicyDocument.Statement;
    expect(edge).toEqual(expect.arrayContaining([expect.objectContaining({ Action: ['s3:GetObject', 's3:PutObject'], Resource: 'arn:aws:s3:::*/dashboards/*' })]));
    // The telemetry it draws from rides the same edge, and no other S3 reach does.
    expect(edge.filter((st) => JSON.stringify(st.Action).includes('s3:'))).toHaveLength(1);
  });

  it('only a role a dashboard tool is offered to may publish, under its own classification', () => {
    expect(dashboardRoles(['primary', 'ops'])).toEqual(['ops']);
    expect(dashboardPrefix('premium')).toBe('dashboards/premium/');
  });

  it('DENY: the key is the turn\'s own conversation; a classification or conversation id that is not one is refused', () => {
    expect(dashboardKey('premium', 'esc-1', 'snapshot')).toBe('dashboards/premium/esc-1/snapshot.json');
    expect(dashboardKey('premium', 'esc-1', 'page')).toBe('dashboards/premium/esc-1/page.html');
    expect(dashboardKey('premium', '../esc-2', 'snapshot')).toBeNull();
    expect(dashboardKey('Premium/../basic', 'esc-1', 'snapshot')).toBeNull();
  });

  it('writes the turn\'s conversation, posts one message, and updates it on the next publish', async () => {
    const puts: Array<{ Key: string; Metadata?: Record<string, string> }> = [];
    let stored: string | undefined;
    const s3 = { send: jest.fn(async (cmd: { constructor: { name: string }; input: { Key: string; Metadata?: Record<string, string> } }) => {
      if (cmd.constructor.name === 'HeadObjectCommand') { if (!stored) throw Object.assign(new Error('nf'), { name: 'NotFound' }); return { Metadata: { 'message-id': stored } }; }
      puts.push(cmd.input); if (cmd.input.Metadata?.['message-id']) stored = cmd.input.Metadata['message-id']; return {};
    }) };
    const sent: string[] = [];
    const messaging = { send: jest.fn(async (cmd: { constructor: { name: string } }) => { sent.push(cmd.constructor.name); return { MessageId: 'm-1' }; }) };
    const args = { mode: 'snapshot' as const, credentials: { accessKeyId: 'a', secretAccessKey: 'b' }, bucket: 'ae-attachments', channelArn: ROOM, classification: 'premium', botArn: `${APP}/bot/ops`, assistant: 'ops-premium' };
    const deps = { s3: s3 as never, messaging: messaging as never, read: async () => data(), now: () => Date.parse('2026-11-08T13:00:00Z') };
    expect(await publishDashboard(args, deps)).toMatchObject({ published: true, alarmState: 'ALARM' });
    expect(puts.every((p) => p.Key === 'dashboards/premium/esc-1/snapshot.json')).toBe(true);
    // THE CONVERSATION'S NAME IS READ AS THE ASSISTANT, for the dashboard's title, then the one message is posted, then updated.
    expect(sent).toEqual(['DescribeChannelCommand', 'SendChannelMessageCommand']);
    await publishDashboard(args, deps);
    expect(sent).toEqual(['DescribeChannelCommand', 'SendChannelMessageCommand', 'DescribeChannelCommand', 'UpdateChannelMessageCommand']);
  });

  it('DENY: a turn not acting as an assistant publishes nothing', async () => {
    const out = await publishDashboard({ mode: 'snapshot', credentials: null, bucket: 'b', channelArn: ROOM, classification: 'premium', botArn: 'x', assistant: 'a' }, { messaging: { send: jest.fn() } as never });
    expect(out).toMatchObject({ published: false });
  });
});

describe('each member reads it as themselves', () => {
  it('the member vend role reads the dashboards of each classification its token grants, and nothing else in S3', () => {
    const json = (s: { toJSON: () => unknown }) => JSON.stringify(s.toJSON());
    const premium = exchangeVendStatements(APP, 'premium', BUCKET_ARN).map(json).filter((s) => s.includes('s3:'));
    expect(premium).toEqual([expect.stringContaining(`${BUCKET_ARN}/dashboards/premium/*`)]);
    expect(premium[0]).toContain('"s3:GetObject"');
    expect(premium[0]).not.toContain('PutObject');
  });

  it('DENY: a basic vend role names no prefix of a classification its token does not grant', () => {
    expect(profiles.grantsFor('basic' as never)).not.toContain('premium');
    const s3Statements = exchangeVendStatements(APP, 'basic', BUCKET_ARN).map((s) => s.toJSON() as { Action: unknown; Resource: unknown }).filter((s) => JSON.stringify(s.Action).includes('s3:'));
    expect(s3Statements).toHaveLength(1);
    const resources = ([] as string[]).concat(s3Statements[0].Resource as string | string[]);
    expect(resources.sort()).toEqual(profiles.grantsFor('basic' as never).map((c) => `${BUCKET_ARN}/${dashboardPrefix(c)}*`).sort());
    expect(resources).not.toContain(`${BUCKET_ARN}/dashboards/premium/*`);
    expect(resources).not.toContain(`${BUCKET_ARN}/dashboards/*`);
  });

  it('DENY: the restricted role and a role given no bucket hold no S3 read', () => {
    const s3 = (token: 'restricted' | 'premium', bucket?: string) => exchangeVendStatements(APP, token, bucket).map((s) => JSON.stringify(s.toJSON())).filter((s) => s.includes('s3:'));
    expect(s3('restricted', BUCKET_ARN)).toEqual([]);
    expect(s3('premium')).toEqual([]);
  });

  it('DENY: a dashboard session reads exactly its conversation\'s snapshot, never the page or another conversation', () => {
    expect(dashboardObjectOf(BUCKET_ARN, 'premium', ROOM)).toEqual({ arn: `${BUCKET_ARN}/dashboards/premium/esc-1/snapshot.json`, bucket: 'ae-attachments', key: 'dashboards/premium/esc-1/snapshot.json' });
    expect(dashboardObjectOf(BUCKET_ARN, 'premium', `${APP}/channel/*`)).toBeNull();
    expect(dashboardObjectOf('', 'premium', ROOM)).toBeNull();
  });

  it('the exchange checks the caller is in the conversation before it vends a dashboard read', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../lambda/src/credential-exchange.ts'), 'utf8') as string;
    const at = src.indexOf('if (caps.includes(DASHBOARD_CAPABILITY))');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf('const sessionPolicy', at));
    expect(block).toMatch(/callerReachesConversation\(/);
    expect(block.indexOf('callerReachesConversation(')).toBeLessThan(block.indexOf('dashboardObjectOf('));
  });
});

describe('the hosted page', () => {
  it('DENY: the bucket lets CloudFront read only dashboard pages, for a distribution of this account', () => {
    const stack = new cdk.Stack(new cdk.App(), 'Bucket', { env: { account: '111111111111', region: 'us-east-1' } });
    const bucket = s3.Bucket.fromBucketArn(stack, 'Attachments', BUCKET_ARN);
    const statement = stack.resolve(dashboardPagesReadStatement(bucket, '111111111111').toStatementJson()) as { Action: unknown; Resource: unknown; Condition: unknown };
    expect(DASHBOARD_PAGE_OBJECTS).toBe('dashboards/*/page.html');
    expect(statement.Action).toBe('s3:GetObject');
    expect(statement.Resource).toBe(`${BUCKET_ARN}/dashboards/*/page.html`);
    expect(statement.Resource).not.toBe(`${BUCKET_ARN}/dashboards/*`);
    expect(statement.Condition).toEqual({
      StringEquals: { 'AWS:SourceAccount': '111111111111' },
      ArnLike: { 'AWS:SourceArn': 'arn:aws:cloudfront::111111111111:distribution/*' },
    });
  });

  it('signs one page for five minutes, verifiable with the distribution\'s public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const url = dashboardPageUrl('d1.cloudfront.net', 'premium', 'esc-1')!;
    expect(url).toBe('https://d1.cloudfront.net/dashboards/premium/esc-1/page.html');
    const signed = new URL(signCannedUrl(url, 1_900_000_000, 'K1', pem));
    const sig = signed.searchParams.get('Signature')!.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/');
    const policy = JSON.stringify({ Statement: [{ Resource: url, Condition: { DateLessThan: { 'AWS:EpochTime': 1_900_000_000 } } }] });
    expect(createVerify('RSA-SHA1').update(policy).verify(createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })), sig, 'base64')).toBe(true);
    expect(signed.searchParams.get('Key-Pair-Id')).toBe('K1');
  });

  it('DENY: a link names a dashboard page and nothing else', () => {
    expect(dashboardPageUrl('d1.cloudfront.net', 'premium', '../../x')).toBeNull();
    expect(dashboardPageUrl('', 'premium', 'esc-1')).toBeNull();
  });

  it('the link route refuses a caller the conversation check refuses, before it signs', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../lambda/src/dashboard-link.ts'), 'utf8') as string;
    expect(src.indexOf('callerReachesConversation(event, conversationId)')).toBeLessThan(src.indexOf('signCannedUrl(url,'));
    expect(src).toMatch(/if \(!access\.ok\) return reply\(access\.status/);
  });

  it('DENY: the page carries no script, and a value from data is escaped', () => {
    const page = renderDashboardPage(data('<script>alert(1)</script>'), labels);
    expect(page).not.toMatch(/<script/i);
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).toContain(DASHBOARD_CSP);
    expect(DASHBOARD_CSP).toMatch(/default-src 'none'/);
    expect(DASHBOARD_CSP).not.toMatch(/script-src/);
  });

  it('draws the alarm as a status with its label, the watched metric against its threshold, and a table of values', () => {
    const html = renderDashboardFragment(data(), labels);
    expect(html).toContain('In alarm');
    expect(html).toContain('Threshold 5');
    expect(html).toContain('<table>');
    expect(html).toContain('No data');
  });
});

describe('a workflow chooses it or requires it', () => {
  it('an agent step may list a dashboard tool beside its read tools, and still no other write', () => {
    const readOnly = { readOnly: 'read tools only', dashboardWrites: true };
    expect(toolListErrors(['read_deployment_health', 'publish_dashboard'], 'x.tools', readOnly)).toEqual([]);
    // DENY: a welcome grants no such exemption, so a dashboard tool is a write there.
    expect(toolListErrors(['publish_dashboard'], 'x.tools', { readOnly: 'a welcome may use read tools only' }).join(' ')).toMatch(/changes state/);
    expect(toolListErrors(['advance_task_state'], 'x.tools', readOnly).join(' ')).toMatch(/changes state/);
  });

  it('the incident watch requires a refresh, which the platform machine publishes on entry with no model deciding', () => {
    const machine = DEFAULT_TASK_STATE_MACHINES.dashboard_refresh;
    expect(PLATFORM_MACHINE_KEYS).toContain('dashboard_refresh');
    expect(machine.states[machine.initial]).toMatchObject({ action: { tool: 'publish_dashboard' }, onSuccess: 'published', onFailure: 'failed' });
    const watch = SHIPPED_EVENT_WORKFLOWS['incident-watch'];
    expect(watch.states.refresh.task).toMatchObject({ machine: 'dashboard_refresh', by: { assistantRole: 'ops' } });
    expect(eventWorkflowErrors('incident-watch', watch)).toEqual([]);
  });
});
