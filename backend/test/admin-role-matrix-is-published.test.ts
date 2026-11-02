/**
 * The published capability matrix cannot disagree with the capability catalog it describes.
 *
 * `SPEC-ADMIN-CONSOLE.md` publishes the role-based capability matrix: every admin function, which
 * role holds it, and how it is controlled. An operator reads it to learn what a role can reach, and a
 * deployment reads it to decide which group to put somebody in. A permission table that is wrong about
 * who is DENIED is worse than no table at all: it is an assurance, and the reader cannot check it. The
 * grants themselves live in `lib/config/admin-capabilities.ts`, the one place the CDK builds each
 * role's IAM policy from and the credential exchange vends against, so the document is a copy and
 * every copy drifts.
 *
 * WHAT IT CHECKS. Membership: a role the table marks as holding a capability is in that capability's
 * `roles`, a role the table marks `None` is not, every catalog key has exactly one row, and every row
 * names a catalog key. It does not check the "How it is controlled" or "Today" prose.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ADMIN_CAPABILITIES, ADMIN_ROLES, ADMIN_ROLE_GROUP, AdminRole } from '../lib/config/admin-capabilities';

const SPEC = path.join(__dirname, '..', '..', 'docs', 'specs', 'interface', 'SPEC-ADMIN-CONSOLE.md');

/** The role columns, in the order the published table renders them, after the Capability and Key columns. */
const COLUMNS: AdminRole[] = ['admins', 'team-members'];

/** A cell that names any reach at all means the role holds the capability; `None` means it does not. */
function cellHoldsCapability(cell: string): boolean {
  const v = cell.replace(/\*/g, '').trim();
  if (/^none\b/i.test(v)) return false;
  if (!v) throw new Error('An empty cell in the capability matrix. Name the reach, or write None.');
  return true;
}

interface PublishedRow { capability: string; holders: Set<AdminRole>; line: number }

/** Parse the capability matrix: the table under "Role-based capability matrix", keyed by its Key column. */
function publishedMatrix(): PublishedRow[] {
  const lines = fs.readFileSync(SPEC, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^### Role-based capability matrix\s*$/.test(l));
  if (start < 0) throw new Error('SPEC-ADMIN-CONSOLE has no "### Role-based capability matrix" section');
  const rows: PublishedRow[] = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('#'); i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const key = cells[1]?.match(/^`([a-z-]+)`$/)?.[1];
    if (!key) continue;
    const holders = new Set<AdminRole>();
    COLUMNS.forEach((role, n) => { if (cellHoldsCapability(cells[n + 2])) holders.add(role); });
    rows.push({ capability: key, holders, line: i + 1 });
  }
  return rows;
}

describe('the capability matrix the spec publishes', () => {
  const rows = publishedMatrix();

  it('publishes exactly one row for every capability in the catalog, and invents none', () => {
    expect(rows.map((r) => r.capability).sort()).toEqual(Object.keys(ADMIN_CAPABILITIES).sort());
  });

  it('names exactly the roles that hold each capability', () => {
    const wrong: string[] = [];
    for (const row of rows) {
      const inCode = new Set(ADMIN_CAPABILITIES[row.capability].roles);
      for (const role of COLUMNS) {
        const published = row.holders.has(role);
        if (published !== inCode.has(role)) {
          wrong.push(`  SPEC-ADMIN-CONSOLE.md:${row.line} - ${row.capability} / ${role}: the table says `
            + `${published ? 'it holds this' : 'None'}, the catalog says ${inCode.has(role) ? 'it holds this' : 'it does not'}`);
        }
      }
    }
    if (wrong.length) {
      throw new Error('The published capability matrix disagrees with `lib/config/admin-capabilities.ts`:\n'
        + `${wrong.join('\n')}\n\nThe catalog is the source of truth - the CDK builds the IAM policies `
        + 'from it. Update the table in SPEC-ADMIN-CONSOLE.md to match, and if the change was not '
        + 'intended, change the catalog instead.');
    }
  });

  it('covers every role the catalog declares, so a new role cannot be left out of the table', () => {
    expect([...COLUMNS].sort()).toEqual([...ADMIN_ROLES].sort());
  });

  it('names each role by the Cognito group a deployment actually assigns', () => {
    const text = fs.readFileSync(SPEC, 'utf8');
    for (const role of ADMIN_ROLES) expect(text).toContain(`\`${ADMIN_ROLE_GROUP[role]}\``);
  });
});
