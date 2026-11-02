/**
 * AN ASSISTANT SESSION CANNOT WRITE THE PROCESSOR'S OWN RECORDS.
 *
 * The abuse counters and circuit, the turn state and the message-analytics row are the platform's
 * bookkeeping about a turn. They are written on the processor's ambient role (`ProcessorRole`), never on
 * the assistant's vended session, so a session cannot reset its own rate limit, release another turn's lock,
 * trip or clear the cost circuit, or write an analytics row.
 *
 * For each classification, IAM decides (`simulate-principal-policy`):
 * - on the acting role: every one of those writes is refused, with the session's own tags in context;
 * - on the processor's role: the same writes are allowed, so the turn still keeps its records.
 *
 * The tables and the circuit parameter are read off the deployed processor's environment, so the spec
 * checks what this deployment uses. A classification that is not deployed is reported and skipped.
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import {
  CLASSIFICATIONS, NO_AWS_REASON, SSM_ROOT, REGION,
  awsReachable, awsOrNull, decide, actingRole, processorRoleArn, botFor, sessionContext,
} from './helpers/assistant-acting-role';

guardBackendErrors('a-vended-session-cannot-write-processor-records');

/** The processor's environment and the account, or null when the classification is not deployed. */
function processorEnv(classification: string): { env: Record<string, string>; account: string } | null {
  const fn = awsOrNull(`ssm get-parameter --name "${SSM_ROOT}/assistant/${classification}/processor-arn" --query "Parameter.Value"`);
  if (typeof fn !== 'string') return null;
  const env = awsOrNull(`lambda get-function-configuration --function-name ${fn} --query "Environment.Variables"`);
  return env ? { env, account: fn.split(':')[4] } : null;
}

/** The writes a turn keeps about itself, as (action, resource) pairs this deployment has configured. */
function processorWrites(env: Record<string, string>, account: string): Array<{ action: string; resource: string }> {
  const table = (name: string) => `arn:aws:dynamodb:${REGION}:${account}:table/${name}`;
  const out: Array<{ action: string; resource: string }> = [];
  if (env.ABUSE_CONTROLS_TABLE) {
    out.push({ action: 'dynamodb:UpdateItem', resource: table(env.ABUSE_CONTROLS_TABLE) });
    out.push({ action: 'dynamodb:PutItem', resource: table(env.ABUSE_CONTROLS_TABLE) });
  }
  if (env.TURN_STATE_TABLE) out.push({ action: 'dynamodb:UpdateItem', resource: table(env.TURN_STATE_TABLE) });
  if (env.MESSAGE_ANALYTICS_TABLE) out.push({ action: 'dynamodb:PutItem', resource: table(env.MESSAGE_ANALYTICS_TABLE) });
  if (env.ABUSE_CIRCUIT_PARAM) out.push({ action: 'ssm:PutParameter', resource: `arn:aws:ssm:${REGION}:${account}:parameter${env.ABUSE_CIRCUIT_PARAM}` });
  return out;
}

test.describe('an assistant session cannot write the processor\'s own records', () => {
  test.skip(!awsReachable(), NO_AWS_REASON);

  for (const classification of CLASSIFICATIONS) {
    test(`${classification}: the acting role is refused each write the processor role is allowed`, async () => {
      test.setTimeout(300_000);
      const deployed = processorEnv(classification);
      const acting = actingRole(classification);
      const processor = processorRoleArn(classification);
      test.skip(!deployed || !acting || !processor, `${classification} is not deployed`);

      const writes = processorWrites(deployed!.env, deployed!.account);
      // Not vacuous: the abuse table and the turn state are always wired.
      expect(writes.map((w) => w.action), 'no processor record is configured to check').toEqual(
        expect.arrayContaining(['dynamodb:UpdateItem', 'dynamodb:PutItem']),
      );

      const bot = botFor(classification, 'primary');
      const context = bot ? sessionContext(classification, 'primary', bot.botId) : [];
      for (const w of writes) {
        expect({ ...w, role: 'acting', decision: decide(acting!.arn, w.action, w.resource, context) })
          .toEqual({ ...w, role: 'acting', decision: expect.stringMatching(/Deny/) });
        expect({ ...w, role: 'processor', decision: decide(processor!, w.action, w.resource) })
          .toEqual({ ...w, role: 'processor', decision: 'allowed' });
      }
    });
  }
});
