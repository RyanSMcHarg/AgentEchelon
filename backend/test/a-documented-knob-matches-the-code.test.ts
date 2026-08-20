/**
 * THE KNOBS TABLE IN THE DEVELOPER GUIDE STATES THE VALUES THE CODE ACTUALLY USES.
 *
 * `HOW-TO-ADD-OR-MANAGE-A-PROFILE.md` documents the delivery checks as tunable constants - how many
 * correction passes run, the artifact floor, the words-per-page band, the floor a rewrite must keep -
 * precisely so a reader knows these are choices rather than properties of the design, and can change
 * them deliberately.
 *
 * A table like that is worth less than nothing once it drifts: it reads as authoritative, and someone
 * planning a change works from numbers the runtime stopped using. Documentation that invites you to
 * change a constant has to name the constant correctly.
 *
 * This asserts the DOCUMENTED value against the SOURCE for each row. It does not check the prose - the
 * trade-off column is judgement, and judgement is reviewed by people.
 */
import * as fs from 'fs';
import * as path from 'path';

const GUIDE = fs.readFileSync(
  path.join(__dirname, '../../docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md'), 'utf8',
);
const PROCESSOR = fs.readFileSync(
  path.join(__dirname, '../lambda/src/assistant-async-processor.ts'), 'utf8',
);
const CHECK = fs.readFileSync(
  path.join(__dirname, '../lambda/src/lib/deliverable-check.ts'), 'utf8',
);

/** The knobs table's own section, so a number elsewhere in the guide cannot satisfy these. */
function knobsSection(): string {
  const start = GUIDE.indexOf('### What the runtime checks before it delivers');
  expect(start).toBeGreaterThan(-1);
  const rest = GUIDE.slice(start + 1);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('the delivery knobs the guide documents are the ones the code uses', () => {
  const section = knobsSection();

  it('correction passes: the guide says 3 and the constant is 3', () => {
    expect(section).toMatch(/MAX_CORRECTION_ROUNDS[^|]*\|[^|]*\b3\b/);
    expect(PROCESSOR).toMatch(/const MAX_CORRECTION_ROUNDS = 3;/);
  });

  it('artifact floor: the guide says 400 chars, and BOTH paths use it', () => {
    expect(section).toMatch(/400 chars/);
    // The task delivery gate, and the ad-hoc "save this as a document" path. The guide names both
    // because changing one alone makes the two disagree about what is worth downloading.
    expect(PROCESSOR).toMatch(/trimmedResponse\.length >= 400/);
    expect(PROCESSOR).toMatch(/response\.trim\(\)\.length < 400/);
    expect(section).toMatch(/two sites/i);
  });

  it('words per page: the guide says 300-900 and the constants agree', () => {
    expect(section).toMatch(/300-900/);
    expect(CHECK).toMatch(/const WORDS_PER_PAGE_MIN = 300;/);
    expect(CHECK).toMatch(/const WORDS_PER_PAGE_MAX = 900;/);
  });

  it('content floor on a rewrite: the guide says 60% and acceptCorrection uses 0.6', () => {
    expect(section).toMatch(/60% of the original/);
    expect(CHECK).toMatch(/before \* 0\.6/);
  });

  it('the length-requirement matcher in the guide is the pattern the processor runs', () => {
    const documented = /\/length\\?\|format\\?\|size\\?\|pages\?\\?\|words\?\/i/;
    expect(section).toMatch(documented);
    expect(PROCESSOR).toMatch(/\/length\|format\|size\|pages\?\|words\?\/i/);
  });

  it('the three purity rules the guide counts are the three the module declares', () => {
    expect(section).toMatch(/three regexes/);
    const declared = CHECK.match(/^const (CHAT_WRAPPER|READER_ASK|CLAIMS_A_FILE)\b/gm) ?? [];
    expect(declared).toHaveLength(3);
  });

  // The two limits are the reason the section exists: a reader has to be able to tell a deliberate
  // trade-off from a wall. If either stops being described as movable, the section has lost its point.
  it('both limits are stated AND described as movable', () => {
    expect(section).toMatch(/best version is delivered anyway/i);
    expect(section).toMatch(/Completion is still the model's decision/i);
    expect(section).toMatch(/neither is fundamental/i);
    expect(section).toMatch(/per-platform constants today rather than per-deployment/i);
  });
});
