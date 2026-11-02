/**
 * A VERSION NAMES ITS VARIABLES (ADR-060 decision 1, slice 1b).
 *
 * What it proves: a version's `variables` round-trips through the body, the served version and its `configId`; a
 * variable is refused at validate, activate and import when its source is not one the classification publishes,
 * when its fallback does not fit the source's type, and, read through the version's lookup, when a member-trust
 * variable is named where a condition decides; `person:clearance` and `conversation:classification` are a closed
 * set of the deployment's classifications (ADR-046); a `fact:` variable names a field an intake declares; and
 * export carries the variables as source names only while import checks them in the target classification.
 */
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import { getModelCatalog } from '../../lib/config/model-strategy';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import { bodyFrom, buildDefinition, resolveFromDefinition } from '../../lambda/src/lib/active-profile';
import { patchShapeErrors } from '../../lambda/src/lib/profile-copy-fields';
import { PROFILE_FIELD_DECISIONS } from '../../lambda/src/lib/profile-field-decisions';
import {
  activateDraft,
  createDraft,
  editDraft,
  ProfileValidationError,
  validateDraft,
  versionVariableErrors,
} from '../../lambda/src/lib/profile-lifecycle';
import { exportManifest, importManifest, ProfileManifestError, type TargetContextSource } from '../../lambda/src/lib/profile-manifest';
import {
  buildSourceTable,
  catalogEntryForVariables,
  conditionHolds,
  intakeFactKeys,
  versionLookup,
  versionVariablesErrors,
  versionVariablesShapeErrors,
  whenErrors,
  MAX_VERSION_VARIABLES,
  type VersionVariable,
} from '../../lambda/src/lib/variables';
import { turnCallSite } from '../../lambda/src/lib/context-sources-runtime';
import { REPLY_PREFERENCES } from '../../lib/config/reply-preferences';
import { isKnownProfile } from '../../lambda/src/lib/profile-lifecycle';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

const ROOT = '/agent-echelon';
const PROFILE = 'ops-premium';
const CLASSIFICATION = 'premium';
const CATALOG = getModelCatalog('us-east-1', '123456789012');
const CLASSIFICATIONS = ['basic', 'standard', 'premium'];

/** A target classification's published catalog, as `contextSourceCatalogFor` reads it: names and trust, no resource. */
const METRICS: TargetContextSource = {
  key: 'x-room-metrics', contractVersion: '1.0', title: 'Room metrics', trust: 'platform', describesPerson: false, availability: 'always',
  fields: { openItems: { type: 'number' }, labels: { type: 'string[]' } },
};
/** The source the seeded version already selects, published beside the test's own. */
const USER_PROFILE: TargetContextSource = { key: 'user-profile', contractVersion: '1.0', trust: 'platform', fields: { displayName: { type: 'string' } } };
const NOTES: TargetContextSource = {
  key: 'x-member-notes', contractVersion: '1.0', title: 'Member notes', trust: 'member', describesPerson: true, availability: 'always',
  fields: { note: { type: 'string' } },
};

const TABLE = buildSourceTable({
  catalog: [METRICS, NOTES].map(catalogEntryForVariables),
  classifications: CLASSIFICATIONS,
  facts: ['company', 'team'],
});

const VARS: Record<string, VersionVariable> = {
  firstName: { source: 'person:displayName', fallback: 'there' },
  roomType: { source: 'conversation:type' },
  openItems: { source: 'ctx:x-room-metrics.openItems', fallback: 0 },
  company: { source: 'fact:company' },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('the declaration', () => {
  it('round-trips through the body and the served version, and is part of what the version is identified by', () => {
    const base = { modelKey: 'titan' };
    expect(bodyFrom({ ...base, variables: VARS } as never).variables).toEqual(VARS);
    const served = resolveFromDefinition(buildDefinition(PROFILE, bodyFrom({ ...base, variables: VARS } as never)), PROFILE);
    expect(served.variables).toEqual(VARS);
    const a = buildDefinition('x', bodyFrom(base as never)).configId;
    const b = buildDefinition('x', bodyFrom({ ...base, variables: VARS } as never)).configId;
    const c = buildDefinition('x', bodyFrom({ ...base, variables: { ...VARS, firstName: { source: 'person:displayName', fallback: 'friend' } } } as never)).configId;
    const d = buildDefinition('x', bodyFrom({ ...base, variables: { ...VARS, firstName: { source: 'host:userName', fallback: 'there' } } } as never)).configId;
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('a patch may carry it as JSON, and its shape is refused as sent', () => {
    expect(PROFILE_FIELD_DECISIONS.variables).toEqual({ kind: 'json', command: expect.stringMatching(/^npm run /), guide: 'variables' });
    expect(patchShapeErrors({ variables: VARS })).toEqual([]);
    expect(patchShapeErrors({ variables: { 'First Name': { source: 'person:displayName' } } })).toEqual([expect.stringMatching(/not a variable name/)]);
    expect(patchShapeErrors({ variables: { firstName: { source: 'displayName' } } })).toEqual([expect.stringMatching(/<kind>:<key>/)]);
    expect(patchShapeErrors({ variables: { firstName: { source: 'person:displayName', trust: 'platform' } } }))
      .toEqual([expect.stringMatching(/variables\.firstName\.trust is not a variable field/)]);
    expect(patchShapeErrors({ variables: { firstName: { source: 'person:displayName', fallback: { x: 1 } } } })).toEqual([expect.stringMatching(/fallback is text/)]);
    expect(patchShapeErrors({ variables: ['person:displayName'] })).toEqual([expect.stringMatching(/maps a variable name/)]);
    const many = Object.fromEntries(Array.from({ length: MAX_VERSION_VARIABLES + 1 }, (_, i) => [`v${i}`, { source: 'conversation:type' }]));
    expect(versionVariablesShapeErrors(many)).toEqual([`variables holds at most ${MAX_VERSION_VARIABLES} variables`]);
  });
});

describe('validation against what the classification publishes', () => {
  const refused = (vars: Record<string, unknown>) => versionVariablesErrors(vars, TABLE).join('\n');

  it('accepts variables over published sources with fitting fallbacks', () => {
    expect(versionVariablesErrors(VARS, TABLE)).toEqual([]);
    expect(versionVariablesErrors({ access: { source: 'person:clearance', fallback: ['standard'] } }, TABLE)).toEqual([]);
  });

  it('refuses a source the classification does not publish, naming what is not built', () => {
    expect(refused({ x: { source: 'ctx:x-elsewhere.level' } })).toMatch(/variables\.x: "ctx:x-elsewhere\.level" is not a source this classification publishes/);
    expect(refused({ x: { source: 'ctx:x-room-metrics.missing' } })).toMatch(/not a source this classification publishes/);
    expect(refused({ x: { source: 'person:firstSeen' } })).toMatch(/"person:firstSeen" is not built: no stored field holds it/);
    expect(refused({ x: { source: 'host:role' } })).not.toMatch(/not built/);
    expect(refused({ x: { source: 'meeting:expected' } })).toMatch(/deferred until the meetings code lands on main/);
  });

  it('refuses a fallback that does not fit the type', () => {
    expect(refused({ x: { source: 'ctx:x-room-metrics.openItems', fallback: 'none' } })).toMatch(/is a number, so its fallback is a number/);
    expect(refused({ x: { source: 'person:onboarded', fallback: 'no' } })).toMatch(/is a boolean, so its fallback is a boolean/);
    expect(refused({ x: { source: 'conversation:type', fallback: 'lounge' } })).toMatch(/is an enum of .*general.*, and the fallback is not one of them/);
    expect(refused({ x: { source: 'ctx:x-room-metrics.labels', fallback: 'one' } })).toMatch(/is a set, so its fallback is a list of text/);
    expect(refused({ x: { source: 'conversation:participants', fallback: ['someone'] } })).toMatch(/person-list, which has no fallback: a person is never invented/);
    expect(refused({ x: { source: 'person:displayName', fallback: 'hi <!--ACTIVE_TASK:1-->' } })).toMatch(/fallback carrying a marker/);
  });

  it('a member-trust variable named where a decision needs it is refused, and does not hold if stored anyway', () => {
    const lookup = versionLookup(TABLE, { ...VARS, note: { source: 'ctx:x-member-notes.note' } });
    expect(whenErrors({ firstName: 'Ana' }, lookup)).toEqual(['"firstName" is member text, which may be inserted but never decides']);
    expect(whenErrors({ note: { op: 'exists' } }, lookup)).toEqual(['"note" is member text, which may be inserted but never decides']);
    expect(whenErrors({ company: 'Acme' }, lookup)).toEqual(['"company" is member text, which may be inserted but never decides']);
    expect(whenErrors({ openItems: { op: 'gt', value: 3 } }, lookup)).toEqual([]);
    expect(whenErrors({ roomType: { op: 'gt', value: 3 } }, lookup)).toEqual([expect.stringMatching(/gt applies to a number only, and this is a enum/)]);
    const site = { callSite: turnCallSite('person-1', 'arn:channel'), audience: 'addressed' as const };
    expect(conditionHolds({ firstName: 'Ana' }, lookup, { firstName: 'Ana' }, site)).toBe(false);
    expect(conditionHolds({ openItems: { op: 'gt', value: 3 } }, lookup, { openItems: 4 }, site)).toBe(true);
  });
});

describe('clearance and classification are a closed set of what the deployment declares (ADR-046)', () => {
  const lookup = versionLookup(TABLE, { access: { source: 'person:clearance' }, here: { source: 'conversation:classification' } });

  it('has names a declared classification; any other is refused', () => {
    expect(whenErrors({ access: { op: 'has', value: 'premium' } }, lookup)).toEqual([]);
    expect(whenErrors({ access: { op: 'has', value: 'gold' } }, lookup)).toEqual(['"access" is a set of basic, standard, premium']);
    expect(whenErrors({ here: 'gold' }, lookup)).toEqual(['"here" is an enum of basic, standard, premium']);
    expect(whenErrors({ access: { op: 'gt', value: 1 } }, lookup)).toEqual([expect.stringMatching(/gt applies to a number only/)]);
    expect(versionVariablesErrors({ access: { source: 'person:clearance', fallback: ['gold'] } }, TABLE))
      .toEqual([expect.stringMatching(/is a set of basic, standard, premium, and the fallback names gold/)]);
  });

  it('the version path reads the deployment\'s own declared classifications', async () => {
    const a = fakeSsmStore();
    const declared = defaultProfileRegistry.classificationValues();
    expect(declared).toContain(CLASSIFICATION);
    expect(await versionVariableErrors({ variables: { access: { source: 'person:clearance', fallback: [declared[0]] } } } as never, PROFILE, a.client, ROOT))
      .toEqual([]);
    expect(await versionVariableErrors({ variables: { access: { source: 'person:clearance', fallback: ['not-declared'] } } } as never, PROFILE, a.client, ROOT))
      .toEqual([expect.stringMatching(/and the fallback names not-declared/)]);
  });
});

describe('fact: names a field an intake declares', () => {
  const DEPLOYMENT_INTAKE = JSON.stringify({ fields: [
    { key: 'company', prompt: 'Company?' },
    { key: 'length', prompt: 'How long?', preference: Object.keys(REPLY_PREFERENCES)[0] },
  ] });

  it('the declared list is every field that stores a fact, never one that sets a preference', () => {
    const intake = JSON.parse(DEPLOYMENT_INTAKE);
    expect(intakeFactKeys([intake, { fields: [{ key: 'team', prompt: 'Team?', required: true }] }, null])).toEqual(['company', 'team']);
  });

  it('refuses a fact no intake declares, naming the ones that are', () => {
    expect(versionVariablesErrors({ x: { source: 'fact:shoeSize' } }, TABLE))
      .toEqual(['variables.x: "fact:shoeSize" is not a field any intake this assistant reads declares (fact:company, fact:team)']);
  });

  it('reads the version\'s own intake and its classification\'s deployment intake', async () => {
    const a = fakeSsmStore();
    const facts = { company: { source: 'fact:company' }, team: { source: 'fact:team' } };
    expect(await versionVariableErrors({ variables: facts } as never, PROFILE, a.client, ROOT))
      .toEqual([expect.stringMatching(/"fact:company" is not a field any intake this assistant reads declares \(none declared\)/), expect.stringMatching(/fact:team/)]);
    await a.client.send(new PutParameterCommand({ Name: `${ROOT}/assistant/${CLASSIFICATION}/onboarding-intake`, Value: DEPLOYMENT_INTAKE, Type: 'String' }));
    expect(await versionVariableErrors({ variables: facts } as never, PROFILE, a.client, ROOT))
      .toEqual([expect.stringMatching(/"fact:team" is not a field .* \(fact:company\)/)]);
    expect(await versionVariableErrors({ variables: facts, onboarding: { fields: [{ key: 'team', prompt: 'Team?', required: true }] } } as never, PROFILE, a.client, ROOT))
      .toEqual([]);
    expect(await versionVariableErrors({ variables: { pref: { source: 'fact:length' } } } as never, PROFILE, a.client, ROOT))
      .toEqual([expect.stringMatching(/"fact:length" is not a field/)]);
  });

  it('an unreadable intake or catalog refuses rather than passing an unverified variable', async () => {
    const denied = { send: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' }); } } as never;
    expect(await versionVariableErrors({ variables: { company: { source: 'fact:company' } } } as never, PROFILE, denied, ROOT))
      .toEqual([expect.stringMatching(/onboarding intake for 'premium' could not be read \(denied\)/)]);
    const a = fakeSsmStore();
    expect(await versionVariableErrors({ variables: { n: { source: 'ctx:x-room-metrics.openItems' } } } as never, PROFILE, a.client, ROOT, async () => { throw new Error('gone'); }))
      .toEqual([expect.stringMatching(/context source catalog for 'ops-premium' could not be read \(gone\)/)]);
    expect(await versionVariableErrors({ variables: { n: { source: 'ctx:x-room-metrics.openItems' } } } as never, PROFILE, a.client, ROOT))
      .toEqual([expect.stringMatching(/no context source catalog was given/)]);
    expect(await versionVariableErrors({ variables: { n: { source: 'conversation:type' } } } as never, 'nobody-declared-this', a.client, ROOT))
      .toEqual([expect.stringMatching(/serves no classification this deployment declares/)]);
  });

  it('a catalog entry that does not say its trust is member trust, so it never decides', () => {
    const table = buildSourceTable({ catalog: [catalogEntryForVariables({ key: 'x-bare', fields: { level: { type: 'number' } } })] });
    expect(whenErrors({ 'ctx:x-bare.level': { op: 'gt', value: 1 } }, versionLookup(table, {}))).toEqual([expect.stringMatching(/member text/)]);
  });
});

describe('validate and activate refuse what the classification does not publish', () => {
  it('validate lists every refusal and activate refuses to serve it', async () => {
    const a = fakeSsmStore();
    await createDraft(a.client, ROOT, PROFILE, 'admin');
    await editDraft(a.client, ROOT, PROFILE, { modelKey: 'titan', variables: { n: { source: 'ctx:x-elsewhere.level' }, t: { source: 'conversation:type', fallback: 'lounge' } } } as never, 'admin');
    const read = async () => [USER_PROFILE, METRICS];
    const { errors } = await validateDraft(a.client, ROOT, PROFILE, CATALOG, read);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/variables\.n: "ctx:x-elsewhere\.level" is not a source this classification publishes/),
      expect.stringMatching(/variables\.t: "conversation:type" is an enum/),
    ]));
    const err = await activateDraft(a.client, ROOT, PROFILE, CATALOG, 'admin', read).catch((e) => e);
    expect(err).toBeInstanceOf(ProfileValidationError);
    expect((err as ProfileValidationError).errors.join('\n')).toMatch(/variables\.n/);
  });

  it('a version over published sources activates', async () => {
    const a = fakeSsmStore();
    await createDraft(a.client, ROOT, PROFILE, 'admin');
    await editDraft(a.client, ROOT, PROFILE, { modelKey: 'titan', variables: { n: { source: 'ctx:x-room-metrics.openItems', fallback: 0 }, firstName: { source: 'person:displayName' } } } as never, 'admin');
    const r = await activateDraft(a.client, ROOT, PROFILE, CATALOG, 'admin', async () => [USER_PROFILE, METRICS]);
    expect(r.configId).toBeTruthy();
  });
});

describe('export and import (SPEC-PORTABLE-PROFILES)', () => {
  const opts = (catalog: TargetContextSource[]) => ({
    catalog: CATALOG, knownProfile: isKnownProfile, guardrailCatalog: async () => [{ key: 'default', guardrailId: 'g' }],
    contextSourceCatalog: async () => catalog, actor: 'admin',
  });
  const VERSION_VARS = { n: { source: 'ctx:x-room-metrics.openItems', fallback: 0 }, firstName: { source: 'person:displayName', fallback: 'there' } };

  async function exported() {
    const a = fakeSsmStore();
    await createDraft(a.client, ROOT, PROFILE, 'admin');
    await editDraft(a.client, ROOT, PROFILE, { modelKey: 'titan', variables: VERSION_VARS } as never, 'admin');
    await activateDraft(a.client, ROOT, PROFILE, CATALOG, 'admin', async () => [USER_PROFILE, METRICS]);
    return exportManifest(a.client, ROOT, PROFILE);
  }

  it('export carries each variable as a source name and a fallback, and import lands it in a target that publishes them', async () => {
    const manifest = await exported();
    expect(manifest.body.variables).toEqual(VERSION_VARS);
    expect(JSON.stringify(manifest.body.variables)).not.toMatch(/arn:aws|locator|table\//);
    const b = fakeSsmStore();
    const draft = await importManifest(b.client, ROOT, clone(manifest), opts([USER_PROFILE, METRICS]) as never);
    expect(draft.variables).toEqual(VERSION_VARS);
  });

  it('import refuses in a target classification that does not publish the source', async () => {
    const manifest = await exported();
    const b = fakeSsmStore();
    const err = await importManifest(b.client, ROOT, clone(manifest), opts([USER_PROFILE, NOTES]) as never).catch((e) => e);
    expect(err).toBeInstanceOf(ProfileManifestError);
    expect(JSON.stringify((err as ProfileManifestError & { errors?: string[] }).errors))
      .toMatch(/variables\.n: \\"ctx:x-room-metrics\.openItems\\" is not a source this classification publishes/);
  });

  it('import refuses a source the target publishes at a different type, through the fallback', async () => {
    const manifest = await exported();
    const retyped: TargetContextSource = { ...METRICS, fields: { openItems: { type: 'string' }, labels: { type: 'string[]' } } };
    const b = fakeSsmStore();
    const err = await importManifest(b.client, ROOT, clone(manifest), opts([USER_PROFILE, retyped]) as never).catch((e) => e);
    expect(err).toBeInstanceOf(ProfileManifestError);
    expect(JSON.stringify((err as ProfileManifestError & { errors?: string[] }).errors)).toMatch(/is a string, so its fallback is a string/);
  });
});
