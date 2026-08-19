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
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'lambda', 'src');

// The control lives where it is ENFORCED: the entry paths (router, channel-flow) run the pre-dispatch
// gate + fail-closed classification + dedup key + length cap; the async-processor SINK runs the input +
// output guardrails and the dedup CLAIM. A symbol is matched as a substring (covers the shared helper
// and any in-file wrapper, e.g. router's resolveChannelClassificationTag wraps the shared one).
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
      'evaluateAbuseGate', 'resolveChannelClassificationTag', 'capUserMessage',
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
    controls: ['evaluateAbuseGate', 'resolveChannelClassificationTag', 'userMessageId'],
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
  // The router charges an ordinary turn at min(channel, clearance); the flow charges the /battle
  // fan-out - the most expensive dispatch - for the same sender. While the flow had no clearance
  // input it charged at the CHANNEL classification, so a basic-clearance member of a premium channel
  // who was over their own ceiling could keep spending via /battle. Failed open: the duel still
  // answered, which is why nothing surfaced it.
  const routerSrc = fs.readFileSync(path.join(SRC, 'router-agent-handler.ts'), 'utf8');
  const flowSrc = fs.readFileSync(path.join(SRC, 'channel-flow-processor.ts'), 'utf8');

  it('each side applies the effective-min rule to its metering input', () => {
    expect(routerSrc).toMatch(/minRank\(channelClassification, userClearance\)/);
    expect(flowSrc).toMatch(/profiles\.min\(classification, \(await resolveUserClearance\(userSub\)\)\.clearance\)/);
  });

  it('clearance has ONE implementation, imported by both, so the two cannot drift', () => {
    expect(routerSrc).toContain("from './lib/user-clearance.js'");
    expect(flowSrc).toContain("from './lib/user-clearance.js'");
    // Neither dispatch file may grow its own group lookup back.
    expect(routerSrc).not.toContain('AdminListGroupsForUserCommand');
    expect(flowSrc).not.toContain('AdminListGroupsForUserCommand');
  });
});
