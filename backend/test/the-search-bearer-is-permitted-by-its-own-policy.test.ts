/**
 * THE PRINCIPAL THAT BEARS THE CHANNEL SEARCH IS PERMITTED TO BEAR IT.
 *
 * `scoped-channels.ts` bears `SearchChannels` as the ASSISTANT. That was a deliberate change on
 * 2026-09-30, measured against the live API with a control, replacing an earlier belief that a bot could
 * not bear at all. The IAM grant in `assistant-profile-stack.ts` was NOT widened with it: it listed the
 * app instance and `user/*`, and its comment still asserted the belief the measurement had disproved.
 *
 * WHAT THAT COST, and why it survived a month. Every search came back `AccessDeniedException` on a `bot/*`
 * resource. The caller fails CLOSED and suggests nothing - correct behavior for a refusal - so
 * cross-conversation suggestions simply never appeared, no user saw an error, and the only trace was a WARN
 * line. It was found on 2026-10-02 because an e2e refuses to pass a turn that logged one.
 *
 * So this asserts the two halves agree. It is a SOURCE check on purpose: the bearer lives in Lambda code and
 * the grant lives in CDK, there is no runtime where both are present, and the failure mode is precisely that
 * someone changes one and not the other.
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripComments } from './lib/strip-comments';

const BACKEND = path.join(__dirname, '..');
const SCOPED = path.join(BACKEND, 'lambda', 'src', 'lib', 'scoped-channels.ts');
const PROFILE_STACK = path.join(BACKEND, 'lib', 'stacks', 'assistant-profile-stack.ts');

/** Comments stripped with the scanning stripper: both files discuss bearers and ARNs in prose at length. */
const code = (file: string): string => stripComments(fs.readFileSync(file, 'utf8'));

/** The `SearchChannels` policy statement's resource list, as written in the stack. */
const searchChannelsResources = (): string => {
  const src = code(PROFILE_STACK);
  const at = src.indexOf("'chime:SearchChannels'");
  // The stack must grant chime:SearchChannels at all.
  expect(at).toBeGreaterThan(-1);
  // The statement is one object literal; take the window after the action up to its close.
  const window = src.slice(at, at + 600);
  const resources = window.match(/resources:\s*\[([\s\S]*?)\]/);
  // The statement must list resources.
  expect(resources).toBeTruthy();
  return resources![1];
};

describe('the channel-search bearer', () => {
  it('is the assistant, in the code that performs the search', () => {
    // If this ever goes back to a human bearer, the grant assertion below becomes the wrong requirement -
    // so the two are checked together rather than the grant being asserted on its own.
    const src = code(SCOPED);
    expect(src).toMatch(/ChimeBearer:\s*(?:input\.)?bearerArn/);
  });

  it('is granted SearchChannels on a bot resource, because a bot is what bears it', () => {
    const resources = searchChannelsResources();
    // The assistant bears the search, so a bot resource has to be permitted. Without it every search is
    // refused, the caller fails closed, and nobody sees a suggestion or an error.
    expect(resources).toMatch(/\/bot\/\*/);
  });

  it('keeps the human resource too, because a human bears the membership-limit retry', () => {
    // Only the BEARER is limit-checked, and the assistant grows fastest. When the service refuses it for
    // that limit a human asks the same question, so removing `user/*` would break the fallback silently.
    expect(searchChannelsResources()).toMatch(/\/user\/\*/);
  });

  it('still carries the app-instance resource the operation itself is scoped to', () => {
    expect(searchChannelsResources()).toMatch(/appInstanceArn/);
  });
});
