/**
 * THE INVITATION LANDING PAGE ON THE CHAT APP'S ORIGIN (`invite.html`, M-5, M-10): where every invitation's link
 * lands (`invitationLandingFor`). The page is the one the widget's origin also serves (`@ae/widget/invitation-landing`):
 *
 *  - a `sign-in` invitation sends its holder to this app's root to sign in or sign up, with the token in the
 *    fragment (`#invitation=`); `main.tsx` takes it from there, the first sign-in redeems it, and the person
 *    lands in the conversation;
 *  - a `link` invitation is redeemed on this page, and the session it vends, for the one conversation, is
 *    hosted here.
 *
 * It mounts nothing of the signed-in app: a link invitee holds no account and no Cognito session.
 */
import { mountInvitationLanding } from '@ae/widget/invitation-landing';

mountInvitationLanding(document.getElementById('root')!);
