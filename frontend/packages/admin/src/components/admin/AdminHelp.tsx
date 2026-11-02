import i18n from '@ae/shared/i18n';
import React, { useId, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { DOC_LINKS, DOC_SECTIONS, type DocLinkKey } from '../../config/docLinks';
import type { MetricProvenance } from './metricTargets';
import './AdminHelp.css';

/**
 * Base for a link to a FILE, as opposed to `docLinks.ts`'s base for a document. Same repo and the
 * same reasoning - a link lives where its target is versioned with the behavior it describes - so a
 * move is one edit in each of two files rather than one in forty call sites.
 */
const CODE_BASE = 'https://github.com/RyanSMcHarg/AgentEchelon/blob/main';

interface InfoTooltipProps {
  /** Tooltip body — plain text or rich nodes. */
  content: React.ReactNode;
  /** Accessible label for the trigger button. */
  label?: string;
  /** Extra className on the container. */
  className?: string;
}

/** Keep in sync with `.info-tip-content { max-width }` in AdminHelp.css. */
const TIP_MAX_WIDTH = 260;

/**
 * Small info (ⓘ) affordance that reveals a short explanation on hover or focus.
 *
 * The panel is rendered in a portal with fixed, viewport-clamped positioning so
 * it can never be clipped by a card, table cell, or the scrolling content
 * region (an absolutely-positioned panel would be). Keyboard- and
 * screen-reader-accessible (focusable trigger, role="tooltip", aria-describedby,
 * Escape to dismiss) and safe inside a clickable row — the trigger stops
 * click/keyboard propagation so it never triggers the row.
 */
export const InfoTooltip: React.FC<InfoTooltipProps> = ({
  content,
  label = i18n.t('admin.adminHelp.moreInformation'),
  className,
}) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    // Center under the trigger, then clamp so it stays fully on screen.
    const left = Math.min(
      Math.max(margin, r.left + r.width / 2 - TIP_MAX_WIDTH / 2),
      window.innerWidth - TIP_MAX_WIDTH - margin,
    );
    setPos({ top: r.bottom + 6, left });
  }, []);

  const show = useCallback(() => {
    place();
    setOpen(true);
  }, [place]);
  const hide = useCallback(() => setOpen(false), []);

  return (
    <span
      className={`info-tip${className ? ` ${className}` : ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <button
        ref={triggerRef}
        type="button"
        className="info-tip-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open) hide();
          else show();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') hide();
          // Don't let Enter/Space bubble to a clickable parent row.
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        }}
      >
        <span aria-hidden="true">&#9432;</span>
      </button>
      {open && pos &&
        createPortal(
          <span
            role="tooltip"
            id={id}
            className="info-tip-content"
            style={{ top: pos.top, left: pos.left }}
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
};

/**
 * HELP BEHIND A ? CONTROL: a step's or a card's longer explanation, and its guides, shown when asked for rather than
 * as paragraphs around the controls. The button says whether it is open, and the panel it opens is a region a screen
 * reader can reach. A one-line field help stays an `InfoTooltip`.
 */
export const HelpToggle: React.FC<{ label: string; children: React.ReactNode; testId?: string }> = ({ label, children, testId }) => {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="admin-help-toggle">
      <button type="button" className="admin-help-toggle-button" aria-label={label} aria-expanded={open} aria-controls={id}
        data-testid={testId} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">?</span>
      </button>
      {open && <div id={id} role="region" aria-label={label} className="admin-help-toggle-panel" data-testid={testId ? `${testId}-panel` : undefined}>{children}</div>}
    </span>
  );
};

interface DocLinkProps {
  /** Absolute documentation URL (see config/docLinks.ts). */
  href: string;
  /**
   * Link text, REQUIRED and naming the destination ("Latency targets", never "Learn more"): a screen
   * reader lists links out of context, and "Learn more" five times is no list at all.
   */
  children: React.ReactNode;
  className?: string;
}

/**
 * A link to documentation. Opens in a new tab, safely, and says so to a screen reader: the arrow is
 * the visual cue and is hidden from assistive technology, which hears "(opens in a new tab)" instead.
 */
export const DocLink: React.FC<DocLinkProps> = ({ href, children, className }) => (
  <a
    className={`doc-link${className ? ` ${className}` : ''}`}
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    onClick={(e) => e.stopPropagation()}
  >
    {children}
    <span aria-hidden="true"> &#8599;</span>
    <span className="visually-hidden"> {i18n.t('admin.adminHelp.opensInNewTab')}</span>
  </a>
);

/** One guide a surface points to: why a reader would open it, and the guide's name. */
export interface Guide {
  /** The reason, as the start of a sentence the link completes ("To add a role, ... see"). */
  lead: string;
  /** The guide's name, which is the link text. */
  title: string;
  href: string;
}

/**
 * THE GUIDES A SURFACE POINTS TO, EACH WITH ITS REASON. A bare row of "Guide ↗" links tells a reader
 * neither what is behind them nor why they are there, so every link here is the end of a sentence
 * saying why one would open it, and its text names the guide.
 */
export const GuideLinks: React.FC<{ guides: Guide[]; className?: string }> = ({ guides, className }) => (
  <ul className={`admin-guides${className ? ` ${className}` : ''}`} aria-label={i18n.t('admin.adminHelp.guides')}>
    {guides.map((g) => (
      <li key={g.href}>
        {g.lead} <DocLink href={g.href}>{g.title}</DocLink>
      </li>
    ))}
  </ul>
);

/** A registered guide by its key, titled from the locale: one name per guide across the console. */
export const guide = (lead: string, key: DocLinkKey): Guide => ({
  lead,
  title: i18n.t(`admin.docs.title.${key}`),
  href: DOC_LINKS[key],
});

/** A section of a registered guide, titled from the locale. */
export const guideSection = (lead: string, key: keyof typeof DOC_SECTIONS): Guide => ({
  lead,
  title: i18n.t(`admin.docs.title.${key}`),
  href: DOC_SECTIONS[key],
});

/**
 * The two links under a metric's explanation: the guide, and the code that computes the number.
 *
 * WHY A COMPONENT RATHER THAN TWO `DocLink`s AT EACH CALL SITE. A tooltip whose links are assembled
 * by hand is a tooltip whose links can be forgotten, and a missing code link is invisible - the copy
 * still reads fine. Assembled from `MetricProvenance` in one place, the registry is the only thing
 * that has to be complete, and a test can check it.
 *
 * THE CODE REFERENCE DEGRADES TO TEXT ON PURPOSE. `publicLine` is present only when the generator
 * found the symbol in the PUBLIC tree, which is what the link resolves against. Without it the path
 * and symbol are shown as plain text: an operator can still find the computation, and nobody is sent
 * to a 404 or - worse - to whatever unrelated code now sits at that line number. See
 * `metricTargets.ts` `MetricProvenance` for the measurement behind that.
 */
export const MetricProvenanceLinks: React.FC<{
  provenance: MetricProvenance;
  className?: string;
}> = ({ provenance, className }) => {
  const { guide, file, symbol, publicLine } = provenance;
  const shortFile = file.split('/').pop() ?? file;
  return (
    <span className={`metric-provenance${className ? ` ${className}` : ''}`}>
      <span>
        {i18n.t('admin.docs.metricDefined')}{' '}
        <DocLink href={DOC_LINKS[guide]}>{i18n.t(`admin.docs.title.${guide}`)}</DocLink>
      </span>
      {publicLine ? (
        <span>
          {i18n.t('admin.docs.metricComputed')}{' '}
          <DocLink href={`${CODE_BASE}/${file}#L${publicLine}`}>{`${shortFile}:${publicLine}`}</DocLink>
        </span>
      ) : (
        // Not yet in the public repo. Named precisely so it is still findable, and deliberately not
        // a link - see the component docstring.
        <span className="metric-provenance-text">{`Computed in ${shortFile} (${symbol})`}</span>
      )}
    </span>
  );
};
