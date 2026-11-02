/**
 * TEARDOWN IS THE ONE SCRIPT WHERE "I COULD NOT LOOK" MUST NEVER READ AS "THERE IS NOTHING THERE".
 *
 * `teardown.mjs` asks AWS through `awsJson`, and a caller that writes `(awsJson(...) || {}).X || []`
 * turns a null into an empty inventory, which is right for a not-found and catastrophic for a failed
 * call: a listing of what is still standing that comes back empty both ends the delete loop and
 * satisfies the final check, so the run prints a success over stacks it never read. This happened twice
 * for a different cause - a missing `--region` hid a cross-region stack from both lists - ending in
 * `Teardown complete` with a stack at CREATE_COMPLETE, which then collides on its fixed name at the next
 * deploy as an opaque changeset failure. Every region a stack can live in is now listed
 * (`teardownRegions`, from `lib/config/stack-names.json`).
 *
 * This is a SOURCE-SHAPE test, and that is a deliberate compromise. The decisions are pure and tested in
 * `teardown-plan.test.ts`; what is left here is the driver, a script with top-level side effects, so
 * importing it would run a teardown. So the invariant is pinned where it can be: the failure path must
 * consult the credential probe before it is allowed to return a value, every listing the plan and the
 * verification read goes through the reader that aborts on a failure, and the success line comes after
 * the check that refuses it.
 *
 * The related gap this also guards - `AssociateChannelFlow` on the channel-flow resource - had no test
 * at all, and its failure mode is a caught warning plus a conversation with no flow, which is how it
 * went unnoticed for days the first time.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEARDOWN = path.join(REPO_ROOT, 'backend', 'scripts', 'teardown.mjs');
const CLASSIFICATION_COMMON = path.join(REPO_ROOT, 'backend', 'lib', 'stacks', 'agent-classification-common.ts');

describe('teardown cannot report a success it did not verify', () => {
  // Tracked, so a fresh checkout has it and this guard always runs.
  const src = fs.readFileSync(TEARDOWN, 'utf-8');

  it('has the credential probe the failure path depends on', () => {
    expect(src).toMatch(/function canStillReadTheAccount\s*\(/);
    // `sts get-caller-identity` is the right probe precisely because it needs no permissions beyond
    // holding a usable credential, so a denial on it means the process cannot see the account at all.
    expect(src).toMatch(/sts['"]\s*,\s*['"]get-caller-identity/);
  });

  it('consults that probe before awsJson may return on a failure', () => {
    const fn = src.slice(src.indexOf('function awsJson'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('canStillReadTheAccount');
    // The probe must gate the ABORT, and the abort must come before the `return null`, or a credential
    // failure still reaches the callers as an empty inventory.
    const abortAt = body.indexOf('process.exit(2)');
    const returnNullAt = body.indexOf('return null');
    expect(abortAt).toBeGreaterThan(-1);
    expect(returnNullAt).toBeGreaterThan(abortAt);
  });

  it('does not decide by pattern-matching the CLI error text', () => {
    // The first version of this guard matched `ExpiredToken`/`AccessDenied`/... and the very first
    // thing tried against it produced "The config profile () could not be found", which it missed. A
    // guard against silent failure must not itself fail silently on an unfamiliar message.
    //
    // Asserted against the DECIDING CODE, not the whole file: the comment above `awsJson` names those
    // error codes to record what was removed and why, which is exactly the prose the repo wants kept.
    // The first version of THIS test banned the words anywhere and failed on that comment.
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/ExpiredToken|InvalidClientTokenId|UnrecognizedClientException/);
    expect(code).not.toMatch(/const CANNOT_LOOK/);
  });

  it('lists what is left through a reader that aborts on any failure, never one that reads it as empty', () => {
    // `standingStacks`, `inventory` and `ssmParams` decide both the plan and the final verification, so
    // each reads through `listing`, which exits on a null; and success is printed only after all three
    // come back empty a second time.
    const fn = src.slice(src.indexOf('function listing'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/out === null/);
    expect(body).toContain('process.exit(2)');
    for (const reader of ['function standingStacks', 'function inventory', 'function ssmParams']) {
      const f = src.slice(src.indexOf(reader));
      expect(f.slice(0, f.indexOf('\n}'))).toContain('listing([');
    }
    const complete = src.indexOf('Teardown of "${INSTANCE}" complete');
    expect(complete).toBeGreaterThan(src.indexOf('Teardown INCOMPLETE'));
  });

  it('still defaults to a dry run, so the enumeration change cannot destroy anything by itself', () => {
    expect(src).toMatch(/const CONFIRM = process\.argv\.includes\('--confirm'\)/);
    expect(src).toMatch(/preview \|\| !CONFIRM/);
  });
});

describe('the narrow AssociateChannelFlow grant', () => {
  it('names the channel-flow resource, which is the leg nobody listed', () => {
    const src = fs.readFileSync(CLASSIFICATION_COMMON, 'utf-8');
    // `AssociateChannelFlow` authorizes against the app instance, the channel AND the channel-flow
    // resource. The third was missing, so drift channels were created with no flow attached - surfacing
    // only as a caught warning. This is the one narrow grant of the four that reach this resource, so it
    // is the only one that can regress silently.
    expect(src).toContain('DriftAssociateTheChannelFlowResource');
    expect(src).toMatch(/channel-flow\/\*/);
  });
});
