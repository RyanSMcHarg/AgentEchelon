/**
 * A TRACE HOLDS NO PASSWORD.
 *
 * Local only: a page served from this process, a sign-in form on it, and a trace read back from the
 * zip it produces. No deployment, no credentials, so it runs anywhere the suite does.
 *
 * Two tests, and the first is what makes the second mean anything. A plain `fill` must be FOUND in the
 * trace (action title, DOM snapshot and request body), which proves the reader below sees what a
 * person opening the trace would see. Only then does "`fillSecret` leaves nothing" say something.
 *
 * The secret is random per run, so it is in no source file the trace bundles (`sources: true`).
 */
import { test, expect } from './helpers/fixtures';
import { type Browser } from '@playwright/test';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import { fillSecret } from './helpers/unrecorded-secret';
import { guardBackendErrors } from './helpers/turn-guards';

// This file starts and reads its own trace, so the runner's must not be running on the same context.
test.use({ trace: 'off', video: 'off' });

const PAGE = `<!doctype html><html><body>
<form id="login">
  <input type="email" id="email">
  <input type="password" id="password">
  <button type="submit">Sign in</button>
</form>
<div id="result"></div>
<script>
document.getElementById('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = JSON.stringify({
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: document.getElementById('email').value, PASSWORD: document.getElementById('password').value },
  });
  const r = await fetch('/auth', { method: 'POST', headers: { 'Content-Type': 'application/x-amz-json-1.1' }, body });
  const ok = (await r.json()).ok;
  // As the app does: a signed-in page no longer renders the form.
  if (ok) document.getElementById('login').remove();
  document.getElementById('result').textContent = ok ? 'signed-in' : 'refused';
});
</script></body></html>`;

/** Every entry of a zip, inflated. Enough of the format for a Playwright trace (stored or deflated). */
function zipEntries(buf: Buffer): Map<string, Buffer> {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Where in a trace a value appears: as text, or inside any base64 run (the protocol carries request
 * bodies and overrides as base64, at any byte alignment, so a search for `btoa(secret)` alone misses it).
 */
function whereFound(trace: Map<string, Buffer>, secret: string): string[] {
  const found: string[] = [];
  for (const [name, data] of trace) {
    const text = data.toString('utf8');
    if (text.includes(secret)) { found.push(name); continue; }
    for (const run of text.match(/[A-Za-z0-9+/]{24,}={0,2}/g) ?? []) {
      if (Buffer.from(run, 'base64').toString('utf8').includes(secret)) { found.push(`${name} (base64)`); break; }
    }
  }
  return found;
}

/** Serve the page, sign in through it with `type`, and return the trace and what the server received. */
async function signInTraced(
  browser: Browser,
  tracePath: string,
  secret: string,
  type: (field: import('@playwright/test').Locator, endpoint: RegExp) => Promise<void>,
): Promise<{ trace: Map<string, Buffer>; received: string[] }> {
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/auth') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const password = JSON.parse(body).AuthParameters?.PASSWORD ?? '';
        received.push(password);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: password === secret }));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const context = await browser.newContext();
  try {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator('#email').fill('person@example.com');
    await type(page.locator('#password'), new RegExp(`^${origin.replace(/[.]/g, '\\.')}/auth`));
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#result')).toHaveText(/signed-in|refused/);
    // One more action, so a snapshot is taken after the sign-in as well as before it.
    await expect(page.locator('#result')).toHaveText('signed-in');
    await context.tracing.stop({ path: tracePath });
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return { trace: zipEntries(fs.readFileSync(tracePath)), received };
}

test.describe('a trace holds no password', () => {
  guardBackendErrors('trace-holds-no-password');
  test('a plain fill is found in the trace: in the action, the snapshot and the request', async ({ browser }, testInfo) => {
    const secret = `Pw${randomBytes(12).toString('hex')}x9`;
    const { trace, received } = await signInTraced(browser, testInfo.outputPath('plain.zip'), secret, (field) => field.fill(secret));
    expect(received).toEqual([secret]);
    const where = whereFound(trace, secret);
    // The action and its snapshots are in the trace file, the request body in a resource the network
    // file names.
    expect(where.some((w) => w.endsWith('.trace')), `found in: ${where.join(', ')}`).toBe(true);
    expect(where.some((w) => w.startsWith('resources/')), `found in: ${where.join(', ')}`).toBe(true);
  });

  test('fillSecret signs in with the real password and the trace holds none of it', async ({ browser }, testInfo) => {
    const secret = `Pw${randomBytes(12).toString('hex')}x9`;
    const { trace, received } = await signInTraced(
      browser, testInfo.outputPath('unrecorded.zip'), secret, (field, endpoint) => fillSecret(field, secret, { endpoint }),
    );
    // The identity provider received the real value, so the swap is not a no-op that fails sign-in.
    expect(received).toEqual([secret]);
    expect(whereFound(trace, secret), 'the password appears in the trace').toEqual([]);
    // And the stand-in is where the password would have been: in the action and in the recorded
    // request, so the trace still shows what was typed and sent, only not the secret.
    const standIn = whereFound(trace, 'Ae1!unrecorded');
    expect(standIn.some((w) => w.endsWith('.trace')), `stand-in found in: ${standIn.join(', ')}`).toBe(true);
    expect(standIn.some((w) => w.startsWith('resources/')), `stand-in found in: ${standIn.join(', ')}`).toBe(true);
  });

  test('no spec types a password field with fill, type or pressSequentially', async () => {
    // A literal is a value written into the source on purpose (a wrong password, a too-short one) and is
    // no secret. Anything else is read from somewhere, and goes through fillSecret.
    const typed = /locator\(\s*(['"`])[^'"`]*(?:type="password"|#password|#confirmPassword|#newPassword)[^'"`]*\1\s*\)\s*\.(?:fill|type|pressSequentially)\(\s*([^)]*)\)/g;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const source = fs.readFileSync(full, 'utf8');
          for (const m of source.matchAll(typed)) {
            if (!/^(['"`])[^'"`$]*\1$/.test(m[2].trim())) offenders.push(`${path.relative(__dirname, full)}: ${m[0]}`);
          }
        }
      }
    };
    walk(__dirname);
    expect(offenders, 'type a password with fillSecret (helpers/unrecorded-secret.ts)').toEqual([]);
  });
});
