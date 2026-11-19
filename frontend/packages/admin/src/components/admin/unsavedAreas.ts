/**
 * A DRAFT'S UNSAVED EDITS, HELD PER AREA (SPEC-ADMIN-CONSOLE "Assistants").
 *
 * An area's controls report a patch once edited, and that patch is kept here, by area, rather than in the controls. So
 * an edit outlives the controls that made it: switching sections, the Active/Draft toggle and a wizard step all keep it,
 * and saving one area leaves every other area's unsaved edit in place, laid over the draft that save produced.
 *
 * Two areas share a body field: the models and the routing rules both write `models`. The workflows area owns every
 * workflow, the welcome included, so `eventWorkflows` is one area's. An area's patch is therefore read as ITS OWN PART of that field (`rebase`), laid
 * over the latest draft, so saving one never carries back another area's older value of the shared field.
 */
import { areaFields, stable, withPatch, type DraftArea } from './draftAreas';
import type { ProfileDefinitionBody, ProfileDraftPatch } from '../../services/profileService';

/** The unsaved patch of every area that has one. */
export type Unsaved = Partial<Record<DraftArea, ProfileDraftPatch>>;

type Body = Partial<ProfileDefinitionBody>;


/**
 * AN AREA'S PATCH, LAID OVER THE LATEST DRAFT: its own part of a shared field from the patch, every other part from the
 * draft. An area that shares no field is its patch as it stands.
 */
export function rebase(area: DraftArea, draft: Body, patch: ProfileDraftPatch): ProfileDraftPatch {
  if (area === 'models' && 'models' in patch) {
    const { routing: _mine, ...rest } = patch.models ?? {};
    const routing = (draft.models ?? {}).routing;
    return { ...patch, models: routing ? { ...rest, routing } : rest };
  }
  if (area === 'routing' && 'models' in patch) {
    const { routing: _theirs, ...rest } = (draft.models ?? {});
    const routing = patch.models?.routing;
    return { ...patch, models: routing ? { ...rest, routing } : rest };
  }
  return patch;
}

/** The draft as an area's controls start from it: the saved draft with that area's unsaved edit laid over it. */
export function draftWith(area: DraftArea, draft: ProfileDefinitionBody, patch: ProfileDraftPatch | undefined): ProfileDefinitionBody {
  return patch ? withPatch(draft, rebase(area, draft, patch) as Record<string, unknown>) as ProfileDefinitionBody : draft;
}

/**
 * ONE PATCH FOR SEVERAL AREAS' UNSAVED EDITS, each laid over the draft the one before it produced, so two areas that
 * share a field are both kept. Each field the areas touch is sent: its value, or `null` where the result removes it.
 */
export function combinedPatch(draft: ProfileDefinitionBody, unsaved: Unsaved, areas: readonly DraftArea[]): ProfileDraftPatch {
  let body: Body = draft;
  const touched = new Set<string>();
  for (const area of areas) {
    const p = unsaved[area];
    if (!p) continue;
    const laid = rebase(area, body, p);
    for (const k of Object.keys(laid)) touched.add(k);
    body = withPatch(body, laid as Record<string, unknown>);
  }
  const out: Record<string, unknown> = {};
  for (const k of touched) out[k] = (body as Record<string, unknown>)[k] ?? null;
  return out as ProfileDraftPatch;
}

/** Where a newer draft changed a field an area's unsaved edit also holds, by the field's path (`areaFields`). */
export interface Overlap { area: DraftArea; fields: string[] }

type Workflows = NonNullable<ProfileDefinitionBody['eventWorkflows']>;

/**
 * THE UNSAVED EDITS, CARRIED ONTO A DRAFT SAVED ELSEWHERE SINCE THEY WERE MADE over `before`.
 *
 * The events area's patch holds the whole workflow map, so it is rebased workflow by workflow: a workflow this person
 * added, changed or removed against `before` is theirs, and every other workflow is the newer draft's, so saving the
 * edit keeps what the other writer did to the rest. Every other area's edit is kept as it stands. Wherever the newer draft
 * also changed a field an edit holds (a workflow both changed, or any field of another area), that field is named in
 * `overlaps`, because saving the edit replaces the other writer's change to it. An edit that comes to say nothing the
 * newer draft does not already say is dropped.
 */
export function rebaseOnto(unsaved: Unsaved, before: Body, newer: Body): { unsaved: Unsaved; overlaps: Overlap[] } {
  const out: Unsaved = {};
  const overlaps: Overlap[] = [];
  for (const area of unsavedAreas(unsaved)) {
    let patch: ProfileDraftPatch = unsaved[area]!;
    const fields: string[] = [];
    if (area === 'events' && 'eventWorkflows' in patch) {
      const mine = (patch.eventWorkflows ?? {}) as Workflows;
      const base = (before.eventWorkflows ?? {}) as Workflows;
      const theirs = (newer.eventWorkflows ?? {}) as Workflows;
      const merged: Workflows = {};
      for (const name of [...new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])].sort()) {
        const changedByMe = stable(mine[name]) !== stable(base[name]);
        const changedByThem = stable(theirs[name]) !== stable(base[name]);
        const kept = changedByMe ? mine[name] : theirs[name];
        if (kept !== undefined) merged[name] = kept;
        if (changedByMe && changedByThem && stable(mine[name]) !== stable(theirs[name])) fields.push(`eventWorkflows.${name}`);
      }
      patch = { ...patch, eventWorkflows: merged };
    }
    // Every other field the edit holds: where the newer draft changed it, and the edit says something else.
    const laid = areaFields(area, withPatch(newer, rebase(area, newer, patch) as Record<string, unknown>));
    const was = areaFields(area, before);
    const now = areaFields(area, newer);
    const held = new Set(Object.keys(patch));
    for (const path of Object.keys({ ...was, ...now, ...laid })) {
      if (area === 'events' && path.startsWith('eventWorkflows.')) continue;
      if (!held.has(path.split('.')[0])) continue;
      if (stable(was[path]) !== stable(now[path]) && stable(laid[path]) !== stable(now[path])) fields.push(path);
    }
    const saysSomething = 'layout' in patch
      || Object.keys({ ...now, ...laid }).some((path) => stable(laid[path]) !== stable(now[path]));
    if (saysSomething) out[area] = patch;
    if (fields.length) overlaps.push({ area, fields });
  }
  return { unsaved: out, overlaps };
}

/** The areas with an unsaved edit, among those given (all of them when none are). */
export function unsavedAreas(unsaved: Unsaved, among?: readonly DraftArea[]): DraftArea[] {
  return (Object.keys(unsaved) as DraftArea[]).filter((a) => unsaved[a] && Object.keys(unsaved[a]!).length && (!among || among.includes(a)));
}
