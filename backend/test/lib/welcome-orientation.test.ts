/**
 * welcome-orientation - config-driven WelcomeIntent copy. The platform ships a generic welcome;
 * a deployment supplies company/access/examples via SSM with no code change. These lock both the
 * generic fallback (unchanged historical greeting) and the enriched, oriented welcome.
 *
 * The `partial orientation` block below is the important one. A single absent field must omit ONE
 * PIECE OF COPY and nothing else: it must not fall back to the generic greeting, and it must not
 * discard the fields that ARE configured. It must also be REPORTED, because degraded copy is the only
 * symptom this misconfiguration has - the welcome still lands, nothing throws, and no user complains.
 */
import {
  parseWelcomeOrientation,
  parseWelcomeOrientationDetailed,
  composeWelcome,
  composeWelcomeMessage,
  DEPLOYMENT_FIELDS,
  CONVERSATION_FIELDS,
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

const GENERIC =
  "Hi - I'm your assistant for this conversation. I can answer questions, draft documents, analyse "
  + 'data, help with code, or work through a plan with you. What would you like to start with?';

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
    expect(parseWelcomeOrientation('[1,2]')).toBeNull();
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

describe('parseWelcomeOrientationDetailed - what was rejected, and why', () => {
  it('reports NOTHING for an absent parameter (an un-configured deployment is not a defect)', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const r = parseWelcomeOrientationDetailed(raw);
      expect(r.orientation).toBeNull();
      expect(r.issues).toEqual([]);
    }
  });

  it('reports a clean parse as having no issues', () => {
    expect(parseWelcomeOrientationDetailed(JSON.stringify(STRATUM)).issues).toEqual([]);
  });

  it('reports malformed JSON and non-object values distinctly', () => {
    expect(parseWelcomeOrientationDetailed('{not json').issues).toEqual([
      'the parameter value is not valid JSON',
    ]);
    expect(parseWelcomeOrientationDetailed('"a string"').issues).toEqual([
      'the parameter value is not a JSON object',
    ]);
    expect(parseWelcomeOrientationDetailed('[]').issues).toEqual([
      'the parameter value is not a JSON object',
    ]);
  });

  it('reports a wrong-typed field, keeps the rest, and names the field', () => {
    const r = parseWelcomeOrientationDetailed(JSON.stringify({ companyName: 42, accessBlurb: 'ok' }));
    expect(r.orientation).toEqual({ accessBlurb: 'ok' });
    expect(r.issues).toEqual(['companyName is number, not a string - ignored']);
  });

  it('reports a blank field rather than treating it as absent', () => {
    const r = parseWelcomeOrientationDetailed(JSON.stringify({ companyName: 'Acme', platformNote: '   ' }));
    expect(r.orientation).toEqual({ companyName: 'Acme' });
    expect(r.issues).toEqual(['platformNote is blank - ignored']);
  });

  it('reports dropped and truncated examples', () => {
    const r = parseWelcomeOrientationDetailed(JSON.stringify({
      companyName: 'X',
      examples: ['a', '', 7, 'b', 'c', 'd', 'e'],
    }));
    expect(r.orientation?.examples).toEqual(['a', 'b', 'c', 'd']);
    expect(r.issues).toEqual([
      '2 of 7 examples were blank or not strings - dropped',
      '5 examples supplied, only the first 4 are rendered',
    ]);
  });

  it('reports examples that are not an array at all', () => {
    const r = parseWelcomeOrientationDetailed(JSON.stringify({ companyName: 'X', examples: 'a, b' }));
    expect(r.orientation).toEqual({ companyName: 'X' });
    expect(r.issues).toEqual(['examples is string, not an array of strings - ignored']);
  });

  it('reports a parameter that parsed but carried no usable field', () => {
    const r = parseWelcomeOrientationDetailed(JSON.stringify({ companyName: '', unrelated: 1 }));
    expect(r.orientation).toBeNull();
    expect(r.issues).toContain('the parameter carried no usable orientation field');
  });
});

describe('composeWelcomeMessage', () => {
  it('falls back to the generic, name-less welcome when no orientation', () => {
    expect(composeWelcomeMessage()).toBe(GENERIC);
  });

  it('is always name-less (name personalization moved to the first turn)', () => {
    // The welcome must never carry a user name: the WelcomeIntent races membership/metadata at
    // creation, so the assistant greets by name on the first real turn instead (see the processor).
    expect(composeWelcomeMessage().startsWith('Hi -')).toBe(true);
    expect(composeWelcomeMessage({ companyName: 'Acme' }).startsWith('Hi -')).toBe(true);
  });

  it('renders a drift carry-over', () => {
    const msg = composeWelcomeMessage({ priorSubject: 'quarterly revenue forecasting' });
    expect(msg).toContain('picks up quarterly revenue forecasting');
  });

  it('a SPAWNED conversation does not re-introduce the assistant', () => {
    // The person was already mid-conversation with this same assistant and accepted an offer to
    // continue one thought. They were just told who it is and where they are. Leading with the
    // introduction again pushes the only line that matters - what THIS thread is for - down the
    // message, and reads as though the assistant forgot the conversation they were both just having.
    const msg = composeWelcomeMessage({ ...STRATUM, priorSubject: 'quarterly revenue forecasting' });
    expect(msg).not.toContain("I'm your assistant at");
    expect(msg).not.toContain('Stratum Technologies');
    // It opens DIRECTLY on the continuity, with no leading blank line.
    expect(msg.startsWith('This conversation picks up quarterly revenue forecasting')).toBe(true);
  });

  it('a spawned conversation with only a quoted message also skips the introduction', () => {
    // `priorMessage` alone is spawn evidence too — the drift path sets either or both.
    const msg = composeWelcomeMessage({ ...STRATUM, priorMessage: 'what is our Q3 pipeline coverage?' });
    expect(msg).not.toContain("I'm your assistant at");
    expect(msg.startsWith('You asked:')).toBe(true);
  });

  it('a FRESH conversation still leads with the introduction', () => {
    // The suppression must be keyed on spawn evidence only. A fresh conversation - with or without a
    // topic - is someone arriving cold, and still needs to be told who is talking to them.
    expect(composeWelcomeMessage(STRATUM)).toContain("Hi - I'm your assistant at Stratum Technologies");
    expect(composeWelcomeMessage({ ...STRATUM, topic: 'onboarding' }))
      .toContain("Hi - I'm your assistant at Stratum Technologies");
  });

  it('renders a create-conversation topic', () => {
    const msg = composeWelcomeMessage({ topic: 'onboarding a new customer' });
    expect(msg).toContain('I can help with onboarding a new customer');
  });

  it('renders the oriented welcome: company + access + example bullets + platform note', () => {
    const msg = composeWelcomeMessage(STRATUM);
    expect(msg).toContain("Hi - I'm your assistant at Stratum Technologies, an enterprise SaaS company");
    expect(msg).toContain('You have standard access');
    expect(msg).toContain('A few things you can try:');
    expect(msg).toContain('- Who leads the Platform Core team?');
    expect(msg).toContain('- Extract the engineering roster by location as a table');
    expect(msg).toContain('how does AgentEchelon work?');
  });

  it('renders a minimal orientation (company only, no access/examples)', () => {
    const msg = composeWelcomeMessage({ companyName: 'Acme' });
    expect(msg).toBe("Hi - I'm your assistant at Acme.");
  });
});

describe('composeWelcome - a partial orientation omits one piece of copy, never the rest', () => {
  it('does NOT fall back to the generic welcome when only an access line and a note are configured', () => {
    // THE REGRESSION THIS BLOCK EXISTS FOR. The old gate required companyName, companyBlurb or
    // examples, so this exact orientation returned the generic greeting and threw BOTH configured
    // fields away. The deployment's configuration simply did not appear, and nothing reported it.
    const r = composeWelcome({
      accessBlurb: 'You have leadership access.',
      platformNote: 'Ask how this works.',
    });
    expect(r.variant).toBe('oriented');
    expect(r.usedGenericFallback).toBe(false);
    expect(r.content).not.toBe(GENERIC);
    expect(r.content).toContain('You have leadership access.');
    expect(r.content).toContain('Ask how this works.');
  });

  it('renders examples alone', () => {
    const r = composeWelcome({ examples: ['Try this', 'Or this'] });
    expect(r.variant).toBe('oriented');
    expect(r.content).toContain('A few things you can try:');
    expect(r.content).toContain('- Try this');
    expect(r.content).toContain('- Or this');
  });

  it('drops the "at <company>" clause entirely when no company is named, rather than inventing one', () => {
    // Filling the gap with a placeholder ("your organization") would put words in the deployment's
    // mouth. Omitting the clause is what "leave the missing variable out" means.
    const r = composeWelcome({ accessBlurb: 'You have basic access.' });
    // Assert the configured field SURVIVED first. Without this the rest of the test passes against the
    // generic greeting, which also has no "at <company>" clause and no placeholder - i.e. it would go
    // green under exactly the all-or-nothing fallback it is supposed to forbid.
    expect(r.variant).toBe('oriented');
    expect(r.content).toContain('You have basic access.');
    expect(r.content).toContain("Hi - I'm your assistant for this conversation.");
    expect(r.content).not.toContain('your organization');
    expect(r.content).not.toContain(' at ');
  });

  it('keeps a company blurb that has no company name, on its own line', () => {
    const r = composeWelcome({ companyBlurb: 'a mid-size logistics firm' });
    expect(r.content).toContain("You're working with a mid-size logistics firm.");
    expect(r.usedGenericFallback).toBe(false);
  });

  it('names every field it had to omit, so the caller can record it', () => {
    const r = composeWelcome({ companyName: 'Acme' });
    expect(r.missingFields.sort()).toEqual(
      ['companyBlurb', 'accessBlurb', 'examples', 'platformNote'].sort(),
    );
  });

  it('reports no missing fields for a complete orientation', () => {
    const r = composeWelcome(STRATUM);
    expect(r.missingFields).toEqual([]);
    expect(r.usedGenericFallback).toBe(false);
  });

  it('every single-field orientation renders that field and reports the other four', () => {
    // Exhaustive over the field set, so a newly added field cannot quietly skip both behaviours.
    for (const field of DEPLOYMENT_FIELDS) {
      const orientation = field === 'examples'
        ? { examples: ['only this'] }
        : ({ [field]: `only-${field}` } as Record<string, string>);
      const r = composeWelcome(orientation);
      expect(r.variant).toBe('oriented');
      expect(r.usedGenericFallback).toBe(false);
      expect(r.content).not.toBe(GENERIC);
      expect(r.missingFields).toHaveLength(DEPLOYMENT_FIELDS.length - 1);
      expect(r.missingFields).not.toContain(field);
    }
  });

  it('marks the generic variant as a fallback with nothing missing to report', () => {
    const r = composeWelcome();
    expect(r.variant).toBe('generic');
    expect(r.usedGenericFallback).toBe(true);
    // Nothing was configured, so nothing was OMITTED - the caller decides whether an un-configured
    // deployment is a defect, using whether it expected a parameter at all.
    expect(r.missingFields).toEqual([]);
  });
});

describe('composeWelcome - orientation is assembled, so no source discards another', () => {
  // The short-circuit this block exists for. `triggerContext` and then `topic` used to RETURN EARLY, so
  // a conversation that knew why it existed forgot which company it was in - the same defect as the
  // all-or-nothing field gate, one level up. Both must now appear in one welcome.
  it('a topic does NOT discard the deployment orientation', () => {
    const r = composeWelcome({ ...STRATUM, topic: 'onboarding a new customer' });
    expect(r.content).toContain('I can help with onboarding a new customer');
    expect(r.content).toContain('Stratum Technologies');
    expect(r.content).toContain('You have standard access');
    expect(r.content).toContain('A few things you can try:');
    expect(r.content).toContain('how does AgentEchelon work?');
  });

  // REVERSED DELIBERATELY. This used to assert that a drift carry-over KEPT the full deployment
  // orientation ("no source discards another"). In use that read as padding: the person arrived by
  // accepting an offer to split ONE thought out of a conversation they were already in, so the access
  // line, the example prompts and the platform note are all things they had just read. They buried the
  // only sentence that matters - what this new thread is for.
  //
  // The assembly principle still holds for a FRESH conversation, which is what it was written for.
  //
  // REVERSED AGAIN 2026-08-06, and this line is the whole change: the greeting no longer keeps the
  // company line either. The first reversal dropped sections 3-5 but kept the identity lead, on the
  // reasoning that "identity still renders". Seen live on `conv-drift-1786065899491-…`, that lead is
  // the same padding for the same reason - the person is mid-conversation with THIS assistant, was
  // told who it is in the thread they came from, and arrived by accepting an offer to continue one
  // thought. A spawned conversation opens on its CONTINUITY, not on an introduction.
  it('a spawned conversation keeps its reason for existing and DROPS the repeated orientation', () => {
    const r = composeWelcome({ ...STRATUM, priorSubject: 'the Q2 ARR review' });
    expect(r.content).toContain('picks up the Q2 ARR review');
    // The introduction is gone, not merely moved: neither the greeting nor the company survives.
    expect(r.content).not.toContain('Stratum Technologies');
    expect(r.content).not.toContain("I'm your assistant at");
    expect(r.contributed).not.toContain('companyName');
    expect(r.content).not.toContain('A few things you can try:');
    expect(r.contributed).not.toContain('examples');
    expect(r.contributed).not.toContain('accessBlurb');
  });

  it('a FRESH conversation still gets the whole orientation', () => {
    // The counterpart to the test above: nothing about the assembly changed for the case it was
    // written for. Without spawn evidence, every configured source still contributes.
    const r = composeWelcome({ ...STRATUM, topic: 'shipping a release' });
    expect(r.content).toContain('A few things you can try:');
    expect(r.contributed).toContain('accessBlurb');
    expect(r.contributed).toContain('examples');
  });

  // The quote is the person's own words. Repeating them when the topic label already IS those words
  // (the label is derived from the message) is what made the live copy read as padding.
  it('does not quote the message back when the topic label already says it', () => {
    const r = composeWelcome({
      priorSubject: 'How many tigers live in India',
      priorMessage: 'How many tigers live in India?',
    });
    expect(r.content).toContain('picks up How many tigers live in India');
    expect(r.content).not.toContain('You asked:');
    expect(r.contributed).not.toContain('priorMessage');
  });

  it('DOES quote the message when it carries more than the label', () => {
    const r = composeWelcome({
      priorSubject: 'the Q2 ARR review',
      priorMessage: 'Can you pull the Q2 ARR review and flag anything below plan for the board?',
    });
    expect(r.content).toContain('You asked:');
    expect(r.contributed).toContain('priorMessage');
  });

  it('renders the parent link alongside the carry-over', () => {
    const r = composeWelcome({ priorSubject: 'the Q2 ARR review', parentRef: '?conversation=abc' });
    expect(r.content).toContain('[the conversation it came from](?conversation=abc)');
    expect(r.contributed).toContain('parentRef');
  });

  it('prefers the prior subject over the topic for the one "why you are here" sentence', () => {
    // Precedence WITHIN the reason-for-existing group, to avoid two redundant sentences.
    //
    // The access line is no longer asserted here: `priorSubject` makes this a SPAWNED conversation, and
    // a spawned welcome drops the orientation the person already read (see the spawned/fresh pair
    // above). The precedence claim this test exists for is unaffected.
    const r = composeWelcome({ ...STRATUM, topic: 'a topic', priorSubject: 'a prior subject' });
    expect(r.content).toContain('picks up a prior subject');
    expect(r.content).not.toContain('I can help with a topic');
    expect(r.contributed).toContain('priorSubject');
    expect(r.contributed).not.toContain('topic');
  });

  it('a conversation field alone orients without reporting missing deployment fields', () => {
    // A deployment that configured nothing has omitted nothing. Reporting all five here would make
    // every un-configured deployment's welcome look misconfigured.
    const r = composeWelcome({ topic: 'shipping a release' });
    expect(r.variant).toBe('oriented');
    expect(r.content).not.toBe(GENERIC);
    expect(r.missingFields).toEqual([]);
  });

  it('a partial deployment orientation still reports its own gaps when a topic is present', () => {
    const r = composeWelcome({ companyName: 'Acme', topic: 'shipping a release' });
    expect(r.missingFields.sort()).toEqual(
      ['accessBlurb', 'companyBlurb', 'examples', 'platformNote'].sort(),
    );
  });
});

describe('composeWelcome - member-controlled text is sanitised', () => {
  // `topic`, `priorSubject` and `parentRef` come from Chime channel Metadata, which is MEMBER-WRITABLE
  // (a participant holds UpdateChannel, which sets Name and Metadata in one call). So they are
  // attacker-controlled, and marker stripping is an injection defence rather than formatting - the more
  // so once a template is model-filled and this text becomes part of a prompt.
  it('strips control markers from a member-supplied topic', () => {
    const r = composeWelcome({ topic: 'billing <!--ACTIVE_TASK:abc--> questions' });
    expect(r.content).not.toContain('ACTIVE_TASK');
    expect(r.content).toContain('billing');
  });

  it('strips control markers from a member-supplied prior subject', () => {
    const r = composeWelcome({ priorSubject: 'the review <!--corr:123-->' });
    expect(r.content).not.toContain('<!--corr:');
    expect(r.content).toContain('the review');
  });

  it('treats a marker-only value as absent rather than rendering an empty clause', () => {
    const r = composeWelcome({ topic: '<!--corr:123-->' });
    expect(r.variant).toBe('generic');
    expect(r.contributed).toEqual([]);
  });

  it('caps member-supplied text so it cannot crowd out the rest of the welcome', () => {
    const r = composeWelcome({ ...STRATUM, topic: 'x'.repeat(5_000) });
    expect(r.content).toContain('A few things you can try:');
    expect(r.content.length).toBeLessThan(2_000);
  });
});

describe('the deployment parameter cannot set per-conversation fields', () => {
  // A deployment-wide parameter setting `topic` would apply ONE conversation's reason-for-existing to
  // every conversation on that classification. Reported rather than silently dropped, so an operator who
  // tries it finds out why the value never appears.
  it.each(CONVERSATION_FIELDS)('ignores and reports %s from the SSM parameter', (field) => {
    const r = parseWelcomeOrientationDetailed(JSON.stringify({ companyName: 'Acme', [field]: 'nope' }));
    expect(r.orientation).toEqual({ companyName: 'Acme' });
    expect(r.issues).toContain(
      `${field} is carried per conversation and cannot be set from the deployment parameter - ignored`,
    );
    expect((r.orientation as Record<string, unknown>)[field]).toBeUndefined();
  });
});

describe('composeWelcome - the parent reference is a URL, not prose', () => {
  // A FULL-LENGTH reference: a URI-encoded channel ARN plus a 64-char message id. ~230 chars, which is
  // over the 200-char topic cap that used to be applied to it. Placeholder account and app-instance
  // ids (the repo convention, 123456789012) - only the LENGTH matters here, and a tracked file has no
  // business carrying a real account id.
  const REAL_ARN = 'arn:aws:chime:us-east-1:123456789012:app-instance/a1b2c3d4-5e6f-7081-9234-5a6b7c8d9e01/channel/conv-1785790437782-b072703dc73f';
  const MSG_ID = '83ce694ede54992c669c9eb5f7afe38b44ecc777ec0fbb001710277eff3fb8a8';
  const REAL_REF = `?conversation=${encodeURIComponent(REAL_ARN)}#message=${MSG_ID}`;

  it('keeps a full-length reference INTACT, message id and all', () => {
    // THE REGRESSION. Reusing the topic cap sliced this mid-fragment, emitting `#message=83ce694…b44e` -
    // a well-formed link to a message id that does not exist. An anchor that looks live and lands nowhere is
    // worse than no anchor, because nothing about it reads as broken.
    const r = composeWelcome({ priorSubject: 'quarterly revenue forecasting', parentRef: REAL_REF });
    expect(r.content).toContain(`#message=${MSG_ID}`);
    expect(r.content).toContain(REAL_REF);
    expect(r.contributed).toContain('parentRef');
  });

  it('DROPS an over-long reference rather than truncating it', () => {
    // Half a URL is not a shorter URL. Dropping degrades to a conversation-level mention with no link;
    // truncating produces a link that silently goes to the wrong place.
    const tooLong = `?conversation=${'x'.repeat(600)}#message=${MSG_ID}`;
    const r = composeWelcome({ priorSubject: 'a subject', parentRef: tooLong });
    expect(r.content).not.toContain('#message=');
    expect(r.content).not.toContain('xxxxx');
    expect(r.contributed).not.toContain('parentRef');
    // The reason-for-existing sentence still renders; only the link is gone.
    expect(r.content).toContain('picks up a subject');
  });

  it('still marker-strips the reference', async () => {
    const r = composeWelcome({ priorSubject: 's', parentRef: `?conversation=abc<!--corr:1-->` });
    expect(r.content).not.toContain('<!--corr:');
    expect(r.content).toContain('?conversation=abc');
  });
});
