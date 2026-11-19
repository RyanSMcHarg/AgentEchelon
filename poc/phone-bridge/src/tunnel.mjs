/**
 * A Cloudflare quick tunnel to the PUBLIC port only, so Twilio can reach the webhook and the media
 * stream. The control page and its API are on a different port that is never tunneled.
 */
import { spawn } from 'node:child_process';

/**
 * The quick tunnel's URL in a line of cloudflared output, or null. Cloudflare's own hosts on the same domain
 * (`api.trycloudflare.com`, which cloudflared names when a request to it fails) are never a tunnel.
 */
export function tunnelUrlIn(text) {
  for (const m of String(text).matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/g)) {
    if (m[1] !== 'api' && m[1] !== 'www') return m[0];
  }
  return null;
}

export function startTunnel(cloudflaredPath, port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cloudflaredPath, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true });
    const timer = setTimeout(() => reject(new Error('cloudflared gave no tunnel URL within 30 s')), 30_000);
    const scan = (chunk) => {
      const url = tunnelUrlIn(chunk);
      if (url) { clearTimeout(timer); resolve({ url, proc }); }
    };
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan);
    proc.on('error', (e) => { clearTimeout(timer); reject(new Error(`cloudflared did not start: ${e.message}`)); });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`cloudflared exited with ${code}`)); });
  });
}
