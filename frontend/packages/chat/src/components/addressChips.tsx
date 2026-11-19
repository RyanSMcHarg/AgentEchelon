import type { ReactNode } from 'react';
import type { Root, RootContent, Parent, Text } from 'mdast';
import {
  TOKEN_PLACEHOLDER,
  shownName,
  tokenText,
  type AddressToken,
  type MemberNameResolver,
} from '@ae/shared/utils/addressTokens.ts';
import './addressChips.css';

/**
 * A mention or private address, drawn as a chip.
 *
 * The chip shows `@Name` or `.Name`: the member's current name when the token's id resolves against
 * the conversation's members, else the name the token was written with. The id, the pipe and the
 * brackets are never drawn. A private address carries a title naming who the message is private to.
 */

/** Whether a string holds a placeholder. Not global, so testing it keeps no state. */
const HAS_PLACEHOLDER = /\d+/;

/** The class every chip carries, and the modifier for each kind. */
export const ADDRESS_CHIP_CLASS = 'message-address-chip';

function chipClass(token: AddressToken): string {
  return `${ADDRESS_CHIP_CLASS} ${ADDRESS_CHIP_CLASS}--${token.kind}`;
}

export interface ChipLabels {
  /** The title a private address carries, given the shown name. */
  privateTitle: (name: string) => string;
}

/** Plain text with placeholders, drawn as text runs and chips. */
export function withAddressChips(
  text: string,
  tokens: AddressToken[],
  labels: ChipLabels,
  resolveName?: MemberNameResolver,
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN_PLACEHOLDER)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = tokens[Number(match[1])];
    if (token) {
      out.push(
        <span
          key={`chip-${at}`}
          className={chipClass(token)}
          title={token.kind === 'address' ? labels.privateTitle(shownName(token, resolveName)) : undefined}
        >
          {tokenText(token, resolveName)}
        </span>,
      );
    }
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * A remark plugin that turns each placeholder into a chip element.
 *
 * It runs on the parsed tree, so markdown has already read the text around the placeholder and a name
 * holding `*`, `_` or `|` is never read as markdown. A placeholder inside code, a link target or an
 * image's alt text becomes the plain form, because those hold a string rather than elements.
 */
export function remarkAddressChips(tokens: AddressToken[], labels: ChipLabels, resolveName?: MemberNameResolver) {
  const plain = (value: string) =>
    value.replace(TOKEN_PLACEHOLDER, (_m, i: string) => {
      const token = tokens[Number(i)];
      return token ? tokenText(token, resolveName) : '';
    });

  const chipNode = (token: AddressToken): RootContent => ({
    type: 'text',
    value: tokenText(token, resolveName),
    data: {
      hName: 'span',
      hProperties: {
        className: chipClass(token).split(' '),
        ...(token.kind === 'address' ? { title: labels.privateTitle(shownName(token, resolveName)) } : {}),
      },
    },
  } as Text);

  const splitText = (node: Text): RootContent[] => {
    const parts: RootContent[] = [];
    let last = 0;
    for (const match of node.value.matchAll(TOKEN_PLACEHOLDER)) {
      const at = match.index ?? 0;
      if (at > last) parts.push({ type: 'text', value: node.value.slice(last, at) });
      const token = tokens[Number(match[1])];
      if (token) parts.push(chipNode(token));
      last = at + match[0].length;
    }
    if (last < node.value.length) parts.push({ type: 'text', value: node.value.slice(last) });
    return parts;
  };

  const visit = (node: Root | RootContent) => {
    const n = node as unknown as Record<string, unknown>;
    for (const key of ['value', 'url', 'alt', 'title'] as const) {
      if (node.type !== 'text' && typeof n[key] === 'string') n[key] = plain(n[key] as string);
    }
    if (!('children' in node)) return;
    const parent = node as Parent;
    const next: RootContent[] = [];
    for (const child of parent.children) {
      if (child.type === 'text' && HAS_PLACEHOLDER.test(child.value)) {
        next.push(...splitText(child));
      } else {
        visit(child);
        next.push(child);
      }
    }
    parent.children = next;
  };

  return () => (tree: Root) => {
    visit(tree);
  };
}
