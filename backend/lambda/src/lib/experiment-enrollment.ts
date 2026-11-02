/**
 * A CONVERSATION IS ENROLLED ONCE (ADR-050).
 *
 * A profile experiment swaps what a person sees - persona, display name, tools, taxonomy - so it may not
 * start, stop or skip between turns of one conversation. A conversation is therefore enrolled in the
 * conversation-scoped experiment that was live for its classification at the instant it was created, or
 * in none, and the result is pinned on the conversation's server-only context row for its whole life.
 *
 * The decision is a function of two recorded facts: the conversation's `createdAt`, stamped by the
 * creating path, and the experiment's lifecycle, replayed from its append-only `transitions`. So it does
 * not matter which turn evaluates it: the first turn after creation and a turn an hour later reach the
 * same answer, and the pin only freezes it against later edits to the experiment. A conversation created
 * before the arm is never enrolled. The pin holds only while the experiment stays active: a pause, an end
 * or a passed end date releases the conversation to the live active version (`enrollmentHolds`, owner
 * 2026-10-15), and a resume enrolls only conversations created after it.
 *
 * Recorded on the context row rather than the battle config row, because a battle config row's
 * existence is what its readers take to mean a battle is enabled, and the context row is the store every
 * creating path already writes and no member can read or write.
 */
import type { Classification } from '../../../lib/config/model-strategy.js';
import {
  cachedEnrollableExperiments,
  assignVariant, isConversationScoped, listEnrollableExperiments, pinFor, type Experiment, type ExperimentVariant,
} from './experiment-manager.js';
import { getChannelContext, putChannelContext, type ConversationEnrollment } from './channel-context-client.js';

/**
 * Whether an experiment was live for a classification at an instant: in scope, inside its window, and
 * `active` according to its lifecycle at that instant. Replays `transitions` rather than reading
 * `status`, because the status is what it is NOW. A record with no transitions predates the audit, and
 * is read by its current status, which is the most that can be known about it.
 */
export function wasLiveAt(exp: Experiment, classification: Classification, at: Date): boolean {
  if (!exp.tiers.includes(classification)) return false;
  if (exp.startDate && new Date(exp.startDate) > at) return false;
  if (exp.endDate && new Date(exp.endDate) <= at) return false;
  const transitions = [...(exp.transitions ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  if (!transitions.length) return exp.status === 'active';
  let status: Experiment['status'] | undefined;
  for (const t of transitions) {
    if (new Date(t.at) > at) break;
    status = t.to;
  }
  return status === 'active';
}

/**
 * The experiment and variant a conversation created at `createdAt` is enrolled in, or null. A
 * classification holds one live experiment at a time, so at most one matches; the earliest created wins
 * if older rows overlap.
 */
export function enrolledVariantFor(
  experiments: Experiment[],
  classification: Classification,
  channelArn: string,
  createdAt: string,
): { experiment: Experiment; variant: ExperimentVariant } | null {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return null;
  const match = experiments
    .filter((exp) => isConversationScoped(exp) && exp.status !== 'deleted' && exp.status !== 'draft')
    .filter((exp) => wasLiveAt(exp, classification, at))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))[0];
  if (!match || match.variants.length === 0) return null;
  return { experiment: match, variant: assignVariant(match.experimentId, channelArn, match.variants) };
}

/**
 * The conversation's enrollment: the pin when one is recorded, otherwise decided from its `createdAt`
 * and pinned. Null when it predates the stamp, or no conversation-scoped experiment was live then.
 * Fails soft to null: a store outage serves the classification's ordinary profile for that turn, and
 * the next turn decides again from the same facts.
 */
export async function enrollmentOf(channelArn: string, classification: Classification): Promise<ConversationEnrollment | null> {
  if (!channelArn) return null;
  const ctx = await getChannelContext(channelArn);
  // WHEN IT WAS ENROLLED rides the enrollment so the resolver can tell a conversation enrolled before a
  // pause from one enrolled after a resume (`enrollmentHolds`): the conversation's createdAt, the instant
  // the experiment was live for it.
  if (ctx?.enrollment?.experimentId && ctx.enrollment.variantId) {
    return ctx.createdAt ? { ...ctx.enrollment, enrolledAt: ctx.createdAt } : ctx.enrollment;
  }
  if (!ctx?.createdAt) return null;
  const enrolled = enrolledVariantFor(await listEnrollableExperiments(ctx.createdAt), classification, channelArn, ctx.createdAt);
  const pin = enrolled ? await pinFor(enrolled.experiment, enrolled.variant) : null;
  if (pin) await putChannelContext(channelArn, { enrollment: pin });
  return pin ? { ...pin, enrolledAt: ctx.createdAt } : pin;
}

/**
 * WHETHER AN ENROLLMENT CAN MATTER NOW, from the list this container already holds and never a new read: false when no
 * conversation-scoped experiment is live for the classification, true when one is, and undefined when the container
 * holds no fresh list, so the caller cannot rule it out. Lets a welcome skip the enrollment read in the common case.
 */
export function enrollmentMayApply(classification: Classification, now: Date = new Date()): boolean | undefined {
  const cached = cachedEnrollableExperiments();
  if (!cached) return undefined;
  return cached.some((exp) => isConversationScoped(exp) && exp.status !== 'deleted' && exp.status !== 'draft' && wasLiveAt(exp, classification, now));
}
