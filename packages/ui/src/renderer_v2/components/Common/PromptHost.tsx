import React from 'react'
import { observer } from 'mobx-react-lite'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { promptStore as s } from '../../stores/promptStore'
import './confirmDialog.scss'

/** Globally-mounted host for the promise-based text prompt (reuses the confirm-dialog styling). */
export const PromptHost: React.FC = observer(() => {
  if (!s.open) return null
  return createPortal(
    <div className="gy-confirm-overlay" role="dialog" aria-modal="true">
      <div className="gy-confirm-card">
        <div className="gy-confirm-header">
          <div className="gy-confirm-title">{s.title}</div>
          <button className="icon-btn-sm" onClick={() => s.cancel()} title="Cancel"><X size={18} /></button>
        </div>
        <div className="gy-confirm-body">
          {s.label && <div className="gy-confirm-message">{s.label}</div>}
          <input
            autoFocus
            value={s.value}
            placeholder={s.placeholder}
            onChange={(e) => s.setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') s.submit(); if (e.key === 'Escape') s.cancel() }}
            style={{ width: '100%', marginTop: 8, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--control-bg)', color: 'var(--fg)', fontSize: 13, boxSizing: 'border-box' }}
          />
        </div>
        <div className="gy-confirm-footer">
          <button className="gy-btn gy-btn-secondary" onClick={() => s.cancel()}>Cancel</button>
          <button className="gy-btn gy-btn-primary" onClick={() => s.submit()} disabled={!s.value.trim()}>{s.confirmText}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
})
