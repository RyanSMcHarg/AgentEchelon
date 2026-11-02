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
  intakeAfterChecking,
  intakeAsStarted,
  parseStoredIntake,
  loadIntakeConfig,
  __clearIntakeConfigCache,
  INTAKE_CONFIG_TTL_MS,
  type IntakeConfig,
  type IntakeState,
  type StoredIntake,
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
    // No greeting of its own: the `onboarding-intake` template's greeting opens it (ADR-062).
    expect(cfg!.greeting).toBeUndefined();
    expect(startIntake(cfg!).reply).toMatch(/^Welcome! I just need a few details before we begin./);
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
    // `asked` pins the fields this intake asks, so an answer turn resolves the same list.
    expect(step.state).toEqual({ cursor: 0, collected: {}, phase: 'collecting', asked: ['company', 'email', 'goal'] });
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

describe('the stored intake (channel context, not the Amazon Lex session)', () => {
  it('parseStoredIntake recovers what was stored, including whose intake it is', () => {
    const stored: StoredIntake = { subject: 'sub-jane', cursor: 1, collected: { company: 'Acme' }, phase: 'collecting' };
    expect(parseStoredIntake(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it('returns null for missing or malformed state, which the router reads as "no intake in progress"', () => {
    // Null is never "answer to the first question": that reading is what let any turn without the Lex
    // session file a not-yet-onboarded person's message under question one.
    expect(parseStoredIntake(undefined)).toBeNull();
    expect(parseStoredIntake(null)).toBeNull();
    expect(parseStoredIntake({})).toBeNull();
    expect(parseStoredIntake({ cursor: 'x' })).toBeNull();
  });

  it('refuses a stored intake that does not name its subject', () => {
    // Only the person being onboarded may advance it, so an intake without a subject cannot be acted on.
    const state: IntakeState = { cursor: 0, collected: {}, phase: 'collecting' };
    expect(parseStoredIntake(state)).toBeNull();
    expect(parseStoredIntake({ ...state, subject: '' })).toBeNull();
  });

  it('a full happy-path run reaches done with the state stored and reloaded each turn', () => {
    // Simulate the router: store + reload the state between every turn.
    let step = startIntake(CONFIG);
    let stored: unknown = JSON.parse(JSON.stringify({ ...step.state, subject: 'sub-jane' }));

    const turns = ['Acme Corp', 'jane@acme.com', 'Evaluate the platform', 'yes'];
    for (const msg of turns) {
      const state = parseStoredIntake(stored)!;
      expect(state.subject).toBe('sub-jane');
      step = advanceIntake(CONFIG, state, msg, 'Jane');
      stored = JSON.parse(JSON.stringify({ ...step.state, subject: state.subject }));
    }
    expect(step.done).toBe(true);
    expect(step.state.phase).toBe('done');
  });
});

describe('loadIntakeConfig is cached for a bounded time, present or absent', () => {
  // A deployer writes the parameter to turn onboarding on. When "absent" was held for the container's
  // warm life, nothing changed until the handler happened to cold-start.
  const PARAM = '/test/assistant/standard/onboarding-intake';
  const INTAKE = JSON.stringify({ greeting: 'hi', fields: [{ key: 'company', prompt: 'Company?' }] });
  let now = 1_000_000;

  beforeEach(() => {
    __clearIntakeConfigCache();
    delete process.env.ONBOARDING_INTAKE;
    process.env.ONBOARDING_INTAKE_PARAM = PARAM;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.ONBOARDING_INTAKE_PARAM;
    __clearIntakeConfigCache();
  });

  it('picks up a newly written parameter within the TTL, with no cold start', async () => {
    const ssmGet = jest.fn().mockResolvedValue(undefined);
    expect(await loadIntakeConfig(ssmGet)).toBeNull();

    ssmGet.mockResolvedValue(INTAKE);
    now += INTAKE_CONFIG_TTL_MS - 1;
    expect(await loadIntakeConfig(ssmGet)).toBeNull(); // still inside the window: no re-read
    expect(ssmGet).toHaveBeenCalledTimes(1);

    now += 1;
    expect((await loadIntakeConfig(ssmGet))?.fields[0].key).toBe('company');
    expect(ssmGet).toHaveBeenCalledTimes(2);
  });

  it('picks up a changed or removed parameter after the TTL', async () => {
    const ssmGet = jest.fn().mockResolvedValue(INTAKE);
    expect(await loadIntakeConfig(ssmGet)).not.toBeNull();

    ssmGet.mockResolvedValue(undefined);
    now += INTAKE_CONFIG_TTL_MS;
    expect(await loadIntakeConfig(ssmGet)).toBeNull();
  });

  it('a failed read disables onboarding only until the TTL passes', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ssmGet = jest.fn().mockRejectedValueOnce(new Error('throttled')).mockResolvedValue(INTAKE);
    expect(await loadIntakeConfig(ssmGet)).toBeNull();

    now += INTAKE_CONFIG_TTL_MS;
    expect(await loadIntakeConfig(ssmGet)).not.toBeNull();
  });

  it('matches the bound the rest of a profile\'s SSM-backed config uses', () => {
    // `resolveActiveProfile` defaults `ttlMs` to 30 seconds.
    expect(INTAKE_CONFIG_TTL_MS).toBe(30_000);
  });
});

/**
 * ── AN INTAKE NEVER SITS IN FRONT OF A QUESTION SOMEBODY IS WAITING ON ─────────────────────────
 *
 * The owner rule is from 2026-09-03 and it was failing live on 2026-09-21. A person opened a premium
 * conversation, was asked "what should I default to covering in reports for you", typed "What is
 * AgentEchelon?" - and that question was STORED as their answer. Every message after it was met with
 * "Please reply yes to confirm or no to start over", because only yes/no advances the confirmation.
 * There was no escape, and the assistant was unreachable.
 *
 * It survived the e2e suite because every provisioned test user was marked onboarded on 2026-09-09,
 * so no test in that suite has ever run an intake. These cases are the coverage that gap left open,
 * and they are unit tests precisely because the engine is pure: no user, no table, no deploy.
 */
describe('advanceIntake — a question is not an answer', () => {
  const collecting: IntakeState = { cursor: 0, collected: {}, phase: 'collecting' };
  const confirming: IntakeState = { cursor: 3, collected: { company: 'Acme' }, phase: 'confirming' };

  it('RELEASES the turn instead of storing a question as the answer', () => {
    const step = advanceIntake(CONFIG, collecting, 'What is AgentEchelon?');
    // The reported message, and the exact thing that must not happen:
    expect(step.state.collected.company).toBeUndefined();
    // Released means the caller routes this turn normally, so the assistant answers the question.
    expect(step.release).toBe(true);
    expect(step.done).toBe(true);
    expect(step.reply).toBe('');
  });

  it('releases from the CONFIRMING phase too, which is where the trap closed', () => {
    // "Please reply yes or no" forever was the symptom; a question here is still a question.
    // Recognised by its question mark rather than by an English interrogative, so this holds for a
    // deployment asking in any language.
    const step = advanceIntake(CONFIG, confirming, 'Who created it?');
    expect(step.release).toBe(true);
    expect(step.state.phase).toBe('done');
  });

  it('KEEPS what was already collected when it releases', () => {
    // The intake is abandoned, not discarded: the caller marks the user onboarded with these, so they
    // are never walked back into the same trap on their next conversation.
    const step = advanceIntake(CONFIG, confirming, 'is this thing on?');
    expect(step.state.collected).toEqual({ company: 'Acme' });
  });

  it('accepts a bail phrase the DEPLOYMENT supplied, in its own words', () => {
    // No bail vocabulary ships in the platform: a list in code is one language compiled into a
    // product whose questions are written in another.
    const withBail: IntakeConfig = { ...CONFIG, bail: ['ya basta', 'no thanks'] };
    for (const phrase of ['ya basta', 'No thanks']) {
      expect(advanceIntake(withBail, collecting, phrase).release).toBe(true);
      expect(advanceIntake(withBail, confirming, phrase).release).toBe(true);
    }
    // And with none configured, the same phrase is just an answer.
    expect(advanceIntake(CONFIG, collecting, 'ya basta').release).toBeFalsy();
  });

  it('still records a REAL answer, so the release is not simply swallowing the intake', () => {
    // The negative control. Without it, "everything releases" would pass every case above and make
    // the intake incapable of collecting anything at all.
    const step = advanceIntake(CONFIG, collecting, 'Acme Corp');
    expect(step.release).toBeFalsy();
    expect(step.state.collected.company).toBe('Acme Corp');
  });

  it('does not release an answer that merely CONTAINS a bail phrase', () => {
    // Whole-string matching: a company called "Stop Loss Reporting" is an answer, not a bail.
    const withBail: IntakeConfig = { ...CONFIG, bail: ['stop'] };
    const step = advanceIntake(withBail, collecting, 'Stop Loss Reporting Ltd');
    expect(step.release).toBeFalsy();
    expect(step.state.collected.company).toBe('Stop Loss Reporting Ltd');
  });

  it('still confirms on yes, so the ordinary completion path is intact', () => {
    const step = advanceIntake(CONFIG, confirming, 'yes');
    expect(step.done).toBe(true);
    expect(step.release).toBeFalsy();
    expect(step.reply).not.toBe('');
  });
});

/**
 * ── AN OFFER: ONE YES/NO, ASKED ONCE, ANSWERED EITHER WAY ─────────────────────────────────────
 *
 * The shape basic needs: offer an overview of the platform, deliver it on yes,
 * acknowledge on no, and never ask again either way. It is NOT a field - there is nothing to record
 * and nothing to confirm, so the summary step that made the previous intake feel like a form is
 * skipped entirely.
 */
describe('advanceIntake — an offer', () => {
  const OFFER: IntakeConfig = {
    greeting: 'Hi.',
    fields: [],
    offer: {
      ask: 'Would you like a quick overview?',
      // THE DEPLOYMENT SUPPLIES ITS OWN ANSWER WORDS. Deliberately not English here, to prove the
      // platform matches what the config says rather than what a regex in the code believes.
      affirmative: ['si', 'oui', 'yes'],
      negative: ['no', 'non'],
      onAccept: 'THE OVERVIEW.',
      onDecline: 'No problem.',
      accessHas: 'You already hold more than this room.',
      accessNeeds: 'Request more access for additional data.',
    },
  };
  const asked: IntakeState = { cursor: 0, collected: {}, phase: 'confirming', asked: [] };

  it('is a usable intake even with no fields', () => {
    // `fields: []` used to mean "disabled", which would have dropped an offer-only config on the floor.
    expect(isOnboardingEnabled(OFFER)).toBe(true);
  });

  it('asks the offer after the greeting, with no field prompt', () => {
    const step = startIntake(OFFER);
    expect(step.reply).toBe('Hi.\n\nWould you like a quick overview?');
    expect(step.state.phase).toBe('confirming');
    expect(step.state.asked).toEqual([]);
  });

  it('YES delivers the overview and completes, in the configured language', () => {
    expect(advanceIntake(OFFER, asked, 'si').done).toBe(true);
    expect(advanceIntake(OFFER, asked, 'si').reply).toContain('THE OVERVIEW.');
    const step = advanceIntake(OFFER, asked, 'yes');
    expect(step.done).toBe(true);
    expect(step.reply).toContain('THE OVERVIEW.');
    expect(step.state.phase).toBe('done');
  });

  it('NO acknowledges, completes, and does NOT deliver the overview', () => {
    // "they are onboarded, the agent doesn't go into detail and doesn't ask again".
    const step = advanceIntake(OFFER, asked, 'no');
    expect(step.done).toBe(true);
    expect(step.reply).toBe('No problem.');
    expect(step.reply).not.toContain('THE OVERVIEW');
  });

  it('states what their access means, and states the RIGHT one', () => {
    expect(advanceIntake(OFFER, asked, 'yes', undefined, true).reply).toContain('already hold more');
    expect(advanceIntake(OFFER, asked, 'yes', undefined, false).reply).toContain('Request more access');
  });

  it('SAYS NOTHING ABOUT ACCESS when clearance could not be resolved', () => {
    // `resolveUserClearance` answers `basic` for any failure, so guessing here would tell a premium
    // holder to request premium. Silence is the smaller harm.
    const step = advanceIntake(OFFER, asked, 'yes', undefined, undefined);
    expect(step.reply).toBe('THE OVERVIEW.');
    expect(step.reply).not.toContain('Request more access');
    expect(step.reply).not.toContain('already hold more');
  });

  it('never states access on a decline', () => {
    expect(advanceIntake(OFFER, asked, 'no', undefined, false).reply).toBe('No problem.');
  });

  it('RELEASES anything that is not one of its two answers, needing no vocabulary of its own', () => {
    // The offer knows only the words the deployment gave it. Everything else is something the person
    // wanted to say, so it goes to the assistant - which is why this path matches no English at all
    // and works the same for a deployment writing in any language.
    for (const other of ['hmm', 'never mind', 'What is AgentEchelon?', 'peut-etre']) {
      const step = advanceIntake(OFFER, asked, other);
      expect(step.release).toBe(true);
      expect(step.done).toBe(true);
    }
  });

  it('RELEASES a question asked instead of an answer, so the assistant takes it', () => {
    // The trap that started all of this: an offer must not swallow a real question either.
    const step = advanceIntake(OFFER, asked, 'What is AgentEchelon?');
    expect(step.release).toBe(true);
    expect(step.done).toBe(true);
  });

  it('an offer config with a missing branch is not a usable offer', () => {
    // Half an offer cannot be run: it could ask and then have nothing to say.
    const half = parseIntakeConfig(JSON.stringify({ greeting: 'Hi.', offer: { ask: 'Want it?' } }));
    expect(half).toBeNull();
  });

  it('an offer with NO ANSWER WORDS is refused, because nothing could ever answer it', () => {
    // Every message would release, so the question would be asked once and mean nothing. The platform
    // has no built-in yes/no to fall back on, deliberately.
    const noWords = parseIntakeConfig(JSON.stringify({
      greeting: 'Hi.',
      offer: { ask: 'Want it?', onAccept: 'A.', onDecline: 'B.' },
    }));
    expect(noWords).toBeNull();
  });
});

describe('an intake ADDS to the welcome rather than replacing it', () => {
  // THE DEFECT THIS PINS. The router composed the orientation welcome BELOW the intake branch and
  // returned before reaching it, so configuring an intake silently cost a deployment its access line,
  // its example prompts and its platform note - the conversation opened on a bare question. Premium
  // hit it live on 2026-09-21; basic would have hit it the moment an intake was configured there.
  const WELCOME = 'Hi - I am your assistant at Acme.\n\nA few things you can try:\n- Ask me anything';

  it('opens with the composed welcome, then asks', () => {
    const step = startIntake(CONFIG, WELCOME);
    expect(step.reply.startsWith(WELCOME)).toBe(true);
    expect(step.reply).toContain('What company are you with?');
    // And the config greeting does NOT also appear - the welcome replaces it, not the other way round.
    expect(step.reply).not.toContain('Welcome!');
  });

  it('does the same for an offer', () => {
    const OFFER: IntakeConfig = {
      greeting: 'unused',
      fields: [],
      offer: { ask: 'Want an overview?', onAccept: 'A.', onDecline: 'B.', affirmative: ['yes'], negative: ['no'] },
    };
    const step = startIntake(OFFER, WELCOME);
    expect(step.reply).toBe(`${WELCOME}\n\nWant an overview?`);
  });

  it('falls back to the config greeting when no welcome is supplied', () => {
    // Keeps the pure engine callable on its own, which is what every other case here relies on.
    expect(startIntake(CONFIG).reply.startsWith('Welcome!')).toBe(true);
  });
});

describe('intakeAfterChecking and an offer', () => {
  // THE DEFECT THIS PINS, found only by running it on a deployment. The check drops fields the
  // deployment already asserts and returns null when none are left - so an offer-only config
  // (`fields: []`) resolved to "asking nothing" and the offer was never made. The unit tests all
  // passed, because none of them ran the resolution step the router runs.
  const OFFER_ONLY: IntakeConfig = {
    greeting: 'Hi.',
    fields: [],
    offer: { ask: 'Want it?', onAccept: 'A.', onDecline: 'B.', affirmative: ['yes'], negative: ['no'] },
  };

  it('keeps an offer when there are no fields to check', () => {
    expect(intakeAfterChecking(OFFER_ONLY, { classification: 'basic' })).not.toBeNull();
    expect(intakeAfterChecking(OFFER_ONLY, { classification: 'basic' })!.offer).toBeTruthy();
  });

  it('keeps an offer even when every FIELD is asserted away', () => {
    // An offer asks whether somebody WANTS something; no persona or classification can answer that
    // for them, so nothing can assert it away.
    const mixed: IntakeConfig = {
      ...OFFER_ONLY,
      fields: [{ key: 'company', prompt: 'Which company?', required: false, assertedBy: ['persona'] }],
    };
    const left = intakeAfterChecking(mixed, { hasPersona: true, classification: 'basic' });
    expect(left).not.toBeNull();
    expect(left!.fields).toEqual([]);
    expect(left!.offer).toBeTruthy();
  });

  it('still returns null when there is neither a field left nor an offer', () => {
    const fieldsOnly: IntakeConfig = {
      greeting: 'Hi.',
      fields: [{ key: 'company', prompt: 'Which company?', required: false, assertedBy: ['persona'] }],
    };
    expect(intakeAfterChecking(fieldsOnly, { hasPersona: true })).toBeNull();
  });
});

describe('intakeAsStarted and an offer', () => {
  // THE SECOND HALF OF THE SAME BLIND SPOT. The welcome resolves the intake and pins the keys it
  // asked; the answer turn reads them back. An offer pins NO keys, and an empty list was read as
  // "this conversation asked nothing" - so the answer turn found no intake, never intercepted, and
  // the person's "yes" went to the model as an ordinary question. Asked but unanswerable.
  const OFFER: IntakeConfig = {
    greeting: 'Hi.',
    fields: [],
    offer: { ask: 'Want it?', onAccept: 'A.', onDecline: 'B.', affirmative: ['yes'], negative: ['no'] },
  };

  it('runs the offer for a row that pinned no keys', () => {
    const resolved = intakeAsStarted(OFFER, { asked: [] }, 'basic');
    expect(resolved).not.toBeNull();
    expect(resolved!.offer).toBeTruthy();
  });

  it('the pinned offer can then actually be answered', () => {
    // The end-to-end shape of the defect: resolve as the answer turn does, then answer.
    const resolved = intakeAsStarted(OFFER, { asked: [] }, 'basic')!;
    const step = advanceIntake(resolved, { cursor: 0, collected: {}, phase: 'confirming', asked: [] }, 'yes');
    expect(step.done).toBe(true);
    expect(step.reply).toBe('A.');
  });

  it('still returns null for a FIELD intake that pinned no keys', () => {
    const fieldsOnly: IntakeConfig = {
      greeting: 'Hi.',
      fields: [{ key: 'company', prompt: 'Which company?', required: false }],
    };
    expect(intakeAsStarted(fieldsOnly, { asked: [] }, 'basic')).toBeNull();
  });
});
