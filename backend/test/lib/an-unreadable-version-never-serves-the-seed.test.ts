/**
 * AN UNREADABLE VERSION NEVER SERVES THE SEED (SPEC-PORTABLE-PROFILES FR6).
 *
 * The compiled seed carries no tool allowlist (`tools` undefined offers every runtime tool) and no guardrail selection
 * (only the deployment default applies), so it is wider than any approved version. It serves only a profile with NO
 * active version. A version that exists and cannot be read (a throttled or denied parameter read, an unreadable body, a
 * definition that does not validate):
 *  - is read again while the failure is transient (a throttle, a timeout), and only then;
 *  - still unreadable, is answered by the last version this container read for the profile, for a few seconds only;
 *  - with none, throws `ProfileVersionUnreadableError`, which the turn processor answers with its degraded reply.
 * A pinned version (`resolveProfileVersion`, the version the vend narrowed the session by) is never answered by the
 * label or the seed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  resolveActiveProfile,
  resolveProfileVersion,
  ProfileVersionUnreadableError,
  PROFILE_DEFINITION_SCHEMA_VERSION,
  __clearActiveProfileCache,
} from '../../lambda/src/lib/active-profile';

const SSM_ROOT = '/agent-echelon';
const throttled = () => Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
const notFound = () => Object.assign(new Error('not found'), { name: 'ParameterNotFound' });

/** An approved version: one tool, its own guardrail. */
const APPROVED = JSON.stringify({
  schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
  profileName: 'analyst',
  modelKey: 'sonnet',
  tools: ['load_company_context'],
  guardrailId: 'strict',
  configId: 'approved0001',
});

/** A fake SSM whose answer to each read is the next entry of `answers` (the last one repeats). */
function ssmAnswering(answers: Array<() => unknown>) {
  let i = 0;
  const send = jest.fn(async (_cmd: GetParameterCommand) => {
    const answer = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return answer();
  });
  return { send } as unknown as import('@aws-sdk/client-ssm').SSMClient & { send: jest.Mock };
}
const value = (v: string, version = 3) => () => ({ Parameter: { Value: v, Version: version } });
const fail = (e: () => Error) => () => { throw e(); };

beforeEach(() => __clearActiveProfileCache());

describe('the active version, when it cannot be read', () => {
  it('a throttled read of a versioned profile never yields every tool or no guardrail: the turn is refused', async () => {
    const ssm = ssmAnswering([fail(throttled)]);
    const read = resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT, retryDelayMs: 0 });
    await expect(read).rejects.toBeInstanceOf(ProfileVersionUnreadableError);
    await expect(read).rejects.toMatchObject({ profileName: 'analyst' });
    // A throttle is transient: read, then twice more.
    expect(ssm.send).toHaveBeenCalledTimes(3);
  });

  it('a failure that answers the same every time is not read again', async () => {
    const denied = () => Object.assign(new Error('denied'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 400 } });
    const ssm = ssmAnswering([fail(denied)]);
    await expect(resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT, retryDelayMs: 0 })).rejects.toBeInstanceOf(ProfileVersionUnreadableError);
    expect(ssm.send).toHaveBeenCalledTimes(1);
  });

  it('answers the rest of a turn from memory, and the next turn reads again', async () => {
    let clock = 1_000;
    const ssm = ssmAnswering([fail(throttled)]);
    const opts = { ssm, ssmRoot: SSM_ROOT, now: () => clock, retryDelayMs: 0 };
    await expect(resolveActiveProfile('analyst', opts)).rejects.toBeInstanceOf(ProfileVersionUnreadableError);
    const reads = ssm.send.mock.calls.length;
    await expect(resolveActiveProfile('analyst', opts)).rejects.toBeInstanceOf(ProfileVersionUnreadableError);
    expect(ssm.send.mock.calls.length).toBe(reads);
    clock += 10_000;
    await expect(resolveActiveProfile('analyst', opts)).rejects.toBeInstanceOf(ProfileVersionUnreadableError);
    expect(ssm.send.mock.calls.length).toBeGreaterThan(reads);
  });

  it('a definition that does not validate is refused the same way, never answered by the seed', async () => {
    for (const raw of ['not json at all', JSON.stringify({ schemaVersion: 99, profileName: 'analyst', modelKey: 'x' })]) {
      __clearActiveProfileCache();
      const ssm = ssmAnswering([value(raw)]);
      await expect(resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT, retryDelayMs: 0 })).rejects.toBeInstanceOf(ProfileVersionUnreadableError);
    }
  });

  it('a read that succeeds on the retry serves the version', async () => {
    const ssm = ssmAnswering([fail(throttled), value(APPROVED)]);
    const r = await resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT, retryDelayMs: 0 });
    expect(r).toMatchObject({ configId: 'approved0001', tools: ['load_company_context'], guardrailId: 'strict' });
  });

  it('serves the last version read when the version becomes unreadable, and does not cache that answer', async () => {
    let clock = 1_000;
    const ssm = ssmAnswering([value(APPROVED), fail(throttled)]);
    const opts = { ssm, ssmRoot: SSM_ROOT, ttlMs: 100, now: () => clock, retryDelayMs: 0 };
    expect((await resolveActiveProfile('analyst', opts)).configId).toBe('approved0001');
    clock += 200; // the cached resolution has expired; the next read fails
    const served = await resolveActiveProfile('analyst', opts);
    expect(served).toMatchObject({ configId: 'approved0001', tools: ['load_company_context'], guardrailId: 'strict' });
    const reads = ssm.send.mock.calls.length;
    // Not cached as a success: once the short memo lapses, the next turn reads again.
    clock += 200;
    await resolveActiveProfile('analyst', opts);
    expect(ssm.send.mock.calls.length).toBeGreaterThan(reads);
  });

  it('the seed answers only a profile with no active version', async () => {
    const ssm = ssmAnswering([fail(notFound)]);
    const r = await resolveActiveProfile('analyst', { ssm, ssmRoot: SSM_ROOT, retryDelayMs: 0 });
    expect(r.configId).toBe('seed');
    expect(r.tools).toBeUndefined();
    // No retry on the expected answer.
    expect(ssm.send).toHaveBeenCalledTimes(1);
  });

  it('a seed resolution is never the stand-in for a version activated since', async () => {
    let clock = 1_000;
    const ssm = ssmAnswering([fail(notFound), fail(throttled)]);
    const opts = { ssm, ssmRoot: SSM_ROOT, ttlMs: 100, now: () => clock, retryDelayMs: 0 };
    expect((await resolveActiveProfile('analyst', opts)).configId).toBe('seed');
    clock += 200;
    await expect(resolveActiveProfile('analyst', opts)).rejects.toBeInstanceOf(ProfileVersionUnreadableError);
  });
});

describe('the pinned version, when it cannot be read', () => {
  it('is refused rather than answered by the label or the seed', async () => {
    const ssm = ssmAnswering([fail(throttled)]);
    const read = resolveProfileVersion('analyst', 2, { ssm, ssmRoot: SSM_ROOT, retryDelayMs: 0 });
    await expect(read).rejects.toBeInstanceOf(ProfileVersionUnreadableError);
    await expect(read).rejects.toMatchObject({ profileName: 'analyst', version: 2 });
    // Only the pinned version was asked for; the label was never read.
    for (const [cmd] of ssm.send.mock.calls) expect((cmd as GetParameterCommand).input.Name).toBe(`${SSM_ROOT}/assistant/analyst/definition:2`);
  });

  it('serves the pinned version when the retry reads it', async () => {
    const ssm = ssmAnswering([fail(throttled), value(APPROVED, 2)]);
    const r = await resolveProfileVersion('analyst', 2, { ssm, ssmRoot: SSM_ROOT, retryDelayMs: 0 });
    expect(r).toMatchObject({ configId: 'approved0001', version: 2, tools: ['load_company_context'] });
  });
});

describe('the turn processor answers a refused resolution with its degraded reply', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'assistant-async-processor.ts'), 'utf8');
  it('resolves the turn\'s version inside the try whose catch posts the turnFailed notice', () => {
    const handlerStart = code.indexOf('export const handler = async');
    const tryAt = code.indexOf('\n  try {', handlerStart);
    const resolveAt = code.indexOf('await resolveProfileVersion(turnProfileName', tryAt);
    const catchAt = code.indexOf('} catch (error) {\n    await handleProcessingError(event, error, turnCopy);', resolveAt);
    expect(handlerStart).toBeGreaterThan(-1);
    expect(tryAt).toBeGreaterThan(handlerStart);
    expect(resolveAt).toBeGreaterThan(tryAt);
    expect(catchAt).toBeGreaterThan(resolveAt);
    // No catch in between swallows it into a wider profile.
    expect(code.slice(resolveAt, resolveAt + 300)).not.toMatch(/\.catch\(/);
    const core = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'lib', 'async-processor-core.ts'), 'utf8');
    const errorPath = core.slice(core.indexOf('export async function handleProcessingError'), core.indexOf('export async function sendProcessorErrorAlert'));
    expect(errorPath).toContain("noticeLine(copy, 'turnFailed')");
  });
});
