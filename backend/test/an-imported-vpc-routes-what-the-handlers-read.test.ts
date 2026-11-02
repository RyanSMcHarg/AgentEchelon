/**
 * An imported analytics VPC that brings its own endpoints (`createVpcEndpoints=false`) must route every call an in-VPC
 * handler makes (scripts/lib/imported-vpc-checks.cjs). Synth cannot see an imported endpoint's policy, so an S3
 * gateway endpoint whose policy leaves out the registry bucket deploys cleanly and hangs every in-VPC handler on its
 * first registry read. These are the decisions the deploy preflight refuses on, over facts shaped like EC2's
 * Describe* responses.
 */
import * as fs from 'fs';
import * as path from 'path';

const {
  importedVpcSelection,
  wildcardMatch,
  evaluateEndpointPolicy,
  inVpcRequirements,
  subnetTypeOf,
  hasNatEgress,
  cidrContains,
  checkImportedVpc,
  describeImportedVpcFailures,
} = require('../scripts/lib/imported-vpc-checks.cjs');
const { DEPLOY_STEPS } = require('../scripts/lib/deploy-guards.cjs');

const ACCOUNT = '111122223333';
const REGION = 'us-east-1';
const REGISTRY = `agent-echelon-registry-${ACCOUNT}-${REGION}`;
const ARCHIVE = `agent-echelon-aurora-archive-${ACCOUNT}-${REGION}`;

const getRegistry = { action: 's3:GetObject', resource: `arn:aws:s3:::${REGISTRY}/registry/classification/row` };

describe('the endpoint policy evaluator', () => {
  it('matches IAM wildcards, actions without regard to case and resources exactly', () => {
    expect(wildcardMatch('s3:Get*', 'S3:GETOBJECT', { caseInsensitive: true })).toBe(true);
    expect(wildcardMatch('arn:aws:s3:::bucket/*', 'arn:aws:s3:::bucket/a/b')).toBe(true);
    expect(wildcardMatch('arn:aws:s3:::bucket/*', 'arn:aws:s3:::Bucket/a')).toBe(false);
    expect(wildcardMatch('arn:aws:s3:::b?cket', 'arn:aws:s3:::bucket')).toBe(true);
    expect(wildcardMatch('arn:aws:s3:::bucket.x', 'arn:aws:s3:::bucketyx')).toBe(false);
  });

  it('allows under the default full-access policy, and with no policy at all', () => {
    const full = { Version: '2008-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: '*', Resource: '*' }] };
    expect(evaluateEndpointPolicy(JSON.stringify(full), getRegistry, ACCOUNT).decision).toBe('allow');
    expect(evaluateEndpointPolicy(undefined, getRegistry, ACCOUNT).decision).toBe('allow');
  });

  it('refuses a policy that names other buckets only: the case that hung every in-VPC handler', () => {
    const other = { Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::other-project-*/*' }] };
    expect(evaluateEndpointPolicy(other, getRegistry, ACCOUNT)).toEqual({ decision: 'implicit', reason: 'no statement allows it' });
  });

  it('lets an unconditional Deny win over an Allow', () => {
    const policy = {
      Statement: [
        { Effect: 'Allow', Principal: '*', Action: '*', Resource: '*' },
        { Sid: 'NoRegistry', Effect: 'Deny', Principal: { AWS: '*' }, Action: 's3:*', Resource: `arn:aws:s3:::${REGISTRY}/*` },
      ],
    };
    expect(evaluateEndpointPolicy(policy, getRegistry, ACCOUNT).decision).toBe('deny');
  });

  it('honors NotAction and NotResource', () => {
    const notAction = { Statement: [{ Effect: 'Allow', Principal: '*', NotAction: 's3:Delete*', Resource: '*' }] };
    expect(evaluateEndpointPolicy(notAction, getRegistry, ACCOUNT).decision).toBe('allow');
    const notResource = { Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:*', NotResource: `arn:aws:s3:::${REGISTRY}/*` }] };
    expect(evaluateEndpointPolicy(notResource, getRegistry, ACCOUNT).decision).toBe('implicit');
  });

  it('admits the account by id or root ARN, and reports a named role as unconfirmed', () => {
    const byRoot = { Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` }, Action: 's3:GetObject', Resource: '*' }] };
    expect(evaluateEndpointPolicy(byRoot, getRegistry, ACCOUNT).decision).toBe('allow');
    const byRole = { Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${ACCOUNT}:role/x` }, Action: 's3:GetObject', Resource: '*' }] };
    expect(evaluateEndpointPolicy(byRole, getRegistry, ACCOUNT).decision).toBe('uncertain');
    const otherAccount = { Statement: [{ Effect: 'Allow', Principal: { AWS: [] }, Action: 's3:GetObject', Resource: '*' }] };
    expect(evaluateEndpointPolicy(otherAccount, getRegistry, ACCOUNT).decision).toBe('implicit');
  });

  it('does not evaluate a Condition: a conditional Allow or Deny is unconfirmed, not passed', () => {
    const condAllow = { Statement: [{ Effect: 'Allow', Principal: '*', Action: '*', Resource: '*', Condition: { StringEquals: { 'aws:PrincipalOrgID': 'o-1' } } }] };
    expect(evaluateEndpointPolicy(condAllow, getRegistry, ACCOUNT).decision).toBe('uncertain');
    const condDeny = {
      Statement: [
        { Effect: 'Allow', Principal: '*', Action: '*', Resource: '*' },
        { Effect: 'Deny', Principal: '*', Action: '*', Resource: '*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
      ],
    };
    expect(evaluateEndpointPolicy(condDeny, getRegistry, ACCOUNT).decision).toBe('uncertain');
  });

  it('reports a policy that does not parse as unconfirmed rather than passing it', () => {
    expect(evaluateEndpointPolicy('{not json', getRegistry, ACCOUNT).decision).toBe('uncertain');
  });
});

describe('what the in-VPC handlers need', () => {
  it('names the registry copy, the archive bucket, the database secret and the embedding model', () => {
    const reqs = inVpcRequirements({ resPrefix: 'agent-echelon', account: ACCOUNT, region: REGION });
    const s3 = reqs.filter((r: { service: string }) => r.service === 's3').map((r: { action: string; resource: string }) => `${r.action} ${r.resource}`);
    expect(s3).toEqual(expect.arrayContaining([
      `s3:ListBucket arn:aws:s3:::${REGISTRY}`,
      `s3:GetObject arn:aws:s3:::${REGISTRY}/registry/classification/row`,
      `s3:GetObject arn:aws:s3:::${ARCHIVE}/rag/doc.md`,
      `s3:PutObject arn:aws:s3:::${ARCHIVE}/delivered-documents/doc`,
    ]));
    expect(reqs.map((r: { service: string }) => r.service)).toEqual(expect.arrayContaining(['secretsmanager', 'bedrock-runtime']));
  });

  it('adds the buckets and tables a deployed in-VPC function names, once each', () => {
    const reqs = inVpcRequirements({
      resPrefix: 'agent-echelon', account: ACCOUNT, region: REGION,
      attachmentsBucket: 'attach', extraBuckets: ['attach', REGISTRY, 'extra', 'extra'], tables: ['t1'],
    });
    expect(reqs.filter((r: { bucket?: string }) => r.bucket === 'extra')).toHaveLength(1);
    expect(reqs.filter((r: { bucket?: string }) => r.bucket === 'attach').map((r: { resource: string }) => r.resource))
      .toEqual(['arn:aws:s3:::attach/generated-docs/doc', 'arn:aws:s3:::attach/battle-images/image.png']);
    expect(reqs.find((r: { service: string }) => r.service === 'dynamodb').resource).toBe(`arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/t1`);
  });

  it('matches the names the stacks give the registry and archive buckets', () => {
    const profiles = fs.readFileSync(path.join(__dirname, '../lib/config/profiles.ts'), 'utf8');
    expect(profiles).toContain('return `${resPrefix}-registry-${account}-${region}`;');
    const archive = fs.readFileSync(path.join(__dirname, '../lib/stacks/archive-stack-aurora.ts'), 'utf8');
    expect(archive).toContain('bucketName: `${ANALYTICS_PREFIX}-aurora-archive-${this.account}-${this.region}`');
  });
});

describe('subnets and routes', () => {
  it('types a subnet the way the CDK lookup does: by tag, else by its default route', () => {
    expect(subnetTypeOf({ Tags: [{ Key: 'aws-cdk:subnet-type', Value: 'Isolated' }] }, undefined)).toBe('isolated');
    expect(subnetTypeOf({}, { Routes: [] })).toBe('isolated');
    expect(subnetTypeOf({}, { Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' }] })).toBe('public');
    expect(subnetTypeOf({}, { Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-1' }] })).toBe('private');
  });

  it('counts a NAT or transit gateway as egress and an internet gateway or a blackhole not', () => {
    expect(hasNatEgress({ Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-1' }] })).toBeTruthy();
    expect(hasNatEgress({ Routes: [{ DestinationCidrBlock: '0.0.0.0/0', TransitGatewayId: 'tgw-1' }] })).toBeTruthy();
    expect(hasNatEgress({ Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' }] })).toBeFalsy();
    expect(hasNatEgress({ Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-1', State: 'blackhole' }] })).toBeFalsy();
  });

  it('compares CIDRs', () => {
    expect(cidrContains('10.0.0.0/16', '10.0.1.0/24')).toBe(true);
    expect(cidrContains('10.0.0.0/24', '10.0.1.0/24')).toBe(false);
    expect(cidrContains('0.0.0.0/0', '192.168.0.0/24')).toBe(true);
    expect(cidrContains('10.0.1.0/24', '10.0.0.0/16')).toBe(false);
  });
});

describe('the imported VPC check', () => {
  const isolated = (id: string, cidr: string) => ({ SubnetId: id, CidrBlock: cidr, Tags: [{ Key: 'aws-cdk:subnet-type', Value: 'Isolated' }] });
  const subnets = [isolated('subnet-a', '10.0.0.0/24'), isolated('subnet-b', '10.0.1.0/24')];
  const routeTables = [
    { RouteTableId: 'rtb-a', Associations: [{ SubnetId: 'subnet-a' }], Routes: [{ DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' }] },
    { RouteTableId: 'rtb-b', Associations: [{ SubnetId: 'subnet-b' }], Routes: [{ DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' }] },
    { RouteTableId: 'rtb-main', Associations: [{ Main: true }], Routes: [] },
  ];
  const full = JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: '*', Action: '*', Resource: '*' }] });
  const gateway = (svc: string, policy = full, rts = ['rtb-a', 'rtb-b']) => ({
    VpcEndpointId: `vpce-${svc}`, ServiceName: `com.amazonaws.${REGION}.${svc}`, VpcEndpointType: 'Gateway', State: 'available', RouteTableIds: rts, PolicyDocument: policy,
  });
  const iface = (svc: string, extra = {}) => ({
    VpcEndpointId: `vpce-${svc}`, ServiceName: `com.amazonaws.${REGION}.${svc}`, VpcEndpointType: 'Interface', State: 'available',
    PrivateDnsEnabled: true, Groups: [{ GroupId: 'sg-endpoints' }], PolicyDocument: full, ...extra,
  });
  const securityGroups = [{ GroupId: 'sg-endpoints', IpPermissions: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '10.0.0.0/16' }] }] }];
  const requirements = inVpcRequirements({ resPrefix: 'agent-echelon', account: ACCOUNT, region: REGION, tables: ['agent-echelon-turn-routing-table'] });
  const facts = (endpoints: unknown[], over: Record<string, unknown> = {}) => ({
    vpcId: 'vpc-1', subnetType: 'isolated', subnets, routeTables, endpoints, securityGroups, account: ACCOUNT, requirements, ...over,
  });
  const healthy = () => [gateway('s3'), gateway('dynamodb'), iface('secretsmanager'), iface('bedrock-runtime')];
  const failures = (findings: Array<{ level: string; check: string; detail: string }>) => findings.filter((f) => f.level === 'fail');

  it('passes a VPC whose endpoints route every call (the dev account\'s shape)', () => {
    const findings = checkImportedVpc(facts(healthy()));
    expect(failures(findings)).toEqual([]);
    expect(findings.filter((f: { level: string }) => f.level === 'warn')).toEqual([]);
    expect(describeImportedVpcFailures(findings, 'vpc-1')).toBeNull();
  });

  it('refuses an S3 gateway whose policy leaves out the registry bucket, naming the bucket and the fix', () => {
    const narrow = JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:*', Resource: ['arn:aws:s3:::other-project-*', 'arn:aws:s3:::other-project-*/*'] }] });
    const endpoints = [gateway('s3', narrow), gateway('dynamodb'), iface('secretsmanager'), iface('bedrock-runtime')];
    const failed = failures(checkImportedVpc(facts(endpoints)));
    expect(failed.length).toBeGreaterThan(0);
    const text = describeImportedVpcFailures(checkImportedVpc(facts(endpoints)), 'vpc-1') as string;
    expect(text).toContain(`s3://${REGISTRY}`);
    expect(text).toContain(`Fix: add an Allow for s3:GetObject on arn:aws:s3:::${REGISTRY}/*`);
    expect(text).toContain('createVpcEndpoints=true');
    expect(text).toContain('npm run check:vpc');
  });

  it('refuses a subnet whose route table has no S3 gateway and no NAT route', () => {
    const endpoints = [gateway('s3', full, ['rtb-a']), gateway('dynamodb'), iface('secretsmanager'), iface('bedrock-runtime')];
    const failed = failures(checkImportedVpc(facts(endpoints)));
    expect(failed.map((f) => f.check)).toEqual(['s3 from subnet-b']);
    expect(failed[0].detail).toContain('rtb-b');
  });

  it('accepts a NAT route in place of a gateway endpoint', () => {
    const natTables = routeTables.map((rt) => ({ ...rt, Routes: [...rt.Routes, { DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-1' }] }));
    // Tagged isolated, so the NAT route does not move them out of the selection.
    const findings = checkImportedVpc(facts([iface('secretsmanager'), iface('bedrock-runtime')], { routeTables: natTables }));
    expect(failures(findings)).toEqual([]);
  });

  it('refuses a missing interface endpoint, one without private DNS, and one whose security group does not admit HTTPS', () => {
    const noBedrock = failures(checkImportedVpc(facts([gateway('s3'), gateway('dynamodb'), iface('secretsmanager')])));
    expect(noBedrock.map((f) => f.check)).toEqual(['bedrock-runtime']);

    const noDns = failures(checkImportedVpc(facts([gateway('s3'), gateway('dynamodb'), iface('secretsmanager', { PrivateDnsEnabled: false }), iface('bedrock-runtime')])));
    expect(noDns[0].detail).toContain('private DNS is off');

    const closed = [{ GroupId: 'sg-endpoints', IpPermissions: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [], UserIdGroupPairs: [{ GroupId: 'sg-other' }] }] }];
    const sg = failures(checkImportedVpc(facts(healthy(), { securityGroups: closed })));
    expect(sg).toHaveLength(2);
    expect(sg[0].detail).toContain('sg-other');
  });

  it('ignores an endpoint that is not available', () => {
    const pending = healthy().map((e) => (e.VpcEndpointId === 'vpce-s3' ? { ...e, State: 'pending' } : e));
    expect(failures(checkImportedVpc(facts(pending))).length).toBeGreaterThan(0);
  });

  it('refuses when no subnet of the selected type exists', () => {
    const findings = checkImportedVpc(facts(healthy(), { subnetType: 'private' }));
    expect(failures(findings)[0].detail).toContain('no subnet of type "private"');
  });

  it('checks a route-only requirement for its route and not its policy (a first deploy, no table known yet)', () => {
    const routeOnly = [...inVpcRequirements({ resPrefix: 'agent-echelon', account: ACCOUNT, region: REGION }), { service: 'dynamodb', routeOnly: true, who: 'tables' }];
    const closed = JSON.stringify({ Statement: [] });
    const withGateway = checkImportedVpc(facts([gateway('s3'), gateway('dynamodb', closed), iface('secretsmanager'), iface('bedrock-runtime')], { requirements: routeOnly }));
    expect(failures(withGateway)).toEqual([]);
    const without = checkImportedVpc(facts([gateway('s3'), iface('secretsmanager'), iface('bedrock-runtime')], { requirements: routeOnly }));
    expect(failures(without).map((f) => f.check)).toEqual(['dynamodb from subnet-a', 'dynamodb from subnet-b']);
  });

  it('warns rather than refuses on a conditional policy', () => {
    const cond = JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: '*', Action: '*', Resource: '*', Condition: { StringEquals: { 'aws:PrincipalAccount': ACCOUNT } } }] });
    const findings = checkImportedVpc(facts([gateway('s3', cond), gateway('dynamodb'), iface('secretsmanager'), iface('bedrock-runtime')]));
    expect(failures(findings)).toEqual([]);
    expect(findings.some((f: { level: string }) => f.level === 'warn')).toBe(true);
  });
});

describe('when the check applies, and where it runs', () => {
  const ctx = (o: Record<string, string>) => (k: string) => o[k];

  it('applies only to Aurora mode with an imported VPC and createVpcEndpoints=false', () => {
    expect(importedVpcSelection(ctx({ analyticsMode: 'aurora', analyticsVpcId: 'vpc-1', createVpcEndpoints: 'false' })))
      .toEqual({ vpcId: 'vpc-1', subnetType: 'isolated' });
    expect(importedVpcSelection(ctx({ analyticsMode: 'aurora', analyticsVpcId: 'vpc-1', createVpcEndpoints: 'false', analyticsVpcSubnetType: 'private' })))
      .toEqual({ vpcId: 'vpc-1', subnetType: 'private' });
    expect(importedVpcSelection(ctx({ analyticsMode: 'aurora', analyticsVpcId: 'vpc-1' }))).toBeNull();
    expect(importedVpcSelection(ctx({ analyticsMode: 'aurora', createVpcEndpoints: 'false' }))).toBeNull();
    expect(importedVpcSelection(ctx({ analyticsMode: 'athena', analyticsVpcId: 'vpc-1', createVpcEndpoints: 'false' }))).toBeNull();
  });

  it('runs in npm run deploy before any stack deploys, and in deploy:stack', () => {
    const at = (id: string) => DEPLOY_STEPS.indexOf(id);
    expect(at('assertImportedVpcEgress')).toBeGreaterThan(at('resolveContext'));
    expect(at('assertImportedVpcEgress')).toBeLessThan(at('deployBackend'));
    const stack = fs.readFileSync(path.join(__dirname, '../scripts/deploy-stack.mjs'), 'utf8');
    expect(stack.indexOf('await assertImportedVpcEgress(forwarded')).toBeGreaterThan(-1);
    expect(stack.indexOf('await assertImportedVpcEgress(forwarded')).toBeLessThan(stack.indexOf("'cdk', 'deploy', stackName"));
  });
});
