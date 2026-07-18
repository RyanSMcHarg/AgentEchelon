/**
 * welcome-orientation - config-driven WelcomeIntent copy. The platform ships a generic welcome;
 * a deployment supplies company/access/examples via SSM with no code change. These lock both the
 * generic fallback (unchanged historical greeting) and the enriched, oriented welcome.
 */
import {
  parseWelcomeOrientation,
  composeWelcomeMessage,
} from '../../lambda/src/lib/welcome-orientation';

const STRATUM = {
  companyName: 'Stratum Technologies',
  companyBlurb: 'an enterprise SaaS company (workflow automation, ~280 people, Austin)',
  accessBlurb: 'You have standard access - internal company info (directory, processes, roadmap).',
  examples: [
    'Who leads the Platform Core team?',
    'Extract the engineering roster by location as a table',
    'Compile a report on the Q3 product roadmap',
  ],
  platformNote: 'I also know the AgentEchelon platform that runs this - ask "how does AgentEchelon work?"',
};

describe('parseWelcomeOrientation', () => {
  it('parses a full orientation JSON', () => {
    const o = parseWelcomeOrientation(JSON.stringify(STRATUM));
    expect(o).toMatchObject({ companyName: 'Stratum Technologies' });
    expect(o?.examples).toHaveLength(3);
  });

  it('returns null for empty / whitespace / invalid JSON', () => {
    expect(parseWelcomeOrientation(undefined)).toBeNull();
    expect(parseWelcomeOrientation('')).toBeNull();
    expect(parseWelcomeOrientation('   ')).toBeNull();
    expect(parseWelcomeOrientation('{not json')).toBeNull();
    expect(parseWelcomeOrientation('"a string"')).toBeNull();
    expect(parseWelcomeOrientation('{}')).toBeNull(); // no orientation signal
  });

  it('caps examples at 4 and drops non-string / blank entries', () => {
    const o = parseWelcomeOrientation(JSON.stringify({
      companyName: 'X',
      examples: ['a', 'b', '', 3, 'c', 'd', 'e'],
    }));
    expect(o?.examples).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('composeWelcomeMessage', () => {
  it('falls back to the generic, name-less welcome when no orientation', () => {
    const msg = composeWelcomeMessage({});
    expect(msg).toBe("Hi - I'm your assistant for this conversation. I can answer questions, draft documents, analyse data, help with code, or work through a plan with you. What would you like to start with?");
  });

  it('is always name-less (name personalization moved to the first turn)', () => {
    // The welcome must never carry a user name: the WelcomeIntent races membership/metadata at
    // creation, so the assistant greets by name on the first real turn instead (see the processor).
    expect(composeWelcomeMessage({}).startsWith('Hi -')).toBe(true);
    expect(composeWelcomeMessage({ orientation: { companyName: 'Acme' } }).startsWith('Hi -')).toBe(true);
  });

  it('short-circuits on a drift triggerContext', () => {
    const msg = composeWelcomeMessage({ triggerContext: 'quarterly revenue forecasting', orientation: STRATUM });
    expect(msg).toContain('continuing from your earlier message');
    expect(msg).toContain('quarterly revenue forecasting');
  });

  it('short-circuits on a create-conversation topic', () => {
    const msg = composeWelcomeMessage({ topic: 'onboarding a new customer' });
    expect(msg).toContain('I can help with onboarding a new customer');
  });

  it('renders the oriented welcome: company + access + example bullets + platform note', () => {
    const msg = composeWelcomeMessage({ orientation: STRATUM });
    expect(msg).toContain("Hi - I'm your assistant at Stratum Technologies, an enterprise SaaS company");
    expect(msg).toContain('You have standard access');
    expect(msg).toContain('A few things you can try:');
    expect(msg).toContain('- Who leads the Platform Core team?');
    expect(msg).toContain('- Extract the engineering roster by location as a table');
    expect(msg).toContain('how does AgentEchelon work?');
  });

  it('renders a minimal orientation (company only, no access/examples)', () => {
    const msg = composeWelcomeMessage({ orientation: { companyName: 'Acme' } });
    expect(msg).toBe("Hi - I'm your assistant at Acme.");
  });
});
