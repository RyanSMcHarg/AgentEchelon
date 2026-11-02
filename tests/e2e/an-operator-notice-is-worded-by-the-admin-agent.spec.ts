/**
 * AN OPERATOR NOTICE IS SAID FROM THE ADMIN AGENT'S OWN TEMPLATE BEFORE THE SHIPPED ONE (ADR-062 decision 6, slice 3,
 * "the admin channel's operator notices are the admin agent's templates"), against the deployed stacks.
 *
 * The unit suite proves the selection and the words with the code's own functions
 * (`the-operator-notices-are-the-admin-agents-templates`). What only a deployment proves is the path end to end:
 *  - a CloudWatch alarm changing state reaches the one alarm notifier through an SNS topic it subscribes to, and the
 *    notifier raises the notice by name (`cloudwatch-alarm`) with its values;
 *  - the admin alert poster reads the admin agent's own `cloudwatch-alarm` from
 *    `templates/admin/_assistants/admin-agent/` under the role that reads that one family, and posts the notice into the
 *    admin notification channel as the admin agent, in the admin agent's words rather than the shipped ones.
 *
 * THE RUN OWNS WHAT IT CHANGES. It saves the admin agent a `cloudwatch-alarm` template that is the shipped one with a
 * first line of its own, the way an operator does (`npm run template -- put admin <file> --assistant admin-agent
 * --activate`), and creates one alarm with this deployment's name prefix, no data and missing data ignored, whose action
 * is an alarm notifier's topic. Afterwards the alarm is deleted and the template's pointer is put back as it was.
 *
 * GATED by ADMIN_ALERT_E2E=1 (validate.mjs --only=notifications), because it posts a real notice into the admin channel.
 * Every other gate names the dependency that is absent.
 *
 * **Coverage:** `e2e/an-operator-notice-is-worded-by-the-admin-agent.spec.ts`
 */
import { test, expect, expectAlarm } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { pollFor } from './helpers/task-backend';
import { awsv, awsvText } from './helpers/aws';
import { SSM_ROOT, STACK_PREFIX, physicalIdsInClassificationStacks } from './helpers/stack-prefix';
import { attachmentsBucket } from './helpers/delivered-template';
import { assistantTemplatePointer, putAssistantTemplate, readPointer, restorePointer } from './helpers/template-pointer';
import { roomMessagesSeenBy, type RoomMessage } from './helpers/event-run-messages';
import { ADMIN_NOTICE_ASSISTANT, ADMIN_NOTICE_CLASSIFICATION, shippedAdminNotices } from '../../backend/lambda/src/lib/admin-notice-templates';

const RUN = process.env.ADMIN_ALERT_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NOTICE = 'cloudwatch-alarm';
const STAMP = Date.now().toString(36);
/** The admin agent's own first line, which the shipped template does not say. */
const WORDING = `Worded by the admin agent (${STAMP}).`;
/** Named with this deployment's stack prefix and owned by this run alone. */
const ALARM = `${STACK_PREFIX}-e2e-admin-notice-${STAMP}`;
/** A template pointer is reused for 30 seconds (`TEMPLATE_POINTER_TTL_MS`). */
const POINTER_TTL_MS = 35_000;

function ssmValue(name: string): string {
  try {
    const v = awsvText(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text'], { quiet: true }).trim();
    return v === 'None' ? '' : v;
  } catch {
    return '';
  }
}

test.describe.serial('an operator notice is worded by the admin assistant (notifications)', () => {
  guardBackendErrors('an-operator-notice-is-worded-by-the-admin-agent');

  let channelArn = '';
  let agentBot = '';
  let serviceAdmin = '';
  let topicArn = '';
  let pointerParam = '';
  let pointerBefore: string | null = null;
  let templateSaved = false;
  let alarmMade = false;

  test.beforeAll(async () => {
    test.skip(!RUN, 'posts a real operator notice into the admin channel; set ADMIN_ALERT_E2E=1 (validate.mjs --only=notifications)');
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    channelArn = ssmValue(`${SSM_ROOT}/admin-notification/channel-arn`);
    test.skip(!channelArn, `${SSM_ROOT}/admin-notification/channel-arn is not published: admin is not a declared capability, so notices are log-only by design`);
    agentBot = ssmValue(`${SSM_ROOT}/assistant/admin-agent/bot-arn`);
    serviceAdmin = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`);
    expect(agentBot, 'the admin channel is enabled, so the admin agent\'s bot ARN must be published').toContain('/bot/');
    expect(serviceAdmin, `${SSM_ROOT}/app-instance-admin-arn is not published`).toContain('/user/');
    expect(attachmentsBucket(), 'the Conversations stack publishes no AttachmentsBucketName, where templates are stored').toBeTruthy();

    // AN ALARM NOTIFIER'S TOPIC: every classification stack subscribes the one notifier to its own alarm topics.
    try {
      topicArn = physicalIdsInClassificationStacks({ type: 'AWS::SNS::Topic', logicalId: /^(EventDeadlineAlarmTopic|ContextSourceAlarmTopic)/ })[0] || '';
    } catch {
      topicArn = '';
    }
    test.skip(!topicArn, 'no classification stack builds an alarm topic the notifier subscribes to (no invitation deadlines and no context source alarm)');
    pointerParam = assistantTemplatePointer(ADMIN_NOTICE_CLASSIFICATION, ADMIN_NOTICE_ASSISTANT, NOTICE);
    pointerBefore = readPointer(pointerParam);
  });

  test.afterAll(async () => {
    const tryTo = (what: string, fn: () => void) => {
      try { fn(); } catch (err) { console.warn(`cleanup: could not ${what}: ${(err as Error).message.slice(0, 200)}`); }
    };
    if (alarmMade) tryTo(`delete the alarm ${ALARM}`, () => awsv(['cloudwatch', 'delete-alarms', '--alarm-names', ALARM]));
    if (templateSaved) tryTo(`restore ${pointerParam}`, () => restorePointer(pointerParam, pointerBefore));
  });

  test('an alarm changing state is posted in the admin channel in the admin assistant\'s words', async () => {
    test.setTimeout(300_000);
    // THE ADMIN AGENT'S OWN TEMPLATE: the shipped one, every section and field kept, with a first line of its own.
    const shipped = shippedAdminNotices().get(NOTICE)?.source ?? '';
    expect(shipped, `the platform ships no ${NOTICE} notice`).toContain('# chat');
    const own = shipped.replace(/^# chat\n/m, `# chat\n${WORDING}\n`);
    expect(own, 'the admin agent\'s template differs from the shipped one').not.toBe(shipped);
    putAssistantTemplate(ADMIN_NOTICE_CLASSIFICATION, ADMIN_NOTICE_ASSISTANT, NOTICE, own);
    templateSaved = true;
    await sleep(POINTER_TTL_MS);

    // THE STEP: an alarm whose action is the notifier's topic enters ALARM.
    awsv(['cloudwatch', 'put-metric-alarm', '--alarm-name', ALARM,
      '--alarm-description', `AgentEchelon e2e ${STAMP}: an alarm the operator-notice spec owns and deletes`,
      '--namespace', 'AgentEchelon/E2E', '--metric-name', 'OperatorNoticeProbe', '--statistic', 'Sum',
      '--period', '60', '--evaluation-periods', '1', '--threshold', '1',
      '--comparison-operator', 'GreaterThanOrEqualToThreshold', '--treat-missing-data', 'ignore', '--alarm-actions', topicArn]);
    alarmMade = true;
    const since = Date.now() - 5_000;
    expectAlarm(ALARM);
    awsv(['cloudwatch', 'set-alarm-state', '--alarm-name', ALARM, '--state-value', 'ALARM', '--state-reason', `AgentEchelon e2e ${STAMP}: the operator-notice spec drives this alarm`]);

    // SETTLED: the notice for this alarm is in the admin channel.
    const ours = (ms: RoomMessage[]) => ms.filter((m) => Date.parse(m.createdAt) >= since && m.text.includes(ALARM));
    const seen = await pollFor(() => roomMessagesSeenBy(channelArn, serviceAdmin), (ms) => ours(ms).length > 0, { timeoutMs: 180_000, intervalMs: 5_000 });
    const posted = ours(seen);
    expect(posted.length, `no notice for ${ALARM} reached the admin channel; the newest are ${JSON.stringify(seen.slice(-5).map((m) => m.text.slice(0, 100)))}`).toBe(1);
    expect(posted[0].senderArn, 'the notice is posted as the admin agent').toBe(agentBot);
    // THE WORDS ARE THE ADMIN AGENT'S: its own first line, then the shipped template's lines filled for this alarm.
    expect(posted[0].text.split('\n')[0], 'the notice opens with the admin agent\'s own line').toBe(WORDING);
    expect(posted[0].text, 'the notice says the state and names the alarm').toContain(`**Alarm:** ${ALARM}`);
    expect(posted[0].text, 'the notice carries what the alarm describes').toContain(`AgentEchelon e2e ${STAMP}`);
  });
});
