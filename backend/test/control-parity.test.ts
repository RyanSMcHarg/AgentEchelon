/**
 * Control-parity invariant (prevention for the "sibling decision missed" class).
 *
 * Every model-dispatch path must run the SAME cross-cutting controls the platform promises, so a NEW
 * path - or a regression that drops a control - fails HERE instead of silently shipping a bypass. This
 * is the guard for the class of gap the security hardening arc closed:
 *   - the @all / /battle dispatch reaching the model without the rate/budget gate (a group-channel
 *     budget-bypass),
 *   - the @all dedup using a fresh random id instead of the stable message id (cross-container
 *     double-invoke),
 *   - the external-LLM branch shipping without applyInputGuardrail (an input-guardrail hole).
 *
 * It is SOURCE-LEVEL (same spirit as docs-drift-guard): it asserts each handler REFERENCES the shared
 * control helper (or its in-file wrapper). It catches "forgot to run the shared control on this path";
 * it does NOT prove the result is used correctly - that is what the behavioral unit + cdk-synth IAM
 * tests cover. The two layers are complementary; keep both.
 *
 * Adding a new model-dispatch path? Add it here with the controls it must run, and the test will hold
 * it to parity with the others.
 */
import * as fs from 'fs';
import { stripComments } from './helpers/strip-comments';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'lambda', 'src');

// The control lives where it is ENFORCED: the entry paths (router, channel-flow) run the pre-dispatch
// gate + fail-closed classification + dedup key + length cap; the async-processor SINK runs the input +
// output guardrails and the dedup CLAIM. A symbol is matched as a substring (covers the shared helper
// and any in-file wrapper, e.g. router's resolveChannelClassificationTag wraps the shared one).
//
// THE CLASSIFICATION CONTROL IS NAMED BY ITS SUFFIX, `ChannelClassificationTag`, because the read is
// what matters and there is now one spelling of it: `readChannelClassificationTag`, which returns
// `undefined` for a tag it cannot read. Matching the suffix keeps the guard working if a path wraps it.
//
// `failClosedValue` IS NO LONGER A CONTROL, AND ITS ABSENCE IS THE POINT (ADR-046).
// It used to be required of the flow separately, because that path applied the fail-closed default
// itself and the read could drift from the default. There is no default: classifications are a set
// with no floor, so an unreadable tag is REFUSED rather than resolved to the least-privileged value.
// Requiring the symbol now would demand the very substitution the boundary work removed - a guard
// that fails the build for doing the right thing. What replaces it as the thing that must not drift
// is the refusal itself, which each path states at its own call site.
const DISPATCH_PATHS: Array<{ file: string; controls: string[]; role: string }> = [
  {
    file: 'router-agent-handler.ts',
    role: 'the 1:1 Lex turn',
    // BOTH dedup keys are minted here now, because the router runs BOTH entries' turns (MESSAGE-FLOW
    // §3.1). A retried turn is only collapsible if both attempts derive the same key, so reverting
    // either to a random id per attempt silently restores the duplicate-reply bug (ADR-022):
    //   - turnCorrelationId  - the Lex entry, derived from a time bucket because Amazon Chime SDK does
    //     not give Lex the inbound message id.
    //   - mentionCorrelationId - the bypass entry, DECLARED from the message id the flow hands over.
    //     It moved here from channel-flow-processor.ts with the @all handoff; it was not dropped.
    controls: [
      'evaluateAbuseGate', 'ChannelClassificationTag', 'capUserMessage',
      'turnCorrelationId', 'mentionCorrelationId',
    ],
  },
  {
    file: 'channel-flow-processor.ts',
    role: 'the @all / @assistant / battle group dispatch',
    // `userMessageId` is the flow's half of the dedup control now. The flow no longer MINTS the @all
    // key - the router does - but the key is only stable because the flow declares the inbound message
    // id. Drop it and the router silently falls back to the 90-second time-bucket derivation, so a
    // cross-container redelivery that straddles a bucket boundary answers twice again. That is the same
    // bug the original mentionCorrelationId entry guarded, one component upstream.
    controls: ['evaluateAbuseGate', 'ChannelClassificationTag', 'userMessageId'],
  },
  {
    file: 'assistant-async-processor.ts',
    role: 'the async processor (Bedrock + external provider branches)',
    controls: ['applyInputGuardrail', 'applyOutputGuardrail'],
  },
  {
    file: 'lib/async-processor-core.ts',
    role: 'the shared model-invocation sink',
    controls: ['applyInputGuardrail', 'applyOutputGuardrail', 'claimCorrelation'],
  },
];

describe('control parity: every model-dispatch path runs the shared controls', () => {
  it.each(DISPATCH_PATHS)('$file ($role) references all its required controls', ({ file, controls, role }) => {
    const abs = path.join(SRC, file);
    const src = fs.readFileSync(abs, 'utf8');
    const missing = controls.filter((c) => !src.includes(c));
    if (missing.length > 0) {
      throw new Error(
        `${file} (${role}) is a model-dispatch path but does NOT reference required control(s): ` +
          `${missing.join(', ')}. Either run the control on this path, or - if it genuinely does not ` +
          `apply here - update DISPATCH_PATHS with the reason. Dropping a control silently is the exact ` +
          `bypass this guard exists to prevent.`,
      );
    }
    expect(missing).toEqual([]);
  });
});

describe('both entries meter the same person by the same rule', () => {
  // WHAT THIS GUARDS IS PARITY, AND THE RULE IT IS PARITY ON CHANGED (maintainer, 2026-08-31).
  //
  // It asserted that each side capped its metering input at min(channel, clearance). That cap is
  // gone from both: one channel has one classification, and IAM decides it (ADR-033). The
  // channel-scoped Allow is applied to the Cognito USER roles as well as the assistant roles,
  // tag-gated and fail-closed, so the state the cap guarded - a basic-clearance member spending in a
  // premium channel - is unreachable; they hold no grant on that channel at all.
  //
  // And the cap cost the case that IS reachable: resolveUserClearance answers `basic` for ANY
  // failure, so a Cognito throttle metered a legitimate premium turn against basic limits.
  //
  // So the parity still holds and is still worth pinning - both sides now meter at the CHANNEL -
  // and this asserts the new rule on both rather than being deleted with the old one.
  const routerSrc = fs.readFileSync(path.join(SRC, 'router-agent-handler.ts'), 'utf8');
  const flowSrc = fs.readFileSync(path.join(SRC, 'channel-flow-processor.ts'), 'utf8');

  it('neither side caps its metering input at the speaker clearance', () => {
    // COMMENT-STRIPPED, because both files RECORD the old rule in prose. The note explaining why the
    // cap was removed contains the very expression this forbids, so a scan of the raw source is
    // satisfied by the explanation rather than by the code - the check would pass on a file that had
    // been reverted, as long as it still carried the comment. Same reason
    // task-shaped-battle-parity.test.ts reads through stripComments.
    expect(stripComments(routerSrc)).not.toMatch(/minRank\(channelClassification, userClearance\)/);
    expect(stripComments(flowSrc)).not.toMatch(/profiles\.min\(classification,/);
  });

  it('both meter at the channel classification, which is the rule they must share', () => {
    expect(routerSrc).toContain('const effectiveClassification = channelClassification;');
    expect(flowSrc).toContain('const effective = classification;');
  });

  it('neither dispatch file grows its own group lookup', () => {
    // The router still resolves clearance - the abuse-exemption isAdmin flag reads it - and must keep
    // taking it from the one implementation. The flow needs no clearance at all now, so the
    // assertion that binds it is the negative one: it must not grow a lookup of its own back.
    expect(routerSrc).toContain("from './lib/user-clearance.js'");
    expect(routerSrc).not.toContain('AdminListGroupsForUserCommand');
    expect(flowSrc).not.toContain('AdminListGroupsForUserCommand');
  });
});
