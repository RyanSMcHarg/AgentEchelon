/**
 * SES sending-identity ARNs for an IAM resource scope.
 *
 * Why this is not just `identity/${senderEmail}`: SES authorizes `ses:SendEmail` against **the
 * identity it resolves the From address to**, and when the address is covered by a verified DOMAIN
 * that resolved identity is the DOMAIN, not the address. A policy scoped only to
 * `identity/assistant@example.com` is then denied with the domain ARN in the message:
 *
 *   not authorized to perform `ses:SendEmail' on resource `.../identity/example.com'
 *
 * That is a silent failure in practice - the notification path collects send failures rather than
 * throwing (`lambda/src/lib/notification.ts`), so the caller's request still succeeds and no email
 * is ever delivered. Verifying the address identity ALONE also works, so which of the two identities
 * SES picks depends on deployment-time verification choices this stack does not control.
 *
 * Granting both is still least-privilege: two named identities, no wildcard, and the deployer's own
 * verification decides which one SES actually uses.
 */
export function sesSenderIdentityArns(
  region: string,
  account: string,
  senderEmail: string,
): string[] {
  const arn = (identity: string) => `arn:aws:ses:${region}:${account}:identity/${identity}`;
  const domain = senderEmail.includes('@') ? senderEmail.split('@').pop() : undefined;
  return domain ? [arn(senderEmail), arn(domain)] : [arn(senderEmail)];
}
