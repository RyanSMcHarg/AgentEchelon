/**
 * TWO BATTLE GRANTS, CHECKED AGAINST THE RESOURCES THEY HAVE TO REACH.
 *
 * Each is a grant written by a pattern that the resource it is meant for does not match, so the grant
 * synthesizes, deploys and denies every call. Only the deployed log says so, which is why both are
 * pinned here against the synthesized app rather than against the construct that writes them.
 *
 *   1. THE ANALYTICS QUERY SCANS THE BATTLE OUTCOME TABLE. The battle-wins join reads every pick from
 *      it. The table has a fixed name (`CAPABILITY_RESOURCES.battleOutcomeTable`), so a grant on the
 *      stack-prefixed `table/<prefix>Battle*` matches nothing it reads, and every pick is missing from
 *      the results.
 *   2. THE ALT'S NAME APPLIER, BUILT BY ITS CLASSIFICATION'S OWN STACK, CARRIES ITS CLASSIFICATION TAG. The admin backend invokes an applier by
 *      `*ApplyAssistantName*` only where the function carries the instance and classification tags
 *      (`ownInstanceFunctions`). An untagged alt applier is refused, and the alt keeps its placeholder
 *      name through the battle.
 */
import { Template } from 'aws-cdk-lib/assertions';
import { auroraAppTemplates } from './helpers/synth';
import { CAPABILITY_RESOURCES } from '../lib/stacks/agent-classification-common';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';

type Resource = { Type: string; Properties: Record<string, any> };

let templates: Record<string, Template>;
beforeAll(() => {
  templates = auroraAppTemplates();
}, 600_000);

const battle = (): Template => templates.Battle;
const analytics = (): Template => Object.entries(templates).find(([name]) => /^AdminServicesAnalytics.*\.nested$/.test(name))![1];

/** Every statement of every policy and role in a template. */
function statements(t: Template): any[] {
  const out: any[] = [];
  for (const r of Object.values(t.toJSON().Resources ?? {}) as Resource[]) {
    if (r.Type === 'AWS::IAM::Policy') out.push(...(r.Properties.PolicyDocument?.Statement ?? []));
    if (r.Type === 'AWS::IAM::Role') for (const p of r.Properties.Policies ?? []) out.push(...(p.PolicyDocument?.Statement ?? []));
  }
  return out;
}
const actionsOf = (s: any): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);

/** A resource ARN as a string, with `Fn::Join` pieces joined and pseudo-parameters left as `${...}`. */
function arnText(resource: unknown): string {
  if (typeof resource === 'string') return resource;
  const join = (resource as any)?.['Fn::Join'];
  if (join) return (join[1] as unknown[]).map((p) => (typeof p === 'string' ? p : `\${${(p as any).Ref ?? 'token'}}`)).join(join[0]);
  return JSON.stringify(resource);
}

describe('the analytics query can read the battle outcome table', () => {
  it('the Battle stack creates the outcome table under its fixed name', () => {
    battle().hasResourceProperties('AWS::DynamoDB::Table', { TableName: CAPABILITY_RESOURCES.battleOutcomeTable });
  });

  it("the analytics role's Scan names exactly that table", () => {
    const scans = statements(analytics()).filter((s) => actionsOf(s).includes('dynamodb:Scan'));
    const resources = scans.flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource])).map(arnText);
    // The table ARN, by name, in this deployment's region and account (literal or pseudo-parameter).
    expect(resources).toContainEqual(expect.stringMatching(
      new RegExp(`^arn:aws:dynamodb:[^:]+:[^:]+:table/${CAPABILITY_RESOURCES.battleOutcomeTable}$`),
    ));
    // No wildcard on a table: the grant that denied every pick was one.
    for (const r of resources) expect(r).not.toMatch(/:table\/[^/]*\*/);
  });
});

describe("a duel's alt is the provisioner's, and no stack builds an applier for it", () => {
  // ADR-048, amended 2026-10-23: every battle-capable classification declares its alt to its seed, and the one
  // runtime applier renames it through its directory entry.
  it('the battle-capable classifications declare their alts to the seed, so the check below is not vacuous', () => {
    const alts = Object.entries(templates).filter(([name]) => /^Assistants-/.test(name))
      .flatMap(([, t]) => Object.values(t.findResources('Custom::DeclaredAssistants')) as Resource[])
      .flatMap((r) => JSON.parse(String(r.Properties.declaration)).assistants as Array<{ occupancy: string; welcome: boolean }>)
      .filter((a) => a.occupancy === 'alt');
    expect(alts.length).toBeGreaterThan(0);
    for (const a of alts) expect(a.welcome).toBe(false);
  });

  it('no classification stack builds a name applier', () => {
    const appliers = Object.entries(templates).filter(([name]) => /^Assistants-/.test(name))
      .flatMap(([, t]) => Object.values(t.findResources('AWS::Lambda::Function')) as Resource[])
      .filter((fn) => /ApplyAssistantName/.test(String(fn.Properties.FunctionName ?? '')));
    expect(appliers).toEqual([]);
  });
});
