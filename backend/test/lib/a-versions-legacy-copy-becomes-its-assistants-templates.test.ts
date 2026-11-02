/**
 * A VERSION'S RETIRED `copy` LINES BECOME ITS ASSISTANT'S OWN TEMPLATES (ADR-062, `npm run migrate-legacy-copy`).
 *
 * Selection reads no `copy`, so the lines a version stored before message templates are moved once, by the migration:
 * each line that maps to a message (`memberWelcome` to `member-welcome`, `joinRecapRequest` to `join-recap`, an email
 * key to its section, a keyed line of decision 6 to its template) is written to the assistant's own family, `{var}`
 * converted to `{{field}}`, checked against the shipped template it words. A line that does not fit is refused and
 * reported, and a template the assistant already holds is kept, so a second run writes nothing.
 */
import { legacyCopyPlan, migrateLegacyCopy } from '../../lambda/src/lib/legacy-copy-migration';
import { selectMessageTemplate } from '../../lambda/src/lib/message-template-selection';
import { renderMessageTemplate, renderPromptTemplate } from '../../lambda/src/lib/message-template';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';
import { activateTemplate, loadTemplate, putTemplate, _resetTemplateCache } from '../../lambda/src/lib/template-store';
import { readFileSync } from 'fs';
import { join } from 'path';

/** An in-memory bucket and parameter store, answering the commands the template store sends. */
function fakeStore() {
  const objects = new Map<string, string>();
  const params = new Map<string, string>();
  const puts: string[] = [];
  const s3 = {
    send: jest.fn(async (cmd: any) => {
      const input = cmd.input;
      switch (cmd.constructor.name) {
        case 'PutObjectCommand':
          if (input.IfNoneMatch === '*' && objects.has(input.Key)) throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
          objects.set(input.Key, input.Body);
          puts.push(input.Key);
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
  return { objects, params, puts, deps: { s3: s3 as any, ssm: ssm as any, bucket: 'b', ssmRoot: '/ae', now: () => 1_000 } };
}

const at = { assistant: 'advisor', classification: 'basic' };
const own = { family: 'assistant' as const, assistant: 'advisor' };

beforeEach(() => _resetTemplateCache());

describe('the migration maps each line to the template it words and converts it', () => {
  const copy = {
    memberWelcome: 'Hola {name}, bienvenida a {recap}.',
    joinRecapRequest: 'Resume la conversación para quien acaba de llegar.',
    queuedOne: 'Sigo con tu mensaje anterior.',
    email: { greeting: 'Olá {name},', invitationSubject: '{sender} te convidou', language: 'pt-BR' },
  };

  it('plans one template per message, from the keys that word it', () => {
    const plan = legacyCopyPlan(copy);
    expect(plan.refused).toEqual([]);
    const byName = Object.fromEntries(plan.templates.map((t) => [t.name, t.keys]));
    expect(byName).toEqual({
      'member-welcome': ['memberWelcome'],
      'join-recap': ['joinRecapRequest'],
      'queued-one': ['queuedOne'],
      'notification-email': ['email.greeting', 'email.language'],
      invitation: ['email.invitationSubject'],
    });
  });

  it('writes each as the assistant\'s own, active, and selection says it from there with `{var}` as `{{field}}`', async () => {
    const store = fakeStore();
    const report = await migrateLegacyCopy({ ...at, copy }, store.deps);
    expect(report.refused).toEqual([]);
    expect(report.templates.map((t) => [t.name, t.outcome])).toEqual(expect.arrayContaining([
      ['member-welcome', 'wrote'], ['join-recap', 'wrote'], ['queued-one', 'wrote'], ['notification-email', 'wrote'], ['invitation', 'wrote'],
    ]));
    const welcome = await selectMessageTemplate({ classification: 'basic', assistant: 'advisor', name: 'member-welcome' }, store.deps);
    expect(welcome.origin).toBe('assistant');
    expect(welcome.template.messageSections!.chat).toBe('Hola [[{{name}}]], bienvenida a [[{{recap}}]].');
    expect((renderMessageTemplate(welcome.template, { name: 'Riley', recap: 'the Q3 review' }) as any).sections.chat).toBe('Hola Riley, bienvenida a the Q3 review.');
    // A value the call site does not have is substituted with nothing, as the line always printed.
    expect((renderMessageTemplate(welcome.template, { name: 'Riley' }) as any).sections.chat).toBe('Hola Riley, bienvenida a .');
    const recap = (await loadTemplate('basic', { name: 'join-recap' }, store.deps, { owner: own, kind: 'prompt' })).template;
    expect((renderPromptTemplate(recap) as any).prompt).toBe('Resume la conversación para quien acaba de llegar.');
    const wrapper = (await loadTemplate('basic', { name: 'notification-email' }, store.deps, { owner: own, kind: 'message' })).template;
    expect(wrapper.language).toBe('pt-BR');
    expect(wrapper.messageSections!['email.greeting']).toBe('Olá [[{{name}}]],');
    // A section with no line keeps the shipped text.
    expect(wrapper.messageSections!['email.signOff']).toBe(shippedMessageTemplates().get('notification-email')!.template.messageSections!['email.signOff']);
  });

  it('writes nothing for a version with no copy', async () => {
    const store = fakeStore();
    expect(await migrateLegacyCopy({ ...at, copy: undefined }, store.deps)).toEqual({ ...at, templates: [], refused: [] });
    expect(store.puts).toEqual([]);
  });

  it('a dry run says what it would write and writes nothing', async () => {
    const store = fakeStore();
    const report = await migrateLegacyCopy({ ...at, copy: { memberWelcome: 'Hi {name}.' } }, store.deps, { dryRun: true });
    expect(report.templates).toEqual([expect.objectContaining({ name: 'member-welcome', outcome: 'would-write' })]);
    expect(store.puts).toEqual([]);
    expect(store.params.size).toBe(0);
  });
});

describe('it is idempotent: an assistant that already has its own template keeps it', () => {
  it('a second run keeps what the first wrote and stores nothing new', async () => {
    const store = fakeStore();
    await migrateLegacyCopy({ ...at, copy: { memberWelcome: 'Hi {name}.' } }, store.deps);
    const after = store.puts.length;
    const again = await migrateLegacyCopy({ ...at, copy: { memberWelcome: 'Hi {name}.' } }, store.deps);
    expect(again.templates).toEqual([expect.objectContaining({ name: 'member-welcome', outcome: 'kept' })]);
    expect(store.puts.length).toBe(after);
  });

  it('a template the assistant saved itself is never overwritten by its legacy line', async () => {
    const store = fakeStore();
    const { source, template } = shippedMessageTemplates().get('member-welcome')!;
    const saved = source.replace(`# chat\n${template.messageSections!.chat}\n`, '# chat\nWelcome aboard, {{name}}.\n');
    const put = await putTemplate('basic', saved, store.deps, { owner: own });
    await activateTemplate('basic', put.name, put.contentHash, store.deps, { owner: own });
    const report = await migrateLegacyCopy({ ...at, copy: { memberWelcome: 'Hi {name}.' } }, store.deps);
    expect(report.templates).toEqual([expect.objectContaining({ name: 'member-welcome', outcome: 'kept' })]);
    expect((await selectMessageTemplate({ classification: 'basic', assistant: 'advisor', name: 'member-welcome' }, store.deps)).template.messageSections!.chat)
      .toBe('Welcome aboard, {{name}}.');
  });

  it('a template the version\'s `messages` names for the message counts as the assistant\'s own', async () => {
    const store = fakeStore();
    const { source, template } = shippedMessageTemplates().get('member-welcome')!;
    const mine = source.replace('"name":"member-welcome"', '"name":"my-welcome"').replace(`# chat\n${template.messageSections!.chat}\n`, '# chat\nWelcome, {{name}}.\n');
    const put = await putTemplate('basic', mine, store.deps, { owner: own });
    await activateTemplate('basic', put.name, put.contentHash, store.deps, { owner: own });
    const report = await migrateLegacyCopy({ ...at, copy: { memberWelcome: 'Hi {name}.' }, messages: { 'member-welcome': 'my-welcome' } }, store.deps);
    expect(report.templates).toEqual([expect.objectContaining({ name: 'member-welcome', outcome: 'kept' })]);
  });
});

describe('a line that does not fit is refused, and the rest are written', () => {
  it('refuses a line naming a field its message does not supply, keeps its fitting neighbour, and names an unmapped key', async () => {
    const store = fakeStore();
    const report = await migrateLegacyCopy({
      ...at,
      copy: { memberWelcome: 'Hi {{secret}}.', queuedOne: 'Still on it.', notAMessage: 'Something.', rateLimited: '' },
    }, store.deps);
    expect(report.refused).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'memberWelcome', template: 'member-welcome', reason: expect.stringMatching(/secret/) }),
      expect.objectContaining({ key: 'notAMessage', reason: 'no message template words this key' }),
      expect.objectContaining({ key: 'rateLimited', reason: 'not a line (blank or not text)' }),
    ]));
    expect(report.templates.map((t) => t.name)).toEqual(['queued-one']);
    expect((await selectMessageTemplate({ classification: 'basic', assistant: 'advisor', name: 'member-welcome' }, store.deps)).origin).toBe('shipped');
  });
});

describe('the script', () => {
  it('is `npm run migrate-legacy-copy`, builds first, and reads each active version\'s copy', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
    expect(pkg.scripts['migrate-legacy-copy']).toBe('tsc && node scripts/migrate-legacy-copy.mjs');
    const script = readFileSync(join(__dirname, '../../scripts/migrate-legacy-copy.mjs'), 'utf8');
    expect(script).toContain('definition:active');
    expect(script).toContain('migrateLegacyCopy(');
  });
});
