/**
 * ProxlabServicesPanel — Read-only display of auto-discovered ProxLab services.
 *
 * Shows LLM models, embeddings, reranker, TTS providers (with voices/models),
 * and STT providers. Refreshes on mount from the ProxlabDiscovery cache.
 */

import React, { useState, useEffect } from 'react'
import {
  Brain, Mic, Volume2, Search, Layers, Server, RefreshCw,
  ChevronDown, ChevronRight, CircleDot,
} from 'lucide-react'
import {
  getDiscoveredModels,
  getEmbedModelId,
  getRerankModelId,
  getTtsProviders,
  getSttProviders,
  getServices,
  discoverModels,
  type DiscoveredModel,
  type TtsProvider,
  type SttProvider,
  type ProxlabServices,
} from '../../services/ProxlabDiscovery'
import './ProxlabServicesPanel.scss'

export const ProxlabServicesPanel: React.FC = () => {
  const [models, setModels] = useState<DiscoveredModel[]>([])
  const [embedId, setEmbedId] = useState<string | null>(null)
  const [rerankId, setRerankId] = useState<string | null>(null)
  const [tts, setTts] = useState<TtsProvider[]>([])
  const [stt, setStt] = useState<SttProvider[]>([])
  const [services, setServices] = useState<Partial<ProxlabServices>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['llm']))

  const loadFromCache = () => {
    setModels(getDiscoveredModels())
    setEmbedId(getEmbedModelId())
    setRerankId(getRerankModelId())
    setTts(getTtsProviders())
    setStt(getSttProviders())
    setServices(getServices())
  }

  useEffect(() => { loadFromCache() }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    await discoverModels()
    loadFromCache()
    setRefreshing(false)
  }

  const toggleSection = (id: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const friendlyModelName = (id: string) =>
    id.replace(/^koboldcpp\//, '')
      .replace(/-UD-Q\d+_K(_XL)?(-\d+-of-\d+)?$/i, '')
      .replace(/\.Q\d+_K$/i, '')

  const svcCount = (type: string) =>
    (services as any)[type]?.length || 0

  return (
    <div className="proxlab-services-panel">
      <div className="proxlab-header">
        <Server size={14} />
        <span className="proxlab-title">ProxLab Services</span>
        <span className="proxlab-subtitle">Auto-discovered from local proxy</span>
        <button
          className={`proxlab-refresh ${refreshing ? 'spinning' : ''}`}
          onClick={handleRefresh}
          title="Refresh discovery"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* LLM Models */}
      <div className="proxlab-section">
        <div className="proxlab-section-header" onClick={() => toggleSection('llm')}>
          {expandedSections.has('llm') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Brain size={12} />
          <span>LLM Models</span>
          <span className="proxlab-count">{models.length}</span>
        </div>
        {expandedSections.has('llm') && (
          <div className="proxlab-section-body">
            {models.length === 0 ? (
              <div className="proxlab-empty">No LLM models detected</div>
            ) : (
              models.map(m => (
                <div key={m.id} className="proxlab-item">
                  <CircleDot size={8} className="proxlab-dot active" />
                  <span className="proxlab-item-name">{friendlyModelName(m.id)}</span>
                  <span className="proxlab-item-meta">slot {m.slot}</span>
                  <span className="proxlab-item-meta">{m.node}</span>
                  <span className="proxlab-item-meta">{m.provider}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Embeddings */}
      <div className="proxlab-section">
        <div className="proxlab-section-header" onClick={() => toggleSection('embed')}>
          {expandedSections.has('embed') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Layers size={12} />
          <span>Embeddings</span>
          <span className="proxlab-count">{svcCount('embed')}</span>
        </div>
        {expandedSections.has('embed') && (
          <div className="proxlab-section-body">
            {embedId ? (
              <div className="proxlab-item">
                <CircleDot size={8} className="proxlab-dot active" />
                <span className="proxlab-item-name">{embedId}</span>
                <span className="proxlab-item-meta">4096 dims</span>
              </div>
            ) : (
              <div className="proxlab-empty">No embedding model detected</div>
            )}
          </div>
        )}
      </div>

      {/* Reranker */}
      <div className="proxlab-section">
        <div className="proxlab-section-header" onClick={() => toggleSection('rerank')}>
          {expandedSections.has('rerank') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Search size={12} />
          <span>Reranker</span>
          <span className="proxlab-count">{svcCount('rerank')}</span>
        </div>
        {expandedSections.has('rerank') && (
          <div className="proxlab-section-body">
            {rerankId ? (
              <div className="proxlab-item">
                <CircleDot size={8} className="proxlab-dot active" />
                <span className="proxlab-item-name">{rerankId}</span>
                <span className="proxlab-item-meta">Cohere v2 format</span>
              </div>
            ) : (
              <div className="proxlab-empty">No reranker detected</div>
            )}
          </div>
        )}
      </div>

      {/* TTS Providers */}
      {(() => {
        const ttsServices = (services as any).tts || []
        const ttsProviderSlots = new Set(tts.map(p => p.slot))
        const rvcServices = ttsServices.filter((s: any) => !ttsProviderSlots.has(s.slot))
        const totalCount = tts.length + rvcServices.length
        return (
      <div className="proxlab-section">
        <div className="proxlab-section-header" onClick={() => toggleSection('tts')}>
          {expandedSections.has('tts') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Volume2 size={12} />
          <span>Text-to-Speech</span>
          <span className="proxlab-count">{totalCount} services</span>
        </div>
        {expandedSections.has('tts') && (
          <div className="proxlab-section-body">
            {tts.length === 0 ? (
              <div className="proxlab-empty">No TTS providers detected</div>
            ) : (
              tts.map(p => (
                <div key={p.slot} className="proxlab-provider">
                  <div className="proxlab-item">
                    <CircleDot size={8} className={`proxlab-dot ${p.status === 'healthy' ? 'active' : 'inactive'}`} />
                    <span className="proxlab-item-name">{p.providerName}</span>
                    <span className="proxlab-item-meta">slot {p.slot}</span>
                    <span className="proxlab-item-meta">{p.node}</span>
                    <span className={`proxlab-tag ${p.status === 'healthy' ? 'active' : ''}`}>{p.status}</span>
                  </div>
                  {p.models.length > 0 && (
                    <div className="proxlab-sub-list">
                      <span className="proxlab-sub-label">Models:</span>
                      {p.models.map(m => <span key={m} className="proxlab-sub-item">{m}</span>)}
                    </div>
                  )}
                  {p.voices.length > 0 && (
                    <div className="proxlab-sub-list">
                      <span className="proxlab-sub-label">Voices ({p.voices.length}):</span>
                      {p.voices.slice(0, 8).map(v => <span key={v} className="proxlab-sub-item">{v}</span>)}
                      {p.voices.length > 8 && <span className="proxlab-sub-item proxlab-more">+{p.voices.length - 8} more</span>}
                    </div>
                  )}
                  {p.capabilities.formats.length > 0 && (
                    <div className="proxlab-sub-list">
                      <span className="proxlab-sub-label">Formats:</span>
                      {p.capabilities.formats.map(f => <span key={f} className="proxlab-sub-item">{f}</span>)}
                    </div>
                  )}
                </div>
              ))
            )}
            {rvcServices.length > 0 && (
              <>
                <div className="proxlab-sub-divider">Voice Conversion (RVC)</div>
                {rvcServices.map((svc: any) => (
                  <div key={svc.slot} className="proxlab-item">
                    <CircleDot size={8} className="proxlab-dot active" />
                    <span className="proxlab-item-name">{svc.provider || 'RVC'}</span>
                    <span className="proxlab-item-meta">slot {svc.slot}</span>
                    <span className="proxlab-item-meta">{svc.node}</span>
                    <span className="proxlab-tag active">pipeline</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
        )
      })()}

      {/* STT Providers */}
      <div className="proxlab-section">
        <div className="proxlab-section-header" onClick={() => toggleSection('stt')}>
          {expandedSections.has('stt') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Mic size={12} />
          <span>Speech-to-Text</span>
          <span className="proxlab-count">{stt.length} providers</span>
        </div>
        {expandedSections.has('stt') && (
          <div className="proxlab-section-body">
            {stt.length === 0 ? (
              <div className="proxlab-empty">No STT providers detected</div>
            ) : (
              stt.map(p => (
                <div key={p.slot} className="proxlab-provider">
                  <div className="proxlab-item">
                    <CircleDot size={8} className={`proxlab-dot ${p.status === 'healthy' ? 'active' : 'inactive'}`} />
                    <span className="proxlab-item-name">{p.providerName}</span>
                    <span className="proxlab-item-meta">slot {p.slot}</span>
                    <span className="proxlab-item-meta">{p.node}</span>
                    <span className={`proxlab-tag ${p.status === 'healthy' ? 'active' : ''}`}>{p.status}</span>
                  </div>
                  {p.models.length > 0 && (
                    <div className="proxlab-sub-list">
                      <span className="proxlab-sub-label">Models:</span>
                      {p.models.map(m => <span key={m} className="proxlab-sub-item">{m}</span>)}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
