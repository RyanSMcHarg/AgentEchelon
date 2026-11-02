/**
 * WHAT A TEARDOWN TAKES, AND WHAT IT REFUSES TO TAKE (`scripts/lib/teardown-plan.cjs`).
 *
 * The teardown deletes a whole instance in a shared account, so each decision it makes before it acts is
 * pinned here: the instance comes only from an explicit name, the default (dev) instance needs its flag,
 * an executing run names the account's other projects or declares there are none,
 * a stack is taken only by an exact name, an instance on the earlier layout is enumerated whole, stacks go
 * in export order, and a secret holding external API keys is never deleted.
 */
import { IMAGE_GEN_MODELS } from '../lambda/src/lib/image-gen-models';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plan = require('../scripts/lib/teardown-plan.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DEFAULT_INSTANCE, STACK_NAMES } = require('../scripts/lib/stack-lookup.cjs');

describe('the target', () => {
  it('refuses to run with no instance set', () => {
    expect(() => plan.teardownTarget({ env: {}, argv: [] })).toThrow(/No instance is set/);
    expect(() => plan.teardownTarget({ env: { AE_INSTANCE_NAME: '  ' }, argv: [] })).toThrow(/No instance is set/);
    // A prefix alone names no instance.
    expect(() => plan.teardownTarget({ env: { AE_STACK_PREFIX: 'AeNext' }, argv: [] })).toThrow(/No instance is set/);
  });

  it('refuses the default instance without --instance-is-dev, and takes it with the flag', () => {
    expect(() => plan.teardownTarget({ env: { AE_INSTANCE_NAME: DEFAULT_INSTANCE }, argv: ['--confirm'] })).toThrow(/--instance-is-dev/);
    expect(plan.teardownTarget({ env: { AE_INSTANCE_NAME: DEFAULT_INSTANCE }, argv: ['--instance-is-dev'] }))
      .toEqual({ instance: DEFAULT_INSTANCE, prefix: 'AgentEchelon', isDefault: true });
  });

  it('takes the target from the instance, and refuses variables or a prefix that disagree with it', () => {
    expect(plan.teardownTarget({ env: { AE_INSTANCE_NAME: 'ae-next' }, argv: [] })).toEqual({ instance: 'ae-next', prefix: 'AeNext', isDefault: false });
    expect(plan.teardownTarget({ env: { SSM_ROOT: '/ae-next' }, argv: [] }).instance).toBe('ae-next');
    expect(() => plan.teardownTarget({ env: { AE_INSTANCE_NAME: 'ae-next', E2E_INSTANCE_NAME: 'ae-scratch' }, argv: [] })).toThrow(/different instances/);
    expect(() => plan.teardownTarget({ env: { AE_INSTANCE_NAME: 'ae-next', AE_STACK_PREFIX: 'AgentEchelon' }, argv: [] })).toThrow(/not instance "ae-next"'s own prefix/);
    expect(() => plan.teardownTarget({ env: { AE_INSTANCE_NAME: 'Ae Next' }, argv: [] })).toThrow(/not an instance name/);
  });
});

describe('the other-project denylist', () => {
  it('refuses an executing run when AE_TEARDOWN_PROTECT is unset, and names both ways to set it', () => {
    for (const env of [{}, { AE_TEARDOWN_PROTECT: '' }, { AE_TEARDOWN_PROTECT: '   ' }]) {
      expect(() => plan.otherProjectsDenylist({ env, confirm: true })).toThrow(/AE_TEARDOWN_PROTECT is not set[\s\S]*Nothing was deleted[\s\S]*"none"/);
    }
  });

  it('plans a dry run with it unset, and returns the warning to print', () => {
    const out = plan.otherProjectsDenylist({ env: {}, confirm: false });
    expect(out.patterns).toEqual([]);
    expect(out.warning).toMatch(/AE_TEARDOWN_PROTECT is not set[\s\S]*--confirm is refused/);
  });

  it('takes `none` exactly as an empty list declared on purpose', () => {
    expect(plan.otherProjectsDenylist({ env: { AE_TEARDOWN_PROTECT: 'none' }, confirm: true }))
      .toEqual({ patterns: [], declaredNone: true });
    // Only the exact word: anything else is a pattern.
    expect(plan.otherProjectsDenylist({ env: { AE_TEARDOWN_PROTECT: 'None' }, confirm: true }).patterns).toHaveLength(1);
  });

  it('parses comma-separated patterns, case-insensitively, and refuses one that is not a regular expression', () => {
    const { patterns, warning } = plan.otherProjectsDenylist({ env: { AE_TEARDOWN_PROTECT: 'billing, crm-?app ,' }, confirm: true });
    expect(warning).toBeUndefined();
    expect(patterns.map(String)).toEqual(['/billing/i', '/crm-?app/i']);
    expect(patterns[1].test('CrmApp-Data')).toBe(true);
    expect(patterns.some((re: RegExp) => re.test('AeNextMessaging'))).toBe(false);
    expect(() => plan.otherProjectsDenylist({ env: { AE_TEARDOWN_PROTECT: 'billing,(' }, confirm: true })).toThrow(/is not a regular expression/);
  });

  it('the teardown reads the list from this decision before it reads the account', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'teardown.mjs'), 'utf8');
    const decided = src.indexOf('plan.otherProjectsDenylist(');
    expect(decided).toBeGreaterThan(0);
    expect(decided).toBeLessThan(src.indexOf('standingStacks();'));
    expect(src).not.toMatch(/process\.env\.AE_TEARDOWN_PROTECT/);
  });
});

describe('the stacks', () => {
  it('matches exactly, never a longer prefix or a nested stack', () => {
    expect(plan.isTeardownStack('AeNextMessaging', 'AeNext')).toBe(true);
    expect(plan.isTeardownStack('AeNextAssistants-basic', 'AeNext')).toBe(true);
    expect(plan.isTeardownStack('AeNextImageGuardrail-us-west-2', 'AeNext')).toBe(true);
    // Another instance whose prefix starts with this one's.
    expect(plan.isTeardownStack('AeNextC0Messaging', 'AeNext')).toBe(false);
    expect(plan.isTeardownStack('AeNextC0Assistants-guest', 'AeNext')).toBe(false);
    // A nested stack goes with its parent and is never deleted on its own.
    expect(plan.isTeardownStack('AeNextAdminServices-AnalyticsNestedStackAnalyticsNestedStackResource-1ABC', 'AeNext')).toBe(false);
    // Another app entirely.
    expect(plan.isTeardownStack('OtherAppMessaging', 'AeNext')).toBe(false);
    expect(plan.isTeardownStack('AeNextSomethingElse', 'AeNext')).toBe(false);
    expect(plan.isTeardownStack('AeNextMessaging', '')).toBe(false);
  });

  it('enumerates an instance on the earlier layout and the current one alike, from a listing fixture', () => {
    const listing = [
      // The earlier layout (retired names).
      ...['ChimeMessaging', 'CognitoAuth', 'Foundations', 'S3Storage', 'Analytics', 'AnalyticsAurora', 'AdminPlane',
        'AdminNotification', 'Frontend', 'AdminFrontend', 'Classification-Basic', 'Classification-Premium', 'Tier-Standard']
        .map((n) => ({ name: `AgentEchelon${n}`, region: 'us-east-1' })),
      // The current layout.
      ...['Messaging', 'Identity', 'Conversations', 'Archive', 'ChannelFlow', 'PostProcessing', 'PersonApi', 'AdminServices',
        'AdminApi', 'AdminApp', 'ChatApp', 'Notifications', 'Operations', 'Battle', 'Experiments', 'TestInbox', 'TestIssuer',
        'Assistants-basic', 'Assistants-guest']
        .map((n) => ({ name: `AgentEchelon${n}`, region: 'us-east-1' })),
      { name: 'AgentEchelonImageGuardrail-us-west-2', region: 'us-west-2' },
      // Not this instance's.
      { name: 'AgentEchelonTwoMessaging', region: 'us-east-1' },
      { name: 'BillingApi', region: 'us-east-1' },
      { name: 'AgentEchelonCognitoAuth-NestedStackResource-XYZ', region: 'us-east-1' },
    ];
    const { stacks, retired } = plan.instanceStacks(listing, 'AgentEchelon');
    expect(stacks).toHaveLength(13 + 19 + 1);
    expect(retired.map((s: { name: string }) => s.name).sort()).toEqual(listing.slice(0, 13).map((s) => s.name).sort());
    expect(stacks.map((s: { name: string }) => s.name)).not.toContain('AgentEchelonTwoMessaging');
  });

  it('lists every region an image model is pinned to, so a cross-region stack is never missed', () => {
    const pinned = [...new Set(Object.values(IMAGE_GEN_MODELS)
      .filter((m) => m.lifecycle === 'active' && m.hosting === 'aws-bedrock' && m.region)
      .map((m) => m.region as string))].sort();
    expect([...STACK_NAMES.crossRegions].sort()).toEqual(pinned);
    expect(plan.teardownRegions('us-east-1')).toEqual(['us-east-1', ...pinned.filter((r) => r !== 'us-east-1')]);
  });

  it('deletes importers before exporters, and other regions last', () => {
    const stacks = [
      { name: 'AMessaging', region: 'us-east-1' },
      { name: 'AIdentity', region: 'us-east-1' },
      { name: 'AConversations', region: 'us-east-1' },
      { name: 'AAssistants-basic', region: 'us-east-1' },
      { name: 'AImageGuardrail-us-west-2', region: 'us-west-2' },
    ];
    const imports = {
      AMessaging: ['AIdentity', 'AConversations'],
      AIdentity: ['AConversations'],
      AConversations: ['AAssistants-basic'],
    };
    const rounds = plan.deletionRounds(stacks, imports, 'us-east-1').map((r: Array<{ name: string }>) => r.map((s) => s.name));
    expect(rounds).toEqual([['AAssistants-basic'], ['AConversations'], ['AIdentity'], ['AMessaging'], ['AImageGuardrail-us-west-2']]);
  });

  it('refuses an export another app imports, and a cycle', () => {
    const stacks = [{ name: 'AMessaging', region: 'us-east-1' }, { name: 'AIdentity', region: 'us-east-1' }];
    expect(() => plan.deletionRounds(stacks, { AMessaging: ['SomeoneElse'] }, 'us-east-1')).toThrow(/SomeoneElse imports from AMessaging/);
    expect(() => plan.deletionRounds(stacks, { AMessaging: ['AIdentity'], AIdentity: ['AMessaging'] }, 'us-east-1')).toThrow(/cycle/);
  });
});

describe('the retained resources', () => {
  const instance = 'ae-next';
  const stackNames = plan.knownStackNames('AeNext', ['AeNextAssistants-basic']);
  const select = (inventory: unknown[], keepArchives = false) => plan.selectRetained({ inventory, instance, stackNames, keepArchives });

  it('takes what the Instance tag names, and what an untagged name says is this instance', () => {
    const { purge } = select([
      { kind: 'table', id: 'AeNextIdentity-IdentitiesTable1A2B-XYZ', name: 'AeNextIdentity-IdentitiesTable1A2B-XYZ', instanceTag: null },
      { kind: 'table', id: 'AeNextIdentity-TokensTable9C8D-XYZ', name: 'AeNextIdentity-TokensTable9C8D-XYZ', instanceTag: 'ae-next' },
      { kind: 'table', id: 'AeNextCognitoAuth-UserTasks-XYZ', name: 'AeNextCognitoAuth-UserTasks-XYZ', instanceTag: null },
      { kind: 'user-pool', id: 'us-east-1_a', name: 'ae-next-users', instanceTag: null },
      { kind: 'user-pool', id: 'us-east-1_b', name: 'ae-next-staff', instanceTag: null },
      { kind: 'user-pool', id: 'us-east-1_c', name: 'ae-next-test-issuer-h1-oidc', instanceTag: null },
      { kind: 'bucket', id: 'ae-next-conversation-archive-111122223333-us-east-1', name: 'ae-next-conversation-archive-111122223333-us-east-1', instanceTag: null },
      { kind: 'bucket', id: 'aenextconversations-attachmentsbucket-xyz', name: 'aenextconversations-attachmentsbucket-xyz', instanceTag: null },
      { kind: 'stream', id: 'chime-messaging-ae-next', name: 'chime-messaging-ae-next', instanceTag: null },
      { kind: 'stream', id: 'chime-messaging-ae-next-aurora', name: 'chime-messaging-ae-next-aurora', instanceTag: null },
      { kind: 'app-instance', id: 'arn:aws:chime:us-east-1:111122223333:app-instance/x', name: 'ae-next', instanceTag: undefined },
      { kind: 'kms-key', id: 'key-1', name: 'alias/ae-next-archive', aliases: ['alias/ae-next-archive'], instanceTag: null },
    ]);
    expect(purge.map((i: { name: string }) => i.name)).toHaveLength(12);
  });

  it('never takes another instance, by tag or by a name that only starts like this one', () => {
    const { purge } = select([
      { kind: 'user-pool', id: 'us-east-1_x', name: 'ae-next-users', instanceTag: 'ae-next-two' },
      { kind: 'user-pool', id: 'us-east-1_y', name: 'ae-next-two-users', instanceTag: null },
      { kind: 'stream', id: 'chime-messaging-ae-next-two', name: 'chime-messaging-ae-next-two', instanceTag: null },
      { kind: 'table', id: 'AeNextTwoIdentity-IdentitiesTable-XYZ', name: 'AeNextTwoIdentity-IdentitiesTable-XYZ', instanceTag: null },
      { kind: 'bucket', id: 'aenexttwoconversations-attachments-xyz', name: 'aenexttwoconversations-attachments-xyz', instanceTag: null },
      { kind: 'app-instance', id: 'arn:other', name: 'ae-next-two', instanceTag: undefined },
      { kind: 'kms-key', id: 'key-2', name: 'alias/ae-next-two-archive', aliases: ['alias/ae-next-two-archive'], instanceTag: null },
      { kind: 'bucket', id: 'billing-uploads', name: 'billing-uploads', instanceTag: null },
    ]);
    expect(purge).toEqual([]);
  });

  it('keeps every secret, the external API keys above all, even when it carries this instance tag', () => {
    const secrets = [
      { kind: 'secret', id: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:twilio-keys-AbC', name: 'twilio-keys', instanceTag: 'ae-next' },
      { kind: 'secret', id: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:image-gen-keys-AbC', name: 'image-gen-keys', instanceTag: 'ae-next' },
      { kind: 'secret', id: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:ae-next-test-users-AbC', name: 'ae-next-test-users', instanceTag: 'ae-next' },
    ];
    const { purge, kept } = select(secrets);
    expect(purge).toEqual([]);
    expect(kept.map((k: { item: { name: string } }) => k.item.name)).toEqual(['twilio-keys', 'image-gen-keys', 'ae-next-test-users']);
    for (const s of secrets) expect(() => plan.assertPurgeable(s)).toThrow(/never a secret/);
  });

  it('refuses at deletion a purgeable kind whose name looks like it holds external keys', () => {
    expect(() => plan.assertPurgeable({ kind: 'bucket', id: 'ae-next-image-gen-keys', name: 'ae-next-image-gen-keys' })).toThrow(/external API keys/);
    expect(() => plan.assertPurgeable({ kind: 'table', id: 'AeNextTwilioApiKeys', name: 'AeNextTwilioApiKeys' })).toThrow(/external API keys/);
    expect(() => plan.assertPurgeable({ kind: 'log-group', id: 'x', name: 'x' })).toThrow(/only user pools/);
    expect(() => plan.assertPurgeable({ kind: 'bucket', id: 'aenextconversations-attachments-xyz', name: 'aenextconversations-attachments-xyz' })).not.toThrow();
    const { purge, kept } = select([{ kind: 'bucket', id: 'ae-next-openai-api-keys', name: 'ae-next-openai-api-keys', instanceTag: 'ae-next' }]);
    expect(purge).toEqual([]);
    expect(kept).toHaveLength(1);
  });

  it('keeps the archive buckets with --keep-archives, and reports a tagged kind it does not delete', () => {
    const archive = { kind: 'bucket', id: 'ae-next-aurora-archive-111122223333-us-east-1', name: 'ae-next-aurora-archive-111122223333-us-east-1', instanceTag: 'ae-next' };
    expect(select([archive], true)).toEqual({ purge: [], kept: [{ item: archive, why: '--keep-archives' }] });
    expect(select([archive]).purge).toEqual([archive]);
    const logs = { kind: 'logs', id: 'arn:aws:logs:us-east-1:111122223333:log-group:x', name: 'x', instanceTag: 'ae-next' };
    expect(select([logs]).kept[0].why).toMatch(/not a kind teardown deletes/);
  });

  it('reads the kind of a tagged resource from its ARN', () => {
    expect(plan.kindOfArn('arn:aws:s3:::ae-next-x')).toBe('bucket');
    expect(plan.kindOfArn('arn:aws:cognito-idp:us-east-1:111122223333:userpool/us-east-1_a')).toBe('user-pool');
    expect(plan.kindOfArn('arn:aws:dynamodb:us-east-1:111122223333:table/AeNextIdentity-T')).toBe('table');
    expect(plan.kindOfArn('arn:aws:kinesis:us-east-1:111122223333:stream/chime-messaging-ae-next')).toBe('stream');
    expect(plan.kindOfArn('arn:aws:kms:us-east-1:111122223333:key/abc')).toBe('kms-key');
    expect(plan.kindOfArn('arn:aws:secretsmanager:us-east-1:111122223333:secret:x')).toBe('secret');
  });
});

describe('the assistants created in the console', () => {
  const p = (name: string, value: Record<string, unknown>) => ({ Name: `/ae/assistant-directory/${name}`, Value: JSON.stringify(value) });

  it('are removed before any stack, because no seed removes one', () => {
    const directory = [
      p('sentinel', { classification: 'premium', role: 'ops', origin: 'console', status: 'active', botArn: 'arn:bot/sentinel', lexBotId: 'LEXS' }),
      p('finance', { classification: 'premium', role: 'primary', status: 'retiring', botArn: 'arn:bot/finance' }),
      p('ops-premium', { classification: 'premium', role: 'ops', origin: 'declared', status: 'active', botArn: 'arn:bot/ops' }),
      p('gone', { classification: 'premium', role: 'ops', origin: 'console', status: 'retired' }),
      p('_build/sentinel', { at: 'x' }),
    ];
    expect(plan.consoleAssistantsToRetireFirst(directory, '/ae')).toEqual([
      { assistant: 'sentinel', parameter: '/ae/assistant-directory/sentinel', botArn: 'arn:bot/sentinel', lexBotId: 'LEXS' },
      { assistant: 'finance', parameter: '/ae/assistant-directory/finance', botArn: 'arn:bot/finance' },
    ]);
  });

  describe('an assistant is reported removed only once its identity and its Lex bot are gone', () => {
    const BOT = 'arn:aws:chime:us-east-1:1:app-instance/ai/bot/sentinel';
    const i = { assistant: 'sentinel', botArn: BOT, lexBotId: 'LEXS' };
    /** A CLI that answers each command by its first two words, and records what it was asked. */
    const cli = (answers: Record<string, { status: number; stdout?: string; stderr?: string }>) => {
      const asked: string[] = [];
      const aws = (args: string[]) => { asked.push(`${args[0]} ${args[1]}`); return answers[`${args[0]} ${args[1]}`] ?? { status: 0, stdout: '{}' }; };
      return { aws, asked };
    };

    it('both deleted: nothing remains', () => {
      expect(plan.removeAssistantResources(i, cli({}).aws)).toEqual([]);
    });

    it('an identity whose delete fails and which its app instance still lists remains, and its Lex bot is left for after it', () => {
      const { aws, asked } = cli({
        'chime-sdk-identity delete-app-instance-bot': { status: 254, stderr: 'ThrottledClientException' },
        'chime-sdk-identity list-app-instance-bots': { status: 0, stdout: JSON.stringify({ AppInstanceBots: [{ AppInstanceBotArn: BOT }] }) },
      });
      expect(plan.removeAssistantResources(i, aws)).toEqual([`identity ${BOT}`, 'Lex bot LEXS']);
      expect(asked).not.toContain('lexv2-models delete-bot');
    });

    it('an identity already gone (not found, or Forbidden and no longer listed) is gone', () => {
      expect(plan.removeAssistantResources(i, cli({ 'chime-sdk-identity delete-app-instance-bot': { status: 254, stderr: 'NotFoundException' } }).aws)).toEqual([]);
      expect(plan.removeAssistantResources(i, cli({
        'chime-sdk-identity delete-app-instance-bot': { status: 254, stderr: 'ForbiddenException' },
        'chime-sdk-identity list-app-instance-bots': { status: 0, stdout: JSON.stringify({ AppInstanceBots: [] }) },
      }).aws)).toEqual([]);
    });

    it('an identity whose listing cannot be read is not assumed gone', () => {
      expect(plan.removeAssistantResources(i, cli({
        'chime-sdk-identity delete-app-instance-bot': { status: 254, stderr: 'ForbiddenException' },
        'chime-sdk-identity list-app-instance-bots': { status: 255, stderr: 'AccessDenied' },
      }).aws)).toEqual([`identity ${BOT}`, 'Lex bot LEXS']);
    });

    it('a Lex bot whose delete fails remains; one not found is gone', () => {
      expect(plan.removeAssistantResources(i, cli({ 'lexv2-models delete-bot': { status: 254, stderr: 'PreconditionFailedException' } }).aws)).toEqual(['Lex bot LEXS']);
      expect(plan.removeAssistantResources(i, cli({ 'lexv2-models delete-bot': { status: 254, stderr: 'ResourceNotFoundException' } }).aws)).toEqual([]);
    });

    it('the teardown keeps the entry of an assistant still standing, reports it, sweeps it again, and does not report success', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const src: string = require('fs').readFileSync(require('path').join(__dirname, '../scripts/teardown.mjs'), 'utf8');
      const firstPass = src.slice(src.indexOf("console.log('\\n▶ Removing the assistants created in the console...');"), src.indexOf("console.log('\\n▶ Deleting stacks...');"));
      expect(firstPass).toMatch(/const remaining = removeAssistant\(i\);\s+if \(remaining\.length\) \{[\s\S]*identities\.push\(i\);[\s\S]*continue;\s+\}\s+run\('aws', \['ssm', 'delete-parameter'/);
      expect(src).toMatch(/const purgedParams = params\.filter\(\(n\) => !keptEntries\.has\(n\)\);/);
      expect(src).toMatch(/if \(after\.length \|\| paramsAfter\.length \|\| stacksAfter\.length \|\| assistantsLeft\.size\)/);
      expect(src).not.toMatch(/run\('aws', \['chime-sdk-identity', 'delete-app-instance-bot'/);
    });
  });
});
