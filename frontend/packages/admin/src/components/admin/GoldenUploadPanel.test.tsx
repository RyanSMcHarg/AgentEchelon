/**
 * A DEPLOYMENT'S OWN GOLDEN ENTRIES (ADR-065 decisions 7, 8).
 *
 * What it proves: the upload is offered only to a session holding `import-golden-set`, and generation only to one holding
 * `edit-profiles`; the format is read from the file's name and anything else is refused before sending; a file whose lines
 * are not entries is refused at once with each bad line named in the locale's words; work that starts runs in the
 * background, its batch's channel is followed, and the result is read once when the channel says it ended, or once when
 * the subscription stands; nothing waits on a timer.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import GoldenUploadPanel, { uploadFormatOf } from './GoldenUploadPanel';
import * as svc from '../../services/profileService';

vi.mock('../../services/profileService', async (orig) => ({
  ...(await orig<typeof import('../../services/profileService')>()),
  uploadGoldenEntries: vi.fn(),
  generateGoldenEntries: vi.fn(),
  readGoldenBatch: vi.fn(),
}));
// The batch's channel: the test says when it is subscribed and when it ended.
const FOLLOWED: Array<{ id: string; ended: (e?: unknown) => void; ready?: () => void; lost?: () => void }> = [];
vi.mock('../../services/consoleEvents', () => ({
  followBatch: (id: string, ended: (e?: unknown) => void, ready?: () => void, lost?: () => void) => {
    FOLLOWED.push({ id, ended, ready, lost });
    return () => {};
  },
}));
const HELD = { capabilities: new Set<string>(['import-golden-set']) };
vi.mock('../../capabilities', () => ({ useCan: () => (c: string) => HELD.capabilities.has(c) }));

const choose = (name: string, text: string) => {
  const file = new File([text], name);
  fireEvent.change(screen.getByTestId('golden-upload-file'), { target: { files: [file] } });
};
const STARTED_AFTER = '2026-11-01T10:00:00.000Z';
const started = (batchId: string, kind: 'upload' | 'generation') => ({ profileName: 'advisor', batchId, kind, status: 'running' as const, startedAfter: STARTED_AFTER });
const batch = (batchId: string, kind: 'upload' | 'generation', status: svc.GoldenBatchReading['status'], result: Record<string, unknown> | null) =>
  ({ profileName: 'advisor', batch: { batchId, kind, status, result, startedAt: '2026-11-01T10:00:01.000Z' } });

beforeEach(() => {
  vi.mocked(svc.uploadGoldenEntries).mockReset();
  vi.mocked(svc.generateGoldenEntries).mockReset();
  vi.mocked(svc.readGoldenBatch).mockReset();
  FOLLOWED.length = 0;
  HELD.capabilities = new Set(['import-golden-set']);
});

describe('the golden upload panel', () => {
  it('reads the format from the file name', () => {
    expect(uploadFormatOf('cases.JSONL')).toBe('jsonl');
    expect(uploadFormatOf('cases.ndjson')).toBe('jsonl');
    expect(uploadFormatOf('cases.csv')).toBe('csv');
    expect(uploadFormatOf('cases.xlsx')).toBeNull();
  });

  it('offers the upload to import-golden-set and generation to edit-profiles, each its own control', () => {
    HELD.capabilities = new Set(['view-profiles']);
    const { container, unmount } = render(<GoldenUploadPanel profileName="advisor" />);
    expect(container.innerHTML).toBe('');
    unmount();
    HELD.capabilities = new Set(['edit-profiles']);
    render(<GoldenUploadPanel profileName="advisor" />);
    expect(screen.queryByTestId('golden-upload-file')).toBeNull();
    expect(screen.getByTestId('golden-generate')).toBeTruthy();
  });

  it('starts the upload, follows its batch, and reads the result once when the channel says it ended', async () => {
    vi.mocked(svc.uploadGoldenEntries).mockResolvedValue(started('u-1', 'upload'));
    vi.mocked(svc.readGoldenBatch)
      .mockResolvedValueOnce(batch('u-1', 'upload', 'running', null))
      .mockResolvedValueOnce(batch('u-1', 'upload', 'complete', { imported: 2, uploadId: 'u-1' }));
    render(<GoldenUploadPanel profileName="advisor" />);
    const text = '{"intent":"report_generation","request":"a"}\n{"intent":"report_generation","request":"b"}';
    choose('cases.jsonl', text);
    fireEvent.click(screen.getByTestId('golden-upload-submit'));
    await waitFor(() => expect(svc.uploadGoldenEntries).toHaveBeenCalledWith('advisor', 'jsonl', text));
    await screen.findByTestId('golden-batch-running');
    expect(FOLLOWED.map((f) => f.id)).toEqual(['u-1']);
    // Subscribed: read once, still running.
    await act(async () => { FOLLOWED[0].ready?.(); });
    expect(screen.getByTestId('golden-batch-running')).toBeTruthy();
    // Told it ended: read once more, and the result shows.
    await act(async () => { FOLLOWED[0].ended(); });
    expect((await screen.findByTestId('golden-upload-done')).textContent).toContain('2');
    expect(svc.readGoldenBatch).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('golden-batch-running')).toBeNull();
  });

  it('words a refusal the batch ended with, naming the lines', async () => {
    vi.mocked(svc.uploadGoldenEntries).mockResolvedValue(started('u-2', 'upload'));
    vi.mocked(svc.readGoldenBatch).mockResolvedValue(batch('u-2', 'upload', 'refused', { refused: true, code: 'DETECTOR_FAILED', params: { count: 1 }, lines: [4] }));
    render(<GoldenUploadPanel profileName="advisor" />);
    choose('cases.jsonl', '{}');
    fireEvent.click(screen.getByTestId('golden-upload-submit'));
    await screen.findByTestId('golden-batch-running');
    await act(async () => { FOLLOWED[0].ended(); });
    const refused = await screen.findByTestId('golden-upload-refused');
    expect(refused.textContent).toContain('4');
    expect(refused.textContent).not.toMatch(/goldenUpload\./);
  });

  it('refuses a file that is neither format before sending it', () => {
    render(<GoldenUploadPanel profileName="advisor" />);
    choose('cases.xlsx', 'x');
    expect((screen.getByTestId('golden-upload-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('.jsonl');
  });

  it('names each bad line of a file refused at once, and follows nothing', async () => {
    vi.mocked(svc.uploadGoldenEntries).mockRejectedValue(Object.assign(new Error('refused'), {
      body: {
        code: 'INVALID_LINES', params: { count: 2, lines: 3 },
        problems: [{ line: 2, code: 'UNKNOWN_INTENT', field: 'intent' }, { line: 3, code: 'MISSING_FIELD', field: 'request' }],
      },
    }));
    render(<GoldenUploadPanel profileName="advisor" />);
    choose('cases.csv', 'intent,request\n');
    fireEvent.click(screen.getByTestId('golden-upload-submit'));
    const refused = await screen.findByTestId('golden-upload-refused');
    expect(refused.querySelectorAll('li')).toHaveLength(2);
    expect(refused.textContent).toContain('Line 2');
    expect(refused.textContent).toContain('request is missing');
    expect(FOLLOWED).toEqual([]);
  });

  it('generates the chosen number per intent under its own id, and shows what was written when told', async () => {
    HELD.capabilities = new Set(['edit-profiles']);
    vi.mocked(svc.generateGoldenEntries).mockImplementation(async (_p, _n, id) => started(id, 'generation'));
    vi.mocked(svc.readGoldenBatch).mockImplementation(async (_p, id) => batch(id, 'generation', 'complete', { generated: 8 }));
    render(<GoldenUploadPanel profileName="advisor" />);
    fireEvent.change(screen.getByTestId('golden-generate-count'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('golden-generate-submit'));
    await waitFor(() => expect(svc.generateGoldenEntries).toHaveBeenCalledWith('advisor', 2, expect.stringMatching(/^[0-9a-f-]{36}$/)));
    await screen.findByTestId('golden-batch-running');
    expect((screen.getByTestId('golden-generate-submit') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { FOLLOWED[0].ended(); });
    expect((await screen.findByTestId('golden-generate-done')).textContent).toContain('8');
  });

  it('reads a batch whose row is not written yet as still running, with no error, and clears nothing it should not', async () => {
    vi.mocked(svc.uploadGoldenEntries).mockResolvedValue(started('u-3', 'upload'));
    vi.mocked(svc.readGoldenBatch)
      .mockRejectedValueOnce(Object.assign(new Error('No such batch'), { body: { code: 'NO_BATCH' } }))
      .mockResolvedValueOnce(batch('u-3', 'upload', 'complete', { imported: 1 }));
    render(<GoldenUploadPanel profileName="advisor" />);
    choose('cases.jsonl', '{}');
    fireEvent.click(screen.getByTestId('golden-upload-submit'));
    await screen.findByTestId('golden-batch-running');
    await act(async () => { FOLLOWED[0].ready?.(); });
    expect(screen.queryByTestId('golden-upload-refused')).toBeNull();
    expect(screen.getByTestId('golden-batch-running')).toBeTruthy();
    await act(async () => { FOLLOWED[0].ended({ id: 'u-3', kind: 'upload', status: 'complete' }); });
    expect(await screen.findByTestId('golden-upload-done')).toBeTruthy();
    expect(screen.queryByTestId('golden-upload-refused')).toBeNull();
  });

  it('takes a row that started before this upload as an earlier run of the same file, not this one', async () => {
    vi.mocked(svc.uploadGoldenEntries).mockResolvedValue(started('u-4', 'upload'));
    vi.mocked(svc.readGoldenBatch)
      .mockResolvedValueOnce({ profileName: 'advisor', batch: { batchId: 'u-4', kind: 'upload', status: 'complete', result: { imported: 10 }, startedAt: '2026-10-30T09:00:00.000Z' } })
      .mockResolvedValueOnce(batch('u-4', 'upload', 'refused', { refused: true, code: 'GOLDEN_SET_FULL', params: { live: 99, adding: 2, capacity: 100 } }));
    render(<GoldenUploadPanel profileName="advisor" />);
    choose('cases.jsonl', '{}');
    fireEvent.click(screen.getByTestId('golden-upload-submit'));
    await screen.findByTestId('golden-batch-running');
    await act(async () => { FOLLOWED[0].ready?.(); });
    expect(screen.queryByTestId('golden-upload-done')).toBeNull();
    await act(async () => { FOLLOWED[0].ended({ id: 'u-4', kind: 'upload', status: 'refused' }); });
    expect((await screen.findByTestId('golden-upload-refused')).textContent).toContain('99');
  });

  it('shows a batch the channel says failed while its row still reads running as failed, and reads once when the channel is lost', async () => {
    vi.mocked(svc.uploadGoldenEntries).mockResolvedValue(started('u-5', 'upload'));
    vi.mocked(svc.readGoldenBatch).mockResolvedValue(batch('u-5', 'upload', 'running', null));
    render(<GoldenUploadPanel profileName="advisor" />);
    choose('cases.jsonl', '{}');
    fireEvent.click(screen.getByTestId('golden-upload-submit'));
    await screen.findByTestId('golden-batch-running');
    await act(async () => { FOLLOWED[0].lost?.(); });
    expect(svc.readGoldenBatch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('golden-batch-check')).toBeTruthy();
    await act(async () => { FOLLOWED[0].ended({ id: 'u-5', kind: 'upload', status: 'failed' }); });
    expect((await screen.findByTestId('golden-upload-refused')).textContent).not.toMatch(/goldenUpload./);
    expect(screen.queryByTestId('golden-batch-running')).toBeNull();
  });

  it('never waits on a timer', () => {
    const source = fs.readFileSync(path.join(__dirname, 'GoldenUploadPanel.tsx'), 'utf8');
    expect(source).not.toMatch(/setInterval|setTimeout/);
  });
});
