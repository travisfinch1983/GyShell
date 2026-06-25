import React, { useState } from 'react'
import styles from './Cluster.module.scss'

/**
 * In-page confirm + edit dialogs. Coding standard #2: NEVER use native browser
 * popups (window.confirm / window.prompt) — every dialog is an in-page component.
 */

export const ConfirmModal: React.FC<{
  title: string
  message?: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}> = ({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose }) => (
  <div className={styles.modalOverlay} onClick={onClose}>
    <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
      <div className={styles.modalTitle}>{title}</div>
      {message && <div className={styles.confirmMsg}>{message}</div>}
      <div className={styles.modalActions}>
        <button onClick={onClose}>Cancel</button>
        <button
          className={danger ? styles.danger : styles.primary}
          onClick={() => {
            onConfirm()
            onClose()
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
)

export const EditValueModal: React.FC<{
  title: string
  label: string
  initial: string
  hint?: string
  onSubmit: (value: string) => void
  onClose: () => void
}> = ({ title, label, initial, hint, onSubmit, onClose }) => {
  const [value, setValue] = useState(initial)
  const submit = () => {
    if (value.trim()) onSubmit(value.trim())
    onClose()
  }
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>{title}</div>
        <div className={styles.modalRow}>
          <label>{label}</label>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onClose()
            }}
          />
        </div>
        {hint && <div className={styles.modalNote}>{hint}</div>}
        <div className={styles.modalActions}>
          <button onClick={onClose}>Cancel</button>
          <button className={styles.primary} onClick={submit}>
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
