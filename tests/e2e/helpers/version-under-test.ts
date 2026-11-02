/**
 * AN ASSISTANT VERSION A SPEC ACTIVATES FOR ITS RUN, AND THE ONE IT RETURNS TO (ADR-047's lifecycle, through the console's
 * signed routes).
 *
 * The draft starts as a copy of the active version, so everything the assistant already says is kept and a spec adds
 * only what it proves: `patchFor` reads the draft's exported body and returns the patch. Validation must come back
 * with no errors before the version is activated, so a spec never runs against a version the console would refuse.
 * The version that was active is returned, and `returnToVersion` activates it again afterwards.
 */
import { expect } from '@playwright/test';
import { signedCall, type VendedCredentials } from './admin-api';
import { adminUrl } from './api-urls';

/** The served version is cached by the router and the processor for 30 seconds; a spec waits this long after activating. */
export const SERVED_VERSION_TTL_MS = 35_000;

/** The parts of an exported version body a patch is computed from. */
export interface VersionBody {
  eventWorkflows?: Record<string, any>;
  workflows?: string[];
  [key: string]: unknown;
}

/**
 * Activate a new version of `profileName` with `patchFor(draftBody)` applied. Returns the version that was active
 * before, which the caller hands to `returnToVersion` in its `afterAll`.
 */
export async function activateVersionWith(
  admin: VendedCredentials,
  profileName: string,
  patchFor: (body: VersionBody) => Record<string, unknown>,
): Promise<number> {
  const listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), admin);
  const previous = (listing.body?.profiles ?? []).find((p: any) => p.profileName === profileName)?.activeVersion;
  expect(previous, `${profileName} has no active version to return to`).toBeDefined();

  const created = await signedCall(adminUrl('assistant-admin', '/admin/profiles/version'), admin, 'POST', { profileName });
  expect(created.status, JSON.stringify(created.body).slice(0, 400)).toBe(200);
  const exported = await signedCall(adminUrl('assistant-admin', '/admin/profiles/export'), admin, 'POST', { profileName, draft: true });
  expect(exported.status, JSON.stringify(exported.body).slice(0, 400)).toBe(200);
  const patch = patchFor((exported.body?.manifest?.body ?? {}) as VersionBody);

  const edited = await signedCall(adminUrl('assistant-admin', '/admin/profiles/draft'), admin, 'POST', { profileName, patch });
  expect(edited.status, JSON.stringify(edited.body).slice(0, 400)).toBe(200);
  const valid = await signedCall(adminUrl('assistant-admin', '/admin/profiles/validate'), admin, 'POST', { profileName });
  expect(valid.body?.errors ?? [], JSON.stringify(valid.body).slice(0, 600)).toEqual([]);
  const activated = await signedCall(adminUrl('assistant-admin', '/admin/profiles/activate'), admin, 'POST', { profileName });
  expect(activated.status, JSON.stringify(activated.body).slice(0, 400)).toBe(200);
  return previous as number;
}

/** Activate `version` of `profileName` again. Logs, never throws, so the rest of a cleanup still runs. */
export async function returnToVersion(admin: VendedCredentials, profileName: string, version: number): Promise<void> {
  const back = await signedCall(adminUrl('assistant-admin', '/admin/profiles/rollback'), admin, 'POST', { profileName, version }).catch(() => undefined);
  if (back?.status !== 200) console.warn(`cleanup: ${profileName} was not returned to version ${version}: ${JSON.stringify(back?.body ?? {}).slice(0, 300)}`);
}

/** A version's own event workflows without any declared on `events`: a version declares at most one per selecting event. */
export function workflowsOffEvents(body: VersionBody, events: readonly string[]): Record<string, any> {
  return Object.fromEntries(Object.entries(body.eventWorkflows ?? {}).filter(([, wf]) => !events.includes(wf?.on)));
}

/**
 * A VERSION'S EVENT WORKFLOWS WITH `name` ANSWERING FOR THE ROOMS ITS `types` NAME (W1). The room's conversation type
 * selects one workflow per event, so every other workflow on the same event that would answer in those rooms is left
 * out: one with no `types` where `wf` names none, one sharing a type where it names some, and one naming any type in
 * `replacing` (a welcome for every room also answers in a type no other welcome names, so a spec that wants its welcome
 * in `general` rooms replaces a `general` one).
 */
export function withWorkflowFor(body: VersionBody, name: string, wf: Record<string, any>, replacing: readonly string[] = []): Record<string, any> {
  const types: string[] = wf.types ?? [];
  const answersHere = (other: Record<string, any>) => {
    const theirs: string[] = other?.types ?? [];
    if (other?.on !== wf.on) return false;
    if (theirs.some((t) => types.includes(t) || replacing.includes(t))) return true;
    return !types.length && !theirs.length;
  };
  const kept = Object.fromEntries(Object.entries(body.eventWorkflows ?? {}).filter(([n, other]) => n !== name && !answersHere(other)));
  return { ...kept, [name]: wf };
}
