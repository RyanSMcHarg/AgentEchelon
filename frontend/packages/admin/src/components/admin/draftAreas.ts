/**
 * A DRAFT, READ AS ITS AREAS: the one place that says which version fields each edit card and wizard step
 * owns, what one sentence says about an area, and what changed against the active version.
 *
 * The cards, the creation wizard's steps and the diff all read these, so an area's fields are listed once. A field no
 * area owns (the intent pack, workflows, onboarding, the boundary, an experiment's tested instruction) is still in the diff, under
 * `other`, because a draft that changes it, by an import or the CLI, changes what activates.
 */
import type { ProfileDefinitionBody } from '../../services/profileService';

/** The areas, in the order the cards show them and the wizard walks them. */
export const DRAFT_AREAS = ['identity', 'abilities', 'settings', 'models', 'routing', 'messages', 'events', 'processes', 'variables'] as const;
export type DraftArea = typeof DRAFT_AREAS[number];

/**
 * Areas whose step is an explanation rather than a control: the field is edited as JSON (its decision in
 * `profile-field-decisions.ts`), and the step says where and how.
 */
export const EXPLAINED_AREAS: ReadonlySet<DraftArea> = new Set(['variables']);

type Body = Partial<ProfileDefinitionBody>;
type Workflows = NonNullable<ProfileDefinitionBody['eventWorkflows']>;

const isWelcome = (wf: { on?: string } | undefined) => wf?.on === 'assistant-joined';
const workflowsWhere = (b: Body, welcome: boolean): Workflows =>
  Object.fromEntries(Object.entries(b.eventWorkflows ?? {}).filter(([, wf]) => isWelcome(wf) === welcome));

/** The body fields each area owns, as `path -> value`. A path names the field a person would look for. */
export function areaFields(area: DraftArea, b: Body): Record<string, unknown> {
  switch (area) {
    case 'identity': return { displayName: b.displayName, persona: b.persona, boundary: b.boundary };
    case 'abilities': return { tools: b.tools, contextSources: b.contextSources };
    case 'settings': return { guardrailId: b.guardrailId };
    case 'models': {
      const { routing: _routing, ...models } = (b.models ?? {});
      return { models, modelKey: b.modelKey };
    }
    case 'routing': return { 'models.routing': b.models?.routing };
    case 'messages': return { messages: b.messages, copy: b.copy };
    case 'events': return {
      ...Object.fromEntries(Object.entries(b.eventWorkflows ?? {}).map(([n, wf]) => [`eventWorkflows.${n}`, wf])),
      welcome: b.welcome,
    };
    case 'processes': return Object.fromEntries(Object.entries(b.processes ?? {}).map(([n, p]) => [`processes.${n}`, p]));
    case 'variables': return { variables: b.variables };
  }
}

/** The top-level body fields some area owns; every other field changed is reported under `other`. */
const OWNED = new Set(['displayName', 'persona', 'tools', 'guardrailId', 'contextSources', 'models', 'modelKey', 'eventWorkflows', 'welcome', 'processes', 'messages', 'copy', 'variables']);

/** A value compared by content: keys sorted, absent and `undefined` alike. */
export function stable(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined && x !== null).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export type FieldChange = { path: string; change: 'added' | 'removed' | 'changed' };
export type AreaDiff = { area: DraftArea | 'other'; changes: FieldChange[] };

function compare(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = stable(before[path]);
    const b = stable(after[path]);
    if (a === b) continue;
    out.push({ path, change: !a ? 'added' : !b ? 'removed' : 'changed' });
  }
  return out;
}

/**
 * WHAT THE DRAFT CHANGES AGAINST THE ACTIVE VERSION, area by area, with every field no area owns under `other`.
 * With nothing active, `active` is null and every field the draft sets reads as added. Areas with no change are left out.
 */
export function draftDiff(active: Body | null, draft: Body): AreaDiff[] {
  const base = active ?? {};
  const out: AreaDiff[] = [];
  for (const area of DRAFT_AREAS) {
    const changes = compare(areaFields(area, base), areaFields(area, draft));
    if (changes.length) out.push({ area, changes });
  }
  const pickOther = (b: Body) => Object.fromEntries(Object.entries(b).filter(([k]) => !OWNED.has(k)));
  const other = compare(pickOther(base), pickOther(draft));
  if (other.length) out.push({ area: 'other', changes: other });
  return out;
}

/** The draft with a step's unsaved patch applied, as the step's preview reads it (`null` removes a field). */
export function withPatch(draft: Body, patch: Record<string, unknown>): Body {
  const out: Record<string, unknown> = { ...draft };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out as Body;
}

type T = (key: string, opts?: Record<string, unknown>) => string;

const isDefault = (m: string | undefined) => !m || m === 'default';

/** ONE SENTENCE ABOUT AN AREA, as its card and the wizard's preview say it. `profileName` names an unnamed assistant. */
export function areaSummary(area: DraftArea, b: Body, t: T, profileName = ''): string {
  const k = (key: string, opts?: Record<string, unknown>) => t(`admin.draftCards.summary.${key}`, opts);
  switch (area) {
    case 'identity': {
      const name = b.displayName?.trim() || profileName;
      return b.persona
        ? k('identityPersona', { name, count: b.persona.length })
        : k('identityNoPersona', { name });
    }
    case 'settings': return k('settings', { guardrail: b.guardrailId || k('guardrailDefault') });
    case 'abilities': {
      return k('abilities', { tools: b.tools?.length ?? 0, sources: b.contextSources?.length ?? 0 });
    }
    case 'models': {
      const m = (b.models ?? {});
      const base = m.default ?? b.modelKey;
      return k('models', {
        model: isDefault(base) ? k('modelDefault') : base,
        classifier: isDefault(m.classifier) ? k('classifierDefault') : m.classifier,
        count: Object.keys(m.byIntent ?? {}).length,
      });
    }
    case 'routing': {
      const n = b.models?.routing?.length ?? 0;
      return n ? k('routing', { count: n }) : k('routingNone');
    }
    case 'messages': {
      const n = Object.keys(b.messages ?? {}).length;
      return n ? k('messages', { count: n }) : k('messagesNone');
    }
    case 'events': {
      // The welcome first, as every version has one (its own, or the built-in), then the other workflows.
      const welcomes = Object.values(workflowsWhere(b, true));
      const types = [...new Set(welcomes.flatMap((wf) => wf.types ?? []))];
      const everyRoom = welcomes.some((wf) => !wf.types?.length);
      const welcome = !welcomes.length ? k('welcomePlatform')
        : k('welcome', { rooms: [...types, ...(everyRoom ? [k('welcomeEveryOtherRoom')] : [])].join(', ') });
      const others = Object.values(workflowsWhere(b, false));
      const rest = others.length ? k('events', { count: others.length, events: [...new Set(others.map((wf) => wf.on))].join(', ') }) : k('eventsNone');
      return `${welcome} ${rest}`;
    }
    case 'processes': {
      const labels = Object.values(b.processes ?? {}).map((p) => p.label);
      return labels.length ? k('processes', { count: labels.length, labels: labels.join(', ') }) : k('processesNone');
    }
    case 'variables': {
      const names = Object.keys(b.variables ?? {});
      return names.length ? k('variables', { count: names.length, names: names.join(', ') }) : k('variablesNone');
    }
  }
}
