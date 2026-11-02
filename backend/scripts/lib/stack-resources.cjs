/**
 * Finding a resource of this deployment by asking its stack, not by matching its generated name.
 *
 * A function, role or table whose name CloudFormation generates starts with the stack name, but not
 * the whole of it: the generated name is capped (64 characters for a Lambda function or an IAM role)
 * and the stack and logical-id parts are both cut to fit, by amounts that depend on each other's
 * length. On the default instance the classification creator role is
 * `AgentEchelonClassificatio-TypedConversationFromEve-...`, while `AgentHandler` keeps the stack part
 * whole. So no name prefix built from the stack name (or the instance prefix) selects the same
 * resources on every deployment, and a filter that misses reads as "not deployed".
 *
 * The stack records each resource's physical id against the logical id CDK gave it, which is the
 * construct id followed by an eight-character hash, so a resource is selected by its CloudFormation
 * type and a pattern on its logical id. `ListStackResources` rather than `DescribeStackResources`,
 * which returns at most 100 resources and a classification stack has more.
 *
 * The selection is pure and shared: the e2e helper (tests/e2e/helpers/stack-prefix.ts) uses the same
 * functions over the AWS CLI, and the scripts use them over the SDK below.
 */
const { isInstanceStack } = require('./stack-lookup.cjs');

/** The stacks this app creates for the instance with `prefix`, among `stackNames`. No look-alike instance's. */
function instanceStacksAmong(stackNames, prefix) {
  return (stackNames || []).filter((name) => isInstanceStack(name, prefix));
}

/** The assistant stacks (`<prefix>Assistants-<classification>`) of the instance with `prefix`, among `stackNames`. */
function classificationStacksAmong(stackNames, prefix) {
  return instanceStacksAmong(stackNames, prefix)
    .filter((name) => name.slice(prefix.length).startsWith('Assistants-'));
}

/**
 * The physical ids of the resources `match` selects, in stack order.
 * `match` is `{ type, logicalId }`: a CloudFormation resource type, and an optional RegExp the
 * logical id must satisfy (every resource of the type when it is absent).
 */
function physicalIdsMatching(resources, match) {
  return (resources || [])
    .filter((r) => r.ResourceType === match.type && (!match.logicalId || match.logicalId.test(r.LogicalResourceId)))
    .map((r) => r.PhysicalResourceId)
    .filter(Boolean);
}

/** Every stack name in the account and region, through an SDK `CloudFormationClient`. */
async function listStackNames(cfn) {
  const { DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');
  const names = [];
  let NextToken;
  do {
    const page = await cfn.send(new DescribeStacksCommand({ NextToken }));
    for (const s of page.Stacks || []) if (s.StackName) names.push(s.StackName);
    NextToken = page.NextToken;
  } while (NextToken);
  return names;
}

/** Every resource of one stack, through an SDK `CloudFormationClient`. Throws when the stack is absent. */
async function listStackResources(cfn, stackName) {
  const { ListStackResourcesCommand } = require('@aws-sdk/client-cloudformation');
  const resources = [];
  let NextToken;
  do {
    const page = await cfn.send(new ListStackResourcesCommand({ StackName: stackName, NextToken }));
    resources.push(...(page.StackResourceSummaries || []));
    NextToken = page.NextToken;
  } while (NextToken);
  return resources;
}

/** The physical ids `match` selects in each of `stacks`, in the order given. */
async function physicalIdsIn(cfn, stacks, match) {
  const out = [];
  for (const stack of stacks) out.push(...physicalIdsMatching(await listStackResources(cfn, stack), match));
  return out;
}

/**
 * `stacks` and every stack nested under them, at any depth. A nested stack is not listed as one of the
 * instance stacks (its generated name carries no instance suffix), so a resource it holds is reached only
 * through its parent, by the nested stack's ARN, which `ListStackResources` accepts as a stack name.
 */
async function withNestedStacks(cfn, stacks) {
  const out = [];
  const visit = async (stack) => {
    out.push(stack);
    for (const id of physicalIdsMatching(await listStackResources(cfn, stack), { type: 'AWS::CloudFormation::Stack' })) await visit(id);
  };
  for (const stack of stacks) await visit(stack);
  return out;
}

module.exports = {
  instanceStacksAmong,
  classificationStacksAmong,
  physicalIdsMatching,
  listStackNames,
  listStackResources,
  physicalIdsIn,
  withNestedStacks,
};
