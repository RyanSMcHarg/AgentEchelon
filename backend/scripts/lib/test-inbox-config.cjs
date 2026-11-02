/**
 * WHERE THE E2E SUITE READS TEST USERS' MAIL, decided from what the deployer configured. Pure, so the
 * rules are exercised without an account (`test/provision-test-users-secret.test.ts`).
 *
 * Two ways to have an inbox, and the suite does not care which:
 *
 *   EXISTING - the deployer already receives mail for a domain into S3 through an SES receipt rule that
 *              is not this deployment's. They declare it in `deploy.config.json` (`testInboxBucket`,
 *              `testInboxPrefix`, with `testInboxDomain` naming the domain), so a fresh deploy keeps it,
 *              or name it at provisioning: TEST_EMAIL_DOMAIN, TEST_INBOX_BUCKET, TEST_INBOX_PREFIX.
 *   NEW      - the opt-in TestInbox stack (`testInboxDomain` with no `testInboxBucket`) created one and
 *              published it to SSM under `/<instance>/test-inbox/`.
 *
 * The environment wins over the config, and the config over SSM: naming an inbox by hand is the more
 * deliberate act, and a declared inbox is the deployment's record of one it does not own.
 *
 * Returns `{ inbox, emailDomain, source, problem }`. `inbox` is null when there is none, and the delivery
 * tests then skip saying so. `source` names where the inbox came from ('' when there is none). `problem`
 * is a configuration that cannot work and is refused rather than written: test users on one domain and an
 * inbox on another would make every delivery test time out.
 */
const DEFAULT_EMAIL_DOMAIN = 'agentechelon.test';

const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();

function resolveTestInbox({ env = {}, config = {}, ssm = {} } = {}) {
  const fromEnv = str(env.TEST_INBOX_BUCKET);
  const declaredDomain = str(env.TEST_EMAIL_DOMAIN).toLowerCase();
  const configBucket = str(config.testInboxBucket);
  const configDomain = str(config.testInboxDomain).toLowerCase();

  let inbox = null;
  let source = '';
  if (fromEnv) {
    if (!declaredDomain) {
      return { inbox: null, emailDomain: '', source: '', problem: 'TEST_INBOX_BUCKET is set without TEST_EMAIL_DOMAIN: name the domain whose mail that bucket receives' };
    }
    inbox = { bucket: fromEnv, prefix: str(env.TEST_INBOX_PREFIX), domain: declaredDomain };
    source = 'environment';
  } else if (configBucket) {
    if (!configDomain) {
      return { inbox: null, emailDomain: '', source: '', problem: 'deploy.config.json sets testInboxBucket without testInboxDomain: name the domain whose mail that bucket receives' };
    }
    inbox = { bucket: configBucket, prefix: str(config.testInboxPrefix), domain: configDomain };
    source = 'deploy.config.json';
  } else if (str(ssm.bucket) && str(ssm.domain)) {
    inbox = { bucket: str(ssm.bucket), prefix: str(ssm.prefix), domain: str(ssm.domain).toLowerCase() };
    source = 'TestInbox stack';
  }

  const emailDomain = declaredDomain || (inbox && inbox.domain) || DEFAULT_EMAIL_DOMAIN;
  if (inbox && inbox.domain !== emailDomain) {
    return {
      inbox: null,
      emailDomain,
      source: '',
      problem: `test users are on ${emailDomain} but the inbox receives ${inbox.domain}: no test email would ever arrive`,
    };
  }
  return { inbox, emailDomain, source, problem: '' };
}

/**
 * Whether provisioning has to look in SSM for the TestInbox stack's inbox: only when neither the
 * environment nor the config names one. A dry run reads nothing from AWS, so it never does.
 */
function needsSsmLookup({ env = {}, config = {}, dryRun = false } = {}) {
  return !dryRun && !str(env.TEST_INBOX_BUCKET) && !str(config.testInboxBucket);
}

module.exports = { resolveTestInbox, needsSsmLookup, DEFAULT_EMAIL_DOMAIN };
