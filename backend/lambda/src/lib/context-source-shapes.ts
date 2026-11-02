/**
 * THE SHAPES A CONTEXT SOURCE IS READ BY: a published catalog entry and what a call site has settled. Types only and
 * dependency-free, so the variable resolver (`variables.ts`) and the console that previews with it name them without
 * the resolution module's readers and metrics (`context-sources-runtime.ts`, which re-exports them).
 */

/** Mirrors the published catalog entry (lib/config/context-sources), minus the resource identifiers. */
export interface PublishedContextSource {
  key: string;
  title: string;
  description: string;
  useWhen: string;
  type: string;
  /** The name the reader resolves: bucket, table, parameter or function. Published; never an ARN. */
  locator?: string;
  /** `s3-prefix` only: the key prefix this entry exposes. Published, so the read matches the grant. */
  prefix?: string;
  /** One record per requesting person. Decides whether a missing record is `no-record` or `absent`. */
  perPerson?: boolean;
  trust: 'platform' | 'operator' | 'member';
  availability: 'always' | 'identity-settled' | 'conversation-settled';
  maxBytes: number;
  /** `from` names where the value lives within the source when the field name is not enough
   *  (an S3 object key, or a differing attribute name). See lib/config/context-sources. */
  fields: Record<string, { type: string; optional?: boolean; description: string; from?: string; trust?: 'platform' | 'operator' | 'member' }>;
  contractVersion?: string;
  /** False when the source holds no fact about a person (ADR-060 decision 7). Absent: it describes one. */
  describesPerson?: boolean;
}

/**
 * What the current call site can offer. `WelcomeIntent` fires on the assistant's channel membership,
 * before the creator's membership AND before channel metadata converge, so both of the first flags are
 * false there.
 *
 * `subjectSettled` (ADR-060 decision 4) is true where the participant shape names one subject. The shape
 * is written before the channel exists, so at `WelcomeIntent` a value about that one person is readable
 * even though the sender is not; in a group or an empty conversation there is no one person to read.
 */
export interface CallSiteCapabilities {
  identitySettled: boolean;
  conversationSettled: boolean;
  subjectSettled: boolean;
}

