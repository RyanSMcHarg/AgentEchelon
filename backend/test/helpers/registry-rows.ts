/**
 * THE DEPLOYMENT'S REGISTRY ROWS, AS A DEPLOYED HANDLER READS THEM, FOR A TEST.
 *
 * A deployed handler reads the deployment's set at runtime from the rows its stacks publish
 * (`loadProfileRegistry`, `lib/profile-registry.ts`; `loadAdmission`, `lambda/cognito-triggers/registry-admission.js`
 * for the raw ones). This names the registry's path and hands both readers the rows of `config` (the shipped
 * catalog unless given), held on the global object so a handler loaded after a module reset reads them too.
 */
import {
  DEFAULT_PROFILES_CONFIG, PROFILE_REGISTRY_PATH_ENV, profilesConfigFromRows, registryRowFromValue, registryRowsOf, registryRowValue, type ProfilesConfig,
} from '../../lib/config/profiles';

export const TEST_REGISTRY_PATH = '/test/registry/classification';

export function seedRegistryRows(config: ProfilesConfig = DEFAULT_PROFILES_CONFIG): void {
  const rows = registryRowsOf(config).map(registryRowValue);
  process.env[PROFILE_REGISTRY_PATH_ENV] = TEST_REGISTRY_PATH;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../../lambda/cognito-triggers/registry-admission.js').__setRowReaderForTest(async () => rows);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const registry = require('../../lib/profile-registry');
  registry.__setRegistryRowReaderForTest(async () => rows);
  // AND THE SET INSTALLED ON THE COPY THE CURRENT MODULE REGISTRY HOLDS, as a handler's load would leave it, so a
  // helper the test imported before a module reset (an edge context, a token) reads the same set. A copy loaded
  // after a reset reads the rows when its handler loads them.
  registry.useDeploymentProfiles(profilesConfigFromRows(rows.map(registryRowFromValue)));
}

/** Forget the path and the rows, so a later test in the same file reads the catalog compiled into the bundle. */
export function clearRegistryRows(): void {
  delete process.env[PROFILE_REGISTRY_PATH_ENV];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../../lambda/cognito-triggers/registry-admission.js').__setRowReaderForTest(undefined);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../../lib/profile-registry').__setRegistryRowReaderForTest(undefined);
}
