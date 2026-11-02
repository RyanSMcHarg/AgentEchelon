/**
 * THE DOCTOR'S CHECK OF THE TRUSTED-ISSUER REGISTRY: each pool exists, each discovery URL answers.
 *
 * Synth validates the registry's SHAPE (`lib/config/issuers.ts`); it cannot know whether a pool id
 * names a pool that exists or whether an issuer's discovery document is reachable. A registry entry
 * pointing at nothing deploys cleanly and then refuses every person of that issuer at sign-in, so the
 * doctor asks before the deploy does.
 *
 * The two lookups are injected, so the check runs against stubs in a test and against AWS and the
 * network in `deployment-doctor.mjs`. Nothing here throws: a lookup that fails is a failed check, with
 * what failed.
 */

const { createPublicKey } = require('crypto');

/** The `issuers` value from deploy.config.json, as a list, or [] when it declares none. */
function issuersFromConfig(config) {
  const raw = config?.issuers;
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * One result per check, in registry order: `{ issuer, check, ok, detail }`.
 *
 * - A Cognito entry naming a pool id: `describePool(poolId)` resolves when the pool exists.
 * - `pool: 'self'`: the deployment creates it, so there is nothing to look up before the deploy.
 * - An OIDC entry: `fetchDiscovery(url)` resolves to the discovery document, whose `issuer` must be the
 *   one the entry declares (an Entra template is matched on its tenant).
 */
async function checkIssuers(issuers, { describePool, fetchDiscovery }) {
  const results = [];
  for (const entry of issuers) {
    const id = String(entry?.id || '(no id)');
    const kind = String(entry?.kind || '');
    if (kind === 'cognito-pool' || kind === 'cognito-federated') {
      if (entry.pool === 'self') {
        results.push({ issuer: id, check: 'pool', ok: true, detail: "this deployment's own pool, created by the deploy" });
        continue;
      }
      try {
        await describePool(String(entry.pool));
        results.push({ issuer: id, check: 'pool', ok: true, detail: `pool ${entry.pool} exists` });
      } catch (err) {
        results.push({ issuer: id, check: 'pool', ok: false, detail: `pool ${entry.pool} could not be described: ${err?.name || err?.message || err}` });
      }
      continue;
    }
    if (kind === 'oidc' || kind === 'oidc-entra') {
      const url = String(entry.discoveryUrl || '');
      if (!url) {
        results.push({ issuer: id, check: 'discovery', ok: false, detail: 'names no discoveryUrl' });
        continue;
      }
      try {
        const doc = await fetchDiscovery(url);
        const advertised = String(doc?.issuer || '');
        const expected = kind === 'oidc' ? String(entry.issuer || '') : '';
        const tenantOk = kind !== 'oidc-entra' || (entry.tenants || []).some((t) => advertised.includes(t));
        if (!advertised || (expected && advertised !== expected) || !tenantOk) {
          results.push({ issuer: id, check: 'discovery', ok: false, detail: `${url} answers, but advertises issuer "${advertised}"${expected ? `, not "${expected}"` : ''}` });
        } else {
          results.push({ issuer: id, check: 'discovery', ok: true, detail: `${url} answers as ${advertised}` });
        }
      } catch (err) {
        results.push({ issuer: id, check: 'discovery', ok: false, detail: `${url} did not answer: ${err?.name || err?.message || err}` });
      }
      continue;
    }
    // A HOST ASSERTION has no discovery document to ask: its keys are pinned, so the check is that each
    // pinned key is a public key at all. Whether the host signs with it is the deny-test's to show.
    if (kind === 'host-assertion') {
      const keys = entry?.hostAssertion?.publicKeys && typeof entry.hostAssertion.publicKeys === 'object' ? entry.hostAssertion.publicKeys : {};
      const bad = Object.entries(keys).filter(([, v]) => {
        try { createPublicKey({ key: Buffer.from(String(v), 'base64'), format: 'der', type: 'spki' }); return false; } catch { return true; }
      }).map(([kid]) => kid);
      const count = Object.keys(keys).length;
      results.push(count && !bad.length
        ? { issuer: id, check: 'keys', ok: true, detail: `${count} pinned key${count === 1 ? '' : 's'} (${Object.keys(keys).join(', ')})` }
        : { issuer: id, check: 'keys', ok: false, detail: count ? `pinned key ${bad.join(', ')} is not a public key` : 'no pinned key' });
      continue;
    }
    // The platform's own guest issuer has nothing outside this deployment to ask.
    if (kind === 'guest') {
      results.push({ issuer: id, check: 'kind', ok: true, detail: 'the platform signs guest tokens with its own key' });
      continue;
    }
    // The platform's own invitation-link issuer signs nothing and asks nothing outside this deployment.
    if (kind === 'invitation-link') {
      results.push({ issuer: id, check: 'kind', ok: true, detail: 'a link invitation is redeemed at the exchange; there is no token to check' });
      continue;
    }
    // A kind synth refuses or does not know: synth says why.
    results.push({ issuer: id, check: 'kind', ok: false, detail: `kind "${kind}" is refused at synth; npm run build && npx cdk synth names why` });
  }
  return results;
}

module.exports = { checkIssuers, issuersFromConfig };
