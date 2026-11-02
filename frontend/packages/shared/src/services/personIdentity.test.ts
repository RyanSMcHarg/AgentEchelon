/**
 * The person's identity is the ARN the exchange returned, asked once per session, and an answer that
 * arrives after the session ended is discarded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { exchange } = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock('./credentialExchange', () => ({ exchangeCredentials: exchange }));

import { resolvePersonIdentity, IdentitySupersededError } from './personIdentity';
import { endSessionEpoch } from './sessionEpoch';

const INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/i';
const PERSON_ID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const answer = (userArn = `${INSTANCE}/user/${PERSON_ID}`, consoleRole: unknown = undefined) => ({
  credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' },
  userArn,
  ...(consoleRole !== undefined ? { consoleRole } : {}),
});

beforeEach(() => {
  exchange.mockReset();
  endSessionEpoch();
});

describe('resolvePersonIdentity', () => {
  it('reads the id from the ARN the exchange returned', async () => {
    exchange.mockResolvedValue(answer());
    await expect(resolvePersonIdentity('token')).resolves.toEqual({
      userArn: `${INSTANCE}/user/${PERSON_ID}`,
      personId: PERSON_ID,
      consoleRole: null,
    });
    expect(exchange).toHaveBeenCalledWith({}, 'token');
  });

  it('carries the console role the exchange reports', async () => {
    exchange.mockResolvedValue(answer(undefined, 'admins'));
    await expect(resolvePersonIdentity('token')).resolves.toMatchObject({ consoleRole: 'admins' });
  });

  it('asks once per session, and again in the next one', async () => {
    exchange.mockResolvedValue(answer());
    await resolvePersonIdentity('token');
    await resolvePersonIdentity('token');
    expect(exchange).toHaveBeenCalledTimes(1);
    endSessionEpoch();
    await resolvePersonIdentity('token');
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it('refuses an answer that names no person', async () => {
    exchange.mockResolvedValue(answer(`${INSTANCE}/bot/assistant`));
    await expect(resolvePersonIdentity('token')).rejects.toThrow(/no person ARN/);
  });

  it('discards an answer that arrives after the session ended', async () => {
    let release!: (v: unknown) => void;
    exchange.mockReturnValue(new Promise((r) => { release = r; }));
    const pending = resolvePersonIdentity('token');
    endSessionEpoch();
    release(answer());
    await expect(pending).rejects.toBeInstanceOf(IdentitySupersededError);
  });

  it('does not cache a failure', async () => {
    exchange.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(answer());
    await expect(resolvePersonIdentity('token')).rejects.toThrow('offline');
    await expect(resolvePersonIdentity('token')).resolves.toMatchObject({ personId: PERSON_ID });
  });
});
