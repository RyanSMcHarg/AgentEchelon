/**
 * A TEMPLATE IS A CONTENT-ADDRESSED BODY BEHIND AN ACTIVE-VERSION POINTER (SPEC-DOCUMENT-TEMPLATES FR2, FR7).
 *
 * Bodies live at `templates/<classification>/<name>/<sha256>.md`, created once and never overwritten.
 * The pointer `<ssmRoot>/assistant/<classification>/templates/<name>` names the active version, and
 * activation and rollback rewrite only it, so the next delivery follows with no deploy. The reader's
 * own checks are the second layer under IAM (tenet P4): a body is read only from its own classification's
 * key, and only when its bytes hash to the id the key names.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  putTemplate,
  activateTemplate,
  rollbackTemplate,
  listTemplates,
  loadTemplate,
  loadTurnTemplates,
  templateKey,
  templatePrefix,
  templatePointerName,
  templateReferenceErrors,
  _resetTemplateCache,
  TEMPLATE_POINTER_TTL_MS,
} from '../../lambda/src/lib/template-store';
import { contentIdOf } from '../../lambda/src/lib/profile-bodies';
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';

const V1 = readFileSync(join(__dirname, '..', '..', 'demo', 'templates', 'quarterly-account-review.md'), 'utf8');
const V2 = V1.replace('## Next steps', '## Next steps\n\n## Owners');
const H1 = contentIdOf(V1);
const H2 = contentIdOf(V2);

/** An in-memory bucket and parameter store, answering the commands the store sends. */
function fakeStore() {
  const objects = new Map<string, string>();
  const params = new Map<string, string>();
  const writes: string[] = [];
  const s3 = {
    send: jest.fn(async (cmd: any) => {
      const input = cmd.input;
      switch (cmd.constructor.name) {
        case 'PutObjectCommand':
          if (input.IfNoneMatch === '*' && objects.has(input.Key)) {
            throw Object.assign(new Error('exists'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
          }
          objects.set(input.Key, input.Body);
          writes.push(`s3:${input.Key}`);
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
        writes.push(`ssm:${input.Name}`);
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    }),
  };
  let now = 1_000_000;
  const deps = { s3: s3 as any, ssm: ssm as any, bucket: 'b', ssmRoot: '/ae', now: () => now };
  return { objects, params, writes, deps, s3, ssm, tick: (ms: number) => { now += ms; } };
}

beforeEach(() => _resetTemplateCache());

describe('keys name their owner', () => {
  it('puts the classification second, so IAM can scope a read to it', () => {
    expect(templatePrefix('premium')).toBe('templates/premium/');
    expect(templateKey('premium', 'quarterly-account-review', H1)).toBe(`templates/premium/quarterly-account-review/${H1}.md`);
    expect(templatePointerName('/ae', 'premium', 'quarterly-account-review')).toBe('/ae/assistant/premium/templates/quarterly-account-review');
    expect(() => templatePrefix('pre/mium')).toThrow();
    expect(() => templateKey('premium', '../x', H1)).toThrow();
  });
});

describe('a body is content-addressed and never overwritten', () => {
  it('stores under its hash with a create-only write, and the same bytes again write nothing', async () => {
    const { deps, writes } = fakeStore();
    expect(await putTemplate('premium', V1, deps)).toMatchObject({ name: 'quarterly-account-review', contentHash: H1, written: true });
    expect(await putTemplate('premium', V1, deps)).toMatchObject({ written: false });
    expect(writes).toEqual([`s3:templates/premium/quarterly-account-review/${H1}.md`]);
  });

  it('refuses a template that does not parse before anything is written', async () => {
    const { deps, writes } = fakeStore();
    await expect(putTemplate('premium', '# no front matter', deps)).rejects.toThrow(/front-matter/);
    expect(writes).toEqual([]);
  });

  it('writes nothing on a dry run', async () => {
    const { deps, writes } = fakeStore();
    expect(await putTemplate('premium', V1, deps, { dryRun: true })).toMatchObject({ written: false, contentHash: H1 });
    expect(writes).toEqual([]);
  });
});

describe('activation and rollback re-point, and never rewrite a body (FR7)', () => {
  it('activates, activates a second version, and rolls back to the first, writing only the pointer', async () => {
    const { deps, writes, tick } = fakeStore();
    await putTemplate('premium', V1, deps);
    await putTemplate('premium', V2, deps);
    writes.length = 0;

    expect(await activateTemplate('premium', 'quarterly-account-review', H1, deps)).toMatchObject({ active: H1, changed: true });
    expect((await loadTemplate('premium', { name: 'quarterly-account-review' }, deps)).contentHash).toBe(H1);

    expect(await activateTemplate('premium', 'quarterly-account-review', H2, deps)).toMatchObject({ previous: H1, active: H2 });
    tick(TEMPLATE_POINTER_TTL_MS + 1);
    const next = await loadTemplate('premium', { name: 'quarterly-account-review' }, deps);
    expect(next.contentHash).toBe(H2);
    expect(next.template.sections.map((s) => s.heading)).toContain('Owners');

    expect(await rollbackTemplate('premium', 'quarterly-account-review', deps)).toEqual({ from: H2, to: H1 });
    tick(TEMPLATE_POINTER_TTL_MS + 1);
    expect((await loadTemplate('premium', { name: 'quarterly-account-review' }, deps)).contentHash).toBe(H1);

    expect(writes.every((w) => w.startsWith('ssm:/ae/assistant/premium/templates/'))).toBe(true);
    await expect(rollbackTemplate('premium', 'quarterly-account-review', deps)).rejects.toThrow(/no earlier version/);
  });

  it('refuses to activate a version that is not stored', async () => {
    const { deps } = fakeStore();
    await expect(activateTemplate('premium', 'quarterly-account-review', H1, deps)).rejects.toThrow(/does not exist/);
  });

  it('lists what a classification holds, with its active version', async () => {
    const { deps } = fakeStore();
    await putTemplate('premium', V1, deps);
    await putTemplate('premium', V2, deps);
    await activateTemplate('premium', 'quarterly-account-review', H2, deps);
    expect(await listTemplates('premium', deps)).toEqual([
      { name: 'quarterly-account-review', versions: [H1, H2], active: H2, history: [] },
    ]);
  });
});

describe('the reader is the second layer (tenet P4)', () => {
  it('refuses a body whose bytes do not hash to its key', async () => {
    const { deps, objects } = fakeStore();
    objects.set(templateKey('premium', 'quarterly-account-review', H1), V2);
    await expect(loadTemplate('premium', { name: 'quarterly-account-review', version: H1 }, deps)).rejects.toThrow(/hashes to/);
  });

  it('reads only its own classification\'s key: standard does not find premium\'s template', async () => {
    const { deps } = fakeStore();
    await putTemplate('premium', V1, deps);
    await activateTemplate('premium', 'quarterly-account-review', H1, deps);
    await expect(loadTemplate('standard', { name: 'quarterly-account-review' }, deps)).rejects.toThrow(/does not exist for standard/);
    await expect(loadTemplate('standard', { name: 'quarterly-account-review', version: H1 }, deps)).rejects.toThrow(/does not exist for standard/);
  });

  it('loads a pinned version whatever the pointer says', async () => {
    const { deps } = fakeStore();
    await putTemplate('premium', V1, deps);
    await putTemplate('premium', V2, deps);
    await activateTemplate('premium', 'quarterly-account-review', H2, deps);
    expect((await loadTemplate('premium', { name: 'quarterly-account-review', version: H1 }, deps)).contentHash).toBe(H1);
  });
});

describe('a missing reference is a named error at load (FR4)', () => {
  const machines: Record<string, TaskStateMachine> = {
    report_generation: {
      ...DEFAULT_TASK_STATE_MACHINES.report_generation,
      states: {
        ...DEFAULT_TASK_STATE_MACHINES.report_generation.states,
        generating: { ...DEFAULT_TASK_STATE_MACHINES.report_generation.states.generating, template: 'quarterly-account-review' },
        revising: { ...DEFAULT_TASK_STATE_MACHINES.report_generation.states.revising, template: 'quarterly-account-review' },
      },
    },
  };

  it('names the workflow and the template that does not resolve', async () => {
    const { deps } = fakeStore();
    expect(await templateReferenceErrors(machines, 'premium', deps)).toEqual([
      expect.stringMatching(/^report_generation: .*template "quarterly-account-review" does not exist for premium/),
    ]);
    await putTemplate('premium', V1, deps);
    await activateTemplate('premium', 'quarterly-account-review', H1, deps);
    expect(await templateReferenceErrors(machines, 'premium', deps)).toEqual([]);
  });

  it('keeps a reference the turn could not load as a named failure, not a silent absence', async () => {
    const { deps } = fakeStore();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const loaded = await loadTurnTemplates([{ name: 'quarterly-account-review' }], 'premium', deps);
    expect(loaded['quarterly-account-review']).toMatchObject({ name: 'quarterly-account-review', error: expect.stringMatching(/no version is active/) });
    errSpy.mockRestore();
  });
});
