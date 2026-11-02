/**
 * THIS DEPLOYMENT'S STACKS, AND THE RESOURCES IN THEM, FOR EVERY E2E SPEC.
 *
 * The stack names and the instance name come from backend/scripts/lib/stack-lookup.cjs, the one
 * resolver every operator script uses, so a spec and the script that provisioned its users never
 * disagree about which instance they are pointed at. Nothing here reads `AE_STACK_PREFIX` itself.
 *
 * ── PHYSICAL NAMES ARE ASKED FOR, NOT BUILT ─────────────────────────────────────────────────────
 *
 * CloudFormation cuts a generated name to fit, so no name prefix selects the same resources on every
 * deployment (backend/scripts/lib/stack-resources.cjs says how). A resource is read from its stack by
 * type and logical id instead. The selection is the one the operator scripts use; only the transport
 * differs (the AWS CLI here, the SDK there).
 */
import { awsv } from './aws';

const awsJson = (args: string[]): any => awsv(args, { timeoutMs: 120_000, maxBufferMb: 50, quiet: true });

/** One row of `list-stack-resources`. */
export interface StackResource {
  LogicalResourceId: string;
  PhysicalResourceId: string;
  ResourceType: string;
}

/** Which resource to find: its CloudFormation type, and a pattern on its logical id (any, when absent). */
export interface ResourceMatch {
  type: string;
  logicalId?: RegExp;
}

interface StackLookup {
  resolveStackPrefix(env?: NodeJS.ProcessEnv): string;
  resolveInstanceName(env?: NodeJS.ProcessEnv): string;
}

interface StackResources {
  instanceStacksAmong(stackNames: string[], prefix: string): string[];
  classificationStacksAmong(stackNames: string[], prefix: string): string[];
  physicalIdsMatching(resources: StackResource[], match: ResourceMatch): string[];
}

// CommonJS, shared with the operator scripts. Playwright loads these specs as CommonJS, so `require`
// resolves them relative to this file.
const lookup = require('../../../backend/scripts/lib/stack-lookup.cjs') as StackLookup;
const selection = require('../../../backend/scripts/lib/stack-resources.cjs') as StackResources;

/** This deployment's stack-name prefix: `AgentEchelon` on the default instance. Throws when two variables disagree. */
export const STACK_PREFIX = lookup.resolveStackPrefix(process.env);

/** This deployment's instance name: the default instance's is the SSM root without its slash. */
export const INSTANCE = lookup.resolveInstanceName(process.env);

/** This deployment's SSM root, under which every parameter it publishes lives. */
export const SSM_ROOT = `/${INSTANCE}`;

/** A stack of this deployment by the name `bin/backend.ts` gives it after the prefix, e.g. `Identity`. */
export function stackName(name: string, prefix: string = STACK_PREFIX): string {
  return `${prefix}${name}`;
}

/** The classification stacks (`<prefix>Assistants-<classification>`) among `stackNames`, and no other instance's. */
export function classificationStacksAmong(stackNames: string[], prefix: string = STACK_PREFIX): string[] {
  return selection.classificationStacksAmong(stackNames, prefix);
}

/** The physical ids of the resources in `resources` that `match` selects, in stack order. */
export function physicalIdsMatching(resources: StackResource[], match: ResourceMatch): string[] {
  return selection.physicalIdsMatching(resources, match);
}

function allStackNames(): string[] {
  return awsJson(['cloudformation', 'describe-stacks', '--query', 'Stacks[].StackName']) || [];
}

/** Every deployed stack of this instance. Throws when the lookup cannot be made. */
export function instanceStacks(): string[] {
  return selection.instanceStacksAmong(allStackNames(), STACK_PREFIX);
}

/** The deployed classification stacks of this instance. Throws when the lookup cannot be made. */
export function classificationStacks(): string[] {
  return classificationStacksAmong(allStackNames());
}

/**
 * The resources `match` selects in each of `stacks`, in the order given. Throws when a lookup fails.
 * `list-stack-resources`, which the CLI pages through, because `describe-stack-resources` stops at
 * 100 resources.
 */
export function resourcesIn(stacks: string[], match: ResourceMatch): StackResource[] {
  return stacks.flatMap((stack) => {
    const resources: StackResource[] = awsJson([
      'cloudformation', 'list-stack-resources', '--stack-name', stack,
      '--query', 'StackResourceSummaries[].{LogicalResourceId:LogicalResourceId,PhysicalResourceId:PhysicalResourceId,ResourceType:ResourceType}',
    ]) || [];
    return resources.filter((r) => physicalIdsMatching([r], match).length > 0);
  });
}

/** The physical ids `match` selects in each of `stacks`, in the order given. Throws when a lookup fails. */
export function physicalIdsIn(stacks: string[], match: ResourceMatch): string[] {
  return resourcesIn(stacks, match).map((r) => r.PhysicalResourceId);
}

/** The physical ids `match` selects across every classification stack of this instance. */
export function physicalIdsInClassificationStacks(match: ResourceMatch): string[] {
  return physicalIdsIn(classificationStacks(), match);
}

/** Each classification's router handler (`AgentHandler`): one function per classification stack. */
export const AGENT_HANDLER: ResourceMatch = { type: 'AWS::Lambda::Function', logicalId: /^AgentHandler/ };

/** Every Lambda function / IAM role of a stack. */
export const ANY_FUNCTION: ResourceMatch = { type: 'AWS::Lambda::Function' };
export const ANY_ROLE: ResourceMatch = { type: 'AWS::IAM::Role' };
