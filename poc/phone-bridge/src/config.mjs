import { readFile } from 'node:fs/promises';

export async function loadConfig() {
  let cfg;
  try {
    cfg = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  } catch {
    throw new Error('config.json is missing or not JSON: copy config.example.json to config.json and fill it in');
  }
  for (const key of ['region', 'twilioSecretId', 'twilioNumber', 'localPort', 'publicPort', 'chromePath']) {
    if (!cfg[key] || String(cfg[key]).startsWith('REPLACE_')) throw new Error(`config.json: set ${key}`);
  }
  if (!/^\+[1-9]\d{6,14}$/.test(cfg.twilioNumber)) throw new Error('config.json: twilioNumber is E.164, like +15555550100');
  if (cfg.awsProfile && !process.env.AWS_PROFILE) process.env.AWS_PROFILE = cfg.awsProfile;
  return { cloudflaredPath: 'cloudflared', ...cfg };
}

/** Shows enough of a phone number to tell calls apart, never all of it. */
export function maskNumber(e164) {
  return e164 ? `${'*'.repeat(Math.max(0, e164.length - 4))}${e164.slice(-4)}` : '';
}

/**
 * Every phone number in a piece of text masked as `maskNumber` masks one: a Twilio error names the number it refused in
 * full, so anything that may carry one is masked before it is logged or shown. A number is `+` and 6 to 15 digits, or 10 to
 * 15 digits standing alone; an id with digits in it (a meeting id, a leg id) is left as it is.
 */
export function maskNumbersIn(text) {
  return String(text ?? '').replace(/\+\d{6,15}(?!\d)|(?<![\w-])\d{10,15}(?![\w-])/g, (n) => maskNumber(n));
}
