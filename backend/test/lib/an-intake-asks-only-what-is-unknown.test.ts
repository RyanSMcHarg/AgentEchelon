/**
 * AN INTAKE ASKS ONLY FOR WHAT THE DEPLOYMENT DOES NOT ALREADY ASSERT.
 *
 * Owner rule 2026-09-03, "cheap" chosen 2026-09-14.
 *
 * Opening a standard conversation, the assistant asked "What company are you with?" - in a deployment
 * whose persona opens "You are the internal assistant for Stratum Technologies". Its two fields were
 * `company` and `role`: the two facts the deployment already asserts, because the persona names the
 * company and the CLASSIFICATION is the role claim (standard = employee access, premium = leadership).
 * It then stored the answer as new information, free to contradict the persona.
 *
 * The rule: an intake runs only after the assistant has CHECKED and cannot resolve the field, and if
 * it runs at all it belongs at conversation OPEN rather than in front of a question somebody is
 * already waiting on. Intake becomes a fallback, not a gate.
 *
 * CHECKED IS CHEAP BY DECISION: only what the turn already holds. A thorough check that consults
 * company docs would cost a tool call before the first reply, which is the very thing the second half
 * of the rule forbids.
 */
import {
  parseIntakeConfig,
  fieldIsAsserted,
  intakeAfterChecking,
  isOnboardingEnabled,
  intakeAsStarted,
  startIntake,
  advanceIntake,
  parseStoredIntake,
  type IntakeConfig,
  type IntakeField,
} from '../../lambda/src/lib/onboarding-intake';
import * as fs from 'fs';
import * as path from 'path';

/** The reported deployment: the two fields that drove this, declared as asserted. */
const STRATUM: IntakeConfig = {
  greeting: 'Welcome!',
  fields: [
    { key: 'company', prompt: 'What company are you with?', required: true, assertedBy: ['persona'] },
    { key: 'role', prompt: 'What is your role?', required: true, assertedBy: ['classification'] },
  ],
};

describe('a field the deployment already asserts is not asked', () => {
  it('asks nothing at all when every field is asserted - the reported case', () => {
    const left = intakeAfterChecking(STRATUM, { hasPersona: true, classification: 'standard' });
    // null, not an empty intake: `isOnboardingEnabled` then reads it as disabled and the conversation
    // opens normally with no questions.
    expect(left).toBeNull();
    expect(isOnboardingEnabled(left)).toBe(false);
  });

  it('still asks for a field nothing asserts', () => {
    const config: IntakeConfig = {
      ...STRATUM,
      fields: [...STRATUM.fields, { key: 'project', prompt: 'Which project?', required: true }],
    };
    const left = intakeAfterChecking(config, { hasPersona: true, classification: 'standard' });
    expect(left?.fields.map((f) => f.key)).toEqual(['project']);
  });

  it('asks when the assertion cannot be resolved, rather than skipping on a guess', () => {
    // A deployment whose persona seam is not visible from this handler. The field is ASKED - the
    // annoying direction - rather than silently dropped, which would lose the data with nothing to
    // show it happened.
    const left = intakeAfterChecking(STRATUM, { hasPersona: false, classification: null });
    expect(left?.fields.map((f) => f.key)).toEqual(['company', 'role']);
  });

  it('reads a profile value only when there is a real one', () => {
    const field: IntakeField = { key: 'company', prompt: 'q', required: true, assertedBy: ['profile'] };
    expect(fieldIsAsserted(field, { profileFacts: { company: 'Stratum' } })).toBe(true);
    // Present-but-empty is not an answer, and neither is a missing key or an absent profile.
    expect(fieldIsAsserted(field, { profileFacts: { company: '   ' } })).toBe(false);
    expect(fieldIsAsserted(field, { profileFacts: { role: 'staff' } })).toBe(false);
    expect(fieldIsAsserted(field, { profileFacts: null })).toBe(false);
  });

  it('leaves a config with no assertions exactly as it was', () => {
    const plain: IntakeConfig = {
      greeting: 'hi', fields: [{ key: 'a', prompt: 'q', required: true }],
    };
    // Same object back, so a deployment that never opted in sees no behaviour change at all.
    expect(intakeAfterChecking(plain, { hasPersona: true, classification: 'premium' })).toBe(plain);
  });
});

describe('the answer path runs the intake the welcome started', () => {
  const MIDDLE: IntakeConfig = {
    greeting: 'Welcome!',
    fields: [
      { key: 'company', prompt: 'What company are you with?', required: true },
      { key: 'role', prompt: 'What is your role?', required: true, assertedBy: ['classification'] },
      { key: 'goal', prompt: 'What are you hoping to do?', required: true },
    ],
  };

  it('files each answer under its own key when a middle field is asserted', () => {
    // The welcome's resolution, pinned on the row by `startIntake`.
    const asked = intakeAfterChecking(MIDDLE, { classification: 'standard' })!;
    let step = startIntake(asked);
    expect(step.state.asked).toEqual(['company', 'goal']);

    // Every answer turn reads the row back and resolves the intake from it, never from the full list.
    for (const answer of ['Acme', 'Ship it']) {
      const stored = parseStoredIntake(JSON.parse(JSON.stringify({ ...step.state, subject: 'alice' })))!;
      step = advanceIntake(intakeAsStarted(MIDDLE, stored, 'standard')!, stored, answer);
    }
    expect(step.state.phase).toBe('confirming');
    expect(step.state.collected).toEqual({ company: 'Acme', goal: 'Ship it' });
  });

  it('keeps the pinned list when the intake is restarted from the summary', () => {
    const asked = intakeAfterChecking(MIDDLE, { classification: 'standard' })!;
    const confirming = { cursor: 2, collected: { company: 'Acme', goal: 'x' }, phase: 'confirming' as const, asked: ['company', 'goal'] };
    expect(advanceIntake(asked, confirming, 'no').state.asked).toEqual(['company', 'goal']);
  });

  it('does not depend on facts that can change mid-intake', () => {
    // A pinned list ignores what the check would say now: here the persona became visible after start.
    const persona: IntakeConfig = { ...MIDDLE, fields: [{ ...MIDDLE.fields[0], assertedBy: ['persona'] }, MIDDLE.fields[2]] };
    expect(intakeAsStarted(persona, { asked: ['company', 'goal'] }, 'standard')?.fields.map((f) => f.key))
      .toEqual(['company', 'goal']);
  });

  it('refuses to guess when a pinned key is gone from the deployed intake', () => {
    expect(intakeAsStarted({ ...MIDDLE, fields: [MIDDLE.fields[0]] }, { asked: ['company', 'goal'] }, 'standard')).toBeNull();
  });
});

describe('the config parser is strict about assertions', () => {
  it('keeps the ones it knows', () => {
    const c = parseIntakeConfig(JSON.stringify({
      greeting: 'hi',
      fields: [{ key: 'company', prompt: 'q', assertedBy: ['persona', 'profile'] }],
    }));
    expect(c?.fields[0].assertedBy).toEqual(['persona', 'profile']);
  });

  it('DROPS one it does not, so a typo asks rather than silently skipping', () => {
    // The failure direction is the point. "ask anyway" is annoying; "never ask" loses the field with
    // nothing to show for it.
    const c = parseIntakeConfig(JSON.stringify({
      greeting: 'hi',
      fields: [{ key: 'company', prompt: 'q', assertedBy: ['persoan', 'classification'] }],
    }));
    expect(c?.fields[0].assertedBy).toEqual(['classification']);
  });

  it('accepts a config with no assertions, unchanged', () => {
    const c = parseIntakeConfig(JSON.stringify({ greeting: 'hi', fields: [{ key: 'a', prompt: 'q' }] }));
    expect(c?.fields[0].assertedBy).toBeUndefined();
  });
});

describe('the other half of the rule: an intake runs at conversation OPEN', () => {
  it('is applied on the WelcomeIntent path, not in front of a waiting question', () => {
    const router = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');
    const idx = router.indexOf('intakeAfterChecking(');
    expect(idx).toBeGreaterThan(-1);
    // The nearest enclosing marker above the call is the WelcomeIntent branch.
    const before = router.slice(0, idx);
    expect(before.lastIndexOf('WelcomeIntent')).toBeGreaterThan(before.lastIndexOf('async function handler'));
  });

  it('spends no tool call to decide - "checked" is cheap by decision', () => {
    const router = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');
    // The whole check, from the facts it is given to the intake it starts.
    const from = router.indexOf('const intakeFacts');
    const call = router.slice(from, router.indexOf('startIntake(', from));
    expect(from).toBeGreaterThan(-1);
    // The facts are the active version's persona, the already-resolved classification, and the stored
    // facts the once-per-user gate reads. A company-docs lookup here would sit in front of the first reply.
    expect(`consults company docs: ${/load_company_context|loadCompanyContext/.test(call)}`)
      .toBe('consults company docs: false');
    expect(call).toMatch(/classification: channelClassification/);
  });
});
