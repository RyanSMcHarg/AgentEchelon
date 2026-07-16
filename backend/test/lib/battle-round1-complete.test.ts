/**
 * isBattleRound1Complete — SPEC-BATTLE.md round-1 completion table.
 * Round-2 must not fire until each bot truly finished round-1: for
 * TASK_* that's the task chain reaching terminal, NOT the first async
 * update. Non-TASK / unknown paths complete immediately (preserving
 * the prior unconditional behaviour, so a battle can't get stranded).
 */
import { isBattleRound1Complete } from '../../lambda/src/lib/async-processor-core';

describe('isBattleRound1Complete', () => {
  it('DIRECT / PLACEHOLDER_UPDATE complete immediately', () => {
    expect(isBattleRound1Complete({ deliveryOption: 'DIRECT' })).toBe(true);
    expect(isBattleRound1Complete({ deliveryOption: 'PLACEHOLDER_UPDATE' })).toBe(true);
  });

  it('unknown / absent deliveryOption falls back to complete (never strands a battle)', () => {
    expect(isBattleRound1Complete({})).toBe(true);
    expect(isBattleRound1Complete({ deliveryOption: 'SOMETHING_NEW' })).toBe(true);
  });

  it('TASK_* is NOT complete mid-chain', () => {
    expect(
      isBattleRound1Complete({
        deliveryOption: 'TASK_MULTI_STEP',
        taskType: 'report_generation',
        taskState: 'generating',
        taskStatus: 'in_progress',
      }),
    ).toBe(false);
    expect(
      isBattleRound1Complete({
        deliveryOption: 'TASK_UPDATE_IN_PLACE',
        taskType: 'data_extraction',
        taskState: 'extracting',
        taskStatus: 'pending',
      }),
    ).toBe(false);
  });

  it('TASK_* complete when status is completed or failed', () => {
    expect(
      isBattleRound1Complete({ deliveryOption: 'TASK_MULTI_STEP', taskStatus: 'completed' }),
    ).toBe(true);
    expect(
      isBattleRound1Complete({ deliveryOption: 'TASK_MULTI_STEP', taskStatus: 'failed' }),
    ).toBe(true);
  });

  it('TASK_* complete at a terminal taskState (per the state machine)', () => {
    // report_generation / data_extraction terminal = 'completed'
    expect(
      isBattleRound1Complete({
        deliveryOption: 'TASK_MULTI_STEP',
        taskType: 'report_generation',
        taskState: 'completed',
      }),
    ).toBe(true);
    // guided_troubleshooting end states
    expect(
      isBattleRound1Complete({
        deliveryOption: 'TASK_MULTI_STEP',
        taskType: 'guided_troubleshooting',
        taskState: 'resolved',
      }),
    ).toBe(true);
    expect(
      isBattleRound1Complete({
        deliveryOption: 'TASK_MULTI_STEP',
        taskType: 'guided_troubleshooting',
        taskState: 'escalated',
      }),
    ).toBe(true);
  });

  it('TASK_* complete when taskState is the last state of its machine', () => {
    // (defense: even if not in the universal terminal set, last-of-machine counts)
    expect(
      isBattleRound1Complete({
        deliveryOption: 'TASK_UPDATE_IN_PLACE',
        taskType: 'data_extraction',
        taskState: 'completed', // last of data_extraction
      }),
    ).toBe(true);
  });
});
