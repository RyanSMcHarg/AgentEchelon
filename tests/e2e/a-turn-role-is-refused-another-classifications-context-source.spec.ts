/**
 * A CLASSIFICATION'S TURN ROLE IS REFUSED A CONTEXT SOURCE ONLY ANOTHER CLASSIFICATION PUBLISHES (ADR-060 decision 1,
 * decision 3; tenets P4, D3, D12), against the deployed acting roles.
 *
 * A `ctx:` variable reads a field of a context source its classification publishes, under that classification's acting
 * role. Validation refuses a version naming a source its classification does not publish
 * (`backend/test/a-turn-role-is-refused-another-classifications-context-source.test.ts` proves that half at synth). This
 * proves the other half where it lives: IAM refuses classification A's acting role, with the tags a real A session
 * carries, the read of classification B's published catalog and of every source B's catalog publishes that A's does not.
 *
 * Both directions, because a denial-only file passes as well when the grant is broken: each classification's own role
 * is ALLOWED its own catalog, beside the refusals.
 *
 * `iam simulate-principal-policy` against the deployed role, which evaluates its permissions boundary too. Company
 * context under `context/` is granted per role and per declared classification set and is proven by
 * `an-ops-role-reaches-only-its-own-classification.spec.ts`; it is left out here.
 *
 * **Coverage:** `e2e/a-turn-role-is-refused-another-classifications-context-source.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import {
  CLASSIFICATIONS, NO_AWS_REASON, REGION, SSM_ROOT, actingRole, awsOrNull, awsReachable, botFor, decide, sessionContext,
} from './helpers/assistant-acting-role';

guardBackendErrors('turn-role-ctx-source');

interface PublishedSource { key: string; type: string; locator?: string; prefix?: string }

/** A classification's published catalog, as the deployment holds it, or null when it publishes none. */
function catalogOf(classification: string): PublishedSource[] | null {
  const raw = awsOrNull(`ssm get-parameter --name "${SSM_ROOT}/assistant/${classification}/context-sources" --query "Parameter.Value"`);
  return typeof raw === 'string' ? JSON.parse(raw) : null;
}

/** The action and resource a source is read with, as `contextSourceGrant` grants it; undefined for company context. */
function readOf(src: PublishedSource, account: string): { action: string; resource: string } | undefined {
  switch (src.type) {
    case 's3-prefix':
      return (src.prefix ?? '').startsWith('context/') ? undefined : { action: 's3:GetObject', resource: `arn:aws:s3:::${src.locator}/${src.prefix ?? ''}probe` };
    case 'dynamodb-table': return { action: 'dynamodb:GetItem', resource: `arn:aws:dynamodb:${REGION}:${account}:table/${src.locator}` };
    case 'ssm-parameter': return { action: 'ssm:GetParameter', resource: `arn:aws:ssm:${REGION}:${account}:parameter${src.locator}` };
    case 'lambda-service': return { action: 'lambda:InvokeFunction', resource: src.locator ?? '' };
    default: return undefined;
  }
}

test.describe('a turn role reads only its own classification\'s context sources', () => {
  test.beforeEach(() => test.skip(!awsReachable(), NO_AWS_REASON));

  test('each acting role is allowed its own catalog and refused every other classification\'s catalog and own sources', () => {
    test.setTimeout(300_000);
    const account = awsOrNull('sts get-caller-identity --query Account') as string;
    const deployed = CLASSIFICATIONS.filter((c) => actingRole(c) && catalogOf(c));
    test.skip(deployed.length < 2, 'needs two deployed classifications that each publish a catalog');
    const paramArn = (c: string) => `arn:aws:ssm:${REGION}:${account}:parameter${SSM_ROOT}/assistant/${c}/context-sources`;

    for (const a of deployed) {
      const role = actingRole(a)!.arn;
      const session = sessionContext(a, 'primary', botFor(a, 'primary')?.botId || 'probe-bot');
      // THE POSITIVE CONTROL: a role whose own read is refused would make every refusal below meaningless.
      expect(decide(role, 'ssm:GetParameter', paramArn(a), session), `${a}'s acting role reading its own catalog`).toBe('allowed');
      const own = new Set((catalogOf(a) ?? []).map((s) => JSON.stringify(readOf(s, account))));
      for (const b of deployed.filter((c) => c !== a)) {
        expect(decide(role, 'ssm:GetParameter', paramArn(b), session), `${a}'s acting role reading ${b}'s catalog`).not.toBe('allowed');
        for (const src of catalogOf(b) ?? []) {
          const read = readOf(src, account);
          if (!read || own.has(JSON.stringify(read))) continue; // A publishes it too, so it is A's to read.
          expect(decide(role, read.action, read.resource, session), `${a}'s acting role reading ${b}'s source ${src.key}`).not.toBe('allowed');
        }
      }
    }
  });
});
