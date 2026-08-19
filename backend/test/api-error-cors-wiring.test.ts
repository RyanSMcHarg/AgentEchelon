/**
 * A browser-facing API must attach CORS headers to the GATEWAY's own error responses, not only to
 * the integration's replies.
 *
 * `defaultCorsPreflightOptions` covers the preflight and whatever the Lambda returns. It does not
 * cover the responses API Gateway generates by itself — an authorizer 401, a throttle 429, a 5XX —
 * and without `Access-Control-Allow-Origin` on those, the browser refuses to expose them to the page.
 * `fetch` then rejects with a bare "Failed to fetch": no status, no body, no reason.
 *
 * That is not a cosmetic difference. The share modal showed exactly that during an e2e run, which is
 * indistinguishable from the network being down, and the investigation went looking for a dead
 * endpoint instead of reading the error. An API whose failures cannot be read produces exactly this
 * class of misdiagnosis, which is the same family as the harness that reported OK for dead
 * infrastructure.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

const env = { account: '123456789012', region: 'us-east-1' };

describe('the notification API exposes its own failures to the browser', () => {
  it('attaches CORS headers to gateway 4XX and 5XX responses', async () => {
    const { NotificationStack } = await import('../lib/stacks/notification-stack');
    const app = new cdk.App({ context: { appUrl: 'https://chat.example.com' } });
    const stack = new NotificationStack(app, 'TestNotificationCors', {
      env,
      userPoolId: 'us-east-1_TestPoolId',
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
      senderEmail: 'assistant@example.com',
    } as never);

    const template = Template.fromStack(stack);
    const responses = Object.values(template.findResources('AWS::ApiGateway::GatewayResponse'));

    const types = responses.map((r) => (r.Properties as Record<string, unknown>).ResponseType);
    // UNAUTHORIZED and EXPIRED_TOKEN are named explicitly, not left to DEFAULT_4XX. Verified live:
    // with only the defaults customised, a tokenless call still returned 401 with no
    // `Access-Control-Allow-Origin` — API Gateway serves the more specific type and does not inherit
    // the default mapping. An expired token is the failure a real session actually hits.
    expect(types).toEqual(expect.arrayContaining([
      'DEFAULT_4XX', 'DEFAULT_5XX', 'UNAUTHORIZED', 'ACCESS_DENIED', 'EXPIRED_TOKEN', 'THROTTLED',
    ]));

    // Each one must actually carry the origin header — a GatewayResponse with no header mapping
    // would satisfy a count-only assertion while changing nothing about what the browser sees.
    for (const r of responses) {
      const params = ((r.Properties as Record<string, unknown>).ResponseParameters || {}) as Record<string, unknown>;
      const originHeader = params['gatewayresponse.header.Access-Control-Allow-Origin'];
      expect(String(originHeader)).toContain('chat.example.com');
    }
  });
});
