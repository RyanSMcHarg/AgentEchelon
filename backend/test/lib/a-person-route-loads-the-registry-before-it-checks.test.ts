/**
 * A PERSON ROUTE LOADS THE DEPLOYMENT'S REGISTRY BEFORE IT CHECKS A CONVERSATION.
 *
 * Every deployed function is handed the registry's path, so the registry is unreadable until the handler has
 * loaded it (`loadProfileRegistry`): a read before that throws. The conversation check
 * (`lib/conversation-access.ts`) reads clearance from the registry, so a handler that runs the check without
 * loading it fails every request. Each handler that runs the check is driven here in a fresh module registry,
 * with the path set and the rows on hand but nothing loaded: a member whose clearance does not reach the
 * conversation must be answered `NOT_CLEARED`, which only a loaded registry can decide.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  DEFAULT_PROFILES_CONFIG, PROFILE_REGISTRY_PATH_ENV, registryRowsOf, registryRowValue,
} from '../../lib/config/profiles';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const PERSON = 'person-1';
const PERSON_ARN = `${APP}/user/${PERSON}`;
const ROWS = registryRowsOf(DEFAULT_PROFILES_CONFIG).map(registryRowValue);

type Cmd = { constructor: { name: string }; input: Record<string, any> };
const messaging = {
  send: async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'DescribeChannelMembershipCommand': return {};
      case 'ListTagsForResourceCommand': return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      default: return {};
    }
  },
};

jest.mock('../../lambda/src/lib/auth', () => ({
  ...jest.requireActual('../../lambda/src/lib/auth'),
  callerPersonId: async () => PERSON,
  callerPersonArn: async () => PERSON_ARN,
  callerPerson: async () => ({ personId: PERSON, personArn: PERSON_ARN, source: 'edge', issuer: null, contact: { email: 'a@example.com', name: 'A' } }),
  requireAuth: async () => ({ claims: { personId: PERSON, actor: PERSON, email: null } }),
  // A member whose clearance does not reach the premium conversation.
  callerHolderToken: () => 'basic',
}));
jest.mock('../../lambda/src/lib/chime/clients', () => ({
  ...jest.requireActual('../../lambda/src/lib/chime/clients'),
  chimeMessagingClient: () => messaging,
}));
jest.mock('../../lambda/src/lib/conversation-primary', () => ({
  ...jest.requireActual('../../lambda/src/lib/conversation-primary'),
}));
// The service admin conversation management acts as, read from its parameter.
jest.mock('@aws-sdk/client-ssm', () => ({
  ...jest.requireActual('@aws-sdk/client-ssm'),
  SSMClient: jest.fn(() => ({ send: async () => ({ Parameter: { Value: `${APP}/user/service-admin` } }) })),
}));
// The presigner's own packages, which sign nothing here: every request is refused before a signature.
jest.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: async () => ({ url: '', fields: {} }) }), { virtual: true });
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async () => 'https://signed.example/' }));
jest.mock('../../lambda/src/lib/proposals', () => ({
  ...jest.requireActual('../../lambda/src/lib/proposals'),
  readProposal: async () => ({
    pk: 'proposal#h1', op: 'send_nudge', channelArn: `${APP}/channel/c-proposal`, classification: 'premium',
    personArn: PERSON_ARN, addressedAs: 'person',
  }),
  proposalRefusal: () => undefined,
}));

Object.assign(process.env, {
  APP_INSTANCE_ARN: APP,
  CHANNEL_BATTLE_CONFIG_TABLE: 'battle-config',
  FEEDBACK_TABLE: 'feedback',
  TOKENS_TABLE: 'tokens',
  BUCKET_NAME: 'attachments',
  ADMIN_ARN_PARAM: '/test/admin-arn',
});

const ev = (method: string, path: string, body?: Record<string, unknown>, query?: Record<string, string>) => ({
  httpMethod: method, path, resource: path, headers: { origin: 'http://localhost:5173' },
  body: body ? JSON.stringify(body) : null, queryStringParameters: query ?? null, requestContext: {},
}) as unknown as APIGatewayProxyEvent;

/** Each handler that runs the check, and a request of it naming its own conversation. */
const ROUTES: Array<[string, string, (h: (e: APIGatewayProxyEvent) => Promise<any>) => Promise<any>]> = [
  ['the presigner', '../../lambda/presigned-url/index.js',
    (h) => h(ev('POST', '/presigned-url', { action: 'download', conversationId: 'c-presign', fileKey: 'generated-docs/c-presign/report.docx' }))],
  ['GET /channels/battle', '../../lambda/src/channel-battle',
    (h) => h(ev('GET', '/channels/battle', undefined, { channelArn: `${APP}/channel/c-battle` }))],
  ['POST /channels/battle/outcome', '../../lambda/src/battle-outcome-api',
    (h) => h(ev('POST', '/channels/battle/outcome', { battleId: 'b1', winner: 'A', channelArn: `${APP}/channel/c-outcome` }))],
  ['POST /feedback', '../../lambda/src/user-feedback',
    (h) => h(ev('POST', '/feedback', { messageId: 'm1', channelArn: `${APP}/channel/c-feedback`, feedback: 'up' }))],
  ['POST /tasks/advance', '../../lambda/src/user-tasks-api',
    (h) => h(ev('POST', '/tasks/advance', { channelArn: `${APP}/channel/c-tasks`, taskId: 't1', state: 's', choice: 'c' }))],
  ['GET /turn-state', '../../lambda/src/turn-state-api',
    (h) => h(ev('GET', '/turn-state', undefined, { channelArn: `${APP}/channel/c-turn`, responderId: 'r' }))],
  ['GET /invitations', '../../lambda/src/invitations',
    (h) => h(ev('GET', '/invitations', undefined, { channelArn: `${APP}/channel/c-invitations` }))],
  ['POST /conversations/archive', '../../lambda/src/conversation-management',
    (h) => h(ev('POST', '/conversations/archive', { channelArn: `${APP}/channel/c-archive` }))],
  ['POST /proposals/apply', '../../lambda/src/proposals-api',
    (h) => h(ev('POST', '/proposals/apply', { proposal: 'h1', decision: 'decline' }))],
  ['POST /share-conversation', '../../lambda/share-conversation/index.js',
    (h) => h(ev('POST', '/share-conversation', { conversationArn: `${APP}/channel/c-share`, recipientEmail: 'bob@example.com' }))],
];

beforeEach(() => {
  for (const level of ['log', 'warn', 'error', 'info'] as const) jest.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env[PROFILE_REGISTRY_PATH_ENV];
});

describe.each(ROUTES)('%s', (_name, modulePath, call) => {
  it('loads the registry before it checks, so an uncleared member is answered NOT_CLEARED', async () => {
    let handler!: (e: APIGatewayProxyEvent) => Promise<any>;
    jest.isolateModules(() => {
      // The deployed shape: a registry path, its rows on hand, and nothing loaded yet.
      process.env[PROFILE_REGISTRY_PATH_ENV] = '/test/registry/classification';
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../lib/profile-registry').__setRegistryRowReaderForTest(async () => ROWS);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      handler = require(modulePath).handler;
    });
    const res = await call(handler);
    expect([res.statusCode, JSON.parse(res.body)]).toEqual([403, expect.objectContaining({ code: 'NOT_CLEARED' })]);
  });
});
