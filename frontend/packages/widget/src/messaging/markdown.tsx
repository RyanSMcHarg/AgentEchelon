// A small, dependency-free, XSS-safe Markdown renderer for message bubbles.
//
// The frame is a small bundle, so it builds React elements from a small parser rather than carrying a
// Markdown library. It never uses dangerouslySetInnerHTML, and link hrefs are limited to http(s) and
// mailto, so neither a model nor a prompt-injected message can inject markup or a javascript: URL.
// Covers paragraphs, bullet and numbered lists, headings, bold, italic, inline code, links and bare URLs.

import type { ReactNode } from 'react';

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
function safeHref(url: string): string | null {
  const u = url.trim();
  return SAFE_URL.test(u) ? u : null;
}

// ── Inline parsing ──────────────────────────────────────────────────────────────────────────
// Order matters: code spans first (so their contents aren't re-parsed), then links, then emphasis,
// then bare URLs. Each pass splits text nodes and leaves already-built elements untouched.

type Node = string | ReactNode;

function splitByRegex(
  nodes: Node[],
  re: RegExp,
  make: (m: RegExpExecArray, key: string) => ReactNode,
): Node[] {
  const out: Node[] = [];
  let k = 0;
  for (const node of nodes) {
    if (typeof node !== 'string') {
      out.push(node);
      continue;
    }
    let last = 0;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(node))) {
      if (m.index > last) out.push(node.slice(last, m.index));
      out.push(make(m, `i${k++}`));
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++; // guard against zero-width matches
    }
    if (last < node.length) out.push(node.slice(last));
  }
  return out;
}

function hideBroken(e: { currentTarget: HTMLImageElement }): void {
  e.currentTarget.style.display = 'none';
}

function parseInline(text: string): ReactNode[] {
  let nodes: Node[] = [text];
  // `code`
  nodes = splitByRegex(nodes, /`([^`]+)`/g, (m, key) => (
    <code key={key} className="aeaw__code">
      {m[1]}
    </code>
  ));
  // ![alt](url): a Markdown image (https only); broken images hide themselves.
  nodes = splitByRegex(nodes, /!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g, (m, key) => (
    <img key={key} className="aeaw__img" src={m[2]} alt={m[1]} loading="lazy" onError={hideBroken} />
  ));
  // bare https image URL (by extension) → inline image
  nodes = splitByRegex(nodes, /(https:\/\/[^\s<>()]+\.(?:png|jpe?g|gif|webp|avif))(?:\?[^\s<>()]*)?/gi, (m, key) => (
    <img key={key} className="aeaw__img" src={m[0]} alt="" loading="lazy" onError={hideBroken} />
  ));
  // [label](url)
  nodes = splitByRegex(nodes, /\[([^\]]+)\]\(([^)\s]+)\)/g, (m, key) => {
    const href = safeHref(m[2]);
    return href ? (
      <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" className="aeaw__link">
        {m[1]}
      </a>
    ) : (
      <span key={key}>{m[1]}</span>
    );
  });
  // **bold**
  nodes = splitByRegex(nodes, /\*\*([^*]+)\*\*/g, (m, key) => <strong key={key}>{m[1]}</strong>);
  // *italic* or _italic_
  nodes = splitByRegex(nodes, /(?:\*([^*\n]+)\*|_([^_\n]+)_)/g, (m, key) => (
    <em key={key}>{m[1] ?? m[2]}</em>
  ));
  // bare URLs (not already inside an <a>, since those are now elements)
  nodes = splitByRegex(nodes, /(https?:\/\/[^\s<>()]+)/g, (m, key) => (
    <a key={key} href={m[1]} target="_blank" rel="noopener noreferrer nofollow" className="aeaw__link">
      {m[1]}
    </a>
  ));
  return nodes.map((n, i) => (typeof n === 'string' ? <span key={`t${i}`}>{n}</span> : n));
}

// ── Block parsing ───────────────────────────────────────────────────────────────────────────

const BULLET = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,4})\s+(.*)$/;

export function renderMarkdown(text: string): ReactNode {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(<p key={`p${key++}`} className="aeaw__p">{parseInline(para.join('\n'))}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{parseInline(it)}</li>);
    blocks.push(
      list.ordered ? (
        <ol key={`l${key++}`} className="aeaw__ol">{items}</ol>
      ) : (
        <ul key={`l${key++}`} className="aeaw__ul">{items}</ul>
      ),
    );
    list = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      flushList();
      blocks.push(<p key={`h${key++}`} className="aeaw__h">{parseInline(h[2])}</p>);
      continue;
    }
    const b = BULLET.exec(line);
    const o = ORDERED.exec(line);
    if (b || o) {
      flushPara();
      const ordered = !!o;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((b ? b[1] : o![1]).trim());
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return <>{blocks}</>;
}
