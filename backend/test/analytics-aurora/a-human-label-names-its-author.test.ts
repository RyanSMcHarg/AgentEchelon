/**
 * A HUMAN LABEL'S AUTHOR IS THE VERIFIED CALLER, NOT A NAME THE BODY CHOOSES.
 *
 * `ground_truth_scores.scorer_id` is the only attribution the one human signal in this system has.
 * Read from the request body it states nothing: any authorized admin can submit under any name, and
 * any inter-annotator agreement computed over those rows is fabricable by one person submitting
 * twice - which is precisely the figure a judge would be certified against.
 *
 * This is attribution within the authorized set, not access: the write already sits behind the signed
 * admin path. So the test asserts three properties and no more - the caller is written, a body-supplied
 * name cannot displace them, and an unattributable submission is REFUSED rather than landing under a
 * placeholder. The third is the one that matters most: a label with nobody's name against it succeeds,
 * and then counts.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

import { handler } from '../../lambda/src/analytics-aurora/analytics-query';
import { analyticsPathFor as pathFor } from '../helpers/analytics-path';


const SUB = '7f1c2a44-0000-4000-8000-abcdefabcdef';
const EXCHANGE = 'e1111111-2222-4333-8444-555555555555';

/** A SigV4 request as API Gateway presents it under AWS_IAM: no authorizer, an identity instead. */
function iamEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: pathFor(body),
    body: JSON.stringify(body),
    requestContext: {
      identity: {
        // The admin console's session, which the exchange names after the person.
        userArn: `arn:aws:sts::123456789012:assumed-role/agent-echelon-admin-console/console-${SUB}`,
      },
    },
  } as unknown as APIGatewayProxyEvent;
}

function submitBody(extra: Record<string, unknown> = {}) {
  return { queryType: 'ground_truth', action: 'submit', exchangeId: EXCHANGE, score: 80, ...extra };
}

/** The parameters of the one INSERT into ground_truth_scores, or undefined if none was issued. */
function groundTruthInsert(): unknown[] | undefined {
  const call = mockDbQuery.mock.calls.find(
    ([sql]) => typeof sql === 'string' && /INSERT INTO ground_truth_scores/i.test(sql),
  );
  return call?.[1] as unknown[] | undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ADMIN_IAM_ENFORCEMENT = 'true';
  // The Identity Pool's pool is this deployment's own: the registry a function with no TRUSTED_ISSUERS reads.
  process.env.USER_POOL_ID = 'us-east-1_pool';
  mockDbQuery.mockResolvedValue({ rows: [] });
});

describe('a submitted ground-truth label is attributed to the caller', () => {
  it('writes the verified caller as the scorer', async () => {
    const res = await handler(iamEvent(submitBody()));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ submitted: true });
    // Positional: (exchange_id, human_score, classification, reasoning, scorer_id).
    expect(groundTruthInsert()?.[4]).toBe(SUB);
  });

  it('a body-supplied scorerId cannot name someone else as the author', async () => {
    await handler(iamEvent(submitBody({ scorerId: 'somebody-else' })));
    expect(groundTruthInsert()?.[4]).toBe(SUB);
    expect(groundTruthInsert()).not.toContain('somebody-else');
  });

  it('never falls back to a placeholder author: an unattributable label is refused', async () => {
    // A signed service principal that is not a person - allowed past the 401 gate, because the gateway
    // vetted its signature, and therefore the one shape that could write a nameless label.
    const anonymousAdmin = {
      httpMethod: 'POST',
      path: pathFor(submitBody()),
      body: JSON.stringify(submitBody()),
      requestContext: {
        identity: { userArn: 'arn:aws:iam::123456789012:role/host-proxy' },
      },
    } as unknown as APIGatewayProxyEvent;

    const res = await handler(anonymousAdmin);
    expect(JSON.parse(res.body)).toMatchObject({ submitted: false });
    expect(res.body).toMatch(/attribute the label to a caller/i);
    expect(groundTruthInsert()).toBeUndefined();
  });
});

describe('the allowlist is where this is actually enforced', () => {
  it('scorerId is not a body parameter the handler will carry', async () => {
    // The guard rather than the symptom. Re-adding `scorerId` to `buildParamsFromBody` would revive
    // the defect everywhere at once, including on any future writer of this column, so the absence is
    // pinned here as well as in the behavior above.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(
        require.resolve('../../lambda/src/analytics-aurora/analytics-query.ts'),
        'utf8',
      ),
    );
    const allowlist = source.slice(
      source.indexOf('function buildParamsFromBody'),
      source.indexOf('return { params: p };'),
    );
    // Strip comment lines first: this rule is explained in a comment inside that very function, and a
    // whole-region search would find its own documentation.
    const code = allowlist
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/'scorerId'/);
  });
});

describe('a label carries compliance and groundedness halves (SPEC-EVALUATION Appendix C4)', () => {
  const RULE = require('../../lib/config/compliance-rules').DEFAULT_COMPLIANCE_RULES[0].id as string;

  it('stores both halves when the person gave them', async () => {
    const res = await handler(iamEvent(submitBody({ isCompliant: 'false', complianceCategories: RULE, isGrounded: 'true' })));
    expect(JSON.parse(res.body)).toMatchObject({ submitted: true });
    const p = groundTruthInsert()!;
    expect(p[5]).toBe(false);
    expect(p[6]).toBe(JSON.stringify([RULE]));
    expect(p[7]).toBe(true);
  });

  it('stores NULL, never a pass, for a half the person left out', async () => {
    await handler(iamEvent(submitBody()));
    const p = groundTruthInsert()!;
    expect(p[5]).toBeNull();
    expect(p[6]).toBeNull();
    expect(p[7]).toBeNull();
  });

  it('refuses a rule id the rule set does not declare, and a compliant label naming a breach', async () => {
    const unknown = await handler(iamEvent(submitBody({ isCompliant: 'false', complianceCategories: 'no-such-rule' })));
    expect(JSON.parse(unknown.body)).toMatchObject({ submitted: false });
    const contradictory = await handler(iamEvent(submitBody({ isCompliant: 'true', complianceCategories: RULE })));
    expect(JSON.parse(contradictory.body)).toMatchObject({ submitted: false });
    expect(groundTruthInsert()).toBeUndefined();
  });
});
