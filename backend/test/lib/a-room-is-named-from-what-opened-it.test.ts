/**
 * A ROOM THE PLATFORM OPENS FOR A PURPOSE IS NAMED FROM THAT PURPOSE AT CREATION (`conversation-name.ts`).
 *
 * What it proves:
 *  - the order: the type's own `name`, then (for a room an event opened) the label, the alarm with its service, the
 *    summary, then the platform's default for the kind of room (a room an event opened is named by its type), and the
 *    placeholder only for a room with no purpose;
 *  - a room's subject is a noun phrase, never the summary sentence its name may fall back to;
 *  - a name is cut by whole characters and always fits an Amazon Chime SDK channel name;
 *  - each default is a section of the `conversation-name` message template, so a template stored for the room's
 *    assistant or classification words it, and a name keeps its own script;
 *  - each creation path hands its name to the one creator: the typed creator from the opening's fields, and the
 *    classification's creator for a visit's continuation;
 *  - a person's own conversation keeps the placeholder, which is the only name its first message replaces.
 */
const mockMessagingSend = jest.fn();
const mockSsmSend = jest.fn();
const mockCreate = jest.fn();
const mockResolveAllowedSet = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockMessagingSend })),
  SendChannelMessageCommand: jest.fn().mockImplementation((input) => ({ __type: 'SendMessage', input })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListTags', input })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListMemberships', input })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ __type: 'GetParameter', input })),
}));
jest.mock('../../lambda/src/lib/channel-creation', () => ({
  createConversationFromEvent: (...args: unknown[]) => mockCreate(...args),
}));
jest.mock('../../lambda/src/lib/service-admin-bearer', () => ({ resolveServiceAdminBearer: async () => '' }));
jest.mock('../../lambda/src/lib/default-agents', () => ({ resolveDefaultAgents: async () => [] }));
jest.mock('../../lambda/src/lib/membership-source', () => ({
  defaultDirectory: () => ({}),
  resolveAllowedSet: (...args: unknown[]) => mockResolveAllowedSet(...args),
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  conversationNameFor, conversationNameText, conversationSubjectFor, declaredTypeName, PLACEHOLDER_TITLE, CONVERSATION_NAME_TEMPLATE,
  CHANNEL_NAME_MAX_UNITS, MAX_CONVERSATION_NAME_LENGTH,
} from '../../lambda/src/lib/conversation-name';
import { CONVERSATION_TYPES, conversationNameErrors } from '../../lib/config/conversation-types';
import { OPENER_FIELDS, PLATFORM_EVENT_FIELDS, openerInput } from '../../lib/config/event-openers';
import { shippedSourceWith } from '../../lambda/src/lib/shipped-message-templates';
import { parseTemplate } from '../../lambda/src/lib/document-template';
// The real one: this file stands the creator's call in for it, so it is required past the mock.
const { sanitizeTitle } = jest.requireActual('../../lambda/src/lib/channel-creation') as typeof import('../../lambda/src/lib/channel-creation');
import type { MessageTemplateSet } from '../../lambda/src/lib/message-lines';

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/inst';
const BOT = `${APP_INSTANCE}/bot/advisor`;
const LEAD = `${APP_INSTANCE}/user/on-call`;
const CONCERNED = `${APP_INSTANCE}/channel/conv-platform-on-call`;

process.env.APP_INSTANCE_ARN = APP_INSTANCE;
process.env.CLASSIFICATION = 'premium';
process.env.BOT_ARN_PARAM = '/test/bot-arn';
process.env.CHANNEL_FLOW_ARN_PARAM = '/test/flow-arn';
process.env.USER_POOL_ID = 'us-east-1_pool';

/** A set holding one classification-wide `conversation-name` template with these sections reworded. */
function storedWording(sections: Record<string, string>): MessageTemplateSet {
  const template = parseTemplate(shippedSourceWith(CONVERSATION_NAME_TEMPLATE, sections));
  return { own: new Map(), classwide: new Map([[CONVERSATION_NAME_TEMPLATE, template]]) };
}

/** Declare a `name` on a shipped type for one test. */
function withTypeName<T>(typeKey: string, name: string, run: () => T): T {
  const before = CONVERSATION_TYPES[typeKey].name;
  CONVERSATION_TYPES[typeKey].name = name;
  try {
    return run();
  } finally {
    if (before === undefined) delete CONVERSATION_TYPES[typeKey].name;
    else CONVERSATION_TYPES[typeKey].name = before;
  }
}

describe('the order a room is named in', () => {
  it('a room an event opened: its label first', () => {
    expect(conversationNameFor({ kind: 'opened', typeKey: 'ops', values: { label: 'Checkout latency', alarm: 'p99-latency', summary: 'Slow.' } }))
      .toBe('Checkout latency');
  });

  it('then the alarm it watches, with the service the event names', () => {
    expect(conversationNameFor({ kind: 'opened', typeKey: 'ops', values: { alarm: 'p99-latency', service: 'AWS/Lambda' } })).toBe('p99-latency Alarm on AWS/Lambda');
    expect(conversationNameFor({ kind: 'opened', typeKey: 'ops', values: { alarm: 'p99-latency' } })).toBe('p99-latency Alarm');
  });

  it('then the summary, then the room\'s type: a room an event opened always has a purpose, so never the placeholder', () => {
    expect(conversationNameFor({ kind: 'opened', typeKey: 'ops', values: { summary: 'Report generation is running slow.' } }))
      .toBe('Report generation is running slow.');
    expect(conversationNameFor({ kind: 'opened', typeKey: 'ops', values: {} })).toBe('Ops Room');
    expect(conversationNameFor({ kind: 'opened', values: {} })).toBe(PLACEHOLDER_TITLE);
  });

  it('its subject is the label, the alarm form or the type, and never the summary sentence', () => {
    expect(conversationSubjectFor({ typeKey: 'ops', values: { label: 'Checkout latency', summary: 'Slow.' } })).toBe('Checkout latency');
    expect(conversationSubjectFor({ typeKey: 'ops', values: { alarm: 'p99-latency', service: 'AWS/Lambda', summary: 'Slow.' } })).toBe('p99-latency Alarm on AWS/Lambda');
    expect(conversationSubjectFor({ typeKey: 'ops', values: { summary: 'Report generation is running slow.' } })).toBe('Ops');
  });

  it('the type\'s default is worded where every message is worded', () => {
    const words = { templates: storedWording({ 'label.opened': 'Incident room ({{type}})', 'label.openedSubject': 'the {{type}} incident' }) };
    expect(conversationNameFor({ kind: 'opened', typeKey: 'ops', values: {}, words })).toBe('Incident room (Ops)');
    expect(conversationSubjectFor({ typeKey: 'ops', values: { summary: 'Slow.' }, words })).toBe('the Ops incident');
  });

  it('the platform default for each other kind of room', () => {
    expect(conversationNameFor({ kind: 'visitor', typeKey: 'guest-visitor' })).toBe('Visitor Chat');
    expect(conversationNameFor({ kind: 'customer', typeKey: 'customer-engagement' })).toBe('Continued Visitor Chat');
    expect(conversationNameFor({ kind: 'briefing', values: { date: '2026-10-30' } })).toBe('2026-10-30 Briefing');
    expect(conversationNameFor({ kind: 'adminNotifications' })).toBe('Admin Notifications');
  });

  it('the type\'s own name comes before every default, filled from the opening', () => {
    withTypeName('ops', 'Incident: {{alarm}} ({{service}})', () => {
      expect(conversationNameFor({ kind: 'opened', typeKey: 'ops', values: { label: 'Ignored label', alarm: 'p99-latency', service: 'AWS/Lambda' } }))
        .toBe('Incident: p99-latency (AWS/Lambda)');
    });
    withTypeName('guest-visitor', 'Website visit {{date}}', () => {
      expect(conversationNameFor({ kind: 'visitor', typeKey: 'guest-visitor', values: { date: '2026-10-30' } })).toBe('Website visit 2026-10-30');
    });
  });

  it('a type\'s name that inserts a field the opening lacks is passed over, never rendered with a hole', () => {
    withTypeName('ops', '{{alarm}} on {{service}}', () => {
      expect(declaredTypeName('ops', { alarm: 'p99-latency' })).toBe('');
      expect(conversationNameFor({ kind: 'opened', typeKey: 'ops', values: { label: 'Checkout latency', alarm: 'p99-latency' } })).toBe('Checkout latency');
    });
  });

  it('every shipped type\'s name inserts only fields an opening carries, and a typo is named', () => {
    expect(conversationNameErrors(CONVERSATION_TYPES)).toEqual([]);
    expect(conversationNameErrors({ broken: { name: '{{alarmName}} down' } })).toEqual([expect.stringContaining('{{alarmName}}')]);
    expect(conversationNameErrors({ empty: { name: '  ' } })).toEqual([expect.stringContaining('empty name')]);
  });

  it('a person\'s own conversation declares no name: it opens with the placeholder its first message replaces', () => {
    expect(CONVERSATION_TYPES.general.name).toBeUndefined();
    expect(sanitizeTitle(PLACEHOLDER_TITLE)).toBe(PLACEHOLDER_TITLE);
    expect(sanitizeTitle('')).toBe(PLACEHOLDER_TITLE);
  });
});

describe('a name is worded where every message is worded, and keeps its own script', () => {
  it('a template stored for the room\'s assistant or classification words each default', () => {
    const words = { templates: storedWording({ 'label.visitor': 'Besuch', 'label.alarm.service': '{{service}}: {{alarm}}' }) };
    expect(conversationNameFor({ kind: 'visitor', typeKey: 'guest-visitor', words })).toBe('Besuch');
    expect(conversationNameFor({ kind: 'opened', typeKey: 'ops', values: { alarm: 'p99', service: 'AWS/Lambda' }, words })).toBe('AWS/Lambda: p99');
  });

  it('a label in any script is a name, not an empty string', () => {
    expect(conversationNameText('決済 API の遅延')).toBe('決済 API の遅延');
    expect(conversationNameText('تأخير الدفع')).toBe('تأخير الدفع');
    expect(sanitizeTitle('Café réservation')).toBe('Café réservation');
    expect(conversationNameText('a <b>bold</b>\u0000 move')).toBe('a b bold /b move');
  });

  it('a long label is cut at a word, within the limit', () => {
    const name = conversationNameText('word '.repeat(40));
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith('word')).toBe(true);
  });

  it('a cut never splits a character: an astral-plane name over the limit keeps whole characters', () => {
    // CJK Extension B: every ideograph is a surrogate pair, so a cut by code unit lands inside one at an odd index.
    const name = conversationNameText('\u{20000}\u{20001}\u{20002}'.repeat(40));
    expect(Array.from(name)).toHaveLength(MAX_CONVERSATION_NAME_LENGTH);
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(name.endsWith('\u{20002}') || name.endsWith('\u{20001}') || name.endsWith('\u{20000}')).toBe(true);
    // One letter in front puts every pair boundary at an odd unit, where a cut by unit would split the 80th.
    const odd = conversationNameText(`a${'\u{20000}'.repeat(100)}`);
    expect(odd).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(Array.from(odd)).toHaveLength(MAX_CONVERSATION_NAME_LENGTH);
    // A letter and the marks that combine with it are one character, and stay together.
    // (`q` has no precomposed form with these marks, so NFC keeps all three.)
    const marked = conversationNameText('q\u0301\u0302'.repeat(100));
    expect(marked.endsWith('q\u0301\u0302')).toBe(true);
    expect(marked.length).toBe(MAX_CONVERSATION_NAME_LENGTH * 3);
  });

  it('every name fits an Amazon Chime SDK channel name: 1 to 256 units, printable, no control characters', () => {
    // The service admits tab, newline, carriage return and printable text, with no lone surrogate (the API reference
    // for CreateChannel and UpdateChannel, `Name`).
    const CHIME_NAME = /^[\u0009\u000A\u000D\u0020-\u007E\u0085\u00A0-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]{1,256}$/u;
    const samples = [
      'Checkout latency', '決済 API の遅延', 'تأخير الدفع', '\u{20000}'.repeat(300), 'a\u0301'.repeat(300),
      'x\u0000y\u0007z\u2028w\uD800', '<script>alert(1)</script>', ' \t padded \n ',
    ];
    for (const raw of samples) {
      const name = conversationNameText(raw);
      expect(name.length).toBeLessThanOrEqual(CHANNEL_NAME_MAX_UNITS);
      expect(name).toMatch(CHIME_NAME);
    }
    for (const kind of ['visitor', 'customer', 'briefing', 'adminNotifications', 'opened'] as const) {
      expect(conversationNameFor({ kind, typeKey: 'ops', values: { date: '2026-10-30' } })).toMatch(CHIME_NAME);
    }
  });
});

describe('an opener carries the service a room is named from', () => {
  it('is a field an opener may fill, and the platform event carries it', () => {
    expect(OPENER_FIELDS).toContain('service');
    expect(PLATFORM_EVENT_FIELDS.service).toBe('$.detail.service');
    expect(openerInput({ source: 'aws.cloudwatch', detailType: 'CloudWatch Alarm State Change', fields: {
      watchesAlarm: '$.detail.alarmName', service: '$.detail.configuration.metrics[0].metricStat.metric.namespace',
    } }, { detail: { alarmName: 'p99-latency', configuration: { metrics: [{ metricStat: { metric: { namespace: 'AWS/Lambda' } } }] } } }))
      .toEqual({ watchesAlarm: 'p99-latency', service: 'AWS/Lambda' });
  });
});

// ── THE TYPED CREATOR NAMES THE ROOM IT OPENS ──────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../lambda/src/typed-conversation-from-event');

describe('the typed creator opens the room with its name', () => {
  beforeEach(() => {
    mockMessagingSend.mockReset().mockImplementation(async (cmd: any) => (cmd.__type === 'ListTags' ? { Tags: [{ Key: 'classification', Value: 'premium' }] } : {}));
    mockSsmSend.mockReset().mockImplementation(async (cmd: any) => ({
      Parameter: { Value: cmd.input.Name === '/test/bot-arn' ? BOT : `${APP_INSTANCE}/channel-flow/flow` },
    }));
    mockResolveAllowedSet.mockReset().mockResolvedValue({ admitted: new Set([LEAD]), refused: [], undetermined: new Set() });
    mockCreate.mockReset().mockResolvedValue({ channelArn: `${APP_INSTANCE}/channel/conv-ops-new`, channelId: 'conv-ops-new' });
  });

  const open = (detail: Record<string, unknown>) => handler({ detail: { conversationType: 'ops', concernedChannelArn: CONCERNED, forUserArn: LEAD, ...detail } });

  it('from the event\'s label', async () => {
    expect((await open({ topicLabel: 'Report latency', summary: 'Report generation is running slow.' })).ok).toBe(true);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ name: 'Report latency', topicLabel: 'Report latency' });
  });

  it('with no label, its subject is the room\'s type, never the summary sentence its name came from', async () => {
    expect((await open({ summary: 'Card payments are failing.' })).ok).toBe(true);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ name: 'Card payments are failing.', topicLabel: 'Ops' });
  });

  it('with nothing to go on, it is named and introduced by its type, never the placeholder', async () => {
    expect((await open({})).ok).toBe(true);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ name: 'Ops Room', topicLabel: 'Ops' });
    expect(mockCreate.mock.calls[0][0].name).not.toBe(PLACEHOLDER_TITLE);
  });

  it('from the alarm it watches and its service, which is also the room\'s subject', async () => {
    expect((await open({ watchesAlarm: 'checkout-p99', service: 'AWS/Lambda' })).ok).toBe(true);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ name: 'checkout-p99 Alarm on AWS/Lambda', topicLabel: 'checkout-p99 Alarm on AWS/Lambda', watchedAlarm: 'checkout-p99' });
  });

  it('from its summary when it carries no label and no alarm, never from the type\'s key', async () => {
    expect((await open({ summary: 'Card payments are failing.' })).ok).toBe(true);
    expect(mockCreate.mock.calls[0][0].name).toBe('Card payments are failing.');
    expect(mockCreate.mock.calls[0][0].name).not.toBe('ops');
  });

  it('from the type\'s own name where the type declares one', async () => {
    CONVERSATION_TYPES.ops.name = 'Incident {{label}}';
    try {
      await open({ topicLabel: 'Report latency' });
    } finally {
      delete CONVERSATION_TYPES.ops.name;
    }
    expect(mockCreate.mock.calls[0][0].name).toBe('Incident Report latency');
  });
});

describe('every creation path names its room through the one order', () => {
  const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
  const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

  it('the classification\'s creator names a visitor\'s and a customer\'s room from its assistant\'s templates', () => {
    const creator = read('create-conversation-at-classification.ts');
    expect(creator).toMatch(/creationReads\(timer, \{ kind: 'visitor', typeKey: GUEST_VISITOR_TYPE \}\)/);
    expect(creator.match(/creationReads\(timer, \{ kind: 'customer', typeKey: target\.typeKey \}\)/g)).toHaveLength(2);
    expect(creator).toMatch(/loadMessageTemplateSet\(\{ classification: CLASSIFICATION/);
  });

  it('the name\'s template read runs beside the creation reads once the primary is known, not after them', () => {
    const creator = read('create-conversation-at-classification.ts');
    const reads = creator.slice(creator.indexOf('function creationReads('), creator.indexOf('async function roomName('));
    expect(reads).toMatch(/return Promise\.all\(\[\s*primary,[\s\S]*naming \? primary\.then\(\(p\) => roomName\(naming\.kind, naming\.typeKey, p\?\.assistant, timer\)\)/);
    expect(creator).not.toMatch(/await roomName\(/);
  });

  it('the briefing and the admin notification channel are named from their classification\'s stored templates', () => {
    const briefing = read('proactive-briefing.ts');
    expect(briefing).toMatch(/loadMessageTemplateSet\(\{ classification \}\)/);
    expect(briefing).toMatch(/conversationNameFor\(\{ kind: 'briefing', values: \{ date: [^}]+\}, \.\.\.\(templates \? \{ words: \{ templates \} \} : \{\}\) \}\)/);
    const admin = read('admin-notification-channel-provision.ts');
    expect(admin).toMatch(/loadMessageTemplateSet\(\{ classification: adminChannelClassification\(\) \}\)/);
    expect(admin).toMatch(/conversationNameFor\(\{ kind: 'adminNotifications', \.\.\.\(templates \? \{ words: \{ templates \} \} : \{\}\) \}\)/);
    for (const src of [briefing, admin]) expect(src).not.toMatch(/name\.(briefing|adminNotifications)/);
    expect(read('lib/channel-creation.ts')).not.toMatch(/sanitizeTitle\('(Visitor|Conversation)'\)/);
  });

  it('a proposal opens its room with its draft as the label, and never the type\'s key', () => {
    expect(read('proposals-api.ts')).not.toMatch(/topicLabel: record\.draft \|\| record\.conversationType/);
  });
});

describe('every default name is one style', () => {
  it('a short Title Case noun phrase, its most specific context first and the kind of room last', () => {
    const SAMPLE = { type: 'Ops Team', alarm: 'p99-latency', service: 'AWS/Lambda', date: '2026-10-30', label: 'Checkout latency' };
    const named: Record<string, string> = {
      opened: conversationNameFor({ kind: 'opened', typeKey: 'ops-team' }),
      alarm: conversationNameFor({ kind: 'opened', typeKey: 'ops', values: { alarm: SAMPLE.alarm } }),
      alarmOnService: conversationNameFor({ kind: 'opened', typeKey: 'ops', values: { alarm: SAMPLE.alarm, service: SAMPLE.service } }),
      visitor: conversationNameFor({ kind: 'visitor', typeKey: 'guest-visitor' }),
      continued: conversationNameFor({ kind: 'customer', typeKey: 'customer-engagement' }),
      briefing: conversationNameFor({ kind: 'briefing', values: { date: SAMPLE.date } }),
      admin: conversationNameFor({ kind: 'adminNotifications' }),
    };
    expect(named).toEqual({
      opened: 'Ops Team Room',
      alarm: 'p99-latency Alarm',
      alarmOnService: 'p99-latency Alarm on AWS/Lambda',
      visitor: 'Visitor Chat',
      continued: 'Continued Visitor Chat',
      briefing: '2026-10-30 Briefing',
      admin: 'Admin Notifications',
    });
    for (const name of Object.values(named)) {
      // Every word the platform writes is capitalized; the inserted context keeps its own form, and "on" joins two.
      const platformWords = name.replace(/p99-latency|AWS\/Lambda|2026-10-30/g, '').split(/\s+/).filter(Boolean).filter((w) => w !== 'on');
      for (const w of platformWords) expect(w.charAt(0)).toBe(w.charAt(0).toUpperCase());
      expect(name.split(/\s+/).length).toBeLessThanOrEqual(6);
    }
  });
});

describe('the room\'s primary assistant manages the channel, including its name', () => {
  const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });

  it('every UpdateChannel that sets a name is the primary\'s, or writes back the name it read', () => {
    // The rename from a first message (as the primary's routed session) and the admin notification channel (as the Admin
    // Assistant, its primary) set a name; every other UpdateChannel writes back the name the channel already has.
    const PRIMARY_BEARS = new Map([
      ['lib/channel-title.ts', /ChimeBearer: botArn,/],
      ['admin-notification-channel-provision.ts', /ChimeBearer: ADMIN_AGENT_BOT_ARN,/],
    ]);
    const KEEPS_NAME = /Name: (described\.Channel\?\.Name|currentName \|\| title|current\.Channel\?\.Name \|\| title|name),/;
    const sites: string[] = [];
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      for (const m of src.matchAll(/new UpdateChannelCommand\(\{([\s\S]*?ChimeBearer:[^\n]*)/g)) {
        sites.push(rel);
        const call = m[1];
        if (!/\bName:/.test(call)) continue;
        const bears = PRIMARY_BEARS.get(rel);
        if (bears) expect({ rel, primary: bears.test(call) }).toEqual({ rel, primary: true });
        else expect({ rel, keepsName: KEEPS_NAME.test(call) }).toEqual({ rel, keepsName: true });
      }
    }
    expect(sites).toEqual(expect.arrayContaining(['lib/channel-title.ts', 'admin-notification-channel-provision.ts']));
  });

  it('the first-message rename and the alt-first naming run act as the primary\'s own session', () => {
    const title = fs.readFileSync(path.join(SRC, 'lib', 'channel-title.ts'), 'utf8');
    expect(title).toMatch(/const messagingClient = sessionClient\(ChimeSDKMessagingClient/);
    const processor = fs.readFileSync(path.join(SRC, 'assistant-async-processor.ts'), 'utf8');
    expect(processor.indexOf('if (event.nameRoom) {')).toBeGreaterThan(processor.indexOf('await adoptTurnIdentity(event.correlationId'));
  });

  it('every room has its primary as a moderator: the one creator adds it, and the admin assistant creates its channel', () => {
    const creation = fs.readFileSync(path.join(SRC, 'lib', 'channel-creation.ts'), 'utf8');
    // The core every origin goes through (a person's room, an event's, a visitor's, a continued visit's, a briefing).
    expect(creation).toMatch(/new CreateChannelModeratorCommand\(\{\s*ChannelArn: channelArn,\s*ChannelModeratorArn: input\.botArn,/);
    for (const origin of ['createConversationForPerson', 'createConversationFromEvent', 'createConversationForGuest', 'createConversationForUpgrade', 'createConversationForBriefing']) {
      const body = creation.slice(creation.indexOf(`export async function ${origin}(`));
      expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(/createConversationCore\(/);
    }
    // A reopened context conversation seats its assistant as a moderator again.
    expect(creation).toMatch(/for \(const arn of \[input\.botArn, input\.userArn\]\)[\s\S]{0,400}CreateChannelModeratorCommand/);
    const admin = fs.readFileSync(path.join(SRC, 'admin-notification-channel-provision.ts'), 'utf8');
    expect(admin).toMatch(/botArn: ADMIN_AGENT_BOT_ARN,/);
  });
});

describe('a reopened context room is named from its context by its creator', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { contextRoomName } = require('../../lambda/src/lib/conversation-name');
  it("follows the host's new title while it still carries the title it was named from", () => {
    expect(contextRoomName('Q3 plan', 'Q3 plan', 'Q3 plan (revised)')).toBe('Q3 plan (revised)');
  });
  it('keeps a name a person or its primary gave it since', () => {
    expect(contextRoomName('Renewal prep with Acme', 'Q3 plan', 'Q3 plan (revised)')).toBe('Renewal prep with Acme');
  });
  it('keeps its name when the title it was named from cannot be read', () => {
    expect(contextRoomName('Q3 plan', undefined, 'Q3 plan (revised)')).toBe('Q3 plan');
  });
  it("takes the host's title when it has no name at all", () => {
    expect(contextRoomName(undefined, undefined, 'Q3 plan')).toBe('Q3 plan');
  });
  it('the creator reads only the title it named the room from, and only that attribute is granted', () => {
    const creator = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'constructs', 'conversation-creator.ts'), 'utf8');
    expect(creator).toContain("'dynamodb:Attributes': ['topic']");
    expect(creator).toContain("'dynamodb:Select': 'SPECIFIC_ATTRIBUTES'");
  });
});
