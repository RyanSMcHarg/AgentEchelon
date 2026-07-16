import React, { useId, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import './AdminHelp.css';

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
  label = 'More information',
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

interface DocLinkProps {
  /** Absolute documentation URL (see config/docLinks.ts). */
  href: string;
  /** Link text — defaults to "Learn more". */
  children?: React.ReactNode;
  className?: string;
}

/** External "learn more" link to documentation; opens in a new tab, safely. */
export const DocLink: React.FC<DocLinkProps> = ({ href, children = 'Learn more', className }) => (
  <a
    className={`doc-link${className ? ` ${className}` : ''}`}
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    onClick={(e) => e.stopPropagation()}
  >
    {children}
    <span aria-hidden="true"> &#8599;</span>
  </a>
);
