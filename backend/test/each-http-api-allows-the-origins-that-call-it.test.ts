/**
 * EACH HTTP API ALLOWS EXACTLY THE ORIGINS THAT CALL IT.
 *
 * CORS is the API's own (`lib/constructs/http-api.ts`): the gateway answers every preflight and adds the
 * configured headers, echoing the one allowed origin a request names. So the list is the boundary a browser
 * sees, and it is derived rather than typed:
 *
 *  - `PersonApi`: the chat app (`appUrl`), the admin console (`adminAppUrl`), which resolves its person on
 *    the person exchange before it asks for a console session, and every origin an issuer declares for its
 *    clients (`allowedOrigins`, the hosts that embed the widget).
 *  - `AdminApi`: the admin console alone.
 *
 * The preflight admits the signing headers, since the console SigV4-signs every admin call, and every method
 * a route serves. A REST API answered its own refusals with no CORS unless each response type was overridden
 * by hand; whether an HTTP API's refusals (an authorizer's 401 or 403, a throttle's 429) carry these headers
 * is checked against the deployed APIs.
 */
import * as path from 'path';
import { synthesizeApp } from '../lib/docs/api-contract';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;
const APP_URL = 'https://chat.example.com';
const ADMIN_URL = 'https://console.example.com';
const HOST = 'https://host.example.org';

type Resource = { Type: string; Properties?: Record<string, any> };
const apiOf = (t: { Resources?: Record<string, Resource> }) =>
  Object.values(t.Resources ?? {}).find((r) => r.Type === 'AWS::ApiGatewayV2::Api')!.Properties!;
const methodsOf = (t: { Resources?: Record<string, Resource> }) =>
  [...new Set(Object.values(t.Resources ?? {}).filter((r) => r.Type === 'AWS::ApiGatewayV2::Route').map((r) => String(r.Properties!.RouteKey).split(' ')[0]))];

describe('each HTTP API allows exactly the origins that call it', () => {
  let person: Record<string, any>;
  let admin: Record<string, any>;
  let templates: Record<string, { Resources?: Record<string, Resource> }>;
  beforeAll(() => {
    const app = synthesizeApp(REPO_ROOT, {
      id: 'cors',
      context: {
        appUrl: APP_URL,
        adminAppUrl: ADMIN_URL,
        capabilities: ['chat', 'admin', 'experiments'],
        issuers: [
          { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true },
          { id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostApp', audience: 'host-client', allowedOrigins: [HOST], clearance: { oneChannel: 'basic', classifications: ['basic'] } },
        ],
      },
    });
    templates = app.templates as never;
    person = apiOf(templates.AgentEchelonPersonApi).CorsConfiguration;
    admin = apiOf(templates.AgentEchelonAdminApi).CorsConfiguration;
  }, SYNTH_TIMEOUT_MS);

  it('PersonApi: both consoles and every host an issuer declares, and nothing else', () => {
    expect([...person.AllowOrigins].sort()).toEqual([ADMIN_URL, APP_URL, HOST].sort());
  });

  it('AdminApi: the admin console alone', () => {
    expect(admin.AllowOrigins).toEqual([ADMIN_URL]);
  });

  it('admits the bearer and the SigV4 signing headers on every preflight', () => {
    for (const cors of [person, admin]) {
      expect(cors.AllowHeaders).toEqual(expect.arrayContaining(['Authorization', 'Content-Type', 'X-Amz-Date', 'X-Amz-Security-Token', 'X-Amz-Content-Sha256']));
      expect(cors.AllowOrigins).not.toContain('*');
    }
  });

  it('advertises every method a route serves', () => {
    expect(person.AllowMethods).toEqual(expect.arrayContaining(methodsOf(templates.AgentEchelonPersonApi)));
    expect(admin.AllowMethods).toEqual(expect.arrayContaining(methodsOf(templates.AgentEchelonAdminApi)));
    expect(admin.AllowMethods).toContain('DELETE');
  });
});
