/**
 * THE ASSISTANT ANSWERED. THE DEFINITION IS WHAT IT WAS SERVING.
 *
 * The L1 banner read "Served by assistant X" off `assistant`, which the query derives as the MODAL
 * `profileName` over the rows - the definition served. The rows themselves were selected by the ASSISTANT
 * that answered (`e.agent_type`, migration 058). The two agree on ordinary traffic and come apart
 * exactly on a duel, where an assistant serves a rival's definition, so the banner could name an assistant
 * that did not answer a single one of the turns being counted.
 *
 * MODE() collapses a mixed intent to whichever name won a plurality, too, with nothing on the page
 * saying several definitions were in play - a single name over several definitions is not a summary of
 * them, it is the wrong answer stated confidently.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import EffectivenessTab from './EffectivenessTab';
import { EMPTY_FILTERS } from './PerformanceFilters';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn().mockResolvedValue({ data: [] }) }));

const RANGE = { start: '2026-09-01', end: '2026-09-08' };

const row = (over: Record<string, unknown> = {}) => ({
  intent: 'general', exchange_count: 100, direct_count: 100, task_count: 0,
  avg_confidence: 90, avg_relevance: 85, relevance_scored_count: 90,
  answering_assistant: 'premium-assistant',
  assistant: 'premium-assistant',
  assistant_definition_count: 1,
  profile_version: 3,
  ...over,
});

const renderL1 = (over: Record<string, unknown> = {}) =>
  render(
    <EffectivenessTab
      data={{ data: [row(over)] } as never}
      dateRange={RANGE}
      isLoading={false}
      drill={{ level: 1, intent: 'general' }}
      onDrillChange={vi.fn()}
      filters={EMPTY_FILTERS}
      onFiltersChange={vi.fn()}
    />,
  );

/** The banner is the first description paragraph on the drill. */
const banner = () => screen.getByText(/Answered by/).closest('p')!;

describe('the banner names the assistant that answered', () => {
  it('leads with the assistant that answered and calls the served definition what it is', () => {
    // The duel shape: this assistant answered, and it was serving a rival's definition while doing it.
    renderL1({ answering_assistant: 'premium-assistant', assistant: 'challenger-profile' });
    expect(banner().textContent).toMatch(/Answered by\s*premium-assistant/);
    expect(banner().textContent).toMatch(/serving the\s*challenger-profile\s*definition/);
  });

  it('does not repeat the name when the assistant was serving its own definition', () => {
    renderL1();
    expect(banner().textContent).toMatch(/Answered by\s*premium-assistant/);
    expect(banner().textContent).not.toMatch(/serving the/);
    expect(banner().textContent).toMatch(/profile\s*v3/);
  });

  it('says several definitions served the intent rather than printing one as the whole story', () => {
    renderL1({ assistant: 'challenger-profile', assistant_definition_count: 3 });
    const text = banner().textContent!;
    expect(text).toMatch(/3 different assistant definitions/);
    // The modal name may be mentioned, but only as the most frequent one - never on its own.
    expect(text).toMatch(/most often/);
    expect(text).not.toMatch(/serving the\s*challenger-profile\s*definition/);
  });

  it('reads the answering assistant from assistant where the row carries it under that name', () => {
    // A deployment whose query predates the `answering_assistant` column still names the assistant that answered,
    // rather than falling back to the definition or to no name at all.
    renderL1({ answering_assistant: undefined, assistant: 'basic-assistant' });
    expect(banner().textContent).toMatch(/Answered by\s*basic-assistant/);
  });
});
