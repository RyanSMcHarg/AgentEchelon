/**
 * THE QUEUE-HEALTH READ MUST NOT BE PUT BACK IN THE VPC (ADR-033).
 *
 * It was written there first, on the reasonable assumption that a panel belongs beside its siblings.
 * The analytics query Lambda sits in isolated subnets with no NAT gateway and interface endpoints for
 * Kinesis, Bedrock Runtime, Secrets Manager, S3 and DynamoDB only - the same unreachability that
 * already forces the in-VPC classification lookup to read a projection rather than the Chime SDK.
 *
 * WHAT MAKES THIS WORTH A TEST RATHER THAN A COMMENT is the failure mode. A CloudWatch call from
 * inside that VPC does not fail fast: it HANGS until the function times out. The panel would error
 * after thirty seconds on every request, no code path would look wrong, and the only way to see the
 * cause is to enumerate the VPC's endpoints - which is not where anybody looks first.
 *
 * So the two properties are pinned: the function that reads CloudWatch is not VPC-attached, and it
 * actually holds the permission to read.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'constructs', 'admin-analytics.ts'), 'utf8');

describe('the CloudWatch read lives outside the VPC', () => {
  it('the queue-health function declares no vpc', () => {
    // Asserted on the CONSTRUCT rather than the synthesized template, because "has no VpcConfig" is
    // also true of a function that failed to synthesize at all. This names the declaration.
    //
    // BOUNDED BY THE NEXT STATEMENT, not by a character budget. The first version matched at most 700
    // characters and stopped matching outright the moment the construct grew - a source-shaped guard
    // that fails as "the declaration is missing" when the declaration is right there, which sends
    // whoever reads the failure looking for a deletion that never happened.
    // The function must still be declared at all.
    const start = SRC.indexOf('const queueHealthFn = new lambdaNodeJs.NodejsFunction(');
    expect(start).toBeGreaterThan(-1);
    // The grant that follows it is the boundary of the declaration.
    const end = SRC.indexOf('queueHealthFn.addToRolePolicy(', start);
    expect(end).toBeGreaterThan(start);
    const decl = SRC.slice(start, end);

    // The slice provably covers the BODY, not just the opening line. Without this a boundary that
    // drifted to the very next character would satisfy every assertion below by containing nothing.
    expect(decl).toContain('queue-health.ts');

    expect(decl).not.toMatch(/\bvpc\b/);
    expect(decl).not.toMatch(/securityGroups|vpcSubnets/);
  });

  it('the analytics QUERY lambda still is in the vpc, so the contrast is real', () => {
    // The guard against the guard: if the analytics Lambda ever leaves the VPC, the reasoning above
    // stops applying and this test would otherwise keep passing while meaning nothing.
    const at = SRC.indexOf("const queryFn = new lambdaNodeJs.NodejsFunction(this, 'AnalyticsQueryLambda',");
    expect(at).toBeGreaterThan(-1);
    // A generous window rather than a brace match: the construct is long and its exact shape is not
    // what this asserts - only that it is still the one inside the VPC.
    expect(SRC.slice(at, at + 1200)).toMatch(/\bvpc: aurora\.vpc,/);
  });

  it('the queue-health read is NOT registered on the in-VPC query dispatch', () => {
    // Where it was first written. A `queue_health` entry there would route it back through the
    // Lambda that cannot reach CloudWatch.
    const queryHandler = fs.readFileSync(
      path.join(__dirname, '..', 'lambda', 'src', 'analytics-aurora', 'analytics-query.ts'), 'utf8');
    expect(queryHandler).not.toMatch(/queue_health|getQueueHealth/);
  });
});

describe('and it can actually read', () => {
  it('holds cloudwatch:GetMetricData', () => {
    // Without it the panel returns an error rather than numbers, and a permission gap looks exactly
    // like "the mechanism has not run yet" - which is the reading a zero already carries.
    const grant = /queueHealthFn\.addToRolePolicy\([\s\S]{0,300}?\)\);/.exec(SRC);
    expect(grant).not.toBeNull();
    expect(grant![0]).toContain('cloudwatch:GetMetricData');
  });

  it('holds no WRITE verb on CloudWatch', () => {
    // A panel that reports metrics has no business publishing them: a read surface able to write
    // could manufacture the very numbers an operator uses to judge the design.
    const grant = /queueHealthFn\.addToRolePolicy\([\s\S]{0,300}?\)\);/.exec(SRC);
    expect(grant![0]).not.toMatch(/PutMetricData|PutMetricAlarm|DeleteAlarms/);
  });
});
