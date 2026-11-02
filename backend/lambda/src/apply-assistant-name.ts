/**
 * PUTS AN ASSISTANT'S DISPLAY NAME ONTO ITS IDENTITY (DESIGN-SEPARATE-ASSISTANTS section 3.0).
 *
 * This exists because of where the rename stopped. A display name rides a profile version, so
 * `manage-profiles` can change what the console and analytics call an assistant - and what a person
 * actually reads beside a message in the room is the `Name` on the `AppInstanceBot`, which only
 * `UpdateAppInstanceBot` changes. Until this Lambda, a rename reached every reader except the one
 * everybody looks at.
 *
 * WHY `manage-profiles` DOES NOT JUST CALL THE API ITSELF. `UpdateAppInstanceBot` takes the bot's
 * whole `Configuration` alongside its name, so holding it is holding the power to repoint the
 * identity's Amazon Lex wiring - to point the assistant at a different brain. A capability for
 * editing BEHAVIOR would then carry a grant over INFRASTRUCTURE, which is the line
 * SPEC-PORTABLE-PROFILES section 7 draws when it says a version selects within a boundary and never
 * points at a resource.
 *
 * WHY NOT THE PROVISIONER, which already holds the wiring (tenet D8 asks first). The provisioner
 * (`assistant-provisioner-function.ts`) creates and deletes identities, and a caller chooses the request it
 * sends. Granting `manage-profiles` an invoke on it would grant it, by the same call, identity deletion, so this
 * is a separate function with one job and one grant.
 *
 * WHAT MAKES THIS NARROW, and it is the design rather than a promise:
 *   - It takes a NAME and nothing else. There is no parameter through which a caller can express an
 *     opinion about configuration.
 *   - It re-sends the configuration the bot ALREADY HAS, read back from the service at call time. It
 *     holds no copy of the Amazon Lex wiring, so it cannot repoint anything and cannot drift from
 *     what the provisioner built - the identity itself is the one source for its own configuration.
 *   - It finds the identity through the assistant's directory entry, which only the provisioner writes,
 *     outside `/assistant/*`, and its IAM grant reaches only identities stamped `provisioner = runtime`.
 *
 * ONE APPLIER FOR EVERY ASSISTANT (ADR-048, amended 2026-10-23). Every identity is the provisioner's,
 * declared or created in the console, a duel's alt included, so the admin backend deploys this one function
 * and no stack deploys an applier of its own. "Inherit" puts back the name the assistant was provisioned
 * with: its directory entry's `displayName`.
 */
import {
  ChimeSDKIdentityClient,
  DescribeAppInstanceBotCommand,
  UpdateAppInstanceBotCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { SSMClient } from '@aws-sdk/client-ssm';
import { displayNameErrors } from './lib/display-name.js';
import { chimeIdentityClient } from './lib/chime/clients.js';
import { readDirectoryEntry } from './lib/runtime-directory.js';
import { ASSISTANT_ID_PATTERN } from './lib/assistant-acting-policy.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const { AWS_REGION } = process.env;
const identity = chimeIdentityClient({ region: AWS_REGION });

export interface ApplyAssistantNameRequest {
  /** The assistant this rename is FOR, found through its directory entry. */
  assistant: string;
  /**
   * What it should now be called, or ABSENT to inherit the configured default.
   *
   * Absent is a real instruction, not a missing argument: it is what an activated version that names
   * nothing asks for, and it must put the provisioned name back rather than leave the previous
   * custom one in place.
   */
  displayName?: string;
}

export interface ApplyAssistantNameResult {
  applied: boolean;
  /** The name the identity carries after this call. */
  name?: string;
  /** What it was called before, so a caller can report a no-op distinctly from a change. */
  previous?: string;
  /**
   * The request asked for something this deployment cannot do, as opposed to something that went
   * wrong. A caller reports it as "no rename path here" rather than as a failure, so an operator is
   * not told a rename broke when they were not renaming anything.
   */
  unsupported?: boolean;
  error?: string;
}

const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const ssm = new SSMClient({ region: AWS_REGION });

/** The identity and inherited name of an ACTIVE assistant, or an error saying why there is none. */
async function runtimeTarget(assistant: string | undefined): Promise<{ botArn: string; defaultName: string } | { error: string }> {
  if (!assistant || !ASSISTANT_ID_PATTERN.test(assistant)) return { error: `'${assistant}' is not an assistant id` };
  try {
    const entry = await readDirectoryEntry(ssm, SSM_ROOT, assistant);
    if (!entry || entry.status !== 'active' || !entry.botArn) return { error: `'${assistant}' has no active identity` };
    return { botArn: entry.botArn, defaultName: entry.displayName || assistant };
  } catch (err) {
    return { error: `the directory could not be read: ${(err as Error)?.message || err}` };
  }
}

export const handler = async (event: ApplyAssistantNameRequest): Promise<ApplyAssistantNameResult> => {
  // The directory reader resolves through the registry, so it is loaded before the first read.
  await loadProfileRegistry();
  const target = await runtimeTarget(event?.assistant);
  if ('error' in target) return { applied: false, error: target.error };
  return rename(target.botArn, target.defaultName, event, 'assistant');
};

/** Put `event.displayName` (or `defaultName`, to inherit) on the identity, keeping its configuration. */
async function rename(
  botArn: string,
  defaultName: string,
  event: ApplyAssistantNameRequest,
  logScope: string,
): Promise<ApplyAssistantNameResult> {
  // ABSENT MEANS INHERIT, so it resolves to the configured default before validation rather than
  // being rejected as missing. A blank string is still refused below: it is a name nobody can address,
  // and it arrives from a caller that meant something by it.
  const target = event.displayName === undefined || event.displayName === null
    ? defaultName
    : event.displayName;
  if (!target) {
    // NOT A FAILURE, and the distinction is what an operator reads. This deployment has no name to
    // inherit, so a version that names nothing asks for something that cannot be done here - the same
    // situation as an assistant with no applier at all. Reporting it as `failed` would tell someone
    // activating an unrelated model change that "renaming the messaging identity failed", which names
    // a problem they do not have and did not cause.
    return {
      applied: false,
      unsupported: true,
      error: 'no name was given and this deployment configured no default to inherit',
    };
  }
  const errs = displayNameErrors(target, { required: true });
  if (errs.length) return { applied: false, error: errs.join('; ') };

  let previous: string | undefined;
  let configuration;
  let metadata: string | undefined;
  try {
    const current = await identity.send(
      new DescribeAppInstanceBotCommand({ AppInstanceBotArn: botArn }),
    );
    previous = current.AppInstanceBot?.Name;
    configuration = current.AppInstanceBot?.Configuration;
    metadata = current.AppInstanceBot?.Metadata;
  } catch (err: any) {
    return { applied: false, error: `could not read the identity: ${err?.message || err}` };
  }
  if (!configuration) {
    // REFUSE RATHER THAN SUBSTITUTE. `UpdateAppInstanceBot` requires a configuration, so the only way
    // to proceed without one is to invent it - and an invented configuration is exactly the
    // repointing this function is built not to do.
    return { applied: false, error: 'the identity returned no configuration to preserve' };
  }
  if (previous === target) {
    // Already correct. Reported as not-applied rather than as a change, so a caller re-running an
    // activation does not read as having renamed something.
    return { applied: false, name: previous, previous };
  }

  try {
    await identity.send(
      new UpdateAppInstanceBotCommand({
        AppInstanceBotArn: botArn,
        Name: target,
        // METADATA IS CARRIED THROUGH for the same reason the configuration is: `UpdateAppInstanceBot`
        // REPLACES the record, so every field this call omits is a field it erases. This sent a
        // hardcoded '' at first, on the true-but-fragile reasoning that the provisioner creates bots
        // without metadata so there was nothing to lose. That makes a rename silently destructive the
        // day anything starts writing it, and a rename is not a thing anyone would suspect of having
        // cleared it. Re-sending what was read keeps the identity the one source for its own record.
        Metadata: metadata ?? '',
        Configuration: configuration,
      }),
    );
  } catch (err: any) {
    return { applied: false, previous, error: `rename refused at the identity: ${err?.message || err}` };
  }
  console.log(
    `[apply-assistant-name] ${logScope}/${event.assistant}: '${previous}' -> '${target}'`,
  );
  return { applied: true, name: target, previous };
}
