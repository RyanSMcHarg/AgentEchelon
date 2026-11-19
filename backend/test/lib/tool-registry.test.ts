/**
 * Per-profile tools (SPEC-ASSISTANT-CONFIG §4): the registry vocabulary + the allowlist filter the
 * Converse loop applies to intersect runtime-available tools with a profile's permitted set.
 */
import { TOOL_REGISTRY, ALL_TOOL_NAMES, isKnownTool, unknownTools, toolOfferedToRole } from '../../lambda/src/lib/tool-registry';
import { observabilityRoles } from '../../lib/stacks/agent-classification-common';
import { filterToolSpecsByProfile } from '../../lambda/src/lib/async-processor-core';

const spec = (name: string) => ({ toolSpec: { name } });

describe('tool registry', () => {
  it('every descriptor has a name, category, and description; names are unique', () => {
    expect(ALL_TOOL_NAMES.length).toBe(TOOL_REGISTRY.length);
    expect(new Set(ALL_TOOL_NAMES).size).toBe(ALL_TOOL_NAMES.length);
    for (const t of TOOL_REGISTRY) {
      expect(t.name).toBeTruthy();
      expect(t.category).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it('knows the loop tools and rejects strangers', () => {
    expect(isKnownTool('advance_task_state')).toBe(true);
    expect(isKnownTool('add_item')).toBe(true);
    expect(isKnownTool('nonexistent')).toBe(false);
    expect(unknownTools(['advance_task_state', 'nope'])).toEqual(['nope']);
  });
});

describe('filterToolSpecsByProfile — per-profile allowlist ∩ runtime-available', () => {
  const available = [spec('load_company_context'), spec('advance_task_state'), spec('add_item')];

  it('undefined allowlist ⇒ all available (byte-identical to the pre-allowlist path)', () => {
    expect(filterToolSpecsByProfile(available, undefined)).toEqual(available);
  });

  it('restricts to the intersection of allowed and available', () => {
    const out = filterToolSpecsByProfile(available, ['advance_task_state', 'search_corporate_travel']);
    expect(out.map((t) => t.toolSpec.name)).toEqual(['advance_task_state']); // travel not available this turn
  });

  it('an empty allowlist offers nothing', () => {
    expect(filterToolSpecsByProfile(available, [])).toEqual([]);
  });
});

describe('a tool whose precondition is a role', () => {
  it('offers read_deployment_health to the ops role only, and to no turn holding no role', () => {
    expect(toolOfferedToRole('read_deployment_health', 'ops')).toBe(true);
    expect(toolOfferedToRole('read_deployment_health', 'primary')).toBe(false);
    expect(toolOfferedToRole('read_deployment_health', '')).toBe(false);
  });

  it('offers a tool with no role precondition to every role', () => {
    expect(toolOfferedToRole('load_company_context', 'primary')).toBe(true);
    expect(toolOfferedToRole('load_company_context', '')).toBe(true);
  });

  it('grants telemetry to exactly the roles the tool is offered to', () => {
    expect(observabilityRoles(['primary', 'ops', 'research'])).toEqual(['ops']);
  });
});

describe('the telemetry grant fails closed', () => {
  it('names only the roles the health tool names, and a tool naming none would grant none', () => {
    const { toolRolesOf } = jest.requireActual('../../lambda/src/lib/tool-registry');
    expect(toolRolesOf('read_deployment_health')).toEqual(['ops']);
    // The guard is in the grant itself: a tool with no `roles` is offered to every role, which must never become
    // telemetry for every assistant.
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../lib/stacks/agent-classification-common.ts'), 'utf8');
    expect(src).toContain("if (!(toolRolesOf('read_deployment_health') ?? []).length) return [];");
  });
});
