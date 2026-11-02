/**
 * THE CREDENTIAL EXCHANGE RECORDS ITS CLEARANCE DECISION, AND THE READERS WITH NO TOKEN READ IT AS EVIDENCE (C3).
 *
 *  - The record is the one attribute `clearanceDecision` on the subject's own `Identities` row: the
 *    classification applied, the issuer, the rule's source and what it matched, and when. A row that does
 *    not exist is never created by it, and a failed write never refuses the sign-in.
 *  - What a rule matched: a mapping's declared values on the token (an undeclared one is not kept), the
 *    groups, or the fixed set.
 *  - A `mapping` member stays undetermined, never held, and carries the record as `lastSignIn`, stale past
 *    the issuer's `recordMaxAgeDays` (default 30).
 *  - The reconcile neither adds nor removes on a record: a record that does not reach the classification,
 *    or is stale, is flagged.
 *  - The membership audit reports a record that does not reach the conversation and revokes nothing for
 *    it; a fresh record that reaches it settles the membership; no record leaves it unaudited.
 */
const mockSubjectsOf = jest.fn();
jest.mock('../../lambda/src/lib/person-identity', () => ({
  ...jest.requireActual('../../lambda/src/lib/person-identity'),
  subjectsOfPerson: (...a: unknown[]) => mockSubjectsOf(...a),
}));
const mockNotice = jest.fn(async () => true);
jest.mock('../../lambda/src/lib/admin-notice', () => ({
  ...jest.requireActual('../../lambda/src/lib/admin-notice'),
  postAdminNotice: (...a: unknown[]) => mockNotice(...(a as [])),
}));

import { CLEARANCE_RECORD_MAX_AGE_DAYS, clearanceBasisOf, clearanceRecordMaxAgeMs, issuerErrors, type TrustedIssuer } from '../../lib/config/issuers';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { recordClearanceDecision, type ClearanceDecision, type PersonSubject } from '../../lambda/src/lib/person-identity';
import { evidenceOf, resolveAllowedSet } from '../../lambda/src/lib/membership-source';
import { oidcIssuer, testDirectory } from '../helpers/directory';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/records';
const person = (id: string) => `${APP}/user/${id}`;
const MAYA = '0192f0e0-0000-7000-8000-00000000aa01';
const NOW = Date.parse('2026-10-19T12:00:00Z');
const DAY = 86_400_000;

const MAPPED = oidcIssuer('mapped-oidc', { mapping: { claim: 'roles', values: { analyst: 'standard', viewer: 'basic' } }, classifications: ['basic', 'standard'] });
const SHORT = oidcIssuer('short-oidc', { mapping: { claim: 'roles', values: { analyst: 'standard' }, recordMaxAgeDays: 2 }, classifications: ['basic', 'standard'] });

const decision = (over: Partial<ClearanceDecision> = {}): ClearanceDecision => ({
  classification: 'standard', issuer: 'mapped-oidc', source: 'mapping', claim: 'roles', matched: ['analyst'], at: new Date(NOW - DAY).toISOString(), ...over,
});

describe('the record the exchange writes', () => {
  it('sets clearanceDecision alone, on a row that exists, with what was decided and when', async () => {
    const send = jest.fn(async () => ({}));
    const ok = await recordClearanceDecision(
      { issuer: 'mapped-oidc', subject: 'maya-oid', classification: 'standard', source: 'mapping', claim: 'roles', matched: ['analyst', 'analyst'] },
      { doc: { send }, table: 'Identities', now: () => new Date(NOW) },
    );
    expect(ok).toBe(true);
    const input = (send.mock.calls[0] as unknown as [{ input: Record<string, any> }])[0].input;
    expect(input).toEqual({
      TableName: 'Identities',
      Key: { issuerSubject: 'mapped-oidc|maya-oid' },
      UpdateExpression: 'SET clearanceDecision = :d',
      ConditionExpression: 'attribute_exists(issuerSubject)',
      ExpressionAttributeValues: { ':d': { classification: 'standard', issuer: 'mapped-oidc', source: 'mapping', claim: 'roles', matched: ['analyst'], at: '2026-10-19T12:00:00.000Z' } },
    });
  });

  it('never refuses the sign-in when it cannot be written', async () => {
    const send = jest.fn(async () => { throw Object.assign(new Error('gone'), { name: 'ConditionalCheckFailedException' }); });
    await expect(recordClearanceDecision({ issuer: 'i', subject: 's', classification: 'basic', source: 'fixed', matched: ['basic'] }, { doc: { send }, table: 'T' })).resolves.toBe(false);
  });

  it('keeps what the rule matched: a mapping\'s declared values, the groups, or the fixed set', () => {
    expect(clearanceBasisOf(MAPPED, { roles: ['analyst', 'stranger'] })).toEqual({ source: 'mapping', claim: 'roles', matched: ['analyst'] });
    const fixed = oidcIssuer('fixed-oidc', { fixed: ['basic'], classifications: ['basic'] });
    expect(clearanceBasisOf(fixed, {})).toEqual({ source: 'fixed', matched: ['basic'] });
    const one = oidcIssuer('one', { oneChannel: 'basic', classifications: ['basic'] } as TrustedIssuer['clearance']);
    expect(clearanceBasisOf(one, {})).toBeNull();
  });
});

describe('the age a record may reach', () => {
  it('is 30 days unless the mapping declares its own, from 1 to 365', () => {
    expect(CLEARANCE_RECORD_MAX_AGE_DAYS).toBe(30);
    expect(clearanceRecordMaxAgeMs(MAPPED.clearance)).toBe(30 * DAY);
    expect(clearanceRecordMaxAgeMs(SHORT.clearance)).toBe(2 * DAY);
    const entry = (age: unknown) => ({
      id: 'partner', kind: 'oidc-entra', discoveryUrl: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
      tenants: ['11111111-2222-3333-4444-555555555555', '66666666-7777-8888-9999-000000000000'], tokenVersion: 2, audience: 'api://ae',
      clearance: { mapping: { claim: 'roles', values: { analyst: 'standard' }, recordMaxAgeDays: age }, classifications: ['standard'] },
    });
    const ageErrors = (age: unknown) => issuerErrors([entry(age)], profiles).filter((e) => e.includes('recordMaxAgeDays'));
    expect(ageErrors(14)).toEqual([]);
    expect(ageErrors(0)).toHaveLength(1);
    expect(ageErrors(1.5)).toHaveLength(1);
    expect(ageErrors(400)).toHaveLength(1);
  });

  it('judges a record stale past it, or with no readable time, and reads only its own issuer\'s', () => {
    expect(evidenceOf(MAPPED, decision(), NOW)).toEqual({ issuer: 'mapped-oidc', classification: 'standard', at: decision().at, stale: false });
    expect(evidenceOf(MAPPED, decision({ at: new Date(NOW - 31 * DAY).toISOString() }), NOW)?.stale).toBe(true);
    expect(evidenceOf(SHORT, decision({ issuer: 'short-oidc', at: new Date(NOW - 3 * DAY).toISOString() }), NOW)?.stale).toBe(true);
    expect(evidenceOf(MAPPED, decision({ at: 'not a time' }), NOW)?.stale).toBe(true);
    expect(evidenceOf(MAPPED, decision({ issuer: 'another' }), NOW)).toBeNull();
    expect(evidenceOf(MAPPED, undefined, NOW)).toBeNull();
  });
});

function directoryWith(subjects: PersonSubject[]) {
  return testDirectory({
    appInstanceArn: APP,
    issuers: [{ issuer: MAPPED }],
    identities: { resolve: async () => person(MAYA), subjectsOf: async () => subjects },
  });
}

describe('a mapping member read through the record', () => {
  it('is undetermined, never held, and carries the record as the last sign-in', async () => {
    const fresh = decision({ at: new Date(Date.now() - DAY).toISOString() });
    const d = directoryWith([{ issuer: 'mapped-oidc', subject: 'maya-oid', clearanceDecision: fresh }]);
    expect(await d.clearanceOf(person(MAYA))).toEqual({
      state: 'undetermined', issuers: ['mapped-oidc'], lastSignIn: [{ issuer: 'mapped-oidc', classification: 'standard', at: fresh.at, stale: false }],
    });
    expect(await directoryWith([{ issuer: 'mapped-oidc', subject: 'maya-oid' }]).clearanceOf(person(MAYA))).toEqual({ state: 'undetermined', issuers: ['mapped-oidc'] });
  });

  it('is never added or removed by the reconcile on a record, and is flagged when it does not reach or is stale', async () => {
    const reaching = directoryWith([{ issuer: 'mapped-oidc', subject: 'maya-oid', clearanceDecision: decision({ at: new Date(Date.now() - DAY).toISOString() }) }]);
    const atStandard = await resolveAllowedSet({ list: [person(MAYA)] }, 'standard', APP, reaching);
    expect([...atStandard.admitted]).toEqual([]);
    expect([...atStandard.undetermined]).toEqual([person(MAYA)]);
    expect(atStandard.flagged).toEqual([]);

    const atPremium = await resolveAllowedSet({ list: [person(MAYA)] }, 'premium', APP, reaching);
    expect([...atPremium.admitted]).toEqual([]);
    expect(atPremium.flagged).toEqual([{ personArn: person(MAYA), why: 'mismatch', issuer: 'mapped-oidc', recorded: 'standard' }]);

    const stale = directoryWith([{ issuer: 'mapped-oidc', subject: 'maya-oid', clearanceDecision: decision({ at: new Date(Date.now() - 60 * DAY).toISOString() }) }]);
    const atStale = await resolveAllowedSet({ list: [person(MAYA)] }, 'standard', APP, stale);
    expect([...atStale.admitted]).toEqual([]);
    expect(atStale.flagged).toEqual([{ personArn: person(MAYA), why: 'stale', issuer: 'mapped-oidc', recorded: 'standard' }]);
  });
});

describe('the membership audit reads the record as evidence', () => {
  let audit: typeof import('../../lambda/src/membership-audit');
  beforeAll(() => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    audit = require('../../lambda/src/membership-audit');
  });
  beforeEach(() => mockNotice.mockClear());

  const fresh = (classification: string) => [{ issuer: 'mapped-oidc', classification, at: new Date(Date.now() - DAY).toISOString(), stale: false }];

  it('reports a record that does not reach the conversation, and revokes nothing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await audit.auditByRecordedDecision('arn:c', person(MAYA), 'premium', fresh('standard'))).toBe(true);
      expect(warn.mock.calls.some(([m, d]) => String(m).includes('SecurityEvent') && (d as { _auditEvent?: string })?._auditEvent === 'membership_clearance_record_mismatch')).toBe(true);
      expect(mockNotice).toHaveBeenCalledTimes(1);
      expect(String((mockNotice.mock.calls[0] as unknown[])[0] && ((mockNotice.mock.calls[0] as unknown[])[0] as { content: string }).content)).toContain('left in place');
    } finally {
      warn.mockRestore();
    }
  });

  it('settles a membership a fresh record reaches, and flags a stale one without reading it', async () => {
    expect(await audit.auditByRecordedDecision('arn:c', person(MAYA), 'standard', fresh('standard'))).toBe(true);
    expect(mockNotice).not.toHaveBeenCalled();
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await audit.auditByRecordedDecision('arn:c', person(MAYA), 'basic', [{ ...fresh('premium')[0], stale: true }])).toBe(true);
      expect(warn.mock.calls.some(([, d]) => (d as { _auditEvent?: string })?._auditEvent === 'membership_clearance_record_stale')).toBe(true);
      expect(error.mock.calls.some(([, d]) => (d as { reason?: string })?.reason === 'clearance-record-stale')).toBe(true);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('leaves a member with no record unaudited', async () => {
    expect(await audit.auditByRecordedDecision('arn:c', person(MAYA), 'basic', undefined)).toBe(false);
    expect(await audit.auditByRecordedDecision('arn:c', person(MAYA), 'basic', [])).toBe(false);
  });
});

void mockSubjectsOf;
