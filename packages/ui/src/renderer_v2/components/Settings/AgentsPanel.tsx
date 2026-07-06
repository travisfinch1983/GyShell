import React, { useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react-lite";
import { Plus, Pencil, Trash2, Users, X, Tag, Box, Wrench } from "lucide-react";
import type { AppStore, AgentDefinition } from "../../stores/AppStore";
import { ConfirmDialog } from "../Common/ConfirmDialog";
import { AgentToolsPicker } from "./AgentToolsPicker";
import { AGENT_ICON_REGISTRY } from "../../lib/agentIcons";

interface Props {
  store: AppStore;
}

const newAgentDraft = (): AgentDefinition => ({
  id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  name: "",
  description: "",
  systemPrompt: "",
  modelProfileIds: [],
  allowedTools: [],
  icon: "Bot",
  showInSidebar: true,
});

const AgentEditor = observer(
  ({
    store,
    agentId,
    onClose,
  }: {
    store: AppStore;
    agentId?: string;
    onClose: () => void;
  }) => {
    const existing = store.agents.find((a) => a.id === agentId);
    // Drop modelProfileIds that no longer correspond to a known item — those
    // are leftover references from the v7 model-id schema change. Keeps any
    // valid assignments so the user only re-picks the truly stale ones.
    const knownItemIds = useMemo(() => {
      const ids = new Set<string>();
      (store.settings?.models.items ?? []).forEach((m: any) => ids.add(m.id));
      return ids;
    }, [store.settings?.models.items]);

    const [draft, setDraft] = useState<AgentDefinition>(() =>
      existing
        ? {
            ...existing,
            allowedTools: [...existing.allowedTools],
            modelProfileIds: [...(existing.modelProfileIds ?? [])].filter((id) =>
              knownItemIds.has(id),
            ),
            icon: existing.icon || "Bot",
            showInSidebar: existing.showInSidebar !== false,
          }
        : newAgentDraft(),
    );
    const [isSaving, setIsSaving] = useState(false);

    const builtInTools = store.builtInTools.filter((t) => t.enabled);
    const mcpTools = store.mcpTools.filter((t) => t.enabled);

    // Multi-select against individual model definitions (items), not profiles.
    // Profiles are user-created bundles (most users have just one), but agents
    // need to address specific model instances — particularly when the user
    // has multiple instances of the same family (e.g. two Qwen3.5-4B servers).
    // Auto-discovered items from proxlab carry _proxlabSlots; manual entries
    // default to 1 lane.
    const allItems = (store.settings?.models.items ?? []) as any[];
    const assignableItems = allItems
      .filter((m) => !m._proxlabDisconnected)
      .slice()
      .sort((a, b) => String(a.name || a.model || "").localeCompare(String(b.name || b.model || "")));

    const itemSlots = (item: any): number =>
      typeof item?._proxlabSlots === "number" && item._proxlabSlots > 0 ? item._proxlabSlots : 1;

    const toggleTool = (name: string) => {
      setDraft((d) => {
        const has = d.allowedTools.includes(name);
        return {
          ...d,
          allowedTools: has ? d.allowedTools.filter((t) => t !== name) : [...d.allowedTools, name],
        };
      });
    };

    const toggleModel = (profileId: string) => {
      setDraft((d) => {
        const has = d.modelProfileIds.includes(profileId);
        return {
          ...d,
          modelProfileIds: has
            ? d.modelProfileIds.filter((id) => id !== profileId)
            : [...d.modelProfileIds, profileId],
        };
      });
    };

    const save = async () => {
      if (!draft.name.trim()) return;
      setIsSaving(true);
      try {
        await store.saveAgent(draft);
        onClose();
      } finally {
        setIsSaving(false);
      }
    };

    return (
      <div className="model-editor-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="model-editor-card" style={{ maxWidth: 720, width: "92%" }}>
          <div className="editor-header">
            <h3>{agentId ? "Edit Agent" : "Add Agent"}</h3>
            <button className="icon-btn-sm" onClick={onClose} disabled={isSaving}>
              <X size={16} />
            </button>
          </div>
          <div className="editor-body">
            <div className="editor-row">
              <span className="editor-icon"><Tag size={16} strokeWidth={2} /></span>
              <input
                className="editor-input"
                placeholder="Agent name (e.g. coder, planner, researcher)"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                disabled={isSaving}
              />
            </div>
            <div className="editor-row">
              <span className="editor-icon"><Box size={16} strokeWidth={2} /></span>
              <input
                className="editor-input"
                placeholder="One-line description (shown to delegating models)"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                disabled={isSaving}
              />
            </div>

            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 12, opacity: 0.75, marginBottom: 4, display: "block" }}>
                Icon
              </label>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(40px, 1fr))",
                  gap: 4,
                  padding: 8,
                  border: "1px solid var(--color-border)",
                  borderRadius: 4,
                  maxHeight: 132,
                  overflowY: "auto",
                }}
              >
                {AGENT_ICON_REGISTRY.map(({ name, icon: Icon }) => {
                  const selected = (draft.icon || "Bot") === name;
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setDraft({ ...draft, icon: name })}
                      title={name}
                      disabled={isSaving}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 32,
                        height: 32,
                        borderRadius: 4,
                        border: selected
                          ? "1.5px solid var(--accent, #3b82f6)"
                          : "1px solid var(--color-border)",
                        background: selected
                          ? "color-mix(in srgb, var(--accent, #3b82f6) 18%, transparent)"
                          : "transparent",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                      }}
                    >
                      <Icon size={16} strokeWidth={1.75} />
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={draft.showInSidebar !== false}
                  onChange={(e) => setDraft({ ...draft, showInSidebar: e.target.checked })}
                  disabled={isSaving}
                />
                <span>Show in sidebar</span>
                <span style={{ opacity: 0.6, fontSize: 11, marginLeft: 4 }}>
                  (icon shortcut + in-flight badge)
                </span>
              </label>
            </div>

            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 12, opacity: 0.75, marginBottom: 4, display: "block" }}>
                Models
                <span style={{ opacity: 0.6, marginLeft: 6 }}>
                  ({draft.modelProfileIds.length === 0
                    ? "inherit caller's active profile"
                    : `${draft.modelProfileIds.length} assigned`})
                </span>
              </label>
              <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>
                Select one or more models. The agent's pool round-robins across them — each model
                contributes its <code>--parallel</code> slots as concurrency lanes. Leave empty to
                inherit the caller's active profile.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 6, maxHeight: 220, overflowY: "auto", padding: 8, border: "1px solid var(--color-border)", borderRadius: 4 }}>
                {assignableItems.length === 0 && (
                  <div style={{ gridColumn: "1 / -1", fontSize: 12, opacity: 0.6 }}>
                    No models available. Make sure proxlab is running and at least one LLM service is up — auto-discovery refreshes every ~30s.
                  </div>
                )}
                {assignableItems.map((item) => {
                  const slots = itemSlots(item);
                  const label = String(item.name || item.model || item.id);
                  return (
                    <label
                      key={item.id}
                      style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}
                    >
                      <input
                        type="checkbox"
                        checked={draft.modelProfileIds.includes(item.id)}
                        onChange={() => toggleModel(item.id)}
                        disabled={isSaving}
                      />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                      <span style={{ opacity: 0.6, fontSize: 11, marginLeft: "auto", flexShrink: 0 }}>
                        {slots} slot{slots === 1 ? "" : "s"}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 12, opacity: 0.75, marginBottom: 4, display: "block" }}>System prompt</label>
              <textarea
                className="editor-input"
                style={{ width: "100%", minHeight: 140, fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
                placeholder="You are a focused coding agent. You..."
                value={draft.systemPrompt}
                onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                disabled={isSaving}
              />
            </div>

            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 12, opacity: 0.75, marginBottom: 4, display: "block" }}>
                Allowed tools <span style={{ opacity: 0.6 }}>({draft.allowedTools.length} selected)</span>
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 6, maxHeight: 220, overflowY: "auto", padding: 8, border: "1px solid var(--color-border)", borderRadius: 4 }}>
                {builtInTools.length > 0 && (
                  <div style={{ gridColumn: "1 / -1", fontSize: 11, opacity: 0.6, marginTop: 4 }}>Built-in</div>
                )}
                {builtInTools.map((tool) => (
                  <label key={`bi-${tool.name}`} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={draft.allowedTools.includes(tool.name)}
                      onChange={() => toggleTool(tool.name)}
                      disabled={isSaving}
                    />
                    <span title={tool.description || ""}>{tool.name}</span>
                  </label>
                ))}
                {mcpTools.length > 0 && (
                  <div style={{ gridColumn: "1 / -1", fontSize: 11, opacity: 0.6, marginTop: 8 }}>MCP servers</div>
                )}
                {mcpTools.map((tool) => (
                  <label key={`mcp-${tool.name}`} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={draft.allowedTools.includes(tool.name)}
                      onChange={() => toggleTool(tool.name)}
                      disabled={isSaving}
                    />
                    <span>{tool.name}</span>
                  </label>
                ))}
                {builtInTools.length === 0 && mcpTools.length === 0 && (
                  <div style={{ gridColumn: "1 / -1", fontSize: 12, opacity: 0.6 }}>
                    No tools enabled. Enable tools in the Tools tab first.
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="editor-footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: 12 }}>
            <button className="btn-secondary" onClick={onClose} disabled={isSaving}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={isSaving || !draft.name.trim()}>
              {isSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    );
  },
);

export const AgentsPanel: React.FC<Props> = observer(({ store }) => {
  const t = store.i18n.t;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [toolsAgentId, setToolsAgentId] = useState<string | null>(null);

  useEffect(() => {
    if (store.agents.length === 0) {
      void store.loadAgents();
    }
  }, [store]);

  const itemNameById = useMemo(() => {
    const m = new Map<string, string>();
    (store.settings?.models.items ?? []).forEach((it: any) => {
      m.set(it.id, String(it.name || it.model || it.id));
    });
    return m;
  }, [store.settings?.models.items]);

  const openEditor = (id?: string) => {
    setEditingId(id || null);
    setShowEditor(true);
  };

  const confirmDelete = async () => {
    if (confirmDeleteId) {
      await store.deleteAgent(confirmDeleteId);
      setConfirmDeleteId(null);
    }
  };

  return (
    <>
      <div className="settings-section-header">
        <div className="settings-section-title">
          <Users size={16} strokeWidth={2} />
          <span style={{ marginLeft: 8 }}>{t.settings.agents}</span>
        </div>
        <div className="settings-actions">
          <button className="btn-secondary" onClick={() => openEditor()}>
            <Plus size={14} strokeWidth={2} />
            <span style={{ marginLeft: 4 }}>Add Agent</span>
          </button>
        </div>
      </div>

      <div className="tools-list">
        {store.agents.map((agent) => {
          const ids = agent.modelProfileIds ?? [];
          const validIds = ids.filter((id) => itemNameById.has(id));
          const staleCount = ids.length - validIds.length;
          const profileLabel = validIds.length === 0
            ? "Inherits caller"
            : validIds.map((id) => itemNameById.get(id) || "").join(", ");
          return (
            <div key={agent.id} className="tool-item">
              <div className="tool-info">
                <div className="tool-name">{agent.name}</div>
                <div className="tool-meta">
                  {agent.description || agent.systemPrompt.slice(0, 80)}
                </div>
                <div className="tool-meta" style={{ opacity: 0.6, fontSize: 11 }}>
                  {validIds.length === 0 ? "Model: " : `Models (${validIds.length}): `}
                  {profileLabel} · {agent.allowedTools.length} tools
                  {staleCount > 0 && (
                    <span style={{ color: "var(--warn, #d97706)", marginLeft: 6 }}>
                      ({staleCount} stale — open to re-pick)
                    </span>
                  )}
                </div>
              </div>
              <div className="tool-actions">
                <button className="icon-btn-sm" onClick={() => setToolsAgentId(agent.id)} title="Tools — pick this agent's gateway tools">
                  <Wrench size={14} />
                </button>
                <button className="icon-btn-sm" onClick={() => openEditor(agent.id)} title="Edit">
                  <Pencil size={14} />
                </button>
                <button className="icon-btn-sm" onClick={() => setConfirmDeleteId(agent.id)} title="Delete">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
        {store.agents.length === 0 ? (
          <div className="tool-empty">
            No agents defined yet. Agents pair a system prompt, model, and tool allowlist
            to give your local models specialized roles (researcher, coder, planner, etc.).
          </div>
        ) : null}
      </div>

      {showEditor && (
        <AgentEditor store={store} agentId={editingId || undefined} onClose={() => setShowEditor(false)} />
      )}

      {toolsAgentId && (
        <AgentToolsPicker
          agentId={toolsAgentId}
          agentName={store.agents.find((a) => a.id === toolsAgentId)?.name ?? toolsAgentId}
          onClose={() => setToolsAgentId(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete agent"
        message={`Delete "${store.agents.find((a) => a.id === confirmDeleteId)?.name ?? ""}"?`}
        confirmText="Delete"
        cancelText="Cancel"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </>
  );
});
