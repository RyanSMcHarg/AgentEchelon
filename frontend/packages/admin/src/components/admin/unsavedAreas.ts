/**
 * A DRAFT'S UNSAVED EDITS, HELD PER AREA (SPEC-ADMIN-CONSOLE "Assistants").
 *
 * An area's controls report a patch once edited, and that patch is kept here, by area, rather than in the controls. So
 * an edit outlives the controls that made it: switching sections, the Active/Draft toggle and a wizard step all keep it,
 * and saving one area leaves every other area's unsaved edit in place, laid over the draft that save produced.
 *
 * Two areas share a body field: the welcome and the event workflows both write `eventWorkflows`, and the models and the
 * routing rules both write `models`. An area's patch is therefore read as ITS OWN PART of that field (`rebase`), laid
 * over the latest draft, so saving one never carries back another area's older value of the shared field.
 */
import { withPatch, type DraftArea } from './draftAreas';
import type { ProfileDefinitionBody, ProfileDraftPatch } from '../../services/profileService';

/** The unsaved patch of every area that has one. */
export type Unsaved = Partial<Record<DraftArea, ProfileDraftPatch>>;

type Body = Partial<ProfileDefinitionBody>;
type Workflows = NonNullable<ProfileDefinitionBody['eventWorkflows']>;

const isWelcome = (wf: { on?: string } | undefined) => wf?.on === 'assistant-joined';
const ofKind = (wfs: Workflows | null | undefined, welcome: boolean): Workflows =>
  Object.fromEntries(Object.entries(wfs ?? {}).filter(([, wf]) => isWelcome(wf) === welcome));

/**
 * AN AREA'S PATCH, LAID OVER THE LATEST DRAFT: its own part of a shared field from the patch, every other part from the
 * draft. An area that shares no field is its patch as it stands.
 */
export function rebase(area: DraftArea, draft: Body, patch: ProfileDraftPatch): ProfileDraftPatch {
  if ((area === 'welcome' || area === 'events') && 'eventWorkflows' in patch) {
    const welcome = area === 'welcome';
    const merged = { ...ofKind(draft.eventWorkflows, !welcome), ...ofKind(patch.eventWorkflows, welcome) };
    return { ...patch, eventWorkflows: Object.keys(merged).length ? merged : null };
  }
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

/** The areas with an unsaved edit, among those given (all of them when none are). */
export function unsavedAreas(unsaved: Unsaved, among?: readonly DraftArea[]): DraftArea[] {
  return (Object.keys(unsaved) as DraftArea[]).filter((a) => unsaved[a] && Object.keys(unsaved[a]!).length && (!among || among.includes(a)));
}
