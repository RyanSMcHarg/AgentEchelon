/**
 * THE EXCHANGE'S HALF OF A HOST ASSERTION (A9): its `jti` is consumed before anything is vended.
 *
 * The edge authorizer verified the assertion against the host's pinned keys and recorded its `jti` in
 * `Tokens` (`recordAssertionJti`). Here the exchange consumes that record with the one conditional update
 * every single-use token gets (`consumeAssertionJti`), before it binds a person or assumes a role. So:
 *
 *  - an assertion presented twice is refused the second time, by the edge and, should a second request
 *    ever reach here, by the consumed record;
 *  - an assertion that reached the exchange without the edge recording it has no record, and is refused;
 *  - an expired record is refused before DynamoDB TTL has deleted anything.
 *
 * The `Tokens` table lives in a stack that deploys after this function's, so its name is read once per
 * container from the parameter that stack publishes (`TOKENS_TABLE_PARAMETER`). A store that cannot be
 * read refuses the assertion: an assertion is never vended for unconsumed.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { consumeAssertionJti, type Redemption } from './tokens.js';
import { countAssertionRefused } from './host-assertion-metric.js';
import { reply } from './vend.js';
import type { HttpResult } from './http-response.js';

export interface HostAssertionDeps {
  consume?: (issuerId: string, jti: string, now: number) => Promise<Redemption>;
  count?: (issuerId: string, check: string) => void;
  now?: () => number;
}

let deps: HostAssertionDeps = {};
/** Replace the store, the metric and the clock. For tests. */
export function __setHostAssertionDepsForTests(next: HostAssertionDeps = {}): void {
  deps = next;
  tableName = null;
}

let doc: DynamoDBDocumentClient | null = null;
let ssm: SSMClient | null = null;
let tableName: string | null = null;

async function tokensTable(): Promise<string> {
  if (tableName) return tableName;
  const parameter = process.env.TOKENS_TABLE_PARAMETER || '';
  if (!parameter) throw new Error('TOKENS_TABLE_PARAMETER is not set');
  ssm ??= new SSMClient({});
  const value = (await ssm.send(new GetParameterCommand({ Name: parameter })))?.Parameter?.Value;
  if (!value) throw new Error(`${parameter} is empty`);
  tableName = value;
  return value;
}

async function consumeInTokens(issuerId: string, jti: string, now: number): Promise<Redemption> {
  doc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return consumeAssertionJti(doc, await tokensTable(), { issuerId, jti, now });
}

/** Count a refusal the exchange makes of an assertion, by check. */
export function countExchangeRefusal(issuerId: string, check: string): void {
  (deps.count ?? countAssertionRefused)(issuerId, check);
}

/**
 * Spend the assertion's `jti`. Null when it was consumed by this call; otherwise the refusal to return,
 * and nothing has been vended or bound.
 */
export async function spendHostAssertion(event: unknown, issuerId: string, claims: Record<string, unknown>): Promise<HttpResult | null> {
  const jti = typeof claims.jti === 'string' ? claims.jti : '';
  if (!jti) {
    countExchangeRefusal(issuerId, 'no-jti');
    return reply(event, 401, { error: 'a host assertion carries a jti, presented once', code: 'ASSERTION_REFUSED' });
  }
  let redemption: Redemption;
  try {
    redemption = await (deps.consume ?? consumeInTokens)(issuerId, jti, Math.floor((deps.now?.() ?? Date.now()) / 1000));
  } catch (err) {
    console.error('[CredentialExchange][SecurityEvent] a host assertion could not be consumed; vending nothing', { issuer: issuerId, err: (err as Error)?.name });
    countExchangeRefusal(issuerId, 'store-unavailable');
    return reply(event, 503, { error: 'the assertion could not be checked; try again', code: 'ASSERTION_UNAVAILABLE' });
  }
  if (!redemption.ok) {
    console.warn('[CredentialExchange][SecurityEvent] a host assertion was refused at the exchange', { issuer: issuerId, reason: redemption.reason });
    countExchangeRefusal(issuerId, redemption.reason === 'consumed' ? 'replayed' : redemption.reason === 'unknown' ? 'unrecorded' : redemption.reason);
    return reply(event, 401, { error: 'this assertion cannot be used', code: 'ASSERTION_REFUSED' });
  }
  return null;
}
