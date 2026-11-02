/**
 * A bot whose Lex fulfillment says nothing must not be invoked on channel-add.
 *
 * WHAT GOES WRONG WITHOUT THIS. Amazon Chime SDK materializes one channel message per Lex turn. A
 * fulfillment that closes with `messages: []` yields no message, and Amazon Chime SDK posts its own
 * status artifact - `{"Code":500}` - into the channel instead. A `WelcomeIntent` is what makes
 * channel-add invoke the fulfillment at all, so giving one to a silent bot puts a status code in
 * front of a person the moment that bot joins a room.
 *
 * This is recorded in prose at all three call sites and was still arrived at twice, on the alt slots
 * and then on the admin assistant, which is why it is a refusal rather than another comment.
 *
 * WHAT THIS CAN AND CANNOT CHECK. It reads the CDK stack sources for the pairing of a silent handler
 * with a `WELCOME_INTENT`, which is a configuration fact visible in the tree. It cannot prove a
 * handler is silent at runtime, so the silent set is named here and asserted to still be silent: if
 * one of them gains a real reply path, this test fails and the pairing is re-decided deliberately
 * rather than inherited.
 *
 * THE CHANNEL FLOW IS THE OTHER HALF, not a replacement for this one. It denies the artifact so a
 * person never reads it (`chimeStatusArtifactCode`, `channel-flow-processor.ts`), but only in a
 * channel that HAS a flow - and the admin notification channel has none. Not producing the artifact
 * and not delivering it are two defenses, and the room with the fewest of them is the one operators
 * watch for alerts.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '..');

/**
 * The fulfillments that deliberately return no message, each with the stack that provisions a bot
 * around it. Named rather than discovered: "which handlers are silent" is a decision, and a test that
 * inferred it would silently stop covering a handler that changed shape.
 */
const SILENT_FULFILLMENTS = [
  {
    handler: 'lambda/src/admin-agent-lex-handler.ts',
    stack: 'lib/stacks/admin-services-stack.ts',
    bot: 'the admin assistant',
  },
];

const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('a silent Lex fulfillment carries no WelcomeIntent', () => {
  it.each(SILENT_FULFILLMENTS)('$bot still returns no message, so the pairing below still applies', ({ handler }) => {
    const src = read(handler);
    // `messages: []` is the whole point: a Lex close that yields nothing for Amazon Chime SDK to post.
    expect(src).toMatch(/messages:\s*\[\s*\]/);
  });

  it.each(SILENT_FULFILLMENTS)('$bot is declared to stay silent when it joins', ({ stack }) => {
    const src = read(stack);
    // Its declaration to the provisioner says `welcome: false` (ADR-048, amended 2026-10-23); anything else
    // invokes the silent fulfillment on channel-add.
    expect(src).toMatch(/assistantId: adminAgent,[^}]*welcome: false/);
    expect(src).not.toMatch(/assistantId: adminAgent,[^}]*welcome: true/);
  });

  it('the provisioner only sets a WelcomeIntent for an assistant declared to greet', () => {
    // The guarantee that makes `welcome: false` mean "no WelcomeIntent". Every identity is built with one
    // builder, so the guarantee is the builder's, checked by what it returns, and the build path asks for a
    // WelcomeIntent only when the declaration says the assistant greets.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { assistantBotConfiguration } = require('../lambda/src/lib/assistant-identity');
    const alias = 'arn:aws:lex:us-east-1:1:bot-alias/B/TSTALIASID';
    expect(assistantBotConfiguration({ lexBotAliasArn: alias, welcomeIntent: '' }).Lex).not.toHaveProperty('WelcomeIntent');
    expect(assistantBotConfiguration({ lexBotAliasArn: alias }).Lex).not.toHaveProperty('WelcomeIntent');
    expect(assistantBotConfiguration({ lexBotAliasArn: alias, welcomeIntent: 'WelcomeIntent' }).Lex.WelcomeIntent).toBe('WelcomeIntent');
    expect(read('lambda/src/lib/assistant-provisioner.ts')).toContain("...(spec.welcome ? { welcomeIntent: 'WelcomeIntent' } : {})");
  });

  it("a duel's alt is declared silent: Battle Mode turning on is announced by the room's primary", () => {
    expect(read('lib/stacks/assistant-profile-stack.ts')).toContain("occupancy: 'alt' as const, displayName: `Alt-${classification}-${role}`, welcome: false");
  });
});
