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
const TOOLS = fs.readFileSync(
  path.join(__dirname, '../lambda/src/lib/task-tools.ts'), 'utf8',
);
const CHECK = fs.readFileSync(
  path.join(__dirname, '../lambda/src/lib/deliverable-check.ts'), 'utf8',
);

const SECTION_HEADING = '### What the runtime checks before it delivers';

/**
 * The knobs table's own section, so a number elsewhere in the guide cannot satisfy these.
 *
 * Ends at the next heading of ANY level at or above its own. Ending only at `\n## ` did not isolate
 * anything: the section ran past two sibling `###` subsections all the way to the next chapter, so a
 * stray "60% of the original" in either of them would have kept this suite green while the row it was
 * meant to pin was gone.
 */
function knobsSection(): string {
  const start = GUIDE.indexOf(SECTION_HEADING);
  if (start === -1) return '';
  const rest = GUIDE.slice(start + SECTION_HEADING.length);
  const end = rest.search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('the delivery knobs the guide documents are the ones the code uses', () => {
  const section = knobsSection();

  // Asserted as a TEST rather than inside the helper: a renamed heading should fail one case with a
  // readable message, not break collection of the whole suite before anything runs.
  it('finds the section at all, so nothing below passes by reading an empty string', () => {
    expect(section).not.toBe('');
    expect(section).toContain('| Knob |');
  });

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

  it('words a page is worth: the guide quotes the guidance the tool schema actually gives', () => {
    // NOT a constant any more, and the guide says so. The model converts pages to words when it
    // records the requirement, so what to change is the sentence it converts BY - the schema's own
    // description - not a number in the reader.
    expect(section).toMatch(/roughly 300-900 words/);
    // Matched in fragments: the description is assembled from concatenated string literals in the
    // source, so the whole sentence never appears on one line to match against.
    expect(TOOLS).toMatch(/A page is roughly 300-900 words/);
    expect(TOOLS).toMatch(/depending on how much of it is tables and lists/);
    // And the constant it replaced is gone, so nothing converts pages to words a second way.
    expect(CHECK).not.toMatch(/WORDS_PER_PAGE/);
  });

  it('content floor on a rewrite: the guide says 60% and acceptCorrection uses 0.6', () => {
    expect(section).toMatch(/60% of the original/);
    expect(CHECK).toMatch(/before \* 0\.6/);
  });

  it('no pattern guesses which requirement was the length', () => {
    // The first version searched requirement NAMES for the pattern below, which fails the moment a
    // machine words its own requirement differently ("how long should it be") - and a machine's
    // `requires` is per-deployment prose, so that was always going to happen. The size now arrives
    // under a known key, resolved to numbers by the model that read the sentence.
    expect(PROCESSOR).not.toContain('/length|format|size|pages?|words?/i');
    expect(PROCESSOR).toContain('recordedLengthTarget(taskContext?.task.details)');
    expect(section).toMatch(/Nothing here parses English/);
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
