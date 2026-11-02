/**
 * NO CONVERSATION TYPE OUTLIVES THE DEPLOYMENT'S CONVERSATION LIMIT, AND THE TWO AXES STAY APART.
 *
 * ── TWO MECHANISMS, TWO NUMBERS, AND THE ORDERING BETWEEN THEM IS DELIBERATE ──────────────────────
 *
 * Amazon Chime SDK deletes two different things on two independent timers:
 *
 *   MESSAGE_RETENTION_DAYS (90)      `ChannelRetentionSettings` - deletes MESSAGES past this age in
 *                                    every channel, app-instance-wide. The channel survives.
 *   MAX_CONVERSATION_TTL_DAYS (270)  the limit on a type's `ExpirationSettings` - deletes the whole
 *                                    CONVERSATION, counted from its last message.
 *
 * SO A CONVERSATION OUTLIVES ITS OWN MESSAGES, ON PURPOSE. Nine months of conversation over ninety
 * days of messages means that from day ninety-one a channel holds only recent content, and that is the
 * intended shape: the archive is the system of record for history (tenet D7) while the channel carries
 * current state. The room, its members and its recent exchanges are what a returning person needs; the
 * rest is a query against the archive.
 *
 * THE EARLIER VERSION OF THIS FILE CALLED THAT A DEFECT, and said so at length - "a person opens a
 * conversation that exists, is named, has its membership, and is empty". It refused any type declaring
 * more days than the MESSAGE limit, because one constant served both axes and the distinction had
 * nowhere to live. That reading is wrong under the declared policy, and keeping it would have forced
 * the conversation lifetime down to the message lifetime for no reason anyone chose.
 *
 * WHAT WOULD GENUINELY BE INCOHERENT IS THE REVERSE: messages outliving the conversation that holds
 * them, which is content with no room. That ordering is asserted below rather than assumed, because it
 * is the half that cannot be recovered from - a deleted channel takes its membership and name with it.
 *
 * ── AND WHY NEITHER LIMIT IS DERIVED FROM THE TYPES ───────────────────────────────────────────────
 *
 * Taking a limit as the maximum of the declared types would make it follow configuration rather than
 * bound it: adding a type with a longer life would silently RAISE the deployment's limit, which is
 * the decision a limit exists to stop anybody making by accident. So both are declared, the types are
 * checked against them, and raising one is a deliberate edit to a named constant.
 */
import {
  CONVERSATION_TYPES,
  MAX_CONVERSATION_TTL_DAYS,
  MESSAGE_RETENTION_DAYS,
} from '../lib/config/conversation-types';

describe('the two retention axes', () => {
  it('are both a positive whole number of days', () => {
    // Amazon Chime SDK reads a missing or zero value as "keep everything", so a limit that is not a
    // positive integer is not a loose limit - it is no limit, silently.
    for (const n of [MAX_CONVERSATION_TTL_DAYS, MESSAGE_RETENTION_DAYS]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });

  it('keep the conversation at least as long as the messages inside it', () => {
    // The recoverable direction. A conversation may outlive its messages - the archive holds those -
    // but messages may not outlive the conversation, because deleting a channel takes its membership
    // and its name with it and leaves content addressed to nothing.
    expect(MAX_CONVERSATION_TTL_DAYS).toBeGreaterThanOrEqual(MESSAGE_RETENTION_DAYS);
  });

  it('are separate constants, so one cannot be read as the other', () => {
    // The defect this exists to prevent is not a wrong number, it is a shared name. One constant served
    // both axes, and a 90 day MESSAGE limit was then described - in a deploy report - as bounding a
    // 15 year CONVERSATION lifetime. It does not; nothing about pruning messages stops a channel
    // existing. A test cannot stop a sentence being written, but it can stop the two values becoming
    // one declaration again.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../lib/config/conversation-types.ts'),
      'utf8',
    );
    expect(src).toMatch(/export const MESSAGE_RETENTION_DAYS = \d+;/);
    expect(src).toMatch(/export const MAX_CONVERSATION_TTL_DAYS = \d+;/);
  });
});

describe('the conversation limit bounds every conversation type', () => {
  it('is not exceeded by any shipped type', () => {
    const over = Object.entries(CONVERSATION_TYPES)
      .filter(([, cfg]) => (cfg.expiration?.days ?? 0) > MAX_CONVERSATION_TTL_DAYS)
      .map(([key, cfg]) => `${key}: ${cfg.expiration?.days} days`);
    expect(over).toEqual([]);
  });

  it('every type that declares an expiration counts from a criterion Chime accepts', () => {
    // A type is free to declare no expiration, which reads as "never expires". What it may not do is
    // name a criterion Chime does not evaluate.
    const allowed = ['CREATED_TIMESTAMP', 'LAST_MESSAGE_TIMESTAMP'];
    for (const [, cfg] of Object.entries(CONVERSATION_TYPES)) {
      if (!cfg.expiration) continue;
      expect(allowed).toContain(cfg.expiration.criterion);
      expect(Number.isInteger(cfg.expiration.days)).toBe(true);
    }
  });

  it('counts the ordinary type from the LAST MESSAGE, not from creation', () => {
    // The declared policy is nine months of INACTIVITY. Counting from creation would delete a busy
    // conversation on its anniversary, which is the opposite of what an expiry is for here.
    for (const key of ['general']) {
      const cfg = CONVERSATION_TYPES[key];
      expect(cfg?.expiration?.criterion).toBe('LAST_MESSAGE_TIMESTAMP');
      expect(cfg?.expiration?.days).toBe(MAX_CONVERSATION_TTL_DAYS);
    }
  });
});

describe('the message limit reaches the deployment', () => {
  it('is what the app-instance custom resource is given, not a second copy of the number', () => {
    // The failure this guards is the one this codebase keeps paying for: the same policy stated in two
    // files, drifting. The stack must pass the constant rather than a literal, so a change to the
    // limit reaches the deployment and this check together.
    const stack = require('fs').readFileSync(
      require('path').join(__dirname, '../lib/stacks/messaging-stack.ts'),
      'utf8',
    );
    expect(stack).toContain('RETENTION_DAYS: String(MESSAGE_RETENTION_DAYS)');
    expect(stack).not.toMatch(/RETENTION_DAYS:\s*'?\d+/);
  });
});
