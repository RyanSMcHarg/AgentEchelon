/**
 * A demo reset returns a deployment to where the demo started: it retires the assistants the console
 * created during the demo and leaves everything the deployment declares exactly as the deploy made it.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assistantsToRetire, parseResetArgs } = require('../scripts/lib/reset-demo.cjs');

const SINCE = new Date('2026-10-27T09:00:00Z');
const entry = (over: Record<string, unknown>) => ({
  classification: 'premium', status: 'active', origin: 'console', createdAt: '2026-10-27T10:00:00Z', ...over,
});

describe('which assistants a demo reset retires', () => {
  it('retires an assistant the console created during the demo', () => {
    expect(assistantsToRetire([['finance-advisor', entry({})]], SINCE).map((a: { name: string }) => a.name))
      .toEqual(['finance-advisor']);
  });

  it('keeps every declared assistant, whenever its deploy wrote it', () => {
    expect(assistantsToRetire([['analyst', entry({ origin: 'declared' })]], SINCE)).toEqual([]);
  });

  it('keeps an assistant created before the demo began', () => {
    expect(assistantsToRetire([['older', entry({ createdAt: '2026-10-26T10:00:00Z' })]], SINCE)).toEqual([]);
  });

  it('leaves an experiment alt to its experiment, and a tombstone as it is', () => {
    expect(assistantsToRetire([
      ['alt-primary-premium', entry({ occupancy: 'alt' })],
      ['gone', entry({ status: 'retired' })],
    ], SINCE)).toEqual([]);
  });

  it('retires a create that failed or is still building, so its name and leftovers are released', () => {
    expect(assistantsToRetire([['a', entry({ status: 'failed' })], ['b', entry({ status: 'provisioning' })]], SINCE)).toHaveLength(2);
  });

  it('treats an entry with no recorded origin as console-created, as the console does', () => {
    expect(assistantsToRetire([['legacy', entry({ origin: undefined })]], SINCE)).toHaveLength(1);
  });
});

describe('the options a reset runs with', () => {
  it('requires the demo window and defaults to a dry run over the demo cast', () => {
    expect(() => parseResetArgs([])).toThrow(/--since/);
    expect(() => parseResetArgs(['--since=yesterday'])).toThrow(/not a time/);
    const opts = parseResetArgs(['--since=2026-10-27T09:00:00Z']);
    expect(opts).toMatchObject({ apply: false, assistants: true, conversations: true, secret: 'agent-interface/demo-credentials' });
  });

  it('applies only when asked, and can leave either half alone', () => {
    expect(parseResetArgs(['--since=2026-10-27T09:00:00Z', '--apply', '--skip-conversations']))
      .toMatchObject({ apply: true, assistants: true, conversations: false });
  });
});
