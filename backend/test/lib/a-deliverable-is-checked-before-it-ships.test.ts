/**
 * THE LOOP WRITES, CHECKS, AND CORRECTS - so the checks are the thing that has to be right.
 *
 * Every fixture below is a document this deployment actually produced, or the shape of one, captured
 * from live runs on 2026-08-19/20. That matters more than usual here: these rules decide whether a
 * finished document is sent back to the model for a rewrite, so a rule that is too eager costs a model
 * call and risks making a good document worse, and a rule that is too shy leaves the defect that
 * started this - a report opening "Here's your report, Test - delivered as a downloadable markdown
 * document" while the prompt had forbidden exactly that.
 */
import {
  acceptCorrection,
  correctionInstruction,
  correctionProgressLine,
  deliverableIssues,
  documentStructure,
  documentWordCount,
  opensAsADocument,
  phraseShadowKinds,
  postInline,
  recordedLengthTarget,
  stillFailingPackaging,
  templateCheckOutcome,
} from '../../lambda/src/lib/deliverable-check';
import { parseTemplate } from '../../lambda/src/lib/document-template';

/** The extraction that shipped with a chat wrapper around real data (live, 2026-08-20). */
const WRAPPED_EXTRACTION = `Hi Test, I have everything I need from the churn-risk data already in context. Here's your downloadable table:

---

# Enterprise Accounts — Churn Risk

| Account | ARR | Risk Level | Reason |
|---------|-----|-----------|--------|
| Coastal Health Systems | $155K | High | Evaluating Zapier Enterprise + custom solution |
| Precision Analytics | $89K | High | Champion left; new VP Engineering is scoping an in-house build |

---

**Summary:**
- **Total at-risk ARR:** $462K across 4 accounts

The two high-risk accounts warrant the most immediate attention. Let me know if you'd like the mitigation owners and next actions added, or if you need this sliced differently.`;

/** A clean document of the same kind: the data, and nothing addressed to anyone. */
const CLEAN_EXTRACTION = `# Enterprise Accounts — Churn Risk

| Account | ARR | Risk Level | Reason |
|---------|-----|-----------|--------|
| Coastal Health Systems | $155K | High | Evaluating Zapier Enterprise + custom solution |
| Precision Analytics | $89K | High | Champion left; new VP Engineering is scoping an in-house build |

**Summary:** total at-risk ARR is $462K across 4 accounts. The two high-risk accounts warrant the most
immediate attention: Coastal Health is actively evaluating alternatives, and Precision Analytics lost
its internal champion.`;

describe('the agreed size is read as numbers, never parsed out of prose', () => {
  // The model resolves "1-2 pages" to a range when it RECORDS the requirement, so this reader only
  // validates. The regex parser that used to live here is gone: it put the runtime back to guessing at
  // English one layer below where the agreement had just been moved out of prose.
  it('reads a recorded range', () => {
    const t = recordedLengthTarget({ lengthTarget: { minWords: 600, maxWords: 900, source: '1-2 pages' } });
    expect(t).toEqual({ minWords: 600, maxWords: 900, source: '1-2 pages' });
  });

  it('falls back to naming the range when the model recorded no source phrase', () => {
    expect(recordedLengthTarget({ lengthTarget: { minWords: 600, maxWords: 900 } })?.source)
      .toBe('600-900 words');
  });

  // HALF AN AGREEMENT IS NOT AN AGREEMENT. A minimum alone admits a document ten times what was asked
  // for; a maximum alone admits an empty one. Each of these is treated as no agreement at all.
  it.each([
    ['no details at all', undefined],
    ['no lengthTarget', {}],
    ['a minimum only', { lengthTarget: { minWords: 600 } }],
    ['a maximum only', { lengthTarget: { maxWords: 900 } }],
    ['non-numeric bounds', { lengthTarget: { minWords: '600', maxWords: '900' } }],
    ['a reversed pair', { lengthTarget: { minWords: 900, maxWords: 600 } }],
    ['a zero minimum', { lengthTarget: { minWords: 0, maxWords: 900 } }],
  ])('treats %s as nothing to enforce', (_label: string, details: unknown) => {
    expect(recordedLengthTarget(details)).toBeNull();
  });
});

describe('the checks, against documents this deployment actually produced', () => {
  // WHAT DECIDES IS THE MARKUP (tenet D11). The document opens with a sentence to the person, which
  // its structure shows in any language; the greeting, the offer and the file claim are English
  // phrases, measured by the shadow and never acted on.
  it('catches the wrapper structurally, and measures the phrases without acting on them', () => {
    expect(deliverableIssues(WRAPPED_EXTRACTION, null).map((i) => i.kind)).toEqual(['chat_wrapper']);
    const shadow = phraseShadowKinds(WRAPPED_EXTRACTION);
    expect(shadow).toContain('chat_wrapper');
    expect(shadow).toContain('reader_ask');
    expect(shadow).toContain('claims_a_file');
  });

  it('acts on no phrase: a document that opens as a document is not sent back for one', () => {
    const doc = '# Findings\n\nThe two high-risk accounts warrant attention. Let me know if you would like more.';
    expect(deliverableIssues(doc, null)).toEqual([]);
    expect(phraseShadowKinds(doc)).toEqual(['reader_ask']);
  });

  it('passes the same data with the conversation stripped off it', () => {
    expect(deliverableIssues(CLEAN_EXTRACTION, null)).toEqual([]);
  });

  // The eagerness half. A rule that rewrites good documents gets switched off, so these must NOT fire.
  it('leaves a rhetorical question alone, because it asks the reader nothing', () => {
    const doc = '# Repositories\n\nWhich model scales better at five teams? The evidence favours neither '
      + 'outright, and the deciding factor is where coordination cost is paid.';
    expect(deliverableIssues(doc, null)).toEqual([]);
  });

  it('leaves prose that merely mentions the reader alone', () => {
    const doc = '# Findings\n\nIf you operate five teams, the coordination cost lands in the build system '
      + 'rather than in release negotiation, and that trade is the one worth measuring.';
    expect(deliverableIssues(doc, null)).toEqual([]);
  });

  it('does not read "high risk of churn" as a claim about a file', () => {
    expect(deliverableIssues(CLEAN_EXTRACTION, null)).toEqual([]);
  });
});

describe('length is enforced only against a recorded agreement', () => {
  const target = ({ minWords: 600, maxWords: 900, source: 'roughly 600-900 words' });

  it('flags a document a fraction of what was agreed', () => {
    const stub = `# Report\n\n${'word '.repeat(200)}`;
    const kinds = deliverableIssues(stub, target).map((i) => i.kind);
    expect(kinds).toContain('too_short');
  });

  it('flags one that ran well past it', () => {
    const bloated = `# Report\n\n${'word '.repeat(2000)}`;
    expect(deliverableIssues(bloated, target).map((i) => i.kind)).toContain('too_long');
  });

  it('accepts one inside the band', () => {
    const right = `# Report\n\n${'word '.repeat(700)}`;
    expect(deliverableIssues(right, target)).toEqual([]);
  });

  it('enforces nothing when no size was recorded, however short the document', () => {
    const stub = `# Report\n\n${'word '.repeat(50)}`;
    expect(deliverableIssues(stub, null)).toEqual([]);
  });

  it('counts words without table pipes or heading marks inflating the total', () => {
    expect(documentWordCount('# Title\n\n| a | b |\n|---|---|\n| one | two |\n\nSome real prose here.')).toBe(9);
  });
});

describe('the correction instruction asks for a document, not a conversation about one', () => {
  const issues = deliverableIssues(WRAPPED_EXTRACTION, ({ minWords: 600, maxWords: 900, source: '600-900 words' }));
  const instruction = correctionInstruction(issues, WRAPPED_EXTRACTION);

  it('names every issue it found', () => {
    // The length it was agreed at, and the structural opening, which asks for the conversation out.
    expect(issues.map((i) => i.kind)).toEqual(['too_short', 'chat_wrapper']);
    expect(instruction).toContain('The agreed length is');
    expect(instruction).toContain('opens with a sentence to the reader instead of the document');
    expect(instruction).toContain('any offer or question to the reader');
    expect(instruction).toContain('anything about files or downloads');
  });

  it('demands the corrected document alone', () => {
    expect(instruction).toMatch(/Return ONLY the corrected document/);
    expect(instruction).toMatch(/no explanation of what you changed/);
  });

  it('carries the document itself, so the rewrite keeps what was already right', () => {
    expect(instruction).toContain('Coastal Health Systems');
    expect(instruction).toContain('Keep everything that is already right');
  });
});

/**
 * ACCEPTANCE, and this is the half that shipped a defect before it had a test.
 *
 * The first rule was "fewer faults than before", and a live run defeated it in minutes: the corrective
 * call was itself refused by the guardrail, so the rewrite came back as the 60-character refusal copy.
 * That document has no greeting, no question and no file claim - zero faults - so it won on the count
 * and was delivered to the person as their extraction. Deleting a document is not a way of fixing it.
 */
describe('a rewrite is accepted only if it is better AND still the document', () => {
  const GOOD = `# Enterprise Accounts — Churn Risk\n\n${'account data '.repeat(60)}`;
  const issuesBefore = [
    { kind: 'reader_ask' as const, fix: 'x' },
    { kind: 'claims_a_file' as const, fix: 'y' },
  ];

  // THE LIVE CASE, verbatim: this is what the model returned when the corrective turn was blocked.
  const BLOCK_COPY = 'I cannot process that request. Please rephrase your message.';

  it('refuses the guardrail refusal, even though it has no faults at all', () => {
    expect(phraseShadowKinds(BLOCK_COPY)).toEqual([]);
    const v = acceptCorrection({
      original: GOOD, rewritten: BLOCK_COPY, issuesBefore, issuesAfter: [], target: null, blocked: true,
    });
    expect(v.accept).toBe(false);
    expect(v.reason).toContain('guardrail-blocked');
  });

  // The structural flag is the primary guard, but a refusal can arrive without one (a model that
  // simply declines in prose), so the content floor has to catch it independently.
  it('refuses it on content alone when nothing marked it blocked', () => {
    const v = acceptCorrection({
      original: GOOD, rewritten: BLOCK_COPY, issuesBefore, issuesAfter: [], target: null,
    });
    expect(v.accept).toBe(false);
    expect(v.reason).toContain('lost the document');
  });

  it('accepts a real correction that keeps the content', () => {
    const fixed = `# Enterprise Accounts — Churn Risk\n\n${'account data '.repeat(58)}`;
    const v = acceptCorrection({
      original: GOOD, rewritten: fixed, issuesBefore, issuesAfter: [], target: null,
    });
    expect(v.accept).toBe(true);
  });

  it('refuses a rewrite that fixed nothing', () => {
    const v = acceptCorrection({
      original: GOOD, rewritten: GOOD, issuesBefore, issuesAfter: issuesBefore, target: null,
    });
    expect(v.accept).toBe(false);
    expect(v.reason).toContain('fixed nothing');
  });

  it('refuses an empty rewrite', () => {
    const v = acceptCorrection({
      original: GOOD, rewritten: '   ', issuesBefore, issuesAfter: [], target: null,
    });
    expect(v.accept).toBe(false);
  });

  // SHRINKING IS THE CORRECTION when the document was too long, so the 60% floor would refuse the very
  // fix it asked for. There the floor becomes the length the person agreed to.
  it('allows a too-long document to shrink to the agreed minimum', () => {
    const target = ({ minWords: 600, maxWords: 900, source: 'roughly 600-900 words' });
    const long = `# Report\n\n${'word '.repeat(2000)}`;
    const trimmed = `# Report\n\n${'word '.repeat(700)}`;
    const v = acceptCorrection({
      original: long,
      rewritten: trimmed,
      issuesBefore: [{ kind: 'too_long', fix: 'shorten' }],
      issuesAfter: [],
      target,
    });
    expect(v.accept).toBe(true);
  });

  it('still refuses a too-long document shrunk below what was agreed', () => {
    const target = ({ minWords: 600, maxWords: 900, source: 'roughly 600-900 words' });
    const long = `# Report\n\n${'word '.repeat(2000)}`;
    const gutted = `# Report\n\n${'word '.repeat(80)}`;
    const v = acceptCorrection({
      original: long,
      rewritten: gutted,
      issuesBefore: [{ kind: 'too_long', fix: 'shorten' }],
      issuesAfter: [],
      target,
    });
    expect(v.accept).toBe(false);
  });
});

/**
 * WHAT THE PERSON SEES WHILE IT IS BEING FIXED.
 *
 * A correction pass costs a model call, and a placeholder that sits unchanged through one looks like a
 * stalled turn. The line also has to be honest about WHICH way the document is wrong: "trimming" when
 * it ran long and "expanding" when it came up short are different promises, and a person who asked for
 * two pages can tell which one they are owed.
 */
describe('the progress line names the work, not the machinery', () => {
  const target = ({ minWords: 300, maxWords: 1800, source: '1-2 pages' });

  it('says it is trimming when the document ran long', () => {
    const line = correctionProgressLine([{ kind: 'too_long', fix: 'x' }], target);
    expect(line).toMatch(/^Trimming the report to 1-2 pages/);
  });

  it('says it is expanding when it came up short', () => {
    const line = correctionProgressLine([{ kind: 'too_short', fix: 'x' }], target);
    expect(line).toMatch(/^Expanding the report to 1-2 pages/);
  });

  it('falls back to "the agreed length" when the size came from somewhere unquotable', () => {
    expect(correctionProgressLine([{ kind: 'too_short', fix: 'x' }], null))
      .toBe('Expanding the report to the agreed length...');
  });

  it('describes a purity fix without pretending it is about length', () => {
    const line = correctionProgressLine(
      [{ kind: 'chat_wrapper', fix: 'x' }, { kind: 'reader_ask', fix: 'y' }], target,
    );
    expect(line).toBe('Tidying the document before delivering it...');
  });

  // The round count is an implementation detail: a person reading "pass 2 of 3" learns nothing they
  // can act on, and it advertises a bound that is ours to change.
  it('never mentions passes or rounds', () => {
    for (const kind of ['too_long', 'too_short', 'chat_wrapper'] as const) {
      const line = correctionProgressLine([{ kind, fix: 'x' }], target);
      expect(line).not.toMatch(/pass|round|attempt|\b\d+ of \d+\b/i);
    }
  });
});

/**
 * THE PROGRESS LINE IS POSTED INTO THE CHANNEL, so what it interpolates is a sink.
 *
 * `source` is model-authored: it comes from `collected[].sizeLabel` on the tool call. The line built
 * from it is posted with `updateMessage`, and the chat client PARSES control markers out of bot
 * content - a `<!--ACTIVE_TASK:-->` marker renders a task chip, and a `NAVIGATE_CHANNEL:` marker on a
 * message UPDATE makes every watching client navigate with no user gesture. A write-side length bound
 * does not protect this: rows already exist that were written before it, and a hand edit or an
 * imported fixture is not bound by it at all. Stripped at BOTH the read and the render.
 */
describe('model-authored text cannot carry a control marker into a posted message', () => {
  const MARKERS = [
    ['an active-task marker', '<!--ACTIVE_TASK:{"type":"a","status":"paid"}-->'],
    ['a correlation marker', '<!--corr:fulfil-abc123-->'],
    ['a navigation marker', 'NAVIGATE_CHANNEL:arn:aws:chime:us-east-1:1:app-instance/x/channel/y|Go here'],
  ] as const;

  it.each(MARKERS)('%s is stripped when the target is read back', (_label: string, marker: string) => {
    const t = recordedLengthTarget({ lengthTarget: { minWords: 600, maxWords: 900, source: `2 pages ${marker}` } });
    expect(t!.source).not.toContain('ACTIVE_TASK');
    expect(t!.source).not.toContain('corr:');
    expect(t!.source).not.toContain('NAVIGATE_CHANNEL');
  });

  it.each(MARKERS)('%s is stripped again when the line is built', (_label: string, marker: string) => {
    // A caller may hand over a target it built itself, so the render does not rely on the read.
    const line = correctionProgressLine(
      [{ kind: 'too_long', fix: 'x' }],
      { minWords: 600, maxWords: 900, source: `2 pages ${marker}` },
    );
    expect(line).not.toContain('ACTIVE_TASK');
    expect(line).not.toContain('corr:');
    expect(line).not.toContain('NAVIGATE_CHANNEL');
    expect(line).toMatch(/^Trimming the report to 2 pages/);
  });

  it('falls back to the numbers when the label was NOTHING BUT a marker', () => {
    const t = recordedLengthTarget({
      lengthTarget: { minWords: 600, maxWords: 900, source: '<!--ACTIVE_TASK:{"x":1}-->' },
    });
    expect(t!.source).toBe('600-900 words');
  });

  // The read applies the bound too, because the row may predate the write-side one.
  it('bounds a long label read back from a row written before the cap existed', () => {
    const t = recordedLengthTarget({
      lengthTarget: { minWords: 600, maxWords: 900, source: 'x'.repeat(500) },
    });
    expect(t!.source.length).toBeLessThanOrEqual(60);
  });
});

/**
 * THE INCIDENT THAT MOVED THE CORRECTION OFF A WORD COUNT (premium extraction, live).
 *
 * The document shipped as greeting + narration + table + "I can't generate a downloadable file". The
 * check flagged it, the model's correction was right - the table under a title, the conversation gone -
 * and it was REJECTED, because taking out the conversation took out half the words and the floor was
 * 60% of them. The wrapped original shipped. For purity faults the question is whether the document's
 * structure survived, and here every table row did.
 */
describe('a correction that only removes conversation is judged by the structure it kept', () => {
  const INCIDENT = [
    'Hi Ryan, I have everything I need to pull this together. I searched the account records that were '
      + 'available in context and filtered them to enterprise customers whose health score marks them as a '
      + 'churn risk this quarter, then sorted them by annual recurring revenue so the largest exposure is at '
      + 'the top.',
    '',
    '| Account | ARR | Risk | Signal |',
    '|---------|-----|------|--------|',
    '| Coastal Health Systems | $155K | High | Evaluating a competitor |',
    '| Precision Analytics | $89K | High | Champion left the company |',
    '| Northwind Logistics | $132K | Medium | Usage down 40% in 90 days |',
    '| Brightline Retail | $86K | Medium | Renewal contact unresponsive |',
    '',
    "I can't generate a downloadable file directly from here, but you can copy this table into a "
      + 'spreadsheet and it will keep its columns. Let me know if you would like me to add owners, next '
      + 'actions or renewal dates to each account, or if you would like the list sliced differently by '
      + 'region or by product line.',
  ].join('\n');

  const CORRECTED = [
    '# Enterprise Accounts at Churn Risk',
    '',
    '| Account | ARR | Risk | Signal |',
    '|---------|-----|------|--------|',
    '| Coastal Health Systems | $155K | High | Evaluating a competitor |',
    '| Precision Analytics | $89K | High | Champion left the company |',
    '| Northwind Logistics | $132K | Medium | Usage down 40% in 90 days |',
    '| Brightline Retail | $86K | Medium | Renewal contact unresponsive |',
  ].join('\n');

  it('is the incident: the correction took out about half the words', () => {
    const before = documentWordCount(INCIDENT);
    const after = documentWordCount(CORRECTED);
    expect(before).toBeGreaterThanOrEqual(140);
    expect(after).toBeLessThan(before * 0.6); // the old floor would have refused it
  });

  it('accepts the wrapper-only correction because every table row survived', () => {
    const issuesBefore = deliverableIssues(INCIDENT, null);
    expect(issuesBefore.map((i) => i.kind)).toEqual(['chat_wrapper']);
    const issuesAfter = deliverableIssues(CORRECTED, null);
    expect(issuesAfter).toEqual([]);

    const v = acceptCorrection({ original: INCIDENT, rewritten: CORRECTED, issuesBefore, issuesAfter, target: null });
    expect(v.accept).toBe(true);
    expect(v.reason).toContain('structure kept');
  });

  it('refuses a purity correction that lost table rows', () => {
    const lostRows = CORRECTED.split('\n').slice(0, 6).join('\n');
    expect(documentStructure(lostRows).tableRows).toBeLessThan(documentStructure(INCIDENT).tableRows);
    const v = acceptCorrection({
      original: INCIDENT,
      rewritten: lostRows,
      issuesBefore: deliverableIssues(INCIDENT, null),
      issuesAfter: deliverableIssues(lostRows, null),
      target: null,
    });
    expect(v.accept).toBe(false);
    expect(v.reason).toContain('tableRows 5 -> 3');
  });

  it('keeps the word floor for a length fault, where words are what was agreed', () => {
    const v = acceptCorrection({
      original: INCIDENT,
      rewritten: CORRECTED,
      issuesBefore: [{ kind: 'too_short', fix: 'x' }, { kind: 'chat_wrapper', fix: 'y' }],
      issuesAfter: [{ kind: 'too_short', fix: 'x' }],
      target: { minWords: 600, maxWords: 900, source: '1-2 pages' },
    });
    expect(v.accept).toBe(false);
    expect(v.reason).toContain('60% of the original');
  });
});

/**
 * WHAT COUNTS AS OPENING AS A DOCUMENT, read from markup. It must never fail a correct deliverable:
 * a code file is code wherever it starts, and an extraction may be CSV-shaped.
 */
describe('a document opens as a document, in markup any language shares', () => {
  it.each([
    ['a heading', '# Churn risk\n\nThe accounts.'],
    ['a table row', '| Account | ARR |\n|---|---|\n| Coastal | $155K |'],
    ['a fenced code block', '```ts\nexport const x = 1;\n```'],
    ['a bold title line', '**Churn risk accounts**\n\nThe accounts.'],
    ['a setext heading', 'Churn risk accounts\n===================\n\nThe accounts.'],
    ['a CSV header and rows', 'account,arr,risk\nCoastal Health,155000,high\nPrecision Analytics,89000,high'],
    ['a tab-separated extraction', 'account\tarr\nCoastal\t155000\nPrecision\t89000'],
    ['JSON', '{\n  "accounts": []\n}'],
  ])('accepts %s', (_label: string, doc: string) => {
    expect(opensAsADocument(doc)).toBe(true);
    expect(deliverableIssues(doc, null)).toEqual([]);
  });

  it.each([
    ['a greeting', 'Hi Ryan, here is what I found.\n\n| a |\n|---|\n| 1 |'],
    ['a sentence with one comma above another', 'Sure, I pulled the records.\nThey are below, sorted by ARR.\n\n| a |'],
    ['a narration', 'I searched the account records and found four.'],
  ])('flags %s', (_label: string, doc: string) => {
    expect(opensAsADocument(doc)).toBe(false);
    expect(deliverableIssues(doc, null).map((i) => i.kind)).toEqual(['chat_wrapper']);
  });

  it('never fails a code deliverable, wherever its code starts', () => {
    const rawCode = 'import fs from "fs";\n\nexport function read(p: string) {\n  return fs.readFileSync(p, "utf8");\n}';
    expect(deliverableIssues(rawCode, null, { code: true })).toEqual([]);
    const fenced = '```python\nprint("hi")\n```';
    expect(deliverableIssues(fenced, null)).toEqual([]);
  });
});

/**
 * A DECLARED DOCUMENT THAT STILL FAILS AFTER CORRECTION POSTS INLINE, NOT ATTACHED. The decision is one
 * pure function the delivery gate reads (`stillFailingPackaging`), so it is exercised here on real
 * documents, the template case included (SPEC-DOCUMENT-TEMPLATES FR6); the source pins only that the gate
 * reads it and withholds the file on its answer.
 */
describe('a declared document still failing after correction posts inline', () => {
  const proc = require('fs').readFileSync(
    require('path').join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8',
  ) as string;

  const TEMPLATE = parseTemplate([
    '---',
    JSON.stringify({ name: 'account-review', description: 'A review.' }),
    '---',
    '# Account review',
    '## Summary',
    '## Risks',
    '| Risk | Owner |',
    '|---|---|',
  ].join('\n'));
  // A real document with a heading, a summary and no risks table: it opens as a document and misses
  // the template's second section.
  const MISSING_A_SECTION = '# Coastal Health review\n\n## Summary\n\nRenewal is on track for Q1, with expansion into two new sites.';

  it('withholds the file for a document that still does not follow its template, and posts it after the reply', () => {
    const issues = deliverableIssues(MISSING_A_SECTION, null, { template: TEMPLATE });
    expect(issues.map((i) => i.kind)).toEqual(['template_structure']);
    expect(stillFailingPackaging(issues, true)).toBe('template_structure');
    expect(templateCheckOutcome({ filled: false, attached: false, corrected: false })).toBe('posted_inline');
    expect(postInline('Here is where it stands.', MISSING_A_SECTION)).toBe(`Here is where it stands.\n\n${MISSING_A_SECTION}`);
    expect(postInline('  ', MISSING_A_SECTION)).toBe(MISSING_A_SECTION);
  });

  it('withholds the file for a remaining purity fault on a declared document', () => {
    expect(stillFailingPackaging([{ kind: 'chat_wrapper', fix: '' } as never], true)).toBe('purity');
  });

  it('attaches the best version when only the agreed length is off, and withholds nothing where the reply is the file', () => {
    expect(stillFailingPackaging([{ kind: 'too_long', fix: '' } as never], true)).toBe('mismatch');
    expect(stillFailingPackaging([{ kind: 'template_structure', fix: '' } as never], false)).toBe('mismatch');
    expect(stillFailingPackaging([], true)).toBeNull();
  });

  it('records the outcome a template check came to', () => {
    expect(templateCheckOutcome({ filled: true, attached: true, corrected: false })).toBe('filled_by_platform');
    expect(templateCheckOutcome({ filled: false, attached: true, corrected: true })).toBe('passed_after_correction');
    expect(templateCheckOutcome({ filled: false, attached: true, corrected: false })).toBe('passed');
  });

  it('is the decision the gate reads, and the gate withholds the file on it', () => {
    const at = proc.indexOf('const stillFailing = stillFailingPackaging(issues, replyBesideFile);');
    expect(at).toBeGreaterThan(-1);
    const branch = proc.slice(at, at + 2500);
    expect(branch).toMatch(/stillFailing === 'template_structure'[\s\S]*?generate = false;/);
    expect(branch).toMatch(/stillFailing === 'purity'[\s\S]*?generate = false;/);
    expect(proc).toContain('if (!generate && replyBesideFile && documentText) {');
    expect(proc).toContain('response = postInline(response, documentText);');
  });

  it('logs the English phrase checks as a shadow and decides nothing from them', () => {
    expect(proc).toContain("'[AssistantAsyncProcessor][shadow] deliverable_phrase_check'");
    expect(proc).not.toMatch(/if \([^)]*phraseShadowKinds/);
  });
});
