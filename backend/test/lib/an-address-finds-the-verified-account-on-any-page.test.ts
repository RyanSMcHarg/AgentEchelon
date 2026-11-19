/**
 * AN ADDRESS FINDS THE ACCOUNT THAT HOLDS IT VERIFIED, HOWEVER MANY ACCOUNTS CLAIM IT.
 *
 * Anyone can register an account naming any address, which the pool marks unverified. The address lookup reads every
 * page the pool returns for the address, so the one verified, enabled account is found wherever it falls, and a lookup
 * still finds exactly one or nobody.
 */
import { ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { cognitoPoolDirectory, ADDRESS_LOOKUP_MAX_PAGES } from '../../lambda/src/lib/cognito-pool-directory';
import { cognitoAdapter } from '../../lambda/src/lib/issuer-seams';

const ADDRESS = 'alice@corp.example';
const POOL = 'us-east-1_TestPool';

type User = { Username: string; Enabled: boolean; Attributes: Array<{ Name: string; Value: string }> };
const account = (sub: string, verified: boolean, enabled = true): User => ({
  Username: sub,
  Enabled: enabled,
  Attributes: [{ Name: 'sub', Value: sub }, { Name: 'email', Value: ADDRESS }, { Name: 'email_verified', Value: String(verified) }],
});
const claims = (n: number, from = 0) => Array.from({ length: n }, (_, i) => account(`mallory-${from + i}`, false));

/** A pool answering the address filter in pages of 60, recording each request. */
function poolOf(users: User[]) {
  const requests: Array<{ Filter?: string; Limit?: number; PaginationToken?: string }> = [];
  const client = {
    send: async (cmd: unknown) => {
      if (!(cmd instanceof ListUsersCommand)) throw new Error('unexpected command');
      const input = cmd.input;
      requests.push({ Filter: input.Filter, Limit: input.Limit, PaginationToken: input.PaginationToken });
      const start = input.PaginationToken ? Number(input.PaginationToken) : 0;
      const end = start + (input.Limit ?? 60);
      return { Users: users.slice(start, end), ...(end < users.length ? { PaginationToken: String(end) } : {}) };
    },
  };
  return { client, requests };
}

const subjectsFor = async (users: User[]) => {
  const { client, requests } = poolOf(users);
  const adapter = cognitoAdapter('deployment', cognitoPoolDirectory(POOL, client), {} as never);
  const found = await adapter.subjectsByAddress!(ADDRESS);
  return { subjects: found.map((s) => s.subject), requests };
};

describe('an address lookup reads every page the pool returns for it', () => {
  it('finds the verified account behind 130 accounts that only claim the address', async () => {
    const { subjects, requests } = await subjectsFor([...claims(130), account('alice', true)]);
    expect(subjects).toEqual(['alice']);
    expect(requests).toHaveLength(3);
    // Every page asks for the same address, and each page after the first carries the token the one before returned.
    expect(requests.every((r) => r.Filter === `email = "${ADDRESS}"`)).toBe(true);
    expect(requests.map((r) => r.PaginationToken)).toEqual([undefined, '60', '120']);
  });

  it('finds the verified account wherever it falls among the claims', async () => {
    const { subjects } = await subjectsFor([...claims(61), account('alice', true), ...claims(70, 61)]);
    expect(subjects).toEqual(['alice']);
  });

  it('reads one page when the address fits on one', async () => {
    const { subjects, requests } = await subjectsFor([account('mallory', false), account('alice', true)]);
    expect(subjects).toEqual(['alice']);
    expect(requests).toHaveLength(1);
  });

  it('two verified accounts on different pages are both found, so the lookup stays ambiguous', async () => {
    const { subjects } = await subjectsFor([account('alice', true), ...claims(100), account('alice-2', true)]);
    expect(subjects).toEqual(['alice', 'alice-2']);
  });

  it('a disabled account holding the address verified is found by nothing', async () => {
    const { subjects } = await subjectsFor([...claims(70), account('alice', true, false)]);
    expect(subjects).toEqual([]);
  });

  it('past its bound the lookup throws rather than answer from a partial list', async () => {
    const { client, requests } = poolOf([...claims(60 * ADDRESS_LOOKUP_MAX_PAGES), account('alice', true)]);
    await expect(cognitoPoolDirectory(POOL, client).byEmail(ADDRESS)).rejects.toMatchObject({ name: 'AddressLookupBoundExceeded' });
    expect(requests).toHaveLength(ADDRESS_LOOKUP_MAX_PAGES);
  });

  it('an address the filter grammar cannot carry asks the pool nothing', async () => {
    const { client, requests } = poolOf([account('alice', true)]);
    expect(await cognitoPoolDirectory(POOL, client).byEmail('a"b@corp.example')).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});
