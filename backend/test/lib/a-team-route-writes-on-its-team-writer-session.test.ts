/**
 * A TEAM ROUTE WRITES ON A SESSION TAGGED WITH THE ASSISTANT ITS PATH NAMES (DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT 5.1,
 * tenet D3).
 *
 * `team-scoped-writer.ts` sends each write a wrapped store client makes on a team route out on the function's team
 * writer session, assumed with the session tag `assistant=<the path's assistant>`, and each read on the function's own
 * role. Through the message templates handler: a team route's body and pointer writes go out on that session, an
 * administrator's route assumes nothing, and when the handler's own check is wrong (the scope names another assistant
 * than the path) the write still goes out tagged with the PATH's assistant, which the team writer role's grants refuse
 * for any other family (`a-team-writer-reaches-only-its-assistant.test.ts` evaluates that refusal on the synthesized
 * policy).
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockAssumes: Array<{ RoleArn?: string; RoleSessionName?: string; Tags?: Array<{ Key: string; Value: string }> }> = [];
const mockSends: Array<{ client: 's3' | 'ssm'; onSession: boolean; name: string; key: string }> = [];
const mockObjects = new Map<string, string>();
const mockParams = new Map<string, string>();

jest.mock('@aws-sdk/client-sts', () => {
  const actual = jest.requireActual('@aws-sdk/client-sts');
  return {
    ...actual,
    STSClient: jest.fn(() => ({
      send: async (cmd: { input: (typeof mockAssumes)[number] }) => {
        mockAssumes.push(cmd.input);
        return { Credentials: { AccessKeyId: 'ASIA-TEAM', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 900_000) } };
      },
    })),
  };
});
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  class S3Client {
    constructor(private readonly config: { credentials?: { accessKeyId?: string } } = {}) {}
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }): Promise<unknown> {
      const { input } = cmd;
      mockSends.push({ client: 's3', onSession: this.config?.credentials?.accessKeyId === 'ASIA-TEAM', name: cmd.constructor.name, key: input.Key ?? input.Prefix });
      switch (cmd.constructor.name) {
        case 'PutObjectCommand':
          if (input.IfNoneMatch === '*' && mockObjects.has(input.Key)) throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
          mockObjects.set(input.Key, input.Body);
          return {};
        case 'GetObjectCommand':
          if (!mockObjects.has(input.Key)) throw Object.assign(new Error('no key'), { name: 'NoSuchKey' });
          return { Body: { transformToString: async () => mockObjects.get(input.Key) } };
        case 'ListObjectsV2Command':
          return { Contents: [...mockObjects.keys()].filter((k) => k.startsWith(input.Prefix)).map((Key) => ({ Key })) };
        default:
          throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    }
  }
  return { ...actual, S3Client };
});
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  class SSMClient {
    constructor(private readonly config: { credentials?: { accessKeyId?: string } } = {}) {}
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }): Promise<unknown> {
      const { input } = cmd;
      mockSends.push({ client: 'ssm', onSession: this.config?.credentials?.accessKeyId === 'ASIA-TEAM', name: cmd.constructor.name, key: input.Name });
      if (cmd.constructor.name === 'GetParameterCommand') {
        if (!mockParams.has(input.Name)) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
        return { Parameter: { Value: mockParams.get(input.Name) } };
      }
      if (cmd.constructor.name === 'PutParameterCommand') {
        mockParams.set(input.Name, input.Value);
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  }
  return { ...actual, SSMClient };
});
jest.mock('../../lambda/src/lib/auth', () => {
  const actual = jest.requireActual('../../lambda/src/lib/auth');
  return { ...actual, callerActor: jest.fn(async () => 'person-1'), callerCanManageProfiles: jest.fn(() => true) };
});

const ROLE_ARN = 'arn:aws:iam::123456789012:role/TemplatesTeamWriter';
process.env.TEAM_WRITER_ROLE_ARN = ROLE_ARN;

/* eslint-disable import/first */
import { PutParameterCommand, GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { PutCommand, UpdateCommand, DeleteCommand, GetCommand, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  isWriteCommand, writesAsTeam, asTeamWriter, onTeamRoute, withTeamWriterAlt, assumeTeamWriter, teamWriterBinding,
  TeamWriterRefused, _resetTeamWriterSessions,
} from '../../lambda/src/lib/team-scoped-writer';
import { handleTemplates } from '../../lambda/src/manage-message-templates';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';
import { _resetTemplateCache } from '../../lambda/src/lib/template-store';
/* eslint-enable import/first */

beforeEach(() => {
  mockAssumes.length = 0;
  mockSends.length = 0;
  mockObjects.clear();
  mockParams.clear();
  _resetTeamWriterSessions();
  _resetTemplateCache();
  process.env.TEAM_WRITER_ROLE_ARN = ROLE_ARN;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('which commands are writes', () => {
  it.each([
    ['PutParameter', new PutParameterCommand({ Name: 'n', Value: 'v' })],
    ['PutObject', new PutObjectCommand({ Bucket: 'b', Key: 'k' })],
    ['DeleteObject', new DeleteObjectCommand({ Bucket: 'b', Key: 'k' })],
    ['a document Put', new PutCommand({ TableName: 't', Item: {} })],
    ['a document Update', new UpdateCommand({ TableName: 't', Key: {} })],
    ['a document Delete', new DeleteCommand({ TableName: 't', Key: {} })],
  ])('%s is a write', (_l, cmd) => {
    expect(isWriteCommand(cmd)).toBe(true);
  });

  it.each([
    ['GetParameter', new GetParameterCommand({ Name: 'n' })],
    ['GetParametersByPath', new GetParametersByPathCommand({ Path: '/p' })],
    ['GetObject', new GetObjectCommand({ Bucket: 'b', Key: 'k' })],
    ['ListObjectsV2', new ListObjectsV2Command({ Bucket: 'b' })],
    ['a document Get', new GetCommand({ TableName: 't', Key: {} })],
    ['a document Scan', new ScanCommand({ TableName: 't' })],
    ['a document Query', new QueryCommand({ TableName: 't' })],
    ['something that is not an SDK command', { input: {} }],
  ])('%s is not', (_l, cmd) => {
    expect(isWriteCommand(cmd)).toBe(false);
  });
});

describe('a wrapped client', () => {
  const fake = (label: string) => ({ label, send: jest.fn(async (..._args: unknown[]): Promise<string> => label) });

  it('outside a team route sends everything on the function\'s own role', async () => {
    const ambient = fake('own');
    const client = writesAsTeam(ambient, 'x', () => fake('session'));
    await expect(client.send(new PutParameterCommand({ Name: 'n', Value: 'v' }) as never)).resolves.toBe('own');
    expect(teamWriterBinding()).toBeUndefined();
  });

  it('on a team route sends a write on the session and a read on the function\'s own role, and opens the session once, at the first write', async () => {
    const ambient = fake('own');
    const session = fake('session');
    const source = jest.fn(async () => ({ accessKeyId: 'a', secretAccessKey: 's' }));
    const make = jest.fn(() => session);
    const client = writesAsTeam(ambient, 'x', make);
    await asTeamWriter({ assistant: 'advisor' }, async () => {
      await expect(client.send(new GetParameterCommand({ Name: 'n' }) as never)).resolves.toBe('own');
      expect(source).not.toHaveBeenCalled();
      await expect(client.send(new PutParameterCommand({ Name: 'n', Value: 'v' }) as never)).resolves.toBe('session');
      await expect(client.send(new PutParameterCommand({ Name: 'm', Value: 'v' }) as never)).resolves.toBe('session');
      expect(teamWriterBinding()).toEqual({ assistant: 'advisor' });
    }, source);
    expect(source).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledWith({ assistant: 'advisor' });
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('a candidate\'s write is bound to the alt as well, for that work alone', async () => {
    const source = jest.fn(async () => ({ accessKeyId: 'a', secretAccessKey: 's' }));
    const client = writesAsTeam(fake('own'), 'x', () => fake('session'));
    await asTeamWriter({ assistant: 'ops-premium' }, async () => {
      await withTeamWriterAlt('alt-ops-premium', () => client.send(new PutParameterCommand({ Name: 'n', Value: 'v' }) as never));
      expect(teamWriterBinding()).toEqual({ assistant: 'ops-premium' });
    }, source);
    expect(source).toHaveBeenCalledWith({ assistant: 'ops-premium', alt: 'alt-ops-premium' });
  });

  it('DENIED: a write the session cannot be opened for is not made on the function\'s own role', async () => {
    const ambient = fake('own');
    const client = writesAsTeam(ambient, 'x', () => fake('session'));
    await expect(asTeamWriter({ assistant: 'advisor' }, () => client.send(new PutParameterCommand({ Name: 'n', Value: 'v' }) as never),
      async () => { throw new TeamWriterRefused('no role'); })).rejects.toBeInstanceOf(TeamWriterRefused);
    expect(ambient.send).not.toHaveBeenCalled();
  });
});

describe('the session it opens', () => {
  it('assumes this function\'s team writer role, tagged with the assistant, and with the alt when one is bound', async () => {
    await assumeTeamWriter({ assistant: 'advisor' });
    await assumeTeamWriter({ assistant: 'ops-premium', alt: 'alt-ops-premium' });
    expect(mockAssumes).toEqual([
      expect.objectContaining({ RoleArn: ROLE_ARN, RoleSessionName: 'team-advisor', Tags: [{ Key: 'assistant', Value: 'advisor' }] }),
      expect.objectContaining({ Tags: [{ Key: 'assistant', Value: 'ops-premium' }, { Key: 'alt', Value: 'alt-ops-premium' }] }),
    ]);
  });

  it('reuses a session until it nears expiry', async () => {
    await assumeTeamWriter({ assistant: 'advisor' });
    await assumeTeamWriter({ assistant: 'advisor' });
    expect(mockAssumes).toHaveLength(1);
  });

  const noRole = (): void => { delete process.env.TEAM_WRITER_ROLE_ARN; };
  const nothing = (): void => undefined;
  it.each<[string, { assistant: string; alt?: string }, () => void]>([
    ['no team writer role is configured', { assistant: 'advisor' }, noRole],
    ['the assistant is not an assistant id', { assistant: '../premium' }, nothing],
    ['the assistant holds a wildcard', { assistant: '*' }, nothing],
    ['the alt is not an alt', { assistant: 'advisor', alt: 'advisor/x' }, nothing],
  ])('DENIED: refuses when %s, and asks STS nothing', async (_l, binding, arrange) => {
    arrange();
    await expect(assumeTeamWriter(binding)).rejects.toBeInstanceOf(TeamWriterRefused);
    expect(mockAssumes).toHaveLength(0);
  });
});

describe('the message templates handler', () => {
  const identities = async () => [
    { assistant: 'advisor', classification: 'basic' },
    { assistant: 'concierge', classification: 'basic' },
  ] as any[];
  const teamScope = (assistant: string) => jest.fn(async () => ({ assistant, bots: [{ assistant, classification: 'basic' }] as any[] }));
  const { source: shipped, template } = shippedMessageTemplates().get('member-welcome')!;
  const source = shipped.replace(`# chat\n${template.messageSections!.chat}\n`, '# chat\nWelcome aboard, {{name}}.\n');
  const store = { bucket: 'b', ssmRoot: '/ae' };
  const save = (assistant: string | null, scope: ReturnType<typeof teamScope> | jest.Mock) => {
    const event = {
      httpMethod: 'POST', headers: {}, queryStringParameters: null, body: JSON.stringify({ source }),
      path: assistant ? `/admin/assistants/${assistant}/templates/save` : '/admin/templates/save',
      pathParameters: assistant ? { assistant } : null,
      ...(assistant ? {} : { body: JSON.stringify({ source, profileName: 'advisor' }) }),
    } as unknown as APIGatewayProxyEvent;
    return onTeamRoute(assistant, () => handleTemplates(event, { store, identities, scope }));
  };
  const writes = () => mockSends.filter((s) => s.name.startsWith('Put'));

  it('a team route writes its body and its pointer on the session tagged with the path\'s assistant, and reads on its own role', async () => {
    const res = await save('advisor', teamScope('advisor'));
    expect(res.statusCode).toBe(200);
    expect(mockAssumes).toEqual([expect.objectContaining({ RoleArn: ROLE_ARN, Tags: [{ Key: 'assistant', Value: 'advisor' }] })]);
    expect(writes().map((w) => [w.client, w.onSession])).toEqual([['s3', true], ['ssm', true]]);
    expect(writes().every((w) => w.key.includes('_assistants/advisor/'))).toBe(true);
    const reads = mockSends.filter((s) => !s.name.startsWith('Put'));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => !r.onSession)).toBe(true);
  });

  it('an administrator\'s route assumes nothing and writes on the function\'s own role', async () => {
    const res = await save(null, jest.fn(async () => null));
    expect(res.statusCode).toBe(200);
    expect(mockAssumes).toHaveLength(0);
    expect(writes().length).toBe(2);
    expect(writes().every((w) => !w.onSession)).toBe(true);
  });

  it('WITH THE HANDLER\'S CHECK WRONG, the write still goes out tagged with the path\'s assistant, which IAM holds to its own family', async () => {
    // The scope names another assistant than the path: the handler aims its write at concierge's family.
    const res = await save('advisor', teamScope('concierge'));
    expect(res.statusCode).toBe(200);
    expect(writes().every((w) => w.key.includes('_assistants/concierge/') && w.onSession)).toBe(true);
    // The session those writes went out on is advisor's: the team writer role allows it `_assistants/advisor/` alone.
    expect(mockAssumes.map((a) => a.Tags)).toEqual([[{ Key: 'assistant', Value: 'advisor' }]]);
  });

  it('DENIED: a team route whose writer cannot be opened writes nothing and says so', async () => {
    delete process.env.TEAM_WRITER_ROLE_ARN;
    const res = await save('advisor', teamScope('advisor'));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('TEAM_WRITER_UNAVAILABLE');
    expect(mockObjects.size + mockParams.size).toBe(0);
  });
});
