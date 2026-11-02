/**
 * The message input. Enter sends, Shift+Enter is a new line, and an IME mid-composition never sends.
 * Attachments are **NOT BUILT** in the widget: a guest conversation type turns them off (FR11), and a
 * host session has no upload route it may call with an assertion.
 */
import { forwardRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

export const Composer = forwardRef<HTMLTextAreaElement, { onSend: (text: string) => void; disabled?: boolean }>(
  function Composer({ onSend, disabled }, ref) {
    const { t } = useTranslation();
    const [value, setValue] = useState('');

    const submit = () => {
      const text = value.trim();
      if (!text || disabled) return;
      setValue('');
      onSend(text);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    };

    return (
      <form
        className="aeaw__composer"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="aeaw__visually-hidden" htmlFor="aeaw-input">{t('widget.composer.label')}</label>
        <textarea
          id="aeaw-input"
          ref={ref}
          className="aeaw__input"
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('widget.composer.placeholder')}
          autoComplete="off"
          disabled={disabled}
        />
        <button className="aeaw__send" type="submit" disabled={disabled || !value.trim()}>
          {t('widget.composer.send')}
        </button>
      </form>
    );
  },
);
