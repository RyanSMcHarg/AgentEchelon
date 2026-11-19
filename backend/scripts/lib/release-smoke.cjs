/**
 * WHAT A RELEASE OWES, AS DATA (DESIGN-RELEASE-EVIDENCE sections 5 and 7), read by both the step that runs it
 * (`release-steps.mjs`) and the step that judges it (`release-report.mjs`), so the list that runs and the list
 * that is judged cannot diverge.
 *
 * `requires` names the capabilities (`backend/lib/config/capabilities.ts`) an item needs: a configuration that
 * does not declare one records the item as not applicable, never as skipped or passed. `pending` marks an item
 * the design calls for and nothing builds yet; it is owed, so a report names it and is not proven.
 */

/** The deployed smoke set: each a `validate.mjs` phase, narrowed with `--spec` where one phase covers more. */
const SMOKE_ITEMS = [
  { id: 'setup', only: 'seed', requires: ['chat'] },
  { id: 'sign-in', only: 'auth', spec: 'signin', requires: ['chat'] },
  { id: 'deployed-build', only: 'user', spec: 'deployed-build', requires: ['chat'] },
  // One spec covers three rows of the design's table: a 1:1 answered once, a share, and a file between members.
  { id: 'message-share-and-file', only: 'user', spec: 'mentions', requires: ['chat'] },
  // A removal is given by a share and taken by the owner; both routes are the notifications capability's.
  { id: 'removal', only: 'user', spec: 'a-removed-member-is-refused', requires: ['chat', 'notifications'] },
  { id: 'non-member-file', only: 'user', spec: 'a-non-member-is-refused-a-file', requires: ['chat'] },
  { id: 'admin-console-role', only: 'boundaries', spec: 'admin-console-reflects-role', requires: ['admin'] },
];

/** The deny scripts a release runs on the deployment (the name after `deny-test-`). */
const DENY_SCRIPTS = [
  { name: 'admin-capabilities', requires: ['admin'] },
  { name: 'owner-team-tag', requires: ['admin'] },
];

/** The build gates, each one command run from the repository root's `cwd`, as CI runs them. */
const GATES = [
  { id: 'backend-build', cwd: 'backend', cmd: ['npm', 'run', 'build'] },
  { id: 'backend-typecheck', cwd: 'backend', cmd: ['npm', 'run', 'typecheck'] },
  { id: 'backend-synth', cwd: 'backend', cmd: ['npx', 'cdk', 'synth', '--quiet'] },
  { id: 'frontend-lint', cwd: 'frontend', cmd: ['npm', 'run', 'lint'] },
  { id: 'frontend-test', cwd: 'frontend', cmd: ['npm', 'test'] },
  { id: 'frontend-build', cwd: 'frontend', cmd: ['npm', 'run', 'build'] },
];

module.exports = { SMOKE_ITEMS, DENY_SCRIPTS, GATES };
