/**
 * A DEPLOY SAYS WHICH DECLARED ASSISTANTS ARE RETIRED IN THE CONSOLE, AND A TEARDOWN REMOVES EVERY IDENTITY
 * (ADR-048, amended 2026-10-23).
 *
 * The deploy scripts print, after a successful deploy, each assistant the deployment declares whose directory
 * entry says a person retired it in the console, because the seed leaves it retired. A teardown removes every
 * identity the directory still records, because no stack owns one.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { declaredAssistantsOf, retiredInTheConsole, reportLines } = require('../scripts/lib/declared-assistants.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assistantIdentitiesToRemove } = require('../scripts/lib/teardown-plan.cjs');
import { resolveDeploymentProfiles } from '../lib/config/profiles';

describe('the deploy report', () => {
  const config = resolveDeploymentProfiles(['basic', 'standard', 'premium', 'ops-premium']);
  const declared = declaredAssistantsOf(config);

  it('names every declared live assistant by the registry\'s naming rule', () => {
    expect(declared).toEqual(expect.arrayContaining([
      { assistantId: 'concierge', classification: 'basic', role: 'primary' },
      { assistantId: 'advisor', classification: 'premium', role: 'primary' },
      { assistantId: 'ops-premium', classification: 'premium', role: 'ops' },
      { assistantId: 'admin-agent', classification: 'admin', role: 'primary' },
    ]));
  });

  it('reports a declared assistant retired in the console, and nothing else', () => {
    const entries = new Map(Object.entries({
      'ops-premium': { classification: 'premium', role: 'ops', origin: 'declared', status: 'retired' },
      advisor: { classification: 'premium', role: 'primary', origin: 'declared', status: 'active' },
      // A console-created assistant's tombstone is not a declaration the deploy left retired.
      'finance-advisor': { classification: 'premium', role: 'primary', origin: 'console', status: 'retired' },
    }));
    const retired = retiredInTheConsole(declared, entries);
    expect(retired.map((d: { assistantId: string }) => d.assistantId)).toEqual(['ops-premium']);
    expect(reportLines(retired).join('\n')).toMatch(/Declared, but retired in the console; a deploy does not recreate it:\n {4}ops-premium \(premium, ops\)/);
  });

  it('prints nothing when nothing declared is retired', () => {
    expect(reportLines(retiredInTheConsole(declared, new Map()))).toEqual([]);
  });
});

describe('a deploy refuses a configuration that would orphan an assistant created in the console', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { consoleAssistantsOrphanedBy, orphanRefusal } = require('../scripts/lib/declared-assistants.cjs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DEPLOY_STEPS } = require('../scripts/lib/deploy-guards.cjs');
  const withoutPremium = resolveDeploymentProfiles(['basic', 'standard']);
  const entries = new Map(Object.entries({
    'finance-advisor': { classification: 'premium', role: 'primary', origin: 'console', status: 'active' },
    builder: { classification: 'premium', role: 'primary', status: 'provisioning' },
    // Declared assistants go with their classification's seed, and a tombstone orphans nothing.
    advisor: { classification: 'premium', role: 'primary', origin: 'declared', status: 'active' },
    gone: { classification: 'premium', role: 'primary', origin: 'console', status: 'retired' },
    keeper: { classification: 'standard', role: 'primary', origin: 'console', status: 'active' },
  }));

  it('names every console-created assistant still active in a classification the configuration drops', () => {
    const orphaned = consoleAssistantsOrphanedBy(withoutPremium, entries);
    expect(orphaned.map((o: { assistantId: string }) => o.assistantId)).toEqual(['builder', 'finance-advisor']);
    expect(orphanRefusal(orphaned)).toMatch(/no longer declares premium, and assistants created in the console are still active there: builder \(premium, primary\), finance-advisor \(premium, primary\)\. .*retire these in the console first .*Nothing was deployed/);
  });

  it('refuses nothing when the configuration still declares the classification', () => {
    expect(orphanRefusal(consoleAssistantsOrphanedBy(resolveDeploymentProfiles(['basic', 'standard', 'premium']), entries))).toBeNull();
  });

  it('runs before the first backend pass of npm run deploy, and before the single-stack deploy', () => {
    expect(DEPLOY_STEPS.indexOf('assertNoOrphanedConsoleAssistants')).toBeGreaterThanOrEqual(0);
    expect(DEPLOY_STEPS.indexOf('assertNoOrphanedConsoleAssistants')).toBeLessThan(DEPLOY_STEPS.indexOf('deployBackend'));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('fs').readFileSync(require('path').join(__dirname, '../scripts/deploy-stack.mjs'), 'utf8');
    expect(src.indexOf('orphanedConsoleAssistantsRefusal({')).toBeGreaterThan(0);
    expect(src.indexOf('orphanedConsoleAssistantsRefusal({')).toBeLessThan(src.indexOf("run('npx', ['cdk', 'deploy'"));
  });
});

describe('a teardown removes every identity the directory records', () => {
  const ROOT = '/ae';
  const p = (name: string, value: unknown) => ({ Name: `${ROOT}/assistant-directory/${name}`, Value: JSON.stringify(value) });

  it('takes active and failed entries of either origin, and leaves a clean tombstone and the locks', () => {
    const out = assistantIdentitiesToRemove([
      p('advisor', { origin: 'declared', status: 'active', botArn: 'bot/a', lexBotId: 'LA' }),
      p('finance-advisor', { origin: 'console', status: 'active', botArn: 'bot/f', lexBotId: 'LF' }),
      p('half-built', { status: 'failed', lexBotId: 'LH', leftover: ['Lex bot LH'] }),
      p('old-advisor', { status: 'retired', botArn: 'bot/o', lexBotId: 'LO', leftover: [] }),
      p('stuck', { status: 'retired', lexBotId: 'LS', leftover: ['Lex bot LS'] }),
      { Name: `${ROOT}/assistant-directory/_build/advisor`, Value: '{}' },
    ], ROOT);
    expect(out).toEqual([
      { assistant: 'advisor', botArn: 'bot/a', lexBotId: 'LA' },
      { assistant: 'finance-advisor', botArn: 'bot/f', lexBotId: 'LF' },
      { assistant: 'half-built', lexBotId: 'LH' },
      { assistant: 'stuck', lexBotId: 'LS' },
    ]);
  });
});
