import React, { useCallback, useEffect, useState } from 'react';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import {
  listProfiles,
  createProfileVersion,
  editProfileDraft,
  validateProfileDraft,
  activateProfileDraft,
  rollbackProfile,
  exportProfile,
  importProfile,
  DEFAULT_MODEL,
  type ProfileListing,
  type ProfileDefinitionBody,
  type ProfileManifestTyped,
} from '../../services/profileService';
import {
  bedrockModelsUrl,
  bedrockGuardrailsUrl,
  bedrockGuardrailUrl,
  lambdaFunctionsUrl,
  lambdaFunctionUrl,
  lambdaFunctionsSearchUrl,
  cloudwatchLogsUrl,
  iamRolesUrl,
  iamRoleUrl,
} from '../../services/awsConsole';
import { toolInfo, TOOL_INFO } from '../../services/toolRegistry';

/**
 * Assistant Profiles — the P1/P3 versioning lifecycle UI (SPEC-PORTABLE-VERSIONED-PROFILES). The whole
 * backend (SSM version store, manage-profiles API, export/import) already exists; this surfaces it:
 * list each profile's versions + active pointer + draft, and create/edit/validate/activate/rollback/
 * import/export — all gated server-side on the `manage-profiles` capability (A14).
 */
interface ProfilesTabProps {
  registerBack?: (close: (() => void) | null) => void;
  /** Jump to the Effectiveness tab scoped to this assistant (its classification). Profiles are 1:1 with a
   *  classification, so the profile name IS the classification passed through. */
  onOpenEffectiveness?: (classification: string) => void;
}

const MODEL_KEYS = ['haiku', 'sonnet', 'opus', 'titan', 'gpt_oss_20b', 'gpt_oss_120b', 'deepseek_v3'];

const ProfilesTab: React.FC<ProfilesTabProps> = ({ registerBack, onOpenEffectiveness }) => {
  const [profiles, setProfiles] = useState<ProfileListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  // Draft edits, keyed by field; seeded from the active version when a draft is created.
  const [draftPatch, setDraftPatch] = useState<Partial<ProfileDefinitionBody>>({});
  const [validation, setValidation] = useState<{ valid: boolean; errors: string[] } | null>(null);
  // The active version's resolved config VALUES (read from its manifest body), for the read-only view.
  const [config, setConfig] = useState<ProfileDefinitionBody | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // Rich draft editors (models bundle + tools). Seeded from the active version's config once a draft exists,
  // then sent WHOLE on save (editProfileDraft replaces `models`, so we always send the complete bundle).
  const [modelsEdit, setModelsEdit] = useState<NonNullable<ProfileDefinitionBody['models']> | null>(null);
  const [toolsEdit, setToolsEdit] = useState<string[] | null>(null);

  const selected = profiles.find((p) => p.profileName === selectedName) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProfiles(await listProfiles());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load profiles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Let global/browser Back close the profile detail first.
  useEffect(() => {
    registerBack?.(selectedName ? () => setSelectedName(null) : null);
    return () => registerBack?.(null);
  }, [selectedName, registerBack]);

  // Load the active version's config VALUES for the read-only view whenever a profile is opened. Uses the
  // export path (the manifest body is the definitive value set); shows a loading state while it downloads.
  useEffect(() => {
    if (!selectedName) { setConfig(null); return; }
    let live = true;
    setConfigLoading(true);
    setModelsEdit(null); setToolsEdit(null); // re-seed the editors for the newly opened profile
    exportProfile(selectedName)
      .then((m) => { if (live) setConfig((m as unknown as ProfileManifestTyped).body ?? null); })
      .catch(() => { if (live) setConfig(null); })
      .finally(() => { if (live) setConfigLoading(false); });
    return () => { live = false; };
  }, [selectedName]);

  // Seed the rich editors from the active version's values once a draft exists (edit-in-place). Tools
  // default to the full registry (the assistant's whole surface) when the profile hasn't set them.
  useEffect(() => {
    if (selected?.hasDraft && config && modelsEdit === null) {
      setModelsEdit({ ...(config.models ?? {}), byIntent: { ...(config.models?.byIntent ?? {}) } });
      setToolsEdit(config.tools ? [...config.tools] : Object.keys(TOOL_INFO));
    }
  }, [selected?.hasDraft, config, modelsEdit]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onValidate(name: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await validateProfileDraft(name);
      setValidation({ valid: r.valid, errors: r.errors });
    } catch (e) {
      setError(`validate: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onExport(name: string) {
    setDownloading(true);
    setError(null);
    try {
      const manifest = await exportProfile(name);
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}-profile-manifest.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`export: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDownloading(false);
    }
  }

  function onImportFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const manifest = JSON.parse(String(reader.result));
        run('import', () => importProfile(manifest));
      } catch {
        setError('import: the selected file is not valid JSON');
      }
    };
    reader.readAsText(file);
  }

  // Render a model value with default-awareness + a Bedrock deep link. A blank/`'default'` value is shown
  // as an explicit "default" chip (the profile's recorded choice to follow the classification default —
  // NOT a missing value), with the note explaining what it inherits.
  const modelValue = (v: string | undefined, defaultNote: string) =>
    !v || v === DEFAULT_MODEL ? (
      <span className="admin-muted" title={defaultNote}>default <span style={{ opacity: 0.7 }}>· {defaultNote}</span></span>
    ) : (
      <a href={bedrockModelsUrl()} target="_blank" rel="noreferrer" title="Open in Amazon Bedrock console"><code>{v}</code> ↗</a>
    );

  if (loading) return <div className="admin-tab-loading">Loading profiles…</div>;

  // ---- Detail view (one profile) ----
  if (selected) {
    return (
      <div className="admin-tab">
        <div className="admin-tab-header">
          <nav className="admin-breadcrumb" aria-label="Profile path">
            <button className="admin-link-btn" onClick={() => { setSelectedName(null); setValidation(null); }}>← Profiles</button>
            <span> / </span>
            <span>{selected.profileName}</span>
          </nav>
        </div>

        {error && <div className="admin-error"><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}

        <p className="admin-tab-description">
          Active version: <strong>{selected.activeVersion ?? '—'}</strong>{' '}
          {selected.hasDraft && <span style={{ color: 'var(--status-warn)' }}>· has an unactivated draft ({selected.draftConfigId?.slice(0, 8)}…)</span>}
        </p>

        {onOpenEffectiveness && (
          <div className="admin-section" style={{ marginTop: 'calc(-1 * var(--space-2))', marginBottom: 'var(--space-3)' }}>
            <button className="admin-inline-btn" onClick={() => onOpenEffectiveness(selected.profileName)}
              title="Open the Effectiveness view scoped to this assistant's classification (quality, latency, cost, and per-tool errors — with the task/tool-step drill)">
              View this assistant's effectiveness →
            </button>
          </div>
        )}

        <DataTable
          data={selected.versions as unknown as Array<Record<string, unknown>>}
          emptyMessage="No versions"
          columns={[
            { key: 'version', label: 'Version' },
            { key: 'configId', label: 'Config ID', render: (v) => <code>{String(v).slice(0, 12)}…</code> },
            { key: 'active', label: 'Active', render: (v) => (v ? <span style={{ color: 'var(--status-good)' }}>✓ active</span> : '—') },
            { key: 'lastModified', label: 'Modified', render: (v) => (v ? new Date(String(v)).toLocaleString() : '—') },
            {
              key: 'rollback', label: '', sortable: false,
              render: (_v, row) => (row.active ? '' : (
                <button className="admin-inline-btn" disabled={busy}
                  onClick={() => run('rollback', () => rollbackProfile(selected.profileName, Number(row.version)))}>
                  Roll back to this
                </button>
              )),
            },
          ]}
        />

        <div className="admin-section" style={{ marginTop: 'var(--space-4)' }}>
          <h4>Configuration <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>· active version</span>{' '}
            <InfoTooltip label="About the config" content="The resolved behavioral values this profile's active version runs: models (base, classifier, per-intent), tools, guardrail, and limits. Model/guardrail/tool values deep-link to the AWS console (right region) for troubleshooting. A model shown as “default” is the profile's recorded choice to follow the classification default — it tracks the platform default over time rather than pinning a model." />
          </h4>
          {configLoading ? (
            <div className="admin-tab-loading">Loading configuration…</div>
          ) : !config ? (
            <p className="admin-muted">Configuration unavailable.</p>
          ) : (
            <dl className="admin-config-list" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: 'var(--space-2) var(--space-4)', margin: 0 }}>
              <dt>Base model</dt>
              <dd>{modelValue(config.models?.default ?? config.modelKey, 'inherits the classification default')}</dd>

              <dt>Classifier model</dt>
              <dd>{config.classifierMode === 'keyword'
                ? <span className="admin-muted">n/a · keyword classifier (no LLM)</span>
                : modelValue(config.models?.classifier, 'follows the platform classifier (Haiku)')}</dd>

              <dt>Complex model</dt>
              <dd>{config.models?.complex ? modelValue(config.models.complex, '') : <span className="admin-muted">— (uses base for complex turns)</span>}</dd>

              <dt>Per-intent routing</dt>
              <dd>
                {config.models?.byIntent && Object.keys(config.models.byIntent).length > 0 ? (
                  <table className="admin-mini-table" style={{ borderCollapse: 'collapse' }}>
                    <tbody>
                      {Object.entries(config.models.byIntent).map(([intent, route]) => (
                        <tr key={intent}>
                          <td style={{ paddingRight: 'var(--space-3)' }}><code>{intent}</code></td>
                          <td style={{ paddingRight: 'var(--space-2)' }}>{modelValue(route.primary, 'uses base for this intent')}</td>
                          <td>{route.fallback && route.fallback !== DEFAULT_MODEL
                            ? <span style={{ color: 'var(--text-secondary)' }}>↳ fallback {modelValue(route.fallback, '')}</span>
                            : <span className="admin-muted" style={{ fontSize: '0.85em' }}>no fallback</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <span className="admin-muted">— (uses base for every intent)</span>
                )}
              </dd>

              <dt>Tools</dt>
              <dd>
                {(() => {
                  const fn = selected.resolved?.processorFunctionName;
                  const region = selected.resolved?.region;
                  if (!config.tools || config.tools.length === 0) {
                    return <span className="admin-muted">— (no tools enabled for this profile)</span>;
                  }
                  // Each tool: its description ("how it functions") + a deep link to THAT tool's runtime logic
                  // — the processor Lambda's CloudWatch Logs filtered by the tool name (tools are code that
                  // runs inside the per-classification processor, so this is the closest per-tool "logic" link).
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                      {config.tools.map((t) => {
                        const info = toolInfo(t);
                        const logs = fn ? cloudwatchLogsUrl(fn, t, region) : lambdaFunctionsUrl();
                        return (
                          <div key={t} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
                            <code className="admin-chip">{t}</code>
                            <a href={logs} target="_blank" rel="noopener noreferrer" title="Open this tool’s invocations in CloudWatch Logs">logic ↗</a>
                            {info && <span style={{ color: 'var(--text-secondary)', fontSize: '0.9em' }}>{info.description}</span>}
                          </div>
                        );
                      })}
                      {fn && (
                        <a href={lambdaFunctionUrl(fn, region)} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.9em' }}>
                          Open the tool-loop Lambda ({fn}) ↗
                        </a>
                      )}
                    </div>
                  );
                })()}
              </dd>

              <dt>Guardrail</dt>
              <dd>{(() => {
                // Prefer the profile's own guardrailId; else the guardrail the live processor ACTUALLY applies
                // (resolved GUARDRAIL_ID). Deep-link to that guardrail's config, not just the list.
                const gid = config.guardrailId || selected.resolved?.guardrailId;
                return gid
                  ? <a href={bedrockGuardrailUrl(gid, selected.resolved?.region)} target="_blank" rel="noopener noreferrer" title="Open this guardrail's config in Bedrock"><code>{gid}</code> ↗</a>
                  : <span className="admin-muted">— <a href={bedrockGuardrailsUrl()} target="_blank" rel="noopener noreferrer">Guardrails ↗</a></span>;
              })()}</dd>

              <dt>Assistant identity (IAM)</dt>
              <dd>{selected.resolved?.roleName
                ? <a href={iamRoleUrl(selected.resolved.roleName)} target="_blank" rel="noopener noreferrer" title="Open this role in IAM — it bounds what models/tools/context the assistant may reach"><code>{selected.resolved.roleName}</code> ↗</a>
                : <a href={iamRolesUrl()} target="_blank" rel="noopener noreferrer">Open IAM roles ↗</a>}</dd>

              <dt>Classifier mode</dt>
              <dd>{config.classifierMode}</dd>
              <dt>Task support</dt>
              <dd>{config.taskSupport}</dd>
              <dt>Timeout</dt>
              <dd>{config.timeoutSeconds}s</dd>
              <dt>Rate limit</dt>
              <dd>{config.rateLimitPerHour != null ? `${config.rateLimitPerHour}/hr` : <span className="admin-muted">— (unset)</span>}</dd>
              <dt>Battle eligible</dt>
              <dd>{config.battleEligible ? 'yes' : 'no'}</dd>
            </dl>
          )}
        </div>

        <div className="admin-section" style={{ marginTop: 'var(--space-4)' }}>
          <h4>Infrastructure <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>· classification level</span>{' '}
            <InfoTooltip label="About the infra" content="The AWS resources that serve this classification (shared by every profile at this classification): the router/AgentHandler Lambda (intent classification + routing), the async-processor Lambda (the Converse tool loop), and the Amazon Chime SDK channel flow. Deep-link to each for troubleshooting." />
          </h4>
          <dl className="admin-config-list" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: 'var(--space-2) var(--space-4)', margin: 0 }}>
            <dt>Router / classification Lambda</dt>
            <dd>{selected.resolved?.routerFunctionName
              ? <a href={lambdaFunctionUrl(selected.resolved.routerFunctionName, selected.resolved.region)} target="_blank" rel="noopener noreferrer" title="Intent classification + routing (Lex fulfillment)"><code>{selected.resolved.routerFunctionName}</code> ↗</a>
              : <a href={lambdaFunctionsSearchUrl('AgentHandler', selected.resolved?.region)} target="_blank" rel="noopener noreferrer">Find AgentHandler ↗</a>}</dd>

            <dt>Async processor Lambda</dt>
            <dd>{selected.resolved?.processorFunctionName
              ? <a href={lambdaFunctionUrl(selected.resolved.processorFunctionName, selected.resolved.region)} target="_blank" rel="noopener noreferrer" title="The self-hosted Converse tool loop"><code>{selected.resolved.processorFunctionName}</code> ↗</a>
              : <a href={lambdaFunctionsSearchUrl('AsyncProcessor', selected.resolved?.region)} target="_blank" rel="noopener noreferrer">Find AsyncProcessor ↗</a>}</dd>

            <dt>Channel flow</dt>
            <dd>
              {selected.resolved?.channelFlowArn
                ? <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <code style={{ fontSize: '0.85em', wordBreak: 'break-all' }}>{selected.resolved.channelFlowArn}</code>
                    <span><a href={lambdaFunctionsSearchUrl('ChannelFlow', selected.resolved.region)} target="_blank" rel="noopener noreferrer">channel-flow processor ↗</a></span>
                  </div>
                : <a href={lambdaFunctionsSearchUrl('ChannelFlow')} target="_blank" rel="noopener noreferrer">channel-flow processor ↗</a>}
              <div className="admin-muted" style={{ fontSize: '0.85em', marginTop: '2px' }}>
                One shared app-instance flow routes every channel today (it fans out <code>@all</code>, routes <code>/battle</code>, and reads the classification tag), so it stays. Roadmap: slim it to a minimal routing flow and layer additional per-classification/per-profile flows on top — not swap it per classification, which would break routing.
              </div>
            </dd>
          </dl>
        </div>

        <div className="admin-section" style={{ marginTop: 'var(--space-4)' }}>
          <h4>Draft <InfoTooltip label="About drafts" content="A draft is an editable clone of the active version. Edit its behavioral fields, validate, then activate to make it the new active version — no redeploy. Activation archives the previous active (roll back any time)." /></h4>
          {!selected.hasDraft ? (
            <button className="admin-inline-btn" disabled={busy}
              onClick={() => run('create-version', () => createProfileVersion(selected.profileName))}>
              + New version (clone active → draft)
            </button>
          ) : (
            <div className="admin-form-grid">
              <label>Base model <InfoTooltip label="Base model" content="The default model for any intent not pinned to its own model below. “(default)” inherits the classification default (Model Strategy tab)." />
                <select value={modelsEdit?.default ?? ''} onChange={(e) => setModelsEdit((m) => ({ ...(m ?? {}), default: e.target.value || undefined }))}>
                  <option value="">(default) — inherit classification default</option>
                  {MODEL_KEYS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label>Classifier model <InfoTooltip label="Classifier model" content="The LLM that classifies the intent. “default” follows the platform classifier (Haiku) and tracks it over time; pick a concrete model to override." />
                <select value={modelsEdit?.classifier ?? 'default'} onChange={(e) => setModelsEdit((m) => ({ ...(m ?? {}), classifier: e.target.value }))}>
                  <option value="default">default — follow the platform classifier (Haiku)</option>
                  {MODEL_KEYS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label>Classifier mode
                <select value={draftPatch.classifierMode ?? ''} onChange={(e) => setDraftPatch((p) => ({ ...p, classifierMode: e.target.value as 'keyword' | 'llm' }))}>
                  <option value="">(unchanged)</option>
                  <option value="keyword">keyword</option>
                  <option value="llm">llm</option>
                </select>
              </label>
              <label>Task support
                <select value={draftPatch.taskSupport ?? ''} onChange={(e) => setDraftPatch((p) => ({ ...p, taskSupport: e.target.value as 'lightweight' | 'full' }))}>
                  <option value="">(unchanged)</option>
                  <option value="lightweight">lightweight</option>
                  <option value="full">full</option>
                </select>
              </label>
              <label>Battle eligible
                <select value={draftPatch.battleEligible === undefined ? '' : String(draftPatch.battleEligible)}
                  onChange={(e) => setDraftPatch((p) => ({ ...p, battleEligible: e.target.value === '' ? undefined : e.target.value === 'true' }))}>
                  <option value="">(unchanged)</option>
                  <option value="true">yes</option>
                  <option value="false">no</option>
                </select>
              </label>

              <div style={{ gridColumn: '1 / -1' }}>
                <h5 style={{ margin: 'var(--space-2) 0' }}>Per-intent models <InfoTooltip label="Per-intent models" content="The model used for each specific intent (with an optional graceful-degrade fallback). An intent left on “(base)” uses the base model above. This is per-PROFILE routing — the level of control a portable assistant needs." /></h5>
                <table className="admin-mini-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: '0.85em' }}><th>Intent</th><th>Primary</th><th>Fallback</th></tr></thead>
                  <tbody>
                    {Object.keys(modelsEdit?.byIntent ?? {}).sort().map((route) => {
                      const r = modelsEdit!.byIntent![route];
                      const setRoute = (patch: Partial<{ primary: string; fallback?: string }>) =>
                        setModelsEdit((m) => ({ ...(m ?? {}), byIntent: { ...(m?.byIntent ?? {}), [route]: { ...(m?.byIntent?.[route] ?? { primary: '' }), ...patch } } }));
                      return (
                        <tr key={route}>
                          <td style={{ paddingRight: 'var(--space-3)' }}><code>{route}</code></td>
                          <td style={{ paddingRight: 'var(--space-2)' }}>
                            <select value={r.primary ?? ''} onChange={(e) => setRoute({ primary: e.target.value })}>
                              <option value="default">(base) — use the base model</option>
                              {MODEL_KEYS.map((m) => <option key={m} value={m}>{m}</option>)}
                            </select>
                          </td>
                          <td>
                            <select value={r.fallback ?? ''} onChange={(e) => setRoute({ fallback: e.target.value || undefined })}>
                              <option value="">no fallback</option>
                              {MODEL_KEYS.map((m) => <option key={m} value={m}>{m}</option>)}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ gridColumn: '1 / -1' }}>
                <h5 style={{ margin: 'var(--space-2) 0' }}>Tools <InfoTooltip label="Tools" content="This assistant's tool SURFACE — the boundary of what it may use. The model still decides which of these to actually call for each intent at runtime (that's the Converse tool loop). Uncheck a tool to deny it to this assistant entirely." /></h5>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2) var(--space-4)' }}>
                  {Object.keys(TOOL_INFO).map((t) => {
                    const on = (toolsEdit ?? []).includes(t);
                    return (
                      <label key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', fontWeight: 400 }} title={toolInfo(t)?.description}>
                        <input type="checkbox" checked={on} onChange={(e) => setToolsEdit((cur) => {
                          const set = new Set(cur ?? []);
                          if (e.target.checked) set.add(t); else set.delete(t);
                          return [...set];
                        })} />
                        <code>{t}</code>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="admin-review-buttons" style={{ gridColumn: '1 / -1' }}>
                <button className="admin-inline-btn" disabled={busy}
                  onClick={() => run('edit-draft', async () => {
                    await editProfileDraft(selected.profileName, {
                      ...draftPatch,
                      ...(modelsEdit ? { models: modelsEdit } : {}),
                      ...(toolsEdit ? { tools: toolsEdit } : {}),
                    });
                    setDraftPatch({});
                  })}>
                  Save draft edits
                </button>
                <button className="admin-inline-btn" disabled={busy} onClick={() => onValidate(selected.profileName)}>Validate</button>
                <button className="admin-btn admin-btn-approve" disabled={busy || (validation ? !validation.valid : false)}
                  onClick={() => run('activate', async () => { await activateProfileDraft(selected.profileName); setValidation(null); })}>
                  Activate draft
                </button>
              </div>
              {validation && (
                <div style={{ gridColumn: '1 / -1', color: validation.valid ? 'var(--status-good)' : 'var(--status-bad)' }}>
                  {validation.valid ? '✓ Draft is valid — ready to activate.' : `✗ ${validation.errors.join('; ')}`}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="admin-section" style={{ marginTop: 'var(--space-3)' }}>
          <button className="admin-inline-btn" disabled={downloading} onClick={() => onExport(selected.profileName)}>
            {downloading ? 'Downloading…' : 'Export manifest ↓'}
          </button>
        </div>
      </div>
    );
  }

  // ---- List view ----
  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        <h3>Assistant Profiles <InfoTooltip label="About profiles" content="Each assistant profile is a versioned, portable artifact: its behavior (model, classifier, limits) is data you can version, activate, roll back, and import/export across instances — no redeploy. Pit any two profiles/versions against each other from the Experiments tab." /></h3>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <label className="admin-inline-btn" style={{ cursor: 'pointer' }}>
            Import manifest ↑
            <input type="file" accept="application/json,.json" style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onImportFile(f); e.target.value = ''; }} />
          </label>
          <button className="admin-inline-btn" onClick={() => load()} disabled={busy}>Refresh</button>
        </div>
      </div>

      {error && <div className="admin-error"><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}

      <DataTable
        data={profiles as unknown as Array<Record<string, unknown>>}
        emptyMessage="No profiles found."
        onRowClick={(row) => { setSelectedName(String(row.profileName)); setDraftPatch({}); setValidation(null); }}
        columns={[
          // The name is the drill control: DataTable ignores row-clicks that land on a nested button, so
          // this button MUST carry its own onClick (otherwise clicking the name does nothing).
          { key: 'profileName', label: 'Profile', render: (v) => (
            <button className="admin-link-btn" onClick={() => { setSelectedName(String(v)); setDraftPatch({}); setValidation(null); }}>{String(v)}</button>
          ) },
          { key: 'activeVersion', label: 'Active version', render: (v) => (v == null ? '—' : `v${v}`) },
          { key: 'versions', label: 'Versions', render: (v) => (Array.isArray(v) ? v.length : 0) },
          { key: 'hasDraft', label: 'Draft', render: (v) => (v ? <span style={{ color: 'var(--status-warn)' }}>draft pending</span> : '—') },
        ]}
      />
    </div>
  );
};

export default ProfilesTab;
