/**
 * THE ONE ADDRESS AN EMAIL GOES TO, for a person no directory knows yet: a directory that answers for that
 * one AppInstanceUser alone, with the address somebody typed for this one email. It finds nobody by that
 * address (K2) and answers nothing about anybody else, so the fan-out (`emailPeople`) resolves its one
 * recipient exactly as it resolves every other.
 *
 * Two senders use it: an invitation, to the address the inviter typed (`invitations.ts`), and a claim, to
 * the address a visitor registered (`guest-upgrade.ts`). In both the address is a delivery route, and the
 * token in the email's link is what carries the person anywhere.
 */
import type { Directory } from './membership-source.js';

export function oneRecipientDirectory(personArn: string, address: string, name: string): Directory {
  const none = async () => null;
  return {
    personsInGroup: async () => ({ members: [], unreadable: [] }) as never,
    admins: async () => ({ members: [], unreadable: [] }) as never,
    personOf: none,
    groupsFor: none,
    clearedByGroups: none,
    clearanceOf: async () => ({ classifications: [] }) as never,
    listGroups: async () => [],
    displayNameFor: async (arn: string) => (arn === personArn ? name : null),
    contactFor: async (arn: string, route: string) => (arn === personArn && route === 'email' ? { address, name } as never : null),
    findByAddress: none,
    // It knows no account at any issuer, so it vouches for none.
    accountState: async () => 'gone',
  } as Directory;
}
