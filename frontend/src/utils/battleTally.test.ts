import { describe, it, expect } from 'vitest';
import { computeBattleTally, BATTLE_CONFIDENCE_TARGET, type BattleRoundInput } from './battleTally';

const round = (over: Partial<BattleRoundInput> = {}): BattleRoundInput => ({
  battleId: 'b1',
  sideA: { label: 'Atlas', responseMs: 1000, costUsd: 0.01 },
  sideB: { label: 'Echo', responseMs: 2000, costUsd: 0.02 },
  winner: null,
  ...over,
});

describe('computeBattleTally', () => {
  it('counts wins per stable label even when round A/B order flips', () => {
    const t = computeBattleTally([
      round({ battleId: 'b1', winner: 'A' }), // Atlas wins (A=Atlas)
      // order flipped: A=Echo, B=Atlas; winner B => Atlas wins again
      round({
        battleId: 'b2',
        sideA: { label: 'Echo', responseMs: 2000, costUsd: 0.02 },
        sideB: { label: 'Atlas', responseMs: 1000, costUsd: 0.01 },
        winner: 'B',
      }),
    ]);
    const atlas = t.sides.find((s) => s.label === 'Atlas')!;
    const echo = t.sides.find((s) => s.label === 'Echo')!;
    expect(atlas.wins).toBe(2);
    expect(echo.wins).toBe(0);
    expect(t.qualityLeaderLabel).toBe('Atlas');
  });

  it('tracks picked rounds and ties', () => {
    const t = computeBattleTally([
      round({ battleId: 'b1', winner: 'A' }),
      round({ battleId: 'b2', winner: 'tie' }),
      round({ battleId: 'b3', winner: null }),
    ]);
    expect(t.totalRounds).toBe(3);
    expect(t.pickedRounds).toBe(2);
    expect(t.ties).toBe(1);
    expect(t.qualityLeaderLabel).toBe('Atlas'); // Atlas has the only win
  });

  it('picks the lower-average side as speed and cost leader', () => {
    const t = computeBattleTally([round(), round({ battleId: 'b2' })]);
    expect(t.speedLeaderLabel).toBe('Atlas'); // 1000 < 2000
    expect(t.costLeaderLabel).toBe('Atlas'); // 0.01 < 0.02
    const atlas = t.sides.find((s) => s.label === 'Atlas')!;
    expect(atlas.avgResponseMs).toBe(1000);
    expect(atlas.avgCostUsd).toBeCloseTo(0.01, 5);
  });

  it('returns null leaders on a tie or when a side lacks data', () => {
    const equal = computeBattleTally([
      round({ sideA: { label: 'Atlas', responseMs: 1000 }, sideB: { label: 'Echo', responseMs: 1000 } }),
    ]);
    expect(equal.speedLeaderLabel).toBeNull();
    expect(equal.qualityLeaderLabel).toBeNull(); // no picks yet

    const oneSided = computeBattleTally([
      round({ sideA: { label: 'Atlas', responseMs: 1000 }, sideB: { label: 'Echo' } }),
    ]);
    expect(oneSided.speedLeaderLabel).toBeNull(); // only one side has speed data
  });

  it('skips incomplete pairs and defaults the target', () => {
    const t = computeBattleTally([
      round(),
      { battleId: 'bx', sideA: { label: 'Atlas' }, sideB: { label: '' }, winner: 'A' },
    ]);
    expect(t.totalRounds).toBe(1);
    expect(t.target).toBe(BATTLE_CONFIDENCE_TARGET);
  });

  it('averages metrics only over rounds that carried them', () => {
    const t = computeBattleTally([
      round({ sideA: { label: 'Atlas', costUsd: 0.02 }, sideB: { label: 'Echo', costUsd: 0.04 } }),
      round({ battleId: 'b2', sideA: { label: 'Atlas', costUsd: null }, sideB: { label: 'Echo', costUsd: 0.06 } }),
    ]);
    const atlas = t.sides.find((s) => s.label === 'Atlas')!;
    const echo = t.sides.find((s) => s.label === 'Echo')!;
    expect(atlas.avgCostUsd).toBeCloseTo(0.02, 5); // only the first round had a cost
    expect(echo.avgCostUsd).toBeCloseTo(0.05, 5); // (0.04 + 0.06) / 2
  });
});
