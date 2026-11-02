/**
 * WHICH MESSAGE TEMPLATE IS SAID, AND WHO MAY WRITE ONE (ADR-062 decisions 2 and 3).
 *
 * Selection is the template the version's `messages` names, else the assistant's own family, then the
 * classification's, then a deployment-wide line, then the shipped template. A version's retired `copy` is never read:
 * `npm run migrate-legacy-copy` makes its lines the assistant's own templates. Each family is its
 * own key prefix under the classification (`_assistants/<assistant>/`, the classification's, `_shipped/`), so a
 * key names its owner.
 *
 * The console's writer stores only in the assistant family of the assistant the route names, and only a
 * template the platform ships, parsed and fitting that template's call site. A team member's route for one
 * assistant cannot write another's.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { selectMessageTemplate, storedTemplateMisfit } from '../../lambda/src/lib/message-template-selection';
import { shippedMessageTemplates, shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';
import { readFileSync } from 'fs';
import { join } from 'path';
import { noticeLine } from '../../lambda/src/lib/assistant-notice';
import { messageTemplateChoice } from '../../lambda/src/lib/message-lines';
import { joinRecapRequestFor, DEFAULT_JOIN_RECAP_REQUEST } from '../../lambda/src/lib/join-recap';
import {
  putTemplate,
  activateTemplate,
  loadTemplate,
  templateKey,
  templatePointerName,
  templateFamilyPrefix,
  listTemplates,
  _resetTemplateCache,
} from '../../lambda/src/lib/template-store';
import { contentIdOf } from '../../lambda/src/lib/profile-bodies';
import { messagesShapeErrors } from '../../lambda/src/lib/profile-copy-fields';
import { messageTemplateErrors, classificationServedBy } from '../../lambda/src/lib/profile-lifecycle';

jest.mock('../../lambda/src/lib/auth', () => {
  const actual = jest.requireActual('../../lambda/src/lib/auth');
  return { ...actual, callerActor: jest.fn(async () => 'person-1'), callerCanManageProfiles: jest.fn(() => true) };
});
// eslint-disable-next-line import/first
import { handleTemplates, saveRefusal } from '../../lambda/src/manage-message-templates';

/** An in-memory bucket and parameter store, answering the commands the store sends. */
function fakeStore() {
  const objects = new Map<string, string>();
  const params = new Map<string, string>();
  const s3 = {
    send: jest.fn(async (cmd: any) => {
      const input = cmd.input;
      switch (cmd.constructor.name) {
        case 'PutObjectCommand':
          if (input.IfNoneMatch === '*' && objects.has(input.Key)) throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
          objects.set(input.Key, input.Body);
          return {};
        case 'GetObjectCommand':
          if (!objects.has(input.Key)) throw Object.assign(new Error('no key'), { name: 'NoSuchKey' });
          return { Body: { transformToString: async () => objects.get(input.Key) } };
        case 'ListObjectsV2Command':
          return { Contents: [...objects.keys()].filter((k) => k.startsWith(input.Prefix)).map((Key) => ({ Key })) };
        default:
          throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    }),
  };
  const ssm = {
    send: jest.fn(async (cmd: any) => {
      const input = cmd.input;
      if (cmd.constructor.name === 'GetParameterCommand') {
        if (!params.has(input.Name)) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
        return { Parameter: { Value: params.get(input.Name) } };
      }
      if (cmd.constructor.name === 'PutParameterCommand') {
        params.set(input.Name, input.Value);
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    }),
  };
  const deps = { s3: s3 as any, ssm: ssm as any, bucket: 'b', ssmRoot: '/ae', now: () => 1_000 };
  return { objects, params, deps };
}

/** The shipped source of a template with one section's text replaced: a rewording that fits its call site. */
function reworded(name: string, section: string, text: string): string {
  const { source, template } = shippedMessageTemplates().get(name)!;
  return source.replace(`# ${section}\n${template.messageSections![section]}\n`, `# ${section}\n${text}\n`);
}

async function save(store: ReturnType<typeof fakeStore>, classification: string, source: string, owner?: any) {
  const put = await putTemplate(classification, source, store.deps, { owner });
  await activateTemplate(classification, put.name, put.contentHash, store.deps, { owner });
  return put;
}

beforeEach(() => _resetTemplateCache());

describe('each owner has its own key family under the classification', () => {
  const hash = contentIdOf('x');

  it('the classification\'s keys are where document templates have always been; the assistant\'s and the shipped are their own prefixes', () => {
    expect(templateKey('basic', 'member-welcome', hash)).toBe(`templates/basic/member-welcome/${hash}.md`);
    expect(templateKey('basic', 'member-welcome', hash, { family: 'assistant', assistant: 'advisor' })).toBe(`templates/basic/_assistants/advisor/member-welcome/${hash}.md`);
    expect(templateKey('basic', 'member-welcome', hash, { family: 'shipped' })).toBe(`templates/basic/_shipped/member-welcome/${hash}.md`);
    expect(templatePointerName('/ae', 'basic', 'member-welcome', { family: 'assistant', assistant: 'advisor' })).toBe('/ae/assistant/basic/templates/_assistants/advisor/member-welcome');
  });

  it('REFUSES an assistant segment that could climb out of its family', () => {
    expect(() => templateFamilyPrefix('basic', { family: 'assistant', assistant: '../premium' })).toThrow(/assistant name/);
    expect(() => templateFamilyPrefix('basic', { family: 'assistant', assistant: '' })).toThrow(/assistant name/);
  });

  it('a family\'s listing holds its own keys and none of another family\'s', async () => {
    const store = fakeStore();
    await save(store, 'basic', reworded('member-joined', 'chat', '{{name}} is here.'));
    await save(store, 'basic', reworded('member-joined', 'chat', '{{name}} arrived.'), { family: 'assistant', assistant: 'advisor' });
    expect((await listTemplates('basic', store.deps)).map((t) => t.name)).toEqual(['member-joined']);
    expect((await listTemplates('basic', store.deps, { family: 'assistant', assistant: 'advisor' })).map((t) => t.name)).toEqual(['member-joined']);
    expect(await listTemplates('basic', store.deps, { family: 'assistant', assistant: 'other' })).toEqual([]);
  });

  it('a workflow\'s document reference never loads a message template, and a message read never loads a document', async () => {
    const store = fakeStore();
    await save(store, 'basic', reworded('member-joined', 'chat', '{{name}} is here.'));
    await expect(loadTemplate('basic', { name: 'member-joined' }, store.deps)).rejects.toThrow(/is a message, not a document/);
    await expect(loadTemplate('basic', { name: 'member-joined' }, store.deps, { kind: 'message' })).resolves.toEqual(expect.objectContaining({ name: 'member-joined' }));
  });
});

describe('selection: the assistant\'s own, the classification\'s, then the shipped', () => {
  const at = { classification: 'basic', assistant: 'advisor', name: 'member-welcome' };
  const values = { name: 'Riley', recap: 'the Q3 review' };
  const chat = (t: any) => (renderMessageTemplate(t, values) as any).sections.chat;

  it('with nothing stored, the shipped template', async () => {
    const store = fakeStore();
    const s = await selectMessageTemplate(at, store.deps);
    expect(s.origin).toBe('shipped');
    expect(s.template).toBe(shippedMessageTemplate('member-welcome'));
  });

  it('the classification\'s template over the shipped one', async () => {
    const store = fakeStore();
    await save(store, 'basic', reworded('member-welcome', 'chat', 'Hello {{name}}, this is {{recap}}.'));
    const s = await selectMessageTemplate(at, store.deps);
    expect(s.origin).toBe('classification');
    expect(chat(s.template)).toBe('Hello Riley, this is the Q3 review.');
  });

  it('SELECTION HAS NO LEGACY STEP: a version\'s retired `copy` lines never reach a message', async () => {
    const store = fakeStore();
    await save(store, 'basic', reworded('member-welcome', 'chat', 'Hello {{name}}, this is {{recap}}.'));
    // A caller that still hands a version's copy in is not read: the classification's template answers.
    const s = await selectMessageTemplate({ ...at, copy: { memberWelcome: 'Hola {name}, bienvenida a {recap}.' } } as any, store.deps);
    expect(s.origin).toBe('classification');
    expect(chat(s.template)).toBe('Hello Riley, this is the Q3 review.');
    // Nor does a synchronous line read the words object's own keys: only the templates it carries.
    expect(messageTemplateChoice('member-welcome', { copy: { memberWelcome: 'Hola {name}.' } }).origin).toBe('shipped');
    const source = readFileSync(join(__dirname, '../../lambda/src/lib/message-template-selection.ts'), 'utf8')
      + readFileSync(join(__dirname, '../../lambda/src/lib/message-lines.ts'), 'utf8');
    expect(source).not.toMatch(/legacyLinesOf|legacyLines|input\.copy/);
  });

  it('the assistant\'s own template over the classification\'s', async () => {
    const store = fakeStore();
    await save(store, 'basic', reworded('member-welcome', 'chat', 'Hello {{name}}, this is {{recap}}.'));
    await save(store, 'basic', reworded('member-welcome', 'chat', 'Welcome aboard, {{name}}.'), { family: 'assistant', assistant: 'advisor' });
    const s = await selectMessageTemplate(at, store.deps);
    expect(s.origin).toBe('assistant');
    expect(chat(s.template)).toBe('Welcome aboard, Riley.');
  });

  it('A VERSION MAY PICK A FAMILY: @classification skips the assistant\'s own, @shipped skips both', async () => {
    const store = fakeStore();
    await save(store, 'basic', reworded('member-welcome', 'chat', 'Hello {{name}}, this is {{recap}}.'));
    await save(store, 'basic', reworded('member-welcome', 'chat', 'Welcome aboard, {{name}}.'), { family: 'assistant', assistant: 'advisor' });
    expect((await selectMessageTemplate({ ...at, messages: { 'member-welcome': '@classification' } }, store.deps)).origin).toBe('classification');
    expect((await selectMessageTemplate({ ...at, messages: { 'member-welcome': '@shipped' } }, store.deps)).origin).toBe('shipped');
    // With no classification template of the name, @classification answers the shipped one.
    expect((await selectMessageTemplate({ ...at, name: 'member-joined', messages: { 'member-joined': '@classification' } }, store.deps)).origin).toBe('shipped');
    // The synchronous lines follow the same rule.
    const own = new Map([['member-welcome', shippedMessageTemplate('member-welcome')]]);
    expect(messageTemplateChoice('member-welcome', { templates: { own, classwide: new Map(), messages: { 'member-welcome': '@shipped' } } }).origin).toBe('shipped');
    expect(messageTemplateChoice('member-welcome', { templates: { own, classwide: new Map() } }).origin).toBe('assistant');
    // The draft takes a family as a value, and validate reads no store for it.
    expect(messagesShapeErrors({ 'member-welcome': '@shipped', 'member-joined': [{ template: '@classification' }] })).toEqual([]);
    expect(messagesShapeErrors({ 'member-welcome': '@nobody' })).toEqual([expect.stringMatching(/@classification or @shipped/)]);
  });

  it('one assistant\'s template is never another\'s', async () => {
    const store = fakeStore();
    await save(store, 'basic', reworded('member-welcome', 'chat', 'Welcome aboard, {{name}}.'), { family: 'assistant', assistant: 'advisor' });
    expect((await selectMessageTemplate({ ...at, assistant: 'concierge' }, store.deps)).origin).toBe('shipped');
  });

  it('a stored template that asks for a value the call site does not supply is passed over, and the next family answers', async () => {
    const store = fakeStore();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const misfit = reworded('member-welcome', 'chat', 'Welcome, {{name}} ({{secret}}).').replace('"title":"conversation:title"', '"title":"conversation:title","secret":"value:text"');
    await save(store, 'basic', misfit, { family: 'assistant', assistant: 'advisor' });
    expect((await selectMessageTemplate(at, store.deps)).origin).toBe('shipped');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not fit'), expect.objectContaining({ family: 'assistant' }));
    warn.mockRestore();
  });

  it('a store that cannot be read answers the shipped template (tenet D5): a message is always said', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = { ...fakeStore().deps, ssm: { send: jest.fn(async () => { throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' }); }) } as any };
    expect((await selectMessageTemplate(at, broken)).origin).toBe('shipped');
    warn.mockRestore();
  });

  it('a deployment-wide line stands between the classification\'s and the shipped', async () => {
    const store = fakeStore();
    const s = await selectMessageTemplate({ classification: 'basic', name: 'budget-exhausted', deploymentLines: { chat: 'We are busy.' } }, store.deps);
    expect(s.origin).toBe('deployment');
    expect(noticeLine(undefined, 'budgetExhausted', {}, undefined, s.template)).toBe('We are busy.');
  });

  it('the join recap is asked from the assistant\'s own `join-recap` prompt when one is saved', async () => {
    const store = fakeStore();
    expect(await joinRecapRequestFor({ classification: 'basic', assistant: 'advisor' }, store.deps)).toBe(DEFAULT_JOIN_RECAP_REQUEST);
    await save(store, 'basic', reworded('join-recap', 'prompt', 'Resume la conversación para quien acaba de llegar.'), { family: 'assistant', assistant: 'advisor' });
    expect(await joinRecapRequestFor({ classification: 'basic', assistant: 'advisor' }, store.deps))
      .toBe('Resume la conversación para quien acaba de llegar.');
  });

  it('a stored template fits its call site only with the shipped kind and declared fields', () => {
    const shipped = shippedMessageTemplate('member-welcome');
    expect(storedTemplateMisfit(shipped, shipped)).toBeUndefined();
    expect(storedTemplateMisfit({ ...shipped, kind: 'prompt' }, shipped)).toMatch(/prompt/);
    expect(storedTemplateMisfit({ ...shipped, fields: { ...shipped.fields, extra: 'value:text' } }, shipped)).toMatch(/extra/);
  });
});

describe('the console\'s writer: an assistant\'s own family, and only the assistant the route names', () => {
  const identities = async () => [
    { assistant: 'advisor', classification: 'basic' },
    { assistant: 'concierge', classification: 'basic' },
  ] as any[];
  const event = (over: Partial<APIGatewayProxyEvent>): APIGatewayProxyEvent => ({
    httpMethod: 'POST', path: '/admin/templates/save', headers: {}, body: null, pathParameters: null, queryStringParameters: null, ...over,
  } as unknown as APIGatewayProxyEvent);
  const teamScope = (assistant: string) => jest.fn(async () => ({ assistant, bots: [{ assistant, classification: 'basic' }] as any[] }));
  const source = reworded('member-welcome', 'chat', 'Welcome aboard, {{name}}.');

  it('saves into the named assistant\'s family and makes it active; the classification\'s family is untouched', async () => {
    const store = fakeStore();
    const res = await handleTemplates(event({ body: JSON.stringify({ profileName: 'advisor', source }) }), { store: store.deps, identities, scope: jest.fn(async () => null) });
    expect(res.statusCode).toBe(200);
    expect([...store.objects.keys()]).toEqual([`templates/basic/_assistants/advisor/member-welcome/${contentIdOf(source)}.md`]);
    expect([...store.params.keys()]).toEqual(['/ae/assistant/basic/templates/_assistants/advisor/member-welcome']);
  });

  it('DENIED: a team member\'s route for one assistant cannot write another\'s', async () => {
    const store = fakeStore();
    const res = await handleTemplates(event({
      path: '/admin/assistants/advisor/templates/save', pathParameters: { assistant: 'advisor' },
      body: JSON.stringify({ profileName: 'concierge', source }),
    }), { store: store.deps, identities, scope: teamScope('advisor') });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('ASSISTANT_MISMATCH');
    expect(store.objects.size + store.params.size).toBe(0);
  });

  it('DENIED: a team route for an assistant the caller\'s team does not own is refused before anything is read', async () => {
    const store = fakeStore();
    const refused = { statusCode: 403, body: JSON.stringify({ code: 'ASSISTANT_NOT_OWNED' }), headers: {} };
    const res = await handleTemplates(event({ path: '/admin/assistants/concierge/templates/save', pathParameters: { assistant: 'concierge' }, body: JSON.stringify({ source }) }),
      { store: store.deps, identities, scope: jest.fn(async () => refused) });
    expect(res).toBe(refused);
    expect(store.objects.size + store.params.size).toBe(0);
  });

  it('DENIED: no body names the family: a write is the route\'s assistant\'s, never the classification\'s or the shipped', async () => {
    const store = fakeStore();
    const res = await handleTemplates(event({
      path: '/admin/assistants/advisor/templates/save', pathParameters: { assistant: 'advisor' },
      body: JSON.stringify({ source, owner: { family: 'classification' }, family: 'shipped' }),
    }), { store: store.deps, identities, scope: teamScope('advisor') });
    expect(res.statusCode).toBe(200);
    expect([...store.objects.keys()].every((k) => k.startsWith('templates/basic/_assistants/advisor/'))).toBe(true);
  });

  it('REFUSES a template the platform does not ship, one that does not parse, and one that asks for a value nobody supplies', () => {
    expect(saveRefusal(source.replace('"name":"member-welcome"', '"name":"my-own-line"'))).toMatch(/not a template the platform says/);
    expect(saveRefusal('# chat\nHi')).toMatch(/front-matter/);
    expect(saveRefusal(source.replace('"title":"conversation:title"', '"title":"conversation:title","x":"value:text"'))).toMatch(/does not supply/);
    expect(saveRefusal(source)).toBeUndefined();
  });

  it('lists every shipped template beside the classification\'s and the assistant\'s active source', async () => {
    const store = fakeStore();
    await save(store, 'basic', reworded('member-joined', 'chat', '{{name}} is here.'));
    await save(store, 'basic', source, { family: 'assistant', assistant: 'advisor' });
    const res = await handleTemplates(event({ httpMethod: 'GET', path: '/admin/templates', queryStringParameters: { profileName: 'advisor' } }), { store: store.deps, identities, scope: jest.fn(async () => null) });
    const listed = JSON.parse(res.body);
    expect(listed.classification).toBe('basic');
    expect(listed.templates).toHaveLength(shippedMessageTemplates().size);
    expect(listed.templates.find((t: any) => t.name === 'member-joined').classification.source).toContain('{{name}} is here.');
    expect(listed.templates.find((t: any) => t.name === 'member-welcome').own.source).toBe(source);
  });
});

describe('a version names which of its own templates a message is said from (`messages`)', () => {
  const named = reworded('member-welcome', 'chat', 'Hi {{name}}, from the advisor.').replace('"name":"member-welcome"', '"name":"advisor-welcome"');
  const values = { name: 'Riley', recap: 'Q3' };

  it('the named template is said, ahead of the one of the message\'s own name', async () => {
    const store = fakeStore();
    await save(store, 'basic', reworded('member-welcome', 'chat', 'Welcome aboard, {{name}}.'), { family: 'assistant', assistant: 'advisor' });
    await save(store, 'basic', named, { family: 'assistant', assistant: 'advisor' });
    const s = await selectMessageTemplate({ classification: 'basic', assistant: 'advisor', name: 'member-welcome', messages: { 'member-welcome': 'advisor-welcome' } }, store.deps);
    expect((renderMessageTemplate(s.template, values) as any).sections.chat).toBe('Hi Riley, from the advisor.');
  });

  it('the console saves a template under a name of its own when it says which message it words', async () => {
    const store = fakeStore();
    const res = await handleTemplates({
      httpMethod: 'POST', path: '/admin/templates/save', headers: {}, pathParameters: null, queryStringParameters: null,
      body: JSON.stringify({ profileName: 'advisor', source: named, message: 'member-welcome' }),
    } as never, { store: store.deps, identities: async () => [{ assistant: 'advisor', classification: 'basic' }] as any, scope: jest.fn(async () => null) });
    expect(res.statusCode).toBe(200);
    expect([...store.params.keys()]).toEqual(['/ae/assistant/basic/templates/_assistants/advisor/advisor-welcome']);
    expect(saveRefusal(named)).toMatch(/names it in `message`/);
    expect(saveRefusal(named, 'not-shipped')).toMatch(/message names/);
  });

  it('REFUSES a source named for one shipped template while message names another: it is checked by the name it is stored under', () => {
    // It would be checked against member-welcome's call site and voice, then stored and said as workflow-opening.
    const misnamed = reworded('member-welcome', 'chat', 'Hi {{name}}.').replace('"name":"member-welcome"', '"name":"workflow-opening"');
    expect(saveRefusal(misnamed, 'member-welcome')).toMatch(/"workflow-opening" is a template the platform ships, so it is stored and said as workflow-opening/);
    // Naming the template it is, or a name of its own, still saves.
    expect(saveRefusal(reworded('member-welcome', 'chat', 'Hi {{name}}.'), 'member-welcome')).toBeUndefined();
    expect(saveRefusal(named, 'member-welcome')).toBeUndefined();
  });

  it('rolls back a template of the assistant\'s own name, which save accepts, as it rolls back a shipped one', async () => {
    const store = fakeStore();
    const deps = { store: store.deps, identities: async () => [{ assistant: 'advisor', classification: 'basic' }] as any, scope: jest.fn(async () => null) };
    const call = (path: string, body: Record<string, unknown>) => handleTemplates({
      httpMethod: 'POST', path, headers: {}, pathParameters: null, queryStringParameters: null, body: JSON.stringify({ profileName: 'advisor', ...body }),
    } as never, deps);
    const second = named.replace('Hi {{name}}, from the advisor.', 'Hello {{name}}, from the advisor.');
    expect((await call('/admin/templates/save', { source: named, message: 'member-welcome' })).statusCode).toBe(200);
    expect((await call('/admin/templates/save', { source: second, message: 'member-welcome' })).statusCode).toBe(200);
    const rolled = await call('/admin/templates/rollback', { name: 'advisor-welcome' });
    expect(rolled.statusCode).toBe(200);
    expect(JSON.parse(rolled.body)).toMatchObject({ name: 'advisor-welcome', from: contentIdOf(second), to: contentIdOf(named) });
    // A name this family holds nothing of is the store's refusal; a name that is not a template name is refused first.
    expect((await call('/admin/templates/rollback', { name: 'never-saved' })).statusCode).toBe(409);
    expect((await call('/admin/templates/rollback', { name: '../classification' })).statusCode).toBe(400);
  });

  it('the draft refuses a map whose key is not a shipped message or whose value is not a template name', () => {
    expect(messagesShapeErrors({ 'member-welcome': 'advisor-welcome' })).toEqual([]);
    expect(messagesShapeErrors({ 'my-line': 'x' })[0]).toMatch(/not a message template/);
    expect(messagesShapeErrors({ 'member-welcome': 'Bad Name' })[0]).toMatch(/must name a template/);
    expect(messagesShapeErrors(['x'])[0]).toMatch(/must map/);
  });

  it('validate and activate refuse a named template that is not active in the family, or does not fit', async () => {
    const store = fakeStore();
    // The declared assistant of the shipped premium classification.
    const profile = 'advisor';
    expect(classificationServedBy(profile)).toBe('premium');
    expect(await messageTemplateErrors({ messages: { 'member-welcome': 'advisor-welcome' } } as never, profile, store.deps))
      .toEqual([expect.stringMatching(/not an active template of this assistant/)]);
    const misfit = named.replace('"title":"conversation:title"', '"title":"conversation:title","secret":"value:text"');
    await save(store, 'premium', misfit, { family: 'assistant', assistant: profile });
    expect(await messageTemplateErrors({ messages: { 'member-welcome': 'advisor-welcome' } } as never, profile, store.deps))
      .toEqual([expect.stringMatching(/does not fit it/)]);
    _resetTemplateCache();
    const fitting = fakeStore();
    await save(fitting, 'premium', named, { family: 'assistant', assistant: profile });
    expect(await messageTemplateErrors({ messages: { 'member-welcome': 'advisor-welcome' } } as never, profile, fitting.deps)).toEqual([]);
  });
});

describe('a field bound to a variable is saved, and the version that says it is the gate', () => {
  const custom = (fields: Record<string, string>) => [
    '---',
    JSON.stringify({ kind: 'message', name: 'my-variable-line', description: 'd', language: 'en', fields }),
    '---',
    '# chat',
    'This is a {{kind}} conversation.',
  ].join('\n');

  it('saves a field bound to a version variable, which no call site supplies before the version names it', () => {
    expect(saveRefusal(custom({ kind: 'kind' }), 'workflow-subject-welcome')).toBeUndefined();
  });

  it('saves a field bound to a published source', () => {
    expect(saveRefusal(custom({ kind: 'conversation:type' }), 'workflow-subject-welcome')).toBeUndefined();
  });

  it('refuses a field bound to neither', () => {
    expect(saveRefusal(custom({ kind: 'value:text' }), 'workflow-subject-welcome')).toMatch(/does not supply/);
  });
});
