import React from 'react'
import { observer } from 'mobx-react-lite'
import { Square } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import { isLinux } from '../../platform/platform'
import './topbar.scss'

const gyshell = () => (window as any)?.gyshell

export const TopBar: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const linux = isLinux()

  const handleMaximize = () => gyshell()?.windowControls?.maximize?.()

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="topbar-title">AI-Lab</div>
      </div>
      {/*
        Settings gear removed — now lives on the primary sidebar at the bottom.
        Connections (3-slider) icon moved to the Terminal panel, since it only
        affects terminal connections.
      */}
      {linux ? (
        <div className="linux-wc">
          {/* Minimize + Close removed — desktop holdovers, irrelevant in the web build. */}
          <button className="linux-wc-btn" title="Maximize" onClick={handleMaximize}>
            <Square size={11} strokeWidth={2} />
          </button>
        </div>
      ) : null}
    </div>
  )
})
