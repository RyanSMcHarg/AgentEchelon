/**
 * A DEPLOY SEEDS ITS DECLARED ASSISTANTS ONCE, AND A ROLE IS SEPARATE FROM THE ASSISTANTS FILLING IT
 * (ADR-048, amended 2026-10-24).
 *
 * What the provisioner does with a declaration (`lambda/src/lib/declared-assistants.ts`): it builds each declared
 * assistant when no directory entry names it, leaves an active one alone, leaves one retired in the console retired
 * (and says so), refuses a name the console created, refuses to withdraw a role while any assistant still fills it,
 * releases a withdrawn role's declared assistant once it is retired so a later declaration seeds it afresh, removes
 * a duel's alt with its duel, refuses a classification's removal while a console-created assistant is active in it,
 * and answers the primary's identity. The build itself (`assistant-provisioner.ts`) is stubbed, so what is pinned is
 * these decisions.
 */
const mockBuild = jest.fn();
const mockRemove = jest.fn();
jest.mock('../lambda/src/lib/assistant-provisioner', () => ({
  // The identity rename runs as written, against the stubbed identity client each test hands it.
  ...jest.requireActual('../lambda/src/lib/assistant-provisioner'),
  buildIdentity: (...args: unknown[]) => mockBuild(...args),
  removeBuilt: (...args: unknown[]) => mockRemove(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require('../lambda/src/lib/declared-assistants') as typeof import('../lambda/src/lib/declared-assistants');
const { seed, withdrawnAlts, withdrawnRoles, lexBotNameOf, assistantsFilling } = lib;
type Declaration = import('../lambda/src/lib/declared-assistants').Declaration;
type SeedRequest = import('../lambda/src/lib/declared-assistants').SeedRequest;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { displayNameLockParamName } = require('../lambda/src/lib/runtime-directory') as typeof import('../lambda/src/lib/runtime-directory');

const ROOT = '/ae';
const params = new Map<string, string>();
const ssm = {
  send: async (cmd: { constructor: { name: string }; input: { Name: string; Value?: string; Overwrite?: boolean; Path?: string } }) => {
    const { Name, Value, Overwrite, Path } = cmd.input;
    switch (cmd.constructor.name) {
      case 'GetParameterCommand': {
        const v = params.get(Name);
        if (v === undefined) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
        return { Parameter: { Value: v } };
      }
      case 'GetParametersByPathCommand':
        // Not recursive: the `_build` and `_name` locks below the directory are not listed.
        return { Parameters: [...params].filter(([k]) => k.startsWith(`${Path}/`) && !k.slice(Path!.length + 1).includes('/')).map(([N, V]) => ({ Name: N, Value: V })) };
      case 'PutParameterCommand':
        if (!Overwrite && params.has(Name)) throw Object.assign(new Error('exists'), { name: 'ParameterAlreadyExists' });
        params.set(Name, Value as string);
        return {};
      case 'DeleteParameterCommand':
        if (!params.delete(Name)) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
        return {};
      default:
        throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  },
};

const cfg = (classification = 'premium') => ({
  ssm,
  clients: { identity: { send: jest.fn() }, lex: {} as never },
  invokeOwnership: jest.fn(async () => undefined),
  ssmRoot: ROOT, region: 'us-east-1', account: '123456789012',
  appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/ai',
  classification,
  fulfillmentArn: 'arn:aws:lambda:us-east-1:123456789012:function:AgentEchelonRouter',
  lexBotRoleArn: 'arn:aws:iam::123456789012:role/RuntimeAssistantLexBotRole',
  lexBotNamePrefix: 'agent-echelon',
  now: () => new Date('2026-10-23T12:00:00Z'),
});

const PREMIUM: Declaration = {
  classification: 'premium',
  roles: ['ops', 'primary'],
  assistants: [
    { assistantId: 'advisor', role: 'primary', occupancy: 'live', displayName: 'Advisor', welcome: true },
    { assistantId: 'alt-primary-premium', role: 'primary', occupancy: 'alt', displayName: 'Alt-premium-primary', welcome: false },
    { assistantId: 'ops-premium', role: 'ops', occupancy: 'live', displayName: 'Ops', welcome: true },
  ],
};
const withoutOps: Declaration = { ...PREMIUM, roles: ['primary'], assistants: PREMIUM.assistants.slice(0, 2) };

const event = (type: 'Create' | 'Update' | 'Delete', declaration: Declaration, before?: Declaration): SeedRequest => ({
  requestType: type,
  logicalResourceId: 'DeclaredAssistants',
  declaration,
  ...(before ? { oldDeclaration: before } : {}),
  ...(type !== 'Create' ? { physicalResourceId: 'declared-assistants-premium-DeclaredAssistants' } : {}),
});

const entry = (id: string) => (params.has(`${ROOT}/assistant-directory/${id}`) ? JSON.parse(params.get(`${ROOT}/assistant-directory/${id}`)!) : undefined);
const record = (path: string) => (params.has(`${ROOT}/assistant-assignments/${path}`) ? JSON.parse(params.get(`${ROOT}/assistant-assignments/${path}`)!) : undefined);
const retireInConsole = (id: string) => {
  params.set(`${ROOT}/assistant-directory/${id}`, JSON.stringify({ ...entry(id), status: 'retired', retiredBy: 'admin', reason: 'rehearsal' }));
  params.delete(`${ROOT}/assistant-assignments/premium/${entry(id).role}/assistants/${id}`);
};

beforeEach(() => {
  params.clear();
  mockBuild.mockReset().mockImplementation(async (_c: unknown, spec: { assistantId: string }, built: Record<string, string>) => {
    built.lexBotId = `LEX-${spec.assistantId}`;
    built.botArn = `arn:aws:chime:us-east-1:123456789012:app-instance/ai/bot/${spec.assistantId}`;
    return built;
  });
  mockRemove.mockReset().mockResolvedValue([]);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('a declared assistant with no entry is built by the provisioner', () => {
  it('builds each one with the provisioner stamp, writes its record and entry, and answers the primary', async () => {
    const out = await seed(cfg(), event('Create', PREMIUM)) as { PhysicalResourceId: string; Data: { PrimaryBotArn: string } };

    expect(mockBuild).toHaveBeenCalledTimes(3);
    expect(out.PhysicalResourceId).toBe('declared-assistants-premium-DeclaredAssistants');
    expect(out.Data.PrimaryBotArn).toMatch(/bot\/advisor$/);
    expect(entry('advisor')).toMatchObject({ origin: 'declared', status: 'active', classification: 'premium', role: 'primary', botArn: expect.stringMatching(/advisor$/) });
    expect(record('premium/primary/assistants/advisor')).toMatchObject({ occupancy: 'live', assistant: 'advisor', source: 'declared', status: 'active', lexBotId: 'LEX-advisor' });
    expect(record('premium/ops/assistants/ops-premium')).toMatchObject({ assistant: 'ops-premium', source: 'declared' });
    // A DUEL'S ALT answers through its role's alt record, with no occupant between battles.
    expect(record('premium/primary/alt')).toMatchObject({ occupancy: 'alt', assistant: null, botArn: expect.stringMatching(/alt-primary-premium$/) });
    expect(entry('alt-primary-premium')).toMatchObject({ origin: 'declared', occupancy: 'alt' });
    // The alt joins silently; the live assistants greet. Every bot runs as the provisioner's one Lex bot role.
    const specOf = (id: string) => mockBuild.mock.calls.find(([, s]) => s.assistantId === id)[1];
    expect(specOf('alt-primary-premium').welcome).toBe(false);
    expect(specOf('advisor')).toMatchObject({ welcome: true, lexBotRoleArn: expect.stringMatching(/RuntimeAssistantLexBotRole$/) });
    // No record at the retired `live` path.
    expect([...params.keys()].some((k) => k.endsWith('/live'))).toBe(false);
  });

  it('builds on the classification the stack serves and refuses a declaration for another', async () => {
    await expect(seed(cfg('standard'), event('Create', PREMIUM))).rejects.toThrow(/serves 'standard'/);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('removes what this run built when a later build fails, so a rollback leaves nothing undeclared', async () => {
    mockBuild.mockImplementation(async (_c: unknown, spec: { assistantId: string }, built: Record<string, string>) => {
      if (spec.assistantId === 'ops-premium') throw new Error('Lex said no');
      built.lexBotId = `LEX-${spec.assistantId}`;
      built.botArn = `bot/${spec.assistantId}`;
      return built;
    });
    await expect(seed(cfg(), event('Create', PREMIUM))).rejects.toThrow(/ops-premium' could not be built: Lex said no/);
    expect(entry('advisor')).toBeUndefined();
    expect(entry('ops-premium')).toBeUndefined();
    expect(record('premium/primary/assistants/advisor')).toBeUndefined();
  });

  it('names each Amazon Lex bot by instance and assistant, so two instances in one account never collide', () => {
    expect(lexBotNameOf('agent-echelon', 'ops-premium', new Date(0))).toBe('agent-echelon-ops-premium-0');
    expect(lexBotNameOf('ae--x', 'advisor', new Date(36))).toBe('ae-x-advisor-10');
  });
});

describe('seed once: an existing entry decides', () => {
  it('leaves an active one alone, so the console owns it from the first deploy on', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    mockBuild.mockClear();
    const out = await seed(cfg(), event('Update', PREMIUM, PREMIUM)) as { Data: { PrimaryBotArn: string; Summary: string } };
    expect(mockBuild).not.toHaveBeenCalled();
    expect(JSON.parse(out.Data.Summary)).toEqual({ advisor: 'present', 'alt-primary-premium': 'present', 'ops-premium': 'present' });
    expect(out.Data.PrimaryBotArn).toMatch(/advisor$/);
  });

  it('does NOT recreate one retired in the console, and reports it as declared but retired', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    retireInConsole('ops-premium');
    mockBuild.mockClear();
    const log = jest.spyOn(console, 'log');

    const out = await seed(cfg(), event('Update', PREMIUM, PREMIUM)) as { Data: { Summary: string } };

    expect(mockBuild).not.toHaveBeenCalled();
    expect(JSON.parse(out.Data.Summary)['ops-premium']).toBe('retired-in-console');
    expect(entry('ops-premium').status).toBe('retired');
    expect(log.mock.calls.some(([m]) => /ops-premium is declared, but retired in the console; a deploy does not recreate it/.test(String(m)))).toBe(true);
  });

  it('refuses to take over a name the console created', async () => {
    params.set(`${ROOT}/assistant-directory/ops-premium`, JSON.stringify({ classification: 'premium', role: 'ops', status: 'active', origin: 'console' }));
    await expect(seed(cfg(), event('Create', PREMIUM))).rejects.toThrow(/created in the console; a declaration cannot take its name/);
  });

  it('refuses a declared name seeded at another role, rather than moving it', async () => {
    params.set(`${ROOT}/assistant-directory/ops-premium`, JSON.stringify({ classification: 'premium', role: 'primary', status: 'active', origin: 'declared' }));
    await expect(seed(cfg(), event('Create', PREMIUM))).rejects.toThrow(/seeded at premium\/primary/);
  });

  it('removes a build that died and builds it again', async () => {
    params.set(`${ROOT}/assistant-directory/ops-premium`, JSON.stringify({
      classification: 'premium', role: 'ops', origin: 'declared', status: 'failed', lexBotId: 'OLD', botArn: 'bot/old',
    }));
    const out = await seed(cfg(), event('Create', PREMIUM)) as { Data: { Summary: string } };
    expect(mockRemove).toHaveBeenCalledWith(expect.anything(), expect.any(String), { botArn: 'bot/old', lexBotId: 'OLD' });
    expect(JSON.parse(out.Data.Summary)['ops-premium']).toBe('rebuilt');
    expect(entry('ops-premium')).toMatchObject({ status: 'active', lexBotId: 'LEX-ops-premium' });
  });
});

describe('a role and the assistants filling it are separate', () => {
  it('REFUSES to withdraw a role while its declared assistant is active, naming it, and removes nothing', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    mockRemove.mockClear();
    await expect(seed(cfg(), event('Update', withoutOps, PREMIUM)))
      .rejects.toThrow(/the ops role cannot be withdrawn from premium while an assistant fills it: ops-premium\. .*retire it in the console first/);
    expect(mockRemove).not.toHaveBeenCalled();
    expect(entry('ops-premium').status).toBe('active');
    expect(record('premium/ops/assistants/ops-premium')).toBeDefined();
  });

  it('REFUSES while a console-created assistant fills the role, naming every one', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    retireInConsole('ops-premium');
    params.set(`${ROOT}/assistant-directory/sentinel`, JSON.stringify({ classification: 'premium', role: 'ops', status: 'active', origin: 'console' }));
    params.set(`${ROOT}/assistant-directory/watcher`, JSON.stringify({ classification: 'premium', role: 'ops', status: 'provisioning', createdAt: '2026-10-23T11:59:00Z' }));
    await expect(seed(cfg(), event('Update', withoutOps, PREMIUM)))
      .rejects.toThrow(/while assistants fill it: sentinel, watcher\. .*retire them in the console first/);
  });

  it('a retired assistant, a dead build and another role\'s assistant do not fill it', () => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    const directory = new Map<string, any>([
      ['ops-premium', { classification: 'premium', role: 'ops', status: 'retired', origin: 'declared' }],
      ['died', { classification: 'premium', role: 'ops', status: 'provisioning', createdAt: '2026-10-23T10:00:00Z' }],
      ['other', { classification: 'premium', role: 'primary', status: 'active' }],
      ['elsewhere', { classification: 'standard', role: 'ops', status: 'active' }],
      ['alt', { classification: 'premium', role: 'ops', status: 'active', occupancy: 'alt' }],
    ]);
    expect(assistantsFilling(directory, 'premium', 'ops', now)).toEqual([]);
  });

  it('once the declared assistant is retired in the console, the withdrawal RELEASES it, so declaring the role again seeds it afresh', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    retireInConsole('ops-premium');
    // The display-name lock was released at retire; a tombstone remains.
    mockRemove.mockClear();
    await seed(cfg(), event('Update', withoutOps, PREMIUM));

    // The retire removed the identity and the Lex bot, so the release asks to delete neither again.
    expect(mockRemove).toHaveBeenCalledWith(expect.anything(), expect.any(String), {});
    expect(entry('ops-premium')).toBeUndefined();
    expect(entry('advisor').status).toBe('active');

    mockBuild.mockClear();
    const out = await seed(cfg(), event('Update', PREMIUM, withoutOps)) as { Data: { Summary: string } };
    expect(mockBuild.mock.calls.map(([, s]) => s.assistantId)).toEqual(['ops-premium']);
    expect(JSON.parse(out.Data.Summary)['ops-premium']).toBe('built');
    expect(entry('ops-premium')).toMatchObject({ status: 'active', origin: 'declared' });
  });

  it('a withdrawn role\'s release keeps what it could not remove on the entry instead of passing it off as gone', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    params.set(`${ROOT}/assistant-directory/ops-premium`, JSON.stringify({ ...entry('ops-premium'), status: 'retired', leftover: ['Lex bot LEX-ops-premium'] }));
    mockRemove.mockClear().mockResolvedValue(['Lex bot LEX-ops-premium']);
    await seed(cfg(), event('Update', withoutOps, PREMIUM));
    // Only what the retire left is tried again: the Lex bot, not the identity the retire removed.
    expect(mockRemove).toHaveBeenCalledWith(expect.anything(), expect.any(String), { lexBotId: 'LEX-ops-premium' });
    expect(entry('ops-premium')).toMatchObject({ status: 'failed', leftover: ['Lex bot LEX-ops-premium'] });
  });

  it('keeps one dropped from the declaration while its role stays: the console owns it', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    const opsUndeclared: Declaration = { ...PREMIUM, assistants: PREMIUM.assistants.slice(0, 2) };
    await seed(cfg(), event('Update', opsUndeclared, PREMIUM));
    expect(mockRemove).not.toHaveBeenCalled();
    expect(entry('ops-premium').status).toBe('active');
  });

  it('says which roles an update withdraws', () => {
    expect(withdrawnRoles(PREMIUM, withoutOps)).toEqual(['ops']);
    expect(withdrawnRoles(undefined, withoutOps)).toEqual([]);
    expect(withdrawnRoles(withoutOps, PREMIUM)).toEqual([]);
  });
});

describe("a duel's alt is removed with its duel", () => {
  it('when the duel is no longer wired', async () => {
    const noDuel: Declaration = { ...PREMIUM, assistants: PREMIUM.assistants.filter((a) => a.occupancy === 'live') };
    expect(withdrawnAlts(PREMIUM, noDuel).map((a) => a.assistantId)).toEqual(['alt-primary-premium']);
    await seed(cfg(), event('Create', PREMIUM));
    await seed(cfg(), event('Update', noDuel, PREMIUM));
    expect(entry('alt-primary-premium')).toBeUndefined();
    expect(record('premium/primary/alt')).toBeUndefined();
  });

  it("a delete of a declaration of alts alone is the duel withdrawn, never refused for the console's assistants", async () => {
    const alts: Declaration = { ...PREMIUM, assistants: PREMIUM.assistants.filter((a) => a.occupancy === 'alt') };
    await seed(cfg(), event('Create', alts));
    params.set(`${ROOT}/assistant-directory/sentinel`, JSON.stringify({ classification: 'premium', role: 'ops', status: 'active', origin: 'console' }));
    await seed(cfg(), event('Delete', alts));
    expect(entry('alt-primary-premium')).toBeUndefined();
    expect(entry('sentinel').status).toBe('active');
  });
});

describe("removing a classification (the seed's delete)", () => {
  it('removes every declared assistant, the retired ones included', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    retireInConsole('ops-premium');
    await seed(cfg(), event('Delete', PREMIUM));
    for (const id of ['advisor', 'ops-premium', 'alt-primary-premium']) expect(entry(id)).toBeUndefined();
    expect(record('premium/primary/alt')).toBeUndefined();
    expect(mockRemove).toHaveBeenCalledTimes(3);
  });

  it('NEVER FAILS the stack: an assistant created in the console still active in it is reported and left for the sweep', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    params.set(`${ROOT}/assistant-directory/sentinel`, JSON.stringify({ classification: 'premium', role: 'ops', status: 'active', origin: 'console' }));
    params.set(`${ROOT}/assistant-directory/finance`, JSON.stringify({ classification: 'premium', role: 'primary', status: 'active' }));
    params.set(`${ROOT}/assistant-directory/gone`, JSON.stringify({ classification: 'premium', role: 'primary', status: 'retired', origin: 'console' }));
    params.set(`${ROOT}/assistant-directory/basic-helper`, JSON.stringify({ classification: 'basic', role: 'primary', status: 'active', origin: 'console' }));
    const out = await seed(cfg(), event('Delete', PREMIUM)) as { Data: { Summary: string } };
    expect(JSON.parse(out.Data.Summary)).toEqual({ unremoved: {}, consoleCreatedStillActive: ['finance', 'sentinel'] });
    expect(entry('advisor')).toBeUndefined();
    expect(entry('sentinel').status).toBe('active');
  });

  it('never removes a console-created assistant, whatever the declaration says', async () => {
    params.set(`${ROOT}/assistant-directory/advisor`, JSON.stringify({ classification: 'premium', role: 'primary', status: 'retired', origin: 'console', botArn: 'bot/x' }));
    await seed(cfg(), event('Delete', PREMIUM));
    expect(entry('advisor').origin).toBe('console');
    expect(mockRemove).not.toHaveBeenCalled();
  });
});

describe("a declaration's new display name reaches the assistant it already seeded", () => {
  const LEX = { Lex: { LexBotAliasArn: 'arn:aws:lex:us-east-1:123456789012:bot-alias/LEX-advisor/TSTALIASID', InvokedBy: { StandardMessages: 'NONE', TargetedMessages: 'ALL' } } };
  const lockOf = (name: string) => displayNameLockParamName(ROOT, 'premium', name);
  const holderOf = (name: string) => (params.has(lockOf(name)) ? JSON.parse(params.get(lockOf(name))!).assistantId : undefined);
  const renamedTo = (name: string): Declaration => ({
    ...PREMIUM,
    assistants: PREMIUM.assistants.map((a) => (a.assistantId === 'advisor' ? { ...a, displayName: name } : a)),
  });
  /** The identity as Amazon Chime SDK answers for it, renamed in place by an update. */
  const identityShowing = (shown: string) => {
    let name = shown;
    return jest.fn(async (cmd: { constructor: { name: string }; input: { Name?: string } }) => {
      if (cmd.constructor.name === 'DescribeAppInstanceBotCommand') return { AppInstanceBot: { Name: name, Configuration: LEX, Metadata: 'kept' } };
      if (cmd.constructor.name === 'UpdateAppInstanceBotCommand') { name = cmd.input.Name!; return {}; }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
  };
  const sentOf = (send: jest.Mock, type: string) => send.mock.calls.map(([c]) => c).filter((c) => c.constructor.name === type);
  const withIdentity = (send: jest.Mock) => { const c = cfg(); c.clients.identity.send = send; return c; };

  it('renames the identity, the entry and the lock, and leaves the Lex bot, the record and the role as they were', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    const recordBefore = record('premium/primary/assistants/advisor');
    mockBuild.mockClear();
    const send = identityShowing('Advisor');

    const out = await seed(withIdentity(send), event('Update', renamedTo('Counsel'), PREMIUM)) as { Data: { PrimaryBotArn: string; Summary: string } };

    expect(JSON.parse(out.Data.Summary)).toEqual({ advisor: 'renamed', 'alt-primary-premium': 'present', 'ops-premium': 'present' });
    const [update] = sentOf(send, 'UpdateAppInstanceBotCommand');
    // The name and nothing else: the configuration and metadata the identity answered with are re-sent.
    expect(update.input).toEqual({ AppInstanceBotArn: expect.stringMatching(/bot\/advisor$/), Name: 'Counsel', Configuration: LEX, Metadata: 'kept' });
    expect(entry('advisor')).toMatchObject({ displayName: 'Counsel', status: 'active', lexBotId: 'LEX-advisor', role: 'primary' });
    expect(record('premium/primary/assistants/advisor')).toEqual(recordBefore);
    expect(holderOf('Counsel')).toBe('advisor');
    expect(mockBuild).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(out.Data.PrimaryBotArn).toMatch(/advisor$/);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"action":"renamed","assistant":"advisor","classification":"premium","from":"Advisor","to":"Counsel","identity":"renamed"'));
  });

  it('makes no call when the declared name is the one the entry holds, so a rerun of the rename does nothing', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    const send = identityShowing('Advisor');
    await seed(withIdentity(send), event('Update', renamedTo('Counsel'), PREMIUM));
    send.mockClear();
    const paramsBefore = new Map(params);

    const out = await seed(withIdentity(send), event('Update', renamedTo('Counsel'), PREMIUM)) as { Data: { Summary: string } };

    expect(send).not.toHaveBeenCalled();
    expect(new Map(params)).toEqual(paramsBefore);
    expect(JSON.parse(out.Data.Summary).advisor).toBe('present');
  });

  it('REFUSES a name another assistant shows in the classification, and changes nothing', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    const send = identityShowing('Advisor');

    await expect(seed(withIdentity(send), event('Update', renamedTo('Ops'), PREMIUM))).rejects.toThrow(/'advisor' is declared as 'Ops', which ops-premium shows in premium/);

    expect(send).not.toHaveBeenCalled();
    expect(entry('advisor').displayName).toBe('Advisor');
    expect(holderOf('Advisor')).toBe('advisor');
    expect(holderOf('Ops')).toBe('ops-premium');
  });

  it('releases the old name the assistant held, so another assistant may take it', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    expect(holderOf('Advisor')).toBe('advisor');

    await seed(withIdentity(identityShowing('Advisor')), event('Update', renamedTo('Counsel'), PREMIUM));

    expect(params.has(lockOf('Advisor'))).toBe(false);
    expect(holderOf('Counsel')).toBe('advisor');
  });

  it("leaves an identity a profile version named, whose name wins, and still records the declared one", async () => {
    await seed(cfg(), event('Create', PREMIUM));
    const send = identityShowing('Sage');

    await seed(withIdentity(send), event('Update', renamedTo('Counsel'), PREMIUM));

    expect(sentOf(send, 'UpdateAppInstanceBotCommand')).toEqual([]);
    expect(entry('advisor').displayName).toBe('Counsel');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"identity":"named-by-version"'));
  });

  it('releases the name it locked when the identity refuses the rename, so the rollback leaves it free', async () => {
    await seed(cfg(), event('Create', PREMIUM));
    const send = jest.fn(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'DescribeAppInstanceBotCommand') return { AppInstanceBot: { Name: 'Advisor', Configuration: LEX } };
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    });

    await expect(seed(withIdentity(send), event('Update', renamedTo('Counsel'), PREMIUM))).rejects.toThrow(/could not be renamed to 'Counsel': denied/);

    expect(params.has(lockOf('Counsel'))).toBe(false);
    expect(holderOf('Advisor')).toBe('advisor');
    expect(entry('advisor').displayName).toBe('Advisor');
  });
});
