/**
 * THE DENY-TEST INVENTORY: every live refusal the platform claims, and the file that proves it.
 *
 * A deny-test is the evidence tenet P4 asks for: AWS, or the platform's own edge, refusing a crossing
 * on a deployed instance, rather than a code review saying it would. The claims are spread across the
 * specifications, the security model and the design records, and a claim with no test reads exactly
 * like a claim with one. So the inventory is one list, rendered into the end-to-end coverage matrix
 * (`docs/reference/e2e-coverage-matrix.md`), and each row is either present (every file it names exists
 * and holds what the row says it holds) or **NOT BUILT**.
 *
 * `e2e-coverage-matrix.test.ts` holds the rows that are not built yet as a ratchet that only shrinks: a
 * row whose files land must leave the ratchet, and a new row cannot be added as missing.
 *
 * Present means the file exists, not that it ran. Every file here runs against a deployed instance and
 * records its result where the claim it proves lives.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface DenyTestRow {
  /** Stable id, used by the ratchet. */
  id: string;
  /** What is refused, in one sentence a reader can check a security claim against. */
  claim: string;
  /** Repository-relative files that prove it. Every one must exist for the row to be present. */
  files: readonly string[];
  /** A string the first file must contain, when the row extends a file that already exists. */
  contains?: string;
  /** The deployment configurations it runs against (the deploy matrix's ids). */
  configurations: string;
  /**
   * Unit suites that prove the refusal's logic ahead of the live test, with locally generated keys and
   * no deployment. They are listed so a reader sees what is already proven, and they never make a row
   * present: only the live files do (tenet P4).
   */
  unit?: readonly string[];
}

export const DENY_TEST_INVENTORY: readonly DenyTestRow[] = [
  {
    id: 'bearer-pin',
    claim: 'A session vended for one person cannot act as another person: the `person` session tag pins the bearer.',
    files: ['backend/scripts/deny-test-bearer-pin.mjs'],
    configurations: 'C1 and later',
  },
  {
    id: 'credential-exchange',
    claim: 'An exchange credential sending as another person is refused on a real channel its caller belongs to.',
    files: ['backend/scripts/deny-test-credential-exchange.mjs'],
    configurations: 'C1 and later',
  },
  {
    id: 'session-classification',
    claim: 'A session asserting one classification cannot be minted on the role carrying another classification\'s grants.',
    files: ['backend/scripts/deny-test-session-classification.mjs'],
    configurations: 'C1 and later',
  },
  {
    id: 'tag-key-case',
    claim: 'A principal-versus-resource tag condition matches the key casing the stacks write, so it enforces rather than never matching.',
    files: ['backend/scripts/deny-test-tag-key-case.mjs'],
    configurations: 'C1 and later',
  },
  {
    id: 'offboarded-sign-in',
    claim: 'An offboarded person is refused at their next sign-in, and nothing is minted for them.',
    files: ['backend/scripts/deny-test-offboarded-sign-in.mjs'],
    configurations: 'C1 and later',
  },
  {
    id: 'assistant-membership',
    claim: 'A membership credential is authorized on the channel, not on the member it names, so the membership audit is the enforcement on that axis.',
    files: ['backend/scripts/deny-test-assistant-membership.mjs'],
    configurations: 'C1 and later',
  },
  {
    id: 'admin-capabilities',
    claim: 'Every admin capability is refused, by IAM at the gateway, to a role that does not hold it.',
    files: ['backend/scripts/deny-test-admin-capabilities.mjs'],
    configurations: 'C2 and later',
  },
  {
    id: 'owner-team-tag',
    claim: 'Only the ownership function can write the `owner-team` tag.',
    files: ['backend/scripts/deny-test-owner-team-tag.mjs'],
    configurations: 'C2 and later',
  },
  {
    id: 'provisioner-claims',
    claim: "No principal can ask the assistant provisioner in another's name: each classification's claim path is writable by its own seed alone and the console's by `manage-assistants` alone, and a request whose claim was never written is refused.",
    files: ['backend/scripts/deny-test-provisioner-claims.mjs'],
    unit: ['backend/test/the-provisioner-builds-and-retires-every-assistant.test.ts', 'backend/test/one-principal-builds-every-assistant.test.ts'],
    configurations: 'C1 and later',
  },
  {
    id: 'identities-writers',
    claim: 'Only the credential exchange and offboarding write the `Identities` table, and, with a `provisioned-only` issuer, the subject provisioners, which write `pending` rows alone.',
    files: ['backend/scripts/deny-test-credential-exchange.mjs'],
    contains: 'only the exchange and offboarding write Identities',
    configurations: 'C1 and later',
  },
  {
    id: 'issuer-mapping',
    claim: 'A person from a foreign issuer cannot read or post in a channel their mapped classifications do not reach, and a claim value outside the mapping reaches nothing.',
    files: ['backend/scripts/deny-test-issuer-mapping.mjs'],
    configurations: 'C5 and later',
  },
  {
    id: 'edge-authorizer',
    claim: 'A token from an undeclared issuer, with a forged signature, for another audience, of the undeclared token type, signed with an undeclared algorithm (none and HS256 included) or outside its validity gets 401 on every person-facing route; a first-time token is refused everywhere but the exchange; a one-conversation issuer is refused everywhere but its own routes.',
    files: ['backend/scripts/deny-test-edge-authorizer.mjs'],
    configurations: 'C1 and C5',
    unit: [
      'backend/test/lib/the-edge-refuses-a-token-it-cannot-prove.test.ts',
      'backend/test/lib/the-edge-admits-a-token-only-where-its-person-is-served.test.ts',
    ],
  },
  {
    id: 'admin-exchange',
    claim: 'The admin credential exchange refuses a guest token and a host assertion.',
    files: ['backend/scripts/deny-test-admin-exchange.mjs'],
    configurations: 'C5 and later',
  },
  {
    id: 'guest',
    claim: 'A guest cannot reach another guest\'s channel or any route but the exchange; a refresh replay revokes its family, the latest credential included; two tabs refreshing at once both keep the session; a burst from one address is refused; guest start refuses with its reason code when a control cannot answer; the guest-session role with no session policy is refused CreateChannel, CreateChannelMembership and every other channel.',
    files: ['backend/scripts/deny-test-guest.mjs'],
    configurations: 'C0 and later',
    unit: [
      'backend/test/the-guest-session-fails-closed.test.ts',
      'backend/test/lib/the-edge-verifies-a-guest-token.test.ts',
      'backend/test/the-guest-session-reaches-one-conversation.test.ts',
      'backend/test/the-guest-issuer-is-declared-with-its-controls.test.ts',
    ],
  },
  {
    id: 'guest-widget',
    // The widget's own upgrade action (path A bind, path B claim) is NOT BUILT (`WidgetSession.upgrade`); its
    // server half is proven by the `upgrade` row. The widget's upgrade specs join this row when it is built.
    claim: 'An anonymous visitor in the widget gets an answer from the seeded assistant, and the widget shows each refusal\'s reason.',
    files: ['tests/e2e/guest-widget.spec.ts'],
    configurations: 'C0 and later',
  },
  {
    id: 'tokens',
    claim: 'A single-use token is refused on a second redemption, after it expires and on the wrong channel, and each kind writes only its own records.',
    files: ['backend/scripts/deny-test-tokens.mjs'],
    configurations: 'C0 and later',
    unit: ['backend/test/the-token-store-redeems-a-token-once.test.ts'],
  },
  {
    id: 'host-assertion',
    claim: 'A host assertion is refused on replay, on a wrong audience, a long expiry, an unpinned key or no `jti`, on any route but the exchange (without spending its `jti`), with an unmapped permission set, and for a subject nobody provisioned (nothing is created); a pending subject reaches the exchange alone. The undeclared-origin and parent-frame refusals are made by the widget frame itself, in the browser, so no live script can make them: they are proven by the component tests of the widget (`frontend/packages/widget/src/session/hostAssertion.test.ts`, `frontend/packages/widget/src/embed/embed.test.ts`).',
    files: ['backend/scripts/deny-test-host-assertion.mjs'],
    configurations: 'C5 and later',
    unit: [
      'backend/test/lib/the-edge-verifies-a-host-assertion.test.ts',
      'backend/test/a-host-assertion-is-spent-before-the-exchange-vends.test.ts',
      'backend/test/a-host-assertion-issuer-pins-its-keys.test.ts',
    ],
  },
  {
    id: 'pending-identities',
    claim: 'No role but the two subject provisioners writes a `pending` `Identities` row, and each only under the keys of its own issuers; a pending row of one issuer is not accepted from another; a provisioned subject is bound once, to one person, under concurrency too, and carries no expiration.',
    files: ['backend/scripts/deny-test-pending-identities.mjs'],
    configurations: 'C5 and later',
    unit: [
      'backend/test/a-provisioned-subject-is-pending-until-its-first-sign-in.test.ts',
      'backend/test/the-host-assertion-boundary.test.ts',
    ],
  },
  {
    id: 'upgrade',
    claim: 'A guest is bound to an account only by the rules of the bind, which removes its expiration and revokes the guest\'s refresh family; the bind takes the widget\'s single-use hand-off (a nonce, and the secret only the tab the widget opened receives), so a forwarded sign-in link binds nothing; an existing account cannot bind a visitor; a claim is never matched by email and redeems once; erasure follows the source-channel tag; a second issuer is linked only by a pinned session.',
    files: ['backend/scripts/deny-test-upgrade.mjs'],
    contains: 'A12: a forwarded link',
    configurations: 'C0 and later (path B and the link need a customers\' pool)',
    unit: [
      'backend/test/lib/binding-a-guest-ends-the-guest-credential.test.ts',
      'backend/test/a-claim-opens-a-tagged-customer-conversation.test.ts',
      'backend/test/lib/a-second-issuer-is-linked-only-by-a-pinned-session.test.ts',
      'backend/test/the-upgrade-paths-are-granted-narrowly.test.ts',
      'backend/test/user-management-delete.test.ts',
    ],
  },
  {
    id: 'invitations',
    claim: 'An invitation is redeemed once, in its declared mode only; a GET of its link leaves the token unspent; a sign-in redemption never binds an account that already exists; a forwarded link admits one session, pinned to one conversation; revocation removes the membership; offboarding the inviter makes a pending invitation unredeemable.',
    files: ['backend/scripts/deny-test-invitations.mjs', 'tests/e2e/invitations.spec.ts'],
    configurations: 'C3 and later',
    unit: [
      'backend/test/lib/an-invitation-names-its-invitee-by-person.test.ts',
      'backend/test/lib/an-invitation-is-redeemed-once-in-its-mode.test.ts',
      'backend/test/invitations-are-granted-narrowly.test.ts',
      'backend/test/an-invitation-link-issuer-is-declared-with-its-controls.test.ts',
      'backend/test/user-management-delete.test.ts',
    ],
  },
  {
    id: 'reply-token',
    claim: 'Email is sent only with consent and the unsubscribe headers; inbound mail without a valid reply token, or failing DMARC, posts nothing.',
    files: ['backend/scripts/deny-test-reply-token.mjs', 'tests/e2e/preferences.spec.ts'],
    configurations: 'C3 and later',
  },
  {
    id: 'funnel-export',
    claim: 'Each funnel stage is recorded once, and an export covers every store that names a person.',
    files: ['tests/e2e/funnel.spec.ts', 'tests/e2e/export.spec.ts'],
    configurations: 'C2 and later',
    unit: [
      'backend/test/lib/the-funnel-records-each-stage-once-per-journey.test.ts',
      'backend/test/an-export-covers-every-store-erasure-names.test.ts',
    ],
  },
  {
    id: 'claims-erased',
    claim: 'The contact copy kept for a person from a claims-only issuer is erased when the person is offboarded.',
    files: ['tests/e2e/h1-offboard.spec.ts'],
    configurations: 'C5 and later',
  },
  {
    id: 'non-pool-person',
    claim: 'A person from a second pool and from a foreign OIDC issuer is an opaque AppInstanceUser that is not the token\'s subject, and every person-facing feature works for them.',
    files: ['tests/e2e/h1-person.spec.ts'],
    configurations: 'C5 and C7',
  },
  {
    id: 'connector-events',
    claim: 'A vendor event reaches the receiver only through its connector\'s rule, pinned to the declared partner event source and subscribed events; the receiver may be invoked by those rules alone; and no route serves a vendor. A replay is dropped, and a person is named only through `Identities`, never by email (unit; live with a real vendor delivery).',
    files: ['backend/scripts/deny-test-connector-events.mjs'],
    configurations: 'C6 and later',
    unit: [
      'backend/test/lib/a-vendor-event-is-received-only-from-its-source.test.ts',
      'backend/test/lib/a-connector-names-a-person-only-through-identities.test.ts',
    ],
  },
  {
    id: 'connector-boundary',
    claim: 'The connector runtime holds no Amazon Chime SDK channel action, reads only its own connectors\' secrets, decrypts grants only under their encryption context, and never writes `Identities`.',
    files: ['backend/scripts/deny-test-connector-boundary.mjs'],
    configurations: 'C6 and later',
    unit: ['backend/test/connectors-hold-only-their-own-reach.test.ts'],
  },
  {
    id: 'permission-boundaries',
    claim: 'Each role a session is vended on or an assistant acts through (every assistant acting role, the guest and link session roles, each person vend role a host assertion is also vended on, the admin exchange\'s roles), the edge authorizer and the connector runtime carry a permissions boundary that caps them, whatever their identity or session policy grants.',
    files: ['backend/scripts/deny-test-permission-boundaries.mjs'],
    contains: 'THE BOUNDARY CAPS AN IDENTITY POLICY THAT GRANTS EVERYTHING',
    configurations: 'C7',
    unit: ['backend/test/every-role-a-credential-is-minted-on-carries-a-boundary.test.ts'],
  },
  {
    id: 'context-source-per-classification',
    claim: 'A classification\'s acting role, with the tags a real session carries, is refused another classification\'s context-source catalog and every source that catalog publishes and its own does not, so a `ctx:` variable reads only what its classification publishes (ADR-060).',
    files: ['tests/e2e/a-turn-role-is-refused-another-classifications-context-source.spec.ts'],
    configurations: 'C1 and later',
    unit: ['backend/test/a-turn-role-is-refused-another-classifications-context-source.test.ts'],
  },
];

/** True when the repository-relative file exists. */
export function fileExists(repoRoot: string, file: string): boolean {
  return fs.existsSync(path.join(repoRoot, file));
}

/** True when every file the row names exists and the first one holds what the row says it holds. */
export function isPresent(repoRoot: string, row: DenyTestRow): boolean {
  if (!row.files.every((f) => fs.existsSync(path.join(repoRoot, f)))) return false;
  if (!row.contains) return true;
  return fs.readFileSync(path.join(repoRoot, row.files[0]), 'utf8').includes(row.contains);
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

/** The inventory as a section of the coverage matrix. Deterministic: no timestamp, list order kept. */
export function renderDenyTestInventory(
  rows: readonly DenyTestRow[],
  present: (row: DenyTestRow) => boolean,
  exists: (file: string) => boolean,
): string[] {
  const lines: string[] = [];
  const built = rows.filter(present).length;
  lines.push('## Deny-tests');
  lines.push('');
  lines.push('Every live refusal the platform claims, and the file that proves it. Rendered from');
  lines.push('`backend/lib/docs/deny-test-inventory.ts`. A row is present when every file it names exists and');
  lines.push('holds the check; that is not a record that it ran. Each run against a deployed instance is');
  lines.push('recorded, dated, in the document that makes the claim. The configurations are the deploy');
  lines.push('matrix\'s (`backend/test/deploy-matrix/configurations.ts`): C0 is the anonymous widget alone, and');
  lines.push('each later configuration adds capabilities to the one before. A file marked (unit) proves the');
  lines.push('refusal\'s logic without a deployment; it never makes a row present.');
  lines.push('');
  lines.push(`${built} of ${rows.length} present.`);
  lines.push('');
  lines.push('| Deny-test | Refuses | Files | Configurations | State |');
  lines.push('|---|---|---|---|---|');
  for (const row of rows) {
    // A file that does not exist yet is named as plain text, not as a code path: the docs' path guard
    // reads a backticked path as a claim that the file exists.
    const live = row.files.map((f) => (exists(f) ? `\`${f}\`` : `${f} (not built)`));
    // Unit suites are shown, marked as such; they never make a row present.
    const unit = (row.unit ?? []).map((f) => (exists(f) ? `\`${f}\` (unit)` : `${f} (unit, not built)`));
    const files = [...live, ...unit].join('<br>');
    const state = present(row) ? 'present' : '**NOT BUILT**';
    lines.push(`| \`${row.id}\` | ${escapeCell(row.claim)} | ${files} | ${row.configurations} | ${state} |`);
  }
  lines.push('');
  return lines;
}
