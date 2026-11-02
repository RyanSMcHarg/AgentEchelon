/**
 * THE VITE_ISSUERS CONTRACT, BOTH ENDS.
 *
 * `backend/scripts/gen-frontend-env.mjs` projects the trusted-issuer registry into one `.env` line
 * (`backend/scripts/lib/sign-in-issuers.cjs`), Vite loads it, and the sign-in screen parses it
 * (`redirectSignIn.ts`). Each end is tested here against the other, so a field renamed on one side
 * fails here rather than as a missing button on a deployed sign-in screen.
 *
 * The projection is an allowlist of public fields: the line is baked into a bundle anyone can download.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnv } from 'vite';
import { parseSignInIssuers } from './redirectSignIn';

const require = createRequire(import.meta.url);
const { signInIssuers, viteIssuersLine } = require('../../../../../backend/scripts/lib/sign-in-issuers.cjs') as {
  signInIssuers: (issuers: unknown[], o: { selfPoolId?: string; region?: string }) => { entries: Array<Record<string, unknown>>; skipped: Array<{ id: string; reason: string }> };
  viteIssuersLine: (entries: unknown[]) => string;
};

const SELF_POOL = 'us-east-1_Self';
const REGISTRY = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'premium'] }, admin: true },
  {
    id: 'corp-sso', kind: 'cognito-federated', pool: 'self', providerName: 'CorpSAML', admin: true,
    displayName: { en: 'Corp\'s SSO $HOME', fr: 'SSO de l\'entreprise' },
    clearance: { mapping: { claim: 'custom:dept', values: { eng: 'premium' } }, classifications: ['premium'] },
    adminGroups: ['admins'],
  },
  { id: 'other-pool', kind: 'cognito-federated', pool: 'us-east-1_Other', providerName: 'X', clearance: { fixed: ['basic'], classifications: ['basic'] } },
  {
    id: 'partner', kind: 'oidc', issuer: 'https://id.partner.example', discoveryUrl: 'https://id.partner.example/.well-known/openid-configuration',
    audience: 'partner-client', clearance: { fixed: ['basic'], classifications: ['basic'] }, allowedOrigins: ['https://partner.example'],
  },
  {
    id: 'entra', kind: 'oidc-entra', tenants: ['72f988bf-86f1-41af-91ab-2d7cd011db47'], tokenVersion: 2,
    discoveryUrl: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0/.well-known/openid-configuration',
    audience: ['a', 'b'], clearance: { fixed: ['basic'], classifications: ['basic'] },
  },
];

describe('the registry, projected for the sign-in screen', () => {
  const { entries, skipped } = signInIssuers(REGISTRY, { selfPoolId: SELF_POOL, region: 'us-east-1' });

  it('lists the redirect issuers it can offer, and says why it leaves the others out', () => {
    expect(entries.map((e) => e.id)).toEqual(['corp-sso', 'partner']);
    expect(skipped.map((s) => s.id)).toEqual(['other-pool', 'entra']);
    expect(entries[0]).toMatchObject({
      issuer: `https://cognito-idp.us-east-1.amazonaws.com/${SELF_POOL}`,
      discoveryUrl: `https://cognito-idp.us-east-1.amazonaws.com/${SELF_POOL}/.well-known/openid-configuration`,
      providerName: 'CorpSAML',
      admin: true,
    });
    expect(entries[1]).toMatchObject({ clientId: 'partner-client', admin: false });
  });

  it('carries public fields only', () => {
    const allowed = new Set(['id', 'kind', 'displayName', 'discoveryUrl', 'issuer', 'clientId', 'providerName', 'admin']);
    for (const e of entries) for (const key of Object.keys(e)) expect(allowed.has(key)).toBe(true);
    const line = viteIssuersLine(entries);
    for (const secret of ['clearance', 'classifications', 'mapping', 'custom:dept', 'adminGroups', 'tenants', 'allowedOrigins']) {
      expect(line).not.toContain(secret);
    }
  });

  it('survives the .env file and Vite, and parses on the client exactly as projected', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vite-issuers-'));
    try {
      writeFileSync(path.join(dir, '.env'), `VITE_AWS_REGION=us-east-1\n${viteIssuersLine(entries)}\n`);
      const env = loadEnv('production', dir, 'VITE_');
      const parsed = parseSignInIssuers(env.VITE_ISSUERS);
      expect(parsed.map((i) => i.id)).toEqual(['corp-sso', 'partner']);
      // The apostrophe and the dollar sign arrive as written: neither ends nor expands the value.
      expect(parsed[0].displayName).toEqual({ en: 'Corp\'s SSO $HOME', fr: 'SSO de l\'entreprise' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists nothing for the default registry, the deployment pool alone', () => {
    expect(signInIssuers([], { selfPoolId: SELF_POOL }).entries).toEqual([]);
    expect(viteIssuersLine([])).toBe("VITE_ISSUERS='[]'");
    expect(parseSignInIssuers('[]')).toEqual([]);
  });
});
