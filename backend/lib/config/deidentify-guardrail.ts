/**
 * THE DE-IDENTIFICATION GUARDRAIL (DESIGN-ADMIN-CONSOLE 5.3).
 *
 * A guardrail with one job: replace personal data with a typed placeholder. It is separate from the
 * assistants' guardrail on purpose. That one deliberately leaves contact details alone, because
 * colleagues share names and addresses as the ordinary content of work (`bedrock-guardrails.ts`); the
 * de-identified copy exists so that what was said can be read without who said it, so here every entity
 * type the service recognizes is anonymized, and nothing is blocked - a blocked message would leave the
 * copy with a refusal where the conversation had text.
 *
 * Over-masking is the safe direction. The assistants' guardrail measured the phone detector firing on
 * ordinary arithmetic ("3 + 3"), which ruined answers; in a copy read for review it costs a little
 * meaning and never exposes anybody.
 */
import type * as bedrock from 'aws-cdk-lib/aws-bedrock';

/** Every entity type Amazon Bedrock Guardrails detects, each anonymized. */
export const DEIDENTIFY_PII_TYPES = [
  'ADDRESS', 'AGE', 'AWS_ACCESS_KEY', 'AWS_SECRET_KEY', 'CA_HEALTH_NUMBER', 'CA_SOCIAL_INSURANCE_NUMBER',
  'CREDIT_DEBIT_CARD_CVV', 'CREDIT_DEBIT_CARD_EXPIRY', 'CREDIT_DEBIT_CARD_NUMBER', 'DRIVER_ID', 'EMAIL',
  'INTERNATIONAL_BANK_ACCOUNT_NUMBER', 'IP_ADDRESS', 'LICENSE_PLATE', 'MAC_ADDRESS', 'NAME', 'PASSWORD',
  'PHONE', 'PIN', 'SWIFT_CODE', 'UK_NATIONAL_HEALTH_SERVICE_NUMBER', 'UK_NATIONAL_INSURANCE_NUMBER',
  'UK_UNIQUE_TAXPAYER_REFERENCE_NUMBER', 'URL', 'USERNAME', 'US_BANK_ACCOUNT_NUMBER', 'US_BANK_ROUTING_NUMBER',
  'US_INDIVIDUAL_TAX_IDENTIFICATION_NUMBER', 'US_PASSPORT_NUMBER', 'US_SOCIAL_SECURITY_NUMBER',
  'VEHICLE_IDENTIFICATION_NUMBER',
] as const;

export function deidentifyGuardrailPolicy(name: string): bedrock.CfnGuardrailProps {
  return {
    name,
    description: 'Replaces personal data with a typed placeholder in the de-identified conversation copy',
    // Required by the service; unreachable, because nothing in this policy blocks.
    blockedInputMessaging: 'Withheld.',
    blockedOutputsMessaging: 'Withheld.',
    sensitiveInformationPolicyConfig: {
      piiEntitiesConfig: DEIDENTIFY_PII_TYPES.map((type) => ({ type, action: 'ANONYMIZE' })),
    },
  };
}

export type DeidentifyPiiType = (typeof DEIDENTIFY_PII_TYPES)[number];

/**
 * WHAT A READER SEES IN PLACE OF WHAT WAS REMOVED. The guardrail writes a terse tag (`{EMAIL}`); the copy
 * shows what kind of thing was there, so a reader still knows that someone gave an address, a card
 * number or a name, and the sentence still reads. Keyed by the same list the guardrail is built from, so
 * a type added there without a description here does not compile.
 */
export const PLACEHOLDER_DESCRIPTION: Record<DeidentifyPiiType, string> = {
  ADDRESS: 'a postal address',
  AGE: "a person's age",
  AWS_ACCESS_KEY: 'an AWS access key',
  AWS_SECRET_KEY: 'an AWS secret key',
  CA_HEALTH_NUMBER: 'a Canadian health number',
  CA_SOCIAL_INSURANCE_NUMBER: 'a Canadian social insurance number',
  CREDIT_DEBIT_CARD_CVV: 'a card security code',
  CREDIT_DEBIT_CARD_EXPIRY: 'a card expiry date',
  CREDIT_DEBIT_CARD_NUMBER: 'a payment card number',
  DRIVER_ID: "a driver's license number",
  EMAIL: 'an email address',
  INTERNATIONAL_BANK_ACCOUNT_NUMBER: 'an international bank account number',
  IP_ADDRESS: 'an IP address',
  LICENSE_PLATE: 'a license plate',
  MAC_ADDRESS: 'a device hardware address',
  NAME: "a person's name",
  PASSWORD: 'a password',
  PHONE: 'a phone number',
  PIN: 'a PIN',
  SWIFT_CODE: 'a bank SWIFT code',
  UK_NATIONAL_HEALTH_SERVICE_NUMBER: 'a UK NHS number',
  UK_NATIONAL_INSURANCE_NUMBER: 'a UK National Insurance number',
  UK_UNIQUE_TAXPAYER_REFERENCE_NUMBER: 'a UK taxpayer reference',
  URL: 'a web address',
  USERNAME: 'a username',
  US_BANK_ACCOUNT_NUMBER: 'a bank account number',
  US_BANK_ROUTING_NUMBER: 'a bank routing number',
  US_INDIVIDUAL_TAX_IDENTIFICATION_NUMBER: 'a US taxpayer ID',
  US_PASSPORT_NUMBER: 'a passport number',
  US_SOCIAL_SECURITY_NUMBER: 'a Social Security number',
  VEHICLE_IDENTIFICATION_NUMBER: 'a vehicle identification number',
};

/**
 * Replace the guardrail's tags with their descriptions: `{EMAIL}` becomes `[an email address removed]`.
 * Only the tags this policy produces are touched, so braces that were part of what somebody wrote stay.
 */
export function describePlaceholders(text: string): string {
  return text.replace(/\{([A-Z_]+)\}/g, (tag, type: string) =>
    type in PLACEHOLDER_DESCRIPTION ? `[${PLACEHOLDER_DESCRIPTION[type as DeidentifyPiiType]} removed]` : tag);
}

/**
 * WHETHER AN ADDRESS MATCH IS A STREET ADDRESS OR JUST A PLACE. The detector reports both as `ADDRESS`:
 * "100 Main Street, Suite 4" and "Seattle" alike. A street address points at somebody; a city, region or
 * country on its own rarely does, and masking it takes the meaning out of ordinary work ("a trip from
 * Seattle to Denver"). So a match with a number (a house number, a suite, a postal code) or a street-level
 * word is masked, and a bare place name is kept.
 */
const STREET_WORDS = /\b(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|suite|ste|apt|apartment|unit|floor|fl|building|bldg|highway|hwy|parkway|pkwy|terrace|box|p\.?\s?o\.?)\b/i;
export function isStreetLevel(match: string): boolean {
  return /\d/.test(match) || STREET_WORDS.test(match);
}

/**
 * What one detector match is replaced with, or null to keep it as written: a bare place name, and a
 * pseudonym the copy itself put there (`[Person 2]`), which a detector may read as a name.
 */
export function replacementFor(type: string, match: string): string | null {
  if (/^\[?Person \d+\]?$/.test(match.trim())) return null;
  if (type === 'ADDRESS' && !isStreetLevel(match)) return null;
  const description = PLACEHOLDER_DESCRIPTION[type as DeidentifyPiiType];
  return `[${description ?? 'personal data'} removed]`;
}
