/**
 * Drift reasoning gate (ADR-013) unit tests.
 *
 * The decision logic is tested via the injectable `invoke` (no Bedrock SDK at
 * test time). Covers verdict parsing, the relevant-tangent vs real-drift
 * mapping, and the fail-safe paths (short message, missing purpose, model error,
 * unparseable output) -- all of which must resolve to NO drift.
 */

// Virtual mock: the Bedrock SDK is only bundled at Lambda runtime.
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({})),
  ConverseCommand: jest.fn(),
}), { virtual: true });

import {
  judgeDrift,
  buildDriftPrompt,
  parseDriftVerdict,
  type DriftJudgeInput,
} from '../lambda/src/lib/drift-reasoning';

const base: DriftJudgeInput = {
  conversationPurpose: 'Help the user prepare for a software engineering job interview',
  userMessage: 'Can you also help me file my taxes for last year?',
  intent: 'GENERAL',
};

const stub = (text: string) => async () => text;

describe('parseDriftVerdict', () => {
  it('parses a DRIFT verdict + reason', () => {
    expect(parseDriftVerdict('VERDICT: DRIFT\nREASON: taxes are unrelated to interview prep'))
      .toEqual({ isDrift: true, rationale: 'taxes are unrelated to interview prep' });
  });
  it('parses a STAY verdict', () => {
    expect(parseDriftVerdict('VERDICT: STAY\nREASON: still about the interview').isDrift).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(parseDriftVerdict('verdict: drift').isDrift).toBe(true);
  });
  it('treats unparseable output as NOT drift (fail-safe)', () => {
    expect(parseDriftVerdict('I think maybe this is off topic?').isDrift).toBe(false);
  });
});

describe('judgeDrift', () => {
  it('returns drift when the model says DRIFT', async () => {
    const r = await judgeDrift(base, stub('VERDICT: DRIFT\nREASON: taxes vs interview'));
    expect(r.isDrift).toBe(true);
    expect(r.confidence).toBe('medium'); // never "high" for a positive drift call
  });

  it('keeps a relevant tangent in-conversation (model says STAY)', async () => {
    // "Do they have consulting roles too?" in a job conversation -> STAY.
    const r = await judgeDrift(
      { ...base, userMessage: 'Do they also have consulting roles I could apply to?' },
      stub('VERDICT: STAY\nREASON: still about the same job search'),
    );
    expect(r.isDrift).toBe(false);
  });

  it('fail-safe: model error -> no drift', async () => {
    const r = await judgeDrift(base, async () => { throw new Error('throttled'); });
    expect(r.isDrift).toBe(false);
    expect(r.rationale).toMatch(/no drift/i);
  });

  it('fail-safe: unparseable output -> no drift', async () => {
    const r = await judgeDrift(base, stub('hmm not sure'));
    expect(r.isDrift).toBe(false);
  });

  it('skips short messages without calling the model', async () => {
    const invoke = jest.fn();
    const r = await judgeDrift({ ...base, userMessage: 'ok thanks' }, invoke);
    expect(r.isDrift).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('skips when there is no conversation purpose', async () => {
    const invoke = jest.fn();
    const r = await judgeDrift({ ...base, conversationPurpose: '' }, invoke);
    expect(r.isDrift).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('buildDriftPrompt', () => {
  it('includes the purpose, message, intent, and the STAY-when-unsure bias', () => {
    const p = buildDriftPrompt(base);
    expect(p).toContain(base.conversationPurpose);
    expect(p).toContain(base.userMessage);
    expect(p).toContain('GENERAL');
    expect(p).toMatch(/prefer STAY/i);
  });
  it('includes recent context only when provided', () => {
    expect(buildDriftPrompt(base)).not.toContain('Recent context');
    expect(buildDriftPrompt({ ...base, recentContext: 'earlier we discussed resumes' }))
      .toContain('Recent context');
  });
});
