/**
 * A STALLED AWS REQUEST ON AN ASSISTANT TURN FAILS IN SECONDS INSTEAD OF CONSUMING THE TURN.
 *
 * Measured live 2026-10-05: a premium router turn logged `[Router] Resolved`, then nothing, then
 * `Task timed out after 30.00 seconds`. No client on the router's path bounded a request, so one
 * stalled socket ate the whole turn and the person got no reply.
 *
 * Two halves, because either alone is inert:
 *  - the BEHAVIOR: a real SDK client carrying `BOUNDED_REQUEST_HANDLER`, pointed at a server that
 *    accepts the connection and never answers, rejects with a `TimeoutError`. Without
 *    `throwOnRequestTimeout` the handler only logs a warning and waits forever, which is exactly the
 *    shape a config that "sets a timeout" can have while doing nothing;
 *  - the WIRING: every client constructed on the router's path carries the bound. A new client
 *    added without it reopens the hang, and nothing else would notice.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { BOUNDED_REQUEST_HANDLER } from '../../lambda/src/lib/bounded-request-handler';

const SRC = path.resolve(__dirname, '../../lambda/src');

// The modules whose clients serve the router's pre-reply path (traced from
// router-agent-handler.ts's imports). Synchronous Lambda invokes and Bedrock are deliberately absent:
// they legitimately run longer than the bound and carry their own.
const ROUTER_PATH_MODULES = [
  'router-agent-handler.ts',
  'lib/intent-pack.ts', 'lib/profile-bodies.ts', 'lib/task-tracking.ts', 'lib/turn-triage.ts',
  'lib/turn-lock.ts', 'lib/battle-state.ts', 'lib/abuse-controls.ts', 'lib/assistant-advertisement.ts',
  'lib/default-agents.ts', 'lib/clearance-source.ts', 'lib/channel-context-client.ts',
  'lib/channel-notify.ts', 'lib/experiment-manager.ts', 'lib/queue-drain-task.ts',
  'lib/turn-queue-notice.ts', 'lib/live-drift-flow.ts', 'lib/inbound-message.ts',
  'lib/channel-creation.ts', 'lib/service-admin-bearer.ts', 'lib/user-profile-client.ts',
];
const BOUNDED_SERVICES = /new (DynamoDBClient|SSMClient|ChimeSDKMessagingClient|S3Client|CognitoIdentityProviderClient)\(([^)]*)\)/g;

describe('a stalled request fails instead of hanging the turn', () => {
  let server: Server;
  let endpoint: string;
  beforeAll(async () => {
    // Accepts the connection, reads the request, never responds: the hang measured live.
    server = createServer(() => { /* never answer */ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('rejects with a TimeoutError at the request bound', async () => {
    const client = new SSMClient({
      region: 'us-east-1',
      endpoint,
      credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
      maxAttempts: 1,
      requestHandler: BOUNDED_REQUEST_HANDLER,
    });
    const started = Date.now();
    const err = await client.send(new GetParameterCommand({ Name: '/stalled' })).catch((e: Error) => e);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('TimeoutError');
    expect(elapsed).toBeGreaterThanOrEqual(BOUNDED_REQUEST_HANDLER.requestTimeout - 100);
    expect(elapsed).toBeLessThan(BOUNDED_REQUEST_HANDLER.requestTimeout + 2_000);
    client.destroy();
  }, 15_000);

  it('every client on the router path carries the bound', () => {
    const unbounded: string[] = [];
    for (const rel of ROUTER_PATH_MODULES) {
      const src = readFileSync(path.join(SRC, rel), 'utf8');
      for (const m of src.matchAll(BOUNDED_SERVICES)) {
        if (!m[2].includes('BOUNDED_REQUEST_HANDLER')) unbounded.push(`${rel}: ${m[0]}`);
      }
    }
    expect(unbounded).toEqual([]);
  });

  it("the router's own Lambda client is bounded, because it only fires asynchronous invokes", () => {
    const src = readFileSync(path.join(SRC, 'router-agent-handler.ts'), 'utf8');
    expect(src).toMatch(/new LambdaClient\(\{[^)]*BOUNDED_REQUEST_HANDLER/);
    // If a synchronous invoke is ever added, the bound is wrong for it: revisit, do not just delete this.
    expect(src).not.toMatch(/InvocationType\.RequestResponse/);
  });
});
