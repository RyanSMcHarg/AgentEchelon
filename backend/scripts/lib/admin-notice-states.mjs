/**
 * THE OPERATIONAL NOTICES' STATE PARAMETERS, written ENABLED where absent before AdminServices deploys (DESIGN-EVENT-TARGETS
 * section 12). Each operational notice rule reads its state from its parameter at deploy, and no stack owns the parameter, so an
 * administrator's switch survives a deploy; a fresh deployment needs each to exist first. An existing value is never changed.
 *
 * Reads the catalog from the build output, which both deploy scripts compile before they get here.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Write ENABLED for every operational notice whose state parameter is absent. Returns the keys written. */
export async function ensureAdminNoticeStates({ region, instanceName, ssm = new SSMClient({ region }) }) {
  const { ADMIN_NOTICE_TYPES, adminNoticeStateParam } = require(path.join(HERE, '..', '..', 'lambda', 'src', 'lib', 'admin-notice-types.js'));
  const written = [];
  for (const t of ADMIN_NOTICE_TYPES.filter((n) => !n.security)) {
    try {
      await ssm.send(new PutParameterCommand({
        Name: adminNoticeStateParam(`/${instanceName}`, t.key), Value: 'ENABLED', Type: 'String', Overwrite: false,
        Description: `Whether the ${t.messageType} notices post into the admin notifications conversation; switched in the console's trigger form`,
      }));
      written.push(t.key);
    } catch (err) {
      if (err?.name !== 'ParameterAlreadyExists') throw err;
    }
  }
  return written;
}
