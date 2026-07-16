import * as cdk from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

/**
 * Standard cost-attribution tags.
 *
 * `project` is the DERIVED deployment identity (e.g. STACK_PREFIX from AE_INSTANCE_NAME),
 * NEVER a hardcoded literal — so the same platform code deployed as different instances
 * self-attributes to its own cost bucket. `codebase` optionally aggregates all instances of
 * a reusable platform for a platform-wide roll-up.
 */
export interface StandardTagsOptions {
  /** Derived deployment identity → the `Project` tag (e.g. STACK_PREFIX → "Acme"). */
  project: string;
  /** dev | staging | prod | Production → the `Environment` tag. */
  environment: string;
  /** Source platform/codebase → the `Codebase` tag (reusable platforms only). */
  codebase?: string;
  /** Deployment instance name → the `Instance` tag. */
  instance?: string;
  /** Defaults to "CDK". */
  managedBy?: string;
}

export const PROJECT_TAG = 'Project';

/**
 * Apply the standard tags ONCE at the app/root scope. Do NOT re-add `Project` per-stack
 * (that override collapses attribution) — add only stack-specific keys like `Component`
 * inside a stack. Pair with {@link collectProjectTagValues} to fail synth on regressions.
 */
export function applyStandardTags(scope: IConstruct, o: StandardTagsOptions): void {
  const tags = cdk.Tags.of(scope);
  tags.add(PROJECT_TAG, o.project);
  if (o.codebase) tags.add('Codebase', o.codebase);
  if (o.instance) tags.add('Instance', o.instance);
  tags.add('ManagedBy', o.managedBy ?? 'CDK');
  tags.add('Environment', o.environment);
}

/**
 * Collect every `Project` tag value present in a synthesized CloudFormation template
 * (handles both `Tags: [{Key,Value}]` arrays and tag-map forms like `UserPoolTags`).
 * The guardrail invariant is: this set must equal `{ <derived project> }` — anything else
 * is a stray per-stack override fragmenting cost attribution. Used by the tagging tests;
 * format-agnostic and reliable (post-synth), unlike a synth-time Aspect whose tag view
 * depends on aspect ordering.
 */
export function collectProjectTagValues(templateJson: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const el of node) {
        if (el && typeof el === 'object') {
          const e = el as Record<string, unknown>;
          if (e.Key === PROJECT_TAG && typeof e.Value === 'string') out.add(e.Value);
        }
        walk(el);
      }
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === PROJECT_TAG && typeof v === 'string') out.add(v);
        walk(v);
      }
    }
  };
  walk(templateJson);
  return out;
}
