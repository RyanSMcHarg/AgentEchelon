/**
 * THE DEPLOYMENT ENVIRONMENT: one value, read in one place.
 *
 * `environment` in `deploy.config.json` is `dev` or `production`. It decides what a teardown keeps: in
 * `production` every table, the message stream and the Aurora cluster are retained and the cluster is
 * deletion-protected; in `dev` they are destroyed with their stack, so a teardown leaves nothing that
 * blocks the next fresh deploy.
 *
 * Every stack reads it through `isProduction` or `dataRemovalPolicy`, never from the context itself. A
 * value this module does not know is refused at synth: a production deployment spelled `prod` would
 * otherwise read as not production and be built with every table set to be destroyed.
 */
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export const DEPLOYMENT_ENVIRONMENTS = ['dev', 'production'] as const;
export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

/** The `environment` context value, refused when it is not one this module knows. Absent is `dev`. */
export function parseEnvironment(raw: unknown): DeploymentEnvironment {
  if (raw === undefined || raw === null || raw === '') return 'dev';
  const value = String(raw).trim();
  if ((DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(value)) return value as DeploymentEnvironment;
  throw new Error(
    `environment "${value}" is not a deployment environment: set "dev" or "production". `
    + 'Only "production" retains tables, the message stream and the Aurora cluster at teardown.',
  );
}

/** The deployment environment a construct is synthesized in. */
export function environmentOf(scope: Construct): DeploymentEnvironment {
  return parseEnvironment(scope.node.tryGetContext('environment'));
}

export function isProduction(scope: Construct): boolean {
  return environmentOf(scope) === 'production';
}

/** RETAIN in production, DESTROY otherwise: the policy every table and the message stream take. */
export function dataRemovalPolicy(scope: Construct): cdk.RemovalPolicy {
  return isProduction(scope) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
}
