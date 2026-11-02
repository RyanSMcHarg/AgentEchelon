/**
 * EVERY `resolveChannelSize` CALL IN THE ROUTER HONORS A REFUSAL.
 *
 * WHAT THIS GUARDS AND WHAT IT DOES NOT. This is a lexical guard, the same shape ADR-045 asks for on
 * `rankOf(` and the repo already uses elsewhere. It does not prove the router behaves correctly on a
 * denial; the live deny-test in three entry shapes is what earns that, and it runs against a
 * deployment. What this catches is the regression a unit test of behavior would NOT catch: somebody
 * adding a sixth `resolveChannelSize` call later and not knowing a refusal has to end the turn.
 *
 * That failure mode is the specific one ADR-045 was written about. The finding began as five call
 * sites in this file of which the design record named two, and the two it missed were both real: a
 * flow-entry turn reaches `chain-resume` without passing either of the named guards. A guard that
 * counts the call sites live is the only thing that stays true as the file changes, which is the same
 * argument `reuse-first.js` makes for counting implementations rather than listing them.
 *
 * IT IS DELIBERATELY NOT A SNAPSHOT OF A NUMBER. Asserting "there are five call sites" would fail on
 * every unrelated addition and would be updated without thought, which is how a guard stops guarding.
 * It asserts the PROPERTY instead: each call is followed, within a few lines, by a `refused` check.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROUTER = join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts');

/**
 * How far after the call a `refused` check may appear. Generous enough for the destructuring and the
 * comment that usually sit between, tight enough that a check further down some other branch does not
 * count as guarding this one.
 */
const WINDOW = 12;

describe('every channel-size read in the router honors a refusal', () => {
  const source = readFileSync(ROUTER, 'utf8');
  const lines = source.split('\n');

  /** Line numbers (1-based) of real calls, excluding the import and prose mentions. */
  const callSites = lines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /await resolveChannelSize\(/.test(line));

  it('finds the call sites at all, so an empty result cannot pass as compliance', () => {
    // Without this, a rename of `resolveChannelSize` would empty the list and every assertion below
    // would vacuously pass - a guard that asserts over nothing.
    expect(callSites.length).toBeGreaterThanOrEqual(4);
  });

  it.each(
    // Jest needs the cases at collection time; the label carries the line number so a failure names
    // the exact call rather than "case 3".
    (() => {
      const src = readFileSync(ROUTER, 'utf8').split('\n');
      return src
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /await resolveChannelSize\(/.test(line))
        .map(({ n }) => [`router-agent-handler.ts:${n}`, n] as [string, number]);
    })(),
  )('%s is followed by a refusal check', (_label, n) => {
    const window = lines.slice(n - 1, n - 1 + WINDOW).join('\n');
    expect(window).toMatch(/\.refused\b/);
  });
});

describe('the refusal helper stays a silent close', () => {
  const source = readFileSync(ROUTER, 'utf8');

  it('returns the silent response rather than composing user-facing content', () => {
    // The whole point of decision 1 is that NOTHING is returned for Amazon Chime SDK to materialize
    // into a room this assistant may not act in. A well-meaning "I cannot help here" added to this
    // helper would post that sentence into exactly the room the boundary refused.
    const helper = source.slice(
      source.indexOf('function refuseAtClassificationBoundary'),
      source.indexOf('async function resolveChannelClassification'),
    );
    expect(helper).toContain('formatLexSilentResponse');
    expect(helper).not.toMatch(/content:\s*['"`]/);
  });

  it('records the refusal through the shared recorder', () => {
    const helper = source.slice(
      source.indexOf('function refuseAtClassificationBoundary'),
      source.indexOf('async function resolveChannelClassification'),
    );
    // The SecurityEvent and the counted metric live in `lib/access-denial.ts` rather than inline
    // here, because emitters are discovered from source and each must be exercisable on its own
    // (`emf-schema.test.ts` fails the build otherwise). What this guards is that the refusal path
    // still goes through that recorder: a count nobody emits is an alarm watching an empty series,
    // which reads to an operator as "no refusals have happened".
    expect(helper).toContain('recordClassificationBoundaryRefusal');
  });
});
