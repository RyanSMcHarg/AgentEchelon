/**
 * THE ASSISTANT PAGE'S FIELDS THROUGH THE HANDLER (SPEC-ADMIN-CONSOLE "Assistants").
 *
 * What it proves: a draft patch carrying a malformed `welcome` or `copy` is refused 422 through the route,
 * naming the field, before anything is written, and a well-formed one is written; the listing serves what
 * each listed classification offers (its models, bounded to what it selects; its guardrail and context
 * catalogs; its templates), the field decision table and the named messages, so the console offers only
 * what the write path accepts.
 */
const send = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send })) };
});
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  return {
    ...actual,
    LambdaClient: jest.fn(() => ({
      send: async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'GetFunctionConfigurationCommand') {
          return { Environment: { Variables: { BEDROCK_USER_HOURLY_BUDGET: '750', BEDROCK_GLOBAL_HOURLY_BUDGET: '1500' } } };
        }
        throw Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' });
      },
    })),
  };
});
const mockScope = jest.fn();
jest.mock('../lambda/src/lib/assistant-scope', () => {
  const actual = jest.requireActual('../lambda/src/lib/assistant-scope');
  return { ...actual, requireOwnedAssistant: (...a: unknown[]) => mockScope(...a) };
});

// The attachments bucket the company-context prefixes are keys in, served with the catalog.
process.env.PROFILE_BODY_BUCKET = 'ae-attachments';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../lambda/src/manage-profiles';
import { edgeContext } from './helpers/edge-context';
import { defaultProfileRegistry } from '../lib/profile-registry';
import { PLATFORM_TASK_MACHINE_KEYS } from '../lambda/src/lib/task-state-machines';
import { PROFILE_FIELD_DECISIONS } from '../lambda/src/lib/profile-field-decisions';

const ROOT = '/agent-echelon';

function evt(method: string, path: string, body?: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    path,
    headers: { origin: 'http://localhost:5173' },
    requestContext: { authorizer: edgeContext({ claims: { sub: 'u-1', 'cognito:groups': 'admins' } }) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  } as unknown as APIGatewayProxyEvent;
}

const notFound = () => Object.assign(new Error('nf'), { name: 'ParameterNotFound' });

/** SSM answering from a map of parameter values; everything else is absent. */
function ssmFrom(values: Record<string, string>) {
  send.mockImplementation(async (cmd: { constructor: { name: string }; input: { Name?: string; Path?: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'GetParameterCommand') {
      const v = values[cmd.input.Name ?? ''];
      if (v === undefined) throw notFound();
      return { Parameter: { Name: cmd.input.Name, Value: v } };
    }
    if (name === 'GetParametersByPathCommand') {
      const prefix = `${cmd.input.Path}/`;
      return { Parameters: Object.entries(values).filter(([k]) => k.startsWith(prefix)).map(([Name, Value]) => ({ Name, Value })) };
    }
    if (name === 'PutParameterCommand') return {};
    throw notFound();
  });
}

const advisor = defaultProfileRegistry.profileByName('advisor') ? 'advisor' : defaultProfileRegistry.profileNames()[0];
const classification = defaultProfileRegistry.classificationFor(advisor) as string;
const writes = () => send.mock.calls.map(([c]) => c).filter((c) => c.constructor.name === 'PutParameterCommand');

beforeEach(() => { send.mockReset(); mockScope.mockReset(); mockScope.mockResolvedValue(null); });

/** A welcome whose one opening step carries `opening` (W1). */
const welcomeWith = (opening: Record<string, unknown>) => ({
  eventWorkflows: { welcome: { on: 'assistant-joined', initial: 'o', states: { o: { opening, onSuccess: 'd' }, d: { disposition: 'success' } } } },
});

describe('a draft patch carrying a welcome workflow, a retired welcome, or a retired copy line', () => {
  it.each([
    ['a retired welcome, naming the migration', { welcome: { template: 'hello' } }, /welcome is retired.*npm run migrate-legacy-welcome/],
    ['an opening naming a per-conversation field', welcomeWith({ topic: 'x' }), /carried per conversation/],
    ['five suggested prompts', welcomeWith({ examples: ['a', 'b', 'c', 'd', 'e'] }), /at most 4/],
    ['a copy line, naming the migration', { copy: { rateLimited: 'Give me a minute.' } }, /copy is retired.*npm run migrate-legacy-copy/],
    ['a copy group, naming the migration', { copy: { queueStatus: { waiting: 'Held' } } }, /copy is retired.*npm run migrate-legacy-copy/],
  ])('refuses %s with 422 and writes nothing', async (_what, patch, message) => {
    ssmFrom({});
    const res = await handler(evt('POST', '/admin/profiles/draft', { profileName: advisor, patch }));
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).errors.join('\n')).toMatch(message);
    expect(writes()).toHaveLength(0);
  });

  it('writes a well-formed welcome workflow into the draft, and copy: null and welcome: null clear what a cloned version carried', async () => {
    ssmFrom({});
    const patch = { ...welcomeWith({ text: 'I am the advisor.', examples: ['How did Q3 close?'] }), copy: null, welcome: null };
    const res = await handler(evt('POST', '/admin/profiles/draft', { profileName: advisor, patch }));
    expect(res.statusCode).toBe(200);
    const draft = writes().find((c) => c.input.Name === `${ROOT}/assistant/${advisor}/draft`);
    const stored = JSON.parse(draft.input.Value);
    expect(stored.eventWorkflows).toEqual(patch.eventWorkflows);
    expect(stored.welcome).toBeUndefined();
    expect(stored.copy).toBeUndefined();
  });
});

describe('the listing serves what the page needs', () => {
  it('serves each listed classification\'s catalog, bounded to what it selects, with the decisions and messages', async () => {
    ssmFrom({
      [`${ROOT}/assistant/${classification}/guardrails`]: JSON.stringify([{ key: 'strict', guardrailId: 'gr-1' }]),
      [`${ROOT}/assistant/${classification}/context-sources`]: JSON.stringify([{ key: 'crm', description: 'Accounts' }]),
      [`${ROOT}/assistant/${classification}/templates/report`]: JSON.stringify({ active: 'a'.repeat(64), history: [] }),
      [`${ROOT}/assistant/${classification}/router-arn`]: 'arn:aws:lambda:us-east-1:1:function:AgentEchelonRouter',
    });
    const res = await handler(evt('GET', '/admin/profiles'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const cat = body.classifications[classification];
    const selected = defaultProfileRegistry.modelsOf(classification)?.selected ?? [];
    expect(cat.models.text.length).toBeGreaterThan(0);
    expect(cat.models.text.every((m: string) => selected.includes(m))).toBe(true);
    expect(cat.models.image.every((m: string) => selected.includes(m))).toBe(true);
    expect(cat.guardrails).toEqual([{ key: 'strict', guardrailId: 'gr-1' }]);
    expect(cat.contextSources).toEqual([{ key: 'crm', description: 'Accounts' }]);
    expect(cat.templates).toEqual([{ name: 'report', active: 'a'.repeat(64) }]);
    expect(cat.budgets).toEqual({ userHourly: 750, globalHourly: 1500 });
    expect(cat.workflows.length).toBeGreaterThan(0);
    // The bucket the reach prefixes are keys in, so the console can say where they are.
    expect(cat.contextBucket).toBe('ae-attachments');
    // The turn queue's machines are marked as every assistant's, read from the list the runtime exempts from a
    // selection, and only those: a reference workflow such as report_generation stays selectable.
    const required = cat.workflows.filter((w: { required: boolean }) => w.required).map((w: { key: string }) => w.key).sort();
    expect(required).toEqual([...PLATFORM_TASK_MACHINE_KEYS].sort());
    expect(cat.workflows.find((w: { key: string }) => w.key === 'report_generation')).toMatchObject({ required: false });
    expect(body.fieldDecisions).toEqual(JSON.parse(JSON.stringify(PROFILE_FIELD_DECISIONS)));
    // `copy` is retired: the listing serves no catalog of its lines.
    expect(body.copyCatalog).toBeUndefined();
    const row = body.profiles.find((p: { profileName: string }) => p.profileName === advisor);
    expect(row.deployedClassifierMode).toBe(defaultProfileRegistry.profileByName(advisor)?.classifierMode);
  });

  it('lists the classification without the parts it could not read, rather than failing', async () => {
    ssmFrom({});
    const res = await handler(evt('GET', '/admin/profiles'));
    expect(res.statusCode).toBe(200);
    const cat = JSON.parse(res.body).classifications[classification];
    expect(cat.guardrails).toBeUndefined();
    expect(cat.contextSources).toBeUndefined();
    expect(cat.templates).toEqual([]);
  });
});
