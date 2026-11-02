/**
 * AN ASSISTANT ROLE IS ADDED BY DECLARING IT, AND THE DEMO SCRIPT WRITES ONLY THAT DECLARATION.
 *
 * A role the deployment declares is deployed, with no switch beside it. A role the shipped catalog offers is
 * declared by naming its assistant in `profiles` beside its classification (`ops-premium`), so
 * `scripts/add-assistant-role.mjs` changes one list in deploy.config.json and deploys one stack. The script
 * drives a live account; these pin what it decides first (`scripts/lib/assistant-role-config.cjs`) and the
 * selection it relies on (`shippedProfilesSelection`).
 */
import {
  DEFAULT_PROFILES_CONFIG,
  resolveDeploymentProfiles,
  shippedRoleAssistants,
} from '../lib/config/profiles';
import { ProfileRegistry } from '../lib/profile-registry';
import { classificationDeclarationErrors } from '../lib/config/declared-classifications';
import { retiredContextKeyErrors, RETIRED_CONTEXT_KEYS } from '../lib/config/deploy-context';
import * as roleFilling from '../lambda/src/lib/role-filling';
import * as declaredAssistants from '../lambda/src/lib/declared-assistants';
import * as runtimeDirectory from '../lambda/src/lib/runtime-directory';

const {
  parseRoleArgs,
  profilesList,
  roleSelection,
  withProfilesText,
  assistantsStackFor,
  deployArgs,
  checkoutRefusal,
  ROLE_FILLING_MODULE,
  withdrawalRefusal,
  DEPLOYED_RECORD_KEY,
} = require('../scripts/lib/assistant-role-config.cjs');

const DEFAULT_SELECTION = ['basic', 'standard', 'premium'];
const offered = shippedRoleAssistants();
const opts = { offered, defaultSelection: DEFAULT_SELECTION };

describe('a declared role is deployed, and an undeclared one is not', () => {
  it('the shipped catalog offers the premium ops assistant', () => {
    expect([...offered.entries()]).toEqual([['ops-premium', { classification: 'premium', role: 'ops' }]]);
  });

  it('a deployment that names no role assistant holds only primaries, and no role profile', () => {
    for (const raw of [undefined, '', ['basic', 'standard', 'premium']]) {
      const config = resolveDeploymentProfiles(raw);
      const registry = new ProfileRegistry(config);
      expect(registry.rolesFor('premium')).toEqual(['primary']);
      expect(config.profiles.map((p) => p.name)).not.toContain('ops-premium');
      expect(config.classifications.find((c) => c.value === 'premium')?.roleContext).toBeUndefined();
      // The ops type names ops-premium, and that is not a misdeclaration where the role is not declared.
      expect(classificationDeclarationErrors([], registry)).toEqual([]);
    }
  });

  it('naming ops-premium beside premium deploys the role, its context scope and its profile', () => {
    for (const raw of [['basic', 'standard', 'premium', 'ops-premium'], 'basic,standard,premium,ops-premium']) {
      const config = resolveDeploymentProfiles(raw);
      const registry = new ProfileRegistry(config);
      const shipped = DEFAULT_PROFILES_CONFIG.classifications.find((c) => c.value === 'premium')!;
      expect(registry.rolesFor('premium')).toEqual(shipped.roles);
      expect(config.classifications.find((c) => c.value === 'premium')?.roleContext).toEqual(shipped.roleContext);
      expect(config.profiles.map((p) => p.name)).toContain('ops-premium');
      expect(registry.roleAssistantName('premium', 'ops')).toBe('ops-premium');
      expect(classificationDeclarationErrors([], registry)).toEqual([]);
    }
  });

  it('refuses a role assistant without its classification, and a name the catalog does not offer', () => {
    expect(() => resolveDeploymentProfiles(['basic', 'ops-premium'])).toThrow(/"ops-premium" is a role of "premium", which the selection does not name/);
    expect(() => resolveDeploymentProfiles(['premium', 'ops-standard'])).toThrow(/not a shipped classification or role assistant/);
  });

  it('retires additionalRoles at synth, naming the declaration that replaces it', () => {
    expect(RETIRED_CONTEXT_KEYS.additionalRoles).toMatch(/ops-premium/);
    for (const value of ['on', 'off', '']) {
      expect(retiredContextKeyErrors((k) => (k === 'additionalRoles' ? value : undefined))).toEqual([RETIRED_CONTEXT_KEYS.additionalRoles]);
    }
  });
});

describe('the command line', () => {
  it('defaults to the premium ops assistant, and reads --dry-run and --remove', () => {
    expect(parseRoleArgs([])).toEqual({ assistant: 'ops-premium', dryRun: false, remove: false, help: false });
    expect(parseRoleArgs(['ops-premium', '--dry-run', '--remove'])).toEqual({ assistant: 'ops-premium', dryRun: true, remove: true, help: false });
  });

  it('refuses an unknown option and a second name rather than ignoring them', () => {
    expect(() => parseRoleArgs(['--dryrun'])).toThrow(/unknown option "--dryrun"/);
    expect(() => parseRoleArgs(['ops-premium', 'other'])).toThrow(/name one role assistant/);
  });
});

describe('the profiles list it writes', () => {
  it('spells out the default selection when profiles is absent or empty, then adds the name', () => {
    for (const value of [undefined, null, '', '  ']) {
      expect(roleSelection(value, 'ops-premium', opts)).toEqual({
        classification: 'premium', role: 'ops',
        before: DEFAULT_SELECTION, after: [...DEFAULT_SELECTION, 'ops-premium'], changed: true,
      });
    }
  });

  it('keeps every classification already selected, in its order, from a list or a comma string', () => {
    const list = ['premium', 'basic', 'guest', 'customer'];
    expect(roleSelection(list, 'ops-premium', opts).after).toEqual([...list, 'ops-premium']);
    expect(roleSelection('premium, basic', 'ops-premium', opts).after).toEqual(['premium', 'basic', 'ops-premium']);
    expect(profilesList('["premium"]', DEFAULT_SELECTION)).toEqual(['premium']);
  });

  it('changes nothing when the name is already there, and removes only the name', () => {
    const declared = ['basic', 'standard', 'premium', 'ops-premium'];
    expect(roleSelection(declared, 'ops-premium', opts)).toMatchObject({ after: declared, changed: false });
    expect(roleSelection(declared, 'ops-premium', { ...opts, remove: true })).toMatchObject({ after: ['basic', 'standard', 'premium'], changed: true });
    expect(roleSelection(['basic', 'premium'], 'ops-premium', { ...opts, remove: true })).toMatchObject({ changed: false });
  });

  it('refuses a name the catalog does not offer, a selection without its classification, and a custom set', () => {
    expect(() => roleSelection('', 'ops-standard', opts)).toThrow(/not a role assistant the shipped catalog offers/);
    expect(() => roleSelection(['basic', 'standard'], 'ops-premium', opts)).toThrow(/does not name "premium"/);
    expect(() => roleSelection({ classifications: [], profiles: [], groupClearance: {} }, 'ops-premium', opts)).toThrow(/custom set/);
    expect(() => roleSelection('json64:e30', 'ops-premium', opts)).toThrow(/custom set/);
  });
});

describe('the file it writes', () => {
  const after = ['basic', 'standard', 'premium', 'ops-premium'];

  it('replaces the profiles value in place and leaves every other byte alone', () => {
    const text = '{\n  "_analyticsModeChosenAtFirstDeploy": "aurora",\n  "_profiles": "a comment naming \\"profiles\\": here",\n\n  "profiles": "",\n  "issuers": [{"id":"deployment","profiles":"x"}],\n  "senderEmail": "a@example.com"\n}\n';
    const next = withProfilesText(text, after);
    expect(next).toBe(text.replace('"profiles": "",', '"profiles": ["basic", "standard", "premium", "ops-premium"],'));
    expect(JSON.parse(next).issuers[0].profiles).toBe('x');
  });

  it('replaces a list value, and adds the key in the file\'s own indentation and line endings when it is absent', () => {
    expect(JSON.parse(withProfilesText('{"profiles": ["premium"], "a": 1}', ['premium', 'ops-premium'])))
      .toEqual({ profiles: ['premium', 'ops-premium'], a: 1 });
    const crlf = '{\r\n    "senderEmail": "a@example.com"\r\n}\r\n';
    expect(withProfilesText(crlf, after)).toBe('{\r\n    "profiles": ["basic", "standard", "premium", "ops-premium"],\r\n    "senderEmail": "a@example.com"\r\n}\r\n');
  });

  it('refuses text that does not parse, so a broken file is never rewritten', () => {
    expect(() => withProfilesText('{ "profiles": ', after)).toThrow();
  });
});

describe('what it deploys, and from where', () => {
  it('deploys the classification\'s assistant stack through the guarded single-stack deploy', () => {
    expect(assistantsStackFor('AgentEchelon', 'premium')).toBe('AgentEchelonAssistants-premium');
    expect(deployArgs('AgentEchelonAssistants-premium')).toEqual(['run', 'deploy:stack', '--', 'AgentEchelonAssistants-premium']);
  });

  it('runs only from the checkout that deploys this instance', () => {
    const deployed = JSON.stringify({ [DEPLOYED_RECORD_KEY]: 'aurora', profiles: '' });
    expect(checkoutRefusal({ isGitWorkTree: true, configExists: true, configText: deployed })).toBeNull();
    expect(checkoutRefusal({ isGitWorkTree: false, configExists: true, configText: deployed })).toMatch(/not a git work tree/);
    expect(checkoutRefusal({ isGitWorkTree: true, configExists: false, configText: '' })).toMatch(/deploy\.config\.json is not here/);
    expect(checkoutRefusal({ isGitWorkTree: true, configExists: true, configText: '{ nope' })).toMatch(/could not be parsed/);
    expect(checkoutRefusal({ isGitWorkTree: true, configExists: true, configText: '{}' })).toMatch(/no deploy has run from this checkout/);
  });

  it('refuses a config that still carries the retired additionalRoles key', () => {
    const text = JSON.stringify({ [DEPLOYED_RECORD_KEY]: 'aurora', additionalRoles: 'on' });
    expect(checkoutRefusal({ isGitWorkTree: true, configExists: true, configText: text })).toMatch(/additionalRoles, which is retired/);
  });
});

describe('--remove withdraws the ROLE, and only once no assistant fills it', () => {
  const ops = { classification: 'premium', role: 'ops' };
  const now = Date.parse('2026-10-24T12:00:00Z');
  const directory = (entries: Record<string, Record<string, unknown>>) => new Map(Object.entries(entries)) as Map<string, any>;
  // The script's rule is the provisioner's own (`lambda/src/lib/role-filling.ts`), called as the script calls it.
  const assistantsFilling = (d: Map<string, any>, sel: { classification: string; role: string }, at: number) => roleFilling.assistantsFilling(d, sel.classification, sel.role, at);

  it('is refused while the declared assistant is active, naming it and saying to retire it in the console', () => {
    const fillers = assistantsFilling(directory({ 'ops-premium': { classification: 'premium', role: 'ops', origin: 'declared', status: 'active' } }), ops, now);
    expect(fillers).toEqual(['ops-premium']);
    expect(withdrawalRefusal(fillers, ops)).toMatch(/the ops role cannot be withdrawn from premium while an assistant fills it: ops-premium\. Retire it in the console first .*Nothing was written/);
  });

  it('is refused while a console-created assistant fills the role, naming every one', () => {
    const fillers = assistantsFilling(directory({
      'ops-premium': { classification: 'premium', role: 'ops', origin: 'declared', status: 'retired' },
      sentinel: { classification: 'premium', role: 'ops', origin: 'console', status: 'active' },
      watcher: { classification: 'premium', role: 'ops', status: 'retiring' },
    }), ops, now);
    expect(fillers).toEqual(['sentinel', 'watcher']);
    expect(withdrawalRefusal(fillers, ops)).toMatch(/while assistants fill it: sentinel, watcher\. Retire them/);
  });

  it('goes ahead once every assistant in the role is retired: a retired declared one no longer blocks', () => {
    const fillers = assistantsFilling(directory({
      'ops-premium': { classification: 'premium', role: 'ops', origin: 'declared', status: 'retired' },
      'sentinel-r1': { classification: 'premium', role: 'ops', origin: 'console', status: 'retired' },
      died: { classification: 'premium', role: 'ops', status: 'provisioning', createdAt: '2026-10-24T11:00:00Z' },
      advisor: { classification: 'premium', role: 'primary', origin: 'declared', status: 'active' },
      'ops-standard': { classification: 'standard', role: 'ops', origin: 'declared', status: 'active' },
    }), ops, now);
    expect(fillers).toEqual([]);
    expect(withdrawalRefusal(fillers, ops)).toBeNull();
  });
});

describe('who fills a role has one source, read by the deploy and by the script', () => {
  it('the provisioner and the directory read the one module, and the script names it rather than copying it', () => {
    expect(declaredAssistants.assistantsFilling).toBe(roleFilling.assistantsFilling);
    expect(runtimeDirectory.withAbandonedBuild).toBe(roleFilling.withAbandonedBuild);
    expect(runtimeDirectory.BUILD_DEADLINE_MS).toBe(roleFilling.BUILD_DEADLINE_MS);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../scripts/lib/assistant-role-config.cjs');
    expect(Object.keys(config).filter((k) => /^assistantsFilling$|deadline/i.test(k))).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(require('fs').readFileSync(require('path').join(__dirname, '../scripts/lib/assistant-role-config.cjs'), 'utf8')).not.toMatch(/20 \* 60_000|'provisioning', 'retiring'/);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const resolved = path.resolve(__dirname, '../scripts', ROLE_FILLING_MODULE);
    expect(path.relative(path.resolve(__dirname, '..'), resolved).split(path.sep).join('/')).toBe('lambda/src/lib/role-filling.js');
    expect(fs.existsSync(resolved.replace(/\.js$/, '.ts'))).toBe(true);
    const script: string = fs.readFileSync(path.resolve(__dirname, '../scripts/add-assistant-role.mjs'), 'utf8');
    expect(script).toMatch(/const \{ assistantsFilling \} = require\(ROLE_FILLING_MODULE\);/);
    // Read only after the build that compiles it.
    expect(script.indexOf("npm(['run', 'build']")).toBeLessThan(script.indexOf('require(ROLE_FILLING_MODULE)'));
  });
});
