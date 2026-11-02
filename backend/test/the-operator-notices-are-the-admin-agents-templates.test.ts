/**
 * THE OPERATOR NOTICES ARE THE ADMIN ASSISTANT'S TEMPLATES (ADR-062 decision 6, slice 3).
 *
 *  - WORD FOR WORD: each notice the admin channel receives is said from a shipped template, and says exactly what its
 *    emitter composed before; the old compositions are frozen here as the oracle, over every case each one had;
 *  - SELECTION: the admin assistant's own template of that name, `templates/admin/_assistants/admin-agent/<name>/`, then
 *    the shipped one; one that does not fit, or cannot be read, is passed over;
 *  - A SERVICE PASSES VALUES AND LABEL NAMES, NEVER TEXT: a rewording of a label reaches the notice;
 *  - DENY, AT SYNTH: the poster reads that one family and its pointers, and no classification's templates, and writes none.
 */
import { Template } from 'aws-cdk-lib/assertions';
import type { EventBridgeEvent } from 'aws-lambda';
import { parseTemplate } from '../lambda/src/lib/document-template';
import {
  adminNoticeTemplate, renderAdminNotice, shippedAdminNotices, shippedAdminNoticeText, type AdminNoticeWords,
} from '../lambda/src/lib/admin-notice-templates';
import { adminNotice, type AlertDetail } from '../lambda/src/lib/admin-notice';
import { renderAlarm } from '../lambda/src/alarm-to-admin-channel';
import { describe as describeRun, runWords } from '../lambda/src/clean-copy-batch';
import { postAlert, wordedNotice } from '../lambda/src/admin-alert-poster';
import { adminServicesStacks } from './helpers/synth';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockSend })),
  SendChannelMessageCommand: jest.fn((input: unknown) => ({ input })),
}));

// ── The compositions the emitters made before, frozen as the oracle ───────────────────────────────

const BEFORE = {
  turnNotStarted: (why: string, classification: string, botArn: string, channelArn: string) => ({
    content: [`A turn could not start: ${why}.`, `Classification: ${classification || 'unknown'}`, `Assistant: ${botArn || 'not resolved'}`, `Conversation: ${channelArn || 'none'}`].join('\n'),
    subject: `[Assistant] A turn could not start in a ${classification || 'unknown'} conversation`,
  }),
  assistantError: (classification: string, errorName: string, truncated: string, taskType: string | undefined, channelArn: string, timestamp: string) => ({
    subject: `Assistant error: ${errorName} (${classification} tier)`,
    content: `**Assistant error** (${classification} tier)\n\n` + `**Error:** ${errorName}\n` + `**Detail:** ${truncated}\n`
      + (taskType ? `**Task:** ${taskType}\n` : '') + `**Channel:** ${channelArn}\n` + `**Time:** ${timestamp}`,
  }),
  recorded: (recorded: string, channelClassification: string, channelArn: string, memberArn: string, issuer: string, at: string) => ({
    content: `Security audit: a member whose last recorded sign-in was cleared for ${recorded} is on a ${channelClassification}-tier conversation.\n`
      + `Channel: ${channelArn}\nMember: ${memberArn}\nIssuer: ${issuer}, recorded ${at}\n`
      + 'This is read from the record of their last sign-in, not their current clearance, so the membership was left in place.',
    subject: `[Security] A recorded clearance does not reach a ${channelClassification} conversation`,
  }),
  uncleared: (kind: 'member' | 'assistant', enforcing: boolean, outcome: 'revoked' | 'already_gone' | 'failed' | 'reported', subjectClearance: string, channelClassification: string, channelArn: string, memberArn: string) => {
    const noun = kind === 'assistant' ? 'assistant' : 'member';
    const verb = enforcing ? 'was removed from' : 'was found on';
    const tail = {
      revoked: 'The membership has been revoked.',
      already_gone: 'The membership was already gone when the audit tried to revoke it.',
      failed: 'The audit could not revoke the membership. It is still in place; remove it by hand and check the audit role.',
      reported: 'Enforcement is off; the membership was left in place. Flip the enforce toggle in the admin dashboard (or set MEMBERSHIP_AUDIT_ENFORCE) to auto-revoke.',
    }[outcome];
    return {
      content: `Security audit: a ${subjectClearance}-tier ${noun} ${outcome === 'failed' ? 'is still on' : verb} a ${channelClassification}-tier conversation.\n`
        + `Channel: ${channelArn}\n${kind === 'assistant' ? 'Assistant' : 'Member'}: ${memberArn}\n${tail}`,
      subject: `[Security] Uncleared ${noun} on a ${channelClassification} conversation`,
    };
  },
  connector: (connectorId: string, personId: string) => ({
    subject: `A ${connectorId} grant could not be revoked at the vendor`,
    content: `A per-person grant for the **${connectorId}** connector failed revocation at the vendor on every retry and has been deleted here. `
      + `Revoke it at the vendor by hand for person \`${personId}\`.`,
  }),
  guest: (flow: string, detail: string) => ({
    subject: 'Guest sessions are refused: a control could not answer',
    content: `Guest ${flow} refused a visitor because something it decides on could not be read: ${detail}. `
      + 'Every guest control fails closed, so visitors are refused until it answers again.',
  }),
  alarm: (a: { AlarmName?: string; NewStateValue: string; AlarmDescription?: string; NewStateReason?: string; StateChangeTime?: string }, link: string) => {
    const name = a.AlarmName || 'an alarm';
    const recovered = a.NewStateValue === 'OK';
    return {
      subject: recovered ? `Recovered: ${name}` : `Alarm: ${name}`,
      content: [
        recovered ? `**Recovered:** ${name}` : `**Alarm:** ${name}`, '',
        a.AlarmDescription ? `**What:** ${a.AlarmDescription}` : '',
        `**CloudWatch:** ${a.NewStateReason || '(no reason given)'}`,
        `**When:** ${a.StateChangeTime}`,
        link ? `**Dashboard:** ${link}` : '',
      ].filter((l) => l !== '').join('\n'),
    };
  },
  cleanCopy: (r: { outcome: 'complete' | 'incomplete' | 'failed'; conversations: number; remaining: number | null; failure?: string; durationMs: number }) => {
    const took = `${Math.round(r.durationMs / 1000)}s`;
    if (r.outcome === 'complete') return `De-identified copy: run complete. ${r.conversations} conversation(s) brought up to date in ${took}; nothing is pending.`;
    if (r.outcome === 'incomplete') {
      return `De-identified copy: run INCOMPLETE. ${r.conversations} conversation(s) brought up to date in ${took}; `
        + `${r.remaining ?? 'some'} still pending, picked up by the next run. For anything urgent, read the conversation in the archive.`;
    }
    return `De-identified copy: run FAILED. ${r.failure ?? 'Unknown failure.'} ${r.conversations} conversation(s) were written first; `
      + 'the rest stay pending and the next run resumes them. For anything urgent, read the conversation in the archive.';
  },
};

const BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/bot/b1';
const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c1';
const MEMBER = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/u1';

describe('each operator notice says word for word what its emitter said', () => {
  it('ships one template per notice, each a message with a chat line and an email subject', () => {
    expect([...shippedAdminNotices().keys()].sort()).toEqual([
      'activated-past-golden-gate', 'assistant-error', 'clean-copy-run', 'cloudwatch-alarm', 'connector-grant-unrevoked', 'guest-unavailable',
      'recorded-clearance-mismatch', 'turn-not-started', 'uncleared-membership',
    ]);
    for (const { template } of shippedAdminNotices().values()) {
      expect(template.kind).toBe('message');
      expect(template.messageSections?.['email.subject']).toBeDefined();
    }
  });

  it('a turn that did not start, with every value and with each missing', () => {
    const say = (why: string, c: string, b: string, ch: string) => shippedAdminNoticeText({
      name: 'turn-not-started',
      values: { why, ...(c ? { classification: c } : {}), ...(b ? { assistant: b } : {}), ...(ch ? { conversation: ch } : {}) },
      labels: { ...(c ? {} : { classification: 'unknown' }), ...(b ? {} : { assistant: 'notResolved' }), ...(ch ? {} : { conversation: 'none' }) },
    });
    for (const [c, b, ch] of [['standard', BOT, CHANNEL], ['', '', ''], ['premium', '', CHANNEL]]) {
      expect(say('the assistant could not be reached', c, b, ch)).toEqual(BEFORE.turnNotStarted('the assistant could not be reached', c, b, ch));
    }
  });

  it('an assistant error, with a task and without', () => {
    for (const task of ['report', undefined]) {
      const words: AdminNoticeWords = { name: 'assistant-error', values: { classification: 'standard', error: 'ThrottlingException', detail: 'Rate exceeded...', ...(task ? { task } : {}), channel: CHANNEL, time: '2026-10-28T10:00:00.000Z' } };
      expect(shippedAdminNoticeText(words)).toEqual(BEFORE.assistantError('standard', 'ThrottlingException', 'Rate exceeded...', task, CHANNEL, '2026-10-28T10:00:00.000Z'));
    }
  });

  it('an activation past the golden gate names the assistant, the version, the refusal, who and why', () => {
    // A notice new with ADR-065 decision 5, so it has no earlier emitter's wording to match: it says each value it is given.
    const said = shippedAdminNoticeText({ name: 'activated-past-golden-gate', values: { assistant: 'advisor', version: '7', refusal: 'GOLDEN_SET_REFUSED', actor: 'person-1', reason: 'Ship the outage fix' } });
    for (const v of ['advisor', '7', 'GOLDEN_SET_REFUSED', 'person-1', 'Ship the outage fix']) expect(said.content).toContain(v);
    expect(said.subject).toBe('advisor was activated past the golden gate');
  });

  it('a recorded clearance that does not reach the conversation', () => {
    expect(shippedAdminNoticeText({ name: 'recorded-clearance-mismatch', values: { recorded: 'basic', classification: 'premium', channel: CHANNEL, member: MEMBER, issuer: 'https://idp.example.com', recordedAt: '2026-10-01T00:00:00Z' } }))
      .toEqual(BEFORE.recorded('basic', 'premium', CHANNEL, MEMBER, 'https://idp.example.com', '2026-10-01T00:00:00Z'));
  });

  it('an uncleared member or assistant, for every outcome, enforcing and not', () => {
    const tails = { revoked: 'revoked', already_gone: 'alreadyGone', failed: 'failed', reported: 'reported' } as const;
    for (const kind of ['member', 'assistant'] as const) {
      for (const enforcing of [true, false]) {
        for (const outcome of ['revoked', 'already_gone', 'failed', 'reported'] as const) {
          const said = shippedAdminNoticeText({
            name: 'uncleared-membership',
            values: { clearance: 'basic', classification: 'premium', channel: CHANNEL, member: MEMBER },
            labels: { noun: kind, verb: outcome === 'failed' ? 'stillOn' : enforcing ? 'removed' : 'found', heading: kind === 'assistant' ? 'assistantHeading' : 'memberHeading', tail: tails[outcome] },
          });
          expect({ kind, enforcing, outcome, said }).toEqual({ kind, enforcing, outcome, said: BEFORE.uncleared(kind, enforcing, outcome, 'basic', 'premium', CHANNEL, MEMBER) });
        }
      }
    }
  });

  it('an unrevoked connector grant, and a guest outage', () => {
    expect(adminNotice({ name: 'connector-grant-unrevoked', values: { connector: 'salesforce', person: 'u1' } }, 'connector_grant_unrevoked'))
      .toMatchObject(BEFORE.connector('salesforce', 'u1'));
    expect(adminNotice({ name: 'guest-unavailable', values: { flow: 'start', detail: 'the kill switch could not be read' } }, 'guest-unavailable'))
      .toMatchObject(BEFORE.guest('start', 'the kill switch could not be read'));
  });

  it('an alarm and a recovery, with and without a description, a reason and a dashboard', () => {
    const cases = [
      { AlarmName: 'Router-errors', NewStateValue: 'ALARM', AlarmDescription: 'The router failed turns. Check its logs.', NewStateReason: 'Threshold Crossed', StateChangeTime: '2026-10-28T10:00:00.000+0000' },
      { AlarmName: 'Router-errors', NewStateValue: 'OK', NewStateReason: 'Back under', StateChangeTime: '2026-10-28T11:00:00.000+0000' },
      { NewStateValue: 'ALARM', StateChangeTime: '2026-10-28T12:00:00.000+0000' },
    ];
    for (const alarm of cases) {
      for (const dashboard of ['', 'Ops']) {
        const now = renderAlarm(alarm as never, { dashboard, region: 'us-east-1' });
        const link = dashboard ? 'https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=Ops' : '';
        expect({ alarm, dashboard, content: now.content, subject: now.subject }).toEqual({ alarm, dashboard, ...BEFORE.alarm(alarm, link) });
      }
    }
  });

  it('a de-identified copy run, for each outcome and each value it may not have', () => {
    const runs = [
      { outcome: 'complete' as const, conversations: 4, remaining: 0, durationMs: 12_400 },
      { outcome: 'incomplete' as const, conversations: 2, remaining: 7, durationMs: 900_000 },
      { outcome: 'incomplete' as const, conversations: 2, remaining: null, durationMs: 900_000 },
      { outcome: 'failed' as const, conversations: 1, remaining: null, failure: 'the guardrail refused.', durationMs: 3_000 },
      { outcome: 'failed' as const, conversations: 0, remaining: null, durationMs: 0 },
    ];
    for (const r of runs) {
      const report = { ...r, startedAt: 'x', failure: r.failure ?? null } as never;
      expect(describeRun(report)).toBe(BEFORE.cleanCopy(r));
      expect(shippedAdminNoticeText(runWords(report)).subject).toBe(BEFORE.cleanCopy(r).split('.')[0]);
    }
  });
});

describe('a notice is said from the admin assistant\'s own template, then the shipped one', () => {
  const words: AdminNoticeWords = { name: 'connector-grant-unrevoked', values: { connector: 'salesforce', person: 'u1' } };
  const own = (chat: string, fields: Record<string, string> = { connector: 'value:id', person: 'value:id' }) => parseTemplate(
    `---\n${JSON.stringify({ kind: 'message', name: 'connector-grant-unrevoked', description: 'd', language: 'en', fields })}\n---\n# chat\n${chat}\n# email.subject\nVendor revoke needed: {{connector}}\n`,
  );

  it('the admin assistant\'s own wording reaches the notice', async () => {
    const out = await wordedNotice(adminNotice(words, 'connector_grant_unrevoked'), async () => own('Revoke {{connector}} for {{person}} by hand, please.'));
    expect(out).toMatchObject({ content: 'Revoke salesforce for u1 by hand, please.', subject: 'Vendor revoke needed: salesforce' });
  });

  it('none in the family, one that asks for a value the emitter does not supply, and a failed read each say the shipped one', async () => {
    const shipped = BEFORE.connector('salesforce', 'u1');
    expect(await wordedNotice(adminNotice(words, 't'), async () => undefined)).toMatchObject(shipped);
    expect(await wordedNotice(adminNotice(words, 't'), async () => own('{{secret}}', { secret: 'value:text' }))).toMatchObject(shipped);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await wordedNotice(adminNotice(words, 't'), async () => { throw new Error('AccessDenied'); })).toMatchObject(shipped);
    warn.mockRestore();
    expect((await adminNoticeTemplate('connector-grant-unrevoked', async () => undefined)).origin).toBe('shipped');
  });

  it('a label the admin assistant rewords reaches the notice, because the emitter names the label, not its words', async () => {
    const t = shippedAdminNotices().get('cloudwatch-alarm')!.source.replace('# label.recovered\nRecovered', '# label.recovered\nBack to normal');
    const reworded = parseTemplate(t);
    const { words: alarmWords } = renderAlarm({ AlarmName: 'X', NewStateValue: 'OK', StateChangeTime: 't' } as never, {});
    expect(renderAdminNotice(reworded, alarmWords)?.subject).toBe('Back to normal: X');
  });

  it('a notice that names no shipped template keeps its carried wording', async () => {
    const carried = { content: 'c', subject: 's', messageType: 't', words: { name: 'not-a-notice', values: {} } };
    expect(await wordedNotice(carried, async () => undefined)).toBe(carried);
  });

  it('the poster posts the admin assistant\'s wording into the channel', async () => {
    process.env.ALERT_INSTANCE = 'agent-echelon';
    process.env.ADMIN_ALERT_CHANNEL_ARN = CHANNEL;
    process.env.ADMIN_ALERT_BEARER_ARN = BOT;
    mockSend.mockResolvedValue({});
    const event = { source: 'ae.alert', 'detail-type': 'connector_grant_unrevoked', detail: { instance: 'agent-echelon', notice: adminNotice(words, 'connector_grant_unrevoked') } } as unknown as EventBridgeEvent<string, AlertDetail>;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await postAlert(event, async () => own('Revoke {{connector}} for {{person}} by hand, please.'))).toEqual({ posted: true });
    log.mockRestore();
    expect(decodeURIComponent(mockSend.mock.calls[0][0].input.Content)).toBe('Revoke salesforce for u1 by hand, please.');
  });
});

describe('the poster reads the admin assistant\'s family and no other, at synth', () => {
  const t = Template.fromStack(adminServicesStacks({}).adminServices);
  const statements = Object.values(t.findResources('AWS::IAM::Policy'))
    .filter((p: any) => JSON.stringify(p.Properties.Roles).includes('AdminAlertPosterFunction'))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  const s3 = statements.filter((s: any) => JSON.stringify(s.Action).includes('s3:'));
  const ssm = statements.filter((s: any) => JSON.stringify(s.Action).includes('ssm:'));

  it('reads bodies only under templates/admin/_assistants/admin-agent/, and writes none', () => {
    expect(s3).toHaveLength(1);
    expect(s3[0].Action).toBe('s3:GetObject');
    expect(JSON.stringify(s3[0].Resource)).toContain('/templates/admin/_assistants/admin-agent/*');
    expect(JSON.stringify(statements)).not.toMatch(/s3:(PutObject|DeleteObject|ListBucket)/);
  });

  it('reads only that family\'s pointers', () => {
    const pointers = ssm.filter((s: any) => s.Action === 'ssm:GetParameter' && JSON.stringify(s.Resource).includes('/templates/'));
    expect(pointers).toHaveLength(1);
    expect(JSON.stringify(pointers[0].Resource)).toContain('/assistant/admin/templates/_assistants/admin-agent/*');
    expect(JSON.stringify(statements)).not.toMatch(/ssm:PutParameter/);
  });

  it('names no classification\'s template family and no other assistant\'s', () => {
    const text = JSON.stringify(statements);
    for (const c of ['basic', 'standard', 'premium']) expect(text).not.toContain(`templates/${c}/`);
    expect(text).not.toMatch(/templates\/admin\/\*/);
    expect(text).not.toMatch(/templates\/admin\/_assistants\/\*/);
  });
});

describe('the dashboard link names the region by its code', () => {
  // The alarm's SNS payload carries `Region` as a display name ("US East (N. Virginia)"), which makes a broken host.
  it('reads the code from the alarm ARN, never the display name', async () => {
    const { renderAlarm, alarmRegionCode } = await import('../lambda/src/alarm-to-admin-channel');
    const alarm = {
      AlarmName: 'a', NewStateValue: 'ALARM' as const, Region: 'US East (N. Virginia)',
      AlarmArn: 'arn:aws:cloudwatch:eu-west-2:123456789012:alarm:a',
    };
    expect(alarmRegionCode(alarm)).toBe('eu-west-2');
    const { content } = renderAlarm(alarm, { dashboard: 'd' });
    expect(content).toContain('https://eu-west-2.console.aws.amazon.com/cloudwatch/home?region=eu-west-2#dashboards:name=d');
    expect(content).not.toContain('N. Virginia).console');
  });
  it('falls back to the configured region when the ARN is absent', async () => {
    const { renderAlarm } = await import('../lambda/src/alarm-to-admin-channel');
    const { content } = renderAlarm({ AlarmName: 'a', NewStateValue: 'ALARM', Region: 'US East (N. Virginia)' }, { dashboard: 'd', region: 'us-west-2' });
    expect(content).toContain('https://us-west-2.console.aws.amazon.com/');
  });
});
