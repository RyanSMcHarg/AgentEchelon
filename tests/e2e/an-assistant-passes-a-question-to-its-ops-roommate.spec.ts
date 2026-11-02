import { test, expect } from './helpers/fixtures';
import { Page } from '@playwright/test';
import { signIn, looksLikeTaskPlaceholder, idTokenOf } from './helpers/agent-helpers';
import { getOpsLeadUser, getAdminUser, missingUserReason } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { messageRowsVisibleTo, type VisibleMessage } from './helpers/third-party-view';
import { personArnOf } from './helpers/person';
import { assertNotAnErrorReply } from './helpers/drift-backend';
import { awsOrNull } from './helpers/assistant-acting-role';
import { SSM_ROOT, physicalIdsInClassificationStacks } from './helpers/stack-prefix';
import { awsOrNull as aws } from './helpers/aws';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';

guardBackendErrors('ops-roommate');
guardConsoleErrors();

/**
 * AN ASSISTANT PASSES A QUESTION THAT IS ITS ROOMMATE'S, AND KEEPS ONE THAT IS ITS OWN.
 *
 * Act 3.3 of the new-assistant demo, as a test. An `ops` conversation has two assistants of one
 * classification: Advisor (the premium primary) and Ops (the ops role, which alone reads this
 * deployment's CloudWatch telemetry). Asked a telemetry question by name, Advisor must say the
 * question is Ops's and hand it over, and Ops must then answer it - nobody adds Ops to anything and
 * nobody asks twice. Asked a business question, Advisor answers itself and Ops stays out.
 *
 * WHY BOTH HALVES. "Ops answered" alone cannot tell a handoff from Advisor deflecting everything; the
 * control is what proves the primary is routing on the question rather than shrugging.
 *
 * Setup goes through the platform's own creator: an `ops-team` room the platform opens, then an `ops`
 * room an event opens concerning it, named for the ops lead. The lead is a provisioned test user who is
 * premium-cleared and in the `ops` membership group, so the creator admits them. Sent as that user,
 * through the chat app, the standard way every e2e turn is sent. What happened is read from the
 * service, not from the DOM, so a dropped socket cannot pass for an assistant that stayed quiet.
 */

function appInstanceArn(): string | null {
  const adminArn = aws(`ssm get-parameter --name "${SSM_ROOT}/app-instance-admin-arn" --query "Parameter.Value"`);
  return typeof adminArn === 'string' && adminArn.includes('/user/') ? adminArn.split('/user/')[0] : null;
}

/** The premium typed-conversation creator, found by name: it exists only where a type names premium. */
function creatorFunction(): string | null {
  try {
    // Read from the classification stacks, not matched on the generated name: see helpers/stack-prefix.ts.
    const [name] = physicalIdsInClassificationStacks({ type: 'AWS::Lambda::Function', logicalId: /^TypedConversationFromEvent/ });
    return name || null;
  } catch {
    return null;
  }
}

/** Invoke the creator with a payload, through a file so the shell never sees the JSON. */
function create(fn: string, payload: Record<string, unknown>): { ok: boolean; channelArn?: string; error?: string } {
  const dir = require('os').tmpdir();
  const inFile = require('path').join(dir, `ops-roommate-in-${Date.now()}.json`);
  const outFile = require('path').join(dir, `ops-roommate-out-${Date.now()}.json`);
  require('fs').writeFileSync(inFile, JSON.stringify(payload));
  aws(`lambda invoke --function-name ${fn} --cli-binary-format raw-in-base64-out --payload fileb://${inFile} ${outFile}`);
  try {
    return JSON.parse(require('fs').readFileSync(outFile, 'utf8'));
  } catch {
    return { ok: false, error: 'no response from the creator' };
  }
}

/** The room's assistants by display name, read from the membership. */
function assistantsIn(channelArn: string, asArn: string): Record<string, string> {
  const r = aws(`chime-sdk-messaging list-channel-memberships --channel-arn ${channelArn} --chime-bearer ${asArn}`);
  const out: Record<string, string> = {};
  for (const m of r?.ChannelMemberships || []) {
    const arn = String(m?.Member?.Arn || '');
    if (arn.includes('/bot/')) out[String(m?.Member?.Name || '')] = arn;
  }
  return out;
}

async function openConversationById(page: Page, channelId: string) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.goto(`/?conversation=${channelId}`);
    await page.waitForLoadState('networkidle');
    try {
      await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 10000 });
      return;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(3000);
    }
  }
  throw new Error(`openConversationById: ${channelId} never became selectable. Last error: ${lastErr}`);
}

/** Address an assistant by name through the mention picker, then type the question and send. */
async function ask(page: Page, assistantName: string, question: string) {
  const clear = page.locator('.message-input-sticky-target-clear');
  if (await clear.isVisible({ timeout: 1000 }).catch(() => false)) await clear.click();
  await page.locator('.message-textarea').fill('@');
  const option = page.locator('.mention-option', {
    has: page.locator('.mention-option-name', { hasText: assistantName }),
  }).first();
  await expect(option).toBeVisible({ timeout: 10000 });
  await option.click();
  await page.locator('.message-textarea').press('End');
  await page.locator('.message-textarea').pressSequentially(` ${question}`);
  await page.keyboard.press('Enter');
}

/** The words a person reads: the hidden turn markers stripped. */
const visible = (content: string) => content.replace(/<!--[\s\S]*?-->/g, '').trim();

/**
 * Assistant messages created after `since`, oldest first.
 *
 * An answer is posted as a progress placeholder ("One moment...") and then updated to the finished text,
 * so a check on the raw row passes on the placeholder - whose hidden markers alone clear any length bar.
 * `settled` is the reader's text with the markers stripped, and a placeholder never counts as settled.
 */
function repliesSince(channelArn: string, asArn: string, since: number): Array<VisibleMessage & { settled: string }> {
  return messageRowsVisibleTo(channelArn, asArn)
    .filter((m) => m.senderArn.includes('/bot/') && Date.parse(m.createdAt) >= since)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((m) => {
      const text = visible(m.content);
      return { ...m, settled: looksLikeTaskPlaceholder(text) ? '' : text };
    });
}

test.describe.serial('an assistant passes a question to its ops roommate', () => {
  let page: Page;
  let leadArn = '';
  let opsRoom = '';
  let advisorArn = '';
  let opsArn = '';

  test.beforeAll(async ({ browser }) => {
    const lead = await getOpsLeadUser();
    test.skip(!lead, missingUserReason('opsLeadUser'));
    const app = appInstanceArn();
    const fn = creatorFunction();
    test.skip(!app || !fn, 'no premium typed-conversation creator on this deployment (no type names premium)');
    // SKIPPED BY NAME when the ops role is not deployed (no `ops-premium` in `profiles`), as the ops-reach spec does:
    // a deployment without the role and one whose role is broken must not look the same in a run summary.
    const opsLive = awsOrNull(`ssm get-parameter --name ${SSM_ROOT}/assistant-assignments/premium/ops/assistants/ops-premium --query Parameter.Value`);
    test.skip(!opsLive, 'premium has no ops assistant on this deployment; declare it with npm run add-assistant-role (ops-premium in profiles)');

    leadArn = await personArnOf(lead!);
    expect(leadArn, 'the ops lead has no AppInstanceUser').toContain('/user/');

    // The room an ops event concerns: the team's standing room, opened by the platform.
    const team = create(fn!, { conversationType: 'ops-team', forUserArn: leadArn, topicLabel: 'e2e ops team' });
    expect(team.ok, `ops-team creation refused: ${team.error}`).toBe(true);
    // The incident room, opened by an event concerning it and named for the lead.
    const incident = create(fn!, {
      detail: {
        conversationType: 'ops',
        concernedChannelArn: team.channelArn,
        forUserArn: leadArn,
        topicLabel: 'e2e report latency',
        summary: 'Report generation is running slow.',
      },
    });
    expect(incident.ok, `ops creation refused: ${incident.error}`).toBe(true);
    opsRoom = incident.channelArn!;

    const bots = assistantsIn(opsRoom, leadArn);
    advisorArn = bots.Advisor || '';
    opsArn = bots.Ops || '';
    expect({ advisor: !!advisorArn, ops: !!opsArn }, 'the ops room should have Advisor and Ops').toEqual({ advisor: true, ops: true });

    page = await (await browser.newContext()).newPage();
    await signIn(page, lead!.email, lead!.password);
    await openConversationById(page, opsRoom.split('/').pop()!);
    // Let the two welcomes land, so they are not read as replies to the first question.
    await expect.poll(() => repliesSince(opsRoom, leadArn, 0).length, { timeout: 60000 }).toBeGreaterThanOrEqual(2);
  });

  test('a telemetry question for Advisor is acknowledged by Advisor, then answered by Ops', async () => {
    const since = Date.now() - 2000;
    await ask(page, 'Advisor', 'are there any lambda throttles in the last hour?');

    // Advisor speaks first and says the question is Ops's; Ops answers after it.
    await expect.poll(() => {
      const replies = repliesSince(opsRoom, leadArn, since);
      const ack = replies.find((m) => m.senderArn === advisorArn);
      const answer = replies.find((m) => m.senderArn === opsArn && (!ack || Date.parse(m.createdAt) >= Date.parse(ack.createdAt)));
      return { ack: !!ack, answer: !!answer && answer.settled.length > 20 };
    }, { timeout: 120000, intervals: [3000] }).toEqual({ ack: true, answer: true });

    const replies = repliesSince(opsRoom, leadArn, since);
    const ack = replies.find((m) => m.senderArn === advisorArn)!;
    const answer = replies.find((m) => m.senderArn === opsArn)!;
    console.log(`Advisor: ${ack.settled.slice(0, 160)}`);
    console.log(`Ops:     ${answer.settled.slice(0, 300)}`);
    // The acknowledgement names the roommate, so the person knows who will answer.
    expect(ack.settled).toMatch(/\bOps\b/);
    assertNotAnErrorReply(answer.settled, 'Ops answer to a telemetry question');
    // An answer about throttles from the telemetry it reads, not a refusal or a deflection back.
    expect(answer.settled).toMatch(/throttl/i);
  });

  test('a business question for Advisor is answered by Advisor, and Ops stays out', async () => {
    const since = Date.now() - 2000;
    await ask(page, 'Advisor', 'what is our current ARR?');

    await expect.poll(() => repliesSince(opsRoom, leadArn, since).some((m) => m.senderArn === advisorArn && m.settled.length > 20),
      { timeout: 120000, intervals: [3000] }).toBe(true);
    // Give a wrongly routed Ops turn time to land before asserting it did not.
    await page.waitForTimeout(15000);
    const replies = repliesSince(opsRoom, leadArn, since);
    const advisorReply = replies.find((m) => m.senderArn === advisorArn && m.settled.length > 20)!;
    console.log(`Advisor: ${advisorReply.settled.slice(0, 200)}`);
    assertNotAnErrorReply(advisorReply.settled, 'Advisor answer to its own question');
    expect(advisorReply.settled, 'Advisor should answer, not hand its own question over').not.toMatch(/passed it along/i);
    expect(replies.filter((m) => m.senderArn === opsArn), 'Ops must not answer a question that is Advisor\'s own').toEqual([]);
  });

  test('the handover is counted in analytics: sent to Ops, and answered by Ops', async ({ browser }) => {
    // Read through the SIGNED admin path, as the console does. A handover is an archived message, so this
    // waits out archival lag rather than asserting the instant the answer lands.
    const analyticsApi = ADMIN_API_URL ? adminUrl('analytics', '/') : '';
    const adminBaseUrl = process.env.E2E_ADMIN_BASE_URL || '';
    const admin = await getAdminUser();
    test.skip(!analyticsApi || !adminBaseUrl || !admin?.password, 'needs the analytics API, the admin console and the admin user');

    const adminCtx = await browser.newContext({ baseURL: adminBaseUrl });
    const adminPage = await adminCtx.newPage();
    let idToken = '';
    try {
      await signIn(adminPage, admin.email, admin.password);
      idToken = await idTokenOf(adminPage);
    } finally {
      await adminCtx.close();
    }
    expect(idToken, 'admin idToken for the analytics read').toBeTruthy();

    const opsId = opsArn.split('/').pop();
    const counts = async () => {
      const end = new Date();
      const j = await signedAnalyticsPost(analyticsApi, idToken, {
        queryType: 'handovers',
        dateRange: { start: new Date(end.getTime() - 86_400_000).toISOString(), end: end.toISOString() },
      });
      // An error body has no data; reading it as zero would turn an authorization failure into a finding.
      if (!Array.isArray(j?.data)) throw new Error(`handovers returned no result set: ${JSON.stringify(j).slice(0, 300)}`);
      const rows = j.data.filter((r: any) => r.receiver === opsId);
      return {
        sent: rows.reduce((n: number, r: any) => n + Number(r.sent_count), 0),
        answered: rows.reduce((n: number, r: any) => n + Number(r.answered_count), 0),
      };
    };
    await expect.poll(async () => {
      const c = await counts();
      return c.sent >= 1 && c.answered >= 1 && c.answered <= c.sent;
    }, { timeout: 300000, intervals: [15000] }).toBe(true);
    console.log('handovers to Ops in the last day:', await counts());
  });
});
