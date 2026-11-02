/**
 * B10: A REPLY BY EMAIL IS POSTED ONLY THROUGH A VALID REPLY TOKEN, ONLY WITH DMARC, AND ONLY AS THE PERSON.
 *
 *  - mail without a valid reply token posts nothing (no token, a token on another domain, an unknown or
 *    an expired token);
 *  - a reply with a valid token whose From fails DMARC posts nothing, even with SPF and DKIM passing;
 *  - a From that is not the address the person's issuer holds for them now posts nothing, and a person
 *    offboarded or disabled at their pool (no address) posts nothing;
 *  - an accepted reply is posted to the token's conversation as the token's person, never as anyone a
 *    header names, on the person's own bearer-pinned session (the one-conversation role, `person` and
 *    `classification` tags, a session policy of one channel and `SendChannelMessage`);
 *  - a reply token is valid 14 days, is minted per (conversation, person, notice), and is stored only as its hash;
 *  - the receipt rule and the poster's grants, at synth.
 */
jest.unmock('../../lambda/src/lib/email-consent');

const mockChimeSend = jest.fn();
const mockChimeCtor = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => {
  const actual = jest.requireActual('@aws-sdk/client-chime-sdk-messaging');
  return {
    ...actual,
    ChimeSDKMessagingClient: jest.fn().mockImplementation((cfg) => { mockChimeCtor(cfg); return { send: mockChimeSend }; }),
  };
});

import * as cdk from 'aws-cdk-lib';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template } from 'aws-cdk-lib/assertions';
import { createHash } from 'crypto';
import {
  addressOf, decideReply, replyAddressFor, replyTextOf, tokenOfRecipient, REPLY_TOKEN_TTL_SECONDS, type ReceivedMail, type ReplyDeps,
} from '../../lambda/src/lib/reply-tokens';
import { newCaseFreeToken, tokenRecordOf, TOKEN_KINDS } from '../../lambda/src/lib/tokens';
import { deployedEmailConsent } from '../../lambda/src/lib/email-consent';
import { handleReceived, pinnedPoster, receivedMailOf, type EmailReplyDeps } from '../../lambda/src/email-reply';
import { NotificationStack } from '../../lib/stacks/notification-stack';
import { assistantClassifications } from '../../lib/config/profiles';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const PERSON_ID = '0192f0e0-0000-7000-8000-000000000001';
const RILEY = `${APP}/user/${PERSON_ID}`;
const CHANNEL = `${APP}/channel/c1`;
const DOMAIN = 'replies.example.com';
const NOW = 1_800_000_000;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const TOKEN = newCaseFreeToken();

const mail = (over: Partial<ReceivedMail> = {}, verdicts: ReceivedMail['verdicts'] = {}): ReceivedMail => ({
  messageId: 'm-1',
  recipients: [replyAddressFor(TOKEN, DOMAIN)],
  from: 'Riley <Riley@Example.com>',
  verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS', spam: 'PASS', virus: 'PASS', ...verdicts },
  ...over,
});

function deps(over: Partial<ReplyDeps> = {}): ReplyDeps {
  return {
    replyDomain: DOMAIN,
    now: NOW,
    token: async (t) => (t === TOKEN ? { ok: true, record: { channelArn: CHANNEL, personArn: RILEY, expiresAt: NOW + 60, noticeId: 'n-1' } } : { ok: false, reason: 'unknown' }),
    contactOf: async (arn) => (arn === RILEY ? 'riley@example.com' : null),
    text: async () => 'Sounds good, ship it.',
    ...over,
  };
}

describe('the reply token', () => {
  it('is 256 bits in lowercase base32, valid 14 days, and is carried in the reply address', () => {
    expect(TOKEN).toMatch(/^[a-z2-7]{52}$/);
    expect(REPLY_TOKEN_TTL_SECONDS).toBe(14 * 86_400);
    expect(TOKEN_KINDS.reply).toMatchObject({ redemption: 'bounded', built: true, writer: 'notifications' });
    expect(replyAddressFor(TOKEN, 'Replies.Example.com')).toBe(`reply+${TOKEN}@replies.example.com`);
    expect(tokenOfRecipient(`REPLY+${TOKEN.toUpperCase()}@REPLIES.EXAMPLE.COM`, DOMAIN)).toBe(TOKEN);
    expect(tokenOfRecipient(`reply+${TOKEN}@other.example.com`, DOMAIN)).toBeNull();
    expect(tokenOfRecipient('support@replies.example.com', DOMAIN)).toBeNull();
    expect(addressOf('"Riley Chen" <Riley@Example.com>')).toBe('riley@example.com');
  });

  it('is minted per (conversation, person, notice), and the store keeps only its hash', async () => {
    const rows = new Map<string, any>();
    const doc = { send: async (cmd: any) => { rows.set(cmd.input.Item.pk, cmd.input.Item); return {}; } };
    const consent = deployedEmailConsent({ TOKENS_TABLE: 'Tokens', REPLY_DOMAIN: DOMAIN } as never, { doc, ssm: { send: async () => ({}) }, now: () => NOW * 1000 });
    const address = await consent.replyAddress({ personArn: RILEY, channelArn: CHANNEL, noticeId: 'n-1', kind: 'conversation' });
    const token = tokenOfRecipient(address!, DOMAIN)!;
    const rec = rows.get(`reply#${sha(token)}`);
    expect(rec).toMatchObject({ kind: 'reply', channelArn: CHANNEL, personArn: RILEY, noticeId: 'n-1', redemption: 'bounded', expiresAt: NOW + REPLY_TOKEN_TTL_SECONDS });
    expect(JSON.stringify([...rows.values()])).not.toContain(token);
  });
});

describe('mail without a valid reply token posts nothing', () => {
  it.each([
    ['no reply address at all', mail({ recipients: ['support@replies.example.com'] }), 'no-token'],
    ['a token on another domain', mail({ recipients: [`reply+${TOKEN}@attacker.example`] }), 'no-token'],
    ['a token this deployment never minted', mail({ recipients: [replyAddressFor(newCaseFreeToken(), DOMAIN)] }), 'token-unknown'],
  ])('%s', async (_name, m, reason) => {
    expect(await decideReply(m, deps())).toEqual({ post: false, reason });
  });

  it('an expired token, before TTL has deleted it', async () => {
    expect(await decideReply(mail(), deps({ token: async () => ({ ok: false, reason: 'expired' }) }))).toEqual({ post: false, reason: 'token-expired' });
    expect(await decideReply(mail(), deps({ token: async () => ({ ok: true, record: { channelArn: CHANNEL, personArn: RILEY, expiresAt: NOW } }) })))
      .toEqual({ post: false, reason: 'token-expired' });
  });

  it('a virus or a spam verdict', async () => {
    expect(await decideReply(mail({}, { virus: 'FAIL' }), deps())).toEqual({ post: false, reason: 'virus' });
    expect(await decideReply(mail({}, { spam: 'FAIL' }), deps())).toEqual({ post: false, reason: 'spam' });
  });
});

describe('a valid token is not enough', () => {
  it.each(['FAIL', 'GRAY', 'PROCESSING_FAILED', undefined])('DMARC %s posts nothing, even with SPF and DKIM passing', async (dmarc) => {
    expect(await decideReply(mail({}, { spf: 'PASS', dkim: 'PASS', dmarc }), deps())).toEqual({ post: false, reason: 'dmarc' });
  });

  it('a From that is not the person\'s address now posts nothing', async () => {
    expect(await decideReply(mail({ from: 'riley@example.org' }), deps())).toEqual({ post: false, reason: 'from-not-the-person' });
  });

  it('a person offboarded or disabled at their pool (the directory holds no address for them) posts nothing', async () => {
    expect(await decideReply(mail(), deps({ contactOf: async () => null }))).toEqual({ post: false, reason: 'person-not-reachable' });
  });

  it('a reply with nothing left once the quote is removed posts nothing', async () => {
    expect(await decideReply(mail(), deps({ text: async () => '   ' }))).toEqual({ post: false, reason: 'empty' });
  });

  it('otherwise, it is posted to the token\'s conversation as the token\'s person', async () => {
    expect(await decideReply(mail(), deps())).toEqual({ post: true, channelArn: CHANNEL, personArn: RILEY, text: 'Sounds good, ship it.', noticeId: 'n-1' });
  });
});

describe('the handler', () => {
  function world(record = tokenRecordOf('reply', TOKEN, { channelArn: CHANNEL, personArn: RILEY, issuer: '', expiresAt: NOW + 60 })) {
    const s3Calls: string[] = [];
    const posted: any[] = [];
    const d: EmailReplyDeps = {
      replyDomain: DOMAIN, tokensTable: 'Tokens', inboundBucket: 'inbound', inboundPrefix: 'replies/', restrictedRoleArn: 'arn:aws:iam::111122223333:role/restricted',
      doc: { send: async (cmd: any) => ({ Item: cmd.input.Key.pk === record.pk ? record : undefined }) },
      s3: {
        send: async (cmd: any) => {
          s3Calls.push(`${cmd.constructor.name} ${cmd.input.Key}`);
          return cmd.constructor.name === 'GetObjectCommand'
            ? { Body: { transformToString: async () => 'Content-Type: text/plain\r\n\r\nYes, Thursday works.\r\n\r\nOn Mon, Oct 19, 2026 at 9:00 AM Aurora wrote:\r\n> The earlier message\r\n' } }
            : {};
        },
      },
      directory: { contactFor: async () => ({ route: 'email', address: 'riley@example.com', name: 'Riley' }) } as never,
      postAsPerson: async (a) => { posted.push(a); return 'msg-1'; },
      now: () => NOW * 1000,
    };
    return { d, s3Calls, posted };
  }
  const quiet = () => [jest.spyOn(console, 'log').mockImplementation(() => undefined)];

  it('a mail without a token posts nothing, reads no body, and deletes the stored copy', async () => {
    const spies = quiet();
    const w = world();
    const res = await handleReceived(mail({ recipients: ['someone@replies.example.com'] }), w.d);
    spies.forEach((s) => s.mockRestore());
    expect(res).toEqual({ post: false, reason: 'no-token' });
    expect(w.posted).toEqual([]);
    expect(w.s3Calls).toEqual(['DeleteObjectCommand replies/m-1']);
  });

  it('an accepted reply is posted once per message, as the person, with the quoted thread removed', async () => {
    const spies = quiet();
    const w = world();
    const res = await handleReceived(mail(), w.d);
    spies.forEach((s) => s.mockRestore());
    expect(res).toMatchObject({ post: true });
    expect(w.posted).toEqual([{ personArn: RILEY, channelArn: CHANNEL, text: 'Yes, Thursday works.', idempotencyKey: sha('m-1') }]);
  });

  it('reads SES\'s receipt event: recipients, From and every verdict', () => {
    expect(receivedMailOf({ ses: {
      mail: { messageId: 'm', commonHeaders: { from: ['a@b.example'] } },
      receipt: { recipients: ['r@x'], spfVerdict: { status: 'PASS' }, dkimVerdict: { status: 'FAIL' }, dmarcVerdict: { status: 'FAIL' }, spamVerdict: { status: 'PASS' }, virusVerdict: { status: 'PASS' } },
    } })).toEqual({ messageId: 'm', recipients: ['r@x'], from: 'a@b.example', verdicts: { spf: 'PASS', dkim: 'FAIL', dmarc: 'FAIL', spam: 'PASS', virus: 'PASS' } });
  });
});

describe('posted on the person\'s own bearer-pinned session, never as a service identity', () => {
  it('assumes the one-conversation role with the person and classification tags, narrowed to one channel and SendChannelMessage', async () => {
    const assumes: any[] = [];
    const sts = { send: async (cmd: any) => { assumes.push(cmd.input); return { Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST' } }; } };
    mockChimeSend.mockResolvedValue({ MessageId: 'msg-1' });
    const id = await pinnedPoster('arn:aws:iam::111122223333:role/restricted', sts)({ personArn: RILEY, channelArn: CHANNEL, text: 'hi', idempotencyKey: 'k' });
    expect(id).toBe('msg-1');
    expect(assumes).toHaveLength(1);
    expect(assumes[0].RoleArn).toBe('arn:aws:iam::111122223333:role/restricted');
    expect(assumes[0].Tags).toEqual([{ Key: 'person', Value: PERSON_ID }, { Key: 'classification', Value: 'restricted' }]);
    expect(JSON.parse(assumes[0].Policy).Statement).toEqual([
      { Sid: 'OneConversationReply', Effect: 'Allow', Action: ['chime:SendChannelMessage'], Resource: [CHANNEL, RILEY] },
    ]);
    // The message is sent on the vended credentials, bearing the person.
    expect(mockChimeCtor).toHaveBeenCalledWith(expect.objectContaining({ credentials: { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' } }));
    expect(mockChimeSend.mock.calls[0][0].input).toMatchObject({ ChannelArn: CHANNEL, ChimeBearer: RILEY, Content: 'hi', ClientRequestToken: 'k' });
  });

  it('refuses a person and a conversation of different app instances', async () => {
    const sts = { send: jest.fn() };
    await expect(pinnedPoster('r', sts)({ personArn: RILEY, channelArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/other/channel/c', text: 'x', idempotencyKey: 'k' }))
      .rejects.toThrow(/one app instance/);
    expect(sts.send).not.toHaveBeenCalled();
  });
});

describe('the reply text', () => {
  it('is the first text part, decoded, without the quoted thread', () => {
    const qp = [
      'Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable', '', 'Caf=C3=A9 at noon? A long line that is wrapped =', 'here.', '',
      '> quoted', '--b1', 'Content-Type: text/html', '', '<p>ignored</p>', '--b1--',
    ].join('\r\n');
    expect(replyTextOf(qp)).toBe('Café at noon? A long line that is wrapped here.');
    const html = ['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from('<div>Hi<br>there &amp; you</div>').toString('base64')].join('\r\n');
    expect(replyTextOf(html)).toBe('Hi\nthere & you');
  });
});

describe('the receipt rule and the poster, at synth', () => {
  const app = new cdk.App({ context: { replyDomain: 'Replies.Example.com', replyRuleSet: 'active-set' } });
  const env = { account: '111122223333', region: 'us-east-1' };
  const host = new cdk.Stack(app, 'Host', { env });
  const t = Template.fromStack(new NotificationStack(app, 'N', {
    env, appInstanceArn: APP, userPoolId: 'us-east-1_PRIMARY', classifications: assistantClassifications(),
    senderEmail: 'assistant@example.com', appUrl: 'https://app.example.com',
    messageStream: kinesis.Stream.fromStreamArn(host, 'S', 'arn:aws:kinesis:us-east-1:111122223333:stream/s'),
    tokens: dynamodb.Table.fromTableArn(host, 'T', 'arn:aws:dynamodb:us-east-1:111122223333:table/tokens'),
    replyPoster: { roleArn: 'arn:aws:iam::111122223333:role/poster', restrictedRoleArn: 'arn:aws:iam::111122223333:role/restricted' },
  }));

  it('is a rule on the reply subdomain in the named active rule set: store, then invoke', () => {
    const rules = Object.values(t.findResources('AWS::SES::ReceiptRule')) as any[];
    expect(rules).toHaveLength(1);
    expect(rules[0].Properties.RuleSetName).toBe('active-set');
    expect(rules[0].Properties.Rule.Recipients).toEqual(['replies.example.com']);
    expect(rules[0].Properties.Rule.ScanEnabled).toBe(true);
    expect(rules[0].Properties.Rule.Actions.map((a: any) => Object.keys(a)[0])).toEqual(['S3Action', 'LambdaAction']);
  });

  it('every sender\'s mail carries a reply address on that domain', () => {
    const fns = Object.values(t.findResources('AWS::Lambda::Function')) as any[];
    const senders = fns.filter((f) => f.Properties.Environment?.Variables?.TOKENS_TABLE && f.Properties.Environment?.Variables?.PERSON_API_URL_PARAM);
    expect(senders.length).toBeGreaterThanOrEqual(2);
    for (const f of senders) expect(f.Properties.Environment.Variables.REPLY_DOMAIN).toBe('replies.example.com');
  });

  it('the poster reads `reply#*` tokens and nothing else in the store, and holds no send of its own', () => {
    const statements = (Object.values(t.findResources('AWS::IAM::Policy')) as any[])
      .filter((p) => JSON.stringify(p.Properties.Roles).includes('poster'))
      .flatMap((p) => p.Properties.PolicyDocument.Statement);
    const tokenReads = statements.filter((s) => JSON.stringify(s.Resource).includes('tokens'));
    expect(tokenReads).toEqual([expect.objectContaining({ Action: 'dynamodb:GetItem', Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['reply#*'] } } })]);
    expect(JSON.stringify(statements)).not.toMatch(/chime:SendChannelMessage|ses:Send/);
  });
});

describe('the poster may assume the one-conversation role only with the person pinned, at synth', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MessagingStack } = require('../../lib/stacks/messaging-stack');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { IdentityStack } = require('../../lib/stacks/identity-stack');
  const app = new cdk.App();
  const env = { account: '111122223333', region: 'us-east-1' };
  const messaging = new MessagingStack(app, 'M', { env, appInstanceName: 'test-instance' });
  const identity = new IdentityStack(app, 'I', { env, appInstanceArn: messaging.appInstanceArn, emailReplies: true });
  const t = Template.fromStack(identity);

  it('the restricted role trusts the poster role with the same person and classification assertions as the exchange', () => {
    const roles = t.findResources('AWS::IAM::Role') as Record<string, any>;
    const restricted = Object.entries(roles).find(([id]) => id.startsWith('ExchangeRoleRestricted'))![1];
    const posterId = Object.keys(roles).find((id) => id.startsWith('EmailReplyPosterRole'))!;
    const trust = restricted.Properties.AssumeRolePolicyDocument.Statement
      .filter((s: any) => JSON.stringify(s.Principal).includes(posterId));
    expect(trust).toHaveLength(1);
    expect(trust[0].Action.sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    expect(trust[0].Condition).toEqual({
      StringLike: { 'aws:RequestTag/person': '*' },
      StringEquals: { 'aws:RequestTag/classification': 'restricted' },
    });
    expect(identity.replyPoster).toBeDefined();
  });

  it('with no reply domain there is no poster role', () => {
    const app2 = new cdk.App();
    const m2 = new MessagingStack(app2, 'M', { env, appInstanceName: 'test-instance' });
    const i2 = new IdentityStack(app2, 'I', { env, appInstanceArn: m2.appInstanceArn });
    expect(i2.replyPoster).toBeUndefined();
    expect(Object.keys(Template.fromStack(i2).findResources('AWS::IAM::Role')).some((id) => id.startsWith('EmailReplyPosterRole'))).toBe(false);
  });
});
