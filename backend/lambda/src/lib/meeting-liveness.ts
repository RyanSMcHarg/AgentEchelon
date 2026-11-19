/**
 * WHETHER A MEETING RUNS NOW, for the console's Meetings tab (SPEC-ASSISTANT-MEETINGS FR48).
 *
 * Live is current state, so it is read from the source rather than from the recorded events (tenet D7): the meeting's
 * conversation must still hold it as its `activeMeeting`, AND Amazon Chime SDK must still run it (`meetingRunsNow`, the
 * router's own check). A record alone never reads as live: a conversation can keep a record for a meeting the service
 * has already ended, until the next start or join releases it. A meeting whose events hold its end is not live, and
 * nothing is asked about it.
 *
 * `null` means the question could not be answered (a read that failed, or past the checks one answer makes), and the
 * console says so rather than guessing either way.
 */
import { readChannelContext } from './channel-context-client.js';
import { meetingRunsNow } from './meeting-run.js';

/** The most meetings one answer asks the service about; the rest of a window's unended meetings answer `null`. */
export const MAX_LIVENESS_CHECKS = 40;
/** How many of those questions are in flight at once. */
const IN_FLIGHT = 8;

export interface LivenessDeps {
  readRecord: (channelArn: string) => Promise<{ meetingId?: string } | null | undefined>;
  runs: (meetingId: string) => Promise<boolean>;
}

const defaults: LivenessDeps = {
  readRecord: async (channelArn) => (await readChannelContext(channelArn, { consistent: true }))?.activeMeeting ?? null,
  runs: meetingRunsNow,
};
let deps: LivenessDeps = defaults;
/** Test seam: the record read and the service's answer. */
export function __setLivenessDeps(next: Partial<LivenessDeps> | null): void { deps = next ? { ...defaults, ...next } : defaults; }

/** One meeting: true while its conversation holds it and the service runs it, false once either says not, null when unknown. */
export async function meetingIsLive(m: { meetingId: string; channelArn: string; endedAt: string | null }): Promise<boolean | null> {
  if (m.endedAt) return false;
  if (!m.meetingId || !m.channelArn) return false;
  try {
    const recorded = await deps.readRecord(m.channelArn);
    if (recorded?.meetingId !== m.meetingId) return false;
    return await deps.runs(m.meetingId);
  } catch (err) {
    console.warn('[meeting-liveness] whether a meeting runs could not be read', { meetingId: m.meetingId, err: (err as Error).name });
    return null;
  }
}

/**
 * Each meeting's liveness, keyed by meeting id: an ended one is false without a question; the newest
 * {@link MAX_LIVENESS_CHECKS} unended ones are asked; any further unended one is null.
 */
export async function livenessOf(meetings: Array<{ meetingId: string; channelArn: string; endedAt: string | null; startedAt: string | null }>): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  const unended = meetings.filter((m) => !m.endedAt).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  for (const m of meetings) if (m.endedAt) out.set(m.meetingId, false);
  for (const m of unended.slice(MAX_LIVENESS_CHECKS)) out.set(m.meetingId, null);
  const asked = unended.slice(0, MAX_LIVENESS_CHECKS);
  for (let i = 0; i < asked.length; i += IN_FLIGHT) {
    const batch = asked.slice(i, i + IN_FLIGHT);
    const answers = await Promise.all(batch.map((m) => meetingIsLive(m)));
    batch.forEach((m, j) => out.set(m.meetingId, answers[j]));
  }
  return out;
}
