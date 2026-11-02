import { describe, it, expect } from 'vitest';
import { botArnFor, botIdFromArn, isAssistantArn, isPersonArn, personIdFromArn, userArnFor } from './principalArn';

const APP = 'arn:aws:chime:us-east-1:123456789012:app-instance/0f3c-1a2b';

describe('principalArn', () => {
  it('reads a person id, including the admin twin and ids with dashes and colons', () => {
    expect(personIdFromArn(`${APP}/user/6b1e-2f4a`)).toBe('6b1e-2f4a');
    expect(personIdFromArn(`${APP}/user/6b1e-2f4a-admin`)).toBe('6b1e-2f4a-admin');
    expect(personIdFromArn(`${APP}/user/a:b_c@d`)).toBe('a:b_c@d');
    expect(isPersonArn(`${APP}/user/u`)).toBe(true);
  });

  it('reads a bot id, and keeps the two kinds apart', () => {
    expect(botIdFromArn(`${APP}/bot/advisor`)).toBe('advisor');
    expect(personIdFromArn(`${APP}/bot/advisor`)).toBeNull();
    expect(botIdFromArn(`${APP}/user/u`)).toBeNull();
    expect(isAssistantArn(`${APP}/bot/advisor`)).toBe(true);
    expect(isAssistantArn(`${APP}/user/u`)).toBe(false);
  });

  it('returns null for malformed input', () => {
    for (const bad of ['', undefined, null, 'bare-id', `${APP}/user/`, `${APP}/user/a/b`, '/user/x']) {
      expect(personIdFromArn(bad)).toBeNull();
      expect(botIdFromArn(bad)).toBeNull();
      expect(isAssistantArn(bad)).toBe(false);
    }
  });

  it('builds ARNs that read back to the same id', () => {
    expect(userArnFor(APP, 'u-1')).toBe(`${APP}/user/u-1`);
    expect(personIdFromArn(userArnFor(APP, 'u-1'))).toBe('u-1');
    expect(botArnFor(APP, 'advisor')).toBe(`${APP}/bot/advisor`);
  });
});
