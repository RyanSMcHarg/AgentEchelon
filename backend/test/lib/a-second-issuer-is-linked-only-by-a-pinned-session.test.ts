/**
 * B7 (PLAN §16.5 P-13): a second issuer's subject is linked to a person only by a session already pinned
 * to that person plus the second token, in one call, and each link writes an audit record.
 *
 * The §16.5 deny-tests, as units: a second issuer is added only with a session pinned to the person
 * (the pinned side is the edge's resolution, never the body); a second AppInstanceUser is never created
 * for a subject that already has a row; a subject that is somebody else's is never moved; a guest, a host
 * assertion and a one-conversation issuer are never linked. The live proof is `scripts/deny-test-upgrade.mjs`.
 */
import { linkRequestOf, linkSecondIssuer, LinkRefused } from '../../lambda/src/lib/issuer-link';
import { TokenRefused } from '../../lambda/src/lib/token-verification';
import { issuerSubjectKey, revokedMarkerKey } from '../../lambda/src/lib/person-identity';
import type { TrustedIssuer } from '../../lib/config/issuers';

const INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
const PERSON = `${INSTANCE}/user/0190c0de-0000-7000-8000-000000000009`;
const pool = (id: string, extra: Partial<TrustedIssuer> = {}) =>
  ({ id, kind: 'cognito-pool', subject: ['sub'], clearance: { groups: true, classifications: ['basic'] }, ...extra }) as unknown as TrustedIssuer;
const FIRST = pool('deployment');
const STAFF = pool('staff-pool');

function store(rows: Array<Record<string, any>> = []) {
  const items = new Map(rows.map((r) => [r.issuerSubject, r]));
  const sent: string[] = [];
  return {
    items,
    sent,
    async send(cmd: any) {
      const name = cmd.constructor.name;
      sent.push(name);
      if (name === 'GetCommand') return { Item: items.get(cmd.input.Key.issuerSubject) };
      if (name === 'QueryCommand') return { Items: [...items.values()].filter((r) => r.personArn === cmd.input.ExpressionAttributeValues[':p']) };
      if (name === 'PutCommand') {
        if (items.has(cmd.input.Item.issuerSubject)) { const e: any = new Error('x'); e.name = 'ConditionalCheckFailedException'; throw e; }
        items.set(cmd.input.Item.issuerSubject, cmd.input.Item);
        return {};
      }
      throw new Error(name);
    },
  };
}

const verifying = (issuer: TrustedIssuer, sub = 'staff-sub') => async () => ({ issuer: issuer as any, claims: { sub, exp: 9e9 } });

describe('linking a second issuer', () => {
  it('reads the second token from linkIssuer, and refuses a malformed ask', () => {
    expect(linkRequestOf({})).toBeNull();
    expect(linkRequestOf({ linkIssuer: { token: 't' } })).toEqual({ token: 't' });
    expect(linkRequestOf({ linkIssuer: { token: '' } })).toBe('malformed');
  });

  it('writes the second subject naming the pinned person, and an audit record', async () => {
    const doc = store([{ issuerSubject: issuerSubjectKey('deployment', 'd-sub'), personArn: PERSON, issuer: 'deployment', status: 'active' }]);
    const audit = jest.fn(async () => undefined);
    const out = await linkSecondIssuer({ personArn: PERSON, issuer: FIRST }, 'second', { doc, identitiesTable: 'ids', verify: verifying(STAFF), audit });
    expect(out).toEqual({ issuerId: 'staff-pool', personArn: PERSON, created: true });
    expect(doc.items.get(issuerSubjectKey('staff-pool', 'staff-sub'))).toMatchObject({ personArn: PERSON, status: 'active', linkedBy: 'deployment' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ _auditEvent: 'identity_linked', actorArn: PERSON, issuer: 'staff-pool', personArn: PERSON, timestamp: expect.any(String) }));
  });

  it('answers already-linked for the same person, and never moves a subject that is somebody else', async () => {
    const mine = store([{ issuerSubject: issuerSubjectKey('staff-pool', 'staff-sub'), personArn: PERSON, issuer: 'staff-pool', status: 'active' }]);
    await expect(linkSecondIssuer({ personArn: PERSON, issuer: FIRST }, 't', { doc: mine, identitiesTable: 'ids', verify: verifying(STAFF) }))
      .resolves.toMatchObject({ created: false });
    const theirs = store([{ issuerSubject: issuerSubjectKey('staff-pool', 'staff-sub'), personArn: `${INSTANCE}/user/other`, issuer: 'staff-pool', status: 'active' }]);
    await expect(linkSecondIssuer({ personArn: PERSON, issuer: FIRST }, 't', { doc: theirs, identitiesTable: 'ids', verify: verifying(STAFF) }))
      .rejects.toMatchObject({ code: 'SUBJECT_ALREADY_BOUND' });
    expect(theirs.sent).not.toContain('PutCommand');
  });

  it('refuses an offboarded second subject, a second subject of an issuer the person already holds, and the same issuer', async () => {
    const revoked = store([{ issuerSubject: revokedMarkerKey('staff-pool', 'staff-sub') }]);
    await expect(linkSecondIssuer({ personArn: PERSON, issuer: FIRST }, 't', { doc: revoked, identitiesTable: 'ids', verify: verifying(STAFF) }))
      .rejects.toMatchObject({ code: 'SUBJECT_ALREADY_BOUND' });
    const holds = store([{ issuerSubject: issuerSubjectKey('staff-pool', 'older'), personArn: PERSON, issuer: 'staff-pool', status: 'active' }]);
    await expect(linkSecondIssuer({ personArn: PERSON, issuer: FIRST }, 't', { doc: holds, identitiesTable: 'ids', verify: verifying(STAFF) }))
      .rejects.toMatchObject({ code: 'LINK_ISSUER_ALREADY_LINKED' });
    await expect(linkSecondIssuer({ personArn: PERSON, issuer: FIRST }, 't', { doc: store(), identitiesTable: 'ids', verify: verifying(FIRST) }))
      .rejects.toMatchObject({ code: 'LINK_SAME_ISSUER' });
  });

  it('refuses a second token that fails a check, and writes nothing', async () => {
    const doc = store();
    const verify = async () => { throw new TokenRefused('signature', 'bad'); };
    await expect(linkSecondIssuer({ personArn: PERSON, issuer: FIRST }, 't', { doc, identitiesTable: 'ids', verify })).rejects.toMatchObject({ code: 'LINK_TOKEN_REFUSED' });
    expect(doc.sent).toEqual([]);
  });

  it.each([
    ['a guest', pool('guest', { kind: 'guest' } as never)],
    ['a host assertion', pool('host', { kind: 'host-assertion', provisioning: 'provisioned-only' } as never)],
    ['a one-conversation issuer', pool('embed', { clearance: { oneChannel: 'standard', classifications: ['standard'] } } as never)],
  ])('never links %s, on either side', async (_name, issuer) => {
    await expect(linkSecondIssuer({ personArn: PERSON, issuer }, 't', { doc: store(), identitiesTable: 'ids', verify: verifying(STAFF) }))
      .rejects.toBeInstanceOf(LinkRefused);
    await expect(linkSecondIssuer({ personArn: PERSON, issuer: FIRST }, 't', { doc: store(), identitiesTable: 'ids', verify: verifying(issuer) }))
      .rejects.toMatchObject({ code: 'LINK_NOT_SUPPORTED' });
  });

  it('needs a pinned person: a session naming no AppInstanceUser links nothing', async () => {
    await expect(linkSecondIssuer({ personArn: '', issuer: FIRST }, 't', { doc: store(), identitiesTable: 'ids', verify: verifying(STAFF) }))
      .rejects.toMatchObject({ code: 'LINK_NOT_SUPPORTED' });
  });
});
