import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
for (const [entry, out] of [['web/control-page.mjs', 'dist/control.js'], ['web/bridge-page.mjs', 'dist/bridge.js']]) {
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    // The Chime SDK's AWS SDK dependencies ship a browser build; resolve to it, as the chat app's Vite build does.
    mainFields: ['browser', 'module', 'main'],
    conditions: ['browser'],
    define: { global: 'globalThis' },
    target: 'chrome120',
    logLevel: 'warning',
  });
}
await copyFile('web/control.html', 'dist/control.html');
