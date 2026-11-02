/**
 * A PROVISIONING DRY RUN NAMES ONLY THIS INSTANCE'S CURRENT STACKS.
 *
 * The provisioning scripts read their pools and URLs from stack outputs. One that names a retired stack
 * (`CognitoAuth`, `Foundations`) or another instance's finds no output and fails at the point of use, or,
 * worse, finds the default instance's and provisions users there. `--dry-run` makes no AWS call and
 * prints the stacks a real run reads, so the names are checked here for a non-default instance.
 */
import * as path from 'path';
import { spawnSync } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { STACK_NAMES } = require('../scripts/lib/stack-lookup.cjs');

const BACKEND = path.resolve(__dirname, '..');
const PREFIX = 'AeNext';

function dryRun(script: string, env: Record<string, string> = {}): string {
  const r = spawnSync(process.execPath, [script, '--dry-run'], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: { ...process.env, AE_STACK_PREFIX: '', STACK_PREFIX: '', E2E_INSTANCE_NAME: '', INSTANCE_NAME: '', SSM_ROOT: '', AE_INSTANCE_NAME: 'ae-next', ...env },
  });
  expect({ script, status: r.status, stderr: r.stderr }).toEqual({ script, status: 0, stderr: '' });
  return r.stdout;
}

/** Every `AeNext<Name>` the output names, as `<Name>`. */
const stacksNamed = (out: string): string[] => [...out.matchAll(new RegExp(`\\b${PREFIX}([A-Z][A-Za-z0-9-]*)`, 'g'))].map((m) => m[1]);

describe('a provisioning dry run names only current stacks', () => {
  it.each([
    ['scripts/provision-test-users.mjs', {}],
    ['scripts/provision-admin.mjs', { ADMIN_EMAIL: 'a@example.com', ADMIN_TIER: 'premium' }],
  ])('%s', (script, env) => {
    const out = dryRun(script, env as Record<string, string>);
    const named = stacksNamed(out);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      expect({ name, current: STACK_NAMES.current.includes(name) }).toEqual({ name, current: true });
    }
    // Never the default instance's stacks.
    expect(out).not.toMatch(/AgentEchelon[A-Z]/);
  });
});
