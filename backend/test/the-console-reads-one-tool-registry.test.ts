/**
 * THERE IS ONE TOOL REGISTRY, AND THE CONSOLE READS IT RATHER THAN RESTATING IT.
 *
 * `tool-registry.ts` declares itself the single source of the tool names and descriptions that render
 * "the admin console's per-tool 'what it does / how it functions' surface". It could not: it is a Lambda
 * module and the admin console is a separate browser build. So the console carried a hand-written mirror
 * (`services/toolRegistry.ts`, "kept in sync by hand - the tool set is small and stable"), and it went
 * stale in exactly the way a second copy does.
 *
 * MEASURED, not hypothetical: the mirror was missing `read_deployment_health` and `open_work_summary`.
 * The first is the only tool the ops assistant exists to use, so an operator reviewing that profile saw
 * it listed with no description at all - and the draft editor's checkbox list was built from the mirror's
 * keys, so neither tool could be switched off there.
 *
 * The registry is now served with the profile listing (`manage-profiles` GET). These guard the property
 * that makes that worth doing: no copy comes back.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TOOL_REGISTRY } from '../lambda/src/lib/tool-registry';

const REPO_ROOT = path.join(__dirname, '../..');
const MIRROR = path.join(REPO_ROOT, 'frontend/packages/admin/src/services/toolRegistry.ts');
const CONSOLE_FILES = [
  'frontend/packages/admin/src/components/admin/ProfilesTab.tsx',
  'frontend/packages/admin/src/services/profileService.ts',
];

describe('the admin console holds no second copy of the tool registry', () => {
  it('the hand-kept mirror module is gone', () => {
    expect(fs.existsSync(MIRROR)).toBe(false);
  });

  it('scans the console files it names (a scan of nothing passes vacuously)', () => {
    for (const rel of CONSOLE_FILES) expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
  });

  it('no console file restates a registry description', () => {
    // The first eight words of each registry description. Long enough that an ordinary sentence cannot
    // collide with one, short enough to still match a copy somebody reflowed.
    const offenders: string[] = [];
    for (const rel of CONSOLE_FILES) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      for (const tool of TOOL_REGISTRY) {
        const opening = tool.description.split(/\s+/).slice(0, 8).join(' ');
        if (src.includes(opening)) offenders.push(`${rel}: restates ${tool.name}`);
      }
    }
    if (offenders.length) {
      throw new Error(
        'A tool description belongs to the backend registry, which validates a profile\'s `tools` against\n'
        + 'it. The console reads the registry from the profile listing; a copy here drifts the moment a\n'
        + 'tool is added, and the symptom is a tool an operator cannot see or switch off.\n\n'
        + offenders.join('\n'),
      );
    }
    expect(offenders).toEqual([]);
  });
});
