/**
 * A CLASSIFICATION IS SET OR NOT, AND IT NEVER FALLS BACK (lib/router-arn.ts, ADR-046).
 *
 * The dispatchers that carry router variables (the channel flow's `@all` and `/battle`, task-answer
 * repair, the handover backstop, queue triage, the stop evaluation, the battle orchestrator and the
 * services that name a notice or a marker clear) resolve the router through `routerArnForClassification`;
 * a function dispatching its own classification reads that classification's `router-arn` parameter
 * instead (see the module header). These tests pin the one rule the table enforces: a declared classification reaches its OWN
 * router or nothing, and no classification's turn is answered on another's router.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ProfileRegistry, defaultProfileRegistry } from '../../lib/profile-registry';
import { routerArnForClassification, routerArnEnvName } from '../../lambda/src/lib/router-arn';
import * as common from '../../lib/stacks/agent-classification-common';
import { classificationEnvName } from '../../lambda/src/lib/classification-env';

const arnFor = (c: string) => `arn:aws:lambda:us-east-1:111122223333:function:router-${c}`;
const conversational = defaultProfileRegistry.classificationValues().filter((c) => defaultProfileRegistry.isConversational(c));

const saved = { ...process.env };
let warn: jest.SpyInstance;

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.endsWith('_ROUTER_ARN') || k === 'ROUTER_ARN') delete process.env[k];
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  process.env = { ...saved };
});

const wireAll = () => { for (const c of conversational) process.env[routerArnEnvName(c)] = arnFor(c); };

describe('each declared classification reaches only its own router', () => {
  it('the shipped sample declares more than one conversational classification, so the cases below are not vacuous', () => {
    expect(conversational).toEqual(expect.arrayContaining(['basic', 'standard', 'premium']));
  });

  it.each(conversational)('%s resolves to its own router when every router is wired', (c) => {
    wireAll();
    expect(routerArnForClassification(c)).toBe(arnFor(c));
  });

  it.each(conversational)('%s resolves to undefined when only its own router is unset, never to another', (c) => {
    wireAll();
    delete process.env[routerArnEnvName(c)];
    expect(routerArnForClassification(c)).toBeUndefined();
  });

  it('premium with PREMIUM_ROUTER_ARN unset is undefined, not the standard router', () => {
    process.env.STANDARD_ROUTER_ARN = arnFor('standard');
    process.env.BASIC_ROUTER_ARN = arnFor('basic');
    expect(routerArnForClassification('premium')).toBeUndefined();
  });

  it('the legacy bare ROUTER_ARN is not read for any classification', () => {
    process.env.ROUTER_ARN = arnFor('legacy');
    for (const c of conversational) expect(routerArnForClassification(c)).toBeUndefined();
  });

  it('a blank variable is unset', () => {
    process.env.BASIC_ROUTER_ARN = '   ';
    expect(routerArnForClassification('basic')).toBeUndefined();
  });
});

describe('an unknown or unconfigured classification reaches nothing', () => {
  it.each(['enterprise', 'Standard', '', 'standard ', 'undefined'])('%p resolves to undefined even with every router wired', (c) => {
    wireAll();
    expect(routerArnForClassification(c)).toBeUndefined();
  });

  it('the admin plane has no router, even if a variable names one', () => {
    const admin = defaultProfileRegistry.classificationValues().find((c) => !defaultProfileRegistry.isConversational(c));
    expect(admin).toBeDefined();
    wireAll();
    process.env[routerArnEnvName(admin!)] = arnFor(admin!);
    expect(routerArnForClassification(admin!)).toBeUndefined();
  });

  it('logs a [SecurityEvent] naming the classification, once per container and reason', () => {
    routerArnForClassification('never-declared-x');
    routerArnForClassification('never-declared-x');
    const lines = warn.mock.calls.filter((c) => String(c[0]).includes('[SecurityEvent]'));
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual(expect.objectContaining({ classification: 'never-declared-x' }));
  });

  it('never throws', () => {
    expect(() => routerArnForClassification(undefined as unknown as string)).not.toThrow();
    expect(routerArnForClassification(undefined as unknown as string)).toBeUndefined();
  });
});

describe('the table is derived from the registry, not written', () => {
  const peers = new ProfileRegistry({
    classifications: [
      { value: 'legal', profile: 'p', grants: ['legal'] },
      { value: 'finance-ops', profile: 'p', grants: ['finance-ops'] },
    ],
    profiles: [{ name: 'p', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, contextScope: 'granted' }],
    groupClearance: { legal: 'legal', finance: 'finance-ops' },
  });

  it('a classification the code has never heard of is routed by its own variable, with no edit to router-arn.ts', () => {
    process.env.LEGAL_ROUTER_ARN = arnFor('legal');
    process.env.FINANCE_OPS_ROUTER_ARN = arnFor('finance-ops');
    expect(routerArnForClassification('legal', peers)).toBe(arnFor('legal'));
    expect(routerArnForClassification('finance-ops', peers)).toBe(arnFor('finance-ops'));
  });

  it('between peers, an unwired one does not borrow the other', () => {
    process.env.LEGAL_ROUTER_ARN = arnFor('legal');
    expect(routerArnForClassification('finance-ops', peers)).toBeUndefined();
    // And a classification declared by the default registry is unknown to this one.
    process.env.STANDARD_ROUTER_ARN = arnFor('standard');
    expect(routerArnForClassification('standard', peers)).toBeUndefined();
  });

  it('the variable name is the value upper-cased with unsafe characters replaced', () => {
    expect(routerArnEnvName('standard')).toBe('STANDARD_ROUTER_ARN');
    expect(routerArnEnvName('finance-ops')).toBe('FINANCE_OPS_ROUTER_ARN');
  });

  it('router-arn.ts names no classification: there is no hardcoded table to forget a case in', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/lib/router-arn.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/'(basic|standard|premium)'/);
    expect(src).not.toMatch(/\bswitch\b|\bdefault:/);
  });

  // NO STACK WIRES A ROUTER OR TASK SERVICE VARIABLE PER CLASSIFICATION ANY MORE: a shared stack finds each by
  // name at call time (`routerByNameEnvironment`, `taskServiceByNameEnvironment`), so declaring a
  // classification changes no shared stack. The by-name wiring is pinned in
  // `a-first-install-names-a-notice-by-name.test.ts`.
  it('the stacks hold no deploy-time table of routers or task services', () => {
    expect(Object.keys(common)).not.toContain('routerArnEnvironment');
    expect(Object.keys(common)).not.toContain('taskServiceArnEnvironment');
  });

  it('every per-classification variable is named by ONE helper, on the stack side and the reader side', () => {
    // The router used a sanitized name while the processor variable was the raw upper-cased value, so
    // a classification carrying a hyphen would be set under one name and read under another.
    expect(routerArnEnvName('finance-ops')).toBe(classificationEnvName('finance-ops', 'ROUTER_ARN'));
    expect(classificationEnvName('finance-ops', 'ASYNC_PROCESSOR_ARN')).toBe('FINANCE_OPS_ASYNC_PROCESSOR_ARN');
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
    for (const rel of ['lambda/src/router-agent-handler.ts', 'lib/stacks/assistant-profile-stack.ts']) {
      expect(read(rel)).toContain("classificationEnvName(");
      expect(read(rel)).not.toMatch(/toUpperCase\(\)\}_ASYNC_PROCESSOR_ARN/);
    }
  });
});
