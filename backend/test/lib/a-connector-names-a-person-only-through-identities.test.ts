/**
 * A CONNECTOR NAMES A PERSON ONLY THROUGH `Identities`, NEVER BY EMAIL (K1, K2), AND ADMITS THEM ONLY
 * AT THE NARROWER OF TWO LIMITS (K4).
 *
 *  - The vendor adapters hand over the vendor's immutable user id and nothing else: an address in any
 *    field of the event names nobody, even one a real person holds.
 *  - The id resolves under the connector's namespace (`personIssuer`, else its own id), through the
 *    read-only `Identities` resolver; no row is `unresolved` (an invitation, which is NOT BUILT), except
 *    under a `provisioned-only` issuer, where the person is pre-assigned through the connector subject
 *    provisioner and reported `pending`: admitted nowhere until their first sign-in (P-13, V8).
 *  - A resolved person is admitted only when their clearance, within their issuers' classifications, reaches
 *    the connector's classification; a clearance that cannot be read admits nobody.
 *  - And only when one of their sign-ins is active at its issuer, asked now (SPEC-CREDENTIAL-EXCHANGE §4b):
 *    a disabled or gone account is refused, and a read that fails admits nobody.
 *  - No connector source file reaches an address-shaped lookup at all: the guard below reads them.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ADAPTERS } from '../../lambda/src/lib/connectors/vendors';
import { resolveParticipant, resolveParticipants } from '../../lambda/src/lib/connector-participants';
import { connectorRegistry } from '../../lib/config/connectors';
import { connectorContextOf } from '../../lib/constructs/connectors';
import { stripComments } from '../helpers/strip-comments';

const ARN = (n: number) => `arn:aws:chime:us-east-1:111122223333:app-instance/i/user/0192a000-0000-7000-8000-00000000000${n}`;
const JANE = 'jane@example.com';

/** `Identities` as rows: `<namespace>|<subject>` -> person. An address is no key here, and nothing reads one. */
function identities(rows: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    resolve: async (ns: string, subject: string) => {
      reads.push(`${ns}|${subject}`);
      return rows[`${ns}|${subject}`] ?? null;
    },
  };
}

/** Every account active at its issuer: what the tests below are not about. */
const active = { accountState: async () => 'active' as const };
const held = (token: string | undefined) => ({ ...active, clearanceOf: async () => ({ state: 'held' as const, token, held: token ? [token] : [], groups: [], admin: false }) });

describe('the vendor adapters name people by vendor id only', () => {
  it('pagerduty: an assignee is their PagerDuty user id; summary and email are never read', () => {
    const e = ADAPTERS.pagerduty.read({
      id: 'env-1', source: 'aws.partner/pagerduty.com/example-oncall', 'detail-type': 'PagerDuty Webhook', time: '2026-10-19T12:00:00Z',
      detail: {
        id: 'm1', event: 'incident.trigger', created_on: '2026-10-19T12:00:00Z',
        log_entries: [{ agent: { id: 'PAGENT1', summary: JANE, email: JANE } }],
        incident: {
          id: 'Q1', assignments: [
            { assignee: { id: 'PABC123', summary: JANE, email: JANE } },
            { assignee: { id: JANE, summary: 'not an id' } },
          ],
        },
      },
    });
    expect(e.people).toEqual([{ role: 'assignee', subject: 'PABC123' }]);
    expect(JSON.stringify(e)).not.toContain(JANE);
  });

  it('salesforce: the owner is the source\'s org and the owner\'s user id together; an owner address is never read', () => {
    const SOURCE = 'aws.partner/salesforce.com/00D000000000001AAA/0YL000000000001AAA';
    const change = (payload: Record<string, unknown>) => ({
      id: 'env-1', source: SOURCE, 'detail-type': 'LeadChangeEvent', time: '2026-10-19T12:00:00Z',
      detail: { id: 'uuid-1', schemaId: 's', payload: { ChangeEventHeader: { entityName: 'Lead', changeType: 'CREATE', recordIds: ['00Q000000000001AAA'], commitTimestamp: Date.parse('2026-10-19T12:00:00Z'), commitUser: '005000000000009AAA' }, ...payload } },
    });
    const e = ADAPTERS.salesforce.read(change({ OwnerId: '005000000000001AAA', Email: JANE, Owner_Email__c: JANE }));
    expect(e.people).toEqual([{ role: 'owner', subject: '00D000000000001AAA:005000000000001AAA' }]);
    expect(JSON.stringify(e)).not.toContain(JANE);
    // An owner named by address instead of an id is nobody, and the user who made the change is nobody either.
    expect(ADAPTERS.salesforce.read(change({ OwnerId: JANE })).people).toEqual([]);
    expect(ADAPTERS.salesforce.read(change({})).people).toEqual([]);
    // A payload that names another org names nobody in it: the org is the partner event source's.
    const crossed = ADAPTERS.salesforce.read(change({ OwnerId: '005000000000001AAA', organizationId: '00D000000000002AAA' }));
    expect(crossed.people).toEqual([{ role: 'owner', subject: '00D000000000001AAA:005000000000001AAA' }]);
  });
});

describe('resolveParticipant', () => {
  it('reads Identities under the connector namespace, and an address that a person holds resolves nobody', async () => {
    // Jane is a person, and her sign-in row is keyed by her issuer subject. Her ADDRESS is in no key.
    const ids = identities({ 'deployment|cognito-sub-jane': ARN(1) });
    const out = await resolveParticipant({ namespace: 'deployment' }, { role: 'assignee', subject: JANE }, 'standard', { resolve: ids.resolve, directory: held('standard') });
    expect(out).toEqual({ role: 'assignee', state: 'unresolved' });
    expect(ids.reads).toEqual([`deployment|${JANE}`]);
  });

  it('resolves a vendor id the person linked (the connector\'s own namespace) or that their issuer shares (personIssuer)', async () => {
    const ids = identities({ 'pagerduty|PABC123': ARN(1), 'salesforce-host:00D:005': ARN(2), 'salesforce-host|00D:005': ARN(2) });
    expect(await resolveParticipant({ namespace: 'pagerduty' }, { role: 'assignee', subject: 'PABC123' }, 'standard', { resolve: ids.resolve, directory: held('standard') }))
      .toEqual({ role: 'assignee', state: 'admitted', personArn: ARN(1) });
    expect(await resolveParticipant({ namespace: 'salesforce-host' }, { role: 'owner', subject: '00D:005' }, 'standard', { resolve: ids.resolve, directory: held('standard') }))
      .toEqual({ role: 'owner', state: 'admitted', personArn: ARN(2) });
  });

  it('K4: admits only when the person\'s clearance reaches the classification; refused or undetermined otherwise', async () => {
    const ids = identities({ 'pagerduty|PABC123': ARN(1) });
    const p = { role: 'assignee', subject: 'PABC123' };
    // Holds basic, the conversation is premium: refused. The narrower limit wins.
    expect((await resolveParticipant({ namespace: 'pagerduty' }, p, 'premium', { resolve: ids.resolve, directory: held('basic') })).state).toBe('refused');
    // Holds a combination nobody declared: no token, refused.
    expect((await resolveParticipant({ namespace: 'pagerduty' }, p, 'basic', { resolve: ids.resolve, directory: held(undefined) })).state).toBe('refused');
    // A clearance source that decides only from a token: undetermined, never admitted.
    expect((await resolveParticipant({ namespace: 'pagerduty' }, p, 'basic', { resolve: ids.resolve, directory: { ...active, clearanceOf: async () => ({ state: 'undetermined' as const, issuers: ['x'] }) } })).state).toBe('undetermined');
    // A clearance that cannot be read: undetermined.
    expect((await resolveParticipant({ namespace: 'pagerduty' }, p, 'basic', { resolve: ids.resolve, directory: { ...active, clearanceOf: async () => { throw new Error('down'); } } })).state).toBe('undetermined');
    // No issuer the registry declares: refused.
    expect((await resolveParticipant({ namespace: 'pagerduty' }, p, 'basic', { resolve: ids.resolve, directory: { ...active, clearanceOf: async () => ({ state: 'none' as const }) } })).state).toBe('refused');
  });

  it('refuses a person none of whose sign-ins is active at its issuer, however cleared, asking every sign-in', async () => {
    const ids = identities({ 'pagerduty|PABC123': ARN(1) });
    const p = { role: 'assignee', subject: 'PABC123' };
    const subjectsOf = async () => [{ issuer: 'deployment', subject: 'sub-1' }, { issuer: 'corp-sso', subject: 'sub-2' }];
    for (const states of [['disabled', 'disabled'], ['gone', 'disabled'], ['gone', 'gone']] as const) {
      const asked: string[] = [];
      const directory = { ...held('premium'), accountState: async (issuer: string, subject: string) => { asked.push(`${issuer}|${subject}`); return states[asked.length - 1]; } };
      expect(await resolveParticipant({ namespace: 'pagerduty' }, p, 'basic', { resolve: ids.resolve, directory, subjectsOf }))
        .toEqual({ role: 'assignee', state: 'refused', personArn: ARN(1) });
      expect(asked.sort()).toEqual(['corp-sso|sub-2', 'deployment|sub-1']);
    }
    // One active sign-in is enough: the person may still sign in.
    const one = { ...held('premium'), accountState: async (issuer: string) => (issuer === 'corp-sso' ? 'active' as const : 'disabled' as const) };
    expect((await resolveParticipant({ namespace: 'pagerduty' }, p, 'basic', { resolve: ids.resolve, directory: one, subjectsOf })).state).toBe('admitted');
    // Nobody signs in as them: refused.
    expect((await resolveParticipant({ namespace: 'pagerduty' }, p, 'basic', { resolve: ids.resolve, directory: held('premium'), subjectsOf: async () => [] })).state).toBe('refused');
  });

  it('admits nobody when whether the account is active cannot be read (fail closed)', async () => {
    const ids = identities({ 'pagerduty|PABC123': ARN(1) });
    const p = { role: 'assignee', subject: 'PABC123' };
    const down = { ...held('premium'), accountState: async (): Promise<'active'> => { throw new Error('throttled'); } };
    expect((await resolveParticipant({ namespace: 'pagerduty' }, p, 'basic', { resolve: ids.resolve, directory: down })).state).toBe('undetermined');
    const noIndex = async () => { throw new Error('index unreadable'); };
    expect((await resolveParticipant({ namespace: 'pagerduty' }, p, 'basic', { resolve: ids.resolve, directory: held('premium'), subjectsOf: noIndex })).state).toBe('undetermined');
  });

  it('P-13: pre-assigns a person with no row under a provisioned-only issuer, and admits them nowhere', async () => {
    const ids = identities({});
    const asked: string[] = [];
    const provision = { namespaces: ['salesforce-host'], subject: async (ns: string, subject: string, connectorId: string) => { asked.push(`${connectorId}:${ns}|${subject}`); return true; } };
    const owner = { role: 'owner', subject: '00D:005' };
    expect(await resolveParticipant({ id: 'sfdc', namespace: 'salesforce-host' }, owner, 'standard', { resolve: ids.resolve, directory: held('standard'), provision }))
      .toEqual({ role: 'owner', state: 'pending' });
    expect(asked).toEqual(['sfdc:salesforce-host|00D:005']);
    // The connector's own namespace (PagerDuty) is no provisioned-only issuer: nobody is pre-assigned there.
    expect(await resolveParticipant({ id: 'pagerduty', namespace: 'pagerduty' }, { role: 'assignee', subject: 'PZZZ999' }, 'standard', { resolve: ids.resolve, directory: held('standard'), provision }))
      .toEqual({ role: 'assignee', state: 'unresolved' });
    expect(asked).toHaveLength(1);
  });

  it('P-13: a provisioner that refuses or cannot be reached leaves the person unresolved, never admitted', async () => {
    const ids = identities({});
    const owner = { role: 'owner', subject: '00D:005' };
    for (const subject of [async () => false, async () => { throw new Error('down'); }]) {
      expect(await resolveParticipant({ id: 'sfdc', namespace: 'salesforce-host' }, owner, 'standard', { resolve: ids.resolve, directory: held('standard'), provision: { namespaces: ['salesforce-host'], subject } }))
        .toEqual({ role: 'owner', state: 'unresolved' });
    }
  });

  it('resolves each distinct person once', async () => {
    const ids = identities({ 'pagerduty|PABC123': ARN(1) });
    const out = await resolveParticipants({ namespace: 'pagerduty' }, [{ role: 'assignee', subject: 'PABC123' }, { role: 'assignee', subject: 'PABC123' }, { role: 'assignee', subject: 'PZZZ999' }], 'standard', { resolve: ids.resolve, directory: held('standard') });
    expect(out.map((o) => o.state)).toEqual(['admitted', 'unresolved']);
  });
});

describe('the connector registry keeps K2 and K4 at synth', () => {
  const ctx = connectorContextOf({ entries: [
    { id: 'deployment', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] } },
    { id: 'partner', clearance: { groups: true, classifications: ['basic'] } },
  ] });
  const errors = (entry: Record<string, unknown>) => {
    try {
      connectorRegistry([entry], ctx, ['connectors']);
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  };

  it('names a person in the connector\'s own namespace, or under a declared issuer', () => {
    expect(connectorRegistry([{ id: 'pd', vendor: 'pagerduty' }], ctx, ['connectors']).runtime()[0].namespace).toBe('pd');
    expect(connectorRegistry([{ id: 'sf', vendor: 'salesforce', personIssuer: 'deployment' }], ctx, ['connectors']).runtime()[0].namespace).toBe('deployment');
    expect(errors({ id: 'sf', vendor: 'salesforce', personIssuer: 'nobody' })).toMatch(/personIssuer "nobody" is not an issuer the registry declares/);
    expect(errors({ id: 'deployment', vendor: 'pagerduty' })).toMatch(/also an issuer's id/);
  });

  it('refuses a personIssuer whose classifications never reach the connector\'s classification (K4)', () => {
    expect(errors({ id: 'pd', vendor: 'pagerduty', subscribes: ['incident.trigger'], eventSource: 'aws.partner/pagerduty.com/example-oncall', classification: 'premium', personIssuer: 'partner' }))
      .toMatch(/personIssuer "partner" declares classifications that never reach "premium"/);
    expect(errors({ id: 'pd', vendor: 'pagerduty', subscribes: ['incident.trigger'], eventSource: 'aws.partner/pagerduty.com/example-oncall', classification: 'basic', personIssuer: 'partner' })).toBe('');
  });
});

describe('no connector source reaches an address', () => {
  const ROOT = path.resolve(__dirname, '..', '..');
  const FILES = [
    'lambda/src/connector-ingest.ts',
    'lambda/src/connector-grant-routes.ts',
    'lambda/src/connector-grant-revoker.ts',
    'lambda/src/lib/connector-participants.ts',
    'lambda/src/lib/connector-grants.ts',
    ...fs.readdirSync(path.join(ROOT, 'lambda/src/lib/connectors')).filter((f) => f.endsWith('.ts')).map((f) => `lambda/src/lib/connectors/${f}`),
  ];
  // The address-shaped lookups the platform has, and any property named for an address.
  const FORBIDDEN = /\b(findByAddress|subjectsByAddress|byEmail|contactFor|ListUsersCommand)\b|\.email\b|\[['"]email['"]\]|\bemail\s*:/i;

  it('reads the files it guards (a scan over nothing passes vacuously)', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(8);
    for (const f of FILES) expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
  });

  it('finds no address lookup in any of them, outside comments', () => {
    const hits = FILES.flatMap((f) => stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'))
      .split('\n').filter((line) => FORBIDDEN.test(line)).map((line) => `${f}: ${line.trim()}`));
    expect(hits).toEqual([]);
  });

  it('catches the copy it exists for', () => {
    expect(FORBIDDEN.test('const arn = await directory.findByAddress(issuer, assignee.email);')).toBe(true);
    expect(FORBIDDEN.test("people.push({ email: a.summary })")).toBe(true);
  });
});
