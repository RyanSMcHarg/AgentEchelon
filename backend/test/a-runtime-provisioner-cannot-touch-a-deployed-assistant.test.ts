/**
 * THE PROVISIONER REACHES ONLY WHAT IT CREATED (ADR-048, amended 2026-10-24), in the synthesized templates.
 *
 * Every build and removal runs on a session of one role (`RuntimeAssistantProvisionerRole`, in `Messaging`) that
 * the provisioner function alone assumes, with the classification it works at as a session tag, and every
 * classification condition is that tag (`${aws:PrincipalTag/classification}`), so the role names no classification
 * and still never relabels one. Its boundary is a condition, not a resource: every identity and Lex bot action
 * requires `provisioner = runtime`, requested on create and present on the resource after. An identity nothing
 * provisioned carries no such tag, so the role cannot describe, delete or reconfigure one. It holds no `iam:*`
 * beyond passing its one Lex bot role to Amazon Lex, and writes nothing under `/assistant/*`, which is the profile
 * store.
 *
 * `manage-assistants` holds none of it: it asks the provisioner. The inverse is asserted too: the profile editor
 * cannot write the directory or the assignment records, so neither role can forge the other's half of an assistant.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assistantAdministrationTemplate, TEST_ENV } from './helpers/synth';
import { MessagingStack } from '../lib/stacks/messaging-stack';
import { ASSISTANT_PROVISIONER_FUNCTION_NAME } from '../lib/stacks/agent-classification-common';

type Statement = { Sid?: string; Action: string | string[]; Resource: unknown; Principal?: unknown; Condition?: Record<string, Record<string, unknown>> };
type Resource = { Type: string; Properties?: Record<string, any> };
type Resources = { Resources: Record<string, Resource> };

// Assistant administration is the admin backend's (AdminServices), built whether or not experiments are declared.
const admin = assistantAdministrationTemplate({ noExperiments: true }).toJSON() as Resources;
// The provisioner is the core's, beside the app instance.
const messaging = Template.fromStack(new MessagingStack(new cdk.App(), 'TestMessaging', { env: TEST_ENV, appInstanceName: 'test' }))
  .toJSON() as Resources;

const actions = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const resources = (s: Statement): string[] => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).map((r) => JSON.stringify(r));

/** Every statement a role holds: its inline policies and any AWS::IAM::Policy attached to it. */
function statementsOf(template: Resources, rolePrefix: string): Statement[] {
  const entries = Object.entries(template.Resources);
  const roles = entries.filter(([id, r]) => r.Type === 'AWS::IAM::Role' && id.startsWith(rolePrefix));
  if (roles.length !== 1) throw new Error(`expected one ${rolePrefix}, found ${roles.length}`);
  const [roleId, role] = roles[0];
  const inline = (role.Properties?.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement as Statement[]);
  const attached = entries
    .filter(([, r]) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties?.Roles ?? []).includes(roleId))
    .flatMap(([, r]) => r.Properties!.PolicyDocument.Statement as Statement[]);
  return [...inline, ...attached];
}

const provisioner = statementsOf(messaging, 'RuntimeAssistantProvisionerRole');
const fnRole = statementsOf(messaging, 'AssistantProvisionerRole');
const consoleFn = statementsOf(admin, 'ManageAssistantsRole');
const SESSION = '$' + '{aws:PrincipalTag/classification}';
const profileEditor = statementsOf(admin, 'ManageProfilesRole');

/** Whether a statement's conditions pin `provisioner = runtime` on the request or the resource. */
const pinsRuntime = (s: Statement): boolean => {
  const eq = s.Condition?.StringEquals ?? {};
  return eq['aws:RequestTag/provisioner'] === 'runtime' || eq['aws:ResourceTag/provisioner'] === 'runtime';
};

describe('the provisioner reaches only what it created', () => {
  it('holds identity and Lex actions at all (the scan is not vacuous)', () => {
    const all = provisioner.flatMap(actions);
    expect(all).toEqual(expect.arrayContaining(['chime:CreateAppInstanceBot', 'chime:DeleteAppInstanceBot', 'lex:CreateBot', 'lex:DeleteBot']));
  });

  it('every identity and Lex bot action requires provisioner = runtime, but listing', () => {
    // Listing is the one exception: a deleted identity or Lex bot carries no tags, so the tag-conditioned
    // Describe or Delete answers with a denial, and retire settles "gone" by listing. Each listing reads
    // names and can change nothing.
    const LISTINGS = [['chime:ListAppInstanceBots'], ['lex:ListBots']];
    const unpinned = provisioner.filter((s) => actions(s).some((a) => a.startsWith('chime:') || a.startsWith('lex:')) && !pinsRuntime(s));
    expect(unpinned.map((s) => actions(s))).toEqual(LISTINGS);
  });

  it('a create must stamp runtime, and anything after must already carry it', () => {
    const create = provisioner.find((s) => actions(s).includes('chime:CreateAppInstanceBot'))!;
    expect(create.Condition!.StringEquals['aws:RequestTag/provisioner']).toBe('runtime');
    const retire = provisioner.find((s) => actions(s).includes('chime:DeleteAppInstanceBot'))!;
    expect(retire.Condition!.StringEquals['aws:ResourceTag/provisioner']).toBe('runtime');
    const lexDelete = provisioner.find((s) => actions(s).includes('lex:DeleteBot'))!;
    expect(lexDelete.Condition!.StringEquals['aws:ResourceTag/provisioner']).toBe('runtime');
  });

  it('can tag only what is already runtime, and never change a classification', () => {
    // A request-only condition on a tag grant would let this role stamp `provisioner=runtime` onto a
    // bot nothing provisioned, which brings it within the delete grant, or relabel a bot's classification.
    const tagging = provisioner.filter((s) => actions(s).some((a) => a === 'chime:TagResource' || a === 'lex:TagResource'));
    expect(tagging.length).toBeGreaterThanOrEqual(2);
    for (const s of tagging) {
      const eq = s.Condition!.StringEquals;
      expect(eq['aws:ResourceTag/provisioner']).toBe('runtime');
      // The session's own classification on both sides: no list, and no relabel.
      expect(eq['aws:RequestTag/classification']).toBe(SESSION);
      expect(eq['aws:ResourceTag/classification']).toBe(SESSION);
    }
  });

  it("every classification it creates or reaches is the session's own", () => {
    const conditioned = provisioner.filter((s) => JSON.stringify(s.Condition ?? {}).includes('classification'));
    expect(conditioned.length).toBeGreaterThan(0);
    for (const s of conditioned) {
      for (const keys of Object.values(s.Condition!)) {
        for (const [k, v] of Object.entries(keys)) if (/Tag\/classification$/.test(k)) expect(([] as unknown[]).concat(v)).toEqual([SESSION]);
      }
    }
  });

  it("the provisioner function's own role holds no identity or Lex action, and assumes the session role tagged with a classification", () => {
    expect(fnRole.filter((s) => actions(s).some((a) => a.startsWith('chime:') || a.startsWith('lex:')))).toEqual([]);
    const assume = fnRole.find((s) => s.Sid === 'WorkOnASessionOfTheClassification')!;
    expect(actions(assume).sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    expect(resources(assume).join()).toContain('RuntimeAssistantProvisionerRole');
    const role = Object.entries(messaging.Resources).find(([id, r]) => r.Type === 'AWS::IAM::Role' && id.startsWith('RuntimeAssistantProvisionerRole'))![1];
    const trust = role.Properties!.AssumeRolePolicyDocument.Statement as Statement[];
    expect(trust).toHaveLength(2);
    // A credential is minted on it, so it carries a boundary: its own statements.
    const boundaryId = role.Properties!.PermissionsBoundary.Ref as string;
    const bounded = messaging.Resources[boundaryId].Properties!.PolicyDocument.Statement as Statement[];
    const shape = (x: Statement) => JSON.stringify({ ...x, Sid: undefined });
    expect(bounded.map(shape).sort()).toEqual(provisioner.map(shape).sort());
    // Only the provisioner function's role, and only with a classification tag. The admin plane is not excluded:
    // the admin assistant is a declared assistant the provisioner seeds like any other.
    for (const t of trust) {
      expect(JSON.stringify(t.Principal)).toContain('AssistantProvisionerRole');
      expect(t.Condition!.Null).toEqual({ 'aws:RequestTag/classification': 'false' });
    }
  });

  it('the console function holds no identity, Lex or session-role grant: it invokes the provisioner', () => {
    expect(consoleFn.filter((s) => actions(s).some((a) => /^(chime|lex|sts|iam):/.test(a)))).toEqual([]);
    const ask = consoleFn.find((s) => s.Sid === 'AskTheProvisioner')!;
    expect(actions(ask)).toEqual(['lambda:InvokeFunction']);
    expect(resources(ask).join()).toContain(`function:${ASSISTANT_PROVISIONER_FUNCTION_NAME}`);
  });

  it('renames only an identity it built, through one call that keeps the identity\'s own configuration', () => {
    // IAM cannot constrain what `UpdateAppInstanceBot` carries, so the grant is pinned to what the provisioner
    // built, and the one call that sends it re-sends the configuration the identity answered with.
    const updates = provisioner.filter((s) => actions(s).includes('chime:UpdateAppInstanceBot'));
    expect(updates).toHaveLength(1);
    expect(actions(updates[0])).toEqual(['chime:UpdateAppInstanceBot']);
    const eq = updates[0].Condition!.StringEquals;
    expect(Object.keys(updates[0].Condition!)).toEqual(['StringEquals']);
    expect(eq['aws:ResourceTag/provisioner']).toBe('runtime');
    expect(([] as unknown[]).concat(eq['aws:ResourceTag/classification'])).toEqual([SESSION]);
    const src = (f: string) => readFileSync(join(__dirname, '../lambda/src', f), 'utf8');
    const senders = ['lib/assistant-provisioner.ts', 'lib/declared-assistants.ts', 'assistant-provisioner-function.ts']
      .flatMap((f) => (src(f).match(/new UpdateAppInstanceBotCommand\(\{[\s\S]*?\}\)\)/g) ?? []));
    expect(senders).toHaveLength(1);
    expect(senders[0]).toMatch(/Configuration: configuration,/);
    expect(src('lib/assistant-provisioner.ts')).toMatch(/const configuration = current\?\.AppInstanceBot\?\.Configuration;/);
  });

  it('holds no iam action but passing its own Lex bot role to Amazon Lex', () => {
    const iamStatements = provisioner.filter((s) => actions(s).some((a) => a.startsWith('iam:')));
    expect(iamStatements.flatMap(actions)).toEqual(['iam:PassRole']);
    expect(resources(iamStatements[0]).join()).toContain('RuntimeAssistantLexBotRole');
    expect(iamStatements[0].Condition!.StringEquals['iam:PassedToService']).toBe('lexv2.amazonaws.com');
  });

  it('the console writes only the directory, the runtime records and its own claims, and nothing under /assistant/*', () => {
    const writes = consoleFn.filter((s) => actions(s).some((a) => a === 'ssm:PutParameter' || a === 'ssm:DeleteParameter'));
    const targets = writes.flatMap(resources);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(t).toMatch(/assistant-directory\/\*|assistant-assignments\/\*\/\*\/assistants\/\*|provisioner-claims\/console\/\*/);
    expect(targets.join()).not.toMatch(/\/assistant\/\*/);
  });

  it("the provisioner writes the directory and the assignment records, spends its callers' claims, and nothing under /assistant/*", () => {
    const writes = fnRole.filter((s) => actions(s).some((a) => a === 'ssm:PutParameter' || a === 'ssm:DeleteParameter'));
    const targets = writes.flatMap(resources);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(t).toMatch(/assistant-directory\/\*|assistant-assignments\/\*|provisioner-claims\/\*/);
    expect(targets.join()).not.toMatch(/\/assistant\/\*/);
    // A claim is its caller's to write: the provisioner only reads one and deletes it.
    expect(writes.filter((s) => resources(s).some((r) => r.includes('provisioner-claims')) && actions(s).includes('ssm:PutParameter'))).toEqual([]);
  });

  it('the profile editor cannot write the directory or any assignment record', () => {
    const writes = profileEditor.filter((s) => actions(s).some((a) => a === 'ssm:PutParameter' || a === 'ssm:DeleteParameter'));
    const targets = writes.flatMap(resources).join();
    expect(targets).not.toContain('assistant-directory');
    expect(targets).not.toContain('assistant-assignments');
  });
});
