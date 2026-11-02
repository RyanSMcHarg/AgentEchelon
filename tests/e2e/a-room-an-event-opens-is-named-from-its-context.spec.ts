/**
 * A ROOM AN EVENT OPENS ARRIVES NAMED FROM WHAT OPENED IT (SPEC-CONVERSATION-TYPES FR32), against the deployed stacks.
 *
 * The unit suites prove the order a room is named in (`a-room-is-named-from-what-opened-it`). What only a deployment
 * proves is the path end to end: the premium typed creator, deployed with the classification's message templates to read,
 * creates the room with its name in the `CreateChannel` call itself, so the channel never carries the placeholder.
 *  - an opening with no label is named from its summary;
 *  - an opening that names an alarm and its service is named from the two, worded by the `conversation-name` template.
 *
 * Each room is the operations team's standing type (`ops-team`), which the platform opens with no conversation
 * concerned, for the ops lead. Read once, after the creator returns: the name is set at creation, so there is nothing
 * to wait for. Every room and context row it opens, and the alarm's watch record, are deleted afterwards.
 *
 * **Coverage:** `e2e/a-room-an-event-opens-is-named-from-its-context.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getOpsLeadUser, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { personArnOf } from './helpers/person';
import { SSM_ROOT, physicalIdsInClassificationStacks } from './helpers/stack-prefix';
import { awsv, awsvText } from './helpers/aws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

guardBackendErrors('a-room-an-event-opens-is-named-from-its-context');

const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const STAMP = Date.now().toString(36);
const SUMMARY = `Card payments are failing in the e2e ${STAMP}`;
const ALARM = `ae-e2e-naming-${STAMP}`;
const SERVICE = 'AWS/Lambda';

/** One SSM parameter's value, or '' when it is not there. */
function ssmValue(name: string): string {
  try {
    const v = awsvText(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text'], { quiet: true }).trim();
    return v === 'None' ? '' : v;
  } catch {
    return '';
  }
}

/** Invoke the typed-conversation creator directly, through files so no shell sees the JSON. */
function invokeCreator(fn: string, payload: Record<string, unknown>): { ok: boolean; channelArn?: string; error?: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inFile = path.join(os.tmpdir(), `room-name-in-${stamp}.json`);
  const outFile = path.join(os.tmpdir(), `room-name-out-${stamp}.json`);
  fs.writeFileSync(inFile, JSON.stringify(payload));
  awsv(['lambda', 'invoke', '--function-name', fn, '--cli-binary-format', 'raw-in-base64-out', '--payload', `fileb://${inFile}`, outFile]);
  try {
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch {
    return { ok: false, error: 'no response from the creator' };
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

test.describe.serial('a room an event opens is named from its context', () => {
  let creator = '';
  let contextTable = '';
  let serviceAdmin = '';
  let leadArn = '';
  const rooms: string[] = [];

  test.beforeAll(async () => {
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    const lead = await getOpsLeadUser();
    test.skip(!lead, missingUserReason('opsLeadUser'));
    try {
      creator = physicalIdsInClassificationStacks({ type: 'AWS::Lambda::Function', logicalId: /^TypedConversationFromEvent/ })[0] || '';
    } catch {
      creator = '';
    }
    test.skip(!creator, 'no premium typed-conversation creator on this deployment (no type names premium)');
    contextTable = ssmValue(`${SSM_ROOT}/shared/tables/channel-context-name`);
    serviceAdmin = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`);
    expect(serviceAdmin, `${SSM_ROOT}/app-instance-admin-arn names no service admin`).toContain('/user/');
    leadArn = await personArnOf(lead!);
    expect(leadArn, 'the ops lead has no AppInstanceUser').toContain('/user/');
  });

  test.afterAll(async () => {
    const tryTo = (what: string, fn: () => void) => {
      try { fn(); } catch (err) { console.warn(`cleanup: could not ${what}: ${(err as Error).message.slice(0, 200)}`); }
    };
    for (const arn of rooms) {
      tryTo(`delete the room ${arn}`, () => awsv(['chime-sdk-messaging', 'delete-channel', '--channel-arn', arn, '--chime-bearer', serviceAdmin || leadArn]));
      if (contextTable) tryTo(`delete the row of ${arn}`, () => awsv(['dynamodb', 'delete-item', '--table-name', contextTable, '--key', JSON.stringify({ channelArn: { S: arn } })]));
    }
    if (contextTable) {
      tryTo('delete the alarm\'s watch record', () => awsv(['dynamodb', 'delete-item', '--table-name', contextTable, '--key', JSON.stringify({ channelArn: { S: `watch#alarm#${ALARM}` } })]));
    }
  });

  /** Open an `ops-team` room for the lead and read the name it was created with. */
  function openAndName(detail: Record<string, unknown>): string {
    const opened = invokeCreator(creator, { detail: { conversationType: 'ops-team', forUserArn: leadArn, ...detail } });
    expect(opened.ok, `the creator refused: ${opened.error ?? ''}`).toBe(true);
    expect(opened.channelArn, 'the creator returned no room').toContain('/channel/');
    rooms.push(opened.channelArn!);
    const described = awsv(['chime-sdk-messaging', 'describe-channel', '--channel-arn', opened.channelArn!, '--chime-bearer', serviceAdmin]);
    return String(described?.Channel?.Name ?? '');
  }

  test('an opening with no label is named from its summary, never the placeholder or the type', () => {
    test.setTimeout(120_000);
    const name = openAndName({ summary: SUMMARY });
    expect(name).toBe(SUMMARY);
    expect(name).not.toBe('New conversation');
    expect(name).not.toBe('ops-team');
  });

  test('an opening that names an alarm and its service is named from the two', () => {
    test.setTimeout(120_000);
    expect(openAndName({ watchesAlarm: ALARM, service: SERVICE })).toBe(`${ALARM} Alarm on ${SERVICE}`);
  });
});
