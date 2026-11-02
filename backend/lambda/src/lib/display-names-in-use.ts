/**
 * THE NAMES ASSISTANTS SHOW IN ONE CLASSIFICATION, for refusing a second assistant that would show the same.
 *
 * `@` resolves an assistant by the name it shows, so two assistants in one classification showing one name
 * make a mention ambiguous. A create checks it (`manage-assistants`), and so does a rename, on the draft edit
 * and again at activation (`manage-profiles`), because a version carries the name and a rename that skipped
 * the check would put a duplicate in the room with nobody told.
 *
 * WHAT COUNTS AS SHOWN, conservatively: every declared assistant of the classification under its configured
 * name and its active version's name, and every runtime assistant (being created or active) under the name
 * it was created with and its active version's name. A name an assistant has stopped showing stays counted
 * while its create lock stands, which is the safe direction for an ambiguity check.
 */
import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { listDirectory } from './runtime-directory.js';

/** The display name an assistant's active version carries, or undefined when it has none or none is read. */
async function activeDisplayName(ssm: SSMClient, ssmRoot: string, assistant: string): Promise<string | undefined> {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `${ssmRoot}/assistant/${assistant}/definition:active` }));
    const name = (JSON.parse(res?.Parameter?.Value || '{}') as { displayName?: unknown }).displayName;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

/** How two display names compare: trimmed, case-insensitive. */
export const comparableName = (name: string): string => name.trim().toLowerCase();

/**
 * Every name shown in `classification`, compared form to the assistant showing it, leaving out `exclude` (the
 * assistant being renamed, which may keep its own name).
 */
export async function displayNamesInUse(
  ssm: SSMClient,
  ssmRoot: string,
  classification: string,
  exclude?: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const add = (name: string | undefined, assistant: string) => {
    if (!name || assistant === exclude) return;
    const key = comparableName(name);
    if (key && !out.has(key)) out.set(key, assistant);
  };
  for (const name of profiles.profileNames()) {
    if (profiles.classificationOfAssistant(name) !== classification || profiles.roleOfAlt(name)) continue;
    add(profiles.profileByName(name)?.displayName, name);
    add(await activeDisplayName(ssm, ssmRoot, name), name);
  }
  for (const [name, entry] of await listDirectory(ssm, ssmRoot)) {
    if (entry.classification !== classification || (entry.status !== 'active' && entry.status !== 'provisioning')) continue;
    add(entry.displayName, name);
    if (entry.status === 'active') add(await activeDisplayName(ssm, ssmRoot, name), name);
  }
  return out;
}

/** The assistant already showing `displayName` in the classification, or undefined when none does. */
export async function displayNameHolder(
  ssm: SSMClient,
  ssmRoot: string,
  classification: string,
  displayName: string,
  exclude?: string,
): Promise<string | undefined> {
  if (!displayName.trim()) return undefined;
  return (await displayNamesInUse(ssm, ssmRoot, classification, exclude)).get(comparableName(displayName));
}
