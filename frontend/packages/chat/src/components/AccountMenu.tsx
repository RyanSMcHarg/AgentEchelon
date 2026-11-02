import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * THE ACCOUNT MENU: the signed-in person's name, opening Account settings and Sign out.
 *
 * Email preferences were a header button beside Sign out; a preference is not navigation, so it moved into
 * Account settings, and the header keeps one control for the person's own account.
 */
interface Props {
  name: string;
  onOpenSettings: () => void;
  onSignOut: () => void;
}

const AccountMenu: React.FC<Props> = ({ name, onOpenSettings, onSignOut }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const initial = (name.trim()[0] || '?').toUpperCase();

  useEffect(() => {
    if (!open) return;
    firstItemRef.current?.focus();
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (action: () => void) => () => { setOpen(false); action(); };

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        type="button"
        className="account-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('accountMenu.open', { name })}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="account-menu-initial" aria-hidden="true">{initial}</span>
        <span className="account-menu-name">{name}</span>
      </button>
      {open && (
        <div className="account-menu-list" role="menu" aria-label={t('accountMenu.label')}>
          <button ref={firstItemRef} type="button" role="menuitem" className="account-menu-item" onClick={pick(onOpenSettings)}>
            {t('accountMenu.settings')}
          </button>
          <button type="button" role="menuitem" className="account-menu-item" onClick={pick(onSignOut)}>
            {t('header.signOut')}
          </button>
        </div>
      )}
    </div>
  );
};

export default AccountMenu;
