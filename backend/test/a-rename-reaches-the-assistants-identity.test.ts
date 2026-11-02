/**
 * The half of a rename that lands on the `AppInstanceBot` (DESIGN-SEPARATE-ASSISTANTS section 3.0).
 *
 * A display name rides a profile version, so activating one changes what the console and analytics
 * call an assistant. What a person reads beside a message in the room is the `Name` on the identity,
 * and only `UpdateAppInstanceBot` changes that - so without this path a rename reached every reader
 * except the one everybody looks at.
 *
 * THE PROPERTIES PINNED HERE ARE THE ONES WHOSE ABSENCE IS SILENT. An applier that echoed a caller's
 * configuration would repoint the assistant's Amazon Lex wiring and look identical from the outside;
 * one that reported success on a function error would leave the room showing the old name while the
 * console said the rename landed.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockIdentitySend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-identity', () => {
  const cmd = (t: string) => jest.fn((input: unknown) => ({ __t: t, input }));
  return {
    ChimeSDKIdentityClient: jest.fn(() => ({ send: mockIdentitySend })),
    DescribeAppInstanceBotCommand: cmd('DescribeAppInstanceBot'),
    UpdateAppInstanceBotCommand: cmd('UpdateAppInstanceBot'),
  };
});

const mockParams = new Map<string, string>();
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return {
    ...actual,
    SSMClient: jest.fn(() => ({
      send: async (cmd: { input: { Name: string } }) => {
        const v = mockParams.get(cmd.input.Name);
        if (v === undefined) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
        return { Parameter: { Value: v } };
      },
    })),
  };
});

const BOT_ARN = 'arn:aws:chime:us-east-1:123456789012:app-instance/aaa/bot/bbb';
const LEX = {
  Lex: {
    LexBotAliasArn: 'arn:aws:lex:us-east-1:123456789012:bot-alias/ABC/DEF',
    LocaleId: 'en_US',
    WelcomeIntent: 'WelcomeIntent',
    InvokedBy: { StandardMessages: 'NONE', TargetedMessages: 'ALL' },
  },
};

/**
 * The applier, finding `analyst` through its directory entry as it finds every assistant (ADR-048, amended
 * 2026-10-23): declared or created in the console, every identity is the provisioner's.
 */
function loadHandler(entry: Record<string, unknown> | null = { classification: 'standard', role: 'primary', origin: 'declared', status: 'active', botArn: BOT_ARN, displayName: 'Analyst' }) {
  jest.resetModules();
  process.env.SSM_ROOT = '/ae';
  mockParams.clear();
  if (entry) mockParams.set('/ae/assistant-directory/analyst', JSON.stringify(entry));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../lambda/src/apply-assistant-name').handler;
}

/** The identity as the service reports it, with whatever name the test needs. */
function describesAs(name: string, metadata?: string) {
  mockIdentitySend.mockImplementation((cmd: any) => {
    if (cmd.__t === 'DescribeAppInstanceBot') {
      return Promise.resolve({ AppInstanceBot: { Name: name, Configuration: LEX, Metadata: metadata } });
    }
    return Promise.resolve({});
  });
}

describe('a rename reaches the assistant\'s identity', () => {
  beforeEach(() => {
    mockIdentitySend.mockReset();
  });

  it('renames the identity its directory entry names', async () => {
    describesAs('Analyst');
    const handler = loadHandler();
    const res = await handler({ assistant: 'analyst', displayName: 'Research Desk' });

    expect(res).toMatchObject({ applied: true, name: 'Research Desk', previous: 'Analyst' });
    const update = mockIdentitySend.mock.calls.map(([c]) => c).find((c: any) => c.__t === 'UpdateAppInstanceBot');
    expect(update.input.Name).toEqual('Research Desk');
    expect(update.input.AppInstanceBotArn).toEqual(BOT_ARN);
  });

  it('re-sends the configuration the identity ALREADY HAS, so a rename cannot repoint it', async () => {
    // THE SECURITY PROPERTY, and the reason this is a separate function from `manage-profiles`.
    // `UpdateAppInstanceBot` replaces the whole record, so a rename necessarily carries a
    // configuration. Reading it back means there is no parameter through which a caller can express
    // an opinion about the assistant's Amazon Lex wiring, and no second copy here to drift from what
    // the stack provisioned.
    describesAs('Analyst');
    const handler = loadHandler();
    await handler({ assistant: 'analyst', displayName: 'Research Desk' });

    const update = mockIdentitySend.mock.calls.map(([c]) => c).find((c: any) => c.__t === 'UpdateAppInstanceBot');
    expect(update.input.Configuration).toEqual(LEX);
  });

  it('NEVER CHANGES THE ARN: it updates the identity in place and cannot mint or destroy one', async () => {
    // THE PREMISE OF THE WHOLE DESIGN. The bot ARN is the durable identity - the assignment record
    // points at it, the slot's IAM policy names it literally, channel memberships are held by it, and
    // analytics attribute to it. A rename that replaced the identity instead of relabelling it would
    // orphan every one of those, and it would look like a successful rename from the outside.
    //
    // Asserted structurally rather than by inspection: the only commands this module can issue are
    // Describe and Update, both against the ARN it was deployed with. There is no create path and no
    // delete path to reach, so "the ARN is stable" is a property of what the file imports, not a
    // promise about how it is called.
    describesAs('Analyst');
    const handler = loadHandler();
    const res = await handler({ assistant: 'analyst', displayName: 'Research Desk' });

    const sent = mockIdentitySend.mock.calls.map(([c]: any[]) => c);
    expect(sent.map((c: any) => c.__t).sort()).toEqual(['DescribeAppInstanceBot', 'UpdateAppInstanceBot']);
    for (const c of sent) expect(c.input.AppInstanceBotArn).toEqual(BOT_ARN);
    // The result names no ARN at all, so no caller can be handed a new one to store.
    expect(Object.keys(res)).not.toContain('appInstanceBotArn');

    // The module does not even import the commands that would replace an identity.
    const src = fs.readFileSync(path.join(__dirname, '../lambda/src/apply-assistant-name.ts'), 'utf8');
    expect(src).not.toMatch(/CreateAppInstanceBotCommand|DeleteAppInstanceBotCommand/);
  });

  it('carries the metadata through, because the update REPLACES the record', async () => {
    // Every field this call omits is a field it erases. The first version sent a hardcoded '' on the
    // reasoning that the provisioner creates bots without metadata - true today, and it would make a
    // rename silently destructive the day anything writes it. Nobody debugging lost metadata would
    // suspect a rename.
    describesAs('Analyst', '{"owner":"research"}');
    const handler = loadHandler();
    await handler({ assistant: 'analyst', displayName: 'Research Desk' });

    const update = mockIdentitySend.mock.calls.map(([c]) => c).find((c: any) => c.__t === 'UpdateAppInstanceBot');
    expect(update.input.Metadata).toEqual('{"owner":"research"}');
  });

  it('puts the CONFIGURED name back when the version names nothing', async () => {
    // "Absent means inherit the profile default" is what the resolver and the console both say, and
    // the identity did not honor it: an activation with no name did nothing, so an assistant renamed
    // once kept the custom name forever while the console read "inherits the provisioned name".
    // Clearing a name is a real operation, and this is where it lands.
    describesAs('E2E Renamed');
    const handler = loadHandler();
    const res = await handler({ assistant: 'analyst' });

    expect(res).toMatchObject({ applied: true, name: 'Analyst', previous: 'E2E Renamed' });
    const update = mockIdentitySend.mock.calls.map(([c]) => c).find((c: any) => c.__t === 'UpdateAppInstanceBot');
    expect(update.input.Name).toEqual('Analyst');
  });

  it('refuses an assistant with no active identity, and touches none', async () => {
    // Defense in depth against a caller that asked about the wrong name: the directory is the one place an
    // identity is found, so a name it does not hold renames nothing.
    describesAs('Analyst');
    const handler = loadHandler();
    const res = await handler({ assistant: 'advisor', displayName: 'Research Desk' });

    expect(res.applied).toBe(false);
    expect(res.error).toMatch(/'advisor' has no active identity/);
    expect(mockIdentitySend).not.toHaveBeenCalled();
  });

  it('refuses a name the identity would refuse, before calling it', async () => {
    describesAs('Analyst');
    const handler = loadHandler();
    expect((await handler({ assistant: 'analyst', displayName: '' })).applied).toBe(false);
    expect((await handler({ assistant: 'analyst', displayName: 'x'.repeat(101) })).error).toMatch(/caps at 100/);
    expect(mockIdentitySend).not.toHaveBeenCalled();
  });

  it('reports a no-op distinctly from a rename', async () => {
    // Re-running an activation must not read as having renamed something.
    describesAs('Analyst');
    const handler = loadHandler();
    const res = await handler({ assistant: 'analyst', displayName: 'Analyst' });

    expect(res).toMatchObject({ applied: false, name: 'Analyst' });
    expect(mockIdentitySend.mock.calls.some(([c]: any[]) => c.__t === 'UpdateAppInstanceBot')).toBe(false);
  });

  it('refuses rather than inventing a configuration when the identity reports none', async () => {
    // The only way to proceed without one is to make one up, and an invented configuration is the
    // repointing this function exists not to do.
    mockIdentitySend.mockResolvedValue({ AppInstanceBot: { Name: 'Analyst' } });
    const handler = loadHandler();
    const res = await handler({ assistant: 'analyst', displayName: 'Research Desk' });

    expect(res.applied).toBe(false);
    expect(res.error).toMatch(/no configuration/);
    expect(mockIdentitySend.mock.calls.some(([c]: any[]) => c.__t === 'UpdateAppInstanceBot')).toBe(false);
  });

  it('says so when the entry records no identity yet, rather than renaming nothing quietly', async () => {
    const handler = loadHandler({ classification: 'standard', role: 'primary', status: 'provisioning' });
    const res = await handler({ assistant: 'analyst', displayName: 'Research Desk' });

    expect(res).toMatchObject({ applied: false });
    expect(res.error).toMatch(/no active identity/);
  });
});
