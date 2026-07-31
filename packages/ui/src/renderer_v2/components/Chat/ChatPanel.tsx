import React, {
  useEffect,
  useRef,
  useState,
  useLayoutEffect,
  useCallback,
} from "react";
import {
  Square,
  Plus,
  X,
  History,
  CornerDownLeft,
  Play,
  MoreVertical,
  GripVertical,
  Volume2,
  VolumeOff,
  Mic,
  Radio,
} from "lucide-react";
import { observer } from "mobx-react-lite";
import type { AppStore } from "../../stores/AppStore";
import type { ChatMessage } from "../../stores/ChatStore";
import { PanelFindBar } from "../Common/PanelFindBar";
import { ChatHistoryPanel } from "./ChatHistoryPanel";
import { ChatMessageList } from "./ChatMessageList";
import { ConfirmDialog } from "../Common/ConfirmDialog";
import { Select } from "../../platform/Select";
import type { SelectHandle } from "../../platform/windows/WindowsSelect";
import { QueueManager } from "./Queue/QueueManager";
import { QueueModeSwitch } from "./Queue/QueueModeSwitch";
import { CompactPanelTabSelect } from "../Layout/CompactPanelTabSelect";
import { resolvePanelTabBarMode } from "../Layout/panelHeaderPresentation";
import type { QueueItem } from "../../stores/ChatQueueStore";
import { RichInput, type RichInputHandle } from "./RichInput";
import { SeamlessOverlayCard } from "./ChatBanner";
import { resolveFloatingMenuPlacement } from "../../lib/menuPlacement";
import { isLinux, isWindows } from "../../platform/platform";
import { isTtsEnabled, setTtsEnabled, stopPlayback } from "../../services/TtsPlayback";
import {
  startPushToTalk, stopPushToTalk,
  startHandsFree, stopHandsFree,
  claimStt, releaseStt,
  type SttState,
} from "../../services/SttCapture";
import { resolveSeamlessOverlayMessages } from "./chatRenderModel";
import { runSlashCommand } from "./slashCommands";
import {
  CHAT_PANEL_SESSION_TITLE_CHAR_LIMIT,
  formatChatPanelSessionTitle,
} from "../../lib/sessionTitleDisplay";
// Legacy specialist chat-overlay removed; messages inject into ChatStore directly
import type { ComposerDraft, InputImageAttachment } from "../../lib/userInput";
import {
  cycleSearchIndex,
  findTextMatches,
  isFindShortcutEvent,
} from "../../lib/textSearch";
import "./chat.scss";

import { createPortal } from "react-dom";

const TokenTooltip: React.FC<{
  mouseX: number;
  mouseY: number;
  content: string;
}> = ({ mouseX, mouseY, content }) => {
  const tooltipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = tooltipRef.current;
    if (!el) return;

    // 1. Get actual dimensions of the element
    const measured = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 24; // Keep 24px distance from the window edge
    const gap = 12; // 12px distance from the mouse cursor

    let x = mouseX;
    let y = mouseY - gap;

    // 2. Horizontal boundary avoidance
    const halfWidth = measured.width / 2;
    if (x - halfWidth < margin) {
      x = margin + halfWidth;
    } else if (x + halfWidth > vw - margin) {
      x = vw - margin - halfWidth;
    }

    // 3. Vertical boundary avoidance and flipping
    let verticalTranslate = "-100%"; // Default above the mouse
    if (y - measured.height < margin) {
      y = mouseY + gap; // Insufficient space, flip to bottom
      verticalTranslate = "0";
      if (y + measured.height > vh - margin) {
        y = vh - margin - measured.height;
      }
    }

    // 4. Update DOM directly synchronously, bypassing React state update cycle to eliminate flickering
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.transform = `translate(-50%, ${verticalTranslate})`;
    el.style.opacity = "1";
  }, [mouseX, mouseY, content]);

  return createPortal(
    <div
      ref={tooltipRef}
      className="token-tooltip"
      style={{
        position: "fixed",
        left: mouseX,
        top: mouseY,
        opacity: 0, // Initially transparent, waiting for calculation to complete
        pointerEvents: "none",
        zIndex: 10000,
      }}
    >
      {content}
    </div>,
    document.body,
  );
};

const CHAT_PANEL_FOCUS_BYPASS_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "[contenteditable]",
  "[data-panel-find-input='true']",
  "[data-layout-panel-draggable='true']",
  "[data-layout-tab-draggable='true']",
  "[draggable='true']",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

const shouldFocusChatPanelRoot = (target: HTMLElement | null): boolean =>
  !target?.closest(CHAT_PANEL_FOCUS_BYPASS_SELECTOR);

const WORD_CHAR_RE = /[A-Za-z'’]/;

/**
 * Find the word at viewport coordinates inside an editable element.
 * Returns the word and a Range covering it, or null if the click missed
 * a word (whitespace, mention chip, image attachment, etc.). Used by
 * the chat context-menu spell-check flow.
 */
function getWordAtPoint(
  x: number,
  y: number,
  rootEl: HTMLElement,
): { word: string; range: Range } | null {
  let textNode: Text | null = null;
  let offset = 0;

  // Chrome / Safari (also recent Firefox) — caretRangeFromPoint
  const docAny = document as any;
  if (typeof docAny.caretRangeFromPoint === "function") {
    const r = docAny.caretRangeFromPoint(x, y) as Range | null;
    if (r && r.startContainer.nodeType === Node.TEXT_NODE) {
      textNode = r.startContainer as Text;
      offset = r.startOffset;
    }
  } else if (typeof docAny.caretPositionFromPoint === "function") {
    // Older Firefox path
    const pos = docAny.caretPositionFromPoint(x, y) as
      | { offsetNode: Node; offset: number }
      | null;
    if (pos && pos.offsetNode.nodeType === Node.TEXT_NODE) {
      textNode = pos.offsetNode as Text;
      offset = pos.offset;
    }
  }
  if (!textNode || !rootEl.contains(textNode)) return null;

  const text = textNode.textContent ?? "";
  let start = Math.min(offset, text.length);
  let end = start;
  while (start > 0 && WORD_CHAR_RE.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHAR_RE.test(text[end])) end++;
  if (start === end) return null;
  const word = text.slice(start, end).replace(/[’]/g, "'");
  if (!word) return null;
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  return { word, range };
}

/**
 * Replace the contents of a Range with plain text and notify the
 * contenteditable host that its content changed (so React + the
 * RichInput onInput handler pick up the new value).
 */
function replaceRangeWithText(range: Range, text: string): void {
  try {
    const startContainer = range.startContainer;
    const editorEl =
      startContainer.nodeType === Node.ELEMENT_NODE
        ? (startContainer as HTMLElement)
        : (startContainer.parentElement as HTMLElement | null);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    // Move caret to end of replacement.
    const after = document.createRange();
    after.setStartAfter(node);
    after.collapse(true);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(after);
    }
    // Bubble an input event so the RichInput's onInput rebuilds state.
    const host = editorEl?.closest(".rich-input-editor") as HTMLElement | null;
    if (host) {
      host.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
  } catch {
    // Range invalidated since right-click — abort silently.
  }
}

interface ChatPanelProps {
  store: AppStore;
  panelId: string;
  sessionIds: string[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onRequestCloseTabs?: (tabIds: string[]) => void;
  onLayoutHeaderContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  /** Overlay mode (GlobalChat): the unified tab strip lives OUTSIDE — skip the
   *  internal header row (tabs + add/history/export actions) entirely. */
  hideTabBar?: boolean;
}

export const ChatPanel: React.FC<ChatPanelProps> = observer(
  ({
    store,
    panelId,
    sessionIds,
    activeSessionId,
    onSelectSession,
    onRequestCloseTabs,
    onLayoutHeaderContextMenu,
    hideTabBar,
  }) => {
    const panelRef = useRef<HTMLDivElement>(null);
    const richInputRef = useRef<RichInputHandle>(null);
    const profileSelectRef = useRef<SelectHandle>(null);
    const [inputEmpty, setInputEmpty] = useState(true);
    const [slashNotice, setSlashNotice] = useState<string | null>(null);
    useEffect(() => {
      if (!slashNotice) return;
      const t = setTimeout(() => setSlashNotice(null), 6000);
      return () => clearTimeout(t);
    }, [slashNotice]);

    const checkInputEmpty = useCallback((draft?: ComposerDraft) => {
      const current = draft ||
        richInputRef.current?.getDraft() || { text: "", images: [] };
      setInputEmpty(
        !(current.text.trim().length > 0 || current.images.length > 0),
      );
    }, []);
    const [showHistory, setShowHistory] = useState(false);
    const [rollbackTarget, setRollbackTarget] = useState<ChatMessage | null>(
      null,
    );
    const [queueEditTarget, setQueueEditTarget] = useState<QueueItem | null>(
      null,
    );
    const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(
      null,
    );
    const [showExportMenu, setShowExportMenu] = useState(false);
    const [overlayExpandedById, setOverlayExpandedById] = useState<
      Record<string, boolean>
    >({});
    const [overlayShowDetailsById, setOverlayShowDetailsById] = useState<
      Record<string, boolean>
    >({});
    const [findOpen, setFindOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResultIndex, setSearchResultIndex] = useState(-1);
    const [exportMenuStyle, setExportMenuStyle] = useState<
      React.CSSProperties | undefined
    >(undefined);
    const exportMenuButtonRef = useRef<HTMLButtonElement>(null);
    const exportMenuRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const t = store.i18n.t;
    const contextMenuId = React.useMemo(
      () => `chat-panel-${panelId}`,
      [panelId],
    );
    const panelRect = store.layout.getPanelRect(panelId);
    const tabBarMode = resolvePanelTabBarMode(
      "chat",
      panelRect?.width || 0,
      sessionIds.length,
      store.panelTabDisplayMode,
    );

    // Get active session
    const activeSession = store.chat.getSessionById(activeSessionId);
    const activeHeaderSession =
      activeSession || store.chat.getSessionById(sessionIds[0] || "");
    const normalizedSearchQuery = searchQuery.trim();
    const searchResultMessageIds = React.useMemo(() => {
      if (!activeSession || !normalizedSearchQuery) {
        return [];
      }
      return activeSession.messageIds.filter((messageId) => {
        const message = activeSession.messagesById.get(messageId);
        if (!message || message.type !== "text") {
          return false;
        }
        return (
          findTextMatches(String(message.content || ""), normalizedSearchQuery)
            .length > 0
        );
      });
    }, [activeSession, normalizedSearchQuery]);
    const activeSearchMessageId =
      searchResultIndex >= 0
        ? searchResultMessageIds[searchResultIndex] || null
        : null;
    const searchResultMessageIdSet = React.useMemo(
      () => new Set(searchResultMessageIds),
      [searchResultMessageIds],
    );
    const isOverlayOpen = store.view !== "main";
    const isThinking = activeSession?.isThinking || false;
    const isQueueMode = activeSessionId
      ? store.chat.queue.isQueueMode(activeSessionId)
      : false;
    const queueItems = activeSessionId
      ? store.chat.queue.getQueue(activeSessionId)
      : [];
    const isQueueRunning = activeSessionId
      ? store.chat.queue.isRunning(activeSessionId)
      : false;
    const inputDisabled = !activeSessionId;
    const canQueueRun = isQueueMode && !isQueueRunning && queueItems.length > 0;
    const primaryDisabled = isQueueMode
      ? inputEmpty && !canQueueRun
      : inputEmpty;
    const latestTokens = store.chat.getLatestTokens(activeSessionId);
    const latestMaxTokens = store.chat.getLatestMaxTokens(activeSessionId);
    const askLabels = {
      allow: t.common.allow,
      deny: t.common.deny,
      allowed: t.common.allowed,
      denied: t.common.denied,
    };
    const exportMenuPlatformClassName = React.useMemo(() => {
      if (isWindows()) return "is-platform-windows";
      if (isLinux()) return "is-platform-linux";
      return "";
    }, []);

    // Auto-resize input - removed as RichInput handles its own size via contentEditable

    const normalizeInputImages = (
      images: Array<InputImageAttachment & { localFile?: File }>,
    ): InputImageAttachment[] =>
      images
        .map((item) => ({
          ...(item.attachmentId ? { attachmentId: item.attachmentId } : {}),
          ...(item.fileName ? { fileName: item.fileName } : {}),
          ...(item.mimeType ? { mimeType: item.mimeType } : {}),
          ...(typeof item.sizeBytes === "number"
            ? { sizeBytes: item.sizeBytes }
            : {}),
          ...(item.sha256 ? { sha256: item.sha256 } : {}),
          ...(item.previewDataUrl
            ? { previewDataUrl: item.previewDataUrl }
            : {}),
          ...(item.status ? { status: item.status } : {}),
          ...(item.localFile instanceof File
            ? { localFile: item.localFile }
            : {}),
        }))
        .filter(
          (item) =>
            !!String(item.attachmentId || "").trim() ||
            (item as any).localFile instanceof File,
        );

    const handleSendNormal = async (draft: ComposerDraft) => {
      if (!draft.text.trim() && draft.images.length === 0) return;
      if (!activeSessionId) return;
      // Slash commands intercept the send (unknown /words fall through to chat).
      if (draft.images.length === 0 && draft.text.trimStart().startsWith("/")) {
        const r = await runSlashCommand(draft.text, { store, sessionId: activeSessionId });
        if (r) {
          richInputRef.current?.clear();
          setInputEmpty(true);
          setSlashNotice(r.notice);
          return;
        }
      }
      const sent = await store.sendChatMessage(
        activeSessionId,
        {
          text: draft.text,
          ...(draft.images.length > 0
            ? { images: normalizeInputImages(draft.images) }
            : {}),
        },
        { mode: "normal" },
      );
      if (!sent) return;
      richInputRef.current?.clear();
      setInputEmpty(true);
    };

    const handleQueueAdd = (draft: ComposerDraft) => {
      if (!draft.text.trim() && draft.images.length === 0) return;
      if (!activeSessionId) return;
      store.chat.addQueueItem(
        activeSessionId,
        draft.text,
        normalizeInputImages(draft.images),
      );
      richInputRef.current?.clear();
      setInputEmpty(true);
    };

    const handleQueueRun = () => {
      if (!activeSessionId) return;
      store.chat.startQueue(activeSessionId);
    };

    const handlePrimaryAction = async () => {
      const draft = richInputRef.current?.getDraft() || {
        text: "",
        images: [],
      };
      if (isQueueMode) {
        if (draft.text.trim() || draft.images.length > 0) {
          handleQueueAdd(draft);
        } else if (!isThinking && queueItems.length > 0 && !isQueueRunning) {
          handleQueueRun();
        }
        return;
      }
      if (draft.text.trim() || draft.images.length > 0) {
        await handleSendNormal(draft);
      }
    };

    const shouldShowInlinePrimaryWhileThinking = isThinking && !inputEmpty;
    const shouldShowPrimaryIdle = !isThinking;
    const shouldShowPrimary =
      shouldShowInlinePrimaryWhileThinking || shouldShowPrimaryIdle;
    const useQueueAddIcon = isQueueMode && !inputEmpty;
    const shouldShowStop = isThinking;
    const runtimeActionCount =
      (shouldShowPrimary ? 1 : 0) + (shouldShowStop ? 1 : 0);

    const computeExportMenuPosition = useCallback(() => {
      const button = exportMenuButtonRef.current;
      const menu = exportMenuRef.current;
      if (!button || !menu) return;
      const rect = button.getBoundingClientRect();
      const measured = menu.getBoundingClientRect();
      const placement = resolveFloatingMenuPlacement({
        anchorRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        menuWidth: Math.ceil(measured.width),
        menuHeight: Math.ceil(measured.height),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        margin: 8,
        gap: 2,
        preferredMaxHeight: 240,
      });
      setExportMenuStyle({
        position: "fixed",
        top: placement.top,
        left: placement.left,
        maxHeight: placement.maxHeight,
        maxWidth: placement.maxWidth,
      });
    }, []);

    const toggleExportMenu = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (showExportMenu) {
        setShowExportMenu(false);
        return;
      }
      setShowExportMenu(true);
    };

    const handleHistoryExport = async (mode: "simple" | "detailed") => {
      if (!activeSessionId) return;
      try {
        await window.gyshell.agent.exportHistory(activeSessionId, mode);
      } catch (error) {
        console.error("Failed to export history:", error);
      } finally {
        setShowExportMenu(false);
      }
    };

    const handleCopySessionId = async () => {
      const sessionId = activeSession?.id || activeSessionId;
      if (!sessionId) {
        setShowExportMenu(false);
        return;
      }
      try {
        await navigator.clipboard.writeText(sessionId);
      } catch (error) {
        console.error("Failed to copy session ID:", error);
      } finally {
        setShowExportMenu(false);
      }
    };

    const stopCurrentRun = () => {
      if (activeSessionId) {
        store.chat.stopQueue(activeSessionId);
        window.gyshell.agent.stopTask(activeSessionId);
        // Optimistically stop thinking in UI
        store.chat.setThinking(false, activeSessionId);
      }
    };

    const renderPrimaryAction = () => (
      <button
        className="icon-btn-sm primary"
        onClick={() => {
          void handlePrimaryAction();
        }}
        disabled={shouldShowPrimaryIdle ? primaryDisabled : false}
      >
        {useQueueAddIcon ? (
          <Plus size={16} strokeWidth={2} />
        ) : isQueueMode ? (
          <Play size={16} strokeWidth={2} />
        ) : (
          <CornerDownLeft size={16} strokeWidth={2} />
        )}
      </button>
    );

    const renderStopAction = () => (
      <button className="icon-btn-sm danger" onClick={stopCurrentRun}>
        <Square size={16} fill="currentColor" />
      </button>
    );

    const isLayoutDragSource = store.layout.draggingPanelId === panelId;

    const profiles = store.settings?.models.profiles || [];
    const activeProfileId = store.settings?.models.activeProfileId;
    const lockedProfileId = activeSession?.lockedProfileId || null;
    const profileSelectorValue = lockedProfileId || activeProfileId || "";
    const profileSelectorDisabled = Boolean(
      activeSession?.isSessionBusy && lockedProfileId,
    );

    const handleAskDecision = async (
      messageId: string,
      decision: "allow" | "deny",
    ) => {
      const sessionId = activeSession?.id;
      if (!sessionId) return;

      const msg = activeSession.messagesById.get(messageId);
      if (msg?.backendMessageId) {
        // 1. Immediately remove from UI for instant feedback
        store.chat.removeMessage(messageId, sessionId);
        // 2. Send decision using backendMessageId
        console.log(
          `[ChatPanel] Sending decision ${decision} for feedbackId=${msg.backendMessageId}`,
        );
        await window.gyshell.agent.replyMessage(msg.backendMessageId, {
          decision,
        });
      }
    };

    const handleRollbackConfirm = async () => {
      if (!rollbackTarget || !activeSession?.id) return;
      const backendMessageId = rollbackTarget.backendMessageId;
      if (!backendMessageId) return;
      try {
        await window.gyshell.agent.rollbackToMessage(
          activeSession.id,
          backendMessageId,
        );
        store.chat.rollbackToMessage(activeSession.id, backendMessageId);
        richInputRef.current?.setDraft({
          text: rollbackTarget.content || "",
          images: normalizeInputImages(
            (rollbackTarget.metadata?.inputImages || []) as Array<
              InputImageAttachment & { localFile?: File }
            >,
          ),
        });
        setInputEmpty(false);
      } catch (error) {
        console.error("Failed to rollback message:", error);
      } finally {
        setRollbackTarget(null);
      }
    };

    const handleQueueEditRequest = (item: QueueItem) => {
      const currentDraft = richInputRef.current?.getDraft() || {
        text: "",
        images: [],
      };
      if (currentDraft.text.trim() || currentDraft.images.length > 0) {
        setQueueEditTarget(item);
        return;
      }
      if (!activeSessionId) return;
      store.chat.removeQueueItem(activeSessionId, item.id);
      richInputRef.current?.setDraft({
        text: item.content,
        images: item.images || [],
      });
      setInputEmpty(false);
    };

    const handleQueueEditConfirm = () => {
      if (!queueEditTarget || !activeSessionId) return;
      store.chat.removeQueueItem(activeSessionId, queueEditTarget.id);
      richInputRef.current?.setDraft({
        text: queueEditTarget.content,
        images: queueEditTarget.images || [],
      });
      setInputEmpty(false);
      setQueueEditTarget(null);
    };

    useLayoutEffect(() => {
      if (!showExportMenu) return;
      computeExportMenuPosition();
    }, [showExportMenu, computeExportMenuPosition]);

    useEffect(() => {
      if (!queueEditTarget) return;
      if (!queueItems.some((item) => item.id === queueEditTarget.id)) {
        setQueueEditTarget(null);
      }
    }, [queueEditTarget, queueItems]);

    // The misspelled word's range, captured at right-click time. Reused
    // when the user picks a suggestion so we can replace exactly the
    // word they clicked on, not whatever the selection happens to be by
    // the time the menu closes.
    const pendingWordRangeRef = useRef<Range | null>(null);

    useEffect(() => {
      const panelEl = panelRef.current;
      if (!panelEl) return;

      const getSelectionText = () => {
        // In rich input mode, we just use window selection
        return window.getSelection()?.toString() || "";
      };

      const handleContextMenu = (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest(".panel-header-minimal")) {
          return;
        }
        event.preventDefault();
        const selectionText = getSelectionText();

        // Open the menu immediately with copy/paste so there's no
        // perceptible delay. If the click was inside an editable element
        // and lands on a word, we fire spell-check in parallel and
        // re-open the menu with suggestions when it returns.
        const x = event.clientX;
        const y = event.clientY;
        window.gyshell.ui.showContextMenu({
          id: contextMenuId,
          canCopy: selectionText.trim().length > 0,
          canPaste: true,
          x,
          y,
        });
        pendingWordRangeRef.current = null;

        const editorEl = target?.closest<HTMLElement>(".rich-input-editor");
        if (!editorEl) return;
        const wordHit = getWordAtPoint(x, y, editorEl);
        if (!wordHit) return;
        pendingWordRangeRef.current = wordHit.range;
        void window.gyshell.ui
          .spellCheck(wordHit.word)
          .then((result: { misspelled: boolean; suggestions: string[] }) => {
            if (!result?.misspelled || !result.suggestions?.length) return;
            window.gyshell.ui.showContextMenu({
              id: contextMenuId,
              canCopy: selectionText.trim().length > 0,
              canPaste: true,
              x,
              y,
              suggestions: result.suggestions,
            });
          })
          .catch(() => {
            // Backend unavailable / dictionary not loaded — silently
            // fall back to plain copy/paste, which is already open.
          });
      };

      const onContextMenuAction = (data: {
        id: string;
        action: "copy" | "paste" | "replace";
        payload?: string;
      }) => {
        if (data.id !== contextMenuId) return;
        if (data.action === "copy") {
          const selectionText = getSelectionText();
          if (selectionText) {
            navigator.clipboard.writeText(selectionText).catch(() => {
              // ignore
            });
          }
          return;
        }
        if (data.action === "paste") {
          navigator.clipboard
            .readText()
            .then((text) => {
              if (text) {
                // We don't have an easy way to insert into RichInput from here
                // but RichInput handles Ctrl+V itself. This is for context menu.
                // For now, we just append or ignore if not focused.
              }
            })
            .catch(() => {
              // ignore
            });
          return;
        }
        if (data.action === "replace") {
          const replacement = data.payload ?? "";
          const range = pendingWordRangeRef.current;
          pendingWordRangeRef.current = null;
          if (!range || !replacement) return;
          replaceRangeWithText(range, replacement);
          return;
        }
      };

      panelEl.addEventListener("contextmenu", handleContextMenu);
      const removeContextMenuListener =
        window.gyshell.ui.onContextMenuAction(onContextMenuAction);
      return () => {
        panelEl.removeEventListener("contextmenu", handleContextMenu);
        removeContextMenuListener();
      };
    }, [contextMenuId]);

    useEffect(() => {
      if (!showExportMenu) return;

      const onDocMouseDown = (event: MouseEvent) => {
        const target = event.target as Node;
        if (exportMenuRef.current?.contains(target)) return;
        if (exportMenuButtonRef.current?.contains(target)) return;
        setShowExportMenu(false);
      };

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setShowExportMenu(false);
        }
      };

      const onReflow = () => computeExportMenuPosition();

      document.addEventListener("mousedown", onDocMouseDown);
      document.addEventListener("keydown", onKeyDown);
      window.addEventListener("resize", onReflow);
      window.addEventListener("scroll", onReflow, true);

      return () => {
        document.removeEventListener("mousedown", onDocMouseDown);
        document.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("resize", onReflow);
        window.removeEventListener("scroll", onReflow, true);
      };
    }, [showExportMenu, computeExportMenuPosition]);

    useEffect(() => {
      if (!normalizedSearchQuery) {
        setSearchResultIndex(-1);
        return;
      }
      setSearchResultIndex(0);
    }, [activeSessionId, normalizedSearchQuery]);

    useEffect(() => {
      setSearchResultIndex((current) => {
        if (!normalizedSearchQuery || searchResultMessageIds.length <= 0) {
          return -1;
        }
        if (current < 0 || current >= searchResultMessageIds.length) {
          return 0;
        }
        return current;
      });
    }, [normalizedSearchQuery, searchResultMessageIds.length]);

    const focusSearchInput = useCallback(() => {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    }, []);

    const openFind = useCallback(() => {
      setFindOpen(true);
      focusSearchInput();
    }, [focusSearchInput]);

    const closeFind = useCallback(() => {
      setFindOpen(false);
      setSearchQuery("");
      setSearchResultIndex(-1);
    }, []);

    const moveSearchResult = useCallback(
      (direction: "next" | "previous") => {
        if (!normalizedSearchQuery || searchResultMessageIds.length <= 0) {
          return;
        }
        setSearchResultIndex((current) =>
          cycleSearchIndex(current, searchResultMessageIds.length, direction),
        );
      },
      [normalizedSearchQuery, searchResultMessageIds.length],
    );

    const handlePanelKeyDownCapture = useCallback(
      (event: React.KeyboardEvent<HTMLElement>) => {
        if (!isFindShortcutEvent(event)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        openFind();
      },
      [openFind],
    );

    const handlePanelMouseDownCapture = useCallback(
      (event: React.MouseEvent<HTMLElement>) => {
        if (store.layout.tree.focusedPanelId !== panelId) {
          store.layout.setFocusedPanel(panelId);
        }

        const target = event.target as HTMLElement | null;
        if (!shouldFocusChatPanelRoot(target)) {
          return;
        }

        requestAnimationFrame(() => {
          panelRef.current?.focus({ preventScroll: true });
        });
      },
      [panelId, store.layout],
    );

    const handlePanelFocusCapture = useCallback(() => {
      if (store.layout.tree.focusedPanelId !== panelId) {
        store.layout.setFocusedPanel(panelId);
      }
    }, [panelId, store.layout]);

    return (
      <div
        className={`panel panel-chat${isLayoutDragSource ? " is-dragging-source" : ""}`}
        ref={panelRef}
        tabIndex={-1}
        onKeyDownCapture={handlePanelKeyDownCapture}
        onMouseDownCapture={handlePanelMouseDownCapture}
        onFocusCapture={handlePanelFocusCapture}
      >
        {!hideTabBar && (
        <div
          className="panel-header-minimal is-draggable"
          draggable
          data-layout-panel-draggable="true"
          data-layout-panel-id={panelId}
          data-layout-panel-kind="chat"
          onContextMenu={onLayoutHeaderContextMenu}
          title={t.chat.dragHint}
          aria-label={t.chat.dragHint}
        >
          <div className="panel-tab-drag-handle" aria-hidden="true">
            <GripVertical size={12} strokeWidth={2.4} />
          </div>
          {tabBarMode === "select" ? (
            <CompactPanelTabSelect
              className="chat-tabs-select"
              panelId={panelId}
              panelKind="chat"
              value={activeHeaderSession?.id || null}
              options={sessionIds
                .map((sessionId) => store.chat.getSessionById(sessionId))
                .filter(
                  (session): session is NonNullable<typeof session> =>
                    !!session,
                )
                .map((session) => ({
                  value: session.id,
                  label: formatChatPanelSessionTitle(session.title),
                  onClose: () => {
                    if (onRequestCloseTabs) {
                      onRequestCloseTabs([session.id]);
                      return;
                    }
                    store.chat.closeSession(session.id);
                  },
                  closeTitle: t.common.close,
                }))}
              onChange={onSelectSession}
              actions={
                activeHeaderSession ? (
                  <button
                    className="gyshell-compact-tab-select-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (onRequestCloseTabs) {
                        onRequestCloseTabs([activeHeaderSession.id]);
                        return;
                      }
                      store.chat.closeSession(activeHeaderSession.id);
                    }}
                    title={t.common.close}
                  >
                    <X size={12} />
                  </button>
                ) : null
              }
            />
          ) : (
            <div
              className="chat-tabs"
              data-layout-tab-bar="true"
              data-layout-tab-panel-id={panelId}
              data-layout-tab-kind="chat"
            >
              {sessionIds.map((sessionId, index) => {
                const session = store.chat.getSessionById(sessionId);
                if (!session) return null;
                return (
                  <div
                    key={session.id}
                    className={`chat-tab ${session.id === activeSessionId ? "active" : ""}`}
                    style={{
                      maxWidth: `${CHAT_PANEL_SESSION_TITLE_CHAR_LIMIT + 8}ch`,
                    }}
                    onClick={() => onSelectSession(session.id)}
                    draggable
                    data-layout-tab-draggable="true"
                    data-layout-tab-id={session.id}
                    data-layout-tab-kind="chat"
                    data-layout-tab-panel-id={panelId}
                    data-layout-tab-index={index}
                  >
                    <span className="chat-tab-title">
                      {formatChatPanelSessionTitle(session.title)}
                    </span>
                    <button
                      className="chat-tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (onRequestCloseTabs) {
                          onRequestCloseTabs([session.id]);
                          return;
                        }
                        store.chat.closeSession(session.id);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="chat-tabs-actions">
            <button
              className="chat-tab-add"
              onClick={() => {
                const sessionId = store.chat.createSession();
                store.layout.attachTabToPanel("chat", sessionId, panelId);
              }}
            >
              <Plus size={14} />
            </button>
            <button
              className="chat-tab-history"
              onClick={() => setShowHistory(true)}
            >
              <History size={14} />
            </button>
            <button
              ref={exportMenuButtonRef}
              className="chat-tab-history-menu"
              onClick={toggleExportMenu}
              title={t.chat.history.exportMenuTitle}
              aria-label={t.chat.history.exportMenuTitle}
              aria-haspopup="menu"
              aria-expanded={showExportMenu}
            >
              <MoreVertical size={14} />
            </button>
          </div>
        </div>
        )}

        {showExportMenu &&
          createPortal(
            <div
              ref={exportMenuRef}
              className={
                exportMenuPlatformClassName
                  ? `win-select-menu chat-export-menu ${exportMenuPlatformClassName}`
                  : "win-select-menu chat-export-menu"
              }
              role="menu"
              style={exportMenuStyle}
            >
              <button
                type="button"
                className="win-select-option"
                role="menuitem"
                onClick={() => handleHistoryExport("simple")}
              >
                {t.chat.history.exportSimple}
              </button>
              <button
                type="button"
                className="win-select-option"
                role="menuitem"
                onClick={() => handleHistoryExport("detailed")}
              >
                {t.chat.history.exportDetailed}
              </button>
              <button
                type="button"
                className="win-select-option"
                role="menuitem"
                onClick={handleCopySessionId}
                disabled={!activeSessionId}
              >
                {t.chat.history.copySessionId}
              </button>
              <div className="win-select-separator" role="separator" />
              <button
                type="button"
                className="win-select-option"
                role="menuitem"
                onClick={() => {
                  setShowExportMenu(false)
                  const ts = (window as any).__transcriptService
                  if (ts) ts.downloadTranscript()
                }}
              >
                Save Transcript
              </button>
              <button
                type="button"
                className="win-select-option win-select-option-danger"
                role="menuitem"
                onClick={() => {
                  setShowExportMenu(false)
                  if (!activeSessionId) return
                  // Delete all sessions (persisted) and create a fresh one.
                  // closeSession only removes in-memory state, so the next
                  // page reload's rehydrate would resurrect everything.
                  const sessionIds = store.chat.sessions.map((s: any) => s.id)
                  for (const sid of sessionIds) {
                    void store.chat.deleteChatSession(sid).catch((err: any) => {
                      console.warn('[ChatPanel] deleteChatSession failed during clear:', sid, err)
                    })
                  }
                  // Clear transcript
                  const ts = (window as any).__transcriptService
                  if (ts) ts.clearChatTranscript?.()
                }}
              >
                Clear Chat View
              </button>
            </div>,
            document.body,
          )}

        {showHistory && (
          <ChatHistoryPanel
            store={store}
            onClose={() => setShowHistory(false)}
          />
        )}

        <ConfirmDialog
          open={!!rollbackTarget}
          title={t.chat.rollback.title}
          message={t.chat.rollback.message}
          confirmText={t.chat.rollback.confirm}
          cancelText={t.chat.rollback.cancel}
          danger
          onCancel={() => setRollbackTarget(null)}
          onConfirm={handleRollbackConfirm}
        />
        <ConfirmDialog
          open={!!queueEditTarget}
          title={t.chat.queue.editConfirmTitle}
          message={t.chat.queue.editConfirmMessage}
          confirmText={t.chat.queue.editConfirm}
          cancelText={t.chat.queue.editCancel}
          onCancel={() => setQueueEditTarget(null)}
          onConfirm={handleQueueEditConfirm}
        />

        {findOpen ? (
          <PanelFindBar
            inputRef={searchInputRef}
            value={searchQuery}
            placeholder={t.chat.searchPlaceholder}
            resultLabel={
              normalizedSearchQuery
                ? searchResultMessageIds.length > 0
                  ? t.common.findResults(
                      Math.max(0, searchResultIndex + 1),
                      searchResultMessageIds.length,
                    )
                  : t.common.findNoResults
                : ""
            }
            onChange={setSearchQuery}
            onPrevious={() => moveSearchResult("previous")}
            onNext={() => moveSearchResult("next")}
            onClose={closeFind}
            disableNavigation={searchResultMessageIds.length <= 0}
          />
        ) : null}

        <ChatMessageList
          store={store}
          sessionId={activeSessionId}
          isThinking={isThinking}
          placeholder={t.chat.placeholder}
          askLabels={askLabels}
          onAskDecision={handleAskDecision}
          onRollback={(message) => setRollbackTarget(message)}
          searchTargetMessageId={activeSearchMessageId}
          searchTargetVersion={searchResultIndex}
          searchMatchedMessageIds={searchResultMessageIdSet}
        />

        {store.chatDisplayMode === "seamless" &&
          (() => {
            if (!activeSession) return null;
            const overlayMessages =
              resolveSeamlessOverlayMessages(activeSession);
            if (overlayMessages.length === 0) return null;
            return (
              <div className="seamless-overlay">
                {overlayMessages.map((msg) => (
                  <SeamlessOverlayCard
                    key={msg.id}
                    msg={msg}
                    onAskDecision={handleAskDecision}
                    onRemove={() =>
                      store.chat.removeMessage(msg.id, activeSession.id)
                    }
                    askLabels={askLabels}
                    expanded={overlayExpandedById[msg.id]}
                    onExpandedChange={(v) =>
                      setOverlayExpandedById((prev) => ({
                        ...prev,
                        [msg.id]: v,
                      }))
                    }
                    showDetails={overlayShowDetailsById[msg.id]}
                    onShowDetailsChange={(v) =>
                      setOverlayShowDetailsById((prev) => ({
                        ...prev,
                        [msg.id]: v,
                      }))
                    }
                  />
                ))}
              </div>
            );
          })()}

        <div className="chat-input-area">
          {isQueueMode && activeSessionId && queueItems.length > 0 && (
            <div className="queue-area">
              <QueueManager
                items={queueItems}
                isRunning={isQueueRunning}
                onReorder={(fromIndex, toIndex) =>
                  store.chat.moveQueueItem(activeSessionId, fromIndex, toIndex)
                }
                onEdit={handleQueueEditRequest}
                editLabel={t.common.edit}
              />
            </div>
          )}
          {isThinking && (
            <div className="chat-thinking-indicator" role="status" aria-live="polite">
              <span className="chat-thinking-dot" />
              <span className="chat-thinking-dot" />
              <span className="chat-thinking-dot" />
              <span className="chat-thinking-label">Working…</span>
            </div>
          )}
          <div className="input-container">
            {slashNotice && (
              <div className="slash-notice" onClick={() => setSlashNotice(null)}>
                {slashNotice}
              </div>
            )}
            <RichInput
              ref={richInputRef}
              store={store}
              placeholder={t.chat.placeholder}
              onSend={(draft) => {
                if (isQueueMode) {
                  handleQueueAdd(draft);
                  return;
                }
                void handleSendNormal(draft);
              }}
              onInput={(draft) => checkInputEmpty(draft)}
              disabled={inputDisabled}
            />

            <div className="input-footer">
              <div className="input-left-tools">
                <TtsToggleButton />
                <SttControls richInputRef={richInputRef} store={store} />
                <div
                  className={`chat-profile-selector ${profileSelectorDisabled ? "is-disabled" : ""}`}
                  onClick={() => {
                    if (!profileSelectorDisabled) {
                      profileSelectRef.current?.toggle();
                    }
                  }}
                >
                  <span
                    className="profile-icon profile-icon-terminal"
                    aria-hidden="true"
                  >
                    ❯_
                  </span>
                  <Select
                    ref={profileSelectRef}
                    className="profile-dropdown"
                    value={profileSelectorValue}
                    options={profiles.map((p) => ({
                      value: p.id,
                      label: p.name,
                    }))}
                    disabled={profileSelectorDisabled}
                    onChange={(id) => store.setActiveProfile(id)}
                    // Keep the mac-style "text-only" look for this compact selector
                    hideArrow
                  />
                </div>
              </div>
              <div className="input-actions">
                <div className="input-actions-static">
                  <QueueModeSwitch
                    enabled={isQueueMode}
                    disabled={!activeSessionId}
                    onToggle={() => {
                      if (activeSessionId) {
                        store.chat.setQueueMode(activeSessionId, !isQueueMode);
                      }
                    }}
                    labelOn={t.chat.queue.modeQueue}
                    labelOff={t.chat.queue.modeNormal}
                  />
                </div>
                <div className="input-actions-runtime">
                  {runtimeActionCount <= 1 ? (
                    <div className="runtime-buttons is-single">
                      {shouldShowPrimary
                        ? renderPrimaryAction()
                        : shouldShowStop
                          ? renderStopAction()
                          : null}
                    </div>
                  ) : (
                    <div className="runtime-buttons is-double">
                      {shouldShowPrimary ? renderPrimaryAction() : null}
                      {shouldShowStop ? renderStopAction() : null}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {latestTokens > 0 && latestMaxTokens > 0 && (
              <div
                className="token-progress-bar"
                onMouseMove={(e) => setMousePos({ x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setMousePos(null)}
              >
                <div
                  className="token-progress-fill"
                  style={{
                    width: `${Math.min(100, Math.round((latestTokens / latestMaxTokens) * 100))}%`,
                  }}
                />
              </div>
            )}
            {mousePos && !isOverlayOpen && (
              <TokenTooltip
                mouseX={mousePos.x}
                mouseY={mousePos.y}
                content={`${(latestTokens / 1000).toFixed(1)}k / ${(latestMaxTokens / 1000).toFixed(1)}k    ${Math.round((latestTokens / latestMaxTokens) * 100)}%`}
              />
            )}
          </div>
        </div>
      </div>
    );
  },
);

// ─── TTS Toggle Button ──────────────────────────────────────────────────────

const TtsToggleButton: React.FC = () => {
  const [on, setOn] = React.useState(isTtsEnabled)

  const toggle = () => {
    const next = !on
    setOn(next)
    setTtsEnabled(next)
    if (!next) stopPlayback()
  }

  return (
    <button
      className={`tts-auto-toggle ${on ? 'active' : ''}`}
      onClick={toggle}
      title={on ? 'Auto-TTS enabled — click to disable' : 'Enable auto-TTS for model responses'}
    >
      {on ? <Volume2 size={14} /> : <VolumeOff size={14} />}
    </button>
  )
}

// ─── Speech-to-text controls ────────────────────────────────────────────────
//
// ONE component owning BOTH buttons, deliberately.
//
// These used to be two sibling components that each registered their own callbacks on the
// SttCapture singleton. There is only one onStateChange slot, so whichever mounted last won
// and the other button's state callback was orphaned — it recorded and transcribed correctly
// but never lit up, with nothing logged to explain it. Registering both handlers in a single
// claim makes that impossible: one owner, one set of slots, one piece of state.

const SttControls: React.FC<{ richInputRef: React.RefObject<RichInputHandle | null>; store: any }> = ({ richInputRef, store }) => {
  const [state, setState] = React.useState<SttState>('idle')

  React.useEffect(() => {
    claimStt('claude-chat', {
      // Push-to-talk: drop the text into the composer, never send it.
      onTranscript: (text: string) => {
        const el = (richInputRef.current as any)?.rootRef?.current
        if (!el) {
          // Do not fail silently — the words were captured and transcribed, and without
          // this you would simply never see them appear.
          console.warn('[chat] transcript arrived but the input box is not mounted; dropped:', text)
          return
        }
        const current = el.textContent || ''
        el.textContent = current ? current + ' ' + text : text
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      },
      // Hands-free: each utterance sends itself.
      onAutoSend: (text: string) => {
        if (!text || !store) return
        const sessionId = store.chat?.activeSessionId || store.chat?.sessions?.[0]?.id
        if (!sessionId) {
          console.warn('[chat] hands-free transcript had no active session to send to; dropped:', text)
          return
        }
        store.sendChatMessage(sessionId, text)
      },
      onStateChange: (s: SttState) => setState(s),
      onEvicted: (by) => {
        console.warn(`[chat] the microphone was taken over by "${by}"`)
        setState('idle')
      },
    })
    return () => releaseStt('claude-chat')
  }, [richInputRef, store])

  const isRecording = state === 'recording'
  const isTranscribing = state === 'transcribing'
  const isHandsFree = state === 'handsfree' || state === 'handsfree-recording'
  const isSpeaking = state === 'handsfree-recording'

  return (
    <>
      <button
        className={`stt-push-to-talk ${isRecording ? 'recording' : ''} ${isTranscribing ? 'transcribing' : ''}`}
        onClick={() => { if (isRecording) stopPushToTalk(); else if (state === 'idle') startPushToTalk() }}
        disabled={isTranscribing || isHandsFree}
        title={isRecording ? 'Stop recording (click to transcribe)' : isTranscribing ? 'Transcribing...' : 'Push to talk — click to start, click again to stop'}
      >
        {isTranscribing ? <Radio size={14} className="pulse" /> : <Mic size={14} />}
      </button>
      <button
        className={`stt-handsfree ${isHandsFree ? 'active' : ''} ${isSpeaking ? 'speaking' : ''}`}
        onClick={() => { if (isHandsFree) stopHandsFree(); else if (state === 'idle') startHandsFree() }}
        disabled={isRecording || isTranscribing}
        title={isHandsFree ? (isSpeaking ? 'Listening... (speech detected)' : 'Hands-free active — click to stop') : 'Hands-free mode — auto-sends after silence'}
      >
        <Radio size={14} />
      </button>
    </>
  )
}

// (legacy wrapper removed)
// Legacy specialist chat-overlay removed; messages inject into ChatStore
