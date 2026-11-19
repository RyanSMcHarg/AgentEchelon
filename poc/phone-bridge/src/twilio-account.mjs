/**
 * The Twilio account: credentials from AWS Secrets Manager, and pointing the chosen number's voice
 * webhook at the bridge for as long as it runs.
 *
 * The number's previous voice settings are written to `.state/original-webhook.json` BEFORE they are
 * changed, and put back on shutdown. A file left by a crash is never overwritten, so the true original
 * survives a second start; `node src/restore-webhook.mjs` puts it back by hand.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import twilio from 'twilio';

const STATE_FILE = new URL('../.state/original-webhook.json', import.meta.url);

/** Reads the secret and finds the account SID and auth token whatever the keys are called. Never logs values. */
export async function loadTwilioCredentials(cfg) {
  const sm = new SecretsManagerClient({ region: cfg.region });
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: cfg.twilioSecretId }));
  let parsed;
  try { parsed = JSON.parse(SecretString ?? ''); } catch { throw new Error(`secret ${cfg.twilioSecretId} is not JSON`); }
  const pick = (test) => Object.entries(parsed).find(([k]) => test(k.toLowerCase().replace(/[^a-z]/g, '')))?.[1];
  const accountSid = pick((k) => k.includes('account') && k.includes('sid')) ?? pick((k) => k === 'sid');
  const authToken = pick((k) => k.includes('auth') && k.includes('token')) ?? pick((k) => k === 'token');
  if (!accountSid || !authToken) {
    throw new Error(`secret ${cfg.twilioSecretId} has keys [${Object.keys(parsed).join(', ')}]; expected an account SID and an auth token`);
  }
  return { accountSid, authToken };
}

export function twilioClient({ accountSid, authToken }) {
  return twilio(accountSid, authToken);
}

async function findNumber(client, e164) {
  const [num] = await client.incomingPhoneNumbers.list({ phoneNumber: e164, limit: 1 });
  if (!num) throw new Error(`${e164} is not a number on this Twilio account`);
  return num;
}

/**
 * Points the number's voice webhook at the bridge, and its status callback too, so an inbound call that ends before its
 * audio stream opens is still reported to the bridge.
 */
export async function pointNumberAt(client, e164, voiceUrl, statusCallback) {
  const num = await findNumber(client, e164);
  if (!existsSync(STATE_FILE)) {
    await mkdir(new URL('../.state/', import.meta.url), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify({
      sid: num.sid,
      phoneNumber: num.phoneNumber,
      voiceUrl: num.voiceUrl,
      voiceMethod: num.voiceMethod,
      voiceApplicationSid: num.voiceApplicationSid,
      voiceFallbackUrl: num.voiceFallbackUrl,
      statusCallback: num.statusCallback,
      statusCallbackMethod: num.statusCallbackMethod,
    }, null, 2));
  }
  // A number bound to a TwiML App ignores its voiceUrl, so the binding is cleared while the bridge runs.
  await client.incomingPhoneNumbers(num.sid).update({ voiceApplicationSid: '', voiceUrl, voiceMethod: 'POST', statusCallback, statusCallbackMethod: 'POST' });
}

export async function restoreNumber(client) {
  if (!existsSync(STATE_FILE)) return false;
  const saved = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  await client.incomingPhoneNumbers(saved.sid).update({
    voiceUrl: saved.voiceUrl ?? '',
    voiceMethod: saved.voiceMethod ?? 'POST',
    voiceApplicationSid: saved.voiceApplicationSid ?? '',
    voiceFallbackUrl: saved.voiceFallbackUrl ?? '',
    statusCallback: saved.statusCallback ?? '',
    statusCallbackMethod: saved.statusCallbackMethod ?? 'POST',
  });
  await rm(STATE_FILE);
  return true;
}
