/**
 * Unit tests for the onboarding intake engine (pure FSM).
 *
 * No AWS mocks — the engine is a pure function over (config, state, message).
 */

import {
  parseIntakeConfig,
  isOnboardingEnabled,
  startIntake,
  advanceIntake,
  readIntakeState,
  writeIntakeState,
  INTAKE_STATE_ATTR,
  type IntakeConfig,
  type IntakeState,
} from '../../lambda/src/lib/onboarding-intake';

const CONFIG: IntakeConfig = {
  greeting: 'Welcome! A few quick details first.',
  fields: [
    { key: 'company', prompt: 'What company are you with?', required: true },
    { key: 'email', prompt: 'What is your work email?', required: true, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', example: 'you@acme.com' },
    { key: 'goal', prompt: 'What are you hoping to accomplish? (optional)', required: false },
  ],
  completion: 'Thanks, {name} — all set. How can I help?',
};

describe('parseIntakeConfig', () => {
  it('parses a valid config and defaults required=true', () => {
    const cfg = parseIntakeConfig(JSON.stringify({ fields: [{ key: 'a', prompt: 'A?' }] }));
    expect(cfg).not.toBeNull();
    expect(cfg!.fields[0].required).toBe(true);
    expect(cfg!.greeting).toMatch(/./); // has a default greeting
  });

  it('drops fields with no key or no prompt', () => {
    const cfg = parseIntakeConfig(JSON.stringify({ fields: [{ key: '', prompt: 'x' }, { key: 'ok', prompt: 'Ok?' }] }));
    expect(cfg!.fields).toHaveLength(1);
    expect(cfg!.fields[0].key).toBe('ok');
  });

  it('returns null for malformed JSON', () => {
    expect(parseIntakeConfig('{not json')).toBeNull();
  });

  it('returns null when there are no usable fields (disabled)', () => {
    expect(parseIntakeConfig(JSON.stringify({ fields: [] }))).toBeNull();
    expect(parseIntakeConfig(JSON.stringify({ greeting: 'hi' }))).toBeNull();
  });

  it('isOnboardingEnabled reflects presence of fields', () => {
    expect(isOnboardingEnabled(CONFIG)).toBe(true);
    expect(isOnboardingEnabled(null)).toBe(false);
  });
});

describe('startIntake', () => {
  it('greets and asks the first field', () => {
    const step = startIntake(CONFIG);
    expect(step.done).toBe(false);
    expect(step.reply).toContain('Welcome!');
    expect(step.reply).toContain('What company are you with?');
    expect(step.state).toEqual({ cursor: 0, collected: {}, phase: 'collecting' });
  });
});

describe('advanceIntake — collecting', () => {
  it('records an answer and asks the next field', () => {
    const s0: IntakeState = { cursor: 0, collected: {}, phase: 'collecting' };
    const step = advanceIntake(CONFIG, s0, 'Acme Corp');
    expect(step.state.collected.company).toBe('Acme Corp');
    expect(step.state.cursor).toBe(1);
    expect(step.reply).toBe('What is your work email?');
    expect(step.done).toBe(false);
  });

  it('re-asks a required field left blank, without advancing', () => {
    const s0: IntakeState = { cursor: 0, collected: {}, phase: 'collecting' };
    const step = advanceIntake(CONFIG, s0, '   ');
    expect(step.state.cursor).toBe(0);
    expect(step.state.collected.company).toBeUndefined();
    expect(step.reply).toMatch(/required/i);
  });

  it('rejects an answer that fails a required field pattern', () => {
    const s1: IntakeState = { cursor: 1, collected: { company: 'Acme' }, phase: 'collecting' };
    const bad = advanceIntake(CONFIG, s1, 'not-an-email');
    expect(bad.state.cursor).toBe(1);
    expect(bad.state.collected.email).toBeUndefined();
    expect(bad.reply).toContain('you@acme.com');
  });

  it('accepts an answer that passes the pattern', () => {
    const s1: IntakeState = { cursor: 1, collected: { company: 'Acme' }, phase: 'collecting' };
    const ok = advanceIntake(CONFIG, s1, 'jane@acme.com');
    expect(ok.state.collected.email).toBe('jane@acme.com');
    expect(ok.state.cursor).toBe(2);
    expect(ok.reply).toContain('accomplish');
  });

  it('lets an optional field be skipped and moves to confirmation', () => {
    const s2: IntakeState = { cursor: 2, collected: { company: 'Acme', email: 'jane@acme.com' }, phase: 'collecting' };
    const step = advanceIntake(CONFIG, s2, 'skip');
    expect(step.state.phase).toBe('confirming');
    expect(step.reply).toMatch(/Is this correct/i);
    // skipped optional field shows as (skipped) in the summary
    expect(step.reply).toContain('(skipped)');
  });

  it('after the last field, moves to confirmation with a summary', () => {
    const s2: IntakeState = { cursor: 2, collected: { company: 'Acme', email: 'jane@acme.com' }, phase: 'collecting' };
    const step = advanceIntake(CONFIG, s2, 'Evaluate the platform');
    expect(step.state.phase).toBe('confirming');
    expect(step.reply).toContain('Acme');
    expect(step.reply).toContain('jane@acme.com');
    expect(step.reply).toContain('Evaluate the platform');
  });
});

describe('advanceIntake — confirming', () => {
  const confirming: IntakeState = {
    cursor: 3,
    collected: { company: 'Acme', email: 'jane@acme.com', goal: 'Evaluate' },
    phase: 'confirming',
  };

  it('yes completes the intake (done) with the name interpolated', () => {
    const step = advanceIntake(CONFIG, confirming, 'yes', 'Jane');
    expect(step.done).toBe(true);
    expect(step.state.phase).toBe('done');
    expect(step.reply).toContain('Jane');
  });

  it('completion drops the name when unknown', () => {
    const step = advanceIntake(CONFIG, confirming, 'yes', 'there');
    expect(step.done).toBe(true);
    expect(step.reply).not.toMatch(/,\s*there/);
  });

  it('no restarts the intake from the first field, clearing collected', () => {
    const step = advanceIntake(CONFIG, confirming, 'no');
    expect(step.done).toBe(false);
    expect(step.state.phase).toBe('collecting');
    expect(step.state.cursor).toBe(0);
    expect(step.state.collected).toEqual({});
    expect(step.reply).toContain('What company are you with?');
  });

  it('an ambiguous reply re-asks the summary without losing data', () => {
    const step = advanceIntake(CONFIG, confirming, 'maybe later actually');
    expect(step.done).toBe(false);
    expect(step.state.phase).toBe('confirming');
    expect(step.state.collected).toEqual(confirming.collected);
    expect(step.reply).toMatch(/yes.*no/i);
  });
});

describe('sessionAttributes round-trip', () => {
  it('writeIntakeState then readIntakeState recovers the state', () => {
    const state: IntakeState = { cursor: 1, collected: { company: 'Acme' }, phase: 'collecting' };
    const attrs = writeIntakeState(state);
    expect(attrs[INTAKE_STATE_ATTR]).toBeDefined();
    expect(readIntakeState(attrs)).toEqual(state);
  });

  it('readIntakeState returns null for missing or corrupt state', () => {
    expect(readIntakeState(undefined)).toBeNull();
    expect(readIntakeState({})).toBeNull();
    expect(readIntakeState({ [INTAKE_STATE_ATTR]: '{bad' })).toBeNull();
    expect(readIntakeState({ [INTAKE_STATE_ATTR]: JSON.stringify({ cursor: 'x' }) })).toBeNull();
  });

  it('a full happy-path run reaches done via serialised state each turn', () => {
    // Simulate the router: persist + reload state between every turn.
    let step = startIntake(CONFIG);
    let attrs = writeIntakeState(step.state);

    const turns = ['Acme Corp', 'jane@acme.com', 'Evaluate the platform', 'yes'];
    for (const msg of turns) {
      const state = readIntakeState(attrs)!;
      step = advanceIntake(CONFIG, state, msg, 'Jane');
      attrs = writeIntakeState(step.state);
    }
    expect(step.done).toBe(true);
    expect(step.state.phase).toBe('done');
  });
});
