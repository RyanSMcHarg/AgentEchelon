/**
 * THE CORE DEPENDS ON NOTHING OPTIONAL, AND AN ABSENT CAPABILITY IS OFF, NEVER BROKEN (CONTRIBUTING, "Deploy only what
 * you declare", rules 1 to 3).
 *
 * The core alone names no resource of `battle` or `notifications`: no table, parameter, function or alarm of theirs, in
 * any environment variable or grant. Declared, each reaches the core only at its attach points in
 * `lib/config/capabilities.ts`, and the code that reads an attach point makes no call when it is absent.
 */
import { CAPABILITY_RESOURCES, SHARED_SSM } from '../lib/stacks/agent-classification-common';
import { storeNamesReader } from '../lambda/src/lib/offboarding';
import { invokeTransactionalMail } from '../lambda/src/lib/transactional-mail';
import { ANALYTICS_MODES, CONFIGURATIONS } from './deploy-matrix/configurations';
import { synthesize, type Synthesized } from './deploy-matrix/matrix';

const configuration = (id: string) => {
  const found = CONFIGURATIONS.find((c) => c.id === id);
  if (!found) throw new Error(`no configuration ${id}`);
  return found;
};

/** Every string a stack's template holds, keys included, with where it sits. */
function stringsOf(app: Synthesized): { stack: string; at: string; value: string }[] {
  const out: { stack: string; at: string; value: string }[] = [];
  const walk = (stack: string, v: unknown, at: string): void => {
    if (typeof v === 'string') { out.push({ stack, at, value: v }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(stack, x, `${at}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) { out.push({ stack, at, value: k }); walk(stack, x, `${at}.${k}`); }
    }
  };
  for (const [stack, template] of Object.entries(app.templates)) walk(stack, template, '');
  return out;
}

/** What names a resource `battle` or `notifications` owns, as a core template would spell it. */
const BATTLE_NAMES = [
  'AgentEchelonBattle',
  CAPABILITY_RESOURCES.battleStateTable,
  CAPABILITY_RESOURCES.channelBattleConfigTable,
  CAPABILITY_RESOURCES.battleOutcomeTable,
  CAPABILITY_RESOURCES.battleOrchestrator,
  SHARED_SSM.channelBattleConfigName,
  '/battle/*/enabled',
  'BATTLE_STATE_TABLE',
  'CHANNEL_BATTLE_CONFIG_TABLE',
  'CHANNEL_BATTLE_CONFIG_NAME_PARAM',
];
const NOTIFICATIONS_NAMES = [
  'AgentEchelonNotifications',
  CAPABILITY_RESOURCES.transactionalMail,
  'TRANSACTIONAL_MAIL_FUNCTION',
];

describe.each(ANALYTICS_MODES)('the core alone names no undeclared capability (%s)', (mode) => {
  let strings: ReturnType<typeof stringsOf>;
  beforeAll(() => { strings = stringsOf(synthesize(configuration('C1-headless'), mode)); });

  it.each([
    ['battle', BATTLE_NAMES],
    ['notifications', NOTIFICATIONS_NAMES],
  ])('names no %s resource in any core template', (_capability, names) => {
    const hits = strings.filter((s) => names.some((n) => s.value.includes(n))).map((s) => `${s.stack} ${s.at}: ${s.value.slice(0, 160)}`);
    expect(hits).toEqual([]);
  });
});

describe('declared, battle and notifications reach the core at their attach points', () => {
  let app: Synthesized;
  beforeAll(() => { app = synthesize(configuration('C-example'), 'athena'); });

  const fnEnv = (stack: string, has: string): Record<string, unknown>[] => Object.values(app.templates[stack].Resources ?? {})
    .filter((r) => r.Type === 'AWS::Lambda::Function')
    .map((r) => ((r.Properties as { Environment?: { Variables?: Record<string, unknown> } })?.Environment?.Variables ?? {}))
    .filter((v) => has in v);

  it('offboarding is told the battle-setting table parameter and may read it', () => {
    expect(fnEnv('Identity', 'CHANNEL_BATTLE_CONFIG_NAME_PARAM')).toHaveLength(1);
    expect(JSON.stringify(app.templates.Identity.Resources)).toContain(`parameter${SHARED_SSM.channelBattleConfigName}`);
  });

  it('the operator\'s battle setting is read by the channel flow on the Battle stack\'s grant, never on its own', () => {
    expect(JSON.stringify(app.templates.ChannelFlow)).not.toContain('/battle/*/enabled');
    const onTheFlow = Object.entries(app.templates.Battle.Resources ?? {}).find(([id]) => id.startsWith('BattleOnTheChannelFlow'));
    expect(JSON.stringify(onTheFlow?.[1])).toContain('/battle/*/enabled');
  });

  it('the invitations function is named the mail sender', () => {
    // The guest-upgrade function, built where a guest issuer is declared, is named the same way (`nameTransactionalMail`).
    const [invitations] = fnEnv('Conversations', 'CREDENTIAL_EXCHANGE_FUNCTION');
    expect(invitations.TRANSACTIONAL_MAIL_FUNCTION).toBe(CAPABILITY_RESOURCES.transactionalMail);
    for (const env of fnEnv('Conversations', 'TRANSACTIONAL_MAIL_FUNCTION')) {
      expect(env.TRANSACTIONAL_MAIL_FUNCTION).toBe(CAPABILITY_RESOURCES.transactionalMail);
    }
  });
});

describe('an absent attach point makes no call and says nothing', () => {
  afterEach(() => jest.restoreAllMocks());

  it('offboarding with no battle store named reads no parameter for it', async () => {
    const send = jest.fn(async () => ({ Parameter: { Value: 'user-profile' } }));
    const stores = await storeNamesReader({ send } as never, { userProfile: '/ae/user-profile-name', battleConfig: undefined })();
    expect(stores).toEqual({ userProfile: 'user-profile' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a link with no mail sender named is answered as not emailed, with no invoke and no warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = process.env.TRANSACTIONAL_MAIL_FUNCTION;
    delete process.env.TRANSACTIONAL_MAIL_FUNCTION;
    const send = jest.fn();
    try {
      const sent = await invokeTransactionalMail({
        mail: 'invitation', personArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/a/user/p', address: 'a@example.com', name: 'A', channelArn: 'c', link: 'https://example.com/#i=x',
      }, { lambda: { send } as never });
      expect(sent).toBe(false);
    } finally {
      if (previous !== undefined) process.env.TRANSACTIONAL_MAIL_FUNCTION = previous;
    }
    expect(send).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
