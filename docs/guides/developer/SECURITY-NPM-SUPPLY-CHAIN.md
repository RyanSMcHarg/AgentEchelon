# npm Supply-Chain Hardening

This project treats every npm dependency as untrusted code that runs on your machine and in CI. This document records the controls the repo ships, why they exist, and how to work with them.

## Threat

npm packages can execute arbitrary code at install time through lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`). A single compromised dependency, direct or transitive, runs that code with your shell's privileges the moment you install it. The common patterns are a hijacked maintainer account publishing a poisoned release, a phantom dependency added to an otherwise legitimate package, and typosquat or dependency-confusion packages built to harvest credentials from the install environment.

This repo is an AWS CDK project, so a poisoned dependency running where deploy credentials live is exactly what these payloads look for. The controls below target install-time script execution and credential theft.

## Controls this repo ships

**Install-time scripts are blocked.** Every install root carries an `.npmrc` with `ignore-scripts=true` (repo root, `frontend/`, `backend/`, `tests/`, and each `backend/lambda/*` subproject). `npm ci` and `npm install` do not run any dependency's lifecycle scripts. CI inherits this because the `.npmrc` files are committed and CI installs from the same working directories.

**Deterministic installs.** Use `npm ci`, never `npm install`, to set up or refresh dependencies. `npm ci` installs the exact tree recorded in the committed lockfile and fails if `package.json` and the lockfile disagree, instead of resolving newer (possibly poisoned) versions. All documented setup commands use `npm ci`, and the CI jobs (`.github/workflows/ci.yml`) run `npm ci` in `backend/` and `frontend/`.

**Exact pins for new dependencies.** The same `.npmrc` sets `save-exact=true`, so a dependency added with `npm install <pkg>` records an exact version. It does not rewrite existing entries: the committed manifests carry `^` ranges, and what bounds them is the committed lockfile installed with `npm ci`. A fresh resolve (`npm install`, or deleting the lockfile) can still adopt a new patch or minor release inside those ranges.

**Committed lockfiles.** Every install root with a `package.json` commits its `package-lock.json` (`backend/`, `frontend/` covering its workspace packages, `tests/`, and each `backend/lambda/*` subproject). The root `.npmrc` is a safety net; there is no root `package.json`. The lockfile is the single source of truth for what gets installed; review changes to it in PRs the same way you review source.

**Overrides.** `backend/package.json` and `frontend/package.json` carry an `overrides` block that forces minimum versions of specific transitive dependencies (for example `fast-xml-parser`) regardless of what the depending package asks for. Add an override when a vulnerable transitive version cannot be removed by updating its parent, and remove it once the parent ships the fix.

## CI coverage

- **OPEN:** the `tests/` (Playwright e2e) job in `.github/workflows/ci.yml` is commented out, so CI does not install or exercise the `tests/` tree.
- **NOT BUILT:** CI runs no `npm audit` step, and no Dependabot or Renovate configuration is committed. Auditing and update cadence are manual (below).

## Working with these controls

**Adding or updating a dependency.** Run the install in the relevant subproject, review the lockfile diff (watch for unexpected new transitive packages, especially ones with install scripts), and commit `package.json` + `package-lock.json` together.

**When a package legitimately needs an install script.** Some packages (native modules, tools that download a platform binary) rely on a postinstall step. With `ignore-scripts=true` that step is skipped, which can leave such a package non-functional. Handle it explicitly rather than disabling the protection globally:

- Prefer packages that ship prebuilt platform binaries as optional dependencies (no script needed). `esbuild` and Vite, used by the frontend, work this way and build with scripts ignored.
- If a build step is truly required, run it as an explicit, named command after install (for example a dedicated `npm run rebuild` you can read before running) so the executed code is visible and intentional. Do not flip `ignore-scripts` off for the whole project.

**Auditing.** Run `npm audit` to surface known-vulnerable versions and `npm audit signatures` to verify the registry provenance/signatures of your installed tree. Treat high-severity findings as release blockers.

**Adopt new releases on a delay.** Compromised versions are usually detected and pulled within hours to days. Do not adopt brand-new releases immediately. If you add an automated update tool, configure a minimum release age (a few days) so you skip the window when a poisoned version is live.

## Protect the credentials these payloads target

Supply-chain payloads commonly scrape AWS keys and CI secrets from the install environment, so credential hygiene is part of supply-chain defense:

- Use short-lived, federated credentials for CDK deploys and CI (OIDC-assumed roles) rather than long-lived `AKIA...` access keys stored as secrets.
- Keep `.env` files out of git (they are ignored) and avoid running `npm install` / `npm ci` in a shell that has full deploy credentials exported when you can avoid it.
- If you publish internal scoped packages, configure the scope's registry in `.npmrc` so npm cannot be tricked into pulling a public impostor of an internal name (the dependency-confusion vector).

## Checking whether you are affected

When an advisory names a compromised package or version, scan the committed manifests and lockfiles. Lockfiles catch transitive pulls too:

```bash
# Replace <package> and <version> with the advisory's indicators
grep -rE '"<package>"' . --include=package.json --include=package-lock.json | grep -v node_modules
grep -rE '"node_modules/<package>"' -A2 . --include=package-lock.json | grep -E '"version": "<version>"'
```

If a match appears: remove `node_modules`, pin a safe version in `package.json` (or add an override for a transitive dependency), run `npm ci`, rotate any credentials that were present on a machine where the bad version was installed, and review the lockfile diff before committing.
