/**
 * A CONVERSATION TYPE'S TRANSPORTS AND CAPABILITIES, RESOLVED AGAINST WHAT THE DEPLOYMENT DECLARES (T4, D12).
 *
 * A type declares the transports an experience may use (`commsChannels`, FR7) and the capabilities beyond
 * drift it has (`capabilities`, FR9). Whether a deployment can serve one is its declared capability list
 * (`capabilities` in `deploy.config.json`, `lib/config/capabilities.ts`): an email transport needs
 * `notifications`, a duel needs `battle`. A type declaring something the deployment does not have DEGRADES:
 * the dimension resolves off, the gap is recorded (FR14), and the conversation is created as it always was.
 * Nothing here ever refuses a conversation.
 *
 * Resolved once, at synth, by `bin/backend.ts` for every registered type, and recorded on `PersonApi` as the
 * `ConversationTypeGaps` output, so an operator sees what each declared-but-unserved dimension is waiting on.
 * Pure: the same resolution is importable by a handler that is told the declared list.
 */
import { CONVERSATION_TYPES, getConversationTypeConfig, type CommsChannel } from './conversation-types';

/**
 * What each transport needs. `core` is every deployment; a transport with no deployable provider is
 * **NOT BUILT** and never resolves on, whatever is declared.
 */
export const TRANSPORT_NEEDS: Readonly<Record<string, string>> = {
  chat: 'core',
  email: 'notifications',
  briefing: 'notifications',
  video: 'meetings',
  voice: 'not-built',
  sms: 'not-built',
};

/** What each type capability needs. A capability not listed here is unknown and resolves off, recorded. */
export const CAPABILITY_NEEDS: Readonly<Record<string, string>> = {
  tasks: 'core',
  attachments: 'core',
  sharing: 'notifications',
  battle: 'battle',
};

/** One dimension a type declares on that this deployment cannot serve. */
export interface TypeCapabilityGap {
  typeKey: string;
  dimension: 'commsChannels' | 'capabilities';
  value: string;
  /** The capability it needs, `not-built` for a transport no provider serves, `unknown` for one nobody declares. */
  needs: string;
}

/** A type's dimensions as this deployment serves them. */
export interface ResolvedTypeCapabilities {
  typeKey: string;
  commsChannels: CommsChannel[];
  capabilities: Record<string, boolean>;
  gaps: TypeCapabilityGap[];
}

function served(needs: string | undefined, declared: ReadonlySet<string>): boolean {
  if (!needs) return false;
  if (needs === 'core') return true;
  return declared.has(needs);
}

/**
 * A type's transports and capabilities against the declared capability list. A type that declares no
 * transports has chat, as it always has; a capability declared off stays off and is no gap.
 */
export function resolveTypeForDeployment(typeKey: string, declared: readonly string[]): ResolvedTypeCapabilities {
  const config = getConversationTypeConfig(typeKey);
  const have = new Set(declared);
  const gaps: TypeCapabilityGap[] = [];
  const commsChannels: CommsChannel[] = [];
  for (const channel of config.commsChannels ?? ['chat']) {
    const needs = TRANSPORT_NEEDS[channel];
    if (served(needs, have)) commsChannels.push(channel);
    else gaps.push({ typeKey, dimension: 'commsChannels', value: channel, needs: needs ?? 'unknown' });
  }
  // A conversation is always a chat: its hub transport is never resolved away.
  if (!commsChannels.includes('chat')) commsChannels.unshift('chat');
  const capabilities: Record<string, boolean> = {};
  for (const [name, on] of Object.entries(config.capabilities ?? {})) {
    if (!on) { capabilities[name] = false; continue; }
    const needs = CAPABILITY_NEEDS[name];
    const ok = served(needs, have);
    capabilities[name] = ok;
    if (!ok) gaps.push({ typeKey, dimension: 'capabilities', value: name, needs: needs ?? 'unknown' });
  }
  return { typeKey, commsChannels, capabilities, gaps };
}

/** Every registered type's gaps against the declared list, in registry order. */
export function typeCapabilityGaps(declared: readonly string[]): TypeCapabilityGap[] {
  return Object.keys(CONVERSATION_TYPES).flatMap((key) => resolveTypeForDeployment(key, declared).gaps);
}

/** The gaps as one line each, for the synth record. */
export function describeGap(g: TypeCapabilityGap): string {
  const why = g.needs === 'not-built' ? 'no provider is built' : g.needs === 'unknown' ? 'no capability serves it' : `needs the ${g.needs} capability`;
  return `${g.typeKey}: ${g.dimension === 'commsChannels' ? 'transport' : 'capability'} ${g.value} is off (${why})`;
}
