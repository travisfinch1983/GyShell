// ⚠ DORMANT / LEGACY — the minion system is retired (unwired from live code 2026-07-02). Kept for reference only; not imported anywhere.
/**
 * React Context for the MinionStore.
 * Allows any component in the tree to access the minion store.
 */

import React from 'react'
import { MinionStore } from './MinionStore'

const MinionContext = React.createContext<MinionStore | null>(null)

export const MinionProvider = MinionContext.Provider

export function useMinionStore(): MinionStore {
  const store = React.useContext(MinionContext)
  if (!store) throw new Error('useMinionStore must be used within MinionProvider')
  return store
}
