/**
 * A RUNTIME ASSISTANT IS READ FROM ITS ASSIGNMENT RECORD (ADR-048).
 *
 * Every live assistant is assigned by the provisioner at `{root}/assistant-assignments/{classification}/{role}/
 * assistants/{assistantId}`, whoever asked for it (ADR-048, amended 2026-10-23). A DECLARED assistant's record
 * says `source: 'declared'`, and its descriptor is the deployment's profile in the registry; a CONSOLE-CREATED
 * one's says `source: 'runtime'`, and its descriptor is the record's own, which is what `runtimeSeedFor`
 * reads. A duel's alt is assigned at `{classification}/{role}/alt`, where an experiment names its occupant.
 *
 * The record carries what ADR-049 has not yet moved onto the versioned definition (`descriptor`), copied
 * once at creation. Everything a person sees comes from the assistant's own active version, and a
 * runtime assistant with no active version does not act: the vend refuses it.
 *
 * A record whose `status` is anything but `active` reads as absent everywhere, so retiring an assistant
 * stops it being admitted within the readers' cache window. An absent status is active.
 */
import type { AssistantProfile } from '../../../lib/config/profiles.js';
import { ASSISTANT_ID_PATTERN } from './assistant-acting-policy.js';

export type RuntimeAssistantStatus = 'provisioning' | 'active' | 'retiring' | 'retired';

/** An assignment record as its readers parse it. */
export interface AssignmentRecord {
  classification?: string;
  role?: string;
  occupancy?: string;
  assistant?: string | null;
  botArn?: string;
  lexBotId?: string;
  /**
   * Where the assistant's descriptor comes from: `runtime` (the record, for one created in the console) or
   * `declared` (the deployment's profile). Any value but `runtime` reads the registry.
   */
  source?: string;
  status?: RuntimeAssistantStatus;
  displayName?: string;
  /** `classifierModelKey` is the create's choice for the first draft's classifier model; a version carries it after. */
  descriptor?: { modelKey?: string; classifierMode?: string; rateLimitPerHour?: number; classifierModelKey?: string };
  ownerTeam?: string;
}

/** Whether a record admits its assistant: an absent status or `active`. */
export function isServingRecord(record: AssignmentRecord): boolean {
  return record.status === undefined || record.status === 'active';
}

/** The registry reads a runtime seed needs. */
export interface RuntimeSeedRegistry {
  isConversational(value: string | null | undefined): boolean;
  rolesFor(classification: string): string[];
  roleAssistantName(classification: string, role: string): string | undefined;
  profileByName(name: string): AssistantProfile | undefined;
  isReservedAssistantName(name: string): boolean;
}

/**
 * THE SEED FOR A RUNTIME ASSISTANT, from its record, or undefined when the record does not describe one.
 *
 * Its own fields come from the record: the name, the display name, the model, the classifier mode and the
 * rate limit. The two fields that describe the CLASSIFICATION's processor rather than the assistant -
 * the Lambda timeout and whether that processor's role may read attachments - come from its role's
 * deploy-time assistant, because the runtime assistant runs on that processor. That is ADR-048's layer
 * split, not a fallback from one assistant's settings to another's: no behavioral field is copied.
 *
 * Refuses (undefined) a record that is not `runtime`, not active, not a live occupancy, names a reserved
 * or unsafe id, or assigns a role or classification this deployment does not declare.
 */
export function runtimeSeedFor(record: AssignmentRecord, registry: RuntimeSeedRegistry): AssistantProfile | undefined {
  if (record.source !== 'runtime' || !isServingRecord(record) || record.occupancy !== 'live') return undefined;
  const name = record.assistant ?? '';
  const { classification = '', role = '' } = record;
  if (!ASSISTANT_ID_PATTERN.test(name) || registry.isReservedAssistantName(name)) return undefined;
  if (!registry.isConversational(classification) || !registry.rolesFor(classification).includes(role)) return undefined;
  const roleAssistant = registry.roleAssistantName(classification, role);
  const processor = roleAssistant ? registry.profileByName(roleAssistant) : undefined;
  const { modelKey, classifierMode, rateLimitPerHour } = record.descriptor ?? {};
  if (!processor || !modelKey || (classifierMode !== 'keyword' && classifierMode !== 'llm')) return undefined;
  return {
    name,
    ...(record.displayName ? { displayName: record.displayName } : {}),
    modelKey,
    classifierMode,
    timeoutSeconds: processor.timeoutSeconds,
    contextScope: 'granted',
    ...(typeof rateLimitPerHour === 'number' ? { rateLimitPerHour } : {}),
    ...(processor.attachmentsReadable !== undefined ? { attachmentsReadable: processor.attachmentsReadable } : {}),
    ...(record.ownerTeam ? { ownerTeam: record.ownerTeam } : {}),
  };
}
