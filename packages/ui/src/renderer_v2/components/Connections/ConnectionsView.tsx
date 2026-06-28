import React from 'react'
import { observer } from 'mobx-react-lite'
import { ArrowLeft, KeyRound, LockKeyhole, Pencil, Plus, Save, Server, Shield, Trash2, Upload, Waypoints } from 'lucide-react'
import { v4 as uuidv4 } from 'uuid'
import type { AppStore } from '../../stores/AppStore'
import { PortForwardType, type TunnelEntry } from '../../lib/ipcTypes'
import './connections.scss'
import { ConfirmDialog } from '../Common/ConfirmDialog'

import { Select } from '../../platform/Select'
import {
  CONNECTION_MANAGER_SECTIONS,
  getConnectionManagerSectionDefinition,
  type ConnectionsSection,
} from './connectionManagerRegistry'

export const ConnectionsView: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const t = store.i18n.t
  const [section, setSection] = React.useState<ConnectionsSection>('ssh')
  const sectionDefinition = React.useMemo(
    () => getConnectionManagerSectionDefinition(section),
    [section],
  )
  const ssh = store.settings?.connections?.ssh ?? []

  const proxies = store.settings?.connections?.proxies ?? []
  const tunnels = store.settings?.connections?.tunnels ?? []

  const [editingId, setEditingId] = React.useState<string | null>(null)

  const [draft, setDraft] = React.useState<any>(null)
  const [deleteConfirm, setDeleteConfirm] = React.useState<null | { section: ConnectionsSection; id: string }>(null)

  // Managed SSH keys + the upload-keyfile flow
  const sshKeys: Array<{ id: string; name: string; content: string }> =
    (store.settings?.connections as any)?.sshKeys ?? []
  const [showKeyUpload, setShowKeyUpload] = React.useState(false)
  const [keyDragOver, setKeyDragOver] = React.useState(false)
  const [keyError, setKeyError] = React.useState<string | null>(null)
  const keyFileInputRef = React.useRef<HTMLInputElement | null>(null)

  async function ingestKeyFile(file: File | null | undefined) {
    if (!file) return
    setKeyError(null)
    try {
      const content = (await file.text()).trim()
      if (!/PRIVATE KEY|BEGIN .*KEY/.test(content)) {
        setKeyError('That file does not look like a private key.')
        return
      }
      const id = uuidv4()
      await store.saveSshKey({ id, name: file.name, content, createdAt: Date.now() })
      setDraft((d: any) => ({ ...d, keyId: id, privateKey: undefined, privateKeyPath: undefined }))
      setShowKeyUpload(false)
    } catch {
      setKeyError('Could not read that file.')
    }
  }

  React.useEffect(() => {
    // reset editor when switching sections
    setEditingId(null)
    setDraft(null)
  }, [section])

  function startNewEntry() {
    const nextDraft = sectionDefinition.createDraft()
    setEditingId(nextDraft.id)
    setDraft(nextDraft)
  }

  function startEdit(entry: any) {
    setEditingId(entry.id)
    setDraft({ ...entry })
  }

  async function saveDraft() {
    if (!draft) return
    await sectionDefinition.saveDraft(store, draft)
  }

  async function deleteCurrent() {
    if (!editingId) return
    setDeleteConfirm({ section, id: editingId })
  }

  return (
    <div className="connections">
      <ConfirmDialog
        open={!!deleteConfirm}
        title={t.common.confirmDeleteTitle}
        message={t.common.confirmDeleteConfig}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={async () => {
          if (!deleteConfirm) return
          const { section: sec, id } = deleteConfirm
          await getConnectionManagerSectionDefinition(sec).deleteEntry(store, id)
          setDeleteConfirm(null)
          setEditingId(null)
          setDraft(null)
        }}
      />
      <div className="connections-sidebar">
        <button className="connections-back-btn" onClick={() => store.closeOverlay()} title={t.common.back}>
          <ArrowLeft size={16} strokeWidth={2} />
        </button>

        <div className="connections-nav">
          {CONNECTION_MANAGER_SECTIONS.map((item) => {
            const Icon = item.icon
            const label =
              item.labelKey === 'ssh'
                ? t.connections.ssh
                : item.labelKey === 'proxy'
                  ? t.connections.proxy
                  : t.connections.tunnels
            return (
              <div
                key={item.id}
                className={section === item.id ? 'connections-nav-item is-active' : 'connections-nav-item'}
                onClick={() => setSection(item.id)}
                role="button"
                tabIndex={0}
              >
                <span className="icon">
                  <Icon size={16} strokeWidth={2} />
                </span>
                <span>{label}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="connections-content">
        {section === 'ssh' ? (
          <>
            <div className="connections-header">
              <div className="connections-title">{t.connections.ssh}</div>
              <div className="connections-actions">
                {/* Add new remote connection (as requested: + placed inside SSH panel) */}
                <button className="icon-btn-sm" title={t.common.add} onClick={startNewEntry}>
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
            </div>

            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header">
                  <div className="connections-row-main header-main">
                    <div>{t.common.name}</div>
                    <div>{t.common.host}</div>
                    <div>{t.common.port}</div>
                    <div>{t.common.user}</div>
                  </div>
                  <div className="row-icon header-icon" aria-hidden="true" />
                </div>
                {ssh.map((c) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button
                      className="connections-row-main"
                      onClick={() => startEdit(c)}
                      title={t.common.edit}
                    >
                      <div>{c.name}</div>
                      <div>{c.host}</div>
                      <div>{c.port}</div>
                      <div>{c.username}</div>
                    </button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}>
                      <Pencil size={14} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                {!ssh.length ? <div className="connections-empty">No SSH connections yet.</div> : null}
              </div>

              <div className="connections-editor">
                {!draft ? (
                  <div className="editor-empty">{t.common.selectOrCreate}</div>
                ) : (
                  <div className="editor-card">
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Server size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.name}
                        value={draft.name ?? ''}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Server size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.host}
                        value={draft.host ?? ''}
                        onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Server size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.port}
                        value={String(draft.port ?? 22)}
                        onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Server size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.user}
                        value={draft.username ?? ''}
                        onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <KeyRound size={16} strokeWidth={2} />
                      </span>
                      <Select
                        className="editor-select"
                        value={draft.authMethod ?? 'password'}
                        onChange={(val) => setDraft({ ...draft, authMethod: val })}
                        options={[
                          { value: 'password', label: 'Password' },
                          { value: 'privateKey', label: 'Private Key' }
                        ]}
                      />
                    </div>

                    {/* Default pwd, but all fields supported: show key/path/passphrase in key mode */}
                    {(draft.authMethod ?? 'password') === 'password' ? (
                    <div className="editor-row">
                      <span className="editor-icon">
                        <LockKeyhole size={16} strokeWidth={2} />
                      </span>
                      <input
                        type="password"
                        className="editor-input"
                        placeholder={t.common.password}
                        autoComplete="new-password"
                        value={draft.password ?? ''}
                        onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                      />
                    </div>
                    ) : (
                      <>
                        {/* SSH key picker — choose a managed key or upload a new one */}
                        <div className="editor-row">
                          <span className="editor-icon">
                            <KeyRound size={16} strokeWidth={2} />
                          </span>
                          <Select
                            className="editor-select"
                            value={sshKeys.length ? (draft.keyId ?? '') : '__upload_key__'}
                            onChange={(val) => {
                              if (val === '__upload_key__') {
                                setShowKeyUpload(true)
                              } else {
                                setShowKeyUpload(false)
                                setKeyError(null)
                                setDraft({ ...draft, keyId: val || undefined, privateKey: undefined, privateKeyPath: undefined })
                              }
                            }}
                            options={
                              sshKeys.length
                                ? [
                                    { value: '', label: 'Select a key…' },
                                    ...sshKeys.map((k) => ({ value: k.id, label: k.name })),
                                    { value: '__upload_key__', label: '⬆  Upload keyfile…' },
                                  ]
                                : [{ value: '__upload_key__', label: '⬆  Upload keyfile…' }]
                            }
                          />
                        </div>
                        {(showKeyUpload || sshKeys.length === 0) && (
                          <div className="editor-row">
                            <span className="editor-icon">
                              <Upload size={16} strokeWidth={2} />
                            </span>
                            <div
                              className={`ssh-key-dropzone${keyDragOver ? ' is-drag' : ''}`}
                              onClick={() => keyFileInputRef.current?.click()}
                              onDragOver={(e) => { e.preventDefault(); setKeyDragOver(true) }}
                              onDragLeave={() => setKeyDragOver(false)}
                              onDrop={(e) => { e.preventDefault(); setKeyDragOver(false); void ingestKeyFile(e.dataTransfer.files?.[0]) }}
                            >
                              Drag a private key file here, or click to browse…
                            </div>
                            <input
                              ref={keyFileInputRef}
                              type="file"
                              style={{ display: 'none' }}
                              onChange={(e) => { void ingestKeyFile(e.target.files?.[0]); e.target.value = '' }}
                            />
                          </div>
                        )}
                        {keyError && (
                          <div className="editor-row">
                            <span className="editor-icon" />
                            <div className="ssh-key-error">{keyError}</div>
                          </div>
                        )}
                        <div className="editor-row">
                          <span className="editor-icon">
                            <LockKeyhole size={16} strokeWidth={2} />
                          </span>
                          <input
                            className="editor-input"
                            placeholder={t.common.passphrase}
                            value={draft.passphrase ?? ''}
                            onChange={(e) => setDraft({ ...draft, passphrase: e.target.value })}
                          />
                        </div>
                      </>
                    )}

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Shield size={16} strokeWidth={2} />
                      </span>
                      <Select
                        className="editor-select"
                        value={draft.proxyId ?? ''}
                        onChange={(id) => setDraft({ ...draft, proxyId: id || undefined })}
                        options={[
                          { value: '', label: `${t.connections.proxy}: None` },
                          ...proxies.map(p => ({ value: p.id, label: p.name }))
                        ]}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Waypoints size={16} strokeWidth={2} />
                      </span>
                      <Select
                        className="editor-select"
                        value={draft.jumpHost?.id ?? ''}
                        onChange={(selectedId) => {
                          if (!selectedId) {
                            const { jumpHost, ...rest } = draft
                            setDraft(rest)
                          } else {
                            const selected = ssh.find(s => s.id === selectedId)
                            if (selected) {
                              setDraft({ ...draft, jumpHost: { ...selected } })
                            }
                          }
                        }}
                        options={[
                          { value: '', label: `${t.connections.jumpHost}: None` },
                          ...ssh.filter(s => s.id !== draft.id).map(s => ({ value: s.id, label: s.name || s.host }))
                        ]}
                      />
                    </div>

                    <div className="editor-row" style={{ height: 'auto', alignItems: 'flex-start', padding: '8px 0' }}>
                      <span className="editor-icon" style={{ marginTop: 6 }}>
                        <Waypoints size={16} strokeWidth={2} />
                      </span>
                      <div style={{ flex: 1, padding: '0 8px' }}>
                        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 4 }}>{t.connections.tunnels}</div>
                        {tunnels.map(tu => (
                          <div key={tu.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                            <input
                              type="checkbox"
                              checked={(draft.tunnelIds ?? []).includes(tu.id)}
                              onChange={(e) => {
                                const current = draft.tunnelIds ?? []
                                if (e.target.checked) setDraft({ ...draft, tunnelIds: [...current, tu.id] })
                                else setDraft({ ...draft, tunnelIds: current.filter((x: string) => x !== tu.id) })
                              }}
                            />
                            <span style={{ fontSize: 13, color: 'var(--fg)' }}>{tu.name}</span>
                          </div>
                        ))}
                        {!tunnels.length && <div style={{ fontSize: 12, color: 'var(--fg-muted)', opacity: 0.5 }}>No tunnels defined</div>}
                      </div>
                    </div>

                    <div className="editor-actions">
                      <button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}>
                        <Save size={16} strokeWidth={2} />
                      </button>
                      <button
                        className="icon-btn-sm danger"
                        title={t.common.delete}
                        onClick={deleteCurrent}
                      >
                        <Trash2 size={16} strokeWidth={2} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}

        {section === 'proxies' ? (
          <>
            <div className="connections-header">
              <div className="connections-title">{t.connections.proxy}</div>
              <div className="connections-actions">
                <button className="icon-btn-sm" title={t.common.add} onClick={startNewEntry}>
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
            </div>
            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header">
                  <div className="connections-row-main header-main">
                    <div>{t.common.name}</div>
                    <div>{t.common.host}</div>
                    <div>{t.common.port}</div>
                    <div>{t.connections.type}</div>
                  </div>
                  <div className="row-icon header-icon" aria-hidden="true" />
                </div>
                {proxies.map((c) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button className="connections-row-main" onClick={() => startEdit(c)} title={t.common.edit}>
                      <div>{c.name}</div>
                      <div>{c.host}</div>
                      <div>{c.port}</div>
                      <div>{c.type}</div>
                    </button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}>
                      <Pencil size={14} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                {!proxies.length ? <div className="connections-empty">No Proxies defined.</div> : null}
              </div>
              <div className="connections-editor">
                {!draft ? (
                  <div className="editor-empty">{t.common.selectOrCreate}</div>
                ) : (
                  <div className="editor-card">
                    <div className="editor-row">
                      <span className="editor-icon"><Shield size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.name}
                        value={draft.name ?? ''}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <Select
                        className="editor-select"
                        value={draft.type ?? 'socks5'}
                        onChange={(val) => setDraft({ ...draft, type: val })}
                        options={[
                          { value: 'socks5', label: 'SOCKS5' },
                          { value: 'http', label: 'HTTP' }
                        ]}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.host}
                        value={draft.host ?? ''}
                        onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.port}
                        value={String(draft.port ?? 1080)}
                        onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Shield size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.connections.username}
                        value={draft.username ?? ''}
                        onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><LockKeyhole size={16} /></span>
                      <input
                        type="password"
                        className="editor-input"
                        placeholder={t.common.password}
                        autoComplete="new-password"
                        value={draft.password ?? ''}
                        onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                      />
                    </div>
                    <div className="editor-actions">
                      <button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}><Save size={16} /></button>
                      <button className="icon-btn-sm danger" title={t.common.delete} onClick={deleteCurrent}><Trash2 size={16} /></button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}

        {section === 'tunnels' ? (
          <>
            <div className="connections-header">
              <div className="connections-title">{t.connections.tunnels}</div>
              <div className="connections-actions">
                <button className="icon-btn-sm" title={t.common.add} onClick={startNewEntry}>
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
            </div>
            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header">
                  <div className="connections-row-main header-main is-tunnel">
                    <div>{t.common.name}</div>
                    <div>{t.connections.type}</div>
                    <div>{t.common.host}:{t.common.port}</div>
                    <div>{t.connections.targetHost}</div>
                  </div>
                  <div className="row-icon header-icon" aria-hidden="true" />
                </div>
                {tunnels.map((c: TunnelEntry) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button className="connections-row-main is-tunnel" onClick={() => startEdit(c)} title={t.common.edit}>
                      <div>{c.name}</div>
                      <div>{c.type}</div>
                      <div>{c.host}:{c.port}</div>
                      <div>{c.type === PortForwardType.Dynamic ? 'SOCKS proxy' : `${c.targetAddress}:${c.targetPort}`}</div>
                    </button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}>
                      <Pencil size={14} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                {!tunnels.length ? <div className="connections-empty">No Tunnels defined.</div> : null}
              </div>
              <div className="connections-editor">
                {!draft ? (
                  <div className="editor-empty">{t.common.selectOrCreate}</div>
                ) : (
                  <div className="editor-card">
                    <div className="editor-row">
                      <span className="editor-icon"><Waypoints size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.name}
                        value={draft.name ?? ''}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <Select
                        className="editor-select"
                        value={draft.type ?? PortForwardType.Local}
                        onChange={(val) => setDraft({ ...draft, type: val as PortForwardType })}
                        options={[
                          { value: PortForwardType.Local, label: 'Local' },
                          { value: PortForwardType.Remote, label: 'Remote' },
                          { value: PortForwardType.Dynamic, label: 'Dynamic' }
                        ]}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.host}
                        value={draft.host ?? '127.0.0.1'}
                        onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.port}
                        value={String(draft.port ?? 8080)}
                        onChange={(e) => setDraft({ ...draft, port: parseInt(e.target.value) || 8080 })}
                      />
                    </div>

                    {draft.type !== PortForwardType.Dynamic && (
                      <>
                        <div className="editor-row">
                          <span className="editor-icon"><Server size={16} /></span>
                          <input
                            className="editor-input"
                            placeholder={t.connections.targetHost}
                            value={draft.targetAddress ?? '127.0.0.1'}
                            onChange={(e) => setDraft({ ...draft, targetAddress: e.target.value })}
                          />
                        </div>
                        <div className="editor-row">
                          <span className="editor-icon"><Server size={16} /></span>
                          <input
                            className="editor-input"
                            placeholder={t.connections.targetPort}
                            value={String(draft.targetPort ?? 80)}
                            onChange={(e) => setDraft({ ...draft, targetPort: parseInt(e.target.value) || 80 })}
                          />
                        </div>
                      </>
                    )}

                    {draft.type === PortForwardType.Dynamic && (
                      <div className="editor-row">
                        <span className="editor-icon"><Shield size={16} /></span>
                        <div className="editor-input" style={{ backgroundColor: 'var(--bg-secondary)', padding: '8px' }}>
                          SOCKS proxy
                        </div>
                      </div>
                    )}

                    <div className="editor-actions">
                      <button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}><Save size={16} /></button>
                      <button className="icon-btn-sm danger" title={t.common.delete} onClick={deleteCurrent}><Trash2 size={16} /></button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
})

