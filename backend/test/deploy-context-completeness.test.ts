/**
 * Deploy-context COMPLETENESS.
 *
 * `deploy-config-example.test.ts` proves the EXAMPLE documents every flag the app reads. That is only
 * half: nothing checked the deployer's actual `deploy.config.json`, which is gitignored and drifts on
 * its own. This instance's config was missing `appUrl` while the example documented it correctly -
 * `deploy.mjs` loaded it, forwarded 13 flags, reported success, and the diff showed every CORS origin
 * about to be rewritten to `http://localhost:5173` across eight stacks.
 *
 * The guard has to be narrow to be useful. This deployment legitimately omits 46 of 60 documented
 * keys and wants their defaults; failing on all of them would block every deploy and train the
 * operator to pass the escape hatch reflexively, which is worse than no guard at all.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  compareDeployContext,
  describeDeployContextGap,
  DESTRUCTIVE_IF_ABSENT,
} from '../lib/config/deploy-context';

const BACKEND_DIR = path.join(__dirname, '..');
const EXAMPLE_PATH = path.join(BACKEND_DIR, 'deploy.config.example.json');
const CONFIG_PATH = path.join(BACKEND_DIR, 'deploy.config.json');
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;

describe('compareDeployContext', () => {
  const example = { appUrl: '', analyticsMode: '', senderEmail: '', wafRateLimit: '', _comment: 'x' };

  it('classifies a missing DESTRUCTIVE flag separately from a harmless one', () => {
    const gap = compareDeployContext({ senderEmail: 'a@b.c' }, example);
    expect(gap.destructive).toEqual(['analyticsMode', 'appUrl']);
    expect(gap.missing).toEqual(['wafRateLimit']); // harmless: reported, never fatal
  });

  it('treats a PRESENT-but-empty flag as set, because "" means take the default deliberately', () => {
    // This distinction is the whole point: absent means the deployer never saw the flag; "" means
    // they saw it and chose the default. Only the first can silently delete something.
    const gap = compareDeployContext({ appUrl: '', analyticsMode: '', senderEmail: '', wafRateLimit: '' }, example);
    expect(gap.destructive).toEqual([]);
    expect(gap.missing).toEqual([]);
  });

  it('ignores comment keys on both sides', () => {
    const gap = compareDeployContext(
      { _note: 'mine', appUrl: '', analyticsMode: '', senderEmail: '', wafRateLimit: '' },
      example,
    );
    expect(gap.unknown).toEqual([]);
  });

  it('reports an UNDOCUMENTED key, which is usually a typo taking a silent default', () => {
    const gap = compareDeployContext(
      { appUrl: '', analyticsMode: '', senderEmail: '', wafRateLimit: '', apUrl: 'typo' },
      example,
    );
    expect(gap.unknown).toEqual(['apUrl']);
  });

  it('is clean on a complete config', () => {
    const gap = compareDeployContext({ appUrl: 'x', analyticsMode: 'aurora', senderEmail: 'a@b.c', wafRateLimit: '' }, example);
    expect(gap).toEqual({ destructive: [], missing: [], unknown: [] });
  });
});

describe('describeDeployContextGap', () => {
  it('returns null when there is nothing to say', () => {
    expect(describeDeployContextGap({ destructive: [], missing: [], unknown: [] }, '--x')).toBeNull();
  });

  it('stays silent about harmless missing keys, so the message is not 46 lines of noise', () => {
    // A message nobody reads is a guard nobody obeys.
    const msg = describeDeployContextGap({ destructive: [], missing: ['wafRateLimit'], unknown: [] }, '--x');
    expect(msg).toBeNull();
  });

  it('names the CONSEQUENCE, not just the key', () => {
    const msg = describeDeployContextGap({ destructive: ['appUrl'], missing: [], unknown: [] }, '--x')!;
    expect(msg).toContain('appUrl');
    expect(msg).toMatch(/CORS to localhost|live app offline/);
    expect(msg).toContain('--x'); // the escape hatch is discoverable
  });
});

describe('the deployment configuration itself', () => {
  const hasConfig = fs.existsSync(CONFIG_PATH);

  // deploy.config.json is gitignored, so it is absent in CI. Skipping there is correct - the real
  // protection is deploy.mjs failing closed at deploy time; this is the developer-side net.
  (hasConfig ? it : it.skip)('this instance carries every destructive-if-absent flag', () => {
    const gap = compareDeployContext(readJson(CONFIG_PATH), readJson(EXAMPLE_PATH));
    expect(gap.destructive).toEqual([]);
  });

  it('every destructive flag is actually documented in the example', () => {
    // Otherwise the guard names a key a deployer cannot discover, which is the failure it exists for.
    const documented = new Set(Object.keys(readJson(EXAMPLE_PATH)).filter((k) => !k.startsWith('_')));
    expect(DESTRUCTIVE_IF_ABSENT.filter((k) => !documented.has(k))).toEqual([]);
  });
});
