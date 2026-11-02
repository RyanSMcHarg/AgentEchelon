/**
 * THE MATRIX ITSELF: every configuration has its own file, the one left out says why, and each check
 * the configuration files run can fail. No synthesis here; the configuration files do that.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ABSENT_CONFIGURATIONS,
  CONFIGURATIONS,
  CORE_NOT_BUILT,
  CORE_STACKS,
  expectedStacks,
  attachKindOf,
  refusedCapabilities,
  contextFor,
  configuration,
  OUTSIDE_CLASSIFICATIONS,
  type Configuration,
} from './configurations';
import { deployedAssistantClassifications, resolveDeploymentProfiles } from '../../lib/config/profiles';
import { CAPABILITIES, capabilityDefinition } from '../../lib/config/capabilities';
import { additivityViolations, assistantParameterViolations, classificationIndependenceViolations, componentRuleViolations, owningStackOf, ssmEdgeViolations, type Synthesized } from './matrix';

const DIR = __dirname;

describe('the deploy matrix covers every configuration', () => {
  it('passes as the registry the entries a configuration records, and leaves out an issuer recorded without one', () => {
    // C0 is the guest issuer alone: a guest-only deployment, with no pool of its own.
    expect(contextFor(configuration('C0'), 'athena').issuers).toEqual([configuration('C0').issuers[0].entry]);
    expect((contextFor(configuration('C0'), 'athena').issuers as Array<{ kind: string }>).map((e) => e.kind)).toEqual(['guest']);
    expect(contextFor(configuration('C1-headless'), 'athena').issuers).toEqual(configuration('C1-headless').issuers.map((i) => i.entry));
    for (const c of CONFIGURATIONS) {
      const recorded = c.issuers.filter((i) => i.entry).map((i) => i.entry);
      expect({ id: c.id, passed: contextFor(c, 'athena').issuers ?? [] }).toEqual({ id: c.id, passed: recorded });
    }
  });

  it('diffs a configuration only against one that synthesizes the same registry and the same classifications', () => {
    for (const c of CONFIGURATIONS) {
      if (!c.previous) continue;
      const prev = configuration(c.previous);
      expect({ id: c.id, issuers: contextFor(c, 'athena').issuers ?? null, classifications: [...c.classifications].sort() })
        .toEqual({ id: c.id, issuers: contextFor(prev, 'athena').issuers ?? null, classifications: [...prev.classifications].sort() });
    }
    // The two that add an issuer or a classification set to C0 head chains of their own.
    expect(configuration('C1').previous).toBeNull();
    expect(configuration('C0+admin').previous).toBeNull();
  });


  it('names C0 to C7, headless C1 alone and with each layer, the example configuration, C0 + admin, C1-custom + enterprise and C7-custom + research, with C4 declared absent and why', () => {
    const ids = [...CONFIGURATIONS.map((c) => c.id), ...ABSENT_CONFIGURATIONS.map((c) => c.id)].sort();
    expect(ids).toEqual(['C0', 'C0+admin', 'C1', 'C1-custom', 'C1-custom+enterprise', 'C1-headless', 'C1-headless+chat', 'C1-headless+admin', 'C1-headless+chat+admin', 'C1-headless+experiments', 'C1-headless+duels', 'C-example', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C7-custom', 'C7-custom+research'].sort());
    for (const absent of ABSENT_CONFIGURATIONS) expect(absent.reason.length).toBeGreaterThan(40);
  });

  it('gives every configuration exactly one file, and every file in the matrix a configuration', () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.test.ts') && f !== path.basename(__filename));
    expect(files.sort()).toEqual(CONFIGURATIONS.map((c) => c.file).sort());
    for (const c of CONFIGURATIONS) {
      const src = fs.readFileSync(path.join(DIR, c.file), 'utf8');
      expect(src).toContain(`describeConfiguration('${c.id}')`);
    }
  });

  it('is cumulative: each configuration keeps what the one before it declares', () => {
    for (const c of CONFIGURATIONS) {
      if (!c.previous) continue;
      const prev = CONFIGURATIONS.find((p) => p.id === c.previous);
      expect(prev).toBeDefined();
      for (const cap of prev!.capabilities) expect(c.capabilities).toContain(cap);
      for (const s of expectedStacks(prev!)) expect(expectedStacks(c)).toContain(s);
    }
  });

  it('reads the classifications of each configuration from what it declares in profiles', () => {
    for (const c of CONFIGURATIONS) {
      expect({ id: c.id, classifications: [...c.classifications] })
        .toEqual({ id: c.id, classifications: deployedAssistantClassifications(resolveDeploymentProfiles(contextFor(c, 'athena').profiles)) });
    }
  });

  it('declares guest and customer wherever it passes a guest issuer, and no outside classification anywhere else', () => {
    expect(outsideDeclarationErrors(CONFIGURATIONS)).toEqual([]);
    // Every configuration but C1-headless and C1-custom passes the guest issuer, and stands up both outside
    // classifications with it; those two pass none and stand up neither.
    for (const c of CONFIGURATIONS) {
      const outside = c.classifications.filter((v) => (OUTSIDE_CLASSIFICATIONS as readonly string[]).includes(v)).sort();
      const passesGuest = ((contextFor(c, 'athena').issuers ?? []) as Array<{ kind: string }>).some((e) => e.kind === 'guest');
      expect({ id: c.id, outside }).toEqual({ id: c.id, outside: passesGuest ? [...OUTSIDE_CLASSIFICATIONS].sort() : [] });
    }
    expect(['C1-headless', 'C1-custom'].map((id) => configuration(id).issuers.some((i) => i.kind === 'guest'))).toEqual([false, false]);
  });

  it('includes a configuration that declares none of the shipped classifications and no guest', () => {
    const custom = configuration('C1-custom');
    const shipped = resolveDeploymentProfiles(['basic', 'standard', 'premium', 'guest', 'customer']).classifications.map((c) => c.value);
    expect(custom.classifications.length).toBeGreaterThan(0);
    expect(custom.classifications.filter((v) => shipped.includes(v))).toEqual([]);
    expect(custom.issuers.some((i) => i.kind === 'guest')).toBe(false);
  });

  it('adds exactly one classification, and nothing else a capability would, where it declares addsClassification', () => {
    const pairs = CONFIGURATIONS.filter((c) => c.addsClassification);
    expect(pairs.map((c) => c.id)).toEqual(['C1-custom+enterprise', 'C7-custom+research']);
    for (const c of pairs) {
      const base = configuration(c.addsClassification!.to);
      expect({ id: c.id, capabilities: [...c.capabilities].sort(), addedStacks: [...c.addedStacks].sort() })
        .toEqual({ id: c.id, capabilities: [...base.capabilities].sort(), addedStacks: [...base.addedStacks].sort() });
      expect({ id: c.id, added: c.classifications.filter((v) => !base.classifications.includes(v)), removed: base.classifications.filter((v) => !c.classifications.includes(v)) })
        .toEqual({ id: c.id, added: [c.addsClassification!.classification], removed: [] });
    }
  });

  it('declares admin only beside an issuer that is not the guest issuer', () => {
    for (const c of CONFIGURATIONS.filter((x) => x.capabilities.includes('admin'))) {
      expect(c.issuers.some((i) => i.kind !== 'guest' && i.admin === true)).toBe(true);
    }
  });

  it('names the work that turns each configuration green', () => {
    for (const c of CONFIGURATIONS) expect(c.greenAt).toMatch(/^W\d+$/);
  });

  it('declares only capabilities the registry knows', () => {
    for (const c of CONFIGURATIONS) {
      for (const name of c.capabilities) expect({ config: c.id, name, known: !!capabilityDefinition(name) }).toEqual({ config: c.id, name, known: true });
    }
  });

  it('declares only capabilities the registry builds, so every check of every configuration binds', () => {
    // A configuration declaring a capability the registry refuses would not synthesize, and its checks would
    // fail with the refusal; none is ever parked as an expected failure instead.
    for (const c of CONFIGURATIONS) expect({ id: c.id, refused: refusedCapabilities(c) }).toEqual({ id: c.id, refused: [] });
    expect(CAPABILITIES.filter((c) => c.notBuilt).map((c) => c.name)).not.toContain('battle');
  });

  it('parks no check as an expected failure or a skip, in any file of the matrix', () => {
    const parked = /^\s*(it|test|describe)\.(failing|skip|todo)\b|^\s*x(it|test|describe)\(|[?:]\s*\(?\s*(it|test|describe)\.(failing|skip|todo)\b/m;
    for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.ts') && x !== path.basename(__filename))) {
      expect({ f, parked: parked.test(fs.readFileSync(path.join(DIR, f), 'utf8')) }).toEqual({ f, parked: false });
    }
  });

  it('names the work that builds each core stack not built yet, and only core stacks', () => {
    for (const [stack, work] of Object.entries(CORE_NOT_BUILT)) {
      expect({ stack, core: (CORE_STACKS as readonly string[]).includes(stack), work }).toEqual({ stack, core: true, work: expect.stringMatching(/^W\d+$/) });
    }
  });

  it('keeps every configuration fully synthesized', () => {
    expect(CONFIGURATIONS.filter((c) => refusedCapabilities(c).length === 0).map((c) => c.id)).toEqual(CONFIGURATIONS.map((c) => c.id));
  });
});

/** Each configuration that passes a guest issuer without declaring guest and customer, and each that stands up one undeclared. */
function outsideDeclarationErrors(configs: readonly Configuration[]): string[] {
  const errors: string[] = [];
  for (const c of configs) {
    const passed = (contextFor(c, 'athena').issuers as Array<{ kind?: string }> | undefined) ?? [];
    const declared = c.classifications.filter((v) => (OUTSIDE_CLASSIFICATIONS as readonly string[]).includes(v));
    if (passed.some((e) => e.kind === 'guest')) {
      for (const v of OUTSIDE_CLASSIFICATIONS) if (!declared.includes(v)) errors.push(`${c.id} passes a guest issuer and does not declare ${v}`);
    } else if (declared.length) {
      errors.push(`${c.id} declares ${declared.join(', ')} with no guest issuer passed`);
    }
  }
  return errors;
}

describe('the outside-classification rule can fail', () => {
  it('refuses a guest issuer passed without guest and customer declared', () => {
    const withGuest: Configuration = {
      ...configuration('C1-headless'),
      id: 'falsified',
      issuers: [...configuration('C1-headless').issuers, { id: 'guest', kind: 'guest', entry: { id: 'guest', kind: 'guest' } }],
    };
    expect(outsideDeclarationErrors([withGuest])).toEqual(['falsified passes a guest issuer and does not declare guest', 'falsified passes a guest issuer and does not declare customer']);
  });
});

/* ─── falsification: each check fails on the shape it exists to refuse ──────────────────────── */

const lambda = (env: Record<string, string>) => ({
  Type: 'AWS::Lambda::Function',
  Properties: { Handler: 'index.handler', Environment: { Variables: env } },
});

function app(deps: Record<string, string[]>, templates: Synthesized['templates'] = {}): Synthesized {
  const all: Synthesized['templates'] = {};
  for (const s of Object.keys(deps)) all[s] = templates[s] ?? { Resources: {} };
  return { templates: all, dependencies: deps };
}

const CORE_DEPS: Record<string, string[]> = Object.fromEntries(CORE_STACKS.map((s) => [s, []]));

describe('the component rule refuses each shape it names', () => {
  // The rule over the whole admin backend: AdminServices and AdminApi.
  const rule = componentRuleViolations;

  it('passes a layout that keeps it, the admin backend on a capability it administers included', () => {
    expect(rule(app({
      ...CORE_DEPS,
      'Assistants-basic': ['Identity'],
      ChatApp: ['PersonApi'],
      Experiments: [],
      AdminServices: ['Assistants-basic', 'Experiments'],
      AdminApi: ['AdminServices'],
      AdminApp: ['AdminApi'],
    }))).toEqual([]);
  });

  it('refuses an admin backend that is partly present, and the console without all of it', () => {
    expect(rule(app({ ...CORE_DEPS, AdminServices: [], AdminApp: ['AdminServices'] }))).toEqual([
      'the admin backend is partly present: AdminServices without the rest',
      'AdminApp is present without the admin backend',
    ]);
  });

  it('refuses a core stack that depends on the admin backend or an interface stack', () => {
    expect(rule(app({ ...CORE_DEPS, 'Assistants-basic': ['AdminServices'], AdminServices: [], AdminApi: [] })))
      .toEqual(['core stack Assistants-basic depends on AdminServices']);
    expect(rule(app({ ...CORE_DEPS, PersonApi: ['Widget'], Widget: [] })))
      .toEqual(['core stack PersonApi depends on Widget']);
  });

  it('refuses a chat app that needs more than the core', () => {
    expect(rule(app({ ...CORE_DEPS, ChatApp: ['Battle'], Battle: [] })))
      .toEqual(['ChatApp depends on Battle, which is not in the core']);
  });

  it('refuses half an admin backend, and an admin console without one', () => {
    expect(rule(app({ ...CORE_DEPS, AdminServices: [] })))
      .toEqual(['the admin backend is partly present: AdminServices without the rest']);
    expect(rule(app({ ...CORE_DEPS, AdminApp: [] })))
      .toEqual(['AdminApp is present without the admin backend']);
  });

  it('refuses an admin backend that depends on an interface stack', () => {
    expect(rule(app({ ...CORE_DEPS, AdminServices: ['ChatApp'], AdminApi: [], ChatApp: [] })))
      .toEqual(['admin backend stack AdminServices depends on ChatApp, which is an interface stack']);
  });
});

describe('additivity refuses each change outside an attach point', () => {
  const before = app({ Archive: [], 'Assistants-basic': [], Identity: [], ChannelFlow: [] }, {
    Archive: { Resources: { Table: { Type: 'AWS::DynamoDB::Table', Properties: { BillingMode: 'PAY_PER_REQUEST' } } } },
    'Assistants-basic': { Resources: { Router: lambda({ A: '1' }), Role: { Type: 'AWS::IAM::Role', Properties: { P: 'x' } } } },
    Identity: { Resources: { Exchange: lambda({}) } },
    ChannelFlow: { Resources: { Flow: lambda({}) } },
  });

  it('classifies the attach points', () => {
    expect(attachKindOf('PersonApi')).toBe('any');
    expect(attachKindOf('Widget')).toBe('any');
    expect(attachKindOf('Identity')).toBe('add-only');
    expect(attachKindOf('Assistants-guest')).toBe('env-and-add');
    expect(attachKindOf('ChannelFlow')).toBe('env-only');
    expect(attachKindOf('Conversations')).toBe('env-only');
    expect(attachKindOf('Archive')).toBe('none');
  });

  it('passes an environment change in an assistant stack and an added issuer resource in Identity', () => {
    const after = app({ Archive: [], 'Assistants-basic': [], Identity: [], ChannelFlow: [], Battle: [] }, {
      Archive: before.templates.Archive,
      // A classification's part in the capability: its grant in a policy of its own, and the capability's names in its environment.
      'Assistants-basic': { Resources: { Router: lambda({ A: '1', BATTLE: 'on' }), Role: before.templates['Assistants-basic'].Resources!.Role, Grant: { Type: 'AWS::IAM::Policy' } } },
      Identity: { Resources: { Exchange: lambda({ ISSUERS: 'x' }), Pool: { Type: 'AWS::Cognito::UserPool' } } },
      ChannelFlow: { Resources: { Flow: lambda({ BATTLE: 'on' }) } },
    });
    expect(additivityViolations(before, after)).toEqual([]);
  });

  it('reads a nested stack\'s template as its parent stack, by the longest name it starts with', () => {
    const stacks = ['Archive', 'AdminServices', 'Admin', 'AdminServicesAnalytics24C58F9D.nested'];
    expect(owningStackOf('AdminServicesAnalytics24C58F9D.nested', stacks)).toBe('AdminServices');
    expect(owningStackOf('Archive', stacks)).toBe('Archive');
    expect(owningStackOf('OrphanABCDEF12.nested', stacks)).toBe('OrphanABCDEF12.nested');
    // A nested stack of an add-only parent may gain a grant on an existing role; one of a none parent may not.
    const nestedBefore = app({ AdminServices: [], 'AdminServicesAnalytics24C58F9D.nested': [], Archive: [], 'ArchiveInner12345678.nested': [] }, {
      'AdminServicesAnalytics24C58F9D.nested': { Resources: { Fn: lambda({}) } },
      'ArchiveInner12345678.nested': { Resources: { Fn: lambda({}) } },
    });
    const nestedAfter = app({ AdminServices: [], 'AdminServicesAnalytics24C58F9D.nested': [], Archive: [], 'ArchiveInner12345678.nested': [] }, {
      'AdminServicesAnalytics24C58F9D.nested': { Resources: { Fn: lambda({ EXPERIMENTS_TABLE: 'x' }), Grant: { Type: 'AWS::IAM::Policy' } } },
      'ArchiveInner12345678.nested': { Resources: { Fn: lambda({ EXPERIMENTS_TABLE: 'x' }) } },
    });
    expect(additivityViolations(nestedBefore, nestedAfter)).toEqual(['ArchiveInner12345678.nested changed, and it is not an attach point']);
  });

  it('refuses a change to a stack that is not an attach point, a grant in an env-only stack, a changed resource in the stack of a classification, and a removed stack', () => {
    const after = app({ Archive: [], 'Assistants-basic': [], ChannelFlow: [] }, {
      Archive: { Resources: { Table: { Type: 'AWS::DynamoDB::Table', Properties: { BillingMode: 'PROVISIONED' } } } },
      'Assistants-basic': { Resources: { Router: lambda({ A: '1' }), Role: { Type: 'AWS::IAM::Role', Properties: { P: 'y' } } } },
      ChannelFlow: { Resources: { Flow: lambda({}), Grant: { Type: 'AWS::IAM::Policy' } } },
    });
    expect(additivityViolations(before, after)).toEqual([
      'Archive changed, and it is not an attach point',
      'Assistants-basic: Role (AWS::IAM::Role) changes beyond its environment',
      'Identity is gone: a capability added must never remove a stack',
      'ChannelFlow: Grant (AWS::IAM::Policy) is added, and this stack may change only its environment',
    ]);
  });
});

describe('the SSM-edge checks refuse a read of a parameter a later stack publishes', () => {
  const param = (name: string) => ({ Type: 'AWS::SSM::Parameter::Value<String>', Default: name });
  const writer = (name: string) => ({ Resources: { P: { Type: 'AWS::SSM::Parameter', Properties: { Name: name } } } });

  it('refuses a reader that does not deploy after the writer', () => {
    const name = '/agent-echelon/assistant/basic/router-arn';
    const bad = app({ Conversations: [], 'Assistants-basic': [] }, {
      Conversations: { Parameters: { R: param(name) }, Resources: {} },
      'Assistants-basic': writer(name),
    });
    expect(ssmEdgeViolations(bad)).toEqual([`Conversations resolves ${name}, published by Assistants-basic`]);
    expect(assistantParameterViolations(bad)).toEqual([`Conversations resolves ${name}`]);
    const good = app({ Conversations: ['Assistants-basic'], 'Assistants-basic': [] }, bad.templates);
    expect(ssmEdgeViolations(good)).toEqual([]);
    expect(assistantParameterViolations(good)).toEqual([]);
  });
});

describe('the classification-independence check refuses each coupling it names', () => {
  const tpl = (resources: Record<string, unknown>, outputs: Record<string, unknown> = {}) => ({ Resources: resources as never, Outputs: outputs });
  const without = app({ Conversations: [], 'Assistants-legal': [] }, {
    Conversations: tpl({ Fn: lambda({ A: '1' }), Grant: { Type: 'AWS::IAM::Policy', Properties: { P: ['legal'] } } }),
    'Assistants-legal': tpl({ Router: lambda({}) }),
  });

  it('passes a classification whose stack is all that differs, and a cross-stack export it reads', () => {
    const withIt = app({ Conversations: [], 'Assistants-legal': [], 'Assistants-enterprise': ['Conversations'] }, {
      Conversations: tpl(without.templates.Conversations.Resources as never, { E: { Export: { Name: 'Conversations:ExportsOutputRefX' } } }),
      'Assistants-legal': without.templates['Assistants-legal'],
      'Assistants-enterprise': tpl({ Router: lambda({ ANYTHING: 'x' }), Role: { Type: 'AWS::IAM::Role' } }),
    });
    expect(classificationIndependenceViolations(without, withIt, 'enterprise')).toEqual([]);
    expect(classificationIndependenceViolations(withIt, without, 'enterprise')).toEqual([]);
  });

  it('names a changed grant, an environment variable, an added resource and a stack that deploys after it, in either direction', () => {
    const withIt = app({ Conversations: ['Assistants-enterprise'], 'Assistants-legal': [], 'Assistants-enterprise': [] }, {
      Conversations: tpl({
        Fn: lambda({ A: '1', ENTERPRISE_ROUTER_ARN: 'arn' }),
        Grant: { Type: 'AWS::IAM::Policy', Properties: { P: ['legal', 'enterprise'] } },
        RoleEnterprise: { Type: 'AWS::IAM::Role' },
      }),
      'Assistants-legal': without.templates['Assistants-legal'],
      'Assistants-enterprise': tpl({}),
    });
    const expected = [
      'Conversations: Grant (AWS::IAM::Policy) differs',
      'Conversations: RoleEnterprise (AWS::IAM::Role) exists on one side only',
      'Conversations: deploys after Assistants-enterprise',
      'Conversations: environment ENTERPRISE_ROUTER_ARN',
    ];
    expect(classificationIndependenceViolations(without, withIt, 'enterprise')).toEqual(expected);
    expect(classificationIndependenceViolations(withIt, without, 'enterprise')).toEqual(expected);
  });
});
