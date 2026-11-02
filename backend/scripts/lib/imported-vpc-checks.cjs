/**
 * THE IMPORTED VPC'S ROUTES TO WHAT THE IN-VPC HANDLERS READ, decided without AWS.
 *
 * With `analyticsVpcId` set and `createVpcEndpoints=false`, the Aurora archive places its handlers (and each
 * classification's turn data plane) in a VPC another owner runs, and relies on that VPC's own endpoints for every
 * AWS call they make. Synth cannot see an imported endpoint's policy or its route tables, so an S3 gateway endpoint
 * whose policy does not name the registry bucket deploys cleanly and then hangs every in-VPC handler on its first
 * registry read (`AE_PROFILE_REGISTRY_S3`), until the function times out. This module holds the decisions;
 * `scripts/check-imported-vpc.mjs` gathers the facts (EC2 `DescribeVpcEndpoints`, route tables, subnets, security
 * groups) and `deploy.mjs` / `deploy-stack.mjs` refuse a deploy on a failed check.
 *
 * The policy evaluator covers what an endpoint policy uses: `Effect`, `Principal`/`NotPrincipal`,
 * `Action`/`NotAction`, `Resource`/`NotResource`, with `*` and `?` wildcards. A statement with a `Condition` is not
 * evaluated: an Allow that matches only under a condition is reported as unconfirmed (a warning), and a Deny under a
 * condition likewise, because whether the condition holds for a Lambda role's request is not knowable here.
 */

/** The deploy.config.json / context keys that select this check. */
const IMPORTED_VPC_KEYS = { vpcId: 'analyticsVpcId', subnetType: 'analyticsVpcSubnetType', endpoints: 'createVpcEndpoints' };

/**
 * Whether the context selects an imported VPC that brings its own endpoints: Aurora mode, `analyticsVpcId` set,
 * `createVpcEndpoints` false. Only then does the deployment depend on endpoints it does not create.
 * `value(key)` reads one context value (deploy-guards `contextValue` over the forwarded flags).
 */
function importedVpcSelection(value) {
  const mode = String(value('analyticsMode') ?? '').trim();
  const vpcId = String(value(IMPORTED_VPC_KEYS.vpcId) ?? '').trim();
  const endpoints = String(value(IMPORTED_VPC_KEYS.endpoints) ?? '').trim();
  if (mode !== 'aurora' || !vpcId || endpoints !== 'false') return null;
  const subnetType = String(value(IMPORTED_VPC_KEYS.subnetType) ?? '').trim() || 'isolated';
  return { vpcId, subnetType };
}

// ── POLICY EVALUATION ─────────────────────────────────────────────────────────────────────────────

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** IAM wildcard match: `*` any run, `?` one character. Actions compare case-insensitively, resources exactly. */
function wildcardMatch(pattern, value, { caseInsensitive = false } = {}) {
  const p = caseInsensitive ? String(pattern).toLowerCase() : String(pattern);
  const v = caseInsensitive ? String(value).toLowerCase() : String(value);
  const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');
  return re.test(v);
}

/**
 * Whether a statement's principal admits a role in `account`: `"*"`, `{"AWS": "*"}`, or the account named by id or
 * root ARN admit it ('yes'). A principal naming specific roles or users, or a `NotPrincipal`, is 'unknown': which
 * role a handler runs as is the stack's to decide, and this check does not guess it.
 */
function principalAdmits(statement, account) {
  if (statement.NotPrincipal !== undefined) return 'unknown';
  const p = statement.Principal;
  if (p === undefined || p === '*') return 'yes';
  if (typeof p !== 'object') return 'unknown';
  const aws = asList(p.AWS);
  if (aws.includes('*')) return 'yes';
  if (account && aws.some((a) => a === account || a === `arn:aws:iam::${account}:root`)) return 'yes';
  return aws.length ? 'unknown' : 'no';
}

function statementMatches(statement, { action, resource }) {
  const actionHit = statement.NotAction !== undefined
    ? !asList(statement.NotAction).some((a) => wildcardMatch(a, action, { caseInsensitive: true }))
    : asList(statement.Action).some((a) => wildcardMatch(a, action, { caseInsensitive: true }));
  if (!actionHit) return false;
  if (statement.NotResource !== undefined) return !asList(statement.NotResource).some((r) => wildcardMatch(r, resource));
  if (statement.Resource === undefined) return true;
  return asList(statement.Resource).some((r) => wildcardMatch(r, resource));
}

/**
 * The decision an endpoint policy makes for one request by a role in `account`.
 *
 *   'allow'     an unconditional Allow matches and no Deny can
 *   'deny'      an unconditional Deny matches
 *   'implicit'  nothing allows it (the endpoint refuses it)
 *   'uncertain' it turns on a Condition or a named principal this check cannot resolve
 *
 * An absent policy is the default full-access policy endpoints are created with, so it allows.
 */
function evaluateEndpointPolicy(policy, request, account) {
  if (policy === undefined || policy === null || policy === '') return { decision: 'allow', reason: 'no policy (full access)' };
  let doc = policy;
  if (typeof policy === 'string') {
    try { doc = JSON.parse(policy); } catch { return { decision: 'uncertain', reason: 'the policy document does not parse' }; }
  }
  let allow = false;
  let maybeAllow = null;
  let maybeDeny = null;
  for (const st of asList(doc.Statement)) {
    if (!statementMatches(st, request)) continue;
    const who = principalAdmits(st, account);
    if (who === 'no') continue;
    const conditional = st.Condition !== undefined && Object.keys(st.Condition).length > 0;
    const sid = st.Sid ?? '(no Sid)';
    if (st.Effect === 'Deny') {
      if (who === 'yes' && !conditional) return { decision: 'deny', reason: `statement ${sid} denies it` };
      maybeDeny ??= `statement ${sid} may deny it (${conditional ? 'under a Condition' : 'for a named principal'})`;
    } else if (st.Effect === 'Allow') {
      if (who === 'yes' && !conditional) allow = true;
      else maybeAllow ??= `statement ${sid} allows it only ${conditional ? 'under a Condition' : 'for a named principal'}`;
    }
  }
  if (maybeDeny) return { decision: 'uncertain', reason: maybeDeny };
  if (allow) return { decision: 'allow', reason: 'an Allow statement matches' };
  if (maybeAllow) return { decision: 'uncertain', reason: maybeAllow };
  return { decision: 'implicit', reason: 'no statement allows it' };
}

// ── WHAT THE IN-VPC HANDLERS NEED ─────────────────────────────────────────────────────────────────

/**
 * Every AWS call an in-VPC handler makes, as one request each. The buckets and keys mirror the stacks:
 *   - the registry copy, every in-VPC handler (`lib/profile-registry.ts` `readRowsFromS3`: List + Get);
 *   - the archive bucket: DocumentIngestion reads `rag/`, the evaluation runner reads `delivered-documents/`,
 *     archival writes `delivered-documents/` (`archive-stack-aurora.ts`);
 *   - the attachments bucket (when known): archival reads `generated-docs/`, the evaluation runner reads
 *     `battle-images/`;
 *   - any further bucket an in-VPC function's environment names (`extraBuckets`), read under any key;
 *   - DynamoDB tables an in-VPC function's environment names (`tables`);
 *   - Secrets Manager for the database secret and Bedrock runtime for embeddings and judgments.
 * `service` is the endpoint service suffix (`s3`, `dynamodb`, `secretsmanager`, `bedrock-runtime`).
 */
function inVpcRequirements({ resPrefix, account, region, attachmentsBucket, extraBuckets = [], tables = [] }) {
  const registry = `${resPrefix}-registry-${account}-${region}`;
  const archive = `${resPrefix}-aurora-archive-${account}-${region}`;
  const s3 = (bucket, action, key, who) => ({
    service: 's3', bucket, action, resource: key === null ? `arn:aws:s3:::${bucket}` : `arn:aws:s3:::${bucket}/${key}`, who,
  });
  const out = [
    s3(registry, 's3:ListBucket', null, 'every in-VPC handler (the profile registry copy, AE_PROFILE_REGISTRY_S3)'),
    s3(registry, 's3:GetObject', 'registry/classification/row', 'every in-VPC handler (the profile registry copy, AE_PROFILE_REGISTRY_S3)'),
    s3(archive, 's3:GetObject', 'rag/doc.md', 'DocumentIngestion (the RAG corpus)'),
    s3(archive, 's3:GetObject', 'delivered-documents/doc', 'the evaluation runner (delivered documents)'),
    s3(archive, 's3:PutObject', 'delivered-documents/doc', 'archival (delivered documents)'),
  ];
  if (attachmentsBucket) {
    out.push(s3(attachmentsBucket, 's3:GetObject', 'generated-docs/doc', 'archival (delivered documents)'));
    out.push(s3(attachmentsBucket, 's3:GetObject', 'battle-images/image.png', 'the evaluation runner (image turns)'));
  }
  const known = new Set([registry, archive, attachmentsBucket].filter(Boolean));
  for (const b of [...new Set(extraBuckets)].filter((x) => x && !known.has(x))) {
    out.push(s3(b, 's3:GetObject', 'object', 'an in-VPC function whose environment names this bucket'));
  }
  for (const t of [...new Set(tables)].filter(Boolean)) {
    out.push({ service: 'dynamodb', action: 'dynamodb:GetItem', resource: `arn:aws:dynamodb:${region}:${account}:table/${t}`, who: 'an in-VPC function whose environment names this table', table: t });
  }
  out.push({
    service: 'secretsmanager', action: 'secretsmanager:GetSecretValue',
    resource: `arn:aws:secretsmanager:${region}:${account}:secret:${resPrefix}/analytics-db/master-AbCdEf`,
    who: 'the schema and IAM-auth setup functions (the database secret)',
  });
  out.push({
    service: 'bedrock-runtime', action: 'bedrock:InvokeModel',
    resource: `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`,
    who: 'DocumentIngestion, retrieval, drift and summaries (embeddings)',
  });
  return out;
}

/** The gateway services (route-table based); every other service is reached through an interface endpoint. */
const GATEWAY_SERVICES = new Set(['s3', 'dynamodb']);

// ── SUBNETS AND ROUTES ────────────────────────────────────────────────────────────────────────────

/**
 * A subnet's type the way the CDK VPC lookup decides it: the `aws-cdk:subnet-type` tag when present, else its
 * route table (a default route to an internet gateway is Public, to anything else Private, none Isolated).
 */
function subnetTypeOf(subnet, routeTable) {
  const tag = (subnet.Tags || []).find((t) => t.Key === 'aws-cdk:subnet-type')?.Value;
  if (tag) return tag.toLowerCase();
  const def = (routeTable?.Routes || []).find((r) => r.DestinationCidrBlock === '0.0.0.0/0');
  if (!def) return 'isolated';
  return String(def.GatewayId || '').startsWith('igw-') ? 'public' : 'private';
}

/** The route table that governs a subnet: its explicit association, else the VPC's main table. */
function routeTableOf(subnetId, routeTables) {
  return routeTables.find((rt) => (rt.Associations || []).some((a) => a.SubnetId === subnetId))
    || routeTables.find((rt) => (rt.Associations || []).some((a) => a.Main));
}

/**
 * Whether a route table sends default traffic somewhere a Lambda ENI can leave through: a NAT gateway, a transit
 * gateway, a peering or a network interface (a NAT instance). An internet gateway does not count: a Lambda ENI has
 * no public address.
 */
function hasNatEgress(routeTable) {
  return (routeTable?.Routes || []).some((r) => r.DestinationCidrBlock === '0.0.0.0/0' && r.State !== 'blackhole'
    && (r.NatGatewayId || r.TransitGatewayId || r.VpcPeeringConnectionId || r.NetworkInterfaceId || r.InstanceId));
}

/** The subnets the in-VPC handlers land in: those of the selected type (`analyticsVpcSubnetType`, default isolated). */
function lambdaSubnets({ subnets, routeTables, subnetType, deployedSubnetIds = [] }) {
  const want = subnetType === 'private' ? 'private' : subnetType === 'public' ? 'public' : 'isolated';
  const chosen = subnets.filter((s) => subnetTypeOf(s, routeTableOf(s.SubnetId, routeTables)) === want).map((s) => s.SubnetId);
  return [...new Set([...chosen, ...deployedSubnetIds])];
}

/** `com.amazonaws.<region>.<service>` → `<service>`. */
function serviceOf(endpoint) {
  const parts = String(endpoint.ServiceName || '').split('.');
  return parts.slice(3).join('.');
}

/** Whether an interface endpoint's security groups admit HTTPS from every Lambda subnet's CIDR. */
function securityGroupsAdmitHttps(endpoint, securityGroups, subnetCidrs) {
  const groups = (endpoint.Groups || []).map((g) => securityGroups.find((sg) => sg.GroupId === g.GroupId)).filter(Boolean);
  const coversHttps = (perm) => perm.IpProtocol === '-1' || (perm.IpProtocol === 'tcp' && perm.FromPort <= 443 && perm.ToPort >= 443);
  const perms = groups.flatMap((g) => g.IpPermissions || []).filter(coversHttps);
  const cidrs = perms.flatMap((p) => (p.IpRanges || []).map((r) => r.CidrIp));
  const sgRefs = perms.flatMap((p) => (p.UserIdGroupPairs || []).map((u) => u.GroupId));
  const uncovered = subnetCidrs.filter((c) => !cidrs.some((range) => cidrContains(range, c)));
  if (!uncovered.length) return { ok: true };
  return { ok: false, uncovered, sgRefs };
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);
}

/** Whether CIDR `outer` contains CIDR `inner` (IPv4). */
function cidrContains(outer, inner) {
  const [oa, ob] = String(outer).split('/');
  const [ia, ib] = String(inner).split('/');
  const ol = Number(ob);
  const il = Number(ib);
  if (!oa || !ia || Number.isNaN(ol) || Number.isNaN(il) || il < ol) return false;
  const mask = ol === 0 ? 0 : (~0 << (32 - ol)) >>> 0;
  return (ipToInt(oa) & mask) === (ipToInt(ia) & mask);
}

// ── THE CHECK ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Each finding: `{ level: 'ok'|'warn'|'fail', check, detail }`. A 'fail' refuses the deploy.
 *
 * Facts: `vpcId`, `subnetType`, `subnets`, `routeTables`, `endpoints` (DescribeVpcEndpoints), `securityGroups`
 * (the interface endpoints' groups), `deployedSubnetIds` (subnets live in-VPC functions already use), `account`,
 * `requirements` (`inVpcRequirements`).
 */
function checkImportedVpc(facts) {
  const { vpcId, subnetType, subnets, routeTables, endpoints, securityGroups = [], deployedSubnetIds = [], account, requirements } = facts;
  const findings = [];
  const add = (level, check, detail) => findings.push({ level, check, detail });

  const ids = lambdaSubnets({ subnets, routeTables, subnetType, deployedSubnetIds });
  if (!ids.length) {
    add('fail', `${subnetType} subnets in ${vpcId}`, `no subnet of type "${subnetType}" (analyticsVpcSubnetType) in the VPC, so the in-VPC handlers have nowhere to run.`);
    return findings;
  }
  add('ok', `In-VPC handler subnets (${subnetType})`, ids.join(', '));
  const live = endpoints.filter((e) => e.State === 'available' || e.State === 'Available');

  for (const service of [...new Set(requirements.map((r) => r.service))]) {
    const reqs = requirements.filter((r) => r.service === service);
    const ofService = live.filter((e) => serviceOf(e) === service);

    if (GATEWAY_SERVICES.has(service)) {
      // The subnets each gateway endpoint serves, so a policy is evaluated once per endpoint.
      const served = new Map();
      for (const subnetId of ids) {
        const rt = routeTableOf(subnetId, routeTables);
        const gateway = ofService.find((e) => e.VpcEndpointType === 'Gateway' && (e.RouteTableIds || []).includes(rt?.RouteTableId));
        if (gateway) {
          served.set(gateway, [...(served.get(gateway) || []), subnetId]);
        } else if (hasNatEgress(rt)) {
          add('ok', `${service} from ${subnetId}`, `no ${service} gateway endpoint on ${rt?.RouteTableId}; reached through the route table's default route.`);
        } else {
          add('fail', `${service} from ${subnetId}`, `route table ${rt?.RouteTableId ?? '(none)'} has no ${service} gateway endpoint and no NAT route, so every ${service} call from an in-VPC handler hangs until the function times out. `
            + `Fix: associate a ${service} gateway endpoint in ${vpcId} with ${rt?.RouteTableId ?? 'the subnet\'s route table'}, or deploy with createVpcEndpoints=true.`);
        }
      }
      for (const [gateway, subnetIds] of served) {
        for (const r of reqs) {
          // A route-only requirement names no resource to evaluate the policy against (no table is known yet).
          if (r.routeOnly) add('ok', `${gateway.VpcEndpointId} (${subnetIds.join(', ')}): ${service} route`, r.who);
          else policyFinding(add, gateway, r, account, subnetIds.join(', '));
        }
      }
      continue;
    }

    // An interface endpoint: reachable from any subnet in the VPC through private DNS.
    const iface = ofService.find((e) => e.VpcEndpointType === 'Interface');
    if (!iface) {
      const natAll = ids.every((id) => hasNatEgress(routeTableOf(id, routeTables)));
      if (natAll) {
        add('ok', `${service}`, `no ${service} interface endpoint; reached through the subnets' default route.`);
      } else {
        add('fail', `${service}`, `${vpcId} has no ${service} interface endpoint and the handler subnets have no NAT route, so ${reqs[0].who} cannot reach ${service}. `
          + `Fix: add a com.amazonaws.<region>.${service} interface endpoint (private DNS on) in the handler subnets, or deploy with createVpcEndpoints=true.`);
      }
      continue;
    }
    if (iface.PrivateDnsEnabled === false) {
      add('fail', `${service} endpoint ${iface.VpcEndpointId}`, `private DNS is off, so the SDK's default ${service} hostname does not resolve to it. Fix: enable private DNS on ${iface.VpcEndpointId}.`);
      continue;
    }
    const cidrs = ids.map((id) => subnets.find((s) => s.SubnetId === id)?.CidrBlock).filter(Boolean);
    const sg = securityGroupsAdmitHttps(iface, securityGroups, cidrs);
    if (!sg.ok) {
      const refs = sg.sgRefs.length ? ` It admits HTTPS from security group(s) ${sg.sgRefs.join(', ')}, which the stack's function security groups are not.` : '';
      add('fail', `${service} endpoint ${iface.VpcEndpointId}`, `its security groups do not admit HTTPS (443) from ${sg.uncovered.join(', ')}.${refs} `
        + `Fix: allow tcp/443 from the handler subnets' CIDRs (or the VPC CIDR) on ${(iface.Groups || []).map((g) => g.GroupId).join(', ')}.`);
      continue;
    }
    for (const r of reqs) policyFinding(add, iface, r, account);
  }
  return findings;
}

function policyFinding(add, endpoint, req, account, subnetId) {
  const v = evaluateEndpointPolicy(endpoint.PolicyDocument, req, account);
  const target = req.bucket ? `${req.action} on ${req.resource.replace('arn:aws:s3:::', 's3://')}` : `${req.action} on ${req.resource}`;
  const where = subnetId ? ` (${subnetId})` : '';
  if (v.decision === 'allow') {
    add('ok', `${endpoint.VpcEndpointId}${where}: ${target}`, req.who);
    return;
  }
  const fix = req.bucket
    ? `Fix: add an Allow for ${req.action} on arn:aws:s3:::${req.bucket}${req.action === 's3:ListBucket' ? '' : '/*'} to the policy of ${endpoint.VpcEndpointId}, or deploy with createVpcEndpoints=true.`
    : `Fix: allow ${req.action} on ${req.resource} in the policy of ${endpoint.VpcEndpointId}, or deploy with createVpcEndpoints=true.`;
  if (v.decision === 'uncertain') {
    add('warn', `${endpoint.VpcEndpointId}${where}: ${target}`, `not confirmed: ${v.reason}. ${req.who} needs it. ${fix}`);
    return;
  }
  add('fail', `${endpoint.VpcEndpointId}${where}: ${target}`, `the endpoint policy refuses it (${v.reason}), so ${req.who} hangs or fails on it. ${fix}`);
}

/** The refusal text for the failed findings, or null when none failed. */
function describeImportedVpcFailures(findings, vpcId) {
  const failed = findings.filter((f) => f.level === 'fail');
  if (!failed.length) return null;
  return [
    `The imported VPC ${vpcId} (createVpcEndpoints=false) does not give the in-VPC handlers a route to what they read:`,
    ...failed.map((f) => `  - ${f.check}: ${f.detail}`),
    'Synth cannot see an imported VPC\'s endpoints, so nothing else catches this before every in-VPC handler times out.',
    'Check it on its own with `npm run check:vpc`. See docs/specs/foundations/SPEC-AURORA-VPC-MODE.md, "Imported VPC".',
  ].join('\n');
}

module.exports = {
  IMPORTED_VPC_KEYS,
  GATEWAY_SERVICES,
  importedVpcSelection,
  wildcardMatch,
  evaluateEndpointPolicy,
  inVpcRequirements,
  subnetTypeOf,
  routeTableOf,
  hasNatEgress,
  lambdaSubnets,
  cidrContains,
  checkImportedVpc,
  describeImportedVpcFailures,
};
