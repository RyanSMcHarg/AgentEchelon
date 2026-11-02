/**
 * A SIGNED-IN PERSON SEES AND CHANGES THEIR OWN EMAIL PREFERENCES (B9, M-7, owner 2026-10-19).
 *
 *  - `GET /email/preferences/mine` answers every kind in `NOTICE_KINDS`, each transactional kind as always sent;
 *  - `POST` mutes and unmutes one kind, or every kind at once, and refuses a transactional kind;
 *  - the person is the caller the edge resolved, never a field of the request, and it is the same
 *    `<personId>#notices` item the email's own link changes, so a send obeys either;
 *  - its two layers at synth: the route is behind the edge authorizer, and the role reaches only
 *    `*#notices` items and only their preference attributes.
 */
import * as cdk from 'aws-cdk-lib';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template } from 'aws-cdk-lib/assertions';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handlePreferencesMine, preferencesView } from '../../lambda/src/notice-preferences-api';
import { NOTICE_KINDS, mayNotify, noticePreferencesKey, readNoticePreferences } from '../../lambda/src/lib/notice-preferences';
import { NotificationStack } from '../../lib/stacks/notification-stack';
import { assistantClassifications } from '../../lib/config/profiles';
import { edgeContext } from '../helpers/edge-context';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
process.env.APP_INSTANCE_ARN = APP;
const RILEY_ID = '0192f0e0-0000-7000-8000-000000000001';
const SAM_ID = '0192f0e0-0000-7000-8000-000000000002';
const RILEY = `${APP}/user/${RILEY_ID}`;
const SAM = `${APP}/user/${SAM_ID}`;
const named = (name: string) => Object.assign(new Error(name), { name });

/** The preferences item store, interpreting the two updates `setNoticeMute` writes. */
function memoryDoc() {
  const items = new Map<string, Record<string, any>>();
  return {
    items,
    async send(cmd: any) {
      const kind = cmd.constructor.name;
      const i = cmd.input;
      if (kind === 'GetCommand') return { Item: items.get(i.Key.personId) };
      if (kind !== 'UpdateCommand') throw new Error(`unexpected ${kind}`);
      const k = i.Key.personId;
      const row = items.get(k);
      const v = i.ExpressionAttributeValues;
      if (i.ConditionExpression.startsWith('attribute_not_exists(personArn)')) {
        if (row && row.personArn !== v[':p']) throw named('ConditionalCheckFailedException');
        items.set(k, { ...(row ?? { personId: k }), muted: row?.muted ?? {}, personArn: v[':p'], updatedAt: v[':at'] });
        return {};
      }
      if (!row || row.personArn !== v[':p']) throw named('ConditionalCheckFailedException');
      const key = i.ExpressionAttributeNames['#k'];
      if (i.UpdateExpression.startsWith('SET muted.#k')) row.muted[key] = v[':at'];
      else delete row.muted[key];
      return {};
    },
  };
}

const asCaller = (sub: string, method: string, body?: unknown): APIGatewayProxyEvent => ({
  httpMethod: method,
  headers: {},
  requestContext: { authorizer: edgeContext({ claims: { sub } }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}) as unknown as APIGatewayProxyEvent;

describe('the signed-in preferences screen\'s routes', () => {
  const now = () => new Date(Date.UTC(2026, 9, 19));

  it('lists every kind of notice, the transactional ones as always sent, and nothing muted at first', async () => {
    const doc = memoryDoc();
    const res = await handlePreferencesMine(asCaller(RILEY_ID, 'GET'), { doc, table: 'UserProfile', now });
    expect(res.statusCode).toBe(200);
    const view = JSON.parse(res.body);
    expect(view.kinds.map((k: { kind: string }) => k.kind)).toEqual(Object.keys(NOTICE_KINDS));
    for (const k of view.kinds) {
      expect(k.transactional).toBe(NOTICE_KINDS[k.kind as keyof typeof NOTICE_KINDS].transactional);
      expect(k.muted).toBe(false);
    }
    expect(view.allMuted).toBe(false);
  });

  it('mutes and unmutes one kind, in the item a send reads', async () => {
    const doc = memoryDoc();
    const deps = { doc, table: 'UserProfile', now };
    const muted = await handlePreferencesMine(asCaller(RILEY_ID, 'POST', { kind: 'conversation-shared', muted: true }), deps);
    expect(JSON.parse(muted.body).kinds.find((k: { kind: string }) => k.kind === 'conversation-shared').muted).toBe(true);
    expect(mayNotify(await readNoticePreferences(doc, 'UserProfile', RILEY), 'email', 'conversation-shared')).toEqual({ ok: false, reason: 'muted' });
    expect(mayNotify(await readNoticePreferences(doc, 'UserProfile', RILEY), 'email', 'conversation')).toEqual({ ok: true });
    await handlePreferencesMine(asCaller(RILEY_ID, 'POST', { kind: 'conversation-shared', muted: false }), deps);
    expect(mayNotify(await readNoticePreferences(doc, 'UserProfile', RILEY), 'email', 'conversation-shared')).toEqual({ ok: true });
  });

  it('mutes every stoppable kind at once, and the transactional kinds still go', async () => {
    const doc = memoryDoc();
    const res = await handlePreferencesMine(asCaller(RILEY_ID, 'POST', { kind: '*', muted: true }), { doc, table: 'UserProfile', now });
    const view = JSON.parse(res.body);
    expect(view.allMuted).toBe(true);
    for (const k of view.kinds) expect(k.muted).toBe(!k.transactional);
    expect(mayNotify(await readNoticePreferences(doc, 'UserProfile', RILEY), 'email', 'invitation')).toEqual({ ok: true });
  });

  it('refuses to mute a transactional kind, an unknown kind and a missing flag', async () => {
    const doc = memoryDoc();
    const deps = { doc, table: 'UserProfile', now };
    for (const body of [{ kind: 'invitation', muted: true }, { kind: 'claim', muted: true }, { kind: 'everything', muted: true }, { kind: 'alarm' }]) {
      const res = await handlePreferencesMine(asCaller(RILEY_ID, 'POST', body), deps);
      expect({ body, status: res.statusCode }).toEqual({ body, status: 400 });
    }
    expect(doc.items.size).toBe(0);
  });

  it('acts as the caller the edge resolved: a person named in the body changes nothing of theirs', async () => {
    const doc = memoryDoc();
    await handlePreferencesMine(asCaller(RILEY_ID, 'POST', { kind: 'briefing', muted: true, personArn: SAM, personId: SAM_ID }), { doc, table: 'UserProfile', now });
    expect([...doc.items.keys()]).toEqual([noticePreferencesKey(RILEY_ID)]);
    expect(await readNoticePreferences(doc, 'UserProfile', SAM)).toEqual({ muted: {} });
  });

  it('answers 401 for a request the edge resolved to nobody', async () => {
    const res = await handlePreferencesMine({ httpMethod: 'GET', headers: {}, requestContext: {} } as unknown as APIGatewayProxyEvent,
      { doc: memoryDoc(), table: 'UserProfile', now });
    expect(res.statusCode).toBe(401);
  });

  it('an unreadable item is not shown as nothing muted', async () => {
    const doc = memoryDoc();
    doc.items.set(noticePreferencesKey(RILEY_ID), { personId: noticePreferencesKey(RILEY_ID), personArn: SAM, muted: {} });
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await handlePreferencesMine(asCaller(RILEY_ID, 'GET'), { doc, table: 'UserProfile', now });
    err.mockRestore();
    expect(res.statusCode).toBe(503);
  });

  it('the view is a pure function of the stored mutes', () => {
    const view = preferencesView({ muted: { 'email:alarm': 't' } });
    expect(view.kinds.filter((k) => k.muted).map((k) => k.kind)).toEqual(['alarm']);
  });
});

describe('the signed-in preference routes\' two layers, at synth', () => {
  const app = new cdk.App();
  const env = { account: '111122223333', region: 'us-east-1' };
  const host = new cdk.Stack(app, 'Host', { env });
  const stack = new NotificationStack(app, 'N', {
    env, appInstanceArn: APP, userPoolId: 'us-east-1_PRIMARY', classifications: assistantClassifications(),
    senderEmail: 'assistant@example.com', appUrl: 'https://app.example.com',
    messageStream: kinesis.Stream.fromStreamArn(host, 'S', 'arn:aws:kinesis:us-east-1:111122223333:stream/s'),
    tokens: dynamodb.Table.fromTableArn(host, 'T', 'arn:aws:dynamodb:us-east-1:111122223333:table/tokens'),
  });
  const t = Template.fromStack(stack);

  it('is served behind the edge authorizer on GET and POST', () => {
    const routes = stack.routes.filter((r) => r.path === '/email/preferences/mine');
    expect(routes.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
    for (const r of routes) expect(r.auth).toBeUndefined();
  });

  it('reaches only `*#notices` items, reads and writes only their preference attributes, and no token', () => {
    const statements = Object.values(t.findResources('AWS::IAM::Policy'))
      .filter((p: any) => JSON.stringify(p.Properties.Roles).includes('EmailPreferencesMineFunction'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const dynamo = statements.filter((x: any) => JSON.stringify(x.Action).includes('dynamodb:'));
    expect(dynamo.map((x: any) => x.Action).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    for (const x of dynamo) expect(x.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys']).toEqual(['*#notices']);
    const write = dynamo.find((x: any) => x.Action === 'dynamodb:UpdateItem');
    expect(write.Condition['ForAllValues:StringEquals']['dynamodb:Attributes']).toEqual(['personId', 'muted', 'personArn', 'updatedAt']);
    expect(JSON.stringify(statements)).not.toContain('tokens');
  });
});
