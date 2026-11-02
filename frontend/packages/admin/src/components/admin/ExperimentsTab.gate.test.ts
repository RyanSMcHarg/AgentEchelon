import { describe, it, expect } from 'vitest';
import { gateRunsFor } from './ExperimentsTab';

// A CLASSIFIER REPLAY IS EVIDENCE ABOUT THE CLASSIFICATION IT RAN IN (tenet D12). A classification split is
// gated only by a finished run of the same pair in a classification the split covers; a run that names no
// classification read every classification's traffic and gates nothing.

const run = (over: Record<string, string> = {}): Record<string, string> => ({
  runId: 'r', status: 'complete', incumbentModel: 'haiku', challengerModel: 'sonnet', classification: 'standard', ...over,
});

describe('gateRunsFor', () => {
  it('takes a finished run of the pair, either way round, in a covered classification', () => {
    expect(gateRunsFor([run()], 'haiku', 'sonnet', ['standard'])).toHaveLength(1);
    expect(gateRunsFor([run()], 'sonnet', 'haiku', ['standard'])).toHaveLength(1);
  });

  it('refuses a run from another classification', () => {
    expect(gateRunsFor([run({ classification: 'premium' })], 'haiku', 'sonnet', ['standard'])).toEqual([]);
  });

  it('refuses a run that names no classification', () => {
    expect(gateRunsFor([run({ classification: '' })], 'haiku', 'sonnet', ['standard'])).toEqual([]);
    const legacy = run();
    delete (legacy as Record<string, string | undefined>).classification;
    expect(gateRunsFor([legacy], 'haiku', 'sonnet', ['standard'])).toEqual([]);
  });

  it('refuses an unfinished run and a run of another pair', () => {
    expect(gateRunsFor([run({ status: 'running' })], 'haiku', 'sonnet', ['standard'])).toEqual([]);
    expect(gateRunsFor([run({ challengerModel: 'opus' })], 'haiku', 'sonnet', ['standard'])).toEqual([]);
  });
});
