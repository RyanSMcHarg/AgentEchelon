/**
 * The Battles section of an experiment's page: one sentence saying who is winning, how each version did
 * across the battles, and each battle as a row that opens the conversation it ran in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { setClassificationsForTest, type Experiment } from '@ae/shared';
import { SAMPLE_CLASSIFICATIONS } from '@ae/shared/config/sampleClassifications.ts';
import ExperimentBattles, { battleSummaryOf, collapseByVariant, tallyBattles } from './ExperimentBattles';
import { queryAnalytics } from '../../services/analyticsService';
import { writeMessageLink } from './messageLink';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);

const range = { start: '2026-10-01', end: '2026-10-30' };

const experiment = {
  experimentId: 'exp-voice',
  description: 'Premium advisor voice',
  status: 'active',
  intent: 'general',
  tiers: ['premium'],
  variants: [
    { variantId: 'control', weight: 50, controlPin: { profileName: 'advisor', version: 12 } },
    { variantId: 'treatment', weight: 50, altPin: { profileName: 'alt-primary-premium', version: 13 } },
  ],
  startDate: '2026-10-01',
  createdAt: '2026-10-01',
  battleEnabled: true,
  sideNames: { control: 'Atlas', treatment: 'Atlas (alt)' },
} as unknown as Experiment;

const rollupRow = (over: Record<string, unknown> = {}) => ({
  experiment_id: 'exp-voice',
  variant_id: 'control',
  conversation_classification: 'premium',
  assistant: 'advisor',
  assistant_role: 'primary',
  profile_version: 12,
  model_name: 'claude-sonnet',
  turn_count: 6,
  battle_count: 3,
  avg_score: 4.2,
  avg_cost_usd: 0.0123,
  battle_wins: 2,
  ...over,
});

const battle = (over: Record<string, unknown> = {}) => ({
  battle_id: 'b-1',
  fought_at: '2026-10-29T10:00:00.000Z',
  started_at: '2026-10-29T09:59:57.000Z',
  start_message_id: 'msg-battle-1',
  channel_arn: 'arn:aws:chime:us-east-1:1:app-instance/x/channel/c-1',
  conversation_classification: 'premium',
  experiment_id: 'exp-voice',
  rounds: 2,
  sides: 2,
  turn_count: 4,
  contenders: [
    { variant_id: 'control', assistant: 'advisor', assistant_role: 'primary', profile_version: 12, model_name: 'claude-sonnet', turn_count: 2, avg_score: 4 },
    { variant_id: 'treatment', assistant: 'advisor', assistant_role: 'alt', profile_version: 13, model_name: 'claude-sonnet', turn_count: 2, avg_score: null },
  ],
  winner_variant_id: 'treatment',
  vote_count: 2,
  decided_at: '2026-10-29T10:05:00.000Z',
  ...over,
});

function prime(battles: unknown[]) {
  mockQuery.mockImplementation(async () => ({ data: battles }) as never);
}

const param = (k: string) => new URLSearchParams(window.location.search).get(k);

beforeEach(() => {
  mockQuery.mockReset();
  setClassificationsForTest(SAMPLE_CLASSIFICATIONS);
  window.history.replaceState(null, '', '/?admin=experiments&exp=exp-voice');
});
afterEach(() => {
  setClassificationsForTest(null);
  window.history.replaceState(null, '', '/');
});

describe('collapseByVariant, battleSummaryOf and tallyBattles', () => {
  it('sums a version across rooms and weights quality by turns', () => {
    const [side] = collapseByVariant([
      rollupRow({ turn_count: 2, battle_count: 1, avg_score: 2, battle_wins: 1 }),
      rollupRow({ conversation_classification: 'standard', turn_count: 6, battle_count: 2, avg_score: 4, battle_wins: 1 }),
    ] as never);
    expect(side.turn_count).toBe(8);
    expect(side.battle_count).toBe(3);
    expect(side.battle_wins).toBe(2);
    expect(side.avg_score).toBe(3.5);
    expect(side.conversation_classification).toBeNull();
  });

  it('counts an experiment\'s battles once, not once per version', () => {
    const summary = battleSummaryOf([rollupRow(), rollupRow({ variant_id: 'treatment', battle_wins: 1 })] as never, 'exp-voice');
    expect(summary).toEqual({ battles: 3, wins: [{ variantId: 'control', wins: 2 }, { variantId: 'treatment', wins: 1 }] });
    expect(battleSummaryOf([] as never, 'exp-voice')).toBeNull();
  });

  it('tells a tie from a battle nobody picked', () => {
    const t = tallyBattles([battle(), battle({ winner_variant_id: 'tie' }), battle({ winner_variant_id: null })] as never);
    expect(t).toMatchObject({ total: 3, ties: 1, notPicked: 1 });
    expect(t.wins.get('treatment')).toBe(1);
  });
});

describe('the Battles section', () => {
  const rollup = [rollupRow({ battle_wins: 1 }), rollupRow({ variant_id: 'treatment', battle_wins: 2, avg_score: null, avg_cost_usd: 0.02 })] as never;

  it('opens with the one-line help and a summary sentence in the experiment\'s terms', async () => {
    prime([battle(), battle({ battle_id: 'b-2' }), battle({ battle_id: 'b-3', winner_variant_id: 'control', vote_count: 1 }), battle({ battle_id: 'b-4', winner_variant_id: null, vote_count: 0, decided_at: null })]);
    render(<ExperimentBattles dateRange={range} experiment={experiment} rollup={rollup} />);
    expect(screen.getByText(/A battle is one run in a conversation: someone in battle mode gets both versions' answers over a few turns and picks the better one\./)).toBeInTheDocument();
    expect(await screen.findByTestId('battles-summary')).toHaveTextContent('Challenger won 2 of 4 battles; 1 not picked yet');
    expect(mockQuery).toHaveBeenCalledWith('battle_results', range, expect.objectContaining({ experimentId: 'exp-voice', limit: '100' }));
  });

  it('shows how each version did, control first, with a tooltip on every column and no turn or A/B columns', async () => {
    prime([battle()]);
    render(<ExperimentBattles dateRange={range} experiment={experiment} rollup={rollup} />);
    const table = await screen.findByTestId('battles-by-version');
    expect(screen.getByRole('heading', { name: 'How each version did in battles' })).toBeInTheDocument();
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.map((h) => h?.replace(/\s+/g, ' ').trim())).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Version/), expect.stringMatching(/^Battles won/), expect.stringMatching(/^Quality per reply/), expect.stringMatching(/^Est\. cost per reply/)]),
    );
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4);
    for (const h of within(table).getAllByRole('columnheader')) expect(within(h).getByRole('button')).toBeInTheDocument();
    expect(within(table).queryByText(/Turns|approval|A\/B/i)).toBeNull();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Control');
    expect(rows[0]).toHaveTextContent('Atlas · v12');
    expect(rows[0]).toHaveTextContent('1 (33% of picks)');
    expect(rows[1]).toHaveTextContent('Challenger');
    expect(rows[1]).toHaveTextContent('Atlas (alt) · v13');
    expect(rows[1]).toHaveTextContent('2 (67% of picks)');
    // An unscored version reads as a dash, not a zero.
    expect(within(rows[1]).getByText('—')).toBeInTheDocument();
  });

  it('lists each battle as when, room, outcome, picked by and Open conversation', async () => {
    prime([battle(), battle({ battle_id: 'b-2', winner_variant_id: null, vote_count: 0 }), battle({ battle_id: 'b-3', winner_variant_id: 'tie', vote_count: 1 })]);
    const onOpenConversation = vi.fn();
    render(<ExperimentBattles dateRange={range} experiment={experiment} rollup={rollup} onOpenConversation={onOpenConversation} />);
    const list = await screen.findByTestId('battles-list');
    expect(within(list).getAllByRole('columnheader').map((h) => h.textContent?.replace('ⓘ', ''))).toEqual(['When', 'Room', 'Outcome', 'Picked by', 'Conversation']);
    // The When heading says what the time is.
    fireEvent.focus(within(list).getByRole('button', { name: /When/ }));
    expect(await screen.findByText('When the battle started')).toBeInTheDocument();
    expect(within(list).getByText('Challenger won')).toBeInTheDocument();
    expect(within(list).getByText('Not picked yet')).toBeInTheDocument();
    expect(within(list).getByText('Tie')).toBeInTheDocument();
    expect(within(list).getByText('2 people')).toBeInTheDocument();
    expect(within(list).getByText('1 person')).toBeInTheDocument();
    fireEvent.click(within(list).getAllByRole('button', { name: 'Open conversation' })[0]);
    expect(onOpenConversation).toHaveBeenCalledTimes(1);
    expect(onOpenConversation).toHaveBeenCalledWith('arn:aws:chime:us-east-1:1:app-instance/x/channel/c-1', expect.objectContaining({ messageId: 'msg-battle-1' }));
  });

  it('opens the conversation AT the /battle message, and the link it builds names that message and its time', async () => {
    prime([battle()]);
    const onOpenConversation = vi.fn();
    render(<ExperimentBattles dateRange={range} experiment={experiment} rollup={rollup} onOpenConversation={onOpenConversation} />);
    const [row] = await screen.findAllByTestId('battle-row');
    // The When column is the time the battle started: the /battle message's own time.
    expect(within(row).getByText(new Date('2026-10-29T09:59:57.000Z').toLocaleString())).toBeInTheDocument();
    fireEvent.click(row.querySelector('td[data-col="room"]')!);
    const link = { messageId: 'msg-battle-1', at: '2026-10-29T09:59:57.000Z', kind: 'battle' };
    expect(onOpenConversation).toHaveBeenCalledWith('arn:aws:chime:us-east-1:1:app-instance/x/channel/c-1', link);
    // The dashboard writes the link into the conversation's URL with the same helper the viewer reads it back with.
    const url = new URL('https://console.example/?admin=conversations&conv=c-1');
    writeMessageLink(url, link as never);
    expect(url.searchParams.get('conv')).toBe('c-1');
    expect(url.searchParams.get('msg')).toBe('msg-battle-1');
    expect(url.searchParams.get('at')).toBe('2026-10-29T09:59:57.000Z');
    expect(url.searchParams.get('kind')).toBe('battle');
  });

  it('a battle whose start message was not found opens at the time it was fought', async () => {
    prime([battle({ started_at: undefined, start_message_id: null })]);
    const onOpenConversation = vi.fn();
    render(<ExperimentBattles dateRange={range} experiment={experiment} rollup={rollup} onOpenConversation={onOpenConversation} />);
    const [row] = await screen.findAllByTestId('battle-row');
    fireEvent.click(row.querySelector('td[data-col="room"]')!);
    expect(onOpenConversation).toHaveBeenCalledWith(expect.any(String), { messageId: null, at: '2026-10-29T10:00:00.000Z', kind: 'battle' });
  });

  it('a row click opens the conversation the battle ran in, and nothing expands', async () => {
    prime([battle(), battle({ battle_id: 'b-2', channel_arn: 'arn:aws:chime:us-east-1:1:app-instance/x/channel/c-2' })]);
    const onOpenConversation = vi.fn();
    render(<ExperimentBattles dateRange={range} experiment={experiment} rollup={rollup} onOpenConversation={onOpenConversation} />);
    const rows = await screen.findAllByTestId('battle-row');
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[1].querySelector('td[data-col="room"]')!);
    expect(onOpenConversation).toHaveBeenCalledWith('arn:aws:chime:us-east-1:1:app-instance/x/channel/c-2', expect.objectContaining({ kind: 'battle' }));
    // No detail and no URL state: the conversation is where a battle is read.
    expect(screen.getAllByTestId('battle-row')).toHaveLength(2);
    expect(param('battle')).toBeNull();
    expect(param('exp')).toBe('exp-voice');
  });

  it('says what to do when there are no battles yet', async () => {
    prime([]);
    render(<ExperimentBattles dateRange={range} experiment={experiment} rollup={[]} />);
    expect(await screen.findByTestId('battles-empty')).toHaveTextContent('Turn on Battle Mode for Premium in Settings below, then run /battle');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('never says duel', async () => {
    prime([battle(), battle({ battle_id: 'b-2', winner_variant_id: null })]);
    const { container } = render(<ExperimentBattles dateRange={range} experiment={experiment} rollup={rollup} />);
    await screen.findAllByTestId('battle-row');
    expect(container.textContent).not.toMatch(/duel/i);
  });
});
