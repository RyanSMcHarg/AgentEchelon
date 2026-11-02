/**
 * CAN THE ASSISTANT IN THIS CONVERSATION READ A FILE I ATTACH?
 *
 * The composer offers a paperclip. Whether the turn behind it can OPEN what that paperclip sends is
 * a property of the profile serving the conversation, and until this hook existed nothing asked:
 * the control was unconditional, a basic-profile conversation accepted the upload, stored it, showed
 * the chip, and answered from the caption alone - no error, no notice, nothing in the log.
 *
 * ── WHY IT ASKS THE BACKEND RATHER THAN READING THE TIER IT ALREADY HOLDS ────────────────────────
 *
 * `activeConversation.modelTier` is right there and would have been one line. It is the wrong
 * source twice over. It comes from channel Metadata, which members can write (`chime:UpdateChannel`),
 * so it is not authoritative about anything. And keying on it would put a capability RULE - "basic
 * cannot read files" - inside one client, duplicating a decision the deployment makes in CDK; the
 * day a deployment grants basic the attachment read, this client would still hide the control and
 * nobody would know why.
 *
 * So the deployment answers. `attachmentsReadable` comes from the same profile flag that decides
 * whether the turn's IAM role carries `s3:GetObject` on the attachments prefix - the boundary
 * reporting itself rather than a second opinion about it.
 *
 * ── IT IS AN AFFORDANCE, NOT AN ENFORCEMENT ──────────────────────────────────────────────────────
 *
 * Nothing here keeps a file out of anywhere. A client that ignored this hook entirely would still
 * hit a role with no read grant. What this changes is that a person is not invited to do something
 * the platform will silently decline - which is the whole defect, since the decline was invisible.
 *
 * ── THREE STATES, BECAUSE THE CALLER MAKES A STATEMENT OF FACT ──────────────────────────────────
 *
 * The only consumer renders a sentence - "the assistant here cannot read files" - so the difference
 * between "known not to" and "not yet known" is the difference between a true claim and a false one.
 *
 *   `undefined` IN FLIGHT. Nothing has been read yet, so nothing is asserted. This returned a plain
 *     boolean initialised to `false`, which told anyone who staged a file in the first moments of a
 *     conversation that their assistant could not read it - in a premium room where it can. The
 *     window is small and entirely real, and every test awaited the config before staging, so it was
 *     never exercised.
 *
 *   `false` ON A FAILED READ, deliberately, and NOT `undefined`. This is the one place fail-closed
 *     wins over precision: the defect this hook exists for is an assistant silently answering from
 *     the caption, and a network error in a basic-profile conversation would restore exactly that
 *     silence. A warning shown wrongly costs a sentence somebody ignores; a warning withheld wrongly
 *     costs a confident answer about a document nobody read. See the test that pins it.
 */

import { useEffect, useState } from 'react';
import { getBattleConfig } from '../services/channelBattleService';

export function useAttachmentCapability(conversationArn: string | undefined): boolean | undefined {
  const [readable, setReadable] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (!conversationArn) {
      setReadable(undefined);
      return;
    }
    let cancelled = false;
    // UNKNOWN while the answer is in flight, so a conversation switch never shows the PREVIOUS room's
    // capability against this one's composer for a frame - and never states this one's limits before
    // anything has been read.
    setReadable(undefined);
    (async () => {
      try {
        const config = await getBattleConfig(conversationArn);
        if (!cancelled) setReadable(config?.attachmentsReadable === true);
      } catch {
        // FAIL CLOSED on an error, unlike the in-flight state above. An unreadable capability is not
        // evidence of one, but staying silent here re-opens the original defect for the rooms that
        // most need the notice.
        if (!cancelled) setReadable(false);
      }
    })();
    return () => { cancelled = true; };
  }, [conversationArn]);

  return readable;
}
