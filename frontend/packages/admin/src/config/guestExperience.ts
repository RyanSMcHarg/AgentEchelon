/**
 * THE GUEST EXPERIENCE IS NOT SHOWN IN THE CONSOLE YET.
 *
 * "All of the guest details, guest funnel, etc need to be hidden (not necessary to fully remove) from the dashboard
 * until later. I don't have the guest experience fully defined and built yet."
 *
 * Hidden, not removed: the guest panel, the guest-to-customer funnel, guest registrations and the visitor toggle and
 * label in Manage users stay in the code and render when this is true. Their queries are not run while it is false,
 * so hiding them costs nothing. Changing it is a code change and a frontend deploy, on purpose: it follows the
 * guest experience being built, not an operator's preference.
 */
export const GUEST_EXPERIENCE_SHOWN = false;
