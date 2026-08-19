/**
 * Every SSM parameter a classification publishes must be a DECIDED question for the handler role:
 * either the handler is granted `ssm:GetParameter` on it, or it is listed below as deliberately
 * not-handler-read, with a reason.
 *
 * Why this shape, rather than asserting a list of expected grants:
 *
 * The synth tests already assert the IAM ceiling, so a WIDENED boundary fails the build. They could
 * not catch the inverse - a grant that is MISSING - because the application fails open. The handler
 * read `/agent-echelon/assistant/{classification}/processor-arn` on every single request, was denied
 * every time, fell back to an environment variable, and answered normally. 1700+ unit tests and the
 * full e2e suite stayed green while every turn logged an AccessDenied (found and fixed 2026-07-31).
 *
 * An env-var-driven check would not have caught it either: that path is CONSTRUCTED in the handler
 * (`${SSM_ROOT}/assistant/${classification}/processor-arn`), not passed in as a `*_PARAM` variable.
 *
 * So the gate is on the parameters the stack PUBLISHES. A new parameter forces an explicit decision -
 * grant it, or say why not - instead of defaulting to a silent omission that only shows up as log
 * noise nobody reads.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BasicClassificationStack } from '../lib/stacks/basic-classification-stack';
import { DEFAULT_PROFILE_MODEL_SELECTION } from '../lib/config/model-strategy';

const env = { account: '123456789012', region: 'us-east-1' };

/**
 * Parameters the handler legitimately never reads. Each needs a reason: this list is the only way to
 * silence the check, so an unjustified entry is how the guard would rot.
 */
const NOT_READ_BY_HANDLER: Record<string, string> = {
  guardrails: 'The selectable-guardrail catalog is consumed at SYNTH time (profile validation) and by '
    + 'the admin manage-profiles API, never by the handler at runtime.',
  'router-arn': 'Published FOR the admin console to deep-link this classification\'s router. The handler '
    + 'is that router; it has no reason to look up its own ARN.',
  'assistant-system-prompt': 'Read by the ASYNC PROCESSOR when building the system prompt, not by the '
    + 'handler, which never composes a prompt.',
};

/** `arn:aws:ssm:...:parameter/agent-echelon/x/y` -> `/agent-echelon/x/y`. */
function paramPathFromArn(resource: unknown): string | null {
  if (typeof resource !== 'string') return null;
  const i = resource.indexOf(':parameter/');
  return i === -1 ? null : resource.slice(i + ':parameter'.length);
}

/** Wildcards appear as `/agent-echelon/assistant/＊/definition`; match them as globs. */
function grantCovers(granted: string, wanted: string): boolean {
  if (!granted.includes('*')) return granted === wanted;
  const rx = new RegExp('^' + granted.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
  return rx.test(wanted);
}

describe('the handler role can read every parameter it is expected to read', () => {
  it('each published SSM parameter is either granted to the handler or explicitly exempted', () => {
    const app = new cdk.App();
    const stack = new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', {
      env,
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
      attachmentsBucketName: 'test-bucket',
      attachmentsBucketArn: 'arn:aws:s3:::test-bucket',
      profileModelSelection: DEFAULT_PROFILE_MODEL_SELECTION,
    } as never);

    const json = Template.fromStack(stack).toJSON() as Record<string, never>;
    const resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> = json.Resources;

    // Every parameter this classification publishes.
    const published = Object.values(resources)
      .filter((r) => r.Type === 'AWS::SSM::Parameter')
      .map((r) => String(r.Properties?.Name ?? ''))
      .filter(Boolean);
    // Guard against the check silently passing because nothing was found to check.
    if (published.length === 0) throw new Error('the stack published no SSM parameters — this check would be vacuous');

    // Every ssm:GetParameter resource on ANY policy in the stack. Scoping to the handler's own role
    // would be more precise, but policies attach by ref and the indirection buys nothing here: an
    // over-grant is what cdk-synth.test.ts already covers, and this test is about omission.
    const grantedPaths: string[] = [];
    for (const r of Object.values(resources)) {
      if (r.Type !== 'AWS::IAM::Policy' && r.Type !== 'AWS::IAM::Role') continue;
      const raw = JSON.stringify(r.Properties ?? {});
      if (!raw.includes('ssm:GetParameter')) continue;
      for (const m of raw.matchAll(/arn:aws:ssm:[^"]*?:parameter(\/[^"]*)/g)) grantedPaths.push(m[1]);
    }

    const ungranted = published.filter((p) => {
      const leaf = p.split('/').pop() || '';
      if (leaf in NOT_READ_BY_HANDLER) return false;
      return !grantedPaths.some((g) => grantCovers(g, p));
    });

    if (ungranted.length > 0) {
      throw new Error(
        'These published SSM parameters have no ssm:GetParameter grant. If the handler reads one, it '
          + 'will be DENIED at runtime and fail open - the turn still succeeds, so no test notices, and '
          + 'the only symptom is an AccessDenied in CloudWatch. Grant it, or add it to '
          + 'NOT_READ_BY_HANDLER with a reason:\n  '
          + ungranted.join('\n  '),
      );
    }
    expect(ungranted).toEqual([]);
  });

  it('pins the processor-arn grant specifically (the read that was denied on every turn)', () => {
    const app = new cdk.App();
    const stack = new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', {
      env,
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
      attachmentsBucketName: 'test-bucket',
      attachmentsBucketArn: 'arn:aws:s3:::test-bucket',
      profileModelSelection: DEFAULT_PROFILE_MODEL_SELECTION,
    } as never);

    const raw = JSON.stringify(Template.fromStack(stack).toJSON());
    // The handler resolves the async processor from this parameter on every request.
    if (!raw.includes('parameter/agent-echelon/assistant/basic/processor-arn')) {
      throw new Error('no grant for processor-arn: the handler reads it every turn and would be denied');
    }
    expect(raw.includes('parameter/agent-echelon/assistant/basic/processor-arn')).toBe(true);
  });
});
