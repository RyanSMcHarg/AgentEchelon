/**
 * A MESSAGE'S `Target` AND WHAT IT SAYS ABOUT ITSELF MUST AGREE (`targetIntegrity.ts`).
 *
 * What it proves: a received message that opens with a private address, or that an assistant stamped for a person, its
 * `Target` does not name is an error; a person's own Metadata raises none; and a draft that reads as private to a member
 * is refused unless its send targets that member.
 */
import { describe, expect, it } from 'vitest';
import { draftReadsAsPrivateTo, privateAddressId, receivedTargetMismatch, sendTargetMismatch } from './targetIntegrity';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
const SAM = `${APP}/user/sam-id`;
const RYAN = `${APP}/user/ryan-id`;
const OPS = `${APP}/bot/ops-id`;
const members = [
  { userArn: SAM, name: 'Sam' },
  { userArn: `${APP}/user/samlee-id`, name: 'Sam Lee' },
  { userArn: RYAN, name: 'Ryan McHarg' },
  { userArn: OPS, name: 'Ops' },
];

describe('a received message', () => {
  it('agrees when its private address names the member its Target names', () => {
    expect(receivedTargetMismatch({ text: '.<Sam|sam-id> hello', metadata: {}, targetArns: [SAM], senderIsAssistant: false })).toBeUndefined();
    expect(receivedTargetMismatch({ text: '/md .<Ops|ops-id> **hi**', metadata: {}, targetArns: [OPS], senderIsAssistant: false })).toBeUndefined();
  });

  it('DENY: a private address with no Target, or a Target naming someone else, is an error', () => {
    expect(receivedTargetMismatch({ text: '.<Sam|sam-id> hello', metadata: {}, targetArns: [], senderIsAssistant: false })).toBe('address');
    expect(receivedTargetMismatch({ text: '.<Sam|sam-id> hello', metadata: {}, targetArns: [RYAN], senderIsAssistant: false })).toBe('address');
  });

  it('DENY: an assistant\'s reply stamped for a person its Target does not name is an error', () => {
    expect(receivedTargetMismatch({ text: 'here you go', metadata: { targetedSender: SAM }, targetArns: [], senderIsAssistant: true })).toBe('assistant');
    expect(receivedTargetMismatch({ text: 'here you go', metadata: { targetedSender: SAM }, targetArns: [RYAN], senderIsAssistant: true })).toBe('assistant');
    expect(receivedTargetMismatch({ text: 'here you go', metadata: { targetedSender: SAM }, targetArns: [SAM], senderIsAssistant: true })).toBeUndefined();
  });

  it('a person\'s own Metadata says nothing: it neither raises the error nor makes a message private', () => {
    expect(receivedTargetMismatch({ text: 'hello', metadata: { targetedSender: SAM }, targetArns: [], senderIsAssistant: false })).toBeUndefined();
  });

  it('an ordinary message, a mention, and a dot that carries no id raise nothing', () => {
    expect(receivedTargetMismatch({ text: 'hello @<Sam|sam-id>', metadata: {}, targetArns: [], senderIsAssistant: false })).toBeUndefined();
    expect(receivedTargetMismatch({ text: '.env is missing', metadata: {}, targetArns: [], senderIsAssistant: false })).toBeUndefined();
    expect(privateAddressId('.<Sam> hello')).toBeUndefined();
    expect(privateAddressId('.<Sam|sam-id> hello')).toBe('sam-id');
  });
});

describe('a draft addressed to a member the person picked', () => {
  const twoSams = [
    { userArn: `${APP}/user/sender-id`, name: 'Sam' },
    { userArn: SAM, name: 'Sam' },
    { userArn: `${APP}/user/sam2-id`, name: 'Sam' },
  ];
  const picked = (id: string) => ({ text: '.Sam hi', mentions: [{ start: 0, end: 4, token: `.<Sam|${id}>` }] });

  it('is read by the id the pick carries, never by the first member sharing the name', () => {
    expect(draftReadsAsPrivateTo(picked('sam2-id'), twoSams).map((m) => m.userArn)).toEqual([`${APP}/user/sam2-id`]);
    expect(sendTargetMismatch(picked('sam2-id'), twoSams, `${APP}/user/sam2-id`)).toBeUndefined();
    expect(sendTargetMismatch(picked('sam-id'), twoSams, SAM)).toBeUndefined();
  });

  it('DENY: is refused where the send targets another member of the same name', () => {
    expect(sendTargetMismatch(picked('sam2-id'), twoSams, SAM)?.userArn).toBe(`${APP}/user/sam2-id`);
  });

  it('typed by hand, reads as every member of that name, and a send to any of them is not refused', () => {
    expect(draftReadsAsPrivateTo('.Sam hi', twoSams)).toHaveLength(3);
    expect(sendTargetMismatch('.Sam hi', twoSams, `${APP}/user/sam2-id`)).toBeUndefined();
  });
});

describe('a draft that reads as private', () => {
  it('reads the member by their whole name after a leading dot, the longest name first', () => {
    expect(draftReadsAsPrivateTo('.Sam hello', members)[0]?.userArn).toBe(SAM);
    expect(draftReadsAsPrivateTo('.Sam Lee hello', members)[0]?.name).toBe('Sam Lee');
    expect(draftReadsAsPrivateTo('/md .ryan mcharg hi', members)[0]?.userArn).toBe(RYAN);
    expect(draftReadsAsPrivateTo('.Samantha hello', members)).toEqual([]);
    expect(draftReadsAsPrivateTo('.env is missing', members)).toEqual([]);
    expect(draftReadsAsPrivateTo('hello .Sam', members)).toEqual([]);
  });

  it('DENY: is refused where the send would not target that member', () => {
    // The picked address was edited away: the field still reads `.Ryan McHarg`, and the send would go to the room.
    expect(sendTargetMismatch('.Ryan McHarg the numbers are bad', members, undefined)?.userArn).toBe(RYAN);
    // Or it would go privately to somebody else.
    expect(sendTargetMismatch('.Sam Lee hello', members, SAM)?.name).toBe('Sam Lee');
  });

  it('is sent where the send targets that member, and an ordinary draft is never refused', () => {
    expect(sendTargetMismatch('.Ryan McHarg hello', members, RYAN)).toBeUndefined();
    expect(sendTargetMismatch('hello everyone', members, undefined)).toBeUndefined();
    expect(sendTargetMismatch('@Sam hello', members, undefined)).toBeUndefined();
  });
});
