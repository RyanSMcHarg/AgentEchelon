/**
 * IMPORT A VERSION INTO THIS ASSISTANT (SPEC-PORTABLE-PROFILES §5, SPEC-ADMIN-CONSOLE "Assistants").
 *
 * An import lands on one assistant, so it lives in that assistant's configuration and always names it
 * as the target. A manifest carries the name of the assistant it was exported from; that name is shown
 * as where the file came from and never decides where it lands. The server requires the target too
 * (`TARGET_REQUIRED`), so no client can land an import by the manifest's own name.
 *
 * NOTHING IS WRITTEN UNTIL THE PREVIEW IS CONFIRMED. Choosing a file reads it in the browser and shows
 * where it came from and what will happen (a draft of this assistant, replacing a draft that exists);
 * Cancel drops it. A file that is not a manifest is refused here, before any request. What the server
 * refuses (a deploy-time key, an alt's profile, an assistant outside the session's reach, a model the
 * classification lacks) is shown with each of its reasons.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { importProfile, type ProfileManifest } from '../../services/profileService';
import { GuideLinks, guideSection } from './AdminHelp';

/** What the preview says about a manifest's source. Every field but the name is optional. */
export interface ManifestSummary {
  profileName: string;
  displayName?: string;
  version?: string;
  configId?: string;
  exportedAt?: string;
  instanceId?: string;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * Reads a chosen file as a profile manifest, or answers null for anything else. The check is the shape
 * the server's own schema check opens with (`kind`, a `body`, a name), so a file refused here would have
 * been refused there; the server still validates everything else against the target.
 */
export function readManifest(raw: string): { manifest: ProfileManifest; summary: ManifestSummary } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  const body = m.body as Record<string, unknown> | undefined;
  const profileName = text(m.profileName);
  if (m.kind !== 'assistant-profile' || !body || typeof body !== 'object' || Array.isArray(body) || !profileName) return null;
  const provenance = (m.provenance && typeof m.provenance === 'object' ? m.provenance : {}) as Record<string, unknown>;
  const version = provenance.sourceVersion;
  return {
    manifest: m,
    summary: {
      profileName,
      displayName: text(body.displayName),
      version: typeof version === 'number' ? `v${version}` : text(version),
      configId: text(provenance.exportedConfigId),
      exportedAt: text(m.exportedAt) ?? text(provenance.exportedAt),
      instanceId: text(provenance.instanceId),
    },
  };
}

interface ImportVersionProps {
  /** The assistant the import lands on: its profile name, always sent as the target. */
  assistant: string;
  /** What the assistant is called, for the copy. */
  assistantLabel: string;
  /** Whether a draft exists, which the import replaces. */
  hasDraft: boolean;
  disabled?: boolean;
  /** Set beside the import control in the same row (Export). */
  beside?: React.ReactNode;
  /** Called after the server landed the draft, to reload what the view shows. */
  onImported: () => void | Promise<void>;
}

const ImportVersion: React.FC<ImportVersionProps> = ({ assistant, assistantLabel, hasDraft, disabled, beside, onImported }) => {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<{ manifest: ProfileManifest; summary: ManifestSummary; fileName: string } | null>(null);
  const [refusal, setRefusal] = useState<{ message: string; reasons: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = (file: File) => {
    setNotice(null);
    setRefusal(null);
    setPreview(null);
    const reader = new FileReader();
    reader.onload = () => {
      const read = readManifest(String(reader.result ?? ''));
      if (!read) {
        setRefusal({ message: t('admin.profiles.importVersion.notManifest'), reasons: [] });
        return;
      }
      setPreview({ ...read, fileName: file.name });
    };
    reader.readAsText(file);
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setRefusal(null);
    try {
      // THE TARGET IS ALWAYS THIS ASSISTANT, whatever the manifest names.
      await importProfile(preview.manifest, assistant);
      setPreview(null);
      setNotice(t('admin.profiles.importVersion.imported', { assistant: assistantLabel }));
      await onImported();
    } catch (err) {
      const body = (err as { body?: { errors?: unknown } }).body;
      const reasons = Array.isArray(body?.errors) ? body!.errors.filter((e): e is string => typeof e === 'string') : [];
      setRefusal({ message: t('admin.profiles.importVersion.refused', { reason: (err as Error).message }), reasons });
    } finally {
      setBusy(false);
    }
  };

  const s = preview?.summary;
  return (
    <div className="admin-import-version" data-testid="import-version">
      <div className="admin-review-buttons">
        {beside}
        <label className="btn-secondary">
          {t('admin.profiles.importVersion.choose')}
          <input type="file" accept="application/json,.json" hidden
            aria-label={t('admin.profiles.importVersion.chooseFor', { assistant: assistantLabel })}
            disabled={disabled || busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) choose(f); e.target.value = ''; }} />
        </label>
      </div>

      {refusal && (
        <div className="admin-error" role="alert" data-testid="import-refused">
          <span>{refusal.message}</span>
          {refusal.reasons.length > 0 && <ul>{refusal.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        </div>
      )}
      {notice && <div className="admin-info-banner" role="status"><span>{notice}</span></div>}

      {preview && s && (
        <section className="admin-import-preview" aria-labelledby="import-preview-title" data-testid="import-preview">
          <h5 id="import-preview-title">{t('admin.profiles.importVersion.previewTitle')}</h5>
          <dl className="admin-config-list">
            <dt>{t('admin.profiles.importVersion.file')}</dt>
            <dd>{preview.fileName}</dd>
            <dt>{t('admin.profiles.importVersion.from')}</dt>
            <dd><code data-testid="import-source">{s.profileName}</code></dd>
            {s.displayName && <><dt>{t('admin.profiles.importVersion.displayName')}</dt><dd>{s.displayName}</dd></>}
            {s.version && <><dt>{t('admin.profiles.importVersion.version')}</dt><dd>{s.version}</dd></>}
            {s.configId && <><dt>{t('admin.profiles.importVersion.configId')}</dt><dd><code>{s.configId.slice(0, 12)}</code></dd></>}
            {s.exportedAt && <><dt>{t('admin.profiles.importVersion.exportedAt')}</dt><dd>{new Date(s.exportedAt).toLocaleString()}</dd></>}
            {s.instanceId && <><dt>{t('admin.profiles.importVersion.instance')}</dt><dd><code>{s.instanceId}</code></dd></>}
          </dl>
          <p data-testid="import-target">{t('admin.profiles.importVersion.becomesDraft', { assistant: assistantLabel })}</p>
          {hasDraft && (
            <p className="alert-warning" role="note" data-testid="import-replaces-draft">
              {t('admin.profiles.importVersion.replacesDraft', { assistant: assistantLabel })}
            </p>
          )}
          <GuideLinks guides={[guideSection(t('admin.profiles.importVersion.guide'), 'portability')]} />
          <div className="admin-config-actions">
            <button className="btn-ghost" disabled={busy} onClick={() => setPreview(null)}>
              {t('admin.profiles.importVersion.cancel')}
            </button>
            <button className="btn-primary" disabled={busy} onClick={() => { void confirm(); }}>
              {t(busy ? 'admin.profiles.importVersion.importing' : 'admin.profiles.importVersion.confirm')}
            </button>
          </div>
        </section>
      )}
    </div>
  );
};

export default ImportVersion;
