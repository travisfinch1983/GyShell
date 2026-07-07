import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Cpu,
  Palette,
  Settings,
  Plus,
  Trash2,
  X,
  Key,
  Globe,
  Box,
  Tag,
  Shield,
  Loader2,
  Wrench,
  RefreshCw,
  BookOpenText,
  Users,
  Info,
  AlertTriangle,
  Database,
  Volume2,
  Server,
  KeyRound,
  SlidersHorizontal,
  Activity,
} from "lucide-react";
import { observer } from "mobx-react-lite";
import type { AppStore } from "../../stores/AppStore";
import { BUILTIN_THEMES } from "../../theme/themes";
import { ProxmoxSettingsPanel, ClusterTokensPanel, ClusterUiPanel, ExternalServicesPanel, ServiceNamesPanel, GpuPoolsPanel, SharedFoldersPanel } from "./ClusterSettingsPanels";
import type { AppTheme } from "../../theme/themes";
import "./settings.scss";
import { ConfirmDialog } from "../Common/ConfirmDialog";
import { NumericInput } from "../Common/NumericInput";
import { InfoTooltip } from "../Common/InfoTooltip";
import { ProxlabServicesPanel } from "./ProxlabServicesPanel";
import { ProxySettingsPanel } from "./ProxySettingsPanel";
import { AgentsPanel } from "./AgentsPanel";
import { AgentsSettings } from "../Agents/AgentsSettings";
import { TtsSettingsPanel } from "./TtsSettingsPanel";
import "./TtsSettingsPanel.scss";
import { FtpSettingsPanel } from "./FtpSettingsPanel";
import { uiPrefsStore } from "../../stores/uiPrefsStore";
import { GPU_FLEET_POLL_PREF, GPU_FLEET_POLL_DEFAULT, fleetPollMs } from "../GpuFleet/GpuFleetPanel";
import { SERVICE_USAGE_POLL_PREF, SERVICE_USAGE_POLL_DEFAULT, serviceUsagePollMs } from "../../stores/AiServicesStore";
import { ToolsPanel } from "./ToolsPanel";
import { HermesSkillsPanel } from "./HermesSkillsPanel";
import { Select } from "../../platform/Select";
import { ShortcutRecorder } from "./ShortcutRecorder";
import { getDefaultCommandDraftShortcut } from "../../lib/commandDraftShortcut";

function ThemeTile(props: {
  active?: boolean;
  theme: AppTheme;
  onClick: () => void;
}) {
  const { background, foreground, colors } = props.theme.terminal;
  const previewColors = [foreground, colors[1], colors[2]];
  const displayName =
    props.theme.name.length > 13
      ? `${props.theme.name.slice(0, 13)}...`
      : props.theme.name;
  return (
    <button
      className={props.active ? "theme-tile is-active" : "theme-tile"}
      onClick={props.onClick}
      title={props.theme.name}
    >
      <div className="theme-preview" style={{ background }}>
        <div className="theme-preview-swatches">
          {previewColors.map((color, idx) => (
            <span
              key={`${props.theme.id}-swatch-${idx}`}
              style={{ background: color }}
            />
          ))}
        </div>
      </div>
      <div className="theme-tile-content">
        <span className="theme-tile-title">{displayName}</span>
      </div>
    </button>
  );
}

const RULES_PREVIEW_LIMIT = 28;
const TAG_WIDTH_CHAR_PX = 7;
const TAG_WIDTH_PADDING_PX = 10;
const TAG_WIDTH_BORDER_PX = 2;

function computeTagColumnWidth(labels: readonly string[]): string {
  const longestLabelLength = labels.reduce(
    (max, label) => Math.max(max, label.length),
    0,
  );
  const widthPx =
    longestLabelLength * TAG_WIDTH_CHAR_PX +
    TAG_WIDTH_PADDING_PX +
    TAG_WIDTH_BORDER_PX;
  return `${Math.ceil(widthPx)}px`;
}

function RuleChipList(props: {
  t: any;
  rules: string[];
  onDelete: (rule: string) => void;
}) {
  const { t, rules, onDelete } = props;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rules : rules.slice(0, RULES_PREVIEW_LIMIT);
  const remaining = Math.max(0, rules.length - visible.length);

  return (
    <div className="cp-rule-block">
      <div className="cp-chips" role="list">
        {visible.map((rule) => (
          <div
            key={rule}
            className="cp-chip"
            role="listitem"
            data-full={rule}
            aria-label={rule}
          >
            <span className="cp-chip-text">{rule}</span>
            <button
              className="cp-chip-delete"
              title={t.common.delete}
              onClick={() => onDelete(rule)}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {rules.length === 0 ? (
          <div className="tool-empty">{t.settings.noCommandPolicyRules}</div>
        ) : null}
      </div>
      {rules.length > RULES_PREVIEW_LIMIT ? (
        <button className="cp-expand" onClick={() => setExpanded(!expanded)}>
          {expanded
            ? t.common.showLess
            : `${t.common.showMore} (+${remaining})`}
        </button>
      ) : null}
    </div>
  );
}
function AccessTokenRevealDialog(props: {
  open: boolean;
  title: string;
  token: string;
  hint: string;
  copyText: string;
  closeText: string;
  copyError: string;
  onCopy: () => void;
  onClose: () => void;
}): React.ReactElement | null {
  if (!props.open) return null;

  return createPortal(
    <div
      className="gy-confirm-overlay"
      role="dialog"
      aria-modal="true"
      onClick={props.onClose}
    >
      <div
        className="gy-confirm-card access-token-reveal-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="gy-confirm-header">
          <div className="gy-confirm-title">{props.title}</div>
          <button
            className="icon-btn-sm"
            onClick={props.onClose}
            title={props.closeText}
          >
            <X size={18} />
          </button>
        </div>

        <div className="gy-confirm-body access-token-reveal-body">
          <pre className="access-token-created-value">{props.token}</pre>
          <div className="gy-confirm-message access-token-reveal-hint">
            {props.hint}
          </div>
          {props.copyError ? (
            <div className="settings-error access-token-reveal-error">
              {props.copyError}
            </div>
          ) : null}
        </div>

        <div className="gy-confirm-footer">
          <button className="gy-btn gy-btn-secondary" onClick={props.onClose}>
            {props.closeText}
          </button>
          <button className="gy-btn gy-btn-primary" onClick={props.onCopy}>
            {props.copyText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const SettingsView: React.FC<{ store: AppStore }> = observer(
  ({ store }) => {
    const t = store.i18n.t;

    // Live reachability: refresh whenever the Models section is shown (coding std #5).
    React.useEffect(() => {
      if (store.settingsSection === "models") void store.refreshModelHealth();
    }, [store.settingsSection, store.settings?.models.items.length]);
    React.useEffect(() => { void uiPrefsStore.ensureLoaded() }, []);
  const modelMetaColumnVars = useMemo(
    () =>
      ({
          "--model-meta-col-status": computeTagColumnWidth([
            "Active",
            "Stateless",
            "NoActive",
          ]),
          "--model-meta-col-image": computeTagColumnWidth(["Image"]),
          "--model-meta-col-structured": computeTagColumnWidth(["Structured"]),
      }) as React.CSSProperties,
      [],
    );

    const [cpDraft, setCpDraft] = useState<{
      allowlist: string;
      denylist: string;
      asklist: string;
    }>({
      allowlist: "",
      denylist: "",
      asklist: "",
    });
    const [accessTokenName, setAccessTokenName] = useState("");
    const [accessTokenError, setAccessTokenError] = useState("");
    const [accessTokenBusy, setAccessTokenBusy] = useState(false);
    const [createdAccessToken, setCreatedAccessToken] = useState<string | null>(
      null,
    );
    const [accessTokenModalError, setAccessTokenModalError] = useState("");
    const [deleteAccessTokenConfirm, setDeleteAccessTokenConfirm] =
      useState<null | { id: string; name: string }>(null);
    const [showMobileWebGatewayWarning, setShowMobileWebGatewayWarning] =
      useState(false);

    const cpLists = useMemo(
      () => store.commandPolicyLists,
      [store.commandPolicyLists],
    );
    const isMobileWebRunning = store.mobileWebStatus.running;
    const persistedWsGatewayAccess =
      store.settings?.gateway?.ws?.access ?? "localhost";
    const persistedWsGatewayCidrs = (
      store.settings?.gateway?.ws?.allowedCidrs || []
    ).join("\n");
    const [wsGatewayAccessDraft, setWsGatewayAccessDraft] = useState(
      persistedWsGatewayAccess,
    );
    const [wsGatewayCidrsDraft, setWsGatewayCidrsDraft] = useState(
      persistedWsGatewayCidrs,
    );
    const versionInfo = store.versionInfo;
  const formattedCheckedAt =
    versionInfo?.checkedAt && versionInfo.checkedAt > 0
      ? new Date(versionInfo.checkedAt).toLocaleString()
        : "-";

    const [deleteConfirm, setDeleteConfirm] = useState<null | {
      kind: "model" | "profile";
      id: string;
    }>(null);
    const [memoryDraft, setMemoryDraft] = useState("");
    const [memoryBusy, setMemoryBusy] = useState(false);

    React.useEffect(() => {
      if (store.settingsSection !== "memory") return;
      void store.loadMemory();
    }, [store, store.settingsSection]);

  React.useEffect(() => {
      setWsGatewayAccessDraft(persistedWsGatewayAccess);
    }, [persistedWsGatewayAccess]);

  React.useEffect(() => {
      setWsGatewayCidrsDraft(persistedWsGatewayCidrs);
    }, [persistedWsGatewayCidrs]);

    React.useEffect(() => {
      setMemoryDraft(store.memoryContent);
    }, [store.memoryContent]);

  const createAccessToken = async () => {
      const normalizedName = accessTokenName.trim();
    if (!normalizedName) {
        setAccessTokenError(t.settings.accessTokenNameRequired);
        return;
    }

      setAccessTokenBusy(true);
      setAccessTokenError("");
      setAccessTokenModalError("");
    try {
        const created = await store.createAccessToken(normalizedName);
        setCreatedAccessToken(created.token);
        setAccessTokenName("");
    } catch (error) {
        setAccessTokenError(
          error instanceof Error ? error.message : String(error),
        );
    } finally {
        setAccessTokenBusy(false);
  }
    };

  const copyCreatedAccessToken = async () => {
      if (!createdAccessToken) return;
    try {
        await navigator.clipboard.writeText(createdAccessToken);
        setAccessTokenModalError("");
    } catch {
        setAccessTokenModalError(t.settings.accessTokenCopyFailed);
  }
    };

  const closeCreatedAccessTokenDialog = () => {
      setCreatedAccessToken(null);
      setAccessTokenModalError("");
    };

  const saveMemory = async () => {
      setMemoryBusy(true);
    try {
        const snapshot = await store.saveMemoryContent(memoryDraft);
      if (snapshot) {
          setMemoryDraft(snapshot.content);
      }
    } finally {
        setMemoryBusy(false);
  }
    };

  const reloadMemory = async () => {
      setMemoryBusy(true);
    try {
        const snapshot = await store.loadMemory();
      if (snapshot) {
          setMemoryDraft(snapshot.content);
      }
    } finally {
        setMemoryBusy(false);
  }
    };

  return (
    <div className="settings">
      <AccessTokenRevealDialog
        open={!!createdAccessToken}
        title={t.settings.accessTokenCreatedTitle}
          token={createdAccessToken || ""}
        hint={t.settings.accessTokenCreatedHint}
        copyText={t.settings.copyAccessToken}
        closeText={t.common.close}
        copyError={accessTokenModalError}
        onCopy={() => {
            void copyCreatedAccessToken();
        }}
        onClose={closeCreatedAccessTokenDialog}
      />
      <ConfirmDialog
        open={!!deleteConfirm}
        title={t.common.confirmDeleteTitle}
          message={
            deleteConfirm?.kind === "profile"
              ? t.common.confirmDeleteProfile
              : t.common.confirmDeleteModel
          }
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={() => {
            if (!deleteConfirm) return;
            if (deleteConfirm.kind === "model")
              void store.deleteModel(deleteConfirm.id);
            else void store.deleteProfile(deleteConfirm.id);
            setDeleteConfirm(null);
        }}
      />
      <ConfirmDialog
        open={!!deleteAccessTokenConfirm}
        title={t.common.confirmDeleteTitle}
          message={t.settings.confirmDeleteAccessToken(
            deleteAccessTokenConfirm?.name || "",
          )}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        onCancel={() => setDeleteAccessTokenConfirm(null)}
        onConfirm={() => {
            if (!deleteAccessTokenConfirm) return;
            void store.deleteAccessToken(deleteAccessTokenConfirm.id);
            setDeleteAccessTokenConfirm(null);
        }}
      />
        <ConfirmDialog
          open={showMobileWebGatewayWarning}
          title={t.settings.mobileWebGatewayWarningTitle}
          message={t.settings.mobileWebGatewayWarning}
          confirmText={t.common.ok}
          cancelText={t.common.cancel}
          onConfirm={() => setShowMobileWebGatewayWarning(false)}
          onCancel={() => setShowMobileWebGatewayWarning(false)}
        />

      <div className="settings-sidebar">
          <button
            className="settings-back-btn"
            onClick={() => store.closeOverlay()}
            title={t.common.back}
          >
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
        
        <div className="settings-nav">
          <div
              className={
                store.settingsSection === "general"
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => store.setSettingsSection("general")}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Settings size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.general}</span>
          </div>
          <div
              className={
                store.settingsSection === "chat"
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => store.setSettingsSection("chat")}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Settings size={16} strokeWidth={2} />
            </span>
            <span>Chat</span>
          </div>
          <div
              className={
                store.settingsSection === "theme"
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => store.setSettingsSection("theme")}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Palette size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.theme}</span>
          </div>
          <div
              className={
                store.settingsSection === "models"
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => store.setSettingsSection("models")}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Cpu size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.models}</span>
          </div>
          <div
              className={
                store.settingsSection === "tts"
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => store.setSettingsSection("tts")}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Volume2 size={16} strokeWidth={2} />
            </span>
            <span>TTS & STT</span>
          </div>
          <div
              className={
                store.settingsSection === "security"
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => store.setSettingsSection("security")}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Shield size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.security}</span>
          </div>
          <div
              className={
                store.settingsSection === "tools"
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => store.setSettingsSection("tools")}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Wrench size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.tools}</span>
          </div>
          <div
              className={
                store.settingsSection === "skills"
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => store.setSettingsSection("skills")}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <BookOpenText size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.skills}</span>
          </div>
          <div
              className={
                store.settingsSection === "agents"
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => store.setSettingsSection("agents")}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Users size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.agents}</span>
          </div>
          <div
              className={
                store.settingsSection === "memory"
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => store.setSettingsSection("memory")}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Database size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.memory}</span>
          </div>
          <div
              className={
                store.settingsSection === "accessTokens"
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => store.setSettingsSection("accessTokens")}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Key size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.accessTokens}</span>
          </div>
          <div
              className={
                store.settingsSection === "version"
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => store.setSettingsSection("version")}
            role="button"
            tabIndex={0}
          >
            <span className="icon">
              <Info size={16} strokeWidth={2} />
            </span>
            <span>{t.settings.version}</span>
          </div>

          <div className="settings-nav-sep" />
          <div
            className={store.settingsSection === "cluster-proxmox" ? "settings-nav-item is-active" : "settings-nav-item"}
            onClick={() => store.setSettingsSection("cluster-proxmox")}
            role="button"
            tabIndex={0}
          >
            <span className="icon"><Server size={16} strokeWidth={2} /></span>
            <span>Proxmox</span>
          </div>
          <div
            className={store.settingsSection === "cluster-tokens" ? "settings-nav-item is-active" : "settings-nav-item"}
            onClick={() => store.setSettingsSection("cluster-tokens")}
            role="button"
            tabIndex={0}
          >
            <span className="icon"><KeyRound size={16} strokeWidth={2} /></span>
            <span>Download Tokens</span>
          </div>
          <div
            className={store.settingsSection === "cluster-ui" ? "settings-nav-item is-active" : "settings-nav-item"}
            onClick={() => store.setSettingsSection("cluster-ui")}
            role="button"
            tabIndex={0}
          >
            <span className="icon"><SlidersHorizontal size={16} strokeWidth={2} /></span>
            <span>Cluster UI</span>
          </div>
          <div
            className={store.settingsSection === "cluster-services" ? "settings-nav-item is-active" : "settings-nav-item"}
            onClick={() => store.setSettingsSection("cluster-services")}
            role="button"
            tabIndex={0}
          >
            <span className="icon"><Globe size={16} strokeWidth={2} /></span>
            <span>External Services</span>
          </div>
          <div
            className={store.settingsSection === "cluster-servicenames" ? "settings-nav-item is-active" : "settings-nav-item"}
            onClick={() => store.setSettingsSection("cluster-servicenames")}
            role="button"
            tabIndex={0}
          >
            <span className="icon"><Tag size={16} strokeWidth={2} /></span>
            <span>Service Names</span>
          </div>
          <div
            className={store.settingsSection === "cluster-gpu" ? "settings-nav-item is-active" : "settings-nav-item"}
            onClick={() => store.setSettingsSection("cluster-gpu")}
            role="button"
            tabIndex={0}
          >
            <span className="icon"><Cpu size={16} strokeWidth={2} /></span>
            <span>GPU &amp; Pools</span>
          </div>
          <div
            className={store.settingsSection === "cluster-storage" ? "settings-nav-item is-active" : "settings-nav-item"}
            onClick={() => store.setSettingsSection("cluster-storage")}
            role="button"
            tabIndex={0}
          >
            <span className="icon"><Box size={16} strokeWidth={2} /></span>
            <span>Shared Folders</span>
          </div>
          <div
            className={store.settingsSection === "cluster-proxy" ? "settings-nav-item is-active" : "settings-nav-item"}
            onClick={() => store.setSettingsSection("cluster-proxy")}
            role="button"
            tabIndex={0}
          >
            <span className="icon"><Activity size={16} strokeWidth={2} /></span>
            <span>Proxy</span>
          </div>
        </div>
      </div>
      <div className="settings-content">
        <div className="settings-section">
            {store.settingsSection === "chat" ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">Chat</div>
                <div className="settings-section-subtitle">
                  How the agent manages long conversations.
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row-label-with-info">
                  <label>Automatic context compaction</label>
                </div>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={store.settings?.chat?.autoCompaction?.enabled !== false}
                    onChange={(e) => void store.setAutoCompactionEnabled(e.target.checked)}
                  />
                  <span>
                    When the conversation approaches the model's context limit, a
                    second model summarizes older messages and the chat collapses
                    them into a summary block — so what you see matches what the
                    model sees. Turn off to let history grow until the hard limit.
                  </span>
                </label>
              </div>
            </>
          ) : null}
            {store.settingsSection === "general" ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">
                  {t.settings.general}
                </div>
              </div>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.language}</label>
                    <InfoTooltip content={t.settings.tooltips.language} />
                  </div>
                  <Select
                    className="settings-native-select"
                    value={store.i18n.locale}
                    onChange={(v) => store.setLanguage(v as any)}
                    options={[
                        { value: "en", label: "English" },
                        { value: "zh-CN", label: "简体中文" },
                    ]}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.tabDisplayMode}</label>
                    <InfoTooltip content={t.settings.tooltips.tabDisplayMode} />
                  </div>
                  <Select
                    className="settings-native-select"
                    value={store.panelTabDisplayMode}
                    onChange={(value) =>
                      store.setPanelTabDisplayMode(
                        value as AppStore["panelTabDisplayMode"],
                      )
                    }
                    options={[
                      {
                        value: "auto",
                        label: t.settings.tabDisplayModes.auto,
                      },
                      {
                        value: "expanded",
                        label: t.settings.tabDisplayModes.expanded,
                      },
                      {
                        value: "select",
                        label: t.settings.tabDisplayModes.select,
                      },
                    ]}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.recursionLimit}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.recursionLimit}
                      />
                  </div>
                  <div className="settings-slider-container">
                    <input
                      type="range"
                      className="settings-slider"
                      min="100"
                      max="1010"
                      step="10"
                        value={
                          store.settings?.recursionLimit === 2147483647
                            ? 1010
                            : store.settings?.recursionLimit || 200
                        }
                      onChange={(e) => {
                          const val = parseInt(e.target.value);
                          store.setRecursionLimit(
                            val === 1010 ? 2147483647 : val,
                          );
                      }}
                    />
                    <span className="settings-slider-value">
                        {store.settings?.recursionLimit === 2147483647
                          ? "INF"
                          : store.settings?.recursionLimit || 200}
                    </span>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.debugMode}</label>
                    <InfoTooltip content={t.settings.tooltips.debugMode} />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.settings?.debugMode ?? false}
                      onChange={(e) => store.setDebugMode(e.target.checked)}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.chatDisplayMode}</label>
                    <InfoTooltip content={t.settings.tooltips.chatDisplayMode} />
                  </div>
                  <Select
                    className="settings-native-select"
                    value={store.chatDisplayMode}
                    onChange={(value) =>
                      store.setChatDisplayMode(value as 'classic' | 'seamless')
                    }
                    options={[
                      {
                        value: 'classic',
                        label: t.settings.chatDisplayModes.classic,
                      },
                      {
                        value: 'seamless',
                        label: t.settings.chatDisplayModes.seamless,
                      },
                    ]}
                  />
                </div>
              </div>

                <div
                  className="settings-section-header"
                  style={{ marginTop: 24 }}
                >
                <div className="settings-section-title">
                  {t.settings.experimentalFeatures}
                </div>
              </div>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.runtimeThinkingCorrection}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.runtimeThinkingCorrection}
                      />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                        checked={
                          store.settings?.experimental
                            ?.runtimeThinkingCorrectionEnabled !== false
                        }
                        onChange={(e) =>
                          store.setRuntimeThinkingCorrectionEnabled(
                            e.target.checked,
                          )
                        }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.taskFinishGuard}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.taskFinishGuard}
                      />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                        checked={
                          store.settings?.experimental
                            ?.taskFinishGuardEnabled !== false
                        }
                        onChange={(e) =>
                          store.setTaskFinishGuardEnabled(e.target.checked)
                        }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.firstTurnThinkingModel}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.firstTurnThinkingModel}
                      />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                        checked={
                          store.settings?.experimental
                            ?.firstTurnThinkingModelEnabled === true
                        }
                        onChange={(e) =>
                          store.setFirstTurnThinkingModelEnabled(
                            e.target.checked,
                          )
                        }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.execCommandActionModel}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.execCommandActionModel}
                      />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                        checked={
                          store.settings?.experimental
                            ?.execCommandActionModelEnabled !== false
                        }
                        onChange={(e) =>
                          store.setExecCommandActionModelEnabled(
                            e.target.checked,
                          )
                        }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.writeStdinActionModel}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.writeStdinActionModel}
                      />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                        checked={
                          store.settings?.experimental
                            ?.writeStdinActionModelEnabled !== false
                        }
                        onChange={(e) =>
                          store.setWriteStdinActionModelEnabled(
                            e.target.checked,
                          )
                        }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
              </div>

                <div
                  className="settings-section-header"
                  style={{ marginTop: 24 }}
                >
                <div className="settings-section-title">
                  {t.settings.terminal}
                </div>
              </div>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.fontSize}</label>
                    <InfoTooltip content={t.settings.tooltips.fontSize} />
                  </div>
                  <NumericInput
                    className="settings-inline-input"
                    style={{ width: 80 }}
                    value={store.settings?.terminal?.fontSize || 14}
                      onChange={(val) =>
                        store.setTerminalSettings({ fontSize: val })
                      }
                    min={6}
                    max={100}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.lineHeight}</label>
                    <InfoTooltip content={t.settings.tooltips.lineHeight} />
                  </div>
                  <NumericInput
                    className="settings-inline-input"
                    style={{ width: 80 }}
                    value={store.settings?.terminal?.lineHeight || 1.2}
                      onChange={(val) =>
                        store.setTerminalSettings({ lineHeight: val })
                      }
                    allowFloat
                    min={1}
                    max={5}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.scrollback}</label>
                    <InfoTooltip content={t.settings.tooltips.scrollback} />
                  </div>
                  <NumericInput
                    className="settings-inline-input"
                    style={{ width: 80 }}
                    value={store.settings?.terminal?.scrollback || 5000}
                      onChange={(val) =>
                        store.setTerminalSettings({ scrollback: val })
                      }
                    min={0}
                    max={1000000}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.cursorStyle}</label>
                    <InfoTooltip content={t.settings.tooltips.cursorStyle} />
                  </div>
                  <Select
                    className="settings-native-select"
                      value={store.settings?.terminal?.cursorStyle || "block"}
                      onChange={(v) =>
                        store.setTerminalSettings({ cursorStyle: v as any })
                      }
                    options={[
                        {
                          value: "block",
                          label: t.settings.cursorStyles.block,
                        },
                        {
                          value: "underline",
                          label: t.settings.cursorStyles.underline,
                        },
                        { value: "bar", label: t.settings.cursorStyles.bar },
                    ]}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.cursorBlink}</label>
                    <InfoTooltip content={t.settings.tooltips.cursorBlink} />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.settings?.terminal?.cursorBlink ?? true}
                        onChange={(e) =>
                          store.setTerminalSettings({
                            cursorBlink: e.target.checked,
                          })
                        }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.copyOnSelect}</label>
                    <InfoTooltip content={t.settings.tooltips.copyOnSelect} />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                        checked={
                          store.settings?.terminal?.copyOnSelect ?? false
                        }
                        onChange={(e) =>
                          store.setTerminalSettings({
                            copyOnSelect: e.target.checked,
                          })
                        }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.rightClickToPaste}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.rightClickToPaste}
                      />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                        checked={
                          store.settings?.terminal?.rightClickToPaste ?? false
                        }
                        onChange={(e) =>
                          store.setTerminalSettings({
                            rightClickToPaste: e.target.checked,
                          })
                        }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.commandDraftShortcut}</label>
                    <InfoTooltip content={t.settings.tooltips.commandDraftShortcut} />
                  </div>
                  <ShortcutRecorder
                    value={
                      store.settings?.terminal?.commandDraftShortcut ??
                      getDefaultCommandDraftShortcut()
                    }
                    disabledLabel={t.settings.shortcutDisabled}
                    listeningLabel={t.settings.shortcutListening}
                    onChange={(value) =>
                      store.setTerminalSettings({
                        commandDraftShortcut: value,
                      })
                    }
                  />
                </div>
              </div>

              <div className="settings-section-header" style={{ marginTop: 24 }}>
                <div className="settings-section-title">Monitoring poll rates</div>
              </div>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label title="How often the GPU Fleet panel samples metrics for its sparklines. Prometheus-sourced — zero host cost at any rate, so 1s is fine for rapid monitoring.">
                      GPU Fleet sparkline poll rate
                    </label>
                  </div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      step={1}
                      value={Math.round(fleetPollMs() / 1000)}
                      onChange={(e) => {
                        const s = Math.min(60, Math.max(1, parseInt(e.target.value, 10) || GPU_FLEET_POLL_DEFAULT / 1000));
                        uiPrefsStore.set(GPU_FLEET_POLL_PREF, s * 1000);
                      }}
                      style={{ width: 70, height: 28, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--control-bg)", color: "var(--fg)", fontSize: 13 }}
                    />
                    <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                      seconds · applies live to the GPU Fleet panel
                    </span>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label title="How often the AI Service cards poll per-service GPU usage. Data comes from the service-gpu exporter via Prometheus (10s scrape), so polling faster than 10s re-reads the same sample — like the fleet panel's 15s reality.">
                      AI Service card sparkline poll rate
                    </label>
                  </div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      step={1}
                      value={Math.round(serviceUsagePollMs() / 1000)}
                      onChange={(e) => {
                        const s = Math.min(60, Math.max(1, parseInt(e.target.value, 10) || SERVICE_USAGE_POLL_DEFAULT / 1000));
                        uiPrefsStore.set(SERVICE_USAGE_POLL_PREF, s * 1000);
                      }}
                      style={{ width: 70, height: 28, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--control-bg)", color: "var(--fg)", fontSize: 13 }}
                    />
                    <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                      seconds · takes effect on the next poll
                    </span>
                  </div>
                </div>
              </div>

              <FtpSettingsPanel />
            </>
          ) : null}

            {store.settingsSection === "theme" ? (
            <>
              <div className="settings-section-header">
                  <div className="settings-section-title">
                    {t.settings.theme}
                  </div>
                <div className="settings-actions">
                  <InfoTooltip content={t.settings.tooltips.themeCustom}>
                      <button
                        className="btn-secondary"
                        onClick={() => store.openCustomThemeFile()}
                      >
                      {t.settings.openCustomThemes}
                    </button>
                  </InfoTooltip>
                  <InfoTooltip content={t.settings.tooltips.themeReload}>
                    <button
                      className="btn-icon-reload"
                      onClick={() => store.reloadCustomThemes()}
                      title={t.settings.reloadCustomThemes}
                    >
                      <RefreshCw size={14} />
                    </button>
                  </InfoTooltip>
                </div>
              </div>
              <div className="theme-grid">
                <div className="theme-divider">
                  <span>{t.settings.themeSectionCustom}</span>
                  <i />
                </div>
                {store.customThemes.map((theme) => (
                  <ThemeTile
                    key={`custom-${theme.name}`}
                      theme={{
                        id: theme.name,
                        name: theme.name,
                        terminal: theme,
                      }}
                    active={store.settings?.themeId === theme.name}
                    onClick={() => store.setThemeId(theme.name)}
                  />
                ))}
                <div className="theme-divider">
                  <span>{t.settings.themeSectionBuiltIn}</span>
                  <i />
                </div>
                {BUILTIN_THEMES.map((theme) => (
                  <ThemeTile
                    key={`builtin-${theme.id}`}
                    theme={theme}
                    active={store.settings?.themeId === theme.id}
                    onClick={() => store.setThemeId(theme.id)}
                  />
                ))}
              </div>
            </>
          ) : null}

            {store.settingsSection === "models" ? (
            <>
              <ProxlabServicesPanel />

              <DefaultPromptsEditor store={store} />

              <div className="settings-section-header">
                  <div className="settings-section-title">
                    External Model Connections
                    <InfoTooltip content="DEPRECATED — display-only. Register model API sources under Settings › Cluster › External Services (keys stay server-side there). Existing entries keep working as models; to change a key, re-add the endpoint in the registry." />
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                  <button
                    className="icon-btn-sm"
                    title="Refresh reachability"
                    onClick={() => void store.refreshModelHealth()}
                    disabled={store.modelHealthChecking}
                  >
                      <RefreshCw size={16} strokeWidth={2} className={store.modelHealthChecking ? "spin" : ""} />
                  </button>
                  </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--fg-muted)", margin: "2px 0 10px" }}>
                Deprecated &amp; display-only: this path stored API keys in local settings, so editing
                is retired. New model endpoints belong in <b>Settings › Cluster › External Services →
                Model API sources</b> (server-side registry, masked keys, models join the tagged catalog
                automatically). Existing entries below keep working as models; delete stays for cleanup.
              </div>

              <div className="models-list" style={modelMetaColumnVars}>
                {/* Display-only (deprecated path): no click-to-edit — the editor wrote unmasked
                    keys into local settings. Entries keep working as models; key changes go
                    through the External Sources registry. Delete stays for cleanup. */}
                {store.settings?.models.items.filter((item: any) => !item._proxlabAutoDiscovered).map((item) => (
                    <div
                      key={item.id}
                      className="model-item"
                      style={{ cursor: "default" }}
                    >
                    {/** Reachability tag is LIVE (coding std #5): from store.modelHealth, a /v1/models check. */}
                    {(() => {
                        const health = store.modelHealth[item.model];
                        const supportsImage = Boolean(
                          item.profile?.imageInputs,
                        );
                      const supportsStructured =
                        item.profile?.supportsStructuredOutput === true ||
                          item.supportsStructuredOutput === true;

                      return (
                        <>
                            <div className="model-icon">
                              <Box size={16} />
                            </div>
                          <div className="model-info">
                              <div className="model-name">{item.name}</div>
                              <div className="model-id">{item.model}</div>
                          </div>
                          <div className="model-meta">
                              {health === "active" ? (
                                  <span className="tag active" title="Endpoint reachable and model listed">Active</span>
                              ) : health === "missing" ? (
                                  <span className="tag warning" title="Endpoint reachable but this model is not listed">Missing</span>
                              ) : health === "offline" ? (
                                  <span className="tag inactive" title="Endpoint unreachable">Offline</span>
                              ) : (
                                  <span className="tag ghost" title="Checking reachability…">Checking</span>
                              )}
                              {supportsImage ? (
                                  <span className="tag image">Image</span>
                              ) : (
                                <span className="tag ghost" aria-hidden="true">
                                  Image
                                </span>
                              )}
                              {supportsStructured ? (
                                <span className="tag structured">
                                  Structured
                                </span>
                              ) : (
                                <span className="tag ghost" aria-hidden="true">
                                  Structured
                                </span>
                              )}
                          </div>
                        </>
                        );
                    })()}
                    <button 
                        className="model-delete-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteConfirm({ kind: "model", id: item.id });
                        }}
                    >
                        <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>

                <div
                  className="settings-section-title"
                  style={{ marginTop: 32 }}
                >
                {t.settings.profiles}
                <InfoTooltip content={t.settings.tooltips.modelProfile} />
              </div>
              
              <div className="profiles-grid">
                {store.settings?.models.profiles.map((p) => {
                    const isActive =
                      store.settings?.models.activeProfileId === p.id;
                  return (
                      <div
                        key={p.id}
                        className={`profile-card ${isActive ? "active" : ""}`}
                      >
                      <div className="profile-header">
                        <div 
                            className={`radio-check ${isActive ? "checked" : ""}`}
                            onClick={() => store.setActiveProfile(p.id)}
                        />
                        <input
                          className="profile-name-input"
                          value={p.name}
                            onChange={(e) =>
                              store.saveProfile({ ...p, name: e.target.value })
                            }
                          placeholder={t.settings.profileName}
                        />
                        <button
                          className="icon-btn-sm danger"
                            onClick={() =>
                              setDeleteConfirm({ kind: "profile", id: p.id })
                            }
                            disabled={
                              store.settings?.models.profiles.length === 1
                            }
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      <div className="profile-body">
                                                <div className="profile-field">
                          <label>Chat Model</label>
                          <div className="profile-select-with-voice">
                          <div className="profile-select-wrap">
                          <Select
                              value={(p as any).chatModelId || ""}
                              onChange={(id) =>
                                store.saveProfile({
                                  ...p,
                                  chatModelId: id || undefined,
                                } as any)
                              }
                            options={[
                                { value: "", label: "(None — use Orchestrator)" },
                                ...(store.settings?.models.items.map((m: any) => ({
                                  value: m.id,
                                  label: m._proxlabDisconnected ? `⚠ ${m.name}` : m.name,
                                })) || []),
                            ]}
                          />
                          </div>
                          <ProfileVoiceButton profile={p} roleKey="chat" store={store} />
                          </div>
                        </div>
                        <div className="profile-field">
                          <label>Coder Model</label>
                                                    <div className="profile-select-with-voice">
                          <div className="profile-select-wrap">
<Select
                              value={(p as any).coderModelId || ""}
                              onChange={(id) =>
                                store.saveProfile({
                                  ...p,
                                  coderModelId: id || undefined,
                                } as any)
                              }
                            options={[
                                { value: "", label: "(None)" },
                                ...(store.settings?.models.items.map((m: any) => ({
                                  value: m.id,
                                  label: m._proxlabDisconnected ? `⚠ ${m.name}` : m.name,
                                })) || []),
                            ]}
                          />
                          </div>
                          <ProfileVoiceButton profile={p} roleKey="coder" store={store} />
                          </div>
                        </div>
                        <div className="profile-field">
                          <label>Default Model (fallback)</label>
                          <Select
                            value={p.globalModelId}
                              onChange={(id) =>
                                store.saveProfile({ ...p, globalModelId: id })
                              }
                              options={
                                store.settings?.models.items.map((m: any) => ({
                                  value: m.id,
                                  label: m._proxlabDisconnected ? `⚠ ${m.name}` : m.name,
                                })) || []
                              }
                          />
                        </div>
<RolePromptsEditor profile={p} store={store} />
                      </div>
                    </div>
                    );
                })}
                <button
                    className="add-profile-btn"
                    onClick={() => {
                      const id = `profile-${Date.now()}`;
                      const firstModel =
                        store.settings?.models.items[0]?.id || "";
                      store.saveProfile({
                        id,
                        name: "New Profile",
                        globalModelId: firstModel,
                      });
                      store.setActiveProfile(id);
                    }}
                >
                    <Plus size={16} />
                    <span>New Profile</span>
                </button>
              </div>
            </>
          ) : null}

            {store.settingsSection === "security" ? (
            <>
              <div className="settings-section-header">
                  <div className="settings-section-title">
                    {t.settings.security}
                  </div>
                <div className="settings-actions">
                    <button
                      className="btn-secondary"
                      onClick={() => store.openCommandPolicyFile()}
                    >
                    {t.settings.editCommandPolicyFile}
                  </button>
                  <button
                    className="btn-icon-reload"
                    onClick={() => store.loadCommandPolicyLists()}
                    title={t.common.refresh}
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.commandPolicyMode}</label>
                    <InfoTooltip 
                      content={
                        <div className="mode-descriptions">
                            <p>
                              <strong>
                                {t.settings.commandPolicyModes.safe}
                              </strong>
                              : {t.settings.commandPolicyModeDesc.safe}
                            </p>
                            <p>
                              <strong>
                                {t.settings.commandPolicyModes.standard}
                              </strong>
                              : {t.settings.commandPolicyModeDesc.standard}
                            </p>
                            <p>
                              <strong>
                                {t.settings.commandPolicyModes.smart}
                              </strong>
                              : {t.settings.commandPolicyModeDesc.smart}
                            </p>
                        </div>
                      }
                    />
                  </div>
                  <div className="settings-radio-group">
                      {(["safe", "standard", "smart"] as const).map((mode) => (
                      <label key={mode} className="settings-radio-item">
                        <input
                          type="radio"
                          name="command-policy-mode"
                          value={mode}
                          checked={store.settings?.commandPolicyMode === mode}
                          onChange={() => store.setCommandPolicyMode(mode)}
                        />
                        <span>{t.settings.commandPolicyModes[mode]}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="settings-divider settings-divider-spaced">
                <span>{t.settings.commandPolicyAllowlist}</span>
                <i />
              </div>
              <div className="settings-subsection-header">
                <InfoTooltip content={t.settings.commandPolicyRuleDesc} />
                <input
                  className="settings-inline-input"
                  placeholder={t.settings.commandPolicyAddRulePlaceholder}
                  value={cpDraft.allowlist}
                    onChange={(e) =>
                      setCpDraft({ ...cpDraft, allowlist: e.target.value })
                    }
                />
                <button
                  className="icon-btn-sm"
                  title={t.common.add}
                  onClick={() => {
                      void store.addCommandPolicyRule(
                        "allowlist",
                        cpDraft.allowlist,
                      );
                      setCpDraft({ ...cpDraft, allowlist: "" });
                  }}
                >
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
              <RuleChipList
                t={t}
                rules={cpLists.allowlist}
                  onDelete={(rule) =>
                    void store.deleteCommandPolicyRule("allowlist", rule)
                  }
              />

              <div className="settings-divider settings-divider-spaced">
                <span>{t.settings.commandPolicyDenylist}</span>
                <i />
              </div>
              <div className="settings-subsection-header">
                <InfoTooltip content={t.settings.commandPolicyRuleDesc} />
                <input
                  className="settings-inline-input"
                  placeholder={t.settings.commandPolicyAddRulePlaceholder}
                  value={cpDraft.denylist}
                    onChange={(e) =>
                      setCpDraft({ ...cpDraft, denylist: e.target.value })
                    }
                />
                <button
                  className="icon-btn-sm"
                  title={t.common.add}
                  onClick={() => {
                      void store.addCommandPolicyRule(
                        "denylist",
                        cpDraft.denylist,
                      );
                      setCpDraft({ ...cpDraft, denylist: "" });
                  }}
                >
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
              <RuleChipList
                t={t}
                rules={cpLists.denylist}
                  onDelete={(rule) =>
                    void store.deleteCommandPolicyRule("denylist", rule)
                  }
              />

              <div className="settings-divider settings-divider-spaced">
                <span>{t.settings.commandPolicyAsklist}</span>
                <i />
              </div>
              <div className="settings-subsection-header">
                <InfoTooltip content={t.settings.commandPolicyRuleDesc} />
                <input
                  className="settings-inline-input"
                  placeholder={t.settings.commandPolicyAddRulePlaceholder}
                  value={cpDraft.asklist}
                    onChange={(e) =>
                      setCpDraft({ ...cpDraft, asklist: e.target.value })
                    }
                />
                <button
                  className="icon-btn-sm"
                  title={t.common.add}
                  onClick={() => {
                      void store.addCommandPolicyRule(
                        "asklist",
                        cpDraft.asklist,
                      );
                      setCpDraft({ ...cpDraft, asklist: "" });
                  }}
                >
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
              <RuleChipList
                t={t}
                rules={cpLists.asklist}
                  onDelete={(rule) =>
                    void store.deleteCommandPolicyRule("asklist", rule)
                  }
              />
            </>
          ) : null}

            {store.settingsSection === "tts" ? (
              <TtsSettingsPanel store={store} />
            ) : null}

            {store.settingsSection === "tools" ? <ToolsPanel store={store} /> : null}

            {store.settingsSection === "skills" ? <HermesSkillsPanel /> : null}

            {store.settingsSection === "agents" ? (
            <>
              {/* Hermes fleet agents — the new builder (relocated from the primary sidebar). */}
              <AgentsSettings />

              {/* Legacy AgentDefinition roster — still LIVE: feeds the primary chat's
                  delegate_agent sub-agent tool (audit Q1). Kept as a sibling section
                  until its model multi-select moves to the tagged catalog. */}
              <div className="settings-section-header" style={{ marginTop: 36 }}>
                <div className="settings-section-title">
                  Chat sub-agents (delegate_agent roster)
                  <InfoTooltip content="Sub-agents the primary chat can delegate to via the delegate_agent tool — a separate system from the Hermes fleet agents above." />
                </div>
              </div>
              <AgentsPanel store={store} />
            </>
            ) : null}

            {store.settingsSection === "memory" ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">
                  {t.settings.memory}
                  <InfoTooltip content={t.settings.tooltips.memory} />
                </div>
                <div className="settings-actions">
                  <button
                    className="btn-icon-reload"
                    onClick={() => void reloadMemory()}
                    title={t.settings.reloadMemory}
                    disabled={memoryBusy}
                  >
                      <RefreshCw
                        size={14}
                        className={memoryBusy ? "spin" : ""}
                      />
                  </button>
                    <button
                      className="btn-secondary"
                      onClick={() => store.openMemoryFile()}
                    >
                    {t.settings.openMemoryFile}
                  </button>
                    <button
                      className="btn-secondary"
                      onClick={() => void saveMemory()}
                      disabled={memoryBusy}
                    >
                    {t.settings.saveMemory}
                  </button>
                </div>
              </div>

              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.memoryEnabled}</label>
                    <InfoTooltip content={t.settings.tooltips.memory} />
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={store.settings?.memory?.enabled !== false}
                        onChange={(e) =>
                          store.setMemoryEnabled(e.target.checked)
                        }
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
              </div>

              <div className="settings-memory-panel">
                <div className="settings-memory-meta">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.memoryFilePath}</label>
                  </div>
                    <input
                      className="settings-inline-input"
                      value={store.memoryFilePath || "-"}
                      readOnly
                    />

                  <div className="settings-row-label-with-info settings-memory-content-label">
                    <label>{t.settings.memoryContent}</label>
                  </div>
                </div>
                <textarea
                  className="settings-memory-editor"
                  value={memoryDraft}
                  onChange={(event) => setMemoryDraft(event.target.value)}
                  spellCheck={false}
                  disabled={memoryBusy}
                />
              </div>
            </>
          ) : null}

            {store.settingsSection === "accessTokens" ? (
            <>
              <div className="settings-section-header">
                <div className="settings-section-title">
                  {t.settings.accessTokens}
                  <InfoTooltip content={t.settings.tooltips.accessTokens} />
                </div>
                <div className="settings-actions">
                    <button
                      className="btn-icon-reload"
                      onClick={() => store.loadAccessTokens()}
                      title={t.common.refresh}
                    >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>

              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.wsGatewayAccess}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.wsGatewayAccess}
                      />
                  </div>
                  <Select
                    className="settings-native-select"
                      value={wsGatewayAccessDraft}
                      onChange={async (value) => {
                        const nextAccess = value as NonNullable<
                          typeof store.settings
                        >["gateway"]["ws"]["access"];
                        setWsGatewayAccessDraft(nextAccess);
                        if (nextAccess === "custom") {
                          if (persistedWsGatewayCidrs.trim().length > 0) {
                            await store.setWsGatewayAccess("custom");
                          }
                          return;
                        }
                        await store.setWsGatewayAccess(nextAccess);
                      }}
                    options={[
                        {
                          value: "localhost",
                          label: t.settings.wsGatewayAccessModes.localhost,
                        },
                        {
                          value: "lan",
                          label: t.settings.wsGatewayAccessModes.lan,
                        },
                        {
                          value: "custom",
                          label: t.settings.wsGatewayAccessModes.custom,
                        },
                        {
                          value: "internet",
                          label: t.settings.wsGatewayAccessModes.internet,
                        },
                        {
                          value: "disabled",
                          label: t.settings.wsGatewayAccessModes.disabled,
                        },
                    ]}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-label-with-info">
                    <label>{t.settings.wsGatewayPort}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.wsGatewayPort}
                      />
                  </div>
                  <NumericInput
                    className="settings-inline-input"
                    style={{ width: 110 }}
                    value={store.settings?.gateway?.ws?.port || 17888}
                    onChange={(value) => store.setWsGatewayPort(value)}
                    min={1}
                    max={65535}
                  />
                </div>
                  {wsGatewayAccessDraft === "custom" && (
                    <div
                      className="settings-row"
                      style={{
                        flexDirection: "column",
                        alignItems: "flex-start",
                        height: "auto",
                        padding: "10px 12px",
                        gap: 8,
                      }}
                    >
                      <div className="settings-row-label-with-info">
                        <label>{t.settings.wsGatewayCidrs}</label>
                        <InfoTooltip
                          content={t.settings.tooltips.wsGatewayCidrs}
                        />
                      </div>
                      <textarea
                        placeholder={"192.168.1.0/24\n10.0.0.0/8"}
                        value={wsGatewayCidrsDraft}
                        onChange={(e) => setWsGatewayCidrsDraft(e.target.value)}
                        onBlur={async () => {
                          if (persistedWsGatewayAccess === "custom") {
                            const applied =
                              await store.setWsGatewayCidrs(
                                wsGatewayCidrsDraft,
                              );
                            if (!applied) {
                              setWsGatewayCidrsDraft(persistedWsGatewayCidrs);
                            }
                            return;
                          }
                          const applied =
                            await store.setWsGatewayCustomCidrs(
                              wsGatewayCidrsDraft,
                            );
                          if (!applied) {
                            setWsGatewayAccessDraft(persistedWsGatewayAccess);
                            setWsGatewayCidrsDraft(persistedWsGatewayCidrs);
                          }
                        }}
                        rows={4}
                        style={{
                          width: "100%",
                          fontFamily: "monospace",
                          fontSize: "0.85em",
                          padding: "6px 8px",
                          boxSizing: "border-box",
                          resize: "vertical",
                          background:
                            "color-mix(in srgb, var(--fg) 5%, transparent)",
                          color: "var(--fg)",
                          border: "1px solid var(--border)",
                          borderRadius: 2,
                        }}
                      />
                    </div>
                  )}
                </div>

                {/* Mobile Web Server Section */}
                <div className="settings-divider settings-divider-spaced">
                  <span>{t.settings.mobileWebServer}</span>
                  <i />
                </div>
                <div className="settings-rows">
                  <div className="settings-row">
                    <div className="settings-row-label-with-info">
                      <label>{t.settings.mobileWebServer}</label>
                      <InfoTooltip
                        content={t.settings.tooltips.mobileWebServer}
                      />
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={isMobileWebRunning}
                        onChange={async (e) => {
                          const access = store.settings?.gateway?.ws?.access;
                          if (
                            e.target.checked &&
                            (access === "disabled" || access === "localhost")
                          ) {
                            setShowMobileWebGatewayWarning(true);
                            return;
                          }
                          if (e.target.checked) {
                            await store.startMobileWeb();
                          } else {
                            await store.stopMobileWeb();
                          }
                        }}
                      />
                      <span className="switch-slider" />
                    </label>
              </div>

                  <div className="settings-row">
                    <div className="settings-row-label-with-info">
                      <label>{t.settings.mobileWebPort}</label>
                    </div>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          cursor: isMobileWebRunning
                            ? "not-allowed"
                            : "pointer",
                          opacity: isMobileWebRunning ? 0.6 : 1,
                        }}
                      >
                        <input
                          type="radio"
                          name="mobileWebPortMode"
                          checked={
                            store.settings?.gateway?.mobileWeb?.port == null
                          }
                          disabled={isMobileWebRunning}
                          onChange={() => store.setMobileWebPort(null)}
                        />
                        {t.settings.mobileWebPortAuto}
                      </label>
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          cursor: isMobileWebRunning
                            ? "not-allowed"
                            : "pointer",
                          opacity: isMobileWebRunning ? 0.6 : 1,
                        }}
                      >
                        <input
                          type="radio"
                          name="mobileWebPortMode"
                          checked={
                            store.settings?.gateway?.mobileWeb?.port != null
                          }
                          disabled={isMobileWebRunning}
                          onChange={() => store.setMobileWebPort(17889)}
                        />
                        {t.settings.mobileWebPortManual}
                      </label>
                      {store.settings?.gateway?.mobileWeb?.port != null && (
                        <NumericInput
                          className="settings-inline-input"
                          style={{ width: 90 }}
                          value={
                            (store.settings?.gateway?.mobileWeb as any).port
                          }
                          disabled={isMobileWebRunning}
                          onChange={(v) =>
                            store.setMobileWebPort(Math.floor(v))
                          }
                          min={1}
                          max={65535}
                        />
                      )}
                    </div>
                  </div>

                  {isMobileWebRunning &&
                    store.mobileWebStatus.urls &&
                    store.mobileWebStatus.urls.length > 0 && (
                      <div
                        className="settings-row"
                        style={{
                          flexDirection: "column",
                          alignItems: "flex-start",
                          height: "auto",
                          padding: "10px 12px",
                          gap: 8,
                        }}
                      >
                        <div className="settings-row-label-with-info">
                          <label>{t.settings.mobileWebAccessLinks}</label>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                          }}
                        >
                          {store.mobileWebStatus.urls.map((url) => (
                            <div
                              key={url}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                              }}
                            >
                              <code
                                style={{
                                  flex: 1,
                                  fontSize: "0.85em",
                                  wordBreak: "break-all",
                                }}
                              >
                                {url}
                              </code>
                              <button
                                className="btn-secondary"
                                style={{ flexShrink: 0 }}
                                onClick={() =>
                                  navigator.clipboard.writeText(url)
                                }
                              >
                                {t.settings.mobileWebCopyLink}
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                </div>

              <div className="settings-subsection-header">
                <input
                  className="settings-inline-input"
                  placeholder={t.settings.accessTokenNamePlaceholder}
                  value={accessTokenName}
                  onChange={(event) => setAccessTokenName(event.target.value)}
                  disabled={accessTokenBusy}
                />
                  <button
                    className="btn-secondary"
                    onClick={createAccessToken}
                    disabled={accessTokenBusy}
                  >
                    {accessTokenBusy ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      t.common.create
                    )}
                </button>
              </div>

                {accessTokenError ? (
                  <div className="settings-error">{accessTokenError}</div>
                ) : null}

              <div className="settings-divider settings-divider-spaced">
                <span>{t.settings.accessTokenIssuedList}</span>
                <i />
              </div>
              <div className="tools-list">
                {store.accessTokens.map((tokenInfo) => (
                    <div
                      key={tokenInfo.id}
                      className="tool-item access-token-item"
                    >
                    <div className="tool-info">
                      <div className="tool-name">{tokenInfo.name}</div>
                        <div className="tool-meta">
                          {new Date(tokenInfo.createdAt).toLocaleString()}
                        </div>
                    </div>
                    <div className="tool-actions">
                      <button
                        className="icon-btn-sm danger"
                        title={t.common.delete}
                          onClick={() =>
                            setDeleteAccessTokenConfirm({
                              id: tokenInfo.id,
                              name: tokenInfo.name,
                            })
                          }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                  {store.accessTokens.length === 0 ? (
                    <div className="tool-empty">
                      {t.settings.noAccessTokens}
                    </div>
                  ) : null}
              </div>
            </>
          ) : null}

            {store.settingsSection === "version" ? (
            <>
              <div className="settings-section-header">
                  <div className="settings-section-title">
                    {t.settings.version}
                  </div>
                <div className="settings-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => store.checkVersion()}
                    disabled={store.versionCheckInProgress}
                  >
                      {store.versionCheckInProgress
                        ? `${t.settings.checkingVersion}...`
                        : t.settings.checkVersion}
                  </button>
                </div>
              </div>

              <div className="version-grid">
                <div className="version-item">
                    <span className="version-label">
                      {t.settings.currentVersion}
                    </span>
                    <span className="version-value">
                      {versionInfo?.currentVersion || "-"}
                    </span>
                </div>
                <div className="version-item">
                    <span className="version-label">
                      {t.settings.latestVersion}
                    </span>
                    <span className="version-value">
                      {versionInfo?.latestVersion || "-"}
                    </span>
                </div>
                <div className="version-item">
                    <span className="version-label">
                      {t.settings.versionStatus}
                    </span>
                    <span
                      className={`version-status version-status-${versionInfo?.status || "up-to-date"}`}
                    >
                      {versionInfo?.status === "update-available"
                      ? t.settings.updateAvailable
                        : versionInfo?.status === "error"
                      ? t.settings.versionCheckFailed
                      : t.settings.upToDate}
                  </span>
                </div>
                <div className="version-item">
                    <span className="version-label">
                      {t.settings.lastCheckedAt}
                    </span>
                  <span className="version-value">{formattedCheckedAt}</span>
                </div>
                <div className="version-item">
                    <span className="version-label">
                      {t.settings.versionSource}
                    </span>
                    <span className="version-value">
                      {versionInfo?.sourceUrl || "-"}
                    </span>
                </div>
                <div className="version-item">
                    <span className="version-label">
                      {t.settings.downloadPage}
                    </span>
                  {versionInfo?.downloadUrl ? (
                    <button
                      className="version-link"
                      onClick={() => store.openVersionDownload()}
                      title={versionInfo.downloadUrl}
                    >
                      {versionInfo.downloadUrl}
                    </button>
                  ) : (
                    <span className="version-value">-</span>
                  )}
                </div>
              </div>

                {versionInfo?.status === "error" && versionInfo.warning ? (
                <div className="version-warning">
                  <AlertTriangle size={13} />
                    <span>
                      {t.settings.versionNetworkWarning(versionInfo.warning)}
                    </span>
                </div>
              ) : null}

              <div className="settings-card version-note-card">
                  <div className="version-note-title">
                    {t.settings.versionCheckNoteTitle}
                  </div>
                  <div className="version-note-content">
                    {t.settings.versionCheckNote}
                  </div>
              </div>
            </>
          ) : null}

          {store.settingsSection === "cluster-proxmox" ? <ProxmoxSettingsPanel /> : null}
          {store.settingsSection === "cluster-tokens" ? <ClusterTokensPanel /> : null}
          {store.settingsSection === "cluster-ui" ? <ClusterUiPanel /> : null}
          {store.settingsSection === "cluster-services" ? <ExternalServicesPanel /> : null}
          {store.settingsSection === "cluster-servicenames" ? <ServiceNamesPanel /> : null}
          {store.settingsSection === "cluster-gpu" ? <GpuPoolsPanel /> : null}
          {store.settingsSection === "cluster-storage" ? <SharedFoldersPanel /> : null}
          {store.settingsSection === "cluster-proxy" ? <ProxySettingsPanel /> : null}
        </div>
      </div>
    </div>
    );
  },
);

// ─── Profile Voice Button ────────────────────────────────────────────────────

import { VoiceSelector } from './TtsSettingsPanel'
import { getTtsProviders, getRvcModels } from '../../services/ProxlabDiscovery'

const ProfileVoiceButton: React.FC<{
  profile: any
  roleKey: string
  store: any
}> = ({ profile, roleKey, store }) => {
  const [showSelector, setShowSelector] = React.useState(false)

  const ttsConfig = {
    enabled: true,
    dualPipeline: true,
    rvcEnabled: false,
    defaultVoice: 'default',
    defaultModel: 'f5-tts',
    rvcModel: '',
    preferredProviders: [] as number[],
    rvcProviders: [] as number[],
    ...store.settings?.ttsConfig,
    ...((() => { try { return JSON.parse(localStorage.getItem('gyshell-tts-config') || 'null') } catch { return null } })()),
  }

  const isTtsAvailable = ttsConfig.enabled && getTtsProviders().length > 0
  const voiceSettings = profile.voiceSettings || {}
  const roleVoice = voiceSettings[roleKey]
  const hasVoice = !!roleVoice?.voice

  const allVoices = getTtsProviders().flatMap((p: any) => p.voices)
  const uniqueVoices = [...new Set(allVoices)]
  const rvcModelList = getRvcModels()

  const handleSave = (voice: string, rvcVoice?: string) => {
    const newVoiceSettings = { ...voiceSettings }
    if (voice === 'default' && (!rvcVoice || rvcVoice === '__none__')) {
      delete newVoiceSettings[roleKey]
    } else {
      // Save rvcVoice as "__none__" to explicitly disable RVC for this role
      // (distinguishes from undefined which means "use global default")
      newVoiceSettings[roleKey] = { voice, rvcVoice: rvcVoice || '__none__' }
    }
    store.saveProfile({
      ...profile,
      voiceSettings: Object.keys(newVoiceSettings).length > 0 ? newVoiceSettings : undefined,
    } as any)
    setShowSelector(false)
  }

  return (
    <>
      <button
        className={`profile-voice-btn ${!isTtsAvailable ? 'disabled' : hasVoice ? 'has-voice' : ''}`}
        onClick={() => isTtsAvailable && setShowSelector(true)}
        title={!isTtsAvailable ? 'No TTS system configured' : hasVoice ? `Voice: ${roleVoice.voice}` : 'Set voice for this role'}
      >
        <Volume2 size={13} />
      </button>
      {showSelector && (
        <VoiceSelector
          onClose={() => setShowSelector(false)}
          onSave={handleSave}
          currentVoice={roleVoice?.voice}
          currentRvcVoice={roleVoice?.rvcVoice}
          ttsConfig={ttsConfig}
          voices={uniqueVoices}
          rvcModels={rvcModelList}
        />
      )}
    </>
  )
}

// ─── Role Prompts Editor ─────────────────────────────────────────────────────

const PROMPT_ROLES = ['chat', 'coder'] as const;

// Default role prompts (relocated out of the retired legacy services).
import { DEFAULT_ROLE_PROMPTS as CODE_DEFAULT_PROMPTS } from '../../lib/defaultRolePrompts';

// Resolve effective defaults: saved defaults from settings > code defaults
function getEffectiveDefaults(store: any): Record<string, string> {
  const savedDefaults = store?.settings?.models?.defaultRolePrompts || {};
  return { ...CODE_DEFAULT_PROMPTS, ...savedDefaults };
}

// ─── Default System Prompts Editor ───────────────────────────────────────────
// Edits the base default prompts that all new profiles inherit from.

const DefaultPromptsEditor: React.FC<{ store: any }> = observer(({ store }) => {
  const [expanded, setExpanded] = React.useState(false);
  const [editingRole, setEditingRole] = React.useState<string | null>(null);
  const [editValue, setEditValue] = React.useState('');

  const savedDefaults = store.settings?.models?.defaultRolePrompts || {};
  const customCount = Object.keys(savedDefaults).length;

  const startEditing = (role: string) => {
    setEditingRole(role);
    setEditValue(savedDefaults[role] || CODE_DEFAULT_PROMPTS[role] || '');
  };

  const savePrompt = () => {
    if (!editingRole) return;
    const newDefaults = { ...savedDefaults };
    const codeDefault = CODE_DEFAULT_PROMPTS[editingRole] || '';
    if (editValue.trim() === codeDefault.trim() || editValue.trim() === '') {
      delete newDefaults[editingRole];
    } else {
      newDefaults[editingRole] = editValue.trim();
    }
    // Save to settings.models.defaultRolePrompts
    if (!store.settings.models.defaultRolePrompts) store.settings.models.defaultRolePrompts = {};
    store.settings.models.defaultRolePrompts = Object.keys(newDefaults).length > 0 ? newDefaults : undefined;
    store.saveSettings?.();
    setEditingRole(null);
  };

  const resetToCodeDefault = () => {
    if (!editingRole) return;
    setEditValue(CODE_DEFAULT_PROMPTS[editingRole] || '');
  };

  const cancelEdit = () => {
    setEditingRole(null);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0', fontSize: 13 }}
      >
        <span style={{ fontSize: 10 }}>{expanded ? '▾' : '▸'}</span>
        <strong style={{ color: 'var(--fg)' }}>Default System Prompts</strong>
        <span style={{ fontSize: 10, color: 'var(--fg-faint)' }}>
          Base prompts inherited by new profiles
          {customCount > 0 && ` (${customCount} customized)`}
        </span>
      </div>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          {PROMPT_ROLES.map((role) => {
            const isSaved = !!savedDefaults[role];
            const isEditing = editingRole === role;
            const displayPrompt = savedDefaults[role] || CODE_DEFAULT_PROMPTS[role] || '';
            return (
              <div key={role} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'capitalize', flex: 1 }}>
                    {role}
                    {isSaved && <span style={{ fontSize: 9, color: '#f59e0b', marginLeft: 4 }}>modified</span>}
                  </span>
                  <button
                    onClick={() => isEditing ? savePrompt() : startEditing(role)}
                    style={{ border: 'none', background: 'transparent', color: 'var(--accent)', fontSize: 10, fontWeight: 700, cursor: 'pointer', padding: '2px 4px' }}
                  >
                    {isEditing ? 'Save' : 'Edit'}
                  </button>
                  {isEditing && (
                    <>
                      <button
                        onClick={resetToCodeDefault}
                        style={{ border: 'none', background: 'transparent', color: '#f59e0b', fontSize: 10, cursor: 'pointer', padding: '2px 4px' }}
                        title="Reset to built-in code default"
                      >
                        Reset
                      </button>
                      <button
                        onClick={cancelEdit}
                        style={{ border: 'none', background: 'transparent', color: 'var(--fg-faint)', fontSize: 10, cursor: 'pointer', padding: '2px 4px' }}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
                {isEditing ? (
                  <textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    style={{
                      width: '100%', minHeight: 100, marginTop: 4, padding: 6,
                      fontSize: 11, fontFamily: 'monospace', lineHeight: 1.4,
                      border: '1px solid var(--accent)', borderRadius: 3,
                      background: 'var(--panel-bg)', color: 'var(--fg)',
                      resize: 'vertical',
                    }}
                  />
                ) : (
                  <div style={{ fontSize: 10, color: 'var(--fg-faint)', marginTop: 2, lineHeight: 1.3, maxHeight: 32, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {displayPrompt.substring(0, 100)}...
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

const RolePromptsEditor: React.FC<{ profile: any; store: any }> = observer(({ profile, store }) => {
  const [expanded, setExpanded] = React.useState(false);
  const [editingRole, setEditingRole] = React.useState<string | null>(null);
  const [editValue, setEditValue] = React.useState('');

  const currentPrompts = profile.rolePrompts || {};
  const effectiveDefaults = getEffectiveDefaults(store);

  const startEditing = (role: string) => {
    setEditingRole(role);
    setEditValue(currentPrompts[role] || effectiveDefaults[role] || '');
  };

  const savePrompt = () => {
    if (!editingRole) return;
    const newPrompts = { ...currentPrompts };
    const defaultVal = effectiveDefaults[editingRole] || '';
    if (editValue.trim() === defaultVal.trim() || editValue.trim() === '') {
      delete newPrompts[editingRole];
    } else {
      newPrompts[editingRole] = editValue.trim();
    }
    store.saveProfile({ ...profile, rolePrompts: Object.keys(newPrompts).length > 0 ? newPrompts : undefined } as any);
    setEditingRole(null);
  };

  const resetPrompt = () => {
    if (!editingRole) return;
    setEditValue(effectiveDefaults[editingRole] || '');
  };

  const cancelEdit = () => {
    setEditingRole(null);
  };

  return (
    <div className="profile-field" style={{ marginTop: 8 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ink-soft, #8892a4)' }}
      >
        <span style={{ fontSize: 10 }}>{expanded ? '▾' : '▸'}</span>
        <strong>Role Prompts</strong>
        {Object.keys(currentPrompts).length > 0 && (
          <span style={{ fontSize: 10, opacity: 0.7 }}>({Object.keys(currentPrompts).length} customized)</span>
        )}
      </div>
      {expanded && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {PROMPT_ROLES.map((role) => {
            const isCustom = !!currentPrompts[role];
            const isEditing = editingRole === role;
            return (
              <div key={role} style={{ border: '1px solid var(--border, #2a2f3a)', borderRadius: 4, padding: '4px 8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'capitalize', flex: 1 }}>
                    {role}
                    {isCustom && <span style={{ fontSize: 9, color: 'var(--accent)', marginLeft: 4 }}>modified</span>}
                  </span>
                  <button
                    onClick={() => isEditing ? savePrompt() : startEditing(role)}
                    style={{ border: 'none', background: 'transparent', color: 'var(--accent)', fontSize: 10, fontWeight: 700, cursor: 'pointer', padding: '2px 4px' }}
                  >
                    {isEditing ? 'Save' : 'Edit'}
                  </button>
                  {isEditing && (
                    <>
                      <button
                        onClick={resetPrompt}
                        style={{ border: 'none', background: 'transparent', color: 'var(--warning, #f59e0b)', fontSize: 10, cursor: 'pointer', padding: '2px 4px' }}
                        title="Reset to default prompt"
                      >
                        Reset
                      </button>
                      <button
                        onClick={cancelEdit}
                        style={{ border: 'none', background: 'transparent', color: 'var(--ink-soft)', fontSize: 10, cursor: 'pointer', padding: '2px 4px' }}
                        title="Cancel without saving"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
                {isEditing ? (
                  <textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    style={{
                      width: '100%', minHeight: 60, marginTop: 4, padding: 6,
                      fontSize: 11, fontFamily: 'monospace', lineHeight: 1.4,
                      border: '1px solid var(--accent)', borderRadius: 3,
                      background: 'var(--surface-soft, #1e2235)', color: 'var(--ink, #e1e4ea)',
                      resize: 'vertical',
                    }}
                  />
                ) : (
                  <div style={{ fontSize: 10, color: 'var(--ink-soft)', marginTop: 2, lineHeight: 1.3, maxHeight: 32, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {(currentPrompts[role] || effectiveDefaults[role] || '').substring(0, 80)}...
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
