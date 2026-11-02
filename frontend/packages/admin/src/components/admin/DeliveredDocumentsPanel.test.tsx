import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import DeliveredDocumentsPanel from './DeliveredDocumentsPanel';
import MessageInspectDrawer from './MessageInspectDrawer';
import type { AdminConversationMessage, AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

/**
 * A DELIVERED DOCUMENT'S SCORE HAS A PLACE ON THE CONSOLE (SPEC-EVALUATION FR22).
 *
 * The runner grades the file a turn delivered in a row of its own, and nothing showed it. The panel reads
 * `document_evaluation` by intent and by task type, with the reply's relevance on the same turns in its own
 * column (never averaged into the document's), every grading state as a count, and a dash rather than a
 * zero where nothing carried the verdict. The conversation drawer shows the file's grade next to the file.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);

const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });

const range = { start: '2026-10-01', end: '2026-10-22' };

const ROWS = [
  {
    dimension: 'intent', group_key: 'report_request',
    documents_delivered: 40, documents_scored: 30, documents_skipped: 4, documents_retrying: 1, documents_failed: 2, documents_awaiting: 3,
    skipped_private: 3, skipped_too_long: 1,
    doc_avg_relevance: 64.5, reply_avg_relevance: 91.2, reply_scored_count: 38,
    doc_groundedness_rate: null, doc_groundedness_assessed_count: 0,
    doc_compliance_rate: 96.7, doc_compliance_assessed_count: 30,
  },
  {
    dimension: 'task_type', group_key: 'report_generation',
    documents_delivered: 40, documents_scored: 30, documents_skipped: 4, documents_retrying: 1, documents_failed: 2, documents_awaiting: 3,
    doc_avg_relevance: 64.5, reply_avg_relevance: 91.2, reply_scored_count: 38,
  },
];

describe('the delivered documents panel', () => {
  beforeEach(() => mockQuery.mockReset());

  it('reads document_evaluation over the window it is given', async () => {
    mockQuery.mockResolvedValue(result(ROWS));
    render(<DeliveredDocumentsPanel dateRange={range} />);
    await waitFor(() => expect(mockQuery).toHaveBeenCalledWith('document_evaluation', range));
  });

  it('shows the document and the reply relevance side by side, by intent and by task type', async () => {
    mockQuery.mockResolvedValue(result(ROWS));
    render(<DeliveredDocumentsPanel dateRange={range} />);
    const intentRow = (await screen.findByText('report_request')).closest('tr')!;
    expect(within(intentRow).getByText(/64\.5/)).toBeTruthy();
    expect(within(intentRow).getByText(/91\.2/)).toBeTruthy();
    expect(screen.getByText('report_generation')).toBeTruthy();
    expect(screen.getByText('By intent')).toBeTruthy();
    expect(screen.getByText('By task type')).toBeTruthy();
  });

  it('counts every grading state, so a score over few documents reads as that', async () => {
    mockQuery.mockResolvedValue(result(ROWS));
    render(<DeliveredDocumentsPanel dateRange={range} />);
    const intentRow = (await screen.findByText('report_request')).closest('tr')!;
    expect(within(intentRow).getByText(/30 scored · 4 skipped · 1 retrying · 2 failed · 3 waiting/)).toBeTruthy();
  });

  it('renders a rate nothing was assessed for as a dash, not a zero', async () => {
    mockQuery.mockResolvedValue(result(ROWS));
    render(<DeliveredDocumentsPanel dateRange={range} />);
    const intentRow = (await screen.findByText('report_request')).closest('tr')!;
    expect(within(intentRow).queryByText(/^0\.0%/)).toBeNull();
    expect(within(intentRow).getByText(/96\.7%/)).toBeTruthy();
  });

  it('says so when no turn delivered a document', async () => {
    mockQuery.mockResolvedValue(result([]));
    render(<DeliveredDocumentsPanel dateRange={range} />);
    expect(await screen.findByText('No turn in this window delivered a document.')).toBeTruthy();
  });
});

describe('the conversation drawer shows a delivered file\'s grade next to the file', () => {
  const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/ch-1';
  const FILE_KEY = 'generated-docs/ch-1/report.md';
  const message = {
    id: 'm-bot', content: 'Here is the report.', senderArn: 'arn:bot', timestamp: '2026-10-22T10:00:05Z', isBot: true,
    metadata: { attachment: { fileKey: FILE_KEY, name: 'report.md', size: 2048, type: 'text/markdown' } },
  } as unknown as AdminConversationMessage;

  beforeEach(() => mockQuery.mockReset());

  it('asks for this conversation\'s documents and shows the matching file\'s score', async () => {
    mockQuery.mockResolvedValue(result([
      { file_key: 'generated-docs/ch-1/other.md', grading_status: 'scored', relevance_score: 10, classification: 'poor' },
      { file_key: FILE_KEY, grading_status: 'scored', relevance_score: 64, classification: 'partial', reply_relevance_score: 91, is_grounded: true, is_compliant: false, reasoning: 'misses the board framing' },
    ]));
    render(<MessageInspectDrawer message={message} onClose={() => undefined} channelArn={CHANNEL} />);
    const field = await screen.findByTestId('document-score');
    await waitFor(() => expect(within(field).getByText('Relevance 64 (partial)')).toBeTruthy());
    expect(mockQuery).toHaveBeenCalledWith('document_evaluation', undefined, { channelArn: CHANNEL });
    expect(within(field).getByText('Reply beside it: 91')).toBeTruthy();
    expect(within(field).getByText('Grounded')).toBeTruthy();
    expect(within(field).getByText('Not compliant')).toBeTruthy();
  });

  it('says why a file was not graded', async () => {
    mockQuery.mockResolvedValue(result([{ file_key: FILE_KEY, grading_status: 'skipped', skip_reason: 'private' }]));
    render(<MessageInspectDrawer message={message} onClose={() => undefined} channelArn={CHANNEL} />);
    expect(await screen.findByText('Not graded: private task')).toBeTruthy();
  });

  it('says when grading stopped after its attempts', async () => {
    mockQuery.mockResolvedValue(result([{ file_key: FILE_KEY, grading_status: 'failed', grading_attempts: 3 }]));
    render(<MessageInspectDrawer message={message} onClose={() => undefined} channelArn={CHANNEL} />);
    expect(await screen.findByText('Grading stopped after 3 failed attempts')).toBeTruthy();
  });

  it('does not ask about a file a person uploaded', () => {
    const upload = { ...message, isBot: false, metadata: { attachment: { fileKey: 'attachments/ch-1/u1/a.pdf', name: 'a.pdf', size: 1, type: 'application/pdf' } } } as unknown as AdminConversationMessage;
    render(<MessageInspectDrawer message={upload} onClose={() => undefined} channelArn={CHANNEL} />);
    expect(screen.queryByTestId('document-score')).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
