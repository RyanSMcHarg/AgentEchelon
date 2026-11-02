/**
 * THE DEMO CAST (DEMO-SCRIPT Act 1 and Act 3.2) and the address each person signs in with, kept out of
 * `provision-test-users.mjs` so the address rule is exercised without an account
 * (`test/provision-test-users-secret.test.ts`). Directors and VPs at most; nobody here is an executive.
 *
 * EVERY DEMO LOGIN IS A MAILBOX SOMETHING CAN READ. A `stratum.example.com` address is
 * reserved and can never receive mail, so a share, a notification or a password reset sent to it goes
 * nowhere. The address of each person is, in order:
 *
 *   1. their DEMO_*_EMAIL variable, when it is set;
 *   2. `<local>@<inbox domain>` when a test inbox resolves (`lib/test-inbox-config.cjs`), so the mail the
 *      demo's people receive lands in the bucket and `tests/e2e/demo-cast-mail.spec.ts` asserts its
 *      contents. The local parts all begin `demo-`, so none collides with the seed's `basic@`,
 *      `standard@` and `premium@` or the e2e users' `testuser-*`;
 *   3. with no inbox, a plus-address on the presenter's mailbox (`presenterMailbox` in `deploy.config.json`,
 *      `presenter@example.com` when unset), which lands in one mailbox they can open on camera.
 */
const OPS_DEMO_CAST = [
  // The on-call engineer who leads Act 3.2: the person an ops event names, and the login the presenter uses.
  { key: 'onCallLead', local: 'demo-oncall', plus: 'oncall', emailVar: 'DEMO_LEAD_EMAIL', nameVar: 'DEMO_LEAD_NAME', tier: 'premium', groups: ['premium'], name: 'Jordan Reyes' },
  { key: 'platformEngA', local: 'demo-priya', plus: 'priya', emailVar: 'DEMO_ENG_A_EMAIL', tier: 'premium', groups: ['premium'], name: 'Priya Raman' },
  { key: 'platformEngB', local: 'demo-marcus', plus: 'marcus', emailVar: 'DEMO_ENG_B_EMAIL', tier: 'premium', groups: ['premium'], name: 'Marcus Lee' },
  { key: 'engManager', local: 'demo-dana', plus: 'dana', emailVar: 'DEMO_MANAGER_EMAIL', tier: 'premium', groups: ['premium'], name: 'Dana Whitfield' },
  // THE DEMO OPERATOR (DEMO-SCRIPT Act 1.0 to 1.6): one identity in `premium` and `admins`, so the same
  // sign-in opens the chat client and the admin console without the presenter's personal account.
  { key: 'demoAdmin', local: 'demo-admin', plus: 'admin', emailVar: 'DEMO_ADMIN_EMAIL', tier: 'premium', groups: ['premium', 'admins'], name: 'Taylor Brooks' },
  // THE BASIC LOGIN (DEMO-SCRIPT Act 1.7): public access only, someone evaluating Stratum from outside.
  { key: 'basicDemo', local: 'demo-basic', plus: 'basic', emailVar: 'DEMO_BASIC_EMAIL', tier: 'basic', groups: ['basic'], name: 'Sam Rivera' },
  // THE FIRST HALF'S PERSON (DEMO-SCRIPT Act 1, deck slides 1 and 2): James Okafor, VP Sales, who asks
  // Advisor for the Q2 board report.
  { key: 'salesVp', local: 'demo-sales', plus: 'sales', emailVar: 'DEMO_SALES_EMAIL', tier: 'premium', groups: ['premium'], name: 'James Okafor' },
];

/** The presenter's mailbox when `deploy.config.json` names none: a reserved domain, so nothing is ever sent to a real person. */
const DEFAULT_PRESENTER_MAILBOX = 'presenter@example.com';

/**
 * The presenter's mailbox, plus-addressed per person when no test inbox resolves: `presenterMailbox` from
 * `deploy.config.json`, else {@link DEFAULT_PRESENTER_MAILBOX}. A value that is not one plain address is refused
 * by name, so provisioning never invents logins on a mistyped mailbox.
 */
function presenterMailboxOf(config = {}) {
  const value = String((config && config.presenterMailbox) || '').trim().toLowerCase() || DEFAULT_PRESENTER_MAILBOX;
  if (!/^[^@\s+]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    throw new Error(`presenterMailbox in deploy.config.json is "${value}"; it names one address, such as ${DEFAULT_PRESENTER_MAILBOX}, with no plus part`);
  }
  const [local, domain] = value.split('@');
  return { local, domain };
}

/**
 * The cast as provisioning writes it: `{ key, email, tier, groups, name }` per person, each address by the
 * rule above. `inboxDomain` is the resolved test inbox's domain, or '' when there is none; `config` is the
 * deployer's `deploy.config.json`, read for `presenterMailbox`.
 */
function opsDemoCast({ env = {}, inboxDomain = '', config = {} } = {}) {
  const domain = String(inboxDomain || '').trim().toLowerCase();
  const presenter = presenterMailboxOf(config);
  return OPS_DEMO_CAST.map((p) => {
    const override = String(env[p.emailVar] || '').trim();
    const email = override
      || (domain ? `${p.local}@${domain}` : `${presenter.local}+${p.plus}@${presenter.domain}`);
    const name = (p.nameVar && String(env[p.nameVar] || '').trim()) || p.name;
    return { key: p.key, email, tier: p.tier, groups: [...p.groups], name };
  });
}

module.exports = { opsDemoCast, presenterMailboxOf, OPS_DEMO_CAST, DEFAULT_PRESENTER_MAILBOX };
