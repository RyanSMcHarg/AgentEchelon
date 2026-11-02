/**
 * THE ASSISTANT DIRECTORY (ADR-048): the admin plane's index of every provisioner-owned assistant by name,
 * declared or created in the console (`origin`). A declared assistant's entry is also its seed record: a deploy
 * builds a declared assistant only when no entry names it, so a retired one is never recreated.
 *
 * `{root}/assistant-directory/{assistantId}` holds `{ classification, role, botArn, status, createdAt }`.
 * `manage-assistants` writes it first with `Overwrite: false`, which makes it the lock on a name, and never
 * deletes it: a retired entry is a tombstone, because analytics and profile history are keyed by the name,
 * so a name is never reused. It lives outside `/assistant/*` on purpose, because `manage-profiles` may
 * write anything under `/assistant/*` and must not be able to forge an identity record.
 *
 * The turn path does not read it. It reads the assignment record, which is the authority for a role's assistant; this
 * is how the admin plane finds that record from a name.
 */
import { createHash } from 'crypto';
import { GetParameterCommand, GetParametersByPathCommand, type SSMClient } from '@aws-sdk/client-ssm';
import type { AssistantProfile } from '../../../lib/config/profiles.js';
import { defaultProfileRegistry } from '../../../lib/profile-registry';
import { runtimeSeedFor, type AssignmentRecord, type RuntimeAssistantStatus } from './runtime-assistant.js';

export interface DirectoryEntry {
  classification: string;
  role: string;
  /**
   * How the assistant was asked for: `declared` in the deployment's `profiles` and seeded by a deploy, or
   * created in the `console`. Absent on an entry written before the field existed, which the console wrote.
   * A detail, never a capability: every assistant with an entry is renamed, owned and retired the same way.
   */
  origin?: 'declared' | 'console';
  /** `alt` for a duel's challenger, whose record is `{classification}/{role}/alt`. Absent: `live`. */
  occupancy?: 'live' | 'alt';
  botArn?: string;
  lexBotId?: string;
  /** `failed` when a create could not finish or clean up after itself; `leftover` says what remains. */
  status: RuntimeAssistantStatus | 'failed';
  createdAt?: string;
  createdBy?: string;
  displayName?: string;
  descriptor?: AssignmentRecord['descriptor'];
  ownerTeam?: string;
  error?: string;
  leftover?: string[];
  retiredAt?: string;
  retiredBy?: string;
  reason?: string;
  /** Set while retiring a build that never finished, so a retire completed later still releases the name. */
  neverAnswered?: boolean;
  /** Why the build could not put `ownerTeam` on the identity's `owner-team` tag: the team cannot open it yet. */
  ownerSeedError?: string;
  /** Why the build could not seed the first draft; "new version" in the console seeds it again. */
  firstDraftError?: string;
}

export const directoryParamName = (ssmRoot: string, assistantId: string): string =>
  `${ssmRoot}/assistant-directory/${assistantId}`;

export const runtimeAssignmentParamName = (ssmRoot: string, classification: string, role: string, assistantId: string): string =>
  `${ssmRoot}/assistant-assignments/${classification}/${role}/assistants/${assistantId}`;

/**
 * THE BUILD CLAIM. Written with `Overwrite: false` by the asynchronous build before it creates anything,
 * so a duplicated or retried invoke finds it taken and builds nothing. Under the directory tree but at a
 * name no assistant id can have (`_` cannot start one), and below the level the directory listing reads.
 */
export const buildClaimParamName = (ssmRoot: string, assistantId: string): string =>
  `${ssmRoot}/assistant-directory/_build/${assistantId}`;

/**
 * THE DISPLAY-NAME LOCK, per classification. `@` resolves an assistant by the name it shows, and the
 * directory lock covers the id only, so two creates showing the same name could both pass the record
 * check while neither had a record yet. Keyed by a hash because a display name may hold characters an
 * SSM parameter name cannot.
 */
export const displayNameLockParamName = (ssmRoot: string, classification: string, displayName: string): string =>
  `${ssmRoot}/assistant-directory/_name/${classification}/${createHash('sha256').update(displayName.trim().toLowerCase()).digest('hex').slice(0, 40)}`;

/** The build deadline and an abandoned build's reading, said once in the pure module a script also loads. */
export { BUILD_DEADLINE_MS, withAbandonedBuild } from './role-filling.js';

const isNotFound = (err: unknown): boolean => (err as { name?: string })?.name === 'ParameterNotFound';

/** The directory entry for a name, or null when there is none. Any other read failure throws. */
export async function readDirectoryEntry(ssm: SSMClient, ssmRoot: string, assistantId: string): Promise<DirectoryEntry | null> {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: directoryParamName(ssmRoot, assistantId) }));
    return res?.Parameter?.Value ? JSON.parse(res.Parameter.Value) as DirectoryEntry : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * An ACTIVE runtime assistant by name: its directory entry, its assignment record and the seed that record
 * produces. Null when the name has no entry, the entry is not active, the record is missing, or the record
 * does not describe a valid assistant. A compiled name is never a runtime assistant.
 */
export async function readRuntimeAssistant(
  ssm: SSMClient,
  ssmRoot: string,
  assistantId: string,
): Promise<{ entry: DirectoryEntry; record: AssignmentRecord; seed: AssistantProfile } | null> {
  if (!assistantId || defaultProfileRegistry.isReservedAssistantName(assistantId)) return null;
  const entry = await readDirectoryEntry(ssm, ssmRoot, assistantId);
  if (!entry || entry.status !== 'active') return null;
  let record: AssignmentRecord;
  try {
    const res = await ssm.send(new GetParameterCommand({
      Name: runtimeAssignmentParamName(ssmRoot, entry.classification, entry.role, assistantId),
    }));
    record = JSON.parse(res?.Parameter?.Value || '{}') as AssignmentRecord;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const seed = record.assistant === assistantId ? runtimeSeedFor(record, defaultProfileRegistry) : undefined;
  return seed ? { entry, record, seed } : null;
}

/** Every directory entry by name, tombstones included, paged. */
export async function listDirectory(ssm: SSMClient, ssmRoot: string): Promise<Map<string, DirectoryEntry>> {
  const out = new Map<string, DirectoryEntry>();
  const prefix = `${ssmRoot}/assistant-directory/`;
  let token: string | undefined;
  do {
    const res = await ssm.send(new GetParametersByPathCommand({ Path: `${ssmRoot}/assistant-directory`, MaxResults: 10, NextToken: token }));
    for (const p of res?.Parameters || []) {
      try {
        if (p.Name?.startsWith(prefix) && p.Value) out.set(p.Name.slice(prefix.length), JSON.parse(p.Value) as DirectoryEntry);
      } catch {
        // An entry this reader cannot parse lists nothing.
      }
    }
    token = res?.NextToken;
  } while (token);
  return out;
}
