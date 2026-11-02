/**
 * CLEARANCE RESOLUTION HAS EXACTLY ONE PROVIDER-SPECIFIC STEP, AND IT IS BEHIND A SEAM.
 *
 * Owner decision 2026-09-14. `lib/user-clearance.ts` called `AdminListGroupsForUser`
 * directly on the live request path for the router and the channel flow, while
 * IDENTITY-PROVIDER-GUIDE said the platform never enforces on Cognito-specific signals - and Step 7
 * of the same guide told integrators to mirror their claim into a Cognito group. The guide
 * contradicted itself because the code had no seam to describe.
 *
 * ── WHAT THESE TESTS PIN, AND WHY IT IS NOT JUST "AN INTERFACE EXISTS" ──────────────────────────
 *
 * The seam is only worth anything if the DIVISION is right. The adapter answers "which groups does
 * this subject hold"; what those groups MEAN stays with the registry, which is provider-neutral. An
 * adapter that returned a classification would move policy into the directory - the deployment
 * decides what a group means, not the IdP - so that division is the thing under test, not the shape
 * of the interface.
 */
import type { ClearanceSource } from '../../lambda/src/lib/clearance-source';
import * as fs from 'fs';
import * as path from 'path';

const src = (rel: string) =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', rel), 'utf8');

/** A person, as the directory is asked about them: by AppInstanceUser ARN. */
const person = (id: string) => `arn:aws:chime:us-east-1:111122223333:app-instance/test/user/${id}`;

/** A source that reports whatever groups a test wants, with no AWS anywhere near it. */
function sourceOf(groups: string[] | Error): ClearanceSource {
  return {
    name: 'test',
    groupsFor: async () => {
      if (groups instanceof Error) throw groups;
      return groups;
    },
  };
}

describe('the provider is replaceable without touching what a group means', () => {
  let mod: typeof import('../../lambda/src/lib/user-clearance');

  beforeEach(() => {
    jest.resetModules();
    process.env.USER_POOL_ID = 'pool-1';
    process.env.ABUSE_EXEMPT_ADMINS = 'false';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('../../lambda/src/lib/user-clearance');
  });

  it('resolves a non-Cognito provider through the same registry rules', async () => {
    // The whole point: a deployment on another IdP implements one method, and everything above the
    // seam - the grant-set union and the token resolution - is unchanged.
    mod.__setClearanceSourceForTests(sourceOf(['premium']));
    expect((await mod.resolveUserClearance(person('u1'))).clearance).toBe('premium');

    mod.__setClearanceSourceForTests(sourceOf(['admins']));
    expect((await mod.resolveUserClearance(person('u2'))).clearance).toBe('admin');
  });

  it('applies the grant-set union, not a highest single group', async () => {
    // basic + premium is named by `premium` (its grants ARE that union), which a single group and a set
    // happen to agree on. The case that distinguishes them is covered in profile-registry.test.ts;
    // what matters here is that the SEAM did not quietly change which resolver runs.
    mod.__setClearanceSourceForTests(sourceOf(['basic', 'premium']));
    expect((await mod.resolveUserClearance(person('u3'))).clearance).toBe('premium');
  });

  it('resolves to nothing when the provider throws, never to a guess', async () => {
    mod.__setClearanceSourceForTests(sourceOf(new Error('directory unreachable')));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { clearance, isAdmin } = await mod.resolveUserClearance(person('u4'));
    // ADR-046: there is no floor. An unresolvable clearance is `undefined`, and every caller refuses
    // rather than substituting - the credential exchange vends nothing, the router raises a
    // SecurityEvent. Asserted directly, because these tests used to compare against
    // `defaultProfileRegistry.failClosedValue`, a property that decision deleted: the comparison
    // still passed, as `undefined`, while the test name promised a floor that no longer exists.
    expect(clearance).toBeUndefined();
    expect(isAdmin).toBe(false);
    // And the log names WHICH provider failed, so an outage is attributable.
    expect(warn.mock.calls.flat().join(' ')).toMatch(/test source failed/);
    warn.mockRestore();
  });

  it('treats "holds no group" as a real answer, distinct from "could not ask"', async () => {
    // Both resolve to nothing, but for different reasons, and conflating them is how fail-open bugs
    // start. An empty array must not throw and must not be read as an error.
    mod.__setClearanceSourceForTests(sourceOf([]));
    const err = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { clearance } = await mod.resolveUserClearance(person('u5'));
    expect(clearance).toBeUndefined();
    // No provider failure was logged: nothing went wrong, the person simply holds nothing.
    expect(err.mock.calls.flat().join(' ')).not.toMatch(/failed to resolve/);
    err.mockRestore();
  });

  it('resolves to nothing when the deployment configures no provider at all', async () => {
    mod.__setClearanceSourceForTests(null);
    expect((await mod.resolveUserClearance(person('u6'))).clearance).toBeUndefined();
  });
});

describe('the division of responsibility survives', () => {
  it('keeps the provider call out of the clearance module entirely', () => {
    const clearance = src('lib/user-clearance.ts');
    expect(`calls the directory directly: ${/AdminListGroupsForUserCommand/.test(clearance)}`)
      .toBe('calls the directory directly: false');
    expect(clearance).toMatch(/from '\.\/clearance-source\.js'/);
  });

  it('keeps POLICY out of the adapter: it returns groups, never a classification', () => {
    // The mistake this seam exists to prevent. An adapter that answered "premium" would put the
    // deployment's own policy inside the directory integration, and a second adapter would then be
    // free to disagree about what a group means.
    const adapter = src('lib/clearance-source.ts');
    expect(adapter).toMatch(/groupsFor\(subject: string\): Promise<string\[\]>/);
    // COMMENTS STRIPPED FIRST. The file's own header explains what is deliberately NOT behind the
    // seam, and names the registry resolvers to do it - so a scan over raw text matches the prose
    // that exists to prevent the very thing being scanned for.
    const code = adapter
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(`adapter resolves classifications: ${/resolveHolderToken|grantsFor/.test(code)}`)
      .toBe('adapter resolves classifications: false');
    // And it does not import the registry at all, which is the structural half of the same claim.
    expect(`adapter imports the registry: ${/profile-registry/.test(code)}`)
      .toBe('adapter imports the registry: false');
  });

  it('and the guide no longer claims a neutrality the code did not have', () => {
    const guide = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'docs', 'guides', 'user', 'IDENTITY-PROVIDER-GUIDE.md'), 'utf8');
    expect(`still claims never-on-Cognito-signals: ${/never on Cognito-specific signals/.test(guide)}`)
      .toBe('still claims never-on-Cognito-signals: false');
    expect(guide).toMatch(/ClearanceSource/);
  });
});

/**
 * THE WHOLE TREE ASKS THE POOL THROUGH ITS ADAPTERS, and nowhere else.
 *
 * A person is their AppInstanceUser, and what a pool knows about them is reached by person through
 * `Directory` (`lib/membership-source.ts`): their subject through `Identities`, then the pool's adapter.
 * A handler that reads the pool itself keys the person on a pool username or `sub`, which is what an
 * opaque person id exists to stop, and it reaches nobody of another issuer. So the four pool reads are
 * refused anywhere in `backend/lambda` but the adapters.
 */
describe('a pool is read only through its adapters', () => {
  const LAMBDA = path.join(__dirname, '..', '..', 'lambda');
  const READS = ['AdminListGroupsForUserCommand', 'ListUsersInGroupCommand', 'AdminGetUserCommand', 'ListUsersCommand'];
  /** The adapters, and the one handler that is the pool's own trigger. Each entry says why. */
  const ALLOWED: Record<string, string> = {
    'src/lib/clearance-source.ts': 'THE clearance adapter: the groups a subject holds.',
    'src/lib/cognito-pool-directory.ts': 'THE pool adapter: group members, a record, an address lookup, the console listing.',
    'cognito-triggers/post-confirmation.js':
      'A trigger of the pool itself, invoked by Cognito for one of its own users before that user has signed in, '
      + 'so there is no person to resolve yet; it reads the groups of the user the event names and nothing else.',
  };

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts')
        && !(e.name.endsWith('.js') && fs.existsSync(p.slice(0, -3) + '.ts'))) files.push(p);
    }
  };
  walk(LAMBDA);
  const rel = (f: string) => path.relative(LAMBDA, f).split(path.sep).join('/');
  const callers = (cmd: string) => files
    .filter((f) => new RegExp(`new\\s+${cmd}\\s*\\(`).test(fs.readFileSync(f, 'utf8')))
    .map(rel)
    .sort();

  for (const cmd of READS) {
    it(`refuses ${cmd} outside the adapters`, () => {
      const outside = callers(cmd).filter((f) => !ALLOWED[f]);
      if (outside.length) {
        throw new Error(`\n\n${cmd} read outside the pool adapters:\n  ${outside.join('\n  ')}\n\n`
          + 'Ask the directory by person (Directory in lib/membership-source.ts), or the pool adapter '
          + '(lib/cognito-pool-directory.ts) for the console that administers the pool.\n');
      }
      expect(outside).toEqual([]);
    });
  }

  it('is not vacuous: the adapters make the reads it polices', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(callers('AdminListGroupsForUserCommand')).toContain('src/lib/clearance-source.ts');
    expect(callers('ListUsersInGroupCommand')).toEqual(['src/lib/cognito-pool-directory.ts']);
    expect(callers('AdminGetUserCommand')).toEqual(['src/lib/cognito-pool-directory.ts']);
    expect(callers('ListUsersCommand')).toEqual(['src/lib/cognito-pool-directory.ts']);
  });

  it('has no stale allowance', () => {
    const used = new Set(READS.flatMap(callers));
    expect(Object.keys(ALLOWED).filter((f) => !used.has(f))).toEqual([]);
  });
});

/**
 * AN ADAPTER IS CONSTRUCTED ONLY IN THE SEAM FACTORY (C1).
 *
 * Each trusted issuer's directory adapter and clearance source are chosen once, from the registry, by
 * `lib/issuer-seams.ts`; every consumer asks `Directory`, which uses what the factory chose. A handler that
 * built its own pool adapter would read one pool by its own configuration, reach nobody of another issuer,
 * and escape the stub a test selects. So constructing any adapter or source is refused in `backend/lambda`
 * outside the factory and the files that define them.
 */
describe('an adapter is constructed only in the seam factory', () => {
  const LAMBDA = path.join(__dirname, '..', '..', 'lambda');
  const CONSTRUCTORS = [
    'cognitoPoolDirectory', 'new CognitoClearanceSource', 'claimsDirectory', 'cognitoAdapter', 'claimsAdapter', 'noDirectory',
    'groupsClearanceSource', 'mappingClearanceSource', 'fixedClearanceSource', 'oneChannelClearanceSource',
  ];
  /** Where a construction may stand, each with why. */
  const ALLOWED: Record<string, string> = {
    'src/lib/issuer-seams.ts': 'THE seam factory: one adapter and one source per registry entry, chosen once.',
    'src/lib/cognito-pool-directory.ts': 'Defines the pool adapter.',
    'src/lib/clearance-source.ts': 'Defines the clearance sources.',
    'src/lib/claims-directory.ts': 'Defines the claims adapter.',
  };
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts')
        && !(e.name.endsWith('.js') && fs.existsSync(p.slice(0, -3) + '.ts'))) files.push(p);
    }
  };
  walk(LAMBDA);
  const rel = (f: string) => path.relative(LAMBDA, f).split(path.sep).join('/');
  /** Code with comments removed, so prose naming a constructor is not a construction. */
  const code = (f: string) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /** A call of the constructor, never its definition (`function name(`) or a property of the same name. */
  const callOf = (name: string) => new RegExp(`(?<![\\w.])(?<!function\\s)${name.replace(' ', '\\s+')}\\s*\\(`);
  const constructs = (name: string) => files
    .filter((f) => callOf(name).test(code(f)))
    .map(rel)
    .sort();

  for (const name of CONSTRUCTORS) {
    it(`refuses ${name}(...) outside the seam factory`, () => {
      const outside = constructs(name).filter((f) => !ALLOWED[f]);
      if (outside.length) {
        throw new Error(`\n\n${name} constructed outside the seam factory:\n  ${outside.join('\n  ')}\n\n`
          + 'Ask the directory (defaultDirectory() in lib/membership-source.ts), or for the console that '
          + 'administers a pool, poolAdapter / poolGroups from lib/issuer-seams.ts.\n');
      }
      expect(outside).toEqual([]);
    });
  }

  it('is not vacuous: the factory constructs each adapter and source it polices', () => {
    const factory = code(path.join(LAMBDA, 'src', 'lib', 'issuer-seams.ts'));
    for (const name of CONSTRUCTORS) expect(`${name}: ${callOf(name).test(factory)}`).toBe(`${name}: true`);
  });

  it('every consumer of a person asks the directory it is handed, and the directory is built from the registry', () => {
    const ms = code(path.join(LAMBDA, 'src', 'lib', 'membership-source.ts'));
    expect(ms).toMatch(/issuers:\s*trustedIssuers\(\)|trustedIssuers\(\)/);
    expect(ms).toMatch(/selectedSeams\(\)/);
    for (const consumer of ['group-membership-reconcile.ts', 'typed-conversation-from-event.ts', 'membership-audit.ts', 'assistant-ownership.ts',
      'admin-notification-channel-provision.ts', 'admin-conversation-sync.ts', 'router-agent-handler.ts', 'lib/user-clearance.ts', 'lib/assistant-scope.ts']) {
      expect(`${consumer}: ${/defaultDirectory\(\)/.test(code(path.join(LAMBDA, 'src', consumer)))}`).toBe(`${consumer}: true`);
    }
  });
});
