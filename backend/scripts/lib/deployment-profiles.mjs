/**
 * AN OPS SCRIPT READS THE DEPLOYMENT'S CLASSIFICATIONS, NOT THE SHIPPED CATALOG.
 *
 * Import this FIRST, before anything that reads `lib/profile-registry.js`: it resolves the set
 * `backend/deploy.config.json` declares (`profiles`, `resolveDeploymentProfiles`) and installs it as the
 * registry (`useDeploymentProfiles`), the same call `bin/backend.ts` makes before any stack is built. Code that
 * reads `defaultProfileRegistry` at call time then reads the deployment's set. No deploy.config.json, or no
 * `profiles` in it, is the shipped catalog minus its outside classifications, as at synth. COMPILED output: run
 * `npm run build` first.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveDeploymentProfiles } = require('../../lib/config/profiles.js');
const { useDeploymentProfiles } = require('../../lib/profile-registry.js');
const { readDeployConfig } = require('./deploy-guards.cjs');

const config = readDeployConfig();
useDeploymentProfiles(resolveDeploymentProfiles(config.profiles));
