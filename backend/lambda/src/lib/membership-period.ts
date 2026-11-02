/**
 * THE PERIOD AN ASSISTANT WAS IN A CONVERSATION (SPEC-ADMIN-CONSOLE, "Membership period").
 *
 * A team reads a conversation because an assistant it owns was a member of it, and that reason reaches
 * only the turns from while the assistant was there. Without the bound, adding an assistant to a
 * conversation would widen its team's read to the whole history.
 *
 * The periods come from the archived membership timeline, the system of record for who joined and left
 * (the Amazon Chime SDK has no membership-history API). Fails closed: a leave with no join before it opens
 * nothing, and a member with no join is in no period at all.
 */

export interface MembershipEvent {
  action: string;
  memberArn: string;
  timestamp: string;
}

/** One stretch of membership: from a join to the leave that ended it, or to now when it has not ended. */
export interface MembershipPeriod {
  from: string;
  to: string | null;
}

const ms = (t: string) => Date.parse(t);

/**
 * The periods any of `memberArns` was a member, merged where they overlap (an assistant with one identity
 * per classification can be in a room twice), in time order.
 */
export function membershipPeriods(history: MembershipEvent[], memberArns: string[]): MembershipPeriod[] {
  const members = new Set(memberArns);
  const raw: Array<{ from: number; to: number }> = [];
  const open = new Map<string, number>();
  const ordered = history
    .filter((e) => members.has(e.memberArn) && Number.isFinite(ms(e.timestamp)))
    .sort((a, b) => ms(a.timestamp) - ms(b.timestamp));
  for (const e of ordered) {
    const at = ms(e.timestamp);
    if (e.action === 'joined') {
      if (!open.has(e.memberArn)) open.set(e.memberArn, at);
    } else if (e.action === 'left') {
      const from = open.get(e.memberArn);
      if (from !== undefined) {
        raw.push({ from, to: at });
        open.delete(e.memberArn);
      }
    }
  }
  for (const from of open.values()) raw.push({ from, to: Infinity });
  raw.sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [];
  for (const p of raw) {
    const last = merged[merged.length - 1];
    if (last && p.from <= last.to) last.to = Math.max(last.to, p.to);
    else merged.push({ ...p });
  }
  return merged.map((p) => ({
    from: new Date(p.from).toISOString(),
    to: p.to === Infinity ? null : new Date(p.to).toISOString(),
  }));
}

/** Whether a turn at `timestamp` falls in a period: from the join, inclusive, to the leave, exclusive. */
export function withinPeriods(timestamp: string, periods: MembershipPeriod[]): boolean {
  const at = ms(timestamp);
  if (!Number.isFinite(at)) return false;
  return periods.some((p) => at >= ms(p.from) && (p.to === null || at < ms(p.to)));
}
