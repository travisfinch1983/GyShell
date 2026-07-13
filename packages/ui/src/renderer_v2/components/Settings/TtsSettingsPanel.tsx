/**
 * TtsSettingsPanel — the "Support Models" tab in Settings.
 *
 * Configures the models that support the agents rather than being agents:
 * - Vision Description model (global Hermes role — describes images to
 *   text-only agents; vision-capable agents see images natively and ignore it)
 * - STT provider and model selection
 * - TTS provider and model selection
 * - Single/dual pipeline toggle
 * - RVC voice conversion toggle
 *
 * TTS/STT settings stored in settings.ttsConfig / settings.sttConfig;
 * Vision Description lives backend-side (GET/PUT /api/hermes/support-models).
 */

import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import {
  Volume2, Mic, RefreshCw, CircleDot, Eye,
} from 'lucide-react'
import {
  getTtsProviders,
  getSttProviders,
  getRvcModels,
  discoverModels,
  type TtsProvider,
  type SttProvider,
  type RvcModel,
} from '../../services/ProxlabDiscovery'
import { hermesApi, type SupportModelRole, type CatalogModelWithCaps } from '../../stores/hermesApi'

interface TtsConfig {
  enabled: boolean
  dualPipeline: boolean
  rvcEnabled: boolean
  defaultVoice: string
  defaultModel: string
  rvcModel: string
  preferredProviders: number[]
  rvcProviders: number[]
}

interface SttConfig {
  enabled: boolean
  provider: number
  model: string
}

const DEFAULT_TTS_CONFIG: TtsConfig = {
  enabled: true,
  dualPipeline: true,
  rvcEnabled: false,
  defaultVoice: 'default',
  defaultModel: 'f5-tts',
  rvcModel: '',
  preferredProviders: [],
  rvcProviders: [],
}

const DEFAULT_STT_CONFIG: SttConfig = {
  enabled: true,
  provider: 1,
  model: 'large-v3-turbo',
}

// ─── Vision Description Section ───────────────────────────────────────────────
// Global Hermes role: the model that describes images to TEXT-ONLY agents.
// Vision-capable agents see images natively and ignore this setting entirely.

const VisionDescriptionSection: React.FC = () => {
  const [visionModels, setVisionModels] = useState<CatalogModelWithCaps[]>([])
  const [role, setRole] = useState<SupportModelRole | null>(null)
  // Wipe guard: the selector only renders after a successful GET, so a failed
  // load can never turn into a blind PUT over live config.
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')

  const load = async () => {
    setState('loading')
    const [roles, catalog] = await Promise.all([hermesApi.getSupportModels(), hermesApi.listCatalog()])
    if (roles === null) { setState('error'); return }
    setRole(roles.visionDescription)
    setVisionModels(catalog.filter((m) => m.capabilities?.vision === true))
    setState('ready')
  }

  useEffect(() => { load() }, [])

  const apply = async (model: string) => {
    const next: SupportModelRole | null = model ? { provider: role?.provider || 'ailab', model } : null
    const prev = role
    setRole(next)
    setSaving(true)
    setStatus('')
    const r = await hermesApi.setSupportModels(next)
    setSaving(false)
    if (!r.ok) {
      setRole(prev)
      setStatus(`save failed${r.error ? ` — ${r.error}` : ''}`)
      return
    }
    setStatus(
      next
        ? `saved${typeof r.agentsUpdated === 'number' ? ` — ${r.agentsUpdated} agent${r.agentsUpdated === 1 ? '' : 's'} updated` : ''}`
        : 'cleared — text-only agents get no image descriptions',
    )
  }

  // Current value may reference a model missing from the catalog (renamed,
  // unloaded) — keep it selectable rather than silently showing something else.
  const options = visionModels.map((m) => m.id)
  if (role?.model && !options.includes(role.model)) options.unshift(role.model)

  return (
    <div className="tts-section">
      <div className="tts-section-header">
        <Eye size={13} />
        <span>Vision Description</span>
      </div>
      <div className="tts-section-body">
        {state === 'loading' ? (
          <div className="tts-empty">Loading current assignment…</div>
        ) : state === 'error' ? (
          <div className="tts-empty">
            Could not load the current assignment — not editable until it loads.{' '}
            <button className="tts-retry" onClick={load} style={{ cursor: 'pointer' }}>Retry</button>
          </div>
        ) : (
          <>
            <div className="tts-field">
              <label>Describer Model{saving ? ' (saving…)' : ''}</label>
              <select
                value={role?.model || ''}
                onChange={(e) => apply(e.target.value)}
                className="tts-select"
                disabled={saving}
              >
                <option value="">(None — text-only agents get no image descriptions)</option>
                {options.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
              {status && <span className="tts-hint">{status}</span>}
            </div>
            <span className="tts-hint">
              Only used for text-only agents: a non-vision model can't see pixels, so incoming
              images are described to it by this model. Vision-capable agents ignore it — they
              see images natively.
            </span>
          </>
        )}
      </div>
    </div>
  )
}

export const TtsSettingsPanel: React.FC<{ store: any }> = observer(({ store }) => {
  const [ttsProviders, setTtsProviders] = useState<TtsProvider[]>([])
  const [sttProviders, setSttProviders] = useState<SttProvider[]>([])
  const [rvcModelList, setRvcModelList] = useState<RvcModel[]>([])
  const [refreshing, setRefreshing] = useState(false)

  // Hydrate from store settings, falling back to localStorage, then defaults
  const storedTts = store.settings?.ttsConfig
    || (() => { try { return JSON.parse(localStorage.getItem('gyshell-tts-config') || 'null') } catch { return null } })()
  const storedStt = store.settings?.sttConfig
    || (() => { try { return JSON.parse(localStorage.getItem('gyshell-stt-config') || 'null') } catch { return null } })()
  const ttsConfig: TtsConfig = { ...DEFAULT_TTS_CONFIG, ...storedTts }
  const sttConfig: SttConfig = { ...DEFAULT_STT_CONFIG, ...storedStt }

  const loadProviders = () => {
    setTtsProviders(getTtsProviders())
    setSttProviders(getSttProviders())
    setRvcModelList(getRvcModels())
  }

  useEffect(() => { loadProviders() }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    await discoverModels()
    loadProviders()
    setRefreshing(false)
  }

  const updateTts = (patch: Partial<TtsConfig>) => {
    const updated = { ...ttsConfig, ...patch }
    if (store.settings) store.settings.ttsConfig = updated
    localStorage.setItem('gyshell-tts-config', JSON.stringify(updated))
  }

  const updateStt = (patch: Partial<SttConfig>) => {
    const updated = { ...sttConfig, ...patch }
    if (store.settings) store.settings.sttConfig = updated
    localStorage.setItem('gyshell-stt-config', JSON.stringify(updated))
  }

  // Collect all voices and RVC models
  const allVoices = ttsProviders.flatMap(p => p.voices)
  const uniqueVoices = [...new Set(allVoices)]
  const allTtsModels = ttsProviders.flatMap(p => p.models)
  const uniqueTtsModels = [...new Set(allTtsModels)]

  return (
    <div className="tts-settings-panel">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <Volume2 size={16} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>Support Models</span>
        <button
          className={`proxlab-refresh ${refreshing ? 'spinning' : ''}`}
          onClick={handleRefresh}
          title="Refresh providers"
          style={{ marginLeft: 'auto' }}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* ─── Vision Description Section ───────────────────────────── */}
      <VisionDescriptionSection />

      {/* ─── STT Section ──────────────────────────────────────────── */}
      <div className="tts-section">
        <div className="tts-section-header">
          <Mic size={13} />
          <span>Speech-to-Text</span>
          <label className="tts-toggle" style={{ marginLeft: 'auto' }}>
            <input
              type="checkbox"
              checked={sttConfig.enabled}
              onChange={(e) => updateStt({ enabled: e.target.checked })}
            />
            <span className="tts-toggle-label">{sttConfig.enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>

        {sttConfig.enabled && (
          <div className="tts-section-body">
            {sttProviders.length === 0 ? (
              <div className="tts-empty">No STT providers detected</div>
            ) : (
              <>
                <div className="tts-field">
                  <label>Provider</label>
                  <select
                    value={sttConfig.provider}
                    onChange={(e) => updateStt({ provider: Number(e.target.value) })}
                    className="tts-select"
                  >
                    {sttProviders.map(p => (
                      <option key={p.slot} value={p.slot}>
                        {p.providerName} (slot {p.slot}, {p.node})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="tts-field">
                  <label>Model</label>
                  <select
                    value={sttConfig.model}
                    onChange={(e) => updateStt({ model: e.target.value })}
                    className="tts-select"
                  >
                    {sttProviders
                      .find(p => p.slot === sttConfig.provider)
                      ?.models.map(m => (
                        <option key={m} value={m}>{m}</option>
                      )) || <option value="">No models available</option>}
                  </select>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ─── TTS Section ──────────────────────────────────────────── */}
      <div className="tts-section">
        <div className="tts-section-header">
          <Volume2 size={13} />
          <span>Text-to-Speech</span>
          <label className="tts-toggle" style={{ marginLeft: 'auto' }}>
            <input
              type="checkbox"
              checked={ttsConfig.enabled}
              onChange={(e) => updateTts({ enabled: e.target.checked })}
            />
            <span className="tts-toggle-label">{ttsConfig.enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>

        {ttsConfig.enabled && (
          <div className="tts-section-body">
            {ttsProviders.length === 0 ? (
              <div className="tts-empty">No TTS providers detected</div>
            ) : (
              <>
                {/* TTS Model */}
                <div className="tts-field">
                  <label>TTS Model</label>
                  <select
                    value={ttsConfig.defaultModel}
                    onChange={(e) => updateTts({ defaultModel: e.target.value })}
                    className="tts-select"
                  >
                    {uniqueTtsModels.length > 0
                      ? uniqueTtsModels.map(m => <option key={m} value={m}>{m}</option>)
                      : <option value="f5-tts">f5-tts</option>}
                  </select>
                </div>

                {/* Default Voice */}
                <div className="tts-field">
                  <label>Default Voice</label>
                  <select
                    value={ttsConfig.defaultVoice}
                    onChange={(e) => updateTts({ defaultVoice: e.target.value })}
                    className="tts-select"
                  >
                    <option value="default">default</option>
                    {uniqueVoices.filter(v => v !== 'default').map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </div>

                {/* Pipeline Mode */}
                <div className="tts-field-row">
                  <label className="tts-toggle">
                    <input
                      type="checkbox"
                      checked={ttsConfig.dualPipeline}
                      onChange={(e) => updateTts({ dualPipeline: e.target.checked })}
                    />
                    <span className="tts-toggle-label">Dual Pipeline</span>
                  </label>
                  <span className="tts-hint">
                    {ttsConfig.dualPipeline
                      ? 'Round-robin across TTS workers for faster generation'
                      : 'Single pipeline — sequential processing'}
                  </span>
                </div>

                {/* RVC Toggle */}
                <div className="tts-field-row">
                  <label className="tts-toggle">
                    <input
                      type="checkbox"
                      checked={ttsConfig.rvcEnabled}
                      onChange={(e) => updateTts({ rvcEnabled: e.target.checked })}
                    />
                    <span className="tts-toggle-label">RVC Voice Conversion</span>
                  </label>
                  <span className="tts-hint">
                    {ttsConfig.rvcEnabled
                      ? 'Generated speech is passed through RVC for voice cloning'
                      : 'Direct TTS output without voice conversion'}
                  </span>
                </div>

                {/* RVC Model (only shown when RVC enabled) */}
                {ttsConfig.rvcEnabled && (
                  <div className="tts-field">
                    <label>RVC Voice Model</label>
                    {rvcModelList.length > 0 ? (
                      <select
                        value={ttsConfig.rvcModel}
                        onChange={(e) => updateTts({ rvcModel: e.target.value })}
                        className="tts-select"
                      >
                        <option value="">(None — select a voice)</option>
                        {rvcModelList.map(m => (
                          <option key={m.name} value={m.name}>
                            {m.name}{m.loaded ? ' (loaded)' : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={ttsConfig.rvcModel}
                        onChange={(e) => updateTts({ rvcModel: e.target.value })}
                        placeholder="Enter RVC model name (no models discovered)"
                        className="tts-input"
                      />
                    )}
                    <span className="tts-hint">
                      {rvcModelList.length > 0
                        ? `${rvcModelList.length} voice models available`
                        : 'Could not discover RVC models — enter name manually'}
                    </span>
                  </div>
                )}

                {/* Provider status */}
                <div className="tts-providers-summary">
                  <span className="tts-providers-label">Available providers:</span>
                  {ttsProviders.map(p => (
                    <span key={p.slot} className="tts-provider-badge">
                      <CircleDot size={6} className={p.status === 'healthy' ? 'active' : ''} />
                      {p.providerName} (slot {p.slot})
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

// ─── Voice Selector Popup ─────────────────────────────────────────────────────

export interface VoiceSelectorProps {
  onClose: () => void
  onSave: (voice: string, rvcVoice?: string) => void
  currentVoice?: string
  currentRvcVoice?: string
  ttsConfig: TtsConfig
  voices: string[]
  rvcModels: RvcModel[]
}

export const VoiceSelector: React.FC<VoiceSelectorProps> = ({
  onClose, onSave, currentVoice, currentRvcVoice, ttsConfig, voices, rvcModels,
}) => {
  const [voice, setVoice] = useState(currentVoice || ttsConfig.defaultVoice || 'default')
  // "__none__" means explicitly no RVC — distinguish from empty/undefined which means "use default"
  const [rvcVoice, setRvcVoice] = useState(currentRvcVoice || '__none__')

  return createPortal(
    <div className="voice-selector-overlay" onClick={onClose}>
      <div className="voice-selector-popup" onClick={(e) => e.stopPropagation()}>
        <div className="voice-selector-header">
          <Volume2 size={14} />
          <span>Voice Settings</span>
          <button className="voice-selector-close" onClick={onClose}>x</button>
        </div>

        <div className="voice-selector-body">
          <div className="tts-field">
            <label>TTS Voice ({voices.length} available)</label>
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              className="tts-select"
              style={{ minHeight: 28 }}
            >
              <option value="default">default</option>
              {voices.filter(v => v !== 'default').map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>

          {ttsConfig.rvcEnabled && (
            <div className="tts-field">
              <label>RVC Voice Model</label>
              {rvcModels.length > 0 ? (
                <select
                  value={rvcVoice}
                  onChange={(e) => setRvcVoice(e.target.value)}
                  className="tts-select"
                >
                  <option value="__none__">(None — skip RVC)</option>
                  {rvcModels.map(m => (
                    <option key={m.name} value={m.name}>
                      {m.name}{m.loaded ? ' (loaded)' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={rvcVoice}
                  onChange={(e) => setRvcVoice(e.target.value)}
                  placeholder="RVC model name"
                  className="tts-input"
                />
              )}
            </div>
          )}
        </div>

        <div className="voice-selector-footer">
          <button
            className="voice-selector-save"
            onClick={() => onSave(voice, ttsConfig.rvcEnabled ? rvcVoice : undefined)}
          >
            Save
          </button>
          <button className="voice-selector-cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
