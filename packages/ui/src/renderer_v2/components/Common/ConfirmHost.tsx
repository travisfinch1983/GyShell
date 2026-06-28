import React from 'react'
import { observer } from 'mobx-react-lite'
import { ConfirmDialog } from './ConfirmDialog'
import { confirmStore } from '../../stores/confirmStore'

/** Single globally-mounted host that renders the promise-based confirmStore dialog. */
export const ConfirmHost: React.FC = observer(() => (
  <ConfirmDialog
    open={confirmStore.open}
    title={confirmStore.title}
    message={confirmStore.message}
    confirmText={confirmStore.confirmText}
    cancelText={confirmStore.cancelText}
    danger={confirmStore.danger}
    onConfirm={() => confirmStore.resolve(true)}
    onCancel={() => confirmStore.resolve(false)}
  />
))
