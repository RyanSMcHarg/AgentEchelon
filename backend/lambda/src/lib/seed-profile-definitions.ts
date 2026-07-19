/**
 * Seed the ACTIVE profile version (SPEC-PORTABLE-VERSIONED-PROFILES P0 §3, §8).
 *
 * Writes each shipped profile's compiled default as version 1 of `/{root}/assistant/{name}/definition`
 * and labels that version `active`. The seed is byte-identical to the deploy default, so activating it
 * changes nothing (the P0 "behavior diff empty on the seed" bar) — it just makes the active version
 * EXPLICIT so the P1 lifecycle (edit/activate/rollback) has a v1 to build on. Idempotent: re-running
 * overwrites with the same content (SSM stamps a new version number; the label follows to it).
 *
 * WRITE PATH, not the runtime path. This is invoked by a seed step (the demo seeder today; a CDK
 * custom resource / the manage-profiles management API in P1) — NEVER by the async-processor role,
 * which is read-only on this namespace (§7). Kept in its own module so the read-only runtime resolver
 * (`active-profile.ts`) never imports a write command.
 */
import { SSMClient, PutParameterCommand, LabelParameterVersionCommand } from '@aws-sdk/client-ssm';
import { defaultProfileRegistry } from '../../../lib/profile-registry.js';
import { serializeSeedDefinition, definitionParamName } from './active-profile.js';

export interface SeedResult {
  profileName: string;
  version: number;
  labeled: boolean;
}

/** Seed + `active`-label one profile's definition. Returns null when the name is not a shipped profile. */
export async function seedActiveProfileDefinition(
  ssm: SSMClient,
  ssmRoot: string,
  profileName: string,
): Promise<SeedResult | null> {
  const body = serializeSeedDefinition(profileName);
  if (body === null) return null;
  const name = definitionParamName(ssmRoot, profileName);
  const put = await ssm.send(
    new PutParameterCommand({ Name: name, Type: 'String', Value: body, Overwrite: true, Tier: 'Standard' }),
  );
  const version = put.Version ?? 1;
  // Move the `active` label onto the just-written version (LabelParameterVersion moves an existing label).
  await ssm.send(new LabelParameterVersionCommand({ Name: name, ParameterVersion: version, Labels: ['active'] }));
  return { profileName, version, labeled: true };
}

/** Seed every shipped profile. Used by the seeder to make each classification's active version explicit. */
export async function seedAllProfileDefinitions(ssm: SSMClient, ssmRoot: string): Promise<SeedResult[]> {
  const names = new Set(defaultProfileRegistry.classificationValues().map((c) => defaultProfileRegistry.profileFor(c).name));
  const out: SeedResult[] = [];
  for (const name of names) {
    const r = await seedActiveProfileDefinition(ssm, ssmRoot, name);
    if (r) out.push(r);
  }
  return out;
}
