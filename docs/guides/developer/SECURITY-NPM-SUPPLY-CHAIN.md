# npm Supply-Chain Hardening

This project treats every npm dependency as untrusted code that runs on your machine and in CI. This document records the controls the repo ships, why they exist, and how to work with them.

## Why this matters

npm packages can execute arbitrary code at install time through lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`). A single compromised dependency, direct or transitive, runs that code with your shell's privileges the moment you install it. Through 2026 this became the dominant attack pattern, with several high-profile compromises of extremely popular packages:

- **axios** (March 2026): the maintainer's npm account was hijacked and poisoned versions `axios@1.14.1` and `axios@0.30.4` were published, pulling a phantom dependency (`plain-crypto-js@4.2.1`) that dropped a cross-platform remote-access trojan. Safe versions are `>= 1.14.0` on the 1.x line (anything except `1.14.1`) and `0.30.3` on the legacy line.
- **Red Hat "Miasma"** (June 2026): around 32 `@redhat-cloud-services/*` packages were trojanized via a hijacked maintainer account, executing an obfuscated dropper through an npm `preinstall` hook and self-spreading via a phantom `binding-gyp` dependency.
- **Typosquat / dependency-confusion bursts** (May 2026): dozens of packages purpose-built to harvest AWS credentials, Vault tokens, and CI/CD secrets from the install environment.

The common thread is install-time script execution and credential theft. This repo is an AWS CDK project, so a poisoned dependency running where deploy credentials live is exactly the prize these payloads hunt for. The controls below are aimed squarely at that threat.

## Controls this repo ships

**Install-time scripts are blocked by default.** Every install root carries an `.npmrc` with `ignore-scripts=true` (repo root, `frontend/`, `backend/`, `tests/`, and each `backend/lambda/*` subproject). `npm ci` and `npm install` will not run any dependency's lifecycle scripts. This neutralizes the primary infection vector for the attacks above. CI inherits this automatically because the `.npmrc` files are committed and CI installs from the same working directories.

**Deterministic installs.** Use `npm ci`, never `npm install`, to set up or refresh dependencies. `npm ci` installs the exact tree recorded in the committed lockfile and fails if `package.json` and the lockfile disagree, instead of silently resolving newer (possibly poisoned) versions. All documented setup commands use `npm ci`, and CI already enforces it.

**Exact version pins.** The same `.npmrc` sets `save-exact=true`, so adding a dependency records an exact version (no `^` range). Combined with the committed lockfile, a malicious patch or minor release cannot be picked up by a fresh resolve.

**Committed lockfiles.** Every install root commits its `package-lock.json`. The lockfile is the single source of truth for what gets installed; review changes to it in PRs the same way you review source.

## Working with these controls

**Adding or updating a dependency.** Run the install in the relevant subproject, review the lockfile diff (watch for unexpected new transitive packages, especially ones with install scripts), and commit `package.json` + `package-lock.json` together.

**When a package legitimately needs an install script.** Some packages (native modules, tools that download a platform binary) rely on a postinstall step. With `ignore-scripts=true` that step is skipped, which can leave such a package non-functional. Handle it explicitly rather than disabling the protection globally:

- Prefer packages that ship prebuilt platform binaries as optional dependencies (no script needed). Modern `esbuild` / Vite, used by the frontend, work this way and build fine with scripts ignored.
- If a build step is truly required, run it as an explicit, named command after install (for example a dedicated `npm run rebuild` you can read before running) so the executed code is visible and intentional. Do not flip `ignore-scripts` off for the whole project.

**Auditing.** Run `npm audit` to surface known-vulnerable versions and `npm audit signatures` to verify the registry provenance/signatures of your installed tree. Treat high-severity findings as release blockers.

**Adopt new releases on a delay.** Most of these compromises are detected and the bad versions yanked within hours to days. Do not auto-adopt brand-new releases. If you use a bot like Renovate or Dependabot, configure a minimum release age (a few days) so you skip the window when a poisoned version is live.

## Protect the credentials these payloads target

The May 2026 campaigns specifically scraped AWS keys and CI secrets out of the install environment, so credential hygiene is part of supply-chain defense:

- Use short-lived, federated credentials for CDK deploys and CI (OIDC-assumed roles) rather than long-lived `AKIA...` access keys stored as secrets.
- Keep `.env` out of git (it already is) and avoid running `npm install` / `npm ci` in a shell that has full deploy credentials exported when you can avoid it.
- If you ever publish internal scoped packages, configure the scope's registry in `.npmrc` so npm cannot be tricked into pulling a public impostor of an internal name (the dependency-confusion vector).

## Checking whether you are affected

To check this repo (or any project) against the known 2026 compromises, scan the committed manifests and lockfiles. These catch transitive pulls too, and skip `node_modules`:

```bash
# Indicators of compromise: phantom deps + hijacked namespaces
grep -rE 'plain-crypto-js|@redhat-cloud-services|"binding-gyp"' . \
  --include=package.json --include=package-lock.json | grep -v node_modules

# The specific poisoned axios releases
grep -rE '"version": "(1\.14\.1|0\.30\.4)"' . --include=package-lock.json | grep -i axios
```

No output from both means no known-compromised package is pinned. If a match appears: remove `node_modules`, pin a safe version in `package.json`, run `npm ci`, rotate any credentials that were present on a machine where the bad version was installed, and review the lockfile diff before committing.
