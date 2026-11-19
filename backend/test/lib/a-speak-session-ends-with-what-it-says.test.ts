/**
 * A SPEAK SESSION ENDS WITH WHAT IT SAYS (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION Phase 1c; SPEC-ASSISTANT-MEETINGS FR27).
 *
 * Outside a turn the router speaks as an assistant on that assistant's speak edge: send, edit and the conversation reads a
 * post makes, as that one bot. A read the router makes after it has spoken (a room's tags, another assistant's roster,
 * the meeting's people) is the router's own, so the speak session is held for the post alone and the router then acts as
 * it did before. Every speak outside a turn goes through the one scoped helper (`speakingAs`); the turn's own route is the
 * only adoption that lasts, and the handler releases it at the turn's end.
 */
import * as fs from 'fs';
import * as path from 'path';
import { adoptAssistantSession, currentAssistantSession, keepingTheTurnsSession, releaseAssistantSession, sessionClient, type AssistantSession } from '../../lambda/src/lib/assistant-session';

const router = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');
const fnOf = (name: string): string => {
  const start = router.search(new RegExp(`\\n(export )?(async )?function ${name}[(<]`));
  expect(start).toBeGreaterThan(-1);
  const next = router.slice(start + 10).search(/\n(export )?(async )?function /);
  return router.slice(start, next < 0 ? undefined : start + 10 + next);
};

const session = (botArn: string): AssistantSession => ({
  assistant: 'advisor', role: 'r', botArn, credentials: { accessKeyId: botArn, secretAccessKey: 's', sessionToken: 't' },
});

describe('the speak session is held for the work it says, and the router acts as before afterwards', () => {
  afterEach(() => releaseAssistantSession());

  it('outside a turn: a conversation call after the post goes out on the router\'s own role', async () => {
    class ChimeSDKMessagingClient {
      constructor(readonly config: { credentials?: { accessKeyId: string } }) {}
      async send(): Promise<string> { return this.config.credentials?.accessKeyId ?? 'router'; }
    }
    const chime = sessionClient(ChimeSDKMessagingClient, {});
    let during = '';
    await keepingTheTurnsSession(async () => {
      adoptAssistantSession(session('bot-primary'), 'messaging');
      during = await chime.send();
    });
    expect(during).toBe('bot-primary');
    expect(currentAssistantSession()).toBeNull();
    expect(await chime.send()).toBe('router');
  });

  it('inside a turn: the turn\'s own session is back once a run\'s send has spoken', async () => {
    adoptAssistantSession(session('bot-turn'), 'messaging');
    await keepingTheTurnsSession(async () => { adoptAssistantSession(session('bot-owner'), 'messaging'); });
    expect(currentAssistantSession()?.botArn).toBe('bot-turn');
  });
});

describe('every speak outside a turn goes through the scoped helper', () => {
  it('the helper records, vends and adopts inside `keepingTheTurnsSession`', () => {
    const helper = fnOf('speakingAs');
    expect(helper).toMatch(/return keepingTheTurnsSession\(async \(\) => \{\s*await speakAsRoutedAssistant\(/);
    expect(helper).toContain('return work();');
  });

  it('the router adopts a speak session in two places only: the helper, and the turn\'s own route', () => {
    const calls = [...router.matchAll(/speakAsRoutedAssistant\(/g)].map((m) => m.index!);
    expect(calls).toHaveLength(2);
    const helper = router.indexOf('async function speakingAs<T>(');
    expect(calls[0]).toBeGreaterThan(helper);
    expect(calls[0]).toBeLessThan(helper + fnOf('speakingAs').length);
    expect(router.slice(calls[1], calls[1] + 200)).toContain('`${SPEAK_ROUTE_PREFIX}router-${randomUUID()}`');
  });

  it.each(['sayMeetingCard', 'sayWorkflowSendOutcome', 'sayNotice', 'startMeetingStep', 'dispatchTaskPickup', 'dispatchRebuttalRound', 'clearDuelMarkers'])(
    '%s speaks through it', (fn) => {
      expect(fnOf(fn)).toContain('speakingAs({');
      expect(fnOf(fn)).not.toContain('releaseAssistantSession(');
    },
  );
});
