/**
 * THE DAILY DE-IDENTIFICATION BATCH (SPEC-ADMIN-CONSOLE FR54, DESIGN-ADMIN-CONSOLE 5.3).
 *
 * Runs on a schedule (02:00 UTC by default). It asks the data plane which conversations changed since
 * they were last derived, de-identifies each as one document, and writes it back, until nothing is
 * pending or its time is nearly spent. A conversation is written whole or not at all, so a run that
 * fails or is cut short leaves the rest pending and the next run picks them up.
 *
 * OUTSIDE THE VPC, on purpose. It calls the detector and posts to the admin channel itself, and reaches
 * Aurora only through data-plane ops - the seam every non-VPC handler uses - so it needs no new
 * endpoint and no notifier of its own (tenet D8).
 *
 * EVERY RUN SAYS HOW IT ENDED. One message to the admin notification channel, which fans out to the
 * admins by email: complete, incomplete (cut short with work left) or failed (what failed, how much was
 * written first). A day without one is a run that never started.
 *
 * Never throws: an asynchronous invocation that throws is retried, which would run the batch again on
 * top of itself. The failure is reported instead.
 */
import type { Context } from 'aws-lambda';
import { cleanCopyPending, cleanCopySource, cleanCopyWrite, cleanCopyRecordRun } from './lib/data-plane-client.js';
import { deIdentify, DEIDENTIFY_RULES_VERSION } from './lib/de-identify.js';
import { guardrailDetector, type PiiDetector } from './lib/pii-detector.js';
import { adminNotice, postAdminNotice } from './lib/admin-notice.js';
import { shippedAdminNoticeText, type AdminNoticeWords } from './lib/admin-notice-templates.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

/** Stop taking new conversations once less than this remains, so the run can record and report. */
const RESERVE_MS = 90_000;
const PAGE = 25;

export type Outcome = 'complete' | 'incomplete' | 'failed';

export interface RunReport {
  outcome: Outcome;
  startedAt: string;
  conversations: number;
  remaining: number | null;
  /** Which step failed, and how. */
  failure: string | null;
  durationMs: number;
}

export interface BatchDeps {
  detector: PiiDetector;
  remainingMs: () => number;
  /** Announce the run: its shipped wording, and the report the admin assistant's own template is said from. */
  notify: (text: string, report: RunReport) => Promise<void>;
  now?: () => number;
  /**
   * At most this many conversations, then stop and report the rest pending. Set on a manual run that
   * proves a change on a sample; the scheduled run leaves it unset and brings everything up to date.
   * Each conversation costs detector calls, so a change is verified on a few, not the whole archive.
   */
  maxConversations?: number;
}

/** The run itself, with its collaborators passed in so it is tested without AWS. */
export async function runBatch(deps: BatchDeps): Promise<RunReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  const startedAt = new Date(started).toISOString();
  let conversations = 0;
  let remaining: number | null = null;
  let failure: string | null = null;
  let outcome: Outcome = 'complete';
  // What each conversation is derived with: the detector and the version of the rules. A copy derived
  // with anything else is pending again (`cleanCopyPending`).
  const derivation = `${deps.detector.name};rules=${DEIDENTIFY_RULES_VERSION}`;

  try {
    const cap = deps.maxConversations && deps.maxConversations > 0 ? deps.maxConversations : Infinity;
    for (;;) {
      if (deps.remainingMs() < RESERVE_MS || conversations >= cap) {
        const { total } = await cleanCopyPending(1, derivation);
        remaining = total;
        outcome = total > 0 ? 'incomplete' : 'complete';
        break;
      }
      const { pending, total } = await cleanCopyPending(PAGE, derivation);
      remaining = total;
      if (!pending.length) break;
      for (const p of pending) {
        if (deps.remainingMs() < RESERVE_MS || conversations >= cap) break;
        let step = 'archive read';
        try {
          const source = await cleanCopySource(p.channelArn);
          step = 'detector';
          const rows = await deIdentify(source.rows, deps.detector.anonymize);
          step = 'copy write';
          await cleanCopyWrite({
            channelArn: p.channelArn, rows, sourceRows: p.sourceRows, sourceLatest: p.sourceLatest,
            classification: source.classification, detector: derivation,
          });
        } catch (err) {
          throw new Error(`${step} failed on ${p.channelArn.split('/').pop()}: ${(err as Error).message}`);
        }
        conversations++;
        remaining = Math.max(0, (remaining ?? 1) - 1);
      }
    }
  } catch (err) {
    outcome = 'failed';
    failure = (err as Error).message.slice(0, 500);
  }

  const report: RunReport = { outcome, startedAt, conversations, remaining, failure, durationMs: now() - started };
  try {
    await cleanCopyRecordRun({ startedAt, outcome, conversations, remaining, failure });
  } catch (err) {
    console.error('[clean-copy] the run could not be recorded', err);
  }
  try {
    await deps.notify(describe(report), report);
  } catch (err) {
    console.error('[clean-copy] the run could not be announced', err);
  }
  console.log(JSON.stringify({ _event: 'clean_copy_run', ...report }));
  return report;
}

/**
 * WHAT A RUN SAYS, as the `clean-copy-run` template's values (ADR-062 decision 6): the outcome names its line and its
 * label, and a value the run did not record is the template's own label.
 */
export function runWords(r: RunReport): AdminNoticeWords {
  const took = `${Math.round(r.durationMs / 1000)}s`;
  const base = { conversations: String(r.conversations), took };
  if (r.outcome === 'complete') return { name: 'clean-copy-run', values: base, labels: { outcome: 'complete' } };
  if (r.outcome === 'incomplete') {
    return {
      name: 'clean-copy-run', form: 'incomplete',
      values: { ...base, ...(r.remaining !== null && r.remaining !== undefined ? { remaining: String(r.remaining) } : {}) },
      labels: { outcome: 'incomplete', ...(r.remaining !== null && r.remaining !== undefined ? {} : { remaining: 'some' }) },
    };
  }
  return {
    name: 'clean-copy-run', form: 'failed',
    values: { ...base, ...(r.failure ? { failure: r.failure } : {}) },
    labels: { outcome: 'failed', ...(r.failure ? {} : { failure: 'unknownFailure' }) },
  };
}

/** The announcement: what happened, how much, and what the operator should know next, as the shipped template says it. */
export function describe(r: RunReport): string {
  return shippedAdminNoticeText(runWords(r)).content;
}

/**
 * Raise the run's outcome as an `ae.alert`, as every admin notice is raised (`lib/admin-notice.ts`), which
 * the `AdminServices` stack posts into the admin notification channel.
 */
async function postToAdmins(_text: string, report: RunReport): Promise<void> {
  await postAdminNotice(adminNotice(runWords(report), 'clean_copy_run', { outcome: report.outcome }));
}

export async function handler(event: { maxConversations?: number } | null | undefined, context?: Context): Promise<RunReport> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const guardrailId = process.env.DEIDENTIFY_GUARDRAIL_ID || '';
  const guardrailVersion = process.env.DEIDENTIFY_GUARDRAIL_VERSION || '';
  const remainingMs = () => (context ? context.getRemainingTimeInMillis() : 15 * 60_000);
  if (!guardrailId || !guardrailVersion) {
    const report: RunReport = {
      outcome: 'failed', startedAt: new Date().toISOString(), conversations: 0, remaining: null,
      failure: 'the de-identification guardrail is not configured', durationMs: 0,
    };
    await postToAdmins(describe(report), report).catch((err) => console.error('[clean-copy] could not announce', err));
    return report;
  }
  // A manual run proving a change passes `{"maxConversations": 25}`; the schedule passes nothing.
  const maxConversations = Number(event?.maxConversations) || undefined;
  return runBatch({ detector: guardrailDetector(guardrailId, guardrailVersion), remainingMs, notify: postToAdmins, maxConversations });
}
