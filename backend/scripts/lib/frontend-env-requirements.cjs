/**
 * WHICH STACK OUTPUTS THE FRONTEND ENV CANNOT DO WITHOUT, given what the deployment declares.
 *
 * `gen-frontend-env.mjs` writes each output it finds and marks most as optional, because a deployment
 * that does not declare a capability has no stack to read them from. The other direction is the failure
 * worth refusing: a capability that IS declared whose output is missing ships a bundle that cannot reach
 * that capability, and the build succeeds. So each declared capability, and each kind of sign-in the
 * registry declares, names the outputs it needs, and a missing one fails the env generation.
 */

/**
 * The outputs every deployment's clients need: the person API and the app instance. The declared classifications
 * are not an output: the clients read them at load from `GET /classifications` on the person API.
 */
const ALWAYS = ['PersonApiUrl', 'PersonApiCapabilities', 'AppInstanceArnOutput'];

/** The outputs a declared capability's client needs, by capability. */
const BY_CAPABILITY = {
  admin: ['AdminApiUrl', 'AdminApiCapabilities', 'AdminDistributionUrl'],
  widget: ['WidgetDistributionUrl'],
};

/**
 * The outputs this declaration needs that `outputs` lacks, each with why.
 *
 * `capabilities` is the declared list (deploy.config.json `capabilities`); `issuers` the registry, or
 * undefined for the default registry, which is this deployment's own pool alone.
 */
function missingOutputs({ capabilities = [], issuers, outputs = {} }) {
  const need = [];
  for (const key of ALWAYS) need.push({ key, why: 'every client calls the person API' });
  for (const c of capabilities) for (const key of BY_CAPABILITY[c] || []) need.push({ key, why: `${c} is a declared capability` });
  const entries = Array.isArray(issuers) ? issuers : [{ kind: 'cognito-pool', pool: 'self' }];
  const onOwnPool = entries.filter((e) => e && e.pool === 'self' && (e.kind === 'cognito-pool' || e.kind === 'cognito-federated'));
  if (onOwnPool.length) {
    need.push({ key: 'UserPoolId', why: 'the registry declares an issuer on this deployment\'s own pool' });
    need.push({ key: 'UserPoolClientId', why: 'the registry declares an issuer on this deployment\'s own pool' });
  }
  // A provider federating into the own pool signs in through the pool's managed login, which the pool's
  // discovery document points the redirect at.
  if (onOwnPool.some((e) => e.kind === 'cognito-federated')) {
    need.push({ key: 'UserPoolDomainUrl', why: 'a cognito-federated issuer signs in through the pool\'s managed login domain' });
    need.push({ key: 'UserPoolFederatedClientId', why: 'a cognito-federated issuer signs in and refreshes through the pool\'s federated app client' });
  }
  // The widget offers a guest start only with the guest issuer's captcha site key and notice version.
  if (capabilities.includes('widget') && entries.some((e) => e && e.kind === 'guest')) {
    need.push({ key: 'GuestCaptchaSiteKey', why: 'the widget starts a guest with the captcha of the guest issuer' });
    need.push({ key: 'GuestNoticeVersion', why: 'the widget shows the privacy-notice version of the guest issuer' });
    need.push({ key: 'GuestUpgradePaths', why: "the widget offers the upgrade paths the visitor's conversation type declares" });
    need.push({ key: 'GuestSignInUrl', why: 'the widget sends a visitor who keeps the visit to the chat app to sign in' });
  }
  return need.filter(({ key }) => !outputs[key]);
}

module.exports = { missingOutputs, ALWAYS, BY_CAPABILITY };
