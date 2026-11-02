/**
 * The invitation landing page's entry on the widget's origin (`invite.html`, M-5): the alternative client an
 * invitation may land in. Every invitation lands in the chat app today, which mounts the same page
 * (`landing.tsx`).
 */
import { mountInvitationLanding } from './landing';

mountInvitationLanding(document.getElementById('root')!);
