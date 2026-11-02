/**
 * AN EMAIL IS WORDED FROM THE TEMPLATES OF THE ROOM IT IS ABOUT (ADR-062 decisions 2, 3 and 6).
 *
 * The wrapper, the preference page lines, the invitation, the claim and the briefing are selected like every
 * message: the room primary's own template, its version's legacy `email` keys, the room classification's,
 * then the shipped. The functions that send them read the template store, read-only and the template family
 * alone; a function whose mail is about no conversation reads nothing of it. Proven at synth on the
 * Notifications stack, and on the composers with a store holding saved templates.
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import { Template } from 'aws-cdk-lib/assertions';
import { NotificationStack } from '../lib/stacks/notification-stack';
import { assistantClassifications } from '../lib/config/profiles';
import { emailTemplatesFor, emailCopyFromTemplates, emailLine, defaultEmailVoice, DEFAULT_EMAIL_COPY, type EmailVoice } from '../lambda/src/lib/email-copy';
import { composeEmail } from '../lambda/src/lib/notification';
import { shippedMessageTemplates } from '../lambda/src/lib/shipped-message-templates';
import { putTemplate, activateTemplate, _resetTemplateCache } from '../lambda/src/lib/template-store';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
const BUCKET = { bucketName: 'attachments', bucketArn: 'arn:aws:s3:::attachments' };

describe('the Notifications stack reads the template store for its emails, and nothing else of the bucket', () => {
  const app = new cdk.App();
  const env = { account: '111122223333', region: 'us-east-1' };
  const host = new cdk.Stack(app, 'Host', { env });
  const resources = Template.fromStack(new NotificationStack(app, 'N', {
    env, appInstanceArn: APP, userPoolId: 'us-east-1_PRIMARY', classifications: assistantClassifications(),
    senderEmail: 'assistant@example.com', appUrl: 'https://app.example.com', notifyBridge: true,
    messageStream: kinesis.Stream.fromStreamArn(host, 'S', 'arn:aws:kinesis:us-east-1:111122223333:stream/s'),
    tokens: dynamodb.Table.fromTableArn(host, 'T', 'arn:aws:dynamodb:us-east-1:111122223333:table/tokens'),
    templateBucket: BUCKET,
  })).toJSON().Resources as Record<string, any>;
  const statements = Object.entries(resources).filter(([, r]) => r.Type === 'AWS::IAM::ManagedPolicy' || r.Type === 'AWS::IAM::Policy')
    .flatMap(([id, r]) => (r.Properties.PolicyDocument.Statement as any[]).map((s) => ({ ...s, owner: id })));
  const reads = statements.filter((s) => s.Sid === 'ReadTheMessageTemplates');
  const pointers = statements.filter((s) => s.Sid === 'ReadTheMessageTemplatePointers');
  const fnEnv = Object.values(resources).filter((r) => r.Type === 'AWS::Lambda::Function').map((r) => r.Properties.Environment?.Variables ?? {});

  it('every function with a conversation\'s voice reads the template family and its pointers', () => {
    // The bridge, the transactional mail and the proactive briefing.
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(pointers.length).toBe(reads.length);
    expect(fnEnv.filter((v) => v.TEMPLATE_BUCKET === 'attachments').length).toBe(reads.length);
  });

  it('DENIED: the read is GetObject on `templates/*` and GetParameter on template pointers, and nothing wider', () => {
    for (const s of reads) {
      expect(s.Action).toBe('s3:GetObject');
      expect(s.Resource).toBe('arn:aws:s3:::attachments/templates/*');
    }
    for (const s of pointers) {
      expect(s.Action).toBe('ssm:GetParameter');
      expect(JSON.stringify(s.Resource)).toMatch(/parameter\/agent-echelon\/assistant\/\*\/templates\/\*"/);
    }
    const anyTemplateWrite = statements.filter((s) => s.Effect === 'Allow' && JSON.stringify(s.Resource ?? '').includes('templates')
      && [s.Action].flat().some((a: string) => /Put|Delete|\*/.test(a)));
    expect(anyTemplateWrite).toEqual([]);
  });
});

/** An in-memory bucket and parameter store. */
function fakeStore() {
  const objects = new Map<string, string>();
  const params = new Map<string, string>();
  const s3 = { send: jest.fn(async (cmd: any) => {
    const i = cmd.input;
    if (cmd.constructor.name === 'PutObjectCommand') { objects.set(i.Key, i.Body); return {}; }
    if (!objects.has(i.Key)) throw Object.assign(new Error('nk'), { name: 'NoSuchKey' });
    return { Body: { transformToString: async () => objects.get(i.Key) } };
  }) };
  const ssm = { send: jest.fn(async (cmd: any) => {
    const i = cmd.input;
    if (cmd.constructor.name === 'PutParameterCommand') { params.set(i.Name, i.Value); return {}; }
    if (!params.has(i.Name)) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
    return { Parameter: { Value: params.get(i.Name) } };
  }) };
  return { s3: s3 as any, ssm: ssm as any, bucket: 'b', ssmRoot: '/ae', now: () => 1 };
}
const reworded = (name: string, section: string, text: string) => {
  const { source, template } = shippedMessageTemplates().get(name)!;
  return source.replace(`# ${section}\n${template.messageSections![section]}\n`, `# ${section}\n${text}\n`);
};
async function save(deps: ReturnType<typeof fakeStore>, source: string, owner?: any) {
  const put = await putTemplate('basic', source, deps, { owner });
  await activateTemplate('basic', put.name, put.contentHash, deps, { owner });
}

describe('the emails are worded from the selected templates', () => {
  beforeEach(() => _resetTemplateCache());

  it('with nothing stored and no legacy wording, the shipped lines, word for word', async () => {
    const t = await emailTemplatesFor({ classification: 'basic', assistant: 'advisor' }, fakeStore());
    expect(emailCopyFromTemplates(t)).toEqual(DEFAULT_EMAIL_COPY);
  });

  it('an assistant\'s saved wrapper reaches the email; the classification\'s reaches an assistant with none', async () => {
    const deps = fakeStore();
    await save(deps, reworded('notification-email', 'email.greeting', 'Dear {{name}},'), { family: 'assistant', assistant: 'advisor' });
    await save(deps, reworded('notification-email', 'email.signOff', 'Kind regards,'));
    const advisor: EmailVoice = { ...defaultEmailVoice(), templates: await emailTemplatesFor({ classification: 'basic', assistant: 'advisor' }, deps) };
    const concierge: EmailVoice = { ...defaultEmailVoice(), templates: await emailTemplatesFor({ classification: 'basic', assistant: 'concierge' }, deps) };
    concierge.copy = emailCopyFromTemplates(concierge.templates!);
    expect(composeEmail({ email: 'r@example.com', name: 'Riley' }, { subject: 's', bodyText: 'Body', voice: advisor }).text).toMatch(/^Dear Riley,\n/);
    expect(composeEmail({ email: 'r@example.com', name: 'Riley' }, { subject: 's', bodyText: 'Body', voice: concierge }).text).toContain('Kind regards,');
  });

  it('a version\'s retired `email` key is not read: the shipped line is said until a template is saved', async () => {
    const t = await emailTemplatesFor({ classification: 'basic', assistant: 'advisor', copy: { email: { invitationSubject: '{sender} te invitó' } } } as never, fakeStore());
    expect(emailLine({ ...defaultEmailVoice(), templates: t }, 'invitationSubject', { sender: 'Riley', title: 'Q3' })).toBe('Riley invited you to a conversation');
  });

  it('the preference line keeps its link as the only markup in the HTML part', () => {
    const html = composeEmail({ email: 'r@example.com', name: 'Riley', unsubscribeUrl: 'https://app.example.com/p?t=abc' }, { subject: 's', bodyText: 'b' }).html;
    expect(html).toContain('Manage which emails you receive: <a href="https://app.example.com/p?t=abc">https://app.example.com/p?t=abc</a>');
  });
});
