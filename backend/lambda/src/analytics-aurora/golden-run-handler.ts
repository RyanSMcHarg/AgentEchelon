/**
 * A classification's GOLDEN RUN function (ADR-065 Option A): its operations, all inside the classification.
 *
 *   start   invoked as an Event by `manage-profiles`, which minted the run id, handed both versions over as an object and
 *           answered the person's click. Opens the run and answers every entry; the run's own row is the report, so a failure is recorded on it, not thrown to
 *           the async retry, which would run the whole set again.
 *   gate    invoked RequestResponse by `manage-profiles` on Activate and when the console opens a draft: the set's size
 *           and the latest run for the draft's configId.
 *   import  invoked as an Event with a deployment's uploaded entries, read and checked by `manage-profiles` and handed
 *           over as an object under `golden-uploads/<classification>/<assistant>/`, never in the event: de-identifies them
 *           with the clean copy's detector, writes them as capability entries, and removes the object (ADR-065 decision 7).
 *   generate  invoked as an Event with intents of the draft's pack: the utility model writes requests for each,
 *           de-identified and stored as capability entries marked generated (ADR-065 decision 8).
 *   batch   invoked RequestResponse: how an upload or a generation ended, from its row.
 *   retire-upload  retires the capability entries of one upload or generation.
 *
 * An Event's end reaches the console through the function's async destination (EventBridge) and the console's events
 * channel for that run or batch, so the console reads the result once, when told, and never polls.
 *
 * Its own function, beside the classifier replay and built the same way, because the run is minutes of model calls and
 * the database is in the VPC, which the starter is deliberately outside.
 */

import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ensureSchema } from './db-client.js';
import {
  executeGoldenRun, readGoldenGate, importGoldenEntries, retireGoldenUpload, generateGoldenEntries, inBatch, readBatch,
  assertOwnClassification,
  type StartGoldenRun, type GoldenGateQuery, type RetireGoldenUpload, type GenerateGoldenEntries, type GoldenBatchQuery,
  type ImportGoldenEntries,
} from './golden-run.js';
import { goldenUploadPrefix, type UploadedEntry } from '../lib/golden-upload.js';
import { loadProfileRegistry } from '../../../lib/profile-registry';

/** An upload as the function is invoked with it: where its entries are, not the entries. */
export type ImportGoldenBatch = Omit<ImportGoldenEntries, 'entries'> & {
  /** The object holding the checked entries, and its version, removed once read whether the batch succeeds or not. */
  entriesKey: string;
  entriesVersion?: string;
};

/** A run as the function is invoked with it: where its input is, not the definitions. */
export type StartGoldenRunEvent = Pick<StartGoldenRun, 'op' | 'runId' | 'classification' | 'assistant' | 'startedBy' | 'k'> & {
  inputKey: string;
  inputVersion?: string;
};

let s3: S3Client | undefined;

/**
 * Read a hand-over, then remove that version of the object, so what it carried outlives the batch by nothing. ONLY THIS
 * CLASSIFICATION'S HAND-OVER, for the assistant the event names: a payload cannot point the function elsewhere.
 */
async function takeHandOver<T>(classification: string, assistant: string, key: string, version: string | undefined): Promise<T> {
  if (!key.startsWith(goldenUploadPrefix(classification, assistant))) {
    throw new Error(`[golden-run] a hand-over is under ${goldenUploadPrefix(classification, assistant)}`);
  }
  const Bucket = process.env.PROFILE_BODY_BUCKET || '';
  s3 ??= new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
  try {
    const got = await s3.send(new GetObjectCommand({ Bucket, Key: key, ...(version ? { VersionId: version } : {}) }));
    return JSON.parse(await got.Body!.transformToString()) as T;
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket, Key: key, ...(version ? { VersionId: version } : {}) }))
      .catch((err) => console.warn('[golden-run] the hand-over could not be removed; its lifecycle rule removes it', { name: (err as Error)?.name }));
  }
}

export async function handler(event: StartGoldenRunEvent | GoldenGateQuery | ImportGoldenBatch | RetireGoldenUpload | GenerateGoldenEntries | GoldenBatchQuery) {
  await loadProfileRegistry();
  // Apply any pending migration first, as every database function does (`db-lambdas-apply-migrations.test.ts`).
  await ensureSchema();
  if (event?.op === 'gate') return readGoldenGate(event);
  if (event?.op === 'batch') return readBatch(event);
  if (event?.op === 'retire-upload') return retireGoldenUpload(event);
  if (event?.op === 'import') {
    const classification = assertOwnClassification(event.classification);
    const { entriesKey, entriesVersion, ...upload } = event;
    const outcome = await inBatch(classification, event.assistant, event.uploadId, 'upload', event.uploadedBy, async () => {
      const entries = await takeHandOver<UploadedEntry[]>(classification, event.assistant, entriesKey, entriesVersion);
      return importGoldenEntries({ ...upload, entries }) as Promise<Record<string, unknown>>;
    });
    console.log('[golden-run] upload', event.uploadId, outcome.status);
    return outcome;
  }
  if (event?.op === 'generate') {
    const classification = assertOwnClassification(event.classification);
    const outcome = await inBatch(classification, event.assistant, event.generationId, 'generation', event.generatedBy,
      () => generateGoldenEntries(event) as Promise<Record<string, unknown>>);
    console.log('[golden-run] generation', event.generationId, outcome.status);
    return outcome;
  }
  if (event?.op === 'start') {
    if (!event.runId) throw new Error('[golden-run] runId is required');
    const classification = assertOwnClassification(event.classification);
    const { inputKey, inputVersion, ...start } = event;
    const input = await takeHandOver<Pick<StartGoldenRun, 'draft' | 'active' | 'seed' | 'fallbackPersona' | 'deploymentPackRaw'>>(
      classification, event.assistant, inputKey, inputVersion,
    );
    const run = await executeGoldenRun({ ...start, ...input });
    console.log('[golden-run] run', run.runId, 'finished', { status: run.status, entries: run.entriesTotal, refused: run.result?.refused });
    return run;
  }
  throw new Error(`[golden-run] unknown op ${(event as { op?: string })?.op}`);
}
