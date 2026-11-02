/**
 * A DEPLOYMENT'S OWN GOLDEN ENTRIES (ADR-065 decision 7, SPEC-EVALUATION FR27).
 *
 * Offered to a session holding `import-golden-set`, beside the assistant's versions, whether or not a draft is open: a new
 * assistant or a new intent has no labeled traffic, and its owners' own cases are what measure its first drafts. The file
 * is a JSON Lines file or a CSV file with the same columns; the server checks every line against the intents the assistant
 * serves at once, and one bad line refuses the file with each bad line named here, so a corrected file is uploaded whole.
 *
 * GENERATED ENTRIES (ADR-065 decision 8) are offered beside it to an editor (`edit-profiles`, because each intent is a
 * model call): requests written from what each intent of the draft's pack says it covers, stored as capability entries
 * marked generated, which refuse nothing until the active version passes them and a person promotes them.
 *
 * BOTH RUN IN THE BACKGROUND. The start answers at once with the batch's id; the panel follows that batch's channel and
 * reads how it ended once, when told (`followBatch`), and once when the subscription stands, in case it ended first. No
 * timer: where the deployment has no console events, Check again reads it.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InfoTooltip } from './AdminHelp';
import { useCan } from '../../capabilities';
import {
  generateGoldenEntries, readGoldenBatch, uploadGoldenEntries, type GoldenBatchReading, type GoldenUploadRefusal,
} from '../../services/profileService';
import { followBatch, type BatchEnded } from '../../services/consoleEvents';

/** The format a file is read as, from its name; null for a name that is neither. */
export function uploadFormatOf(fileName: string): 'jsonl' | 'csv' | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl';
  if (lower.endsWith('.csv')) return 'csv';
  return null;
}

/** A batch this panel started, and the time a row of it must have started at to be this start's (`startedAfter`). */
type Running = { batchId: string; kind: 'upload' | 'generation'; startedAfter?: string };

/** Clock skew allowed between the API's clock and the database's when telling this start's row from an older one. */
const SKEW_MS = 5000;
type Done = { kind: 'upload' | 'generation'; count: number };

export default function GoldenUploadPanel({ profileName }: { profileName: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const can = useCan();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<Running | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [refusal, setRefusal] = useState<GoldenUploadRefusal | null>(null);
  const [perIntent, setPerIntent] = useState(3);
  const unfollow = useRef<() => void>(() => {});
  // Following stops when the page leaves this assistant, so another assistant's batch never fills this panel.
  useEffect(() => () => unfollow.current(), [profileName]);
  const canUpload = can('import-golden-set');
  const canGenerate = can('edit-profiles');
  if (!canUpload && !canGenerate) return null;

  const format = file ? uploadFormatOf(file.name) : null;

  /**
   * Read how the batch ended, once; a batch still running stays followed. A row not written yet, or one that started before
   * this start (the same file uploaded before), is this batch still to come. `ended` is what the channel said: a batch the
   * channel says failed while its row still reads running ended without recording it (a timeout).
   */
  const check = async (batch: Running, ended?: BatchEnded) => {
    let reading: GoldenBatchReading | null;
    try {
      reading = (await readGoldenBatch(profileName, batch.batchId)).batch as GoldenBatchReading & { startedAt: string };
    } catch (e) {
      if ((e as { body?: { code?: string } }).body?.code !== 'NO_BATCH') {
        setRefusal({ code: 'UNKNOWN', error: e instanceof Error ? e.message : String(e) });
        return;
      }
      reading = null;
    }
    const older = !!reading && !!batch.startedAfter && Date.parse(reading.startedAt) < Date.parse(batch.startedAfter) - SKEW_MS;
    const pending = !reading || older || reading.status === 'running';
    if (pending && ended?.status !== 'failed') return;
    unfollow.current();
    setRunning(null);
    const result = (pending ? null : reading!.result) ?? {};
    if (!pending && reading!.status === 'complete') {
      setRefusal(null);
      setDone({ kind: batch.kind, count: Number(result.imported ?? result.generated ?? 0) });
      return;
    }
    setDone(null);
    setRefusal(!pending && reading!.status === 'refused'
      ? { code: String(result.code), params: result.params as GoldenUploadRefusal['params'], lines: result.lines as number[] | undefined }
      : { code: 'BATCH_FAILED', params: { error: String(result.error ?? '') } });
  };

  const started = (batch: Running) => {
    setRunning(batch);
    unfollow.current();
    unfollow.current = followBatch(batch.batchId, (ended) => { void check(batch, ended); }, () => { void check(batch); }, () => { void check(batch); });
  };

  const begin = async (start: () => Promise<{ batchId: string; startedAfter?: string }>, kind: Running['kind']) => {
    setBusy(true);
    setDone(null);
    setRefusal(null);
    try {
      const out = await start();
      started({ batchId: out.batchId, kind, startedAfter: out.startedAfter });
    } catch (e) {
      const body = (e as { body?: GoldenUploadRefusal }).body;
      setRefusal(body?.code ? body : { code: 'UNKNOWN', error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    if (!file || !format) return;
    const content = await file.text();
    await begin(() => uploadGoldenEntries(profileName, format, content), 'upload');
    setFile(null);
    if (input.current) input.current.value = '';
  };

  // A generation names its own id, so a second click while it runs is the same batch, which the function starts once.
  const generate = () => begin(() => generateGoldenEntries(profileName, perIntent, running?.kind === 'generation' ? running.batchId : crypto.randomUUID()), 'generation');

  const problemLine = (p: NonNullable<GoldenUploadRefusal['problems']>[number]) => t('admin.goldenUpload.problem', {
    line: p.line,
    problem: t(`admin.goldenUpload.problemCode.${p.code}`, { field: p.field ?? '' }),
  });
  const blocked = busy || !!running;

  return (
    <section className="admin-golden-upload" aria-labelledby="golden-upload-title" data-testid="golden-upload">
      <h5 id="golden-upload-title">
        {t('admin.goldenUpload.title')}{' '}
        <InfoTooltip label={t('admin.goldenUpload.title')} content={t('admin.goldenUpload.tip')} />
      </h5>
      {canUpload && (
        <>
          <p className="admin-field-hint">{t('admin.goldenUpload.help')}</p>
          <label htmlFor="golden-upload-file">{t('admin.goldenUpload.fileLabel')}</label>
          <input id="golden-upload-file" ref={input} type="file" accept=".jsonl,.ndjson,.csv" disabled={blocked} data-testid="golden-upload-file"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setDone(null); setRefusal(null); }} />
          {file && !format && <p className="admin-error" role="alert">{t('admin.goldenUpload.refusal.BAD_FORMAT')}</p>}
          <div className="admin-config-actions">
            <button type="button" className="btn-secondary" disabled={blocked || !file || !format} onClick={() => { void upload(); }} data-testid="golden-upload-submit">
              {t('admin.goldenUpload.submit')}
            </button>
          </div>
        </>
      )}
      {canGenerate && (
        <div data-testid="golden-generate">
          <p className="admin-field-hint">{t('admin.goldenUpload.generateHelp')}</p>
          <label htmlFor="golden-generate-count">{t('admin.goldenUpload.perIntentLabel')}</label>{' '}
          <select id="golden-generate-count" value={perIntent} disabled={blocked} onChange={(e) => setPerIntent(Number(e.target.value))} data-testid="golden-generate-count">
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <div className="admin-config-actions">
            <button type="button" className="btn-secondary" disabled={blocked} onClick={() => { void generate(); }} data-testid="golden-generate-submit">
              {t('admin.goldenUpload.generate', { count: perIntent })}
            </button>
          </div>
        </div>
      )}
      {running && (
        <p role="status" data-testid="golden-batch-running">
          {t(`admin.goldenUpload.running.${running.kind}`)}{' '}
          <button type="button" className="btn-link" onClick={() => { void check(running); }} data-testid="golden-batch-check">
            {t('admin.assistantPage.golden.checkAgain')}
          </button>
        </p>
      )}
      {done && (
        <p role="status" data-testid={done.kind === 'upload' ? 'golden-upload-done' : 'golden-generate-done'}>
          {t(done.kind === 'upload' ? 'admin.goldenUpload.done' : 'admin.goldenUpload.generated', { count: done.count })}
        </p>
      )}
      {refusal && (
        <div className="admin-error" role="alert" data-testid="golden-upload-refused">
          <p>{t(`admin.goldenUpload.refusal.${refusal.code}`, { ...(refusal.params ?? {}), defaultValue: refusal.error ?? refusal.code })}</p>
          {(refusal.problems ?? []).length > 0 && <ul>{refusal.problems!.map((p) => <li key={`${p.line}-${p.code}`}>{problemLine(p)}</li>)}</ul>}
          {(refusal.lines ?? []).length > 0 && <p>{t('admin.goldenUpload.lines', { lines: refusal.lines!.join(', ') })}</p>}
        </div>
      )}
    </section>
  );
}
