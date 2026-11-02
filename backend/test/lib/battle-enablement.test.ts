/**
 * MAY A DUEL RUN HERE: capability AND policy, in that order (ADR-049).
 *
 * THE DEFECT THIS EXISTS FOR. `battleEligible` on the assistant profile answered both questions with
 * one value, and the two answers disagreed: it was `true` for basic, whose stack sets
 * `battleCapable: false` and therefore wires no battle plumbing at all. `channel-battle.ts` gated the
 * ENABLE on it, so Battle Mode could be switched on for a basic channel and the duel then had no
 * battle-state grant and no orchestrator invoke to run with. The surface promised what the IAM role
 * could not back, which is the failure `attachmentsReadable` records from 2026-09-12.
 *
 * So the cases below are about the ORDER. Policy can never widen what the deployment built, and a
 * classification that is not capable must be refused before its parameter is even read.
 */
const send = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send })) };
});

import {
  isBattleCapable,
  isBattleOn,
  canRunBattle,
  battleOnParamName,
  __clearBattleEnablementCache,
} from '../../lambda/src/lib/battle-enablement';

function paramNotFound(): never {
  const e = new Error('nf') as Error & { name: string };
  e.name = 'ParameterNotFound';
  throw e;
}

beforeEach(() => {
  send.mockReset();
  __clearBattleEnablementCache();
});

describe('capability: what the deployment wired', () => {
  it('basic is NOT capable, which is the case the old flag got wrong', () => {
    // The whole point. basic's stack builds no battle plumbing, and now nothing claims otherwise.
    expect(isBattleCapable('basic')).toBe(false);
  });

  it('standard and premium are capable', () => {
    expect(isBattleCapable('standard')).toBe(true);
    expect(isBattleCapable('premium')).toBe(true);
  });

  it('the admin plane is never capable, and neither is a classification nobody declared', () => {
    // An admin-plane classification holds no conversations to duel in, so a flag could not make it
    // capable; an unknown value must not become capable by being misspelled into existence.
    expect(isBattleCapable('admin')).toBe(false);
    expect(isBattleCapable('bogus')).toBe(false);
    expect(isBattleCapable(null)).toBe(false);
    expect(isBattleCapable(undefined)).toBe(false);
  });
});

describe('policy: whether an operator turned it on', () => {
  it('is OFF when nothing has been written, rather than on by default', async () => {
    // Battle is "typically only used for internal users". A deployment that has
    // not asked for it does not get a second assistant appearing in somebody's conversation.
    send.mockImplementation(async () => paramNotFound());
    expect(await isBattleOn('premium')).toBe(false);
  });

  it('is ON once the parameter says so, read from the per-classification key', async () => {
    const names: string[] = [];
    send.mockImplementation(async (cmd: { input: { Name: string } }) => {
      names.push(cmd.input.Name);
      return { Parameter: { Value: 'true' } };
    });
    expect(await isBattleOn('premium')).toBe(true);
    expect(names).toEqual([battleOnParamName('premium')]);
  });

  it('treats anything that is not exactly "true" as off', async () => {
    send.mockImplementation(async () => ({ Parameter: { Value: 'TRUE' } }));
    expect(await isBattleOn('premium')).toBe(false);
  });

  it('FAILS CLOSED when the parameter cannot be read', async () => {
    // "We could not tell" and "it is on" must never be the same answer for a feature that puts a
    // second assistant into a conversation. An AccessDenied here means battle is off, not that the
    // gate is skipped.
    send.mockImplementation(async () => {
      const e = new Error('denied') as Error & { name: string };
      e.name = 'AccessDeniedException';
      throw e;
    });
    expect(await isBattleOn('premium')).toBe(false);
  });
});

describe('the order: capability is asked first', () => {
  it('never reads the parameter for a classification that is not capable', async () => {
    // NOT AN OPTIMIZATION - it is the guarantee. A parameter written by hand for `basic` must not be
    // able to turn on a feature whose grants that classification does not have.
    send.mockImplementation(async () => ({ Parameter: { Value: 'true' } }));
    expect(await isBattleOn('basic')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('canRunBattle requires BOTH halves', async () => {
    send.mockImplementation(async () => ({ Parameter: { Value: 'true' } }));
    // capable + on
    expect(await canRunBattle('premium')).toBe(true);
    __clearBattleEnablementCache();
    // not capable, however the policy reads
    expect(await canRunBattle('basic')).toBe(false);

    // capable but off
    __clearBattleEnablementCache();
    send.mockImplementation(async () => paramNotFound());
    expect(await canRunBattle('standard')).toBe(false);
  });
});

describe('caching', () => {
  it('reads once per classification inside the TTL, and keeps classifications apart', async () => {
    send.mockImplementation(async (cmd: { input: { Name: string } }) => ({
      Parameter: { Value: cmd.input.Name.includes('/premium/') ? 'true' : 'false' },
    }));
    expect(await isBattleOn('premium')).toBe(true);
    expect(await isBattleOn('premium')).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);

    // A second classification is a separate answer, not the first one reused.
    expect(await isBattleOn('standard')).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
