/**
 * IAM REFUSES A POLICY WITH TWO STATEMENTS OF THE SAME ID, AND SYNTH DOES NOT.
 *
 * CloudFormation renders duplicate `Sid`s happily; IAM rejects the policy at apply time with
 * "Statement IDs (SID) in a single policy must be unique", the stack update fails, and the whole
 * deploy rolls back - taking every unrelated change in that stack with it.
 *
 * That is exactly what happened. A role was given the output of `classificationChannelScopedAllow`
 * twice: once inside `driftChannelCreateStatements` and once directly, for a different action. The
 * helper names its statements with fixed ids, so the second call collided with the first. Every
 * synth test passed, `cdk diff` was clean, and the failure arrived as a rollback mid-deploy.
 *
 * A duplicate id is never intentional, so this needs no allowlist: it walks every policy of every
 * classification stack and fails on any repeat.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { assistantsOf } from './helpers/assistants';

const env = { account: '123456789012', region: 'us-east-1' };
const baseProps = {
  env,
  appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
  attachmentsBucketName: 'agent-echelon-attachments-test',
  attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
};

/** The drift hookup is what provisions the conversation-split role, so it must be on. */
function makeHookup(_app: cdk.App) {
  return { rdsProxy: false, liveDrift: true };
}

/** Every `Sid` in every statement of every policy, grouped by the policy it lives in. */
function sidsByPolicy(template: Template): Array<{ policy: string; sids: string[] }> {
  const out: Array<{ policy: string; sids: string[] }> = [];
  for (const [logicalId, res] of Object.entries(template.findResources('AWS::IAM::Policy'))) {
    const statements = (res as any)?.Properties?.PolicyDocument?.Statement ?? [];
    const sids = statements
      .map((s: any) => s?.Sid)
      .filter((s: unknown): s is string => typeof s === 'string' && s.length > 0);
    out.push({ policy: logicalId, sids });
  }
  return out;
}

describe('no IAM policy repeats a statement id', () => {
  const stacks: Array<[string, (app: cdk.App) => cdk.Stack]> = [
    ['Basic', (app) => assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', { ...baseProps, auroraDriftHookup: makeHookup(app) } as never)],
    ['Standard', (app) => assistantsOf('standard')(app, 'AgentEchelonAssistants-standard', { ...baseProps, auroraDriftHookup: makeHookup(app) } as never)],
    ['Premium', (app) => assistantsOf('premium')(app, 'AgentEchelonAssistants-premium', { ...baseProps, auroraDriftHookup: makeHookup(app) } as never)],
  ];

  for (const [name, build] of stacks) {
    it(`${name}: every statement id in a policy is unique`, () => {
      const app = new cdk.App();
      const template = Template.fromStack(build(app));

      const offenders: string[] = [];
      for (const { policy, sids } of sidsByPolicy(template)) {
        const seen = new Set<string>();
        for (const sid of sids) {
          if (seen.has(sid)) offenders.push(`${policy}: "${sid}"`);
          seen.add(sid);
        }
      }

      // The joined list IS the message: jest has no assertion-message argument, and a bare
      // toEqual([]) on failure would print the offenders without saying what they mean.
      expect(offenders.join(String.fromCharCode(59, 32))).toBe('');
    });
  }
});
