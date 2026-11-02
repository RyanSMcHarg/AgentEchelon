/**
 * THE TRUSTED-ISSUER REGISTRY, AS THE STACKS WIRE IT.
 *
 * `lib/config/issuers.ts` declares and validates the registry; this is where a stack reads it. Every
 * function that reads a caller or keys a person is handed the registry's runtime form as
 * `TRUSTED_ISSUERS` (`grantIssuerRegistry`, called directly by each handler behind `PersonApi` and by
 * `grantDirectoryRead`), and the edge authorizer verifies every token against the same registry
 * (`lib/constructs/edge-authorizer.ts`). So adding an issuer is one registry entry, and no stack reads a
 * pool id of its own.
 *
 * Validated in full at synth by `bin/backend.ts`, which also checks it against the declared
 * capabilities (L18); here it is read again, without the capability check, by each stack that wires it.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import { compactIssuers, issuerRegistry, runtimeIssuers, type IssuerRegistry } from '../config/issuers';
import { defaultProfileRegistry as profiles } from '../profile-registry';
import { trustedIssuerEntries } from '../config/test-issuers';
import { environmentOf } from '../config/environment';
import { INSTANCE_NAME } from '../stacks/agent-classification-common';

/**
 * The deployment's registry, from the `issuers` context (absent: its own pool alone). A test-fixture
 * entry that does not name its pool yet is left out, as `bin/backend.ts` leaves it out
 * (`lib/config/test-issuers.ts`).
 */
export function issuersOf(scope: Construct): IssuerRegistry {
  return issuerRegistry(trustedIssuerEntries(scope.node.tryGetContext('issuers'), scope.node.tryGetContext('environment')), profiles, { environment: environmentOf(scope) });
}

/**
 * Hand a function the registry. `selfPoolId` is the deployment's own pool, or `''` for a deployment with
 * none (L15): only an entry on `pool: 'self'` reads it.
 */
export function grantIssuerRegistry(fn: lambda.Function, selfPoolId: string): void {
  const stack = cdk.Stack.of(fn);
  fn.addEnvironment('TRUSTED_ISSUERS', trustedIssuersJson(stack, selfPoolId));
}

/** The registry's travelling form (`compactIssuers`), for a function's `TRUSTED_ISSUERS`. */
export function trustedIssuersJson(stack: cdk.Stack, selfPoolId: string): string {
  return stack.toJsonString(compactIssuers(runtimeIssuers(issuersOf(stack), selfPoolId, stack.region, INSTANCE_NAME)));
}

/**
 * The person-facing routes a one-conversation person calls, as `METHOD /path`. Nothing else admits them:
 * the edge authorizer allows a one-conversation issuer's token on these alone (`EDGE_ROUTES`), and each
 * handler refuses them again unless it admits them (`callerPerson`, lambda/src/lib/auth.ts), so the path
 * keeps two layers (tenet D3).
 *
 *  - the credential exchange, which vends them their one conversation;
 *  - conversation creation, which opens or re-opens it.
 */
export const ONE_CHANNEL_ROUTES: readonly string[] = ['POST /exchange-credentials', 'POST /create-conversation'];

/**
 * The person-facing routes a guest (the guest issuer's token) calls with that token: the credential
 * exchange, which vends their one conversation, and path B's registration (`guest-upgrade.ts`), which
 * records the visitor's registration for the conversation the token names. Guest start and guest refresh
 * take no token (`auth: 'none'`, with their own abuse controls), so they are not on this list. The edge
 * allows a guest token here alone, and every handler but these two resolves nobody for a guest
 * (`callerPerson`, lambda/src/lib/auth.ts): two layers before IAM.
 */
export const GUEST_ROUTES: readonly string[] = ['POST /exchange-credentials', 'POST /guest/register'];
