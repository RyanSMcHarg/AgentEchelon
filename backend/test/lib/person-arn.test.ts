/**
 * The one ARN helper, and its operator-script twin held to the same table.
 */
import {
  adminTwinIdFor,
  adminTwinOwnerId,
  appInstanceArnOf,
  botArnFor,
  botIdFromArn,
  isAssistantArn,
  isPersonArn,
  personIdFromArn,
  principalFromArn,
  principalIdFromArn,
  rosterMember,
  rosterOf,
  userArnFor,
} from '../../lambda/src/lib/person-arn';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const twin = require('../../scripts/lib/person-arn.cjs');

const APP = 'arn:aws:chime:us-east-1:123456789012:app-instance/0f3c-1a2b';
const POOL_SUB = '6b1e2f4a-9c7d-4e3b-8a21-0d5c9e7f1a33';

type Row = { name: string; arn: unknown; person: string | null; bot: string | null; app: string | null };

const TABLE: Row[] = [
  { name: 'a person by pool sub', arn: `${APP}/user/${POOL_SUB}`, person: POOL_SUB, bot: null, app: APP },
  { name: 'a person by opaque id', arn: `${APP}/user/0190f5c2-7b3a-7c11-9d2e-5a6b7c8d9e0f`, person: '0190f5c2-7b3a-7c11-9d2e-5a6b7c8d9e0f', bot: null, app: APP },
  { name: 'the admin twin', arn: `${APP}/user/${POOL_SUB}-admin`, person: `${POOL_SUB}-admin`, bot: null, app: APP },
  { name: 'an id with colons, @ and underscores', arn: `${APP}/user/console-a:b_c@premium`, person: 'console-a:b_c@premium', bot: null, app: APP },
  { name: 'a federated id', arn: `${APP}/user/fed_ab12cd34`, person: 'fed_ab12cd34', bot: null, app: APP },
  { name: 'an assistant', arn: `${APP}/bot/basic-advisor`, person: null, bot: 'basic-advisor', app: APP },
  { name: 'a channel', arn: `${APP}/channel/abc-123`, person: null, bot: null, app: APP },
  { name: 'an empty id', arn: `${APP}/user/`, person: null, bot: null, app: APP },
  { name: 'a nested path after the id', arn: `${APP}/user/a/b`, person: null, bot: null, app: APP },
  { name: 'a bare id', arn: POOL_SUB, person: null, bot: null, app: null },
  { name: 'a segment with nothing before it', arn: '/user/x', person: null, bot: null, app: null },
  { name: 'empty', arn: '', person: null, bot: null, app: null },
  { name: 'undefined', arn: undefined, person: null, bot: null, app: null },
  { name: 'null', arn: null, person: null, bot: null, app: null },
  { name: 'not a string', arn: 42, person: null, bot: null, app: null },
];

describe('the admin-plane twin', () => {
  it("is named from its owner's person id, and names its owner back", () => {
    const PERSON = '0190f5c2-7b3a-7c11-9d2e-5a6b7c8d9e0f';
    expect(adminTwinIdFor(PERSON)).toBe(`${PERSON}-admin`);
    expect(adminTwinOwnerId(adminTwinIdFor(PERSON))).toBe(PERSON);
    expect(adminTwinOwnerId('person_01J8Z-admin')).toBe('person_01J8Z');
  });

  it('has no owner for a person, an empty id, or the service admin that shares the suffix', () => {
    expect(adminTwinOwnerId(POOL_SUB)).toBeNull();
    expect(adminTwinOwnerId('-admin')).toBeNull();
    expect(adminTwinOwnerId(undefined)).toBeNull();
    expect(adminTwinOwnerId('agent-echelon-admin', 'agent-echelon-admin')).toBeNull();
  });
});

describe('person-arn', () => {
  describe.each(TABLE)('$name', ({ arn, person, bot, app }) => {
    const a = arn as string | undefined;

    it('reads the person id, the bot id and the app instance', () => {
      expect(personIdFromArn(a)).toBe(person);
      expect(botIdFromArn(a)).toBe(bot);
      expect(appInstanceArnOf(a)).toBe(app);
      expect(isPersonArn(a)).toBe(person !== null);
      expect(isAssistantArn(a)).toBe(bot !== null);
    });

    it('classifies the principal', () => {
      const expected = person ? { kind: 'person', id: person } : bot ? { kind: 'assistant', id: bot } : null;
      expect(principalFromArn(a)).toEqual(expected);
    });

    it('the operator-script twin answers the same', () => {
      expect(twin.personIdFromArn(a)).toBe(person);
      expect(twin.botIdFromArn(a)).toBe(bot);
      expect(twin.appInstanceArnOf(a)).toBe(app);
      expect(twin.principalFromArn(a)).toEqual(principalFromArn(a));
      expect(twin.isPersonArn(a)).toBe(isPersonArn(a));
      expect(twin.isAssistantArn(a)).toBe(isAssistantArn(a));
    });
  });

  it('builds a person and an assistant ARN that read back to the same id', () => {
    for (const id of [POOL_SUB, `${POOL_SUB}-admin`, 'a:b-c_d@e']) {
      expect(userArnFor(APP, id)).toBe(`${APP}/user/${id}`);
      expect(personIdFromArn(userArnFor(APP, id))).toBe(id);
      expect(appInstanceArnOf(userArnFor(APP, id))).toBe(APP);
      expect(twin.userArnFor(APP, id)).toBe(userArnFor(APP, id));
    }
    expect(botArnFor(APP, 'advisor')).toBe(`${APP}/bot/advisor`);
    expect(botIdFromArn(botArnFor(APP, 'advisor'))).toBe('advisor');
    expect(botArnFor(APP, '*')).toBe(`${APP}/bot/*`);
    expect(twin.botArnFor(APP, 'advisor')).toBe(botArnFor(APP, 'advisor'));
  });

  it('principalIdFromArn returns the id of either kind, and passes a bare id through', () => {
    expect(principalIdFromArn(`${APP}/user/u-1`)).toBe('u-1');
    expect(principalIdFromArn(`${APP}/bot/b-1`)).toBe('b-1');
    expect(principalIdFromArn('bare-id')).toBe('bare-id');
    expect(principalIdFromArn(undefined)).toBe('');
    expect(principalIdFromArn('')).toBe('');
  });

  it('reads a roster once, dropping entries that name no principal', () => {
    const memberships = [
      { Member: { Arn: `${APP}/user/u-1`, Name: 'Ada' } },
      { Member: { Arn: `${APP}/bot/advisor`, Name: 'Advisor' } },
      { Member: { Arn: `${APP}/user/u-2-admin` } },
      { Member: { Arn: 'garbage', Name: 'x' } },
      { Member: null },
      {},
    ];
    expect(rosterOf(memberships)).toEqual([
      { kind: 'person', id: 'u-1', arn: `${APP}/user/u-1`, name: 'Ada' },
      { kind: 'assistant', id: 'advisor', arn: `${APP}/bot/advisor`, name: 'Advisor' },
      { kind: 'person', id: 'u-2-admin', arn: `${APP}/user/u-2-admin`, name: '' },
    ]);
    expect(rosterMember({ Member: { Arn: 'garbage' } })).toBeNull();
    expect(rosterOf(undefined)).toEqual([]);
  });
});
