import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@ae/shared/i18n';
import TemplateOutcomesPanel from './TemplateOutcomesPanel';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

/** Document templates (SPEC-DOCUMENT-TEMPLATES FR8): each check outcome over the template's deliveries. */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);
const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });
const range = { start: '2026-10-01', end: '2026-10-26' };

beforeEach(() => mockQuery.mockReset());

describe('the document templates panel', () => {
  it('shows each outcome over the deliveries, and flags a row spanning a template edit', async () => {
    mockQuery.mockResolvedValue(result([{
      assistant: 'analyst', conversation_classification: 'premium', template: 'quarterly-account-review',
      deliveries: 8, passed: 5, passed_after_correction: 2, posted_inline: 1, filled_by_platform: 0, template_versions: 2,
    }]));
    render(<TemplateOutcomesPanel dateRange={range} />);
    expect(await screen.findByText('quarterly-account-review')).toBeInTheDocument();
    expect(screen.getByText('(2 versions)')).toBeInTheDocument();
    expect(screen.getByText('5 of 8')).toBeInTheDocument();
    expect(screen.getByText('2 of 8')).toBeInTheDocument();
    expect(screen.getByText('1 of 8')).toBeInTheDocument();
  });
});
