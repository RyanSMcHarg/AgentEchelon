/**
 * AN ASSISTANT'S TEAM WRITES ONLY THE ASSISTANT FAMILY OF THE TEMPLATE STORE (ADR-062 decision 2; tenets D15, P4).
 *
 * The console's writer of an assistant's own message templates may put a body under
 * `templates/<classification>/_assistants/` and activate a pointer under `.../templates/_assistants/`, and
 * nothing else under `templates/`: the classification's family is the operator's and the `_shipped` family
 * the platform's. `manage-profiles`, which writes `/assistant/*` for versions, is refused every template
 * pointer, so the assistant family has one writer. Read from the SYNTHESIZED template, because a grant that
 * is too wide fails nobody in a unit test.
 *
 * Which assistant is written is the route's: a team member's session names only the assistants their team
 * owns, and the handler reads that ownership again (`an-assistants-own-template-is-said-first.test.ts`).
 */
import { assistantAdministrationTemplate } from './helpers/synth';
import { ADMIN_CAPABILITIES } from '../lib/config/admin-capabilities';

type Resource = { Type: string; Properties?: Record<string, any> };
interface Stmt { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; owner: string }

const resources: Record<string, Resource> = (assistantAdministrationTemplate({ noExperiments: true }).toJSON() as { Resources: Record<string, Resource> }).Resources;

function statementsOf(prefix: string): Stmt[] {
  const out: Stmt[] = [];
  for (const [id, r] of Object.entries(resources)) {
    if (!id.startsWith(prefix)) continue;
    const docs = r.Type === 'AWS::IAM::Role' ? (r.Properties?.Policies ?? []).map((p: any) => p.PolicyDocument)
      : (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') ? [r.Properties?.PolicyDocument] : [];
    for (const d of docs) for (const s of d?.Statement ?? []) out.push({ ...s, owner: id });
  }
  return out;
}

const actionsOf = (s: Stmt) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const resourceText = (s: Stmt) => JSON.stringify(s.Resource ?? []);
const WRITES = ['s3:PutObject', 's3:*', 'ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:LabelParameterVersion', 'ssm:*'];

describe('the console\'s template writer', () => {
  const writer = statementsOf('ManageMessageTemplatesFunction').filter((s) => s.Effect === 'Allow');

  it('exists, with a write on the assistant family', () => {
    expect(writer.find((s) => s.Sid === 'WriteAnAssistantsOwnTemplates')).toBeDefined();
    expect(writer.find((s) => s.Sid === 'ActivateAnAssistantsOwnTemplates')).toBeDefined();
  });

  it('DENIED: writes no template body or pointer outside an assistant family', () => {
    const writes = writer.filter((s) => actionsOf(s).some((a) => WRITES.includes(a)));
    expect(writes.length).toBe(2);
    for (const s of writes) {
      const text = resourceText(s);
      if (actionsOf(s).includes('s3:PutObject')) expect(text).toMatch(/templates\/\*\/_assistants\/\*"/);
      else expect(text).toMatch(/assistant\/\*\/templates\/_assistants\/\*"/);
      expect(text).not.toMatch(/_shipped/);
    }
  });

  it('reads every family, so the console shows the classification\'s and the shipped beside the assistant\'s', () => {
    const reads = writer.filter((s) => actionsOf(s).includes('s3:GetObject') || actionsOf(s).includes('ssm:GetParameter'));
    expect(reads.map(resourceText).join(' ')).toMatch(/templates\/\*"/);
  });
});

describe('manage-profiles', () => {
  it('DENIED: is refused every template pointer, though it writes `/assistant/*` for versions', () => {
    const deny = statementsOf('ManageProfilesRole').find((s) => s.Sid === 'NoTemplatePointerWrites');
    expect(deny?.Effect).toBe('Deny');
    expect(actionsOf(deny!)).toEqual(expect.arrayContaining(['ssm:PutParameter', 'ssm:DeleteParameter']));
    expect(resourceText(deny!)).toMatch(/assistant\/\*\/templates\/\*"/);
  });

  it('holds no write on any template body', () => {
    const writes = statementsOf('ManageProfilesRole').filter((s) => s.Effect === 'Allow' && actionsOf(s).some((a) => a.startsWith('s3:Put')));
    for (const s of writes) expect(resourceText(s)).not.toMatch(/templates/);
  });
});

describe('the routes are in the capability catalog', () => {
  const paths = (key: string) => [...(ADMIN_CAPABILITIES[key].resources ?? []), ...(ADMIN_CAPABILITIES[key].teamResources ?? [])].map((r) => `${r.method} ${r.path}`);

  it('reading is viewing a profile; saving and rolling back are activations', () => {
    expect(paths('view-profiles')).toEqual(expect.arrayContaining(['GET admin/templates', 'GET admin/assistants/{assistant}/templates']));
    expect(paths('activate-profiles')).toEqual(expect.arrayContaining([
      'POST admin/templates/save', 'POST admin/templates/rollback',
      'POST admin/assistants/{assistant}/templates/save', 'POST admin/assistants/{assistant}/templates/rollback',
    ]));
  });
});
