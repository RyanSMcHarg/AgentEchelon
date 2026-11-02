'use strict';
/**
 * THE CHAT APP'S BUILD-TIME FALLBACK SET, FROM THE DEPLOYMENT'S REGISTRY ROWS.
 *
 * The chat app renders before sign-in (the registration screen offers the member classifications as the
 * requested tier), when no person route can be called, so `gen-frontend-env.mjs` writes the set into
 * `VITE_CLASSIFICATIONS` for the chat package alone. It reads the same rows every handler reads at runtime
 * (one SSM parameter per classification under `<SSM root>/registry/classification`, published by the stack that
 * owns the classification) and renders them as `clientClassifications(profilesConfigFromRows(rows))` does
 * (`lib/config/profiles.ts`): the rows in the order of their values, the admin plane granting every member
 * classification and itself, and a badge nobody declares taking the lowest-numbered token nobody declared nor
 * took before it. Once signed in the app loads the set from `GET /classifications` instead.
 *
 * Pinned against the TypeScript by `backend/test/the-chat-fallback-renders-the-registry-rows.test.ts`.
 */
const { gunzipSync } = require('zlib');

const BADGE_TOKENS = ['cls-1', 'cls-2', 'cls-3', 'cls-4', 'cls-5', 'cls-6', 'cls-7', 'cls-8'];

/** The row a parameter value carries (`registryRowValue`). */
function rowOf(value) {
  const json = value.startsWith('gz64:') ? gunzipSync(Buffer.from(value.slice('gz64:'.length), 'base64')).toString('utf8') : value;
  return JSON.parse(json);
}

/** The clients' set the rows render to. */
function clientClassificationsOfRows(rows) {
  const sorted = [...rows].sort((a, b) => (a.classification.value < b.classification.value ? -1 : a.classification.value > b.classification.value ? 1 : 0));
  const taken = new Set(sorted.map((r) => r.classification.badgeToken).filter(Boolean));
  let cycle = 0;
  const next = () => {
    const free = BADGE_TOKENS.find((t) => !taken.has(t));
    if (free) {
      taken.add(free);
      return free;
    }
    return BADGE_TOKENS[cycle++ % BADGE_TOKENS.length];
  };
  return sorted.map(({ classification: c }) => ({
    value: c.value,
    displayName: c.displayName ?? c.value,
    audience: c.audience ?? 'members',
    badgeToken: c.badgeToken ?? next(),
    // The admin plane grants itself alone (SPEC-ADMIN-IDENTITY FR1).
    grants: c.adminPlane ? [c.value] : [...c.grants],
    conversational: !!c.topology,
    ...(c.models ? { models: { selected: [...c.models.selected], default: c.models.default } } : {}),
    ...(c.adminPlane ? { adminPlane: true } : {}),
  }));
}

/** Every row value under `path`, read with the given SSM client and command. */
async function readRowValues(client, GetParametersByPathCommand, path) {
  const values = [];
  let NextToken;
  do {
    const page = await client.send(new GetParametersByPathCommand({ Path: path, Recursive: false, MaxResults: 10, NextToken }));
    for (const p of page.Parameters || []) if (typeof p.Value === 'string') values.push(p.Value);
    NextToken = page.NextToken;
  } while (NextToken);
  return values;
}

module.exports = { rowOf, clientClassificationsOfRows, readRowValues };
