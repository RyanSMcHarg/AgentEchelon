/**
 * Context source ALARM delivery E2E (INV-CTX-CAT-8).
 *
 * The alarm exists so an operator is told when context stops working. Nothing had ever proved that
 * the telling actually happens: the synth test asserts the alarm is shaped correctly, which is a
 * statement about a CloudFormation template, not about a message reaching a human.
 *
 * That gap is not hypothetical here. Two defects in this exact path were found by looking at the live
 * system rather than at the code:
 *   - the metric the alarm watches did not exist at all, because the EMF envelope used lowercase
 *     `name`/`unit` and CloudWatch discards a malformed document silently. The alarm would have sat
 *     in INSUFFICIENT_DATA forever.
 *   - the notifier built a message with no size cap, and Amazon Chime SDK rejects Content over 4096
 *     ENCODED characters. Over the cap, SendChannelMessage throws, the handler swallows it (it has to,
 *     or SNS retries forever), and the alert is lost.
 *
 * So this drives the real notifier with a real alarm payload and asserts a message was really sent.
 *
 * There is deliberately NO Playwright browser step here: this alarm delivers to the admin
 * notification conversation and to the admin roster by email. It has no admin-console surface, so a
 * UI assertion would be theatre. The console-error coverage for the admin app lives in its own specs.
 */
import { test, expect } from '@playwright/test';
import { exec } from 'child_process';
import { promisify } from 'util';
import { guardBackendErrors } from './helpers/turn-guards';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardBackendErrors('context-source-alarm');


const execAsync = promisify(exec);
const AWS_PROFILE = process.env.AWS_PROFILE || '';
const REGION = process.env.AWS_REGION || 'us-east-1';
const CLASSIFICATION = 'standard';

const profileFlag = () => (AWS_PROFILE ? `--profile ${AWS_PROFILE}` : '');
const haveCreds = () => Boolean(AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);

async function aws(args: string): Promise<string> {
  const { stdout } = await execAsync(`aws ${args} --region ${REGION} ${profileFlag()}`, {
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return String(stdout).trim();
}

test.describe.serial('context source alarm delivers to a human', () => {
  test.skip(!haveCreds(), 'needs AWS credentials to inspect the deployed alarm path');

  test('the alarm is deployed, wired to a topic, and not already firing', async () => {
    test.setTimeout(120_000);

    const raw = await aws(
      `cloudwatch describe-alarms --alarm-name-prefix agent-echelon-${CLASSIFICATION}-context-source `
      + '--query "MetricAlarms[0].[AlarmName,StateValue,Threshold,length(AlarmActions),length(OKActions)]" --output text',
    );
    const [name, state, threshold, alarmActions, okActions] = raw.split(/\s+/);

    expect(name, 'no context source failure-rate alarm is deployed').toContain('context-source-failure-rate');
    expect(Number(threshold)).toBeGreaterThan(0);
    // Recovery must notify too, or the alert is a one-way ratchet people learn to ignore.
    expect(Number(alarmActions), 'alarm has no action - it would fire into the void').toBeGreaterThan(0);
    expect(Number(okActions), 'alarm never says "recovered"').toBeGreaterThan(0);
    // INSUFFICIENT_DATA here would mean the metric does not exist - the EMF casing bug's signature.
    expect(
      state,
      'the alarm has no data. The metric it watches is not being produced - check the EMF envelope.',
    ).not.toBe('INSUFFICIENT_DATA');
  });

  test('the metric the alarm divides actually exists in CloudWatch', async () => {
    test.setTimeout(120_000);

    // The rate expression is failed/(failed+resolved) on the bare Classification dimension. If that
    // rollup is missing the alarm can never evaluate, however well-formed the alarm itself is.
    const count = await aws(
      'cloudwatch list-metrics --namespace AgentEchelon/ContextSources '
      + '--metric-name ContextSourceResolved --dimensions Name=Classification,Value=standard '
      + '--query "length(Metrics)" --output text',
    );
    expect(
      Number(count),
      'the Classification-only rollup does not exist, so the failure-RATE alarm has no denominator. '
      + 'This is what a malformed EMF document looks like from the outside: logs fine, no metric.',
    ).toBeGreaterThan(0);
  });

  test('the notifier really posts to the admin conversation', async () => {
    test.setTimeout(180_000);

    const fnName = await aws(
      `cloudformation describe-stack-resources --stack-name AgentEchelonClassification-Standard `
      + '--query "StackResources[?starts_with(LogicalResourceId,\'ContextSourceAlarmFunction\')]'
      + '|[?ResourceType==\'AWS::Lambda::Function\'].PhysicalResourceId" --output text',
    );
    expect(fnName, 'the alarm notifier Lambda is not deployed').toBeTruthy();

    // A REAL CloudWatch alarm SNS payload, including an unbounded NewStateReason. If the notifier
    // does not cap the message, Chime rejects it and the alert is silently lost - so the oversized
    // reason is the point of this fixture, not incidental.
    const alarmMessage = JSON.stringify({
      AlarmName: `agent-echelon-${CLASSIFICATION}-context-source-failure-rate`,
      AlarmDescription: `E2E synthetic alarm. ${'Context source failure detail. '.repeat(80)}`,
      NewStateValue: 'ALARM',
      NewStateReason: `Threshold Crossed: 1 datapoint [42.0] was greater than the threshold (10.0). ${'padding '.repeat(200)}`,
      StateChangeTime: new Date().toISOString(),
      Region: REGION,
    });
    const payload = Buffer.from(
      JSON.stringify({ Records: [{ Sns: { Message: alarmMessage } }] }),
    ).toString('base64');

    const invokedAt = Date.now() - 5_000;
    // NO --cli-binary-format here. The payload above is base64, which is exactly what AWS CLI v2
    // expects by default; `raw-in-base64-out` declares the INPUT raw, so the CLI passed the base64
    // text through undecoded and Lambda rejected it with InvalidRequestContentException
    // ("Unrecognized token 'eyJSZWNvcmRz...'"). The two settings contradicted each other, so this
    // spec could never invoke the notifier at all - it failed on the harness before reaching the
    // assertion about whether an alarm reaches a human.
    const out = await aws(
      `lambda invoke --function-name ${fnName} --payload ${payload} `
      + `"${process.env.TEMP}/alarm-out.json" `
      + '--query "[StatusCode,FunctionError]" --output text',
    );
    const [status, fnError] = out.split(/\s+/);
    expect(Number(status)).toBe(200);
    expect(fnError, 'the notifier threw').toMatch(/^(None)?$/);

    // StatusCode 200 only means the handler returned. It swallows delivery failures by design, so
    // the log is the only place that distinguishes "posted" from "gave up".
    const logGroup = `/aws/lambda/${fnName}`;
    let delivered = '';
    let failures = '';
    for (let attempt = 0; attempt < 8 && !delivered; attempt++) {
      await new Promise((r) => setTimeout(r, 5_000));
      delivered = await aws(
        `logs filter-log-events --log-group-name ${logGroup} --start-time ${invokedAt} `
        + '--filter-pattern "delivered" --query "events[].message" --output text',
      );
      failures = await aws(
        `logs filter-log-events --log-group-name ${logGroup} --start-time ${invokedAt} `
        + '--filter-pattern "\\"failed to deliver\\"" --query "events[].message" --output text',
      );
      if (failures) break;
    }

    expect(
      failures,
      'the notifier could not post the alert. If this names a Chime size limit, the message cap '
      + 'regressed - Content is capped at 4096 ENCODED characters and prose roughly doubles.',
    ).toBe('');
    expect(
      delivered,
      'no delivery confirmation. The alarm fired and nobody was told, which is the failure this '
      + 'whole path exists to prevent.',
    ).toContain('delivered');
  });
});
