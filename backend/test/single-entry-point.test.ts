/**
 * REUSE RATHER THAN BUILD NEW - a ratchet on the operations that keep getting reimplemented.
 *
 * "Create a conversation channel" is implemented six times and "add a member" ten times. Each copy
 * re-derives the same sequence, so every fix has to be applied N times and a missed copy looks fixed
 * from the outside. That is not hypothetical: commit `39208b5` ("associate the channel flow before any
 * membership") changed `create-conversation/index.js` only, `lib/channel-creation.ts` had the identical
 * defect, was never touched, and drift-spawned channels kept the bug for a week while it read as done.
 *
 * Consolidating the existing copies is a real refactor and is deliberately NOT what this file does.
 * What it does is stop the bleeding: the count can go DOWN without ceremony and can never go UP by
 * accident. A seventh creation path fails CI with a message naming the helper to use instead.
 *
 * THE RATCHET IS TWO-WAY ON PURPOSE. An unlisted call site fails (proliferation). A listed call site
 * that no longer makes the call ALSO fails (allowlist rot), which forces the list down as consolidation
 * lands and stops it decaying into a stale inventory nobody trusts - the exact failure mode of the
 * point-in-time audit this repo already retired.
 *
 * Adding an entry is allowed. Adding one WITHOUT a reason is not: the reason is the whole control,
 * because it is what makes "I need another one" a decision someone wrote down rather than a default.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOTS = ['backend/lambda'];

interface Controlled {
  /** The shared implementation a new caller should reuse. */
  canonical: string;
  /** Why this operation is controlled - what breaks when it is reimplemented. */
  why: string;
  /** Sanctioned call sites: repo-relative path -> the reason THIS copy exists. */
  sites: Record<string, string>;
}

/**
 * The operations that must not grow new implementations. Keyed by the SDK command as it appears in
 * source (`new <key>(`), which is the form a new copy actually takes.
 */
const CONTROLLED: Record<string, Controlled> = {
  CreateChannelCommand: {
    canonical: 'backend/lambda/src/lib/channel-creation.ts',
    why:
      'Creating a conversation channel carries invariants that are individually easy to miss and '
      + 'silent when missed: the immutable `classification` tag (the per-classification IAM roles are '
      + 'fail-closed and key on it), channel-flow association BEFORE any membership, the moderator, '
      + 'expiration, and the pre-create channel-context write. The divergence table in the tracker '
      + 'shows almost none of these hold across all six copies.',
    sites: {
      'backend/lambda/src/lib/channel-creation.ts':
        'THE canonical helper. Drift-spawned and internal creation goes through here.',
      'backend/lambda/create-conversation/index.js':
        'The primary user-facing create path, and the oldest. Predates the helper; the consolidation '
        + 'target is for this to call it (tracker row 6).',
      'backend/lambda/src/federated-create-conversation.ts':
        'Host-provisioned federated create: deterministic ChannelId, federated member identities, and '
        + 'a different bearer. Folds into the helper as an option set.',
      'backend/lambda/src/federated-add-member.ts':
        'Creates the channel idempotently when a host adds a member before the conversation exists.',
      'backend/lambda/src/proactive-briefing.ts':
        'Assistant-initiated briefing channel. Known gap: writes no channel context.',
      'backend/lambda/src/admin-notification-channel-provision.ts':
        'Admin notification channel. Known gap: sets NO classification tag and associates no channel '
        + 'flow - verify reachability before consolidating (tracker row 6).',
    },
  },

  CreateChannelMembershipCommand: {
    canonical: 'backend/lambda/src/lib/channel-creation.ts',
    why:
      'Adding a member is an ACCESS-CONTROL act: the classification ceiling has to bind before the '
      + 'membership is written, and membership is the authority for who is in a conversation (never a '
      + 'stored roster copy). Ten independent copies means ten places that rule can be forgotten. The '
      + 'owner-stated direction is one typed entry point, shaped like conversation types.',
    sites: {
      'backend/lambda/src/lib/channel-creation.ts': 'THE canonical helper.',
      'backend/lambda/create-conversation/index.js': 'Adds the creator + the assistant at create time.',
      'backend/lambda/share-conversation/index.js':
        'User-initiated share. Enforces the ceiling from the immutable tag and fails closed - the '
        + 'reference behaviour the consolidated helper should keep.',
      'backend/lambda/add-agent-to-conversation/index.js': 'Adds an assistant to an existing conversation.',
      'backend/lambda/src/federated-create-conversation.ts': 'Federated create: seeds membership.',
      'backend/lambda/src/federated-add-member.ts': 'The federated add-member entry point.',
      'backend/lambda/src/admin-conversation-sync.ts': 'Admin-plane sync of an existing conversation.',
      'backend/lambda/src/admin-notification-channel-provision.ts': 'Admin notification channel provisioning.',
      'backend/lambda/src/channel-battle.ts':
        'Adds the alt-slot bot for a duel. Bot membership, not human - a plausible carve-out when the '
        + 'human path consolidates.',
      'backend/lambda/src/proactive-briefing.ts': 'Seeds membership for an assistant-initiated briefing.',
    },
  },

  CreateChannelModeratorCommand: {
    canonical: 'backend/lambda/src/lib/channel-creation.ts',
    why:
      'Moderator assignment decides who can archive, rename or re-open a conversation, and the '
      + 'assistant must never be one (SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP). Three copies is '
      + 'already three places to get "only the human" wrong.',
    sites: {
      'backend/lambda/src/lib/channel-creation.ts': 'THE canonical helper.',
      'backend/lambda/create-conversation/index.js': 'Makes the creating human a moderator.',
      'backend/lambda/src/federated-create-conversation.ts': 'Same, on the federated path.',
    },
  },
};

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      // .d.ts are build artifacts and carry declarations, not call sites.
      else if (/\.(ts|js)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  for (const r of SCAN_ROOTS) {
    const abs = path.join(ROOT, r);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out;
}

function callSitesOf(command: string, files: string[]): string[] {
  const re = new RegExp(`new\\s+${command}\\s*\\(`);
  return files
    .filter((f) => re.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'))
    .sort();
}

describe('single entry point: reuse rather than build new', () => {
  const files = sourceFiles();

  for (const [command, spec] of Object.entries(CONTROLLED)) {
    describe(command, () => {
      const actual = callSitesOf(command, files);
      const sanctioned = Object.keys(spec.sites).sort();

      it('has no UNSANCTIONED call site', () => {
        const added = actual.filter((f) => !spec.sites[f]);
        // Thrown rather than asserted so the failure carries the guidance. A bare `toEqual([])` diff
        // tells the next person WHAT tripped and not what to do about it, and "what to do about it"
        // is the entire point of this guard.
        if (added.length) {
          throw new Error(
            `\n\nNEW \`${command}\` call site(s):\n  ${added.join('\n  ')}\n\n`
            + `Reuse \`${spec.canonical}\` instead.\n\n${spec.why}\n\n`
            + 'If a new copy is genuinely required, add it to CONTROLLED in this file WITH the reason '
            + 'it cannot reuse the canonical helper. The reason is the control; an entry without one '
            + 'is how six copies happened.\n',
          );
        }
        expect(added).toEqual([]);
      });

      it('has no STALE allowlist entry (the ratchet only turns one way)', () => {
        const gone = sanctioned.filter((f) => !actual.includes(f));
        if (gone.length) {
          throw new Error(
            `\n\nThese are allowlisted but no longer call \`${command}\`:\n  ${gone.join('\n  ')}\n\n`
            + 'Consolidation landed - delete them from CONTROLLED so the count ratchets DOWN and the '
            + 'list keeps describing the code rather than its history.\n',
          );
        }
        expect(gone).toEqual([]);
      });
    });
  }

  it('is not vacuous - the scanner finds the call sites it claims to police', () => {
    // A regex that matched nothing would pass every assertion above while checking nothing at all.
    // These are lower bounds, not the live counts: asserting the exact number would make this test
    // fail on consolidation, which is the outcome it exists to encourage.
    expect(sourceFiles().length).toBeGreaterThan(50);
    expect(callSitesOf('CreateChannelCommand', files).length).toBeGreaterThanOrEqual(2);
    expect(callSitesOf('CreateChannelMembershipCommand', files).length).toBeGreaterThanOrEqual(2);
  });
});
