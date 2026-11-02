/**
 * An assistant's NAME is a label over a durable identity, not the key it is stored under
 * (DESIGN-SEPARATE-ASSISTANTS section 3.0).
 *
 * These were one string, and that is why an assistant could not be renamed: the word a person reads
 * in the room was also the SSM segment its versions live under, the assignment record's `assistant`,
 * and the analytics dimension. Renaming it moved every key and orphaned the version history, so the
 * write path simply had no rename.
 *
 * The identifier now keys storage and never changes; the display name rides a version like any other
 * behavior, so renaming is an ordinary edit with a rollback.
 */
import * as fs from 'fs';
import * as path from 'path';
import { defaultProfileRegistry, ProfileRegistry } from '../lib/profile-registry';
import { DEFAULT_PROFILES_CONFIG } from '../lib/config/profiles';
import { validateBody } from '../lambda/src/lib/profile-lifecycle';
import { getModelCatalog } from '../lib/config/model-strategy';

const CATALOG = getModelCatalog('us-east-1', '123456789012');

describe('an assistant is renamed without moving its keys', () => {
  it('resolves the version name first, then the configured default, then the identifier', () => {
    const r = defaultProfileRegistry;

    // A version that renamed it wins: this is what makes a rename an ordinary versioned edit.
    expect(r.displayNameFor('analyst', 'Research Desk')).toEqual('Research Desk');
    // No version override: what it was provisioned as.
    expect(r.displayNameFor('analyst')).toEqual('Analyst');
    // A blank override is not a rename - it falls through rather than naming the assistant nothing.
    expect(r.displayNameFor('analyst', '   ')).toEqual('Analyst');
  });

  it('falls back to the IDENTIFIER only when no name was ever given', () => {
    // A deployment that never set one gets the identifier rendered as-is, which is a deployment that
    // has not decided rather than a lookup that failed.
    expect(r_displayNameOfUnnamed()).toEqual('admin-agent');
  });

  it('keeps the identifier out of the display path once a name exists', () => {
    // The point of the split: reading the name never yields the storage key for an assistant that
    // has one. If this ever returns `analyst`, the two fields have collapsed back together.
    for (const c of defaultProfileRegistry.classificationValues()) {
      const id = defaultProfileRegistry.requireProfileFor(c).name;
      const shown = defaultProfileRegistry.displayNameFor(id);
      if (defaultProfileRegistry.profileByName(id)?.displayName) {
        expect(shown).not.toEqual(id);
      }
    }
  });

  it('bounds the display name at the write path, where both readers of it are protected at once', () => {
    // It is shown to people AND set on a Chime identity. Amazon Chime SDK caps an AppInstanceBot name
    // at 100 characters and refuses control characters, so a rename that validated here and was
    // refused there would leave the version active and the bot wearing the old name.
    expect(validateBody({ displayName: 'x'.repeat(101) }, CATALOG).join(' ')).toMatch(/caps at 100/);
    expect(validateBody({ displayName: 'badname' }, CATALOG).join(' ')).toMatch(/control character/);
    expect(validateBody({ displayName: '  ' }, CATALOG).join(' ')).toMatch(/non-empty/);
    // Absent is valid and means "inherit", which is NOT the same as blank.
    expect(validateBody({}, CATALOG).filter((e) => e.includes('displayName'))).toEqual([]);
  });

  it('puts the configured name in the declaration, which is the seed property, so a rename re-runs the seed', () => {
    // MEASURED, not hypothetical (2026-09-19): a name carried in a function's environment and not in a custom
    // resource's PROPERTIES reaches nothing, because CloudFormation re-invokes a custom resource only when its
    // properties change. The seed's one property IS the declaration (ADR-048, amended 2026-10-23), and each
    // declared assistant's display name is in it, read from the profile.
    const src = fs.readFileSync(path.join(__dirname, '../lib/stacks/assistant-profile-stack.ts'), 'utf8');
    expect(src).toContain('displayName: defaultProfileRegistry.displayNameFor(assistantId) || assistantId,');
    const seed = fs.readFileSync(path.join(__dirname, '../lib/constructs/declared-assistants-seed.ts'), 'utf8');
    expect(seed).toContain('properties: { declaration: JSON.stringify(declaration) }');
  });
});

/** A profile that was never given a display name: the admin assistant's entry with its name removed. */
function r_displayNameOfUnnamed(): string {
  const adminPlane = defaultProfileRegistry.adminPlaneValues()[0];
  const id = defaultProfileRegistry.requireProfileFor(adminPlane).name;
  const unnamed = new ProfileRegistry({
    ...DEFAULT_PROFILES_CONFIG,
    profiles: DEFAULT_PROFILES_CONFIG.profiles.map((p) => (p.name === id ? { ...p, displayName: undefined } : p)),
  });
  return unnamed.displayNameFor(id);
}
