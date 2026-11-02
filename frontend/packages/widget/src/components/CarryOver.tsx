/**
 * THE VISIT CARRIES OVER WITH NOTHING TO CLICK (`session/upgrade.ts`). A visitor is never asked whether to
 * keep their visit. Under the conversation, as the deployment declares:
 *
 *  - `CarryOverBar`: "Sign in" (path A), whose sign-in carries the visit into the account, and the
 *    registration form (path B), a name and the address a sign-in link is emailed to. A refusal is said
 *    beside the form, in the visitor's language, and the details stay as typed. Once registered, the form
 *    says where the link went, or that it goes once the registration is approved.
 *  - `SigningIn`: the visit is handed to the chat app's sign-in in a new tab. The link is shown too, for a
 *    browser that blocked the tab, and "Back to the conversation" returns to the visit as it was.
 *
 * Every string is a key in the widget's locale (tenets P5 and D11).
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { RegistrationFields, RegistrationOutcome, RegistrationRefusalCode } from '../session/upgrade';

export function RegisterForm({
  busy,
  error,
  done,
  onSubmit,
}: {
  busy: boolean;
  error?: RegistrationRefusalCode;
  /** What the registration came to, and the address its link goes to. */
  done?: { outcome: RegistrationOutcome; email: string };
  onSubmit: (fields: RegistrationFields, email: string) => void;
}) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<RegistrationFields & { email: string }>({ name: '', email: '', company: '', role: '', note: '' });
  const set = (k: keyof typeof fields) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [k]: e.target.value }));
  if (done) {
    return (
      <p className="aeaw__carry-hint" role="status" data-outcome={done.outcome}>
        {t(done.outcome === 'sent' ? 'widget.carry.register.sent' : 'widget.carry.register.awaiting', { email: done.email })}
      </p>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const out: RegistrationFields = { name: fields.name.trim() };
    for (const k of ['company', 'role', 'note'] as const) if (fields[k]?.trim()) out[k] = fields[k]!.trim();
    onSubmit(out, fields.email.trim());
  };
  return (
    <details className="aeaw__register" open={error ? true : undefined}>
      <summary>{t('widget.carry.register.title')}</summary>
      <form aria-label={t('widget.carry.register.title')} onSubmit={submit} noValidate>
        <p className="aeaw__carry-hint">{t('widget.carry.register.body')}</p>
        <label className="aeaw__field">
          <span>{t('widget.carry.register.name')}</span>
          <input value={fields.name} onChange={set('name')} required autoComplete="name" maxLength={120} aria-invalid={error === 'invalid' || undefined} />
        </label>
        <label className="aeaw__field">
          <span>{t('widget.carry.register.email')}</span>
          <input type="email" value={fields.email} onChange={set('email')} required autoComplete="email" maxLength={254} aria-invalid={error === 'invalid' || undefined} />
        </label>
        <label className="aeaw__field">
          <span>{t('widget.carry.register.company')}</span>
          <input value={fields.company} onChange={set('company')} autoComplete="organization" maxLength={120} />
        </label>
        <label className="aeaw__field">
          <span>{t('widget.carry.register.role')}</span>
          <input value={fields.role} onChange={set('role')} autoComplete="organization-title" maxLength={120} />
        </label>
        <label className="aeaw__field">
          <span>{t('widget.carry.register.note')}</span>
          <textarea value={fields.note} onChange={set('note')} rows={2} maxLength={1000} />
        </label>
        {error && <p className="aeaw__field-error" role="alert" data-code={error}>{t(`widget.carry.register.refused.${error}`)}</p>}
        <button type="submit" className="aeaw__action" disabled={busy} aria-busy={busy}>
          {busy ? t('widget.carry.register.submitting') : t('widget.carry.register.submit')}
        </button>
      </form>
    </details>
  );
}

export function CarryOverBar({
  paths,
  onSignIn,
  register,
}: {
  paths: ReadonlySet<'bind' | 'claim'>;
  onSignIn: () => void;
  register: Parameters<typeof RegisterForm>[0];
}) {
  const { t } = useTranslation();
  if (!paths.size) return null;
  return (
    <section className="aeaw__carry" aria-label={t('widget.carry.label')}>
      {paths.has('bind') && (
        <>
          <button type="button" className="aeaw__secondary" onClick={onSignIn} aria-describedby="aeaw-carry-signin">{t('widget.carry.signIn')}</button>
          <p id="aeaw-carry-signin" className="aeaw__carry-hint">{t('widget.carry.signInHint')}</p>
        </>
      )}
      {paths.has('claim') && <RegisterForm {...register} />}
    </section>
  );
}

/**
 * The visit continues in the sign-in tab. "Open the sign-in page" opens that tab again (when none opened, or
 * it was closed) through the widget, never as a plain link: the tab must be one this widget opened, or it
 * cannot ask for the hand-off's secret.
 */
export function SigningIn({ onOpen, onBack }: { onOpen: () => void; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="aeaw__keep" role="status" aria-labelledby="aeaw-continued-title">
      <h3 id="aeaw-continued-title" className="aeaw__notice-title">{t('widget.carry.continued.title')}</h3>
      <p className="aeaw__notice-body">{t('widget.carry.continued.body')}</p>
      <button type="button" className="aeaw__action aeaw__link-action" onClick={onOpen}>{t('widget.carry.continued.open')}</button>
      <button type="button" className="aeaw__secondary" onClick={onBack}>{t('widget.carry.back')}</button>
    </section>
  );
}
