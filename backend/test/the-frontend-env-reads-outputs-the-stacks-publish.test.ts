/**
 * THE FRONTEND ENV READS OUTPUTS THE STACKS PUBLISH, AND REFUSES ONE A DECLARED CAPABILITY NEEDS.
 *
 * `gen-frontend-env.mjs` maps CloudFormation output keys to Vite variables. A key no stack publishes is
 * never found, and an optional one is then written as "not deployed" - silently, after a rename. So every
 * key it maps is checked against the outputs the stacks declare, and the outputs a declaration needs
 * (`scripts/lib/frontend-env-requirements.cjs`) are refused when missing: the person API for every
 * client, the admin API with `admin`, the pool with an issuer on it, and its managed login domain with a
 * provider federating into it.
 */
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { missingOutputs } = require('../scripts/lib/frontend-env-requirements.cjs');

const BACKEND = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(BACKEND, rel), 'utf8');

/** Every output id the stacks declare: literal ids, and the frontend stacks' prefixed ones. */
function declaredOutputs(): Set<string> {
  const ids = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(BACKEND, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        for (const m of read(rel).matchAll(/CfnOutput\(this, '([A-Za-z0-9]+)'/g)) ids.add(m[1]);
      }
    }
  };
  walk('lib');
  // FrontendStack names its outputs `${outputPrefix}Distribution*`; the chat app has no prefix and the
  // admin console `Admin` (lib/config/capabilities.ts).
  const prefixes = ['', ...[...read('lib/config/capabilities.ts').matchAll(/outputPrefix: '([A-Za-z]+)'/g)].map((m) => m[1])];
  for (const p of prefixes) for (const s of ['DistributionBucketName', 'DistributionId', 'DistributionUrl']) ids.add(`${p}${s}`);
  return ids;
}

describe('the frontend env', () => {
  const declared = declaredOutputs();

  it('maps only outputs a stack publishes, the two API URLs among them', () => {
    const src = read('scripts/gen-frontend-env.mjs');
    const map = src.slice(src.indexOf('const OUTPUT_TO_VITE = {'), src.indexOf('};', src.indexOf('const OUTPUT_TO_VITE = {')));
    const keys = [...map.matchAll(/^\s+([A-Za-z0-9]+): 'VITE_[A-Z_]+'/gm)].map((m) => m[1]);
    expect(keys).toEqual(expect.arrayContaining(['PersonApiUrl', 'AdminApiUrl', 'UserPoolId', 'AppInstanceArnOutput']));
    expect(map).toMatch(/PersonApiUrl: 'VITE_PERSON_API_URL'/);
    expect(map).toMatch(/AdminApiUrl: 'VITE_ADMIN_API_URL'/);
    for (const key of keys) expect({ key, declared: declared.has(key) }).toEqual({ key, declared: true });
    expect(declared.has('AdminDistributionUrl')).toBe(true);
  });

  it('does not require, for every deployment, an output only some declarations create', () => {
    // A fresh deploy with only the pool's own sign-in failed env generation on the federated client, which
    // exists only with a cognito-federated issuer and is required then by `missingOutputs`.
    const src = read('scripts/gen-frontend-env.mjs');
    const optional = src.slice(src.indexOf('const OPTIONAL = new Set(['), src.indexOf(']);', src.indexOf('const OPTIONAL = new Set([')));
    for (const v of ['VITE_FEDERATED_CLIENT_ID', 'VITE_ADMIN_API_URL', 'VITE_USER_POOL_ID', 'VITE_WIDGET_ORIGIN']) expect({ v, optional: optional.includes(`'${v}'`) }).toEqual({ v, optional: true });
    const poolOnly = missingOutputs({ capabilities: ['chat'], issuers: [{ id: 'deployment', kind: 'cognito-pool', pool: 'self' }], outputs: { PersonApiUrl: 'x', UserPoolId: 'p', UserPoolClientId: 'c' } });
    expect(poolOnly.map((m: { key: string }) => m.key)).not.toContain('UserPoolFederatedClientId');
  });

  it('names as required only outputs a stack publishes', () => {
    const all = missingOutputs({
      capabilities: ['chat', 'admin'],
      issuers: [{ id: 'deployment', kind: 'cognito-pool', pool: 'self' }, { id: 'corp', kind: 'cognito-federated', pool: 'self', providerName: 'Corp' }],
      outputs: {},
    });
    for (const { key } of all) expect({ key, declared: declared.has(key) }).toEqual({ key, declared: true });
  });

  it('refuses a missing output a declared capability or sign-in needs, and nothing else', () => {
    const outputs = { PersonApiUrl: 'https://p', PersonApiCapabilities: 'core', AppInstanceArnOutput: 'arn' };
    // No pool of its own, no admin: the person API alone.
    expect(missingOutputs({ capabilities: ['chat'], issuers: [{ id: 'corp', kind: 'oidc' }], outputs })).toEqual([]);
    // The default registry is the own pool.
    expect(missingOutputs({ capabilities: [], issuers: undefined, outputs }).map((m: { key: string }) => m.key)).toEqual(['UserPoolId', 'UserPoolClientId']);
    expect(missingOutputs({ capabilities: ['admin'], issuers: [{ kind: 'oidc' }], outputs }).map((m: { key: string }) => m.key))
      .toEqual(['AdminApiUrl', 'AdminApiCapabilities', 'AdminDistributionUrl']);
    const federated = missingOutputs({
      capabilities: [],
      issuers: [{ kind: 'cognito-federated', pool: 'self' }],
      outputs: { ...outputs, UserPoolId: 'p', UserPoolClientId: 'c' },
    });
    expect(federated.map((m: { key: string }) => m.key)).toEqual(['UserPoolDomainUrl', 'UserPoolFederatedClientId']);
    expect(missingOutputs({ capabilities: [], issuers: [{ kind: 'oidc' }], outputs: {} }).map((m: { key: string }) => m.key))
      .toEqual(['PersonApiUrl', 'PersonApiCapabilities', 'AppInstanceArnOutput']);
  });

  it('refuses a widget build without its origin, and without the guest issuer\'s captcha and notice when one is declared', () => {
    const outputs = { PersonApiUrl: 'https://p', PersonApiCapabilities: 'core', AppInstanceArnOutput: 'arn' };
    const keys = (issuers: unknown[]) => missingOutputs({ capabilities: ['widget'], issuers, outputs }).map((m: { key: string }) => m.key);
    expect(keys([{ id: 'guest', kind: 'guest' }])).toEqual(['WidgetDistributionUrl', 'GuestCaptchaSiteKey', 'GuestNoticeVersion', 'GuestUpgradePaths', 'GuestSignInUrl']);
    expect(keys([{ id: 'host', kind: 'host-assertion' }])).toEqual(['WidgetDistributionUrl']);
    for (const key of ['WidgetDistributionUrl', 'GuestCaptchaSiteKey', 'GuestNoticeVersion', 'GuestUpgradePaths', 'GuestSignInUrl']) expect({ key, declared: declared.has(key) }).toEqual({ key, declared: true });
  });

  it('is wired into gen-frontend-env before any file is written', () => {
    const src = read('scripts/gen-frontend-env.mjs');
    expect(src.indexOf('missingOutputs({')).toBeGreaterThan(-1);
    expect(src.indexOf('missingOutputs({')).toBeLessThan(src.indexOf('await writeFile(CHAT_ENV_PATH'));
  });
});
