/**
 * THE E2E'S DOCUMENT RULES CATCH THE DOCUMENT THAT ACTUALLY SHIPPED.
 *
 * A delivered attachment used to be validated as "a real document" by shape alone: a file extension, a
 * few hundred characters, markdown structure, an on-topic word, and a short list of literal chat
 * phrasings. Every one of those is satisfied by an OUTLINE - and an outline is what was delivered as
 * the report in the incident that demoted the output-shape heuristic. It had a heading, a table, 500+
 * characters and the topic words, and it ended by asking the reader to approve it. The e2e called it a
 * valid report.
 *
 * `deliver-on-generation.test.ts` already keeps that live reply verbatim as `OUTLINE_FOR_APPROVAL`,
 * for the neighbouring point that the runtime heuristic cannot tell it apart. This file uses the same
 * fixture for the other half: the E2E's rules must reject it.
 *
 * WHY THE RULES ARE READ OUT OF THE E2E'S SOURCE. They live in `tests/e2e/helpers/task-validation.ts`
 * because Playwright runs them, and a jest suite cannot import that tree. Re-typing them here would
 * pin a copy while the shipped rule drifted - the exact failure the attribution and guardrail-mask
 * parity tests exist to prevent. So the regexes are extracted from the file the e2e actually runs.
 *
 * BOTH DIRECTIONS ARE PINNED. A rule that rejects everything is as useless as one that rejects
 * nothing: an assertion that fires on ordinary report prose gets switched off the first time it blocks
 * a good run. So a realistic finished report must pass all the same rules.
 */
import * as fs from 'fs';
import * as path from 'path';

const HELPER_PATH = path.join(__dirname, '../../tests/e2e/helpers/task-validation.ts');
const FIXTURE_PATH = path.join(__dirname, 'deliver-on-generation.test.ts');

/** Pull a named regex literal out of the e2e helper's source. */
function ruleFromHelper(name: string): RegExp {
  const src = fs.readFileSync(HELPER_PATH, 'utf8');
  const m = new RegExp(`const ${name} =\\s*(/[\\s\\S]*?/[gimsuy]*);`).exec(src);
  if (!m) throw new Error(`${name} not found in tests/e2e/helpers/task-validation.ts`);
  const body = m[1];
  const lastSlash = body.lastIndexOf('/');
  return new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1));
}

/** The live reply that shipped as a report, read from the file that already keeps it verbatim. */
function outlineForApproval(): string {
  const src = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const m = /const OUTLINE_FOR_APPROVAL = `([\s\S]*?)`;/.exec(src);
  if (!m) throw new Error('OUTLINE_FOR_APPROVAL not found in deliver-on-generation.test.ts');
  return m[1];
}

/** Substantial prose paragraphs, computed exactly as `tasks.spec.ts` computes them. */
function proseParagraphs(doc: string): string[] {
  return doc
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => !/^#{1,6}\s/.test(p))
    .filter((p) => !/^\s*([-*]|\d+\.)\s/.test(p))
    .filter((p) => !p.startsWith('|'))
    .filter((p) => p.length >= 180);
}

/**
 * A finished report of the shape the suite actually asks for: analysis prose, a table, headings, no
 * question put to the reader. Kept deliberately close to the real thing so a rule that would block a
 * good delivery fails HERE rather than during a live run.
 */
const FINISHED_REPORT = `# Monorepo vs Multi-Repo: Trade-offs for a 5-Team Engineering Org

## Executive Summary

For an organisation of five teams, the choice between a single repository and many is not primarily a
tooling decision; it is a decision about where coordination cost is paid. A monorepo moves that cost
into the build system and the review queue, where it is visible and can be engineered against. A
multi-repo layout moves it into release coordination between teams, where it is diffuse and tends to
be paid in delay rather than in effort. Both are workable at this size, and the deciding factor is
which of those two costs the organisation is better equipped to absorb.

## Delivery velocity

A monorepo lets a change that crosses two services land as one commit, which removes the
version-negotiation round trip entirely. At five teams that round trip is the single largest source of
lead time in most measurements, because it serialises work that is otherwise independent. The cost
appears at the other end: every merge competes for the same pipeline, so queue time grows with team
count unless the build graph is partitioned. Multi-repo inverts this, giving each team an independent
pipeline and an independent release cadence, at the price of coordinated upgrades whenever a shared
library changes.

## Code ownership

| Model | Ownership signal | Failure mode |
|---|---|---|
| Monorepo | CODEOWNERS paths | Broad review load on shared paths |
| Multi-repo | Repository boundary | Ownership of shared libraries drifts |

Ownership is clearer in a multi-repo layout because the boundary is physical, and a team's repository
is unambiguously theirs. A monorepo can express the same thing through path ownership, but it takes
deliberate maintenance: as directories move, ownership silently follows the file rather than the team,
and review load concentrates on whoever owns the most-touched shared paths.

## CI cost

Continuous integration is where the monorepo's bill arrives. Without change-based test selection every
commit runs everything, and build cost grows with the product of team count and test suite size.
With selection, cost tracks the change rather than the repository, but the selection logic becomes
infrastructure someone has to own. Multi-repo keeps each pipeline small by construction, while
spending more total compute on repeated dependency installation and duplicated integration runs.

## Recommendation

At five teams, adopt a monorepo only alongside change-based test selection and path ownership; without
both, the CI bill and the review queue will erase the velocity gain within two quarters.
`;

describe('the e2e document rules reject the outline that shipped as a report', () => {
  const CLARIFYING_TELLS = ruleFromHelper('CLARIFYING_TELLS');
  const READER_DIRECTED_ASK = ruleFromHelper('READER_DIRECTED_ASK');
  const OUTLINE_TELLS = ruleFromHelper('OUTLINE_TELLS');
  const doc = outlineForApproval();
  const lower = doc.toLowerCase();

  it('the fixture is the real thing: a heading, a table, and an approval question', () => {
    expect(doc).toMatch(/^#{1,3}\s|\n#{1,3}\s/);
    expect(doc).toMatch(/\|.*\|\s*\n\s*\|[-:\s|]+\|/);
    expect(doc.trim().endsWith('?')).toBe(true);
  });

  // The rule that existed when this document shipped. Kept as a NEGATIVE assertion, because "the guard
  // we had missed it" is the whole reason the other rules exist, and a future edit that made this one
  // match would quietly remove the evidence for them.
  it('the original literal-phrase rule MISSES it, which is why it shipped', () => {
    expect(lower).not.toMatch(CLARIFYING_TELLS);
  });

  it('is rejected for putting a question to the reader', () => {
    expect(lower).toMatch(READER_DIRECTED_ASK);
  });

  it('is rejected for describing what it will contain instead of containing it', () => {
    expect(lower).toMatch(OUTLINE_TELLS);
  });

  it('is rejected for carrying no analysis: zero substantial prose paragraphs', () => {
    expect(proseParagraphs(doc).length).toBe(0);
  });

  it('is rejected on length alone against the report minimum', () => {
    // 996 characters. The old floor was 400, which this cleared with room to spare.
    expect(doc.length).toBeLessThan(1200);
    expect(doc.length).toBeGreaterThan(400);
  });
});

describe('and they accept a finished report, so they can survive a real run', () => {
  const CLARIFYING_TELLS = ruleFromHelper('CLARIFYING_TELLS');
  const READER_DIRECTED_ASK = ruleFromHelper('READER_DIRECTED_ASK');
  const OUTLINE_TELLS = ruleFromHelper('OUTLINE_TELLS');
  const lower = FINISHED_REPORT.toLowerCase();

  it('passes every rejection rule', () => {
    expect(lower).not.toMatch(CLARIFYING_TELLS);
    expect(lower).not.toMatch(READER_DIRECTED_ASK);
    expect(lower).not.toMatch(OUTLINE_TELLS);
  });

  it('carries analysis and clears the report minimum', () => {
    expect(proseParagraphs(FINISHED_REPORT).length).toBeGreaterThanOrEqual(2);
    expect(FINISHED_REPORT.length).toBeGreaterThan(1200);
  });

  it('covers the three subjects the request named', () => {
    expect(lower).toMatch(/velocity/);
    expect(lower).toMatch(/ownership/);
    expect(lower).toMatch(/\bci\b|continuous integration|build (time|cost)/);
  });

  it('contains a table, so the table is not what the rules key on', () => {
    expect(FINISHED_REPORT).toMatch(/\|.*\|\s*\n\s*\|[-:\s|]+\|/);
  });
});
