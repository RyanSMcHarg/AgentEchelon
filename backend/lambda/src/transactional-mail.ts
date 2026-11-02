/**
 * THE TRANSACTIONAL MAIL FUNCTION, in `Notifications`: sends an invitation's or a registration's sign-in
 * link for the `Conversations` functions that issue it (`lib/transactional-mail.ts`). Invoked directly, by
 * those two functions' roles alone; it is on no API. Answers `{ sent }`.
 */
import { sendTransactionalMail, transactionalMailOf } from './lib/transactional-mail.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

export async function handler(event: unknown): Promise<{ sent: boolean }> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const mail = transactionalMailOf(event);
  if (!mail) {
    console.warn('[TransactionalMail] refused: not a mail this function sends');
    return { sent: false };
  }
  try {
    return { sent: await sendTransactionalMail(mail) };
  } catch (err) {
    console.warn('[TransactionalMail] the send failed', { mail: mail.mail, err: (err as { name?: string })?.name || '' });
    return { sent: false };
  }
}
