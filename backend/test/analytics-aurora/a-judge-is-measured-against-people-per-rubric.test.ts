/**
 * A judge is measured against people, per rubric and per instance (SPEC-EVALUATION Appendix C4, FR15):
 * kappa and the two error rates with their population, the agreement people reach with each other, a
 * judge that judged its own answers, and a new series whenever the judge or the rubric changes.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import { agreementOf, baseModelId } from '../../lambda/src/lib/agreement';
import { minimumDetectableDifference } from '../../lambda/src/lib/experiment-stats';
import { handler, JUDGE_CALIBRATION_COLUMNS, relevanceMdd } from '../../lambda/src/analytics-aurora/analytics-query';

describe('agreement between a judge and a person', () => {
  it('reports kappa, which discounts the agreement chance alone produces', () => {
    // 90 of 100 agree, but failures are rare: saying "fine" to everything would agree 90 times too.
    const a = agreementOf({ tp: 0, fp: 0, fn: 10, tn: 90 });
    expect(a.n).toBe(100);
    expect(a.kappa).toBe(0);
    expect(a.tpr).toBe(0);
    expect(a.tnr).toBe(1);
  });

  it('computes the textbook kappa and both rates', () => {
    const a = agreementOf({ tp: 20, fp: 5, fn: 10, tn: 15 });
    // po = 35/50 = 0.7; pe = (25*30 + 25*20)/2500 = 0.5; kappa = 0.4
    expect(a.kappa).toBe(0.4);
    expect(a.tpr).toBe(0.667);
    expect(a.tnr).toBe(0.75);
  });

  it('is null, not 100 percent, where there is nothing to measure', () => {
    expect(agreementOf({ tp: 0, fp: 0, fn: 0, tn: 0 })).toMatchObject({ n: 0, kappa: null, tpr: null, tnr: null });
    // Every item in one class on both sides: chance explains all of it, so kappa is undefined.
    expect(agreementOf({ tp: 0, fp: 0, fn: 0, tn: 12 }).kappa).toBeNull();
  });

  it('compares model ids without their cross-region prefix', () => {
    expect(baseModelId('us.anthropic.claude-x')).toBe(baseModelId('anthropic.claude-x'));
  });
});

const SUB = '11111111-2222-3333-4444-555555555555';
const teamPost = (assistant: string, body: Record<string, unknown>): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  path: `/analytics/assistants/${assistant}/query`,
  pathParameters: { assistant },
  body: JSON.stringify({ dateRange: { start: '2026-08-01', end: '2026-10-26' }, ...body }),
  requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/agent-echelon-team-console/console-${SUB}@standard` } },
} as unknown as APIGatewayProxyEvent);

describe('the calibration reading', () => {
  beforeEach(() => mockDbQuery.mockReset().mockResolvedValue({ rows: [] }));
  const call = () => mockDbQuery.mock.calls.find(([s]) => String(s).includes('judge_rows'))!;

  it('splits every judge row by evaluator model and rubric version, so a change starts a new series', async () => {
    await handler(teamPost('analyst', { queryType: 'judge_calibration' }));
    const [sql] = call();
    expect(sql).toMatch(/GROUP BY assistant, conversation_classification, evaluator_model, rubric_version/);
    expect(sql).toMatch(/GROUP BY assistant, conversation_classification, evaluator_model, rule_set_version/);
    expect(sql).toMatch(/GROUP BY assistant, conversation_classification, evaluator_model, groundedness_rubric_version/);
  });

  it('measures people against each other on the same items, two different scorers at a time', async () => {
    await handler(teamPost('analyst', { queryType: 'judge_calibration' }));
    const [sql] = call();
    expect(sql).toMatch(/JOIN per_scorer b ON b\.exchange_id = a\.exchange_id AND b\.scorer_id > a\.scorer_id/);
  });

  it('counts the verdicts a judge gave on its own answers', async () => {
    mockDbQuery.mockResolvedValue({ rows: [
      { dimension: 'self', rubric: null, assistant: 'analyst', conversation_classification: 'standard', evaluator_model: 'm', version: null, tp: '3', fp: '0', fn: '0', tn: '40' },
      { dimension: 'judge', rubric: 'compliance', assistant: 'analyst', conversation_classification: 'standard', evaluator_model: 'm', version: '2', tp: '20', fp: '5', fn: '10', tn: '15' },
    ] });
    const body = JSON.parse((await handler(teamPost('analyst', { queryType: 'judge_calibration' }))).body);
    expect(body.data.find((r: { dimension: string }) => r.dimension === 'self')).toMatchObject({ judged: 40, self_judged: 3 });
    expect(body.data.find((r: { dimension: string }) => r.dimension === 'judge')).toMatchObject({ kappa: 0.4, n: 50 });
    expect(Object.keys(body.data[0]).sort()).toEqual([...JUDGE_CALIBRATION_COLUMNS].sort());
  });

  it('is bound to the team\'s assistant and clearance', async () => {
    await handler(teamPost('analyst', { queryType: 'judge_calibration', agentType: 'advisor' }));
    const [, params] = call();
    expect(params).toContain('analyst');
    expect(params).not.toContain('advisor');
  });
});

describe('an alert needs a population that can detect it', () => {
  it('reports the smallest gap from target the conversations behind an average can detect', () => {
    // 2.80 * 20 / sqrt(16) = 14.0
    expect(relevanceMdd({ direct_relevance_sd: 20, direct_relevance_conversations: 16 })).toBe(14);
    expect(relevanceMdd({ direct_relevance_sd: null, direct_relevance_conversations: 0 })).toBeNull();
    expect(minimumDetectableDifference(20, 0)).toBe(Infinity);
  });

  it('counts conversations, not turns, because turns in one conversation are not independent', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/analytics-aurora/analytics-query.ts'), 'utf8');
    expect(src).toMatch(/COUNT\(DISTINCT e\.channel_arn\) FILTER \(WHERE er\.relevance_score IS NOT NULL AND e\.task_id IS NULL\) AS direct_relevance_conversations/);
  });
});
