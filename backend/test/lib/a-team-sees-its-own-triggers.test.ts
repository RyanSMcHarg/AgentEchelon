/**
 * A TEAM SEES WHICH EVENTS START ITS ASSISTANT'S WORKFLOWS, AND CHANGES NONE.
 *
 * Seeing a trigger (`view-event-triggers`) is apart from attaching or removing one (`manage-event-triggers`): a team member
 * reads the rules attached for an assistant their team owns, on their team route, which IAM names in their console session
 * and the handler checks again. Attaching and removing stay an admin's.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ADMIN_CAPABILITIES } from '../../lib/config/admin-capabilities';

const SRC = readFileSync(join(__dirname, '../../lambda/src/event-triggers-api.ts'), 'utf8');
const STACK = readFileSync(join(__dirname, '../../lib/stacks/admin-services-stack.ts'), 'utf8');
const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe('seeing a trigger is apart from changing one', () => {
  const view = ADMIN_CAPABILITIES['view-event-triggers'];
  const manage = ADMIN_CAPABILITIES['manage-event-triggers'];

  it('a team member holds the read, on their team route only; the write is an admin\'s alone', () => {
    expect(view.roles).toEqual(['admins', 'team-members']);
    expect(view.teamScope).toBe('assistant');
    expect(view.teamResources?.map(key)).toEqual(['GET admin/assistants/{assistant}/event-triggers/{typeKey}/{classification}']);
    expect(manage.roles).toEqual(['admins']);
  });

  it('DENY: no route is named by both, so holding the read reaches no write', () => {
    const reads = new Set([...view.resources, ...(view.teamResources ?? [])].map(key));
    expect(manage.resources.map(key).filter((r) => reads.has(r))).toEqual([]);
    // Its reads are what the form chooses from (event types, the account's rules and alarms), an admin's alone.
    expect(manage.resources.every((r) => r.method === 'POST' || ['admin/event-types', 'admin/event-rules', 'admin/event-alarms', 'admin/admin-notices'].includes(r.path))).toBe(true);
  });

  it('the team route is the trigger function\'s, with the grants its ownership check reads', () => {
    expect(STACK).toMatch(/conversations\('GET', '\/admin\/assistants\/\{assistant\}\/event-triggers\/\{typeKey\}\/\{classification\}', triggersFn\);\n\s+grantAssistantScopeCheck\(triggersFn,/);
  });
});

describe('the handler on the team route', () => {
  const branch = SRC.slice(SRC.indexOf('if (route === TEAM_TRIGGERS_ROUTE) {'), SRC.indexOf('return await listTriggers(event);'));

  it('DENY: refuses a write, and refuses an assistant the caller\'s team does not own before reading anything', () => {
    expect(branch).toMatch(/if \(event\.httpMethod !== 'GET'\) return respond\(event, 405/);
    const owned = branch.indexOf('await requireOwnedAssistant(event)');
    const refused = branch.indexOf('if (isScopeRefusal(owned)) return owned;');
    const listed = branch.indexOf('await listTriggers(');
    expect(owned).toBeGreaterThan(-1);
    expect(refused).toBeGreaterThan(owned);
    expect(listed).toBeGreaterThan(refused);
  });

  it('DENY: lists only the rules attached for that assistant: none attached for no assistant, none for another', () => {
    expect(branch).toMatch(/triggers: \(body\.triggers \?\? \[\]\)\.filter\(\(t\) => t\.assistant === owned\.assistant\)/);
  });
});
