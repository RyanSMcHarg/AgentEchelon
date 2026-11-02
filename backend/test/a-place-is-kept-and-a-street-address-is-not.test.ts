/**
 * A PLACE IS KEPT, A STREET ADDRESS IS NOT (DESIGN-ADMIN-CONSOLE 5.3).
 *
 * The guardrail reports a city and a street address alike as `ADDRESS`, so the copy applies its matches
 * itself: a bare place name stays readable, anything with a number or a street-level word is masked,
 * every other entity is described, and a pseudonym the copy put there is never mistaken for a name.
 */
import { applyMatches, guardrailDetector } from '../lambda/src/lib/pii-detector';
import { isStreetLevel } from '../lib/config/deidentify-guardrail';

describe('an address match', () => {
  it.each(['Seattle', 'Denver, Colorado', 'United Kingdom', 'Austin TX'])('keeps a bare place: %s', (place) => {
    expect(isStreetLevel(place)).toBe(false);
  });
  it.each(['100 Main Street', 'Suite 4', '221B Baker St', 'SW1A 1AA', 'PO Box 77', 'Elm Ave'])('masks a street-level address: %s', (address) => {
    expect(isStreetLevel(address)).toBe(true);
  });
});

describe('applying the detector\'s matches', () => {
  it('keeps the places, masks the street address and describes everything else', () => {
    const text = 'Fly from Seattle to Denver, then deliver to 100 Main Street. Ask Jane Roe at jane@corp.com.';
    expect(applyMatches(text, [
      { match: 'Seattle', type: 'ADDRESS' },
      { match: 'Denver', type: 'ADDRESS' },
      { match: '100 Main Street', type: 'ADDRESS' },
      { match: 'Jane Roe', type: 'NAME' },
      { match: 'jane@corp.com', type: 'EMAIL' },
    ])).toBe('Fly from Seattle to Denver, then deliver to [a postal address removed]. Ask [a person\'s name removed] at [an email address removed].');
  });

  it('never replaces a pseudonym the copy put there', () => {
    expect(applyMatches('Hi [Person 2], welcome', [{ match: 'Person 2', type: 'NAME' }])).toBe('Hi [Person 2], welcome');
  });

  it('replaces a longer match before a part of it', () => {
    expect(applyMatches('at 9 Elm Ave', [{ match: '9', type: 'PIN' }, { match: '9 Elm Ave', type: 'ADDRESS' }])).toBe('at [a postal address removed]');
  });
});

describe('the guardrail detector', () => {
  const respond = (res: unknown) => ({ send: jest.fn().mockResolvedValue(res) });

  it('applies the matches the guardrail reports, rather than its own rewrite', async () => {
    const client = respond({
      action: 'GUARDRAIL_INTERVENED',
      outputs: [{ text: 'from {ADDRESS} to {ADDRESS}' }],
      assessments: [{ sensitiveInformationPolicy: { piiEntities: [
        { match: 'Seattle', type: 'ADDRESS', action: 'ANONYMIZED' },
        { match: 'Denver', type: 'ADDRESS', action: 'ANONYMIZED' },
      ] } }],
    });
    const d = guardrailDetector('g', '1', client as never);
    expect(await d.anonymize(['from Seattle to Denver'])).toEqual(['from Seattle to Denver']);
  });

  it('falls back to the guardrail\'s rewrite when it intervenes without saying what it found', async () => {
    const client = respond({ action: 'GUARDRAIL_INTERVENED', outputs: [{ text: 'call {PHONE}' }], assessments: [] });
    const d = guardrailDetector('g', '1', client as never);
    expect(await d.anonymize(['call 555 0100'])).toEqual(['call [a phone number removed]']);
  });

  it('leaves text the guardrail did not act on', async () => {
    const client = respond({ action: 'NONE', outputs: [] });
    const d = guardrailDetector('g', '1', client as never);
    expect(await d.anonymize(['nothing personal here'])).toEqual(['nothing personal here']);
  });
});
