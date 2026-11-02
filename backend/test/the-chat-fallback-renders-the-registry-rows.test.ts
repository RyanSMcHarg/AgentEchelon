/**
 * THE CHAT APP'S BUILD-TIME FALLBACK RENDERS THE REGISTRY ROWS AS GET /classifications DOES.
 *
 * The chat app renders before sign-in (the registration screen's tiers), so `gen-frontend-env.mjs` writes the set
 * into `VITE_CLASSIFICATIONS` from the same registry rows every handler reads
 * (`scripts/lib/registry-client-classifications.cjs`). Signed in, it loads the set from `GET /classifications`,
 * which renders `clientClassifications(profilesConfigFromRows(rows))`. The two agree on every set here, so what
 * the app renders before and after sign-in is one set.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_PROFILES_CONFIG, clientClassifications, profilesConfigFromRows, registryRowFromValue, registryRowValue, registryRowsOf,
  resolveDeploymentProfiles, type ProfilesConfig,
} from '../lib/config/profiles';
import { CUSTOM_PROFILES, CUSTOM_BATTLE_PROFILES_PLUS_RESEARCH } from './deploy-matrix/configurations';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fallback = require('../scripts/lib/registry-client-classifications.cjs');

describe('the chat fallback renders the registry rows', () => {
  it.each<[string, ProfilesConfig]>([
    ['the shipped catalog', DEFAULT_PROFILES_CONFIG],
    ['a deployment that declares nothing', resolveDeploymentProfiles(undefined)],
    ['C1-custom', resolveDeploymentProfiles(CUSTOM_PROFILES)],
    ['C7-custom+research', resolveDeploymentProfiles(CUSTOM_BATTLE_PROFILES_PLUS_RESEARCH)],
  ])('%s, as GET /classifications renders them', (_name, config) => {
    const values = registryRowsOf(config).map(registryRowValue);
    const served = clientClassifications(profilesConfigFromRows(values.map(registryRowFromValue)));
    expect(fallback.clientClassificationsOfRows(values.map(fallback.rowOf))).toEqual(served);
  });

  it('reads every page of the rows', async () => {
    const pages = [{ Parameters: [{ Value: 'a' }], NextToken: 't' }, { Parameters: [{ Value: 'b' }] }];
    const sent: unknown[] = [];
    const client = { send: async (cmd: unknown) => { sent.push(cmd); return pages[sent.length - 1]; } };
    class Cmd { constructor(public input: unknown) {} }
    await expect(fallback.readRowValues(client, Cmd, '/x/registry/classification')).resolves.toEqual(['a', 'b']);
    expect(sent).toHaveLength(2);
  });

  it('is written for the chat package alone, from the registry path, by gen-frontend-env', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'gen-frontend-env.mjs'), 'utf8');
    expect(src).toContain('chatLines.push(await chatFallbackClassificationsLine());');
    expect(src).not.toMatch(/adminLines\.push\(await chatFallbackClassificationsLine/);
    expect(src).toContain('/registry/classification');
    expect(src).not.toMatch(/Classifications: 'VITE_CLASSIFICATIONS'/);
  });
});
