/**
 * A TASK SERVICE REACHES ONLY ITS OWN CLASSIFICATION'S ROUTER (ADR-063 "IAM this adds", decision E1; tenets P4, D3, D12).
 *
 * The task service names a settled task and a task that became an assistant's to its router. That is the first thing it
 * invokes, and the grant is the boundary: classification A's task service invokes A's router, found by name and bounded
 * by A's tag and this instance's, and no other function; it reads A's router parameter and A's assignment records alone
 * (the second layer that refuses an assistant of another classification). Every case below is a refusal.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assistantsOf } from './helpers/assistants';
import { CLASSIFICATION_TEST_PROPS } from './helpers/synth';
import { INSTANCE_NAME, SSM_ROOT } from '../lib/stacks/agent-classification-common';

type Statement = { Sid?: string; Effect?: string; Action: unknown; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
type Resource = { Type: string; Properties?: Record<string, any> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const text = (v: unknown) => JSON.stringify(v);

const synth = (classification: string): Record<string, Resource> => {
  const app = new cdk.App();
  const stack = assistantsOf(classification)(app, `AgentEchelonAssistants-${classification}`, CLASSIFICATION_TEST_PROPS as never);
  return (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
};

/** Every statement attached to the task service's role, inline or by policy. */
function taskServiceStatements(r: Record<string, Resource>): Statement[] {
  const role = Object.keys(r).find((id) => r[id].Type === 'AWS::IAM::Role' && /^TaskServiceRole[0-9A-F]{8}$/.test(id))!;
  const out: Statement[] = [];
  for (const pol of r[role].Properties?.Policies ?? []) out.push(...pol.PolicyDocument.Statement);
  for (const x of Object.values(r)) {
    if ((x.Type === 'AWS::IAM::Policy' || x.Type === 'AWS::IAM::ManagedPolicy') && (text(x.Properties?.Roles) ?? "").includes(role)) out.push(...(x.Properties?.PolicyDocument?.Statement ?? []));
  }
  return out;
}

/** Whether a condition admits a function carrying these tags (StringEquals over resource tags). */
function admits(condition: Statement['Condition'], tags: Record<string, string>): boolean {
  const eq = condition?.StringEquals ?? {};
  return Object.entries(eq).every(([k, v]) => {
    const tag = k.replace(/^aws:ResourceTag\//, '');
    return list(v).includes(tags[tag]);
  });
}

describe('a task service reaches only its own router (ADR-063, deny tests)', () => {
  for (const classification of ['premium', 'standard']) {
    const other = classification === 'premium' ? 'standard' : 'premium';
    const st = taskServiceStatements(synth(classification));

    it(`DENY: ${classification}'s task service invokes only its own classification's router, of this instance`, () => {
      const invokes = st.filter((s) => s.Effect !== 'Deny' && list(s.Action).some((a) => /^lambda:Invoke/.test(String(a))));
      expect(invokes).toHaveLength(1);
      expect(text(invokes[0].Resource)).toMatch(/-AgentHandler\*/);
      expect(admits(invokes[0].Condition, { Instance: INSTANCE_NAME, classification })).toBe(true);
      expect(admits(invokes[0].Condition, { Instance: INSTANCE_NAME, classification: other })).toBe(false);
      expect(admits(invokes[0].Condition, { Instance: `${INSTANCE_NAME}-another`, classification })).toBe(false);
      expect(admits(invokes[0].Condition, { Instance: INSTANCE_NAME })).toBe(false);
    });

    it(`DENY: ${classification}'s task service reads only its own router parameter and its own assignment records`, () => {
      const params = st.filter((s) => list(s.Action).some((a) => String(a).startsWith('ssm:')) && !text(s.Resource).includes('intent'));
      const resources = params.flatMap((s) => list(s.Resource).map(text));
      expect(resources.length).toBeGreaterThan(0);
      for (const res of resources) {
        expect(res).toContain(classification);
        expect(res).not.toContain(`/${other}`);
        expect(res).not.toMatch(/assistant-assignments\/\*|assistant\/\*\//);
      }
      expect(resources.some((r) => r.includes(`${SSM_ROOT}/assistant/${classification}/router-arn`))).toBe(true);
      expect(resources.some((r) => r.includes(`assistant-assignments/${classification}`))).toBe(true);
    });
  }
});
