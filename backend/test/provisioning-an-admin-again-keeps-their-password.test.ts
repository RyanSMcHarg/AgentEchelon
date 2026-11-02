/**
 * RE-RUNNING `provision-admin.mjs` NEVER TAKES AN ADMIN'S PASSWORD FROM THEM.
 *
 * ADMIN-GUIDE "After a fresh deploy" has the operator read the admin's AppInstanceUser ARN after their
 * first sign-in. Re-running the provisioner for that, with ADMIN_TEMP_PASSWORD still set from the
 * bootstrap, reset the admin's permanent password to the temporary one. The ARN is read by `--print-arn`,
 * which changes nothing, and an existing user's password is reset only when `--reset-password` asks.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const BACKEND = path.resolve(__dirname, '..');
const SCRIPT = path.join('scripts', 'provision-admin.mjs');
const src = fs.readFileSync(path.join(BACKEND, SCRIPT), 'utf8');

function dryRun(args: string[], env: Record<string, string>): string {
  const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', ...args], {
    cwd: BACKEND, encoding: 'utf8', env: { ...process.env, ...env },
  });
  expect(r.status).toBe(0);
  return r.stdout;
}

describe('provisioning an admin again', () => {
  it("leaves an existing user's password as it is, even with ADMIN_TEMP_PASSWORD set", () => {
    const out = dryRun([], { ADMIN_EMAIL: 'a@example.com', ADMIN_TIER: 'premium', ADMIN_TEMP_PASSWORD: 'Temp-1234' });
    expect(out).toContain('existing user   password left as it is');
  });

  it('resets it only when --reset-password asks', () => {
    const out = dryRun(['--reset-password'], { ADMIN_EMAIL: 'a@example.com', ADMIN_TIER: 'premium', ADMIN_TEMP_PASSWORD: 'Temp-1234' });
    expect(out).toContain('reset to the given temporary password (--reset-password)');
  });

  it('the one password reset is gated on the flag', () => {
    const resets = [...src.matchAll(/new AdminSetUserPasswordCommand\(/g)];
    expect(resets).toHaveLength(1);
    const before = src.slice(0, resets[0].index);
    expect(before.slice(before.lastIndexOf('if ('))).toMatch(/^if \(TEMP_PASSWORD && RESET_PASSWORD\)/);
  });

  it('--print-arn reads the ARN, needs no tier, and writes nothing', () => {
    expect(dryRun(['--print-arn'], { ADMIN_EMAIL: 'a@example.com', ADMIN_TIER: '' })).toContain('changes nothing');
    const body = src.slice(src.indexOf('async function printArn()'), src.indexOf('async function main()'));
    expect(body).toContain('personOf(await userPool())');
    expect(body).not.toMatch(/Admin(Create|Update|Set|Add)/);
  });
});
