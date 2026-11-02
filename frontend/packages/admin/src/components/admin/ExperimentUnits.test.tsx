/**
 * THE UNIT OF ANALYSIS ON SCREEN (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §4.2).
 *
 * Every test the backend runs counts conversations, and the means are over exchanges, so the console states
 * both: an operator reading "400 exchanges" next to a verdict computed from 12 conversations would read far
 * more evidence into it than it holds.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ExperimentUnitsRow } from '@ae/shared';
import {
  SampleMeta,
  SampleConversationsCells,
  UnitOfAnalysisNote,
  smallestConversationCount,
  unitsForExperiment,
} from './ExperimentUnits';

const row = (experimentId: string, variantId: string, conversations: number, exchanges: number): ExperimentUnitsRow => ({
  experiment_id: experimentId, variant_id: variantId, unit: 'conversation',
  conversation_count: conversations, exchange_count: exchanges,
  scored_conversation_count: conversations, scored_count: exchanges,
});

describe('unitsForExperiment', () => {
  it('keys one experiment\'s variants, ignoring every other experiment', () => {
    const m = unitsForExperiment([row('exp-1', 'control', 12, 400), row('exp-1', 'treatment', 11, 380), row('exp-2', 'control', 3, 9)], 'exp-1');
    expect(m.size).toBe(2);
    expect(m.get('control')).toEqual({ conversation_count: 12, exchange_count: 400 });
  });

  it('is empty when the backend sent no units', () => {
    expect(unitsForExperiment(undefined, 'exp-1').size).toBe(0);
  });
});

describe('the comparison states conversations beside exchanges', () => {
  it('the header reads both totals', () => {
    render(<SampleMeta variants={[{ conversation_count: 12, exchange_count: 400 }, { conversation_count: 11, exchange_count: 380 }]} />);
    expect(screen.getByTestId('exp-sample-meta').textContent).toBe('23 conversations · 780 exchanges');
  });

  it('a row names the conversations each side was tested on', () => {
    render(<SampleConversationsCells control={{ conversation_count: 12, exchange_count: 400 }} treatment={{ conversation_count: 11, exchange_count: 380 }} />);
    expect(screen.getByText('Sample (conversations)')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('11')).toBeTruthy();
  });
});

describe('the recommendation names its unit', () => {
  it('per side, in conversations and exchanges', () => {
    render(
      <UnitOfAnalysisNote
        variants={[
          { variant_id: 'control', conversation_count: 12, exchange_count: 400 },
          { variant_id: 'treatment', conversation_count: 11, exchange_count: 380 },
        ]}
      />,
    );
    expect(screen.getByTestId('exp-reco-unit').textContent).toBe(
      'Tested per conversation: control 12 conversations (400 exchanges), treatment 11 conversations (380 exchanges).',
    );
  });

  it('says nothing for a payload that does not carry conversations, rather than inventing them', () => {
    const { container } = render(
      <UnitOfAnalysisNote variants={[{ variant_id: 'control', exchange_count: 40 }, { variant_id: 'treatment', exchange_count: 40 }]} />,
    );
    expect(container.textContent).toBe('');
  });
});

describe('the floor counts conversations', () => {
  it('the smallest side\'s conversations, not its exchanges', () => {
    expect(smallestConversationCount([{ conversation_count: 3, exchange_count: 300 }, { conversation_count: 9, exchange_count: 20 }])).toBe(3);
  });

  it('null when no side reports conversations, so the caller falls back rather than reading zero', () => {
    expect(smallestConversationCount([{ exchange_count: 300 }, undefined])).toBeNull();
  });
});
