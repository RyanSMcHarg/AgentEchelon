/** Puts the Twilio number's voice settings back by hand, after a crash left them pointing at a dead tunnel. */
import { loadConfig } from './config.mjs';
import { loadTwilioCredentials, twilioClient, restoreNumber } from './twilio-account.mjs';

const cfg = await loadConfig();
const restored = await restoreNumber(twilioClient(await loadTwilioCredentials(cfg)));
console.log(restored ? 'Restored the number\'s original voice settings.' : 'Nothing to restore.');
