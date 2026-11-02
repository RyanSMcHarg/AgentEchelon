/**
 * EVERY FUNCTION THE APP BUILDS READS THE DEPLOYMENT'S SET AT RUNTIME, AND NO RUNTIME PRINCIPAL WRITES IT.
 *
 * A handler resolves classifications, clearance and profiles through `defaultProfileRegistry`
 * (`lib/profile-registry.ts`), which `loadProfileRegistry` reads from the rows the deployment's stacks publish
 * under one SSM path (`registryPathOf`, `lib/config/profiles.ts`): each `Assistants-<classification>` stack its
 * own classification's, `Identity` the admin plane's. This aspect:
 *
 *   - names that path to every Lambda function (`PROFILE_REGISTRY_PATH_ENV`) and attaches the read to its role
 *     (`ssm:GetParametersByPath` on the path itself, which is what that call authorizes against, and
 *     `ssm:GetParameter` on its rows), adding the same read to a permissions boundary the role carries, so the
 *     boundary does not refuse it;
 *   - names the rows' S3 copy (`PROFILE_REGISTRY_S3_ENV`, `s3://<registry bucket>/registry/classification/`) to
 *     every function attached to a VPC, and attaches that read to its role and boundary (`s3:ListBucket` on the
 *     prefix, `s3:GetObject` on its objects). The analytics VPC is NAT-free and reaches S3 through its gateway
 *     endpoint and SSM not at all, so such a function reads the copy (`loadProfileRegistry` prefers it);
 *   - attaches to every role the app builds a denial of every write on the path (`ssm:PutParameter`,
 *     `ssm:DeleteParameter` and their kin), so only the deploy that publishes a row changes it;
 *   - and the same denial on the call-time routing keys under `${SSM_ROOT}/assistant/<name>/` that end in `-arn`
 *     (`router-arn`, `vend-arn`, `exchange-role-arn`, `conversation-creator-arn`, `task-service-arn`,
 *     `classifier-replay-arn` and their kin), which a handler reads to decide which function or role to call.
 *     CloudFormation publishes each with the stack that owns it; a role allowed to write `assistant/*` for
 *     another reason (manage-profiles' definitions) would otherwise redirect every call that reads one.
 *
 * Both are one managed policy per stack, attached to each role, so no role's inline policy grows
 * (`enforceInlinePolicyBudget`). THE PATH IS THE SAME FOR EVERY SET, so declaring, adding or removing a
 * classification changes no function's environment and no role's policy. IAM never reads the registry: every
 * grant names a classification by its tag.
 *
 * ON EVERY FUNCTION RATHER THAN A LIST OF THE ONES THAT READ IT, because which handlers import the registry is a
 * property of their import graph, and a list would be a second copy of it that drifts. The rows hold no secret.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IConstruct } from 'constructs';
import {
  PROFILE_REGISTRY_PATH_ENV, PROFILE_REGISTRY_S3_ENV, registryBucketNameOf, registryPathOf, registryS3LocationOf, REGISTRY_S3_PREFIX,
} from '../config/profiles';
import { boundaryOf } from './permissions-boundary';

/** The registry's write actions, every one denied to every role the app builds. */
export const REGISTRY_WRITE_ACTIONS = [
  'ssm:PutParameter',
  'ssm:DeleteParameter',
  'ssm:DeleteParameters',
  'ssm:LabelParameterVersion',
  'ssm:UnlabelParameterVersion',
];

const arnIn = (scope: IConstruct, p: string): string => {
  const stack = cdk.Stack.of(scope);
  return `arn:aws:ssm:${stack.region}:${stack.account}:parameter${p}`;
};

/** The read a function's role holds on the registry, as statements for `scope`'s account and region. */
export function registryReadStatements(scope: IConstruct, path: string): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({ sid: 'ReadTheProfileRegistry', actions: ['ssm:GetParametersByPath'], resources: [arnIn(scope, path)] }),
    new iam.PolicyStatement({ sid: 'ReadTheProfileRegistryRows', actions: ['ssm:GetParameter', 'ssm:GetParameters'], resources: [arnIn(scope, `${path}/*`)] }),
  ];
}

/**
 * Whether `fn` runs in a VPC: built with one (`vpc`), or given its subnets on the underlying resource, as a function
 * placed in the archive's VPC by its published subnets is (`ClassificationArchiveFunctions`).
 */
function attachedToAVpc(fn: lambda.Function): boolean {
  return fn.isBoundToVpc || !!(fn.node.defaultChild as lambda.CfnFunction | undefined)?.vpcConfig;
}

/** The registry bucket's name in `scope`'s account and region. */
function registryBucketIn(scope: IConstruct, resPrefix: string): string {
  const stack = cdk.Stack.of(scope);
  return registryBucketNameOf(resPrefix, stack.account, stack.region);
}

/** The read a VPC-attached function's role holds on the rows' S3 copy, in `bucket`. */
export function registryS3ReadStatements(bucket: string): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: 'ListTheProfileRegistryCopy',
      actions: ['s3:ListBucket'],
      resources: [`arn:aws:s3:::${bucket}`],
      conditions: { StringLike: { 's3:prefix': [`${REGISTRY_S3_PREFIX}/*`] } },
    }),
    new iam.PolicyStatement({ sid: 'ReadTheProfileRegistryCopy', actions: ['s3:GetObject'], resources: [`arn:aws:s3:::${bucket}/${REGISTRY_S3_PREFIX}/*`] }),
  ];
}

/** The call-time routing keys: every parameter under an assistant's key that ends in `-arn`. */
export function routingKeyPattern(ssmRoot: string): string {
  return `${ssmRoot}/assistant/*/*-arn`;
}

/** The denial every role the app builds carries: no write on a call-time routing key. */
export function routingKeyWriteDenial(scope: IConstruct, ssmRoot: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'NeverWriteACallTimeRoutingKey',
    effect: iam.Effect.DENY,
    actions: REGISTRY_WRITE_ACTIONS,
    resources: [arnIn(scope, routingKeyPattern(ssmRoot))],
  });
}

/** The denial every role the app builds carries: no write on the registry's path or below it. */
export function registryWriteDenial(scope: IConstruct, path: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'NeverWriteTheProfileRegistry',
    effect: iam.Effect.DENY,
    actions: REGISTRY_WRITE_ACTIONS,
    resources: [arnIn(scope, path), arnIn(scope, `${path}/*`)],
  });
}

/** The construct ids of the two managed policies, one of each per stack. */
export const REGISTRY_READ_POLICY_ID = 'ProfileRegistryRead';
export const REGISTRY_WRITE_DENIAL_POLICY_ID = 'ProfileRegistryWriteDenial';
/** The construct id of the S3 copy's read policy, one per stack that has a VPC-attached function. */
export const REGISTRY_S3_READ_POLICY_ID = 'ProfileRegistryCopyRead';

export class ProfileRegistryReaders implements cdk.IAspect {
  private readonly path: string;
  private readonly ssmRoot: string;
  private readonly resPrefix: string;
  private readonly reads = new Map<cdk.Stack, iam.ManagedPolicy>();
  private readonly denials = new Map<cdk.Stack, iam.ManagedPolicy>();
  private readonly copyReads = new Map<cdk.Stack, iam.ManagedPolicy>();
  private readonly boundaries = new WeakSet<iam.ManagedPolicy>();
  private readonly copyBoundaries = new WeakSet<iam.ManagedPolicy>();
  private readonly readers = new WeakSet<iam.Role>();
  private readonly copyReaders = new WeakSet<iam.Role>();

  /**
   * `ssmRoot`: the instance's SSM root (`SSM_ROOT`), below which the rows are published. `resPrefix`: the instance's
   * resource prefix (`RES_PREFIX`), which names the registry bucket that holds their S3 copy.
   */
  constructor(ssmRoot: string, resPrefix: string) {
    this.path = registryPathOf(ssmRoot);
    this.ssmRoot = ssmRoot;
    this.resPrefix = resPrefix;
  }

  private policyIn(stack: cdk.Stack, kind: 'read' | 'deny'): iam.ManagedPolicy {
    const cache = kind === 'read' ? this.reads : this.denials;
    let policy = cache.get(stack);
    if (!policy) {
      policy = kind === 'read'
        ? new iam.ManagedPolicy(stack, REGISTRY_READ_POLICY_ID, {
          description: 'Reads the profile registry rows every handler loads at runtime',
          statements: registryReadStatements(stack, this.path),
        })
        : new iam.ManagedPolicy(stack, REGISTRY_WRITE_DENIAL_POLICY_ID, {
          description: 'Denies every write on the profile registry rows and the call-time routing keys, which only a deploy publishes',
          statements: [registryWriteDenial(stack, this.path), routingKeyWriteDenial(stack, this.ssmRoot)],
        });
      cache.set(stack, policy);
    }
    return policy;
  }

  private copyReadIn(stack: cdk.Stack): iam.ManagedPolicy {
    let policy = this.copyReads.get(stack);
    if (!policy) {
      policy = new iam.ManagedPolicy(stack, REGISTRY_S3_READ_POLICY_ID, {
        description: 'Reads the S3 copy of the profile registry rows, which a VPC-attached handler loads at runtime',
        statements: registryS3ReadStatements(registryBucketIn(stack, this.resPrefix)),
      });
      this.copyReads.set(stack, policy);
    }
    return policy;
  }

  visit(node: IConstruct): void {
    if (node instanceof lambda.Function) {
      node.addEnvironment(PROFILE_REGISTRY_PATH_ENV, this.path);
      const role = node.role;
      if (role instanceof iam.Role && !this.readers.has(role)) {
        this.readers.add(role);
        role.addManagedPolicy(this.policyIn(cdk.Stack.of(role), 'read'));
        const boundary = boundaryOf(role);
        if (boundary instanceof iam.ManagedPolicy && !this.boundaries.has(boundary)) {
          this.boundaries.add(boundary);
          boundary.addStatements(...registryReadStatements(boundary, this.path));
        }
      }
      if (attachedToAVpc(node)) {
        node.addEnvironment(PROFILE_REGISTRY_S3_ENV, registryS3LocationOf(registryBucketIn(node, this.resPrefix)));
        if (role instanceof iam.Role && !this.copyReaders.has(role)) {
          this.copyReaders.add(role);
          role.addManagedPolicy(this.copyReadIn(cdk.Stack.of(role)));
          const boundary = boundaryOf(role);
          if (boundary instanceof iam.ManagedPolicy && !this.copyBoundaries.has(boundary)) {
            this.copyBoundaries.add(boundary);
            boundary.addStatements(...registryS3ReadStatements(registryBucketIn(boundary, this.resPrefix)));
          }
        }
      }
    }
    if (node instanceof iam.Role) node.addManagedPolicy(this.policyIn(cdk.Stack.of(node), 'deny'));
  }
}
