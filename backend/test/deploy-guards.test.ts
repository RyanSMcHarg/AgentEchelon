/**
 * The decisions `deploy.mjs` and `deploy-frontend.mjs` make before they touch AWS
 * (scripts/lib/deploy-guards.cjs).
 *
 * Both scripts drive a live account, so they cannot run here. Each decision below is one a script got
 * wrong:
 *
 *  - FRONTEND TARGETS. `FRONTEND_STACK_NAME` overrode both the chat and the admin publish target, and
 *    `deploy.mjs` passes its environment to `deploy-frontend.mjs`, so a deployer who set it for the chat
 *    app aimed the `--admin` publish at the chat stack.
 *  - ANALYTICS MODE. Nothing stopped a deploy from flipping `analyticsMode` on an existing instance,
 *    although the two analytics stacks create resources with the same fixed names.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { FrontendStack } from '../lib/stacks/frontend-stack';
import { CAPABILITIES, parseCapabilities } from '../lib/config/capabilities';

const {
  resolveInstancePrefix,
  resolveFrontendTargets,
  isFailedCreate,
  checkFrontendStackOutputs,
  classifyDescribeStacksError,
  contextValue,
  contextFlagsFromConfig,
  declaredCapabilities,
  consoleContext,
  backendDeployArgs,
  corsPassOrigins,
  DEPLOY_STEPS,
  ANALYTICS_MODE_RECORD_KEY,
  archiveStackName,
  deployedAnalyticsMode,
  checkAnalyticsModeLock,
  recordAnalyticsModeText,
  widgetStackName,
  checkWidgetStackOutputs,
} = require('../scripts/lib/deploy-guards.cjs');

const BACKEND_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_DIR, '..');

describe('frontend publish targets', () => {
  it('derives both targets from the default instance', () => {
    expect(resolveFrontendTargets({})).toEqual({
      prefix: 'AgentEchelon',
      chat: 'AgentEchelonChatApp',
      admin: 'AgentEchelonAdminApp',
    });
  });

  it('derives both targets from a non-default instance name', () => {
    expect(resolveFrontendTargets({ AE_INSTANCE_NAME: 'acme-two' })).toEqual({
      prefix: 'AcmeTwo',
      chat: 'AcmeTwoChatApp',
      admin: 'AcmeTwoAdminApp',
    });
    expect(resolveFrontendTargets({ AE_STACK_PREFIX: 'Zed', AE_INSTANCE_NAME: 'acme' }).admin).toBe('ZedAdminApp');
  });

  it('uses the same prefix the CDK app names its stacks with', () => {
    // agent-classification-common.ts reads AE_INSTANCE_NAME / AE_STACK_PREFIX at import time, so it is
    // loaded fresh under each environment and compared against the script's answer.
    for (const env of [{ AE_INSTANCE_NAME: 'acme-two' }, { AE_STACK_PREFIX: 'Zed' }, {}]) {
      const saved = { ...process.env };
      delete process.env.AE_INSTANCE_NAME;
      delete process.env.AE_STACK_PREFIX;
      Object.assign(process.env, env);
      let cdkPrefix = '';
      jest.isolateModules(() => {
        cdkPrefix = require('../lib/stacks/agent-classification-common').STACK_PREFIX;
      });
      process.env = saved;
      expect(resolveInstancePrefix(env)).toBe(cdkPrefix);
    }
  });

  it('a chat override never redirects the admin target', () => {
    // The shipped defect: with FRONTEND_STACK_NAME set for a non-default instance, the --admin publish
    // targeted the chat stack.
    const t = resolveFrontendTargets({ AE_INSTANCE_NAME: 'acme', FRONTEND_STACK_NAME: 'AcmeChatApp' });
    expect(t.chat).toBe('AcmeChatApp');
    expect(t.admin).toBe('AcmeAdminApp');

    // Nor does it feed the prefix: a custom chat name leaves the admin target on the instance prefix.
    const custom = resolveFrontendTargets({ AE_INSTANCE_NAME: 'acme', FRONTEND_STACK_NAME: 'AcmeSomethingElse' });
    expect(custom.chat).toBe('AcmeSomethingElse');
    expect(custom.admin).toBe('AcmeAdminApp');
    expect(custom.prefix).toBe('Acme');
  });

  it('an admin override never redirects the chat target', () => {
    const t = resolveFrontendTargets({ AE_INSTANCE_NAME: 'acme', ADMIN_FRONTEND_STACK_NAME: 'AcmeOpsConsole' });
    expect(t.chat).toBe('AcmeChatApp');
    expect(t.admin).toBe('AcmeOpsConsole');
  });

  it('refuses a chat override that names the admin stack, naming both stacks', () => {
    expect(() => resolveFrontendTargets({ AE_INSTANCE_NAME: 'acme', FRONTEND_STACK_NAME: 'AcmeAdminApp' }))
      .toThrow(/FRONTEND_STACK_NAME=AcmeAdminApp[\s\S]*AcmeChatApp[\s\S]*AcmeAdminApp/);
    expect(() => resolveFrontendTargets({ AE_INSTANCE_NAME: 'acme', FRONTEND_STACK_NAME: 'AcmeAdminApp' }))
      .toThrow(/ADMIN frontend stack/);
  });

  it('accepts the chat stack of an instance whose prefix ends in "Admin"', () => {
    // AE_INSTANCE_NAME=ops-admin names its chat stack OpsAdminChatApp. The admin target is compared by
    // its derived name, never by an "Admin" suffix, so the prefix's own "Admin" decides nothing.
    expect(resolveFrontendTargets({ AE_INSTANCE_NAME: 'ops-admin' })).toEqual({
      prefix: 'OpsAdmin',
      chat: 'OpsAdminChatApp',
      admin: 'OpsAdminAdminApp',
    });
    const t = resolveFrontendTargets({ AE_INSTANCE_NAME: 'ops-admin', FRONTEND_STACK_NAME: 'OpsAdminChatApp' });
    expect(t.chat).toBe('OpsAdminChatApp');
    expect(t.admin).toBe('OpsAdminAdminApp');
    expect(() => resolveFrontendTargets({ AE_INSTANCE_NAME: 'ops-admin', FRONTEND_STACK_NAME: 'OpsAdminAdminApp' }))
      .toThrow(/ADMIN frontend stack/);
  });

  it('refuses an admin override that names the chat stack', () => {
    expect(() => resolveFrontendTargets({ AE_INSTANCE_NAME: 'acme', ADMIN_FRONTEND_STACK_NAME: 'AcmeChatApp' }))
      .toThrow(/ADMIN_FRONTEND_STACK_NAME=AcmeChatApp[\s\S]*CHAT frontend stack/);
  });

  it('refuses an override that names another instance\'s stack', () => {
    // Outside the prefix entirely.
    expect(() => resolveFrontendTargets({ AE_INSTANCE_NAME: 'acme', FRONTEND_STACK_NAME: 'OtherChatApp' }))
      .toThrow(/FRONTEND_STACK_NAME=OtherChatApp does not start with this instance's prefix "Acme"/);
    expect(() => resolveFrontendTargets({ FRONTEND_STACK_NAME: 'OtherAdminApp' }))
      .toThrow(/outside this instance[\s\S]*AgentEchelonChatApp[\s\S]*AgentEchelonAdminApp/);
    expect(() => resolveFrontendTargets({ AE_INSTANCE_NAME: 'acme', ADMIN_FRONTEND_STACK_NAME: 'OpsConsole' }))
      .toThrow(/ADMIN_FRONTEND_STACK_NAME=OpsConsole does not start/);
    // Inside the prefix, but another instance's frontend stack: `Acme` is a prefix of `AcmeTwo`.
    expect(() => resolveFrontendTargets({ AE_INSTANCE_NAME: 'acme', FRONTEND_STACK_NAME: 'AcmeTwoChatApp' }))
      .toThrow(/shaped like another instance's frontend stack/);
    expect(() => resolveFrontendTargets({ AE_INSTANCE_NAME: 'acme', ADMIN_FRONTEND_STACK_NAME: 'AcmeTwoAdminApp' }))
      .toThrow(/shaped like another instance's frontend stack/);
    // The derived names themselves are always accepted as overrides.
    expect(resolveFrontendTargets({ AE_INSTANCE_NAME: 'acme', FRONTEND_STACK_NAME: 'AcmeChatApp', ADMIN_FRONTEND_STACK_NAME: 'AcmeAdminApp' }))
      .toEqual({ prefix: 'Acme', chat: 'AcmeChatApp', admin: 'AcmeAdminApp' });
  });

  it('deploy-frontend.mjs applies the refusal before it calls AWS', () => {
    // Exits during target resolution, so this runs no AWS call; it proves the script uses the guard
    // rather than its own derivation.
    const r = spawnSync(process.execPath, ['scripts/deploy-frontend.mjs', '--admin'], {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
      env: {
        ...process.env,
        AE_INSTANCE_NAME: 'acme',
        // Any other variable naming an instance would disagree with `acme` and stop resolution first.
        E2E_INSTANCE_NAME: '',
        INSTANCE_NAME: '',
        SSM_ROOT: '',
        AE_STACK_PREFIX: '',
        STACK_PREFIX: '',
        FRONTEND_STACK_NAME: 'AcmeAdminApp',
        ADMIN_FRONTEND_STACK_NAME: '',
      },
      timeout: 30000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Chat target:\s+AcmeChatApp/);
    expect(r.stderr).toMatch(/Admin target:\s+AcmeAdminApp/);
  });

  it('deploy.mjs hands both targets and the prefix to every child step', () => {
    // deploy.mjs cannot run here (its first step is a build and its second a deploy). What matters is
    // that the children receive the resolved names instead of inheriting a FRONTEND_STACK_NAME that
    // deploy-frontend.mjs would apply to the admin publish too.
    const src = fs.readFileSync(path.join(BACKEND_DIR, 'scripts/deploy.mjs'), 'utf8');
    expect(src).toMatch(/const CHILD_ENV = \{[\s\S]*STACK_PREFIX: TARGETS\.prefix,[\s\S]*FRONTEND_STACK_NAME: TARGETS\.chat,[\s\S]*ADMIN_FRONTEND_STACK_NAME: TARGETS\.admin,/);
    expect(src).toMatch(/spawnSync\(cmd, args, \{[\s\S]*?env: CHILD_ENV/);
  });
});

describe('frontend stack outputs say which console a stack hosts', () => {
  const env = { account: '123456789012', region: 'us-east-1' };
  const outputKeysOf = (stack: cdk.Stack): string[] => Object.keys(Template.fromStack(stack).toJSON().Outputs ?? {});
  const chatKeys = outputKeysOf(new FrontendStack(new cdk.App(), 'AcmeChatApp', { env }));
  const adminKeys = outputKeysOf(new FrontendStack(new cdk.App(), 'AcmeAdminApp', { env, outputPrefix: 'Admin' }));
  const targets = { chat: 'AcmeChatApp', admin: 'AcmeAdminApp' };

  it('accepts each publish against its own stack', () => {
    expect(checkFrontendStackOutputs({ stackName: 'AcmeChatApp', isAdmin: false, outputKeys: chatKeys, targets })).toBeNull();
    expect(checkFrontendStackOutputs({ stackName: 'AcmeAdminApp', isAdmin: true, outputKeys: adminKeys, targets })).toBeNull();
  });

  it('refuses the admin publish against the chat stack, naming both targets', () => {
    const msg = checkFrontendStackOutputs({ stackName: 'AcmeChatApp', isAdmin: true, outputKeys: chatKeys, targets });
    expect(msg).toMatch(/"AcmeChatApp" is the CHAT frontend stack/);
    expect(msg).toMatch(/Chat target:\s+AcmeChatApp/);
    expect(msg).toMatch(/Admin target:\s+AcmeAdminApp/);
  });

  it('refuses the chat publish against the admin stack', () => {
    const msg = checkFrontendStackOutputs({ stackName: 'AcmeAdminApp', isAdmin: false, outputKeys: adminKeys, targets });
    expect(msg).toMatch(/is the ADMIN frontend stack/);
  });

  it('refuses a stack that is not a frontend stack at all', () => {
    expect(checkFrontendStackOutputs({ stackName: 'AcmeConversations', isAdmin: true, outputKeys: ['TasksTableName'], targets }))
      .toMatch(/missing the AdminDistributionBucketName/);
  });

  it('reports a stack whose create failed as that, not as the wrong kind of stack', () => {
    for (const stackStatus of ['ROLLBACK_COMPLETE', 'ROLLBACK_FAILED', 'REVIEW_IN_PROGRESS']) {
      expect(isFailedCreate(stackStatus)).toBe(true);
      const msg = checkFrontendStackOutputs({ stackName: 'AcmeAdminApp', isAdmin: true, outputKeys: [], targets, stackStatus });
      expect(msg).toContain(`"AcmeAdminApp" is in ${stackStatus}`);
      expect(msg).toMatch(/create never succeeded/);
      expect(msg).not.toMatch(/not a admin frontend stack/);
    }
    expect(isFailedCreate('UPDATE_ROLLBACK_COMPLETE')).toBe(false);
    expect(checkFrontendStackOutputs({ stackName: 'AcmeChatApp', isAdmin: false, outputKeys: chatKeys, targets, stackStatus: 'UPDATE_COMPLETE' }))
      .toBeNull();
  });
});

describe('DescribeStacks error classification', () => {
  it('reads only a "does not exist" ValidationError as absence', () => {
    expect(classifyDescribeStacksError({ name: 'ValidationError', message: 'Stack with id AcmeArchive does not exist' })).toBe('absent');
    expect(classifyDescribeStacksError({ name: 'ExpiredTokenException', message: 'The security token included in the request is expired' })).toBe('unknown');
    expect(classifyDescribeStacksError({ name: 'AccessDenied', message: 'not authorized to perform cloudformation:DescribeStacks' })).toBe('unknown');
    expect(classifyDescribeStacksError({ name: 'ValidationError', message: 'Template format error' })).toBe('unknown');
    expect(classifyDescribeStacksError(new Error('getaddrinfo ENOTFOUND'))).toBe('unknown');
  });
});

describe('context value resolution', () => {
  it('takes the last value, as the CDK CLI does, in every flag spelling', () => {
    expect(contextValue(['--context', 'analyticsMode=athena', '--context', 'analyticsMode=aurora'], 'analyticsMode')).toBe('aurora');
    expect(contextValue(['-c', 'analyticsMode=aurora'], 'analyticsMode')).toBe('aurora');
    expect(contextValue(['--context=analyticsMode=aurora'], 'analyticsMode')).toBe('aurora');
    expect(contextValue(['--context', 'appUrl=https://x'], 'analyticsMode')).toBeUndefined();
    expect(contextValue(['--context', 'adminAppUrl=https://a'], 'appUrl')).toBeUndefined();
  });
});

describe('what deploy.mjs forwards and reads from its context', () => {
  it('forwards deploy.config.json as context, never a `_` key or an empty value', () => {
    const flags = contextFlagsFromConfig({
      _comment: 'mine',
      [ANALYTICS_MODE_RECORD_KEY]: 'aurora',
      analyticsMode: 'aurora',
      capabilities: ['chat', 'admin'],
      appUrl: '',
      vpcId: null,
    });
    expect(flags).toEqual(['--context', 'analyticsMode=aurora', '--context', 'capabilities=chat,admin']);
    expect(flags.join(' ')).not.toContain(ANALYTICS_MODE_RECORD_KEY);
  });

  it('sees appUrl and the declared capabilities in every flag spelling, last value winning', () => {
    for (const spelling of [
      ['--context', 'appUrl=https://x', '--context', 'capabilities=chat,admin'],
      ['-c', 'appUrl=https://x', '-c', 'capabilities=chat,admin'],
      ['--context=appUrl=https://x', '--context=capabilities=chat,admin'],
    ]) {
      expect(consoleContext(spelling)).toEqual({
        userSetAppUrl: true, userSetAdminAppUrl: false, userSetWidgetUrl: false, chatAppEnabled: true, adminAppEnabled: true, widgetEnabled: false, widgetHostEnabled: false,
      });
    }
    // A CLI flag after the persisted config overrides it, as in the CDK CLI.
    expect(consoleContext(['--context', 'capabilities=chat,admin', '-c', 'capabilities=chat']).adminAppEnabled).toBe(false);
    expect(consoleContext(['--context', 'adminAppUrl=https://a']).userSetAdminAppUrl).toBe(true);
    expect(consoleContext(['--context', 'widgetUrl=https://w']).userSetWidgetUrl).toBe(true);
  });

  it('publishes each console exactly when the CDK app creates its stack', () => {
    // The CDK app parses `capabilities` with `parseCapabilities`, and the registry's `chat` and `admin`
    // entries stand up the two console stacks. A deploy.config.json array arrives as a comma-separated string.
    for (const capabilities of [['chat'], ['admin'], ['chat', 'admin'], [], ['notifications', 'chat']]) {
      const forwarded = contextFlagsFromConfig({ capabilities });
      expect(declaredCapabilities(forwarded)).toEqual(parseCapabilities(capabilities.join(',')));
      const stacks = CAPABILITIES.filter((c) => capabilities.includes(c.name)).flatMap((c) => c.stacks);
      expect(consoleContext(forwarded)).toMatchObject({
        chatAppEnabled: stacks.includes('ChatApp'),
        adminAppEnabled: stacks.includes('AdminApp'),
      });
    }
    // A JSON array string, which the CDK app accepts too.
    expect(consoleContext(['--context', 'capabilities=["admin"]']).adminAppEnabled).toBe(true);
    // Absent: the core alone, so neither console.
    expect(consoleContext([])).toMatchObject({ chatAppEnabled: false, adminAppEnabled: false });
  });

  it('names the two console stacks the capability registry stands up', () => {
    const stacksOf = (name: string) => CAPABILITIES.find((c) => c.name === name)!.stacks;
    expect(stacksOf('chat')).toContain('ChatApp');
    expect(stacksOf('admin')).toContain('AdminApp');
    expect(resolveFrontendTargets({ AE_INSTANCE_NAME: 'acme' })).toMatchObject({ chat: 'AcmeChatApp', admin: 'AcmeAdminApp' });
  });

  it('puts the resolved origins on the backend pass', () => {
    const forwarded = ['--context', 'analyticsMode=aurora'];
    expect(backendDeployArgs(forwarded, { appUrl: 'https://c', adminAppUrl: 'https://a' })).toEqual([
      'cdk', 'deploy', '--all', '--require-approval', 'never', '--context', 'analyticsMode=aurora',
      '--context', 'appUrl=https://c', '--context', 'adminAppUrl=https://a',
    ]);
    expect(backendDeployArgs(forwarded, {})).toEqual(['cdk', 'deploy', '--all', '--require-approval', 'never', ...forwarded]);
    // The widget frame's own origin, which PersonApi admits in CORS, rides the same pass.
    expect(backendDeployArgs(forwarded, { widgetUrl: 'https://w' })).toEqual([
      'cdk', 'deploy', '--all', '--require-approval', 'never', ...forwarded, '--context', 'widgetUrl=https://w',
    ]);
  });

  it('runs the extra CORS pass only for a new distribution, carrying both origins', () => {
    expect(corsPassOrigins({ pre: { chat: 'https://c', admin: 'https://a' }, late: {} })).toBeNull();
    // A new admin distribution on an existing instance: the pass keeps the chat origin it already had.
    expect(corsPassOrigins({ pre: { chat: 'https://c', admin: null }, late: { admin: 'https://a' } }))
      .toEqual({ appUrl: 'https://c', adminAppUrl: 'https://a' });
    // A new chat distribution: the pass keeps the admin origin resolved before pass 1, so the admin
    // console's CORS allowlist is not reset by the second pass.
    const pass5 = corsPassOrigins({ pre: { chat: null, admin: 'https://a' }, late: { chat: 'https://c' } });
    expect(backendDeployArgs([], pass5)).toEqual(expect.arrayContaining(['adminAppUrl=https://a', 'appUrl=https://c']));
    // Pass 1 carries the admin origin as well.
    expect(backendDeployArgs([], { appUrl: null, adminAppUrl: 'https://a' })).toContain('adminAppUrl=https://a');
  });

  it("closes a new widget distribution's CORS in the same deploy, keeping every other origin", () => {
    // A guest deployment's first deploy: the widget distribution did not exist before pass 1, so the
    // extra pass carries its origin, and the chat origin resolved before pass 1 with it.
    expect(corsPassOrigins({ pre: { chat: 'https://c', admin: null, widget: null }, late: { widget: 'https://w' } }))
      .toEqual({ appUrl: 'https://c', adminAppUrl: undefined, widgetUrl: 'https://w' });
    // A later deploy: the widget origin was resolved before pass 1, so no extra pass runs.
    expect(corsPassOrigins({ pre: { chat: 'https://c', widget: 'https://w' }, late: {} })).toBeNull();
    // A new chat distribution keeps the widget origin resolved before pass 1.
    expect(corsPassOrigins({ pre: { widget: 'https://w' }, late: { chat: 'https://c' } })).toMatchObject({ widgetUrl: 'https://w', appUrl: 'https://c' });
  });
});

describe('the order deploy.mjs runs its steps in', () => {
  const at = (id: string) => {
    const i = DEPLOY_STEPS.indexOf(id);
    expect(i).toBeGreaterThanOrEqual(0);
    return i;
  };

  it('checks the analytics mode before anything deploys', () => {
    expect(at('assertAnalyticsModeRecord')).toBeLessThan(at('assertOnlyOurStacks'));
    expect(at('assertAnalyticsModeRecord')).toBeGreaterThan(at('resolveContext'));
    expect(at('assertAnalyticsModeMatchesDeployment')).toBeLessThan(at('deployBackend'));
    expect(at('assertOnlyOurStacks')).toBeLessThan(at('deployBackend'));
  });

  it('resolves the origins before the first backend pass and records the mode only after it', () => {
    expect(at('resolveOrigins')).toBeLessThan(at('deployBackend'));
    expect(at('recordAnalyticsMode')).toBe(at('deployBackend') + 1);
    expect(at('corsPass')).toBeGreaterThan(at('publishAdmin'));
    expect(at('build')).toBe(0);
  });

  it('is the list deploy.mjs walks, with a body for every step', () => {
    // deploy.mjs cannot be imported here (importing it runs a deploy), so this reads the source for
    // the loop and one body per id.
    const src = fs.readFileSync(path.join(BACKEND_DIR, 'scripts/deploy.mjs'), 'utf8');
    expect(src).toMatch(/for \(const id of DEPLOY_STEPS\) \{[\s\S]*?await step\(\);/);
    const body = src.slice(src.indexOf('const STEPS = {'), src.indexOf('async function main()'));
    for (const id of DEPLOY_STEPS) expect(body).toMatch(new RegExp(`^  ${id}: `, 'm'));
    expect(new Set(DEPLOY_STEPS).size).toBe(DEPLOY_STEPS.length);
  });
});

describe('analytics mode lock', () => {
  const prefix = 'Acme';

  it('names the one archive stack the CDK app creates in either mode', () => {
    expect(archiveStackName(prefix)).toBe('AcmeArchive');
    const bin = fs.readFileSync(path.join(BACKEND_DIR, 'bin/backend.ts'), 'utf8');
    // Both modes are built under the one id, so the mode is read from the stack's output.
    expect(bin.split("stackId('Archive')").length - 1).toBe(2);
    for (const file of ['lib/stacks/archive-stack.ts', 'lib/stacks/archive-stack-aurora.ts']) {
      expect(fs.readFileSync(path.join(BACKEND_DIR, file), 'utf8')).toMatch(/new cdk\.CfnOutput\(this, 'AnalyticsMode', \{\s*value: this\.analyticsMode,/);
    }
  });

  it('reads the deployed mode from the Archive stack and its AnalyticsMode output', () => {
    expect(deployedAnalyticsMode({ presence: 'absent' })).toBe('none');
    expect(deployedAnalyticsMode({ presence: 'present', mode: 'athena' })).toBe('athena');
    expect(deployedAnalyticsMode({ presence: 'present', mode: 'aurora' })).toBe('aurora');
    expect(deployedAnalyticsMode({ presence: 'unknown' })).toBe('unknown');
    // A stack with no readable mode concludes nothing.
    expect(deployedAnalyticsMode({ presence: 'present', mode: undefined })).toBe('unknown');
    expect(deployedAnalyticsMode({ presence: 'present', mode: 'Aurora' })).toBe('unknown');
  });

  it('lets the first deploy choose either mode', () => {
    expect(checkAnalyticsModeLock({ requested: 'aurora', deployed: 'none', prefix }).ok).toBe(true);
    expect(checkAnalyticsModeLock({ requested: undefined, deployed: 'none', prefix }).ok).toBe(true);
  });

  it('lets a redeploy keep its mode', () => {
    expect(checkAnalyticsModeLock({ requested: 'aurora', deployed: 'aurora', prefix }).ok).toBe(true);
    expect(checkAnalyticsModeLock({ requested: 'athena', deployed: 'athena', recorded: 'athena', prefix }).ok).toBe(true);
  });

  it('refuses a switch in either direction, saying why and where to read about it', () => {
    const toAurora = checkAnalyticsModeLock({ requested: 'aurora', deployed: 'athena', prefix });
    expect(toAurora.ok).toBe(false);
    expect(toAurora.message).toMatch(/runs analyticsMode=athena \(AcmeArchive says so in its AnalyticsMode output\)/);
    expect(toAurora.message).toMatch(/not supported/);
    expect(toAurora.message).toMatch(/AURORA-MODE-GUIDE\.md#switching-modes/);

    const toAthena = checkAnalyticsModeLock({ requested: 'athena', deployed: 'aurora', prefix });
    expect(toAthena.ok).toBe(false);
    expect(toAthena.message).toMatch(/runs analyticsMode=aurora/);
  });

  it('refuses an ABSENT analyticsMode on an Aurora instance, since absent means athena', () => {
    const r = checkAnalyticsModeLock({ requested: undefined, deployed: 'aurora', prefix });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/"analyticsMode": "aurora"/);
  });

  it('refuses when it cannot tell which mode the archive runs', () => {
    const r = checkAnalyticsModeLock({ requested: 'aurora', deployed: 'unknown', prefix });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Could not tell which analytics mode AcmeArchive runs/);
  });

  it('refuses a value the CDK app would silently read as athena', () => {
    const r = checkAnalyticsModeLock({ requested: 'Aurora', deployed: 'none', prefix });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not a mode/);
  });

  it('refuses against the recorded mode before AWS is asked', () => {
    const r = checkAnalyticsModeLock({ requested: 'athena', recorded: 'aurora', prefix });
    expect(r.ok).toBe(false);
    expect(r.message).toContain(ANALYTICS_MODE_RECORD_KEY);
    expect(r.message).toMatch(/first deployed with analyticsMode=aurora/);
    expect(checkAnalyticsModeLock({ requested: 'aurora', recorded: 'aurora', prefix }).ok).toBe(true);
  });

  it('does not count a failed create as the running mode', () => {
    // A ROLLBACK_COMPLETE Archive has no outputs and runs nothing: it is a first deploy still to come,
    // which the backend pass deletes and creates again.
    expect(deployedAnalyticsMode({ presence: 'failed-create' })).toBe('none');
    expect(checkAnalyticsModeLock({ requested: 'aurora', deployed: deployedAnalyticsMode({ presence: 'failed-create' }), prefix }).ok).toBe(true);
  });

  it('warns when the recorded value is not a mode, rather than ignoring it', () => {
    const r = checkAnalyticsModeLock({ requested: 'aurora', recorded: 'Aurora', deployed: 'aurora', prefix });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(new RegExp(`${ANALYTICS_MODE_RECORD_KEY}="Aurora"[\\s\\S]*not a mode`));
    expect(checkAnalyticsModeLock({ requested: 'aurora', recorded: 'aurora', prefix }).warning).toBeUndefined();
    expect(checkAnalyticsModeLock({ requested: 'aurora', prefix }).warning).toBeUndefined();
    // The warning rides on a refusal too.
    const refused = checkAnalyticsModeLock({ requested: 'athena', recorded: 7, deployed: 'aurora', prefix });
    expect(refused.ok).toBe(false);
    expect(refused.warning).toMatch(/not a mode/);
  });

  it('points at a section that exists', () => {
    const guide = fs.readFileSync(path.join(REPO_ROOT, 'docs/guides/admin/AURORA-MODE-GUIDE.md'), 'utf8');
    expect(guide).toMatch(/^### Switching modes$/m);
  });

  it('rests on a premise that still holds: both archive modes create the same fixed-name archive resources', () => {
    // If these names ever diverge, switching may become possible and the lock and its documentation
    // need revisiting rather than silently outliving their reason.
    const athena = fs.readFileSync(path.join(BACKEND_DIR, 'lib/stacks/archive-stack.ts'), 'utf8');
    const aurora = fs.readFileSync(path.join(BACKEND_DIR, 'lib/stacks/archive-stack-aurora.ts'), 'utf8');
    const archive = fs.readFileSync(path.join(BACKEND_DIR, 'lib/constructs/conversation-archive.ts'), 'utf8');
    expect(aurora).toMatch(/new ConversationArchive\(/);
    for (const name of [
      '`${ANALYTICS_PREFIX}-conversation-archive-${',
      '`${ANALYTICS_PREFIX}-message-archive`',
      'name: ANALYTICS_DB_NAME',
      'name: ATHENA_WORKGROUP_NAME',
    ]) {
      expect(athena).toContain(name);
      expect(archive).toContain(name);
    }
  });
});

describe('recording the chosen mode in deploy.config.json', () => {
  const original = '{\n  "_comment": "mine",\n\n  "analyticsMode": "aurora",\n  "senderEmail": "a@b.c"\n}\n';

  it('inserts the record once and leaves the rest of the file byte for byte', () => {
    const next = recordAnalyticsModeText(original, 'aurora');
    expect(next).not.toBeNull();
    expect(JSON.parse(next)[ANALYTICS_MODE_RECORD_KEY]).toBe('aurora');
    expect(JSON.parse(next).senderEmail).toBe('a@b.c');
    expect(next.replace(`\n  "${ANALYTICS_MODE_RECORD_KEY}": "aurora",`, '')).toBe(original);
    expect(recordAnalyticsModeText(next, 'athena')).toBeNull();
  });

  it('handles an empty object and refuses what it cannot record', () => {
    expect(JSON.parse(recordAnalyticsModeText('{}', 'athena'))).toEqual({ [ANALYTICS_MODE_RECORD_KEY]: 'athena' });
    expect(recordAnalyticsModeText('{ not json', 'athena')).toBeNull();
    expect(recordAnalyticsModeText(original, 'Aurora')).toBeNull();
  });

  it('keeps a CRLF file CRLF', () => {
    const crlf = original.replace(/\n/g, '\r\n');
    const next = recordAnalyticsModeText(crlf, 'aurora');
    expect(next).toBe(crlf.replace('{\r\n', `{\r\n  "${ANALYTICS_MODE_RECORD_KEY}": "aurora",\r\n`));
    expect(next.replace(/\r\n/g, '')).not.toContain('\n');
    expect(JSON.parse(recordAnalyticsModeText('{}\r\n', 'athena').trim())).toEqual({ [ANALYTICS_MODE_RECORD_KEY]: 'athena' });
    expect(recordAnalyticsModeText('{\r\n}\r\n', 'athena')).toBe(`{\r\n  "${ANALYTICS_MODE_RECORD_KEY}": "athena"\r\n}\r\n`);
  });

  it('uses the file\'s own indent', () => {
    const tabbed = '{\n\t"analyticsMode": "athena",\n\t"senderEmail": "a@b.c"\n}\n';
    expect(recordAnalyticsModeText(tabbed, 'athena'))
      .toBe(`{\n\t"${ANALYTICS_MODE_RECORD_KEY}": "athena",\n\t"analyticsMode": "athena",\n\t"senderEmail": "a@b.c"\n}\n`);
    const four = '{\n    "analyticsMode": "athena"\n}';
    expect(recordAnalyticsModeText(four, 'athena'))
      .toBe(`{\n    "${ANALYTICS_MODE_RECORD_KEY}": "athena",\n    "analyticsMode": "athena"\n}`);
  });
});

describe('a deploy never removes a commit a live stack runs', () => {
  const {
    deployedCommitParamName,
    deployedCommitRecord,
    parseDeployedCommitRecord,
    rollbackVerdict,
  } = require('../scripts/lib/deploy-guards.cjs');
  const LIVE = 'a'.repeat(40);
  const HEAD = 'b'.repeat(40);
  const base = { stackName: 'AgentEchelonExperiments', head: HEAD, dirty: false, knownLocally: true, isAncestor: true };

  it('refuses a checkout that does not contain the live commit, and says how to fix it', () => {
    const v = rollbackVerdict({ ...base, deployed: { commit: LIVE }, isAncestor: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not an ancestor/);
    expect(v.reason).toMatch(/rebase onto private\/main/);
  });

  it('allows a forward deploy and a redeploy of what is live', () => {
    expect(rollbackVerdict({ ...base, deployed: { commit: LIVE } }).ok).toBe(true);
    expect(rollbackVerdict({ ...base, deployed: { commit: HEAD }, isAncestor: false }).ok).toBe(true);
  });

  it('refuses when the live commit is not in this clone, rather than guessing', () => {
    const v = rollbackVerdict({ ...base, deployed: { commit: LIVE }, knownLocally: false, isAncestor: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/git fetch/);
  });

  it('refuses uncommitted changes unless they are asked for', () => {
    expect(rollbackVerdict({ ...base, deployed: null, dirty: true }).ok).toBe(false);
    expect(rollbackVerdict({ ...base, deployed: null, dirty: true, allowDirty: true }).ok).toBe(true);
  });

  it('lets an explicit override through, and only that', () => {
    expect(rollbackVerdict({ ...base, deployed: { commit: LIVE }, isAncestor: false, allowRollback: true }).ok).toBe(true);
    expect(rollbackVerdict({ ...base, deployed: { commit: LIVE }, knownLocally: false, isAncestor: false, allowRollback: true }).ok).toBe(true);
  });

  it('allows a stack with no record yet, and says the deploy writes the first one', () => {
    const v = rollbackVerdict({ ...base, deployed: null });
    expect(v.ok).toBe(true);
    expect(v.note).toMatch(/first one/);
  });

  it('records per stack under the instance, and reads back only a well-formed record', () => {
    expect(deployedCommitParamName('agent-echelon', 'AgentEchelonExperiments')).toBe('/agent-echelon/deployed-commit/AgentEchelonExperiments');
    const rec = parseDeployedCommitRecord(deployedCommitRecord({ commit: LIVE, dirty: true, by: 'deploy-stack.mjs' }));
    expect(rec).toMatchObject({ commit: LIVE, dirty: true, by: 'deploy-stack.mjs' });
    expect(parseDeployedCommitRecord('{"commit":"not-a-sha"}')).toBeNull();
    expect(parseDeployedCommitRecord('not json')).toBeNull();
    expect(parseDeployedCommitRecord(undefined)).toBeNull();
  });

  it('checks after the stack list is known and before anything deploys; records after the pass succeeds', () => {
    const at = (id: string) => DEPLOY_STEPS.indexOf(id);
    expect(at('assertNoRollback')).toBeGreaterThan(at('assertOnlyOurStacks'));
    expect(at('assertNoRollback')).toBeLessThan(at('deployBackend'));
    expect(at('recordDeployedCommits')).toBeGreaterThan(at('deployBackend'));
  });

  it('is the check both deploy scripts run, and deploy:stack is the single-stack entry', () => {
    const lib = fs.readFileSync(path.join(BACKEND_DIR, 'scripts/lib/deployed-commit.mjs'), 'utf8');
    expect(lib).toMatch(/rollbackVerdict\(/);
    for (const script of ['scripts/deploy.mjs', 'scripts/deploy-stack.mjs']) {
      const src = fs.readFileSync(path.join(BACKEND_DIR, script), 'utf8');
      expect(src).toMatch(/from '\.\/lib\/deployed-commit\.mjs'/);
      expect(src).toMatch(/assertNoRollback\(/);
      expect(src).toMatch(/recordDeployedCommits\(/);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'package.json'), 'utf8'));
    expect(pkg.scripts['deploy:stack']).toBe('node scripts/deploy-stack.mjs');
  });

  it('applies the analytics mode lock in both deploy scripts, so a single stack cannot change the mode', () => {
    for (const script of ['scripts/deploy.mjs', 'scripts/deploy-stack.mjs']) {
      const src = fs.readFileSync(path.join(BACKEND_DIR, script), 'utf8');
      expect(src).toMatch(/checkAnalyticsModeLock\(\{/);
      expect(src).toMatch(/deployedAnalyticsMode\(/);
    }
    // The single-stack check runs before the diff, so --diff-only also reports a mode change it would refuse.
    const single = fs.readFileSync(path.join(BACKEND_DIR, 'scripts/deploy-stack.mjs'), 'utf8');
    expect(single.indexOf('await assertAnalyticsMode(')).toBeLessThan(single.indexOf("console.log(`\\n▶ What this deploy changes"));
  });
});

describe('an assistant deploys through the guarded scripts, never a raw cdk deploy', () => {
  const HOOK = path.join(REPO_ROOT, '.claude/hooks/deploy-through-the-guard.js');
  const { isRawCdkDeploy } = require(HOOK);
  const decide = (command: string) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' });
    expect(r.status).toBe(0);
    return r.stdout.includes('"permissionDecision":"deny"') ? 'deny' : 'allow';
  };

  it('denies every spelling of a raw deploy', () => {
    for (const c of [
      'npx cdk deploy AgentEchelonExperiments --exclusively',
      'cd backend && AWS_PROFILE=x npx cdk deploy --all',
      'cdk deploy Foo',
      'npx --yes aws-cdk deploy Foo',
      'npx cdk@2 deploy Foo',
      'npx cdk --profile x deploy Foo',
    ]) expect([c, isRawCdkDeploy(c)]).toEqual([c, true]);
    expect(decide('npx cdk deploy AgentEchelonExperiments --exclusively')).toBe('deny');
  });

  it('allows the guarded scripts and the read-only cdk commands', () => {
    for (const c of [
      'npm run deploy:stack -- AgentEchelonExperiments',
      'node scripts/deploy-stack.mjs AgentEchelonExperiments --diff-only',
      'npm run deploy',
      'npx cdk diff AgentEchelonAssistants-premium --exclusively',
      'npx cdk list',
      'npx cdk synth Foo',
      'grep -n "cdk deploy" docs/x.md',
      // Text that mentions a deploy is data, not a deploy: the hook refused this shape on its first day.
      "node -e \"s.replace('npx cdk deploy AgentEchelonExperiments --exclusively', 'npm run deploy:stack')\"",
      "node - <<'EOF'\nconst old = `npx cdk deploy Foo --exclusively`;\nEOF",
      'git commit -m "docs: never npx cdk deploy by hand"',
    ]) expect([c, decide(c)]).toEqual([c, 'allow']);
    // A real deploy after a heredoc or a quoted string is still one.
    expect(decide("cat <<'EOF' > notes.txt\nhello\nEOF\nnpx cdk deploy Foo")).toBe('deny');
    expect(decide('echo "deploying" && npx cdk deploy Foo')).toBe('deny');
  });

  it('is wired as a PreToolUse hook on the shell tools', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude/settings.json'), 'utf8'));
    const shell = settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === 'Bash|PowerShell');
    expect(shell.hooks.map((h: { command: string }) => h.command)).toContain('node "$CLAUDE_PROJECT_DIR/.claude/hooks/deploy-through-the-guard.js"');
  });

  it('runs every hook from the project root, whatever directory the shell is in', () => {
    // A relative script path resolves against the shell's working directory, so from `backend/` or `frontend/` the
    // hook is not found, the error is non-blocking, and the guard lets every command through unchecked.
    const settings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude/settings.json'), 'utf8'));
    const commands: string[] = Object.values(settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
      .flat().flatMap((entry) => entry.hooks.map((h) => h.command));
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) expect(c).toMatch(/^node "\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/[a-z-]+\.js"$/);
  });
});

describe('the widget publish', () => {
  it('targets this instance\'s Widget stack, the one the widget capability declares', () => {
    expect(widgetStackName('Acme')).toBe('AcmeWidget');
    expect(CAPABILITIES.find((c) => c.name === 'widget')!.stacks).toEqual(['Widget']);
  });

  it('publishes exactly when widget is declared, after both consoles and before the CORS pass', () => {
    expect(consoleContext(['--context', 'capabilities=widget,chat']).widgetEnabled).toBe(true);
    expect(consoleContext(['--context', 'capabilities=chat']).widgetEnabled).toBe(false);
    expect(DEPLOY_STEPS.indexOf('publishWidget')).toBeGreaterThan(DEPLOY_STEPS.indexOf('publishAdmin'));
    expect(DEPLOY_STEPS.indexOf('publishWidget')).toBeLessThan(DEPLOY_STEPS.indexOf('corsPass'));
  });

  it('takes only a stack with the Widget outputs, never a console', () => {
    expect(checkWidgetStackOutputs({ stackName: 'AcmeWidget', outputKeys: ['WidgetDistributionBucketName', 'WidgetDistributionId'] })).toBeNull();
    expect(checkWidgetStackOutputs({ stackName: 'AcmeChatApp', outputKeys: ['DistributionBucketName', 'DistributionId'] })).toMatch(/not a widget stack/);
    expect(checkWidgetStackOutputs({ stackName: 'AcmeWidget', outputKeys: [], stackStatus: 'ROLLBACK_COMPLETE' })).toMatch(/create never succeeded/);
  });
});
