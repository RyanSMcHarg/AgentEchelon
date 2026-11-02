/**
 * A STACK BELONGS TO ITS OWN INSTANCE, NOT TO EVERY INSTANCE WHOSE NAME IT STARTS WITH.
 *
 * Instance `Acme` and instance `AcmeTwo` share the prefix `Acme`. A script that takes every stack
 * starting with the prefix merges `AcmeTwo`'s outputs into Acme's frontend env. `isInstanceStack`
 * accepts a stack only when the rest of its name is one the app gives its stacks, and this test keeps
 * that list equal to the stack ids the app creates: the core in `bin/backend.ts`, one assistant stack
 * per registry classification, and each capability's stacks in `lib/config/capabilities.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { assistantClassifications } from '../lib/config/profiles';
import { assistantsStackName } from '../lib/stacks/assistant-profile-stack';
import { CAPABILITIES } from '../lib/config/capabilities';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isInstanceStack, INSTANCE_STACK_SUFFIX, STACK_NAMES } = require('../scripts/lib/stack-lookup.cjs');

const backendSrc = fs.readFileSync(path.join(__dirname, '..', 'bin', 'backend.ts'), 'utf8');
const capabilitiesSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'config', 'capabilities.ts'), 'utf8');

describe('a stack belongs to its own instance', () => {
  it('accepts every stack id the app creates, and the app creates no other kind', () => {
    const ids = [
      // The core, named in bin through `stackId`; the assistant stacks are named by `assistantsStackName`, below.
      ...[...backendSrc.matchAll(/stackId\((?:'([^']+)'|`([^`]+)`)\)/g)].map((m) => m[1] || m[2]),
      ...assistantClassifications().map(assistantsStackName),
      // Every capability's stacks, as its factory names them and as its registry entry declares them.
      ...[...capabilitiesSrc.matchAll(/`\$\{ctx\.prefix\}([^`]+)`/g)].map((m) => m[1]),
      ...CAPABILITIES.filter((c) => !c.notBuilt).flatMap((c) => c.stacks),
    ];
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      // Template parts (`${region}`) stand in for a concrete value.
      const concrete = id.replace(/\$\{[^}]+\}/g, 'us-west-2');
      expect({ id, matches: INSTANCE_STACK_SUFFIX.test(concrete) }).toEqual({ id, matches: true });
    }
  });

  it('lists in stack-names.json exactly the stacks bin and the capability registry name', () => {
    // The one name source holds no stale entry and misses none: every fixed name bin creates, and every
    // stack a capability declares (built or not, so a capability that lands needs no second edit).
    const binNames = [...backendSrc.matchAll(/stackId\('([^']+)'\)/g)].map((m) => m[1]);
    expect(binNames.length).toBeGreaterThan(5);
    const named = new Set([...binNames, ...CAPABILITIES.flatMap((c) => c.stacks)]);
    expect([...STACK_NAMES.current, ...STACK_NAMES.testOnly].sort()).toEqual([...named].sort());
    // A retired name is never current, so teardown's enumeration cannot mistake one for the other.
    for (const r of STACK_NAMES.retired) expect({ r, current: STACK_NAMES.current.includes(r) }).toEqual({ r, current: false });
  });

  it("refuses another instance's stack that shares the prefix", () => {
    expect(isInstanceStack('AcmeConversations', 'Acme')).toBe(true);
    expect(isInstanceStack('AcmeAssistants-premium', 'Acme')).toBe(true);
    expect(isInstanceStack('AcmeImageGuardrail-us-west-2', 'Acme')).toBe(true);
    expect(isInstanceStack('AcmeTwoConversations', 'Acme')).toBe(false);
    expect(isInstanceStack('AcmeTwoChatApp', 'Acme')).toBe(false);
    expect(isInstanceStack('AcmeTwoAssistants-basic', 'Acme')).toBe(false);
    expect(isInstanceStack('OtherConversations', 'Acme')).toBe(false);
    expect(isInstanceStack('AcmeConversations', '')).toBe(false);
  });

  it('gen-frontend-env reads only its own instance stacks', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'gen-frontend-env.mjs'), 'utf8');
    expect(src).toMatch(/isInstanceStack\(stack\.StackName, PREFIX\)/);
    expect(src).not.toMatch(/StackName\?\.startsWith\(PREFIX\)/);
  });
});
