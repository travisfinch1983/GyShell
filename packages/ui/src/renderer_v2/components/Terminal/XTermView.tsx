import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import "./xtermView.scss";
import type { TerminalConfig } from "../../lib/ipcTypes";
import {
  TerminalCommandDraft,
  type TerminalCommandDraftLabels,
} from "./TerminalCommandDraft";
import {
  getDefaultCommandDraftShortcut,
  matchesCommandDraftShortcut,
} from "../../lib/commandDraftShortcut";
import { isTerminalTrackedByBackend } from "./runtimeRetention";
import { resolveTerminalSize } from "./terminalDimensions";
import {
  mergeTerminalRefitRequests,
  NORMAL_TERMINAL_REFIT_REQUEST,
  normalizeTerminalRecoveryReason,
  RECOVERY_TERMINAL_REFIT_REQUEST,
  shouldScheduleTerminalRecoveryOnActivate,
  shouldSendTerminalBackendResize,
  type TerminalRefitRequest,
} from "./terminalRecovery";
import { isRuntimeOwnedByUi } from "./runtimeOwnership";
import {
  hasFileSystemPanelDragPayloadType,
  hasNativeFileDragType,
  resolveTerminalDropPathsForTarget,
} from "../../lib/filesystemDragDrop";
import {
  resolveTerminalWindowsPty,
  windowsPtyOptionsEqual,
  type TerminalRemoteOs,
  type TerminalSystemInfoLike,
} from "./terminalWindowsPty";

/**
 * Copy text to the clipboard with a fallback for non-secure contexts. AI-Lab is served over plain
 * HTTP on a LAN IP, where `navigator.clipboard` is unavailable/blocked — so fall back to a hidden
 * textarea + document.execCommand('copy'), which works without a secure context.
 */
function copyTextToClipboard(text: string): void {
  if (!text) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      return;
    }
  } catch {
    /* fall through */
  }
  fallbackCopy(text);
}

function fallbackCopy(text: string): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {
    /* nothing else we can do */
  }
}

const SCROLLBAR_HIDE_DELAY = 2000; // ms
const RUNTIME_RELEASE_DELAY = 4000; // ms
const COMMAND_DRAFT_SPINNER_FRAMES = ["|", "/", "-", "\\"];
const COMMAND_DRAFT_FAILURE_VISIBILITY_MS = 1000;
const TERMINAL_SEARCH_OPTIONS = {
  caseSensitive: false,
  decorations: {
    matchBackground: "rgba(214, 154, 36, 0.18)",
    matchBorder: "rgba(214, 154, 36, 0.4)",
    matchOverviewRuler: "rgba(214, 154, 36, 0.5)",
    activeMatchBackground: "rgba(214, 154, 36, 0.42)",
    activeMatchBorder: "rgba(214, 154, 36, 0.9)",
    activeMatchColorOverviewRuler: "rgba(214, 154, 36, 0.9)",
  },
};

type CommandDraftOpenRequest = {
  id: number;
  placement: "center" | "pointer";
  terminalId: string;
};

type TerminalSettings = {
  fontSize?: number;
  lineHeight?: number;
  scrollback?: number;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  copyOnSelect?: boolean;
  rightClickToPaste?: boolean;
  commandDraftShortcut?: string;
};

export interface XTermSearchHandle {
  setSearchQuery: (query: string) => void;
  findNext: (query: string) => void;
  findPrevious: (query: string) => void;
  clearSearch: () => void;
}

interface XTermViewProps {
  config: TerminalConfig;
  theme: ITheme;
  terminalSettings?: TerminalSettings;
  commandDraftLabels?: TerminalCommandDraftLabels;
  commandDraftShortcut?: string;
  commandDraftProfileId?: string;
  commandDraftProfileOptions?: Array<{ id: string; name: string }>;
  onCommandDraftProfileChange?: (profileId: string) => void;
  commandDraftOpenRequest?: CommandDraftOpenRequest | null;
  onCommandDraftOpenRequestHandled?: (
    requestId: number,
    terminalId: string,
  ) => void;
  remoteOs?: TerminalRemoteOs;
  systemInfo?: TerminalSystemInfoLike;
  isOwnedByUi?: () => boolean;
  isActive?: boolean;
  layoutSignature?: string;
  onSelectionChange?: (selectionText: string) => void;
  onSearchResultsChange?: (payload: {
    resultCount: number;
    resultIndex: number;
  }) => void;
}

interface TerminalRuntime {
  terminalId: string;
  term: Terminal;
  fit: FitAddon;
  searchAddon: SearchAddon;
  mountEl: HTMLDivElement;
  contextMenuId: string;
  selectionHandler?: (selectionText: string) => void;
  settings?: TerminalSettings;
  uiOwnershipCheck?: () => boolean;
  isActive: boolean;
  hostEl: HTMLDivElement | null;
  refCount: number;
  releaseTimer: number | null;
  scrollHideTimer: number | null;
  cleanupBackendData: () => void;
  cleanupContextMenuListener: () => void;
  inputDispose: () => void;
  selectionDispose: () => void;
  scrollDispose: () => void;
  removeDomListeners: () => void;
  refitFrame: number | null;
  settleRefitFrame: number | null;
  pendingRefitRequest: TerminalRefitRequest;
  lastHandledRecoveryEpoch: number;
  pendingRecoveryRefit: boolean;
}

const runtimePool = new Map<string, TerminalRuntime>();
let terminalRecoveryEpoch = 0;

const toPlainConfig = (config: TerminalConfig): TerminalConfig =>
  JSON.parse(JSON.stringify(config)) as TerminalConfig;

const clearTimer = (timerId: number | null): void => {
  if (timerId !== null) {
    window.clearTimeout(timerId);
  }
};

const clearAnimationFrame = (frameId: number | null): void => {
  if (frameId !== null) {
    window.cancelAnimationFrame(frameId);
  }
};

const noteTerminalRecoveryEvent = (): number => {
  terminalRecoveryEpoch += 1;
  return terminalRecoveryEpoch;
};

const refitRuntime = (
  runtime: TerminalRuntime,
  request: TerminalRefitRequest = NORMAL_TERMINAL_REFIT_REQUEST,
): void => {
  const host = runtime.hostEl;
  if (!host) return;
  if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
  try {
    if (request.clearTextureAtlas) {
      runtime.term.clearTextureAtlas();
    }
    const previousCols = runtime.term.cols;
    const previousRows = runtime.term.rows;
    runtime.fit.fit();
    const next = runtime.fit.proposeDimensions();
    const size = resolveTerminalSize(next, {
      cols: runtime.term.cols,
      rows: runtime.term.rows,
    });
    if (
      shouldSendTerminalBackendResize({
        previousCols,
        previousRows,
        nextCols: size.cols,
        nextRows: size.rows,
        forceBackendResize: request.forceBackendResize,
      })
    ) {
      void window.gyshell.terminal
        .resize(runtime.terminalId, size.cols, size.rows)
        .catch(() => {
          // ignore transient backend issues during recovery or hot reload
        });
    }
    runtime.term.refresh(0, Math.max(0, runtime.term.rows - 1));
  } catch {
    // ignore transient DOM/layout issues
  }
};

const scheduleRuntimeRefit = (
  runtime: TerminalRuntime,
  request: TerminalRefitRequest = NORMAL_TERMINAL_REFIT_REQUEST,
): void => {
  runtime.pendingRefitRequest = mergeTerminalRefitRequests(
    runtime.pendingRefitRequest,
    request,
  );
  clearAnimationFrame(runtime.refitFrame);
  clearAnimationFrame(runtime.settleRefitFrame);
  runtime.refitFrame = window.requestAnimationFrame(() => {
    runtime.refitFrame = null;
    const nextRequest = runtime.pendingRefitRequest;
    runtime.pendingRefitRequest = { ...NORMAL_TERMINAL_REFIT_REQUEST };
    refitRuntime(runtime, nextRequest);
    // Resizable panel layout can settle one frame later; run one more fit pass.
    runtime.settleRefitFrame = window.requestAnimationFrame(() => {
      runtime.settleRefitFrame = null;
      refitRuntime(runtime, NORMAL_TERMINAL_REFIT_REQUEST);
    });
  });
};

const scheduleRuntimeRecoveryRefit = (
  runtime: TerminalRuntime,
  recoveryEpoch = terminalRecoveryEpoch,
): void => {
  runtime.lastHandledRecoveryEpoch = Math.max(
    runtime.lastHandledRecoveryEpoch,
    recoveryEpoch,
  );
  runtime.pendingRecoveryRefit = false;
  scheduleRuntimeRefit(runtime, RECOVERY_TERMINAL_REFIT_REQUEST);
};

const attachRuntimeToHost = (
  runtime: TerminalRuntime,
  hostEl: HTMLDivElement,
): void => {
  if (runtime.hostEl === hostEl && runtime.mountEl.parentElement === hostEl)
    return;
  if (
    runtime.mountEl.parentElement &&
    runtime.mountEl.parentElement !== hostEl
  ) {
    runtime.mountEl.parentElement.removeChild(runtime.mountEl);
  }
  hostEl.replaceChildren(runtime.mountEl);
  runtime.hostEl = hostEl;
};

const disposeRuntime = (runtime: TerminalRuntime): void => {
  clearTimer(runtime.releaseTimer);
  clearTimer(runtime.scrollHideTimer);
  clearAnimationFrame(runtime.refitFrame);
  clearAnimationFrame(runtime.settleRefitFrame);
  runtime.releaseTimer = null;
  runtime.scrollHideTimer = null;
  runtime.refitFrame = null;
  runtime.settleRefitFrame = null;
  runtime.cleanupBackendData();
  runtime.cleanupContextMenuListener();
  runtime.inputDispose();
  runtime.selectionDispose();
  runtime.scrollDispose();
  runtime.removeDomListeners();
  runtime.hostEl = null;
  runtime.term.dispose();
};

const createRuntime = (
  config: TerminalConfig,
  theme: ITheme,
  settings: TerminalSettings | undefined,
  remoteOs?: TerminalRemoteOs,
  systemInfo?: TerminalSystemInfoLike,
): TerminalRuntime => {
  const windowsPty = resolveTerminalWindowsPty(remoteOs, systemInfo);
  const term = new Terminal({
    allowTransparency: true,
    cursorBlink: settings?.cursorBlink ?? true,
    cursorStyle: settings?.cursorStyle ?? "block",
    fontSize: settings?.fontSize ?? 14,
    lineHeight: Math.max(1, settings?.lineHeight ?? 1.2),
    scrollback: settings?.scrollback ?? 5000,
    theme,
    windowsPty,
    allowProposedApi: true,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  const searchAddon = new SearchAddon();
  term.loadAddon(searchAddon);

  const webLinks = new WebLinksAddon((_event, url) => {
    window.gyshell.system.openExternal(url).catch(() => {
      // ignore
    });
  });
  term.loadAddon(webLinks);

  const mountEl = document.createElement("div");
  mountEl.style.width = "100%";
  mountEl.style.height = "100%";
  mountEl.style.position = "relative";

  term.open(mountEl);
  try {
    fit.fit();
  } catch {
    // ignore transient DOM/layout issues
  }

  const runtime: TerminalRuntime = {
    terminalId: config.id,
    term,
    fit,
    searchAddon,
    mountEl,
    contextMenuId: `terminal-${config.id}`,
    selectionHandler: undefined,
    settings,
    uiOwnershipCheck: undefined,
    isActive: false,
    hostEl: null,
    refCount: 0,
    releaseTimer: null,
    scrollHideTimer: null,
    cleanupBackendData: () => {},
    cleanupContextMenuListener: () => {},
    inputDispose: () => {},
    selectionDispose: () => {},
    scrollDispose: () => {},
    removeDomListeners: () => {},
    refitFrame: null,
    settleRefitFrame: null,
    pendingRefitRequest: { ...NORMAL_TERMINAL_REFIT_REQUEST },
    lastHandledRecoveryEpoch: terminalRecoveryEpoch,
    pendingRecoveryRefit: false,
  };

  const showScrollbar = () => {
    runtime.hostEl?.classList.add("is-scrollbar-visible");
    clearTimer(runtime.scrollHideTimer);
    runtime.scrollHideTimer = window.setTimeout(() => {
      runtime.hostEl?.classList.remove("is-scrollbar-visible");
      runtime.scrollHideTimer = null;
    }, SCROLLBAR_HIDE_DELAY);
  };

  const inputDisposable = term.onData((data) => {
    window.gyshell.terminal.write(config.id, data);
  });

  const selectionDisposable = term.onSelectionChange(() => {
    const selectionText = term.getSelection();
    runtime.selectionHandler?.(selectionText);
    if (selectionText && runtime.settings?.copyOnSelect) {
      copyTextToClipboard(selectionText);
    }
  });

  const scrollDisposable = term.onScroll(() => {
    showScrollbar();
  });

  const handlePaste = (event: ClipboardEvent) => {
    const selectionText = term.getSelection();
    if (selectionText) {
      event.preventDefault();
      copyTextToClipboard(selectionText);
      term.paste(selectionText);
    }
  };

  const handleDragOver = (event: DragEvent) => {
    const isFileDrop =
      hasFileSystemPanelDragPayloadType(event.dataTransfer) ||
      hasNativeFileDragType(event.dataTransfer);
    if (!isFileDrop) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  };

  const handleDrop = (event: DragEvent) => {
    const isFileDrop =
      hasFileSystemPanelDragPayloadType(event.dataTransfer) ||
      hasNativeFileDragType(event.dataTransfer);
    if (!isFileDrop) return;
    event.preventDefault();
    event.stopPropagation();
    const paths = resolveTerminalDropPathsForTarget(
      event.dataTransfer,
      config.id,
    );
    if (!paths.length) return;
    window.gyshell.terminal.writePaths(config.id, paths).catch(() => {
      // ignore
    });
  };

  // The selection captured when the context menu was opened. Opening/clicking the menu can blur the
  // terminal and clear xterm's live selection, so we must snapshot it here and copy THAT, not re-read.
  let lastContextMenuSelection = "";
  const handleContextMenu = (event: MouseEvent) => {
    if (runtime.settings?.rightClickToPaste) {
      event.preventDefault();
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {
          // ignore
        });
      return;
    }
    event.preventDefault();
    const selectionText = term.getSelection();
    lastContextMenuSelection = selectionText;
    window.gyshell.ui.showContextMenu({
      id: runtime.contextMenuId,
      canCopy: selectionText.trim().length > 0,
      canPaste: true,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const onContextMenuAction = (data: {
    id: string;
    action: "copy" | "paste";
  }) => {
    if (data.id !== runtime.contextMenuId) return;
    if (data.action === "copy") {
      const selectionText = lastContextMenuSelection || term.getSelection();
      if (selectionText) {
        copyTextToClipboard(selectionText);
      }
      return;
    }
    if (data.action === "paste") {
      const selectionText = lastContextMenuSelection || term.getSelection();
      if (selectionText) {
        copyTextToClipboard(selectionText);
        term.paste(selectionText);
        return;
      }
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {
          // ignore
        });
    }
  };

  mountEl.addEventListener("paste", handlePaste);
  mountEl.addEventListener("dragover", handleDragOver, true);
  mountEl.addEventListener("drop", handleDrop, true);
  mountEl.addEventListener("contextmenu", handleContextMenu);
  const removeContextMenuListener =
    window.gyshell.ui.onContextMenuAction(onContextMenuAction);

  let lastBufferOffset = 0;
  let isSyncingInitialBuffer = true;
  const pendingLiveEvents: Array<{ data: string; offset?: number }> = [];
  const writeDataWithOffset = (data: string, offset?: number): void => {
    if (!data) return;
    if (!Number.isFinite(offset)) {
      term.write(data);
      return;
    }

    const normalizedOffset = Math.max(0, Math.floor(offset as number));
    const chunkStart = Math.max(0, normalizedOffset - data.length);
    if (normalizedOffset <= lastBufferOffset) {
      return;
    }
    if (chunkStart < lastBufferOffset) {
      const overlap = lastBufferOffset - chunkStart;
      const nextChunk = data.slice(Math.max(0, overlap));
      if (nextChunk) {
        term.write(nextChunk);
      }
      lastBufferOffset = normalizedOffset;
      return;
    }
    term.write(data);
    lastBufferOffset = normalizedOffset;
  };

  const cleanup = window.gyshell.terminal.onData(
    ({ terminalId, data, offset }) => {
      if (terminalId === config.id) {
        if (isSyncingInitialBuffer) {
          pendingLiveEvents.push({ data, offset });
          return;
        }
        writeDataWithOffset(data, offset);
      }
    },
  );

  const plainConfig = toPlainConfig(config);
  const dims = fit.proposeDimensions();
  const size = resolveTerminalSize(dims, {
    cols: term.cols,
    rows: term.rows,
  });
  window.gyshell.terminal
    .createTab({ ...plainConfig, cols: size.cols, rows: size.rows })
    .catch(() => {
      // ignore: backend is idempotent and may fail during hot reload; user will see logs in devtools
    });
  window.gyshell.terminal.resize(config.id, size.cols, size.rows).catch(() => {
    // ignore
  });

  const syncBufferedOutput = async (): Promise<void> => {
    try {
      const initial = await window.gyshell.terminal.getBufferDelta(
        config.id,
        0,
      );
      writeDataWithOffset(initial.data || "", initial.offset);

      const normalizedOffset = Math.max(
        lastBufferOffset,
        Number.isFinite(initial.offset) ? Math.floor(initial.offset) : 0,
      );
      lastBufferOffset = normalizedOffset;
      const tail = await window.gyshell.terminal.getBufferDelta(
        config.id,
        normalizedOffset,
      );
      writeDataWithOffset(tail.data || "", tail.offset);
    } catch {
      // ignore: runtime output sync is best-effort
    } finally {
      isSyncingInitialBuffer = false;
      if (pendingLiveEvents.length > 0) {
        const pending = pendingLiveEvents.splice(0, pendingLiveEvents.length);
        pending.forEach((event) =>
          writeDataWithOffset(event.data, event.offset),
        );
      }
    }
  };
  void syncBufferedOutput();

  runtime.cleanupBackendData = cleanup;
  runtime.cleanupContextMenuListener = removeContextMenuListener;
  runtime.inputDispose = () => inputDisposable.dispose();
  runtime.selectionDispose = () => selectionDisposable.dispose();
  runtime.scrollDispose = () => scrollDisposable.dispose();
  runtime.removeDomListeners = () => {
    mountEl.removeEventListener("paste", handlePaste);
    mountEl.removeEventListener("dragover", handleDragOver, true);
    mountEl.removeEventListener("drop", handleDrop, true);
    mountEl.removeEventListener("contextmenu", handleContextMenu);
  };

  return runtime;
};

const acquireRuntime = (
  config: TerminalConfig,
  theme: ITheme,
  settings: TerminalSettings | undefined,
  uiOwnershipCheck?: () => boolean,
  remoteOs?: TerminalRemoteOs,
  systemInfo?: TerminalSystemInfoLike,
): TerminalRuntime => {
  let runtime = runtimePool.get(config.id);
  if (!runtime) {
    runtime = createRuntime(config, theme, settings, remoteOs, systemInfo);
    runtimePool.set(config.id, runtime);
  }
  if (uiOwnershipCheck) {
    runtime.uiOwnershipCheck = uiOwnershipCheck;
  }
  runtime.refCount += 1;
  clearTimer(runtime.releaseTimer);
  runtime.releaseTimer = null;
  return runtime;
};

const releaseRuntime = (
  terminalId: string,
  options?: {
    decrementRefCount?: boolean;
  },
): void => {
  const runtime = runtimePool.get(terminalId);
  if (!runtime) return;
  if (options?.decrementRefCount !== false) {
    runtime.refCount = Math.max(0, runtime.refCount - 1);
  }
  if (runtime.refCount > 0) return;

  clearTimer(runtime.releaseTimer);
  runtime.releaseTimer = window.setTimeout(() => {
    const pending = runtimePool.get(terminalId);
    if (!pending || pending.refCount > 0) return;
    if (!isRuntimeOwnedByUi(pending.uiOwnershipCheck)) {
      disposeRuntime(pending);
      runtimePool.delete(terminalId);
      return;
    }

    isTerminalTrackedByBackend(terminalId).then((stillTrackedByBackend) => {
      const latest = runtimePool.get(terminalId);
      if (!latest || latest.refCount > 0) return;
      if (!isRuntimeOwnedByUi(latest.uiOwnershipCheck)) {
        disposeRuntime(latest);
        runtimePool.delete(terminalId);
        return;
      }

      if (stillTrackedByBackend) {
        latest.releaseTimer = window.setTimeout(() => {
          releaseRuntime(terminalId, { decrementRefCount: false });
        }, RUNTIME_RELEASE_DELAY);
        return;
      }

      disposeRuntime(latest);
      runtimePool.delete(terminalId);
    });
  }, RUNTIME_RELEASE_DELAY);
};

export const XTermView = React.forwardRef<XTermSearchHandle, XTermViewProps>(
  function XTermView(props, ref): React.ReactElement {
    const hostRef = useRef<HTMLDivElement>(null);
    const runtimeRef = useRef<TerminalRuntime | null>(null);
    const aliveRef = useRef(true);
    const isActiveRef = useRef(props.isActive !== false);
    const commandDraftFailureTimerRef = useRef<number | null>(null);
    const lastHandledDraftRequestIdRef = useRef(0);
    const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
    const [commandDraftOpen, setCommandDraftOpen] = useState(false);
    const [commandDraftInput, setCommandDraftInput] = useState("");
    const [commandDraftPending, setCommandDraftPending] = useState(false);
    const [commandDraftFailed, setCommandDraftFailed] = useState(false);
    const [commandDraftPosition, setCommandDraftPosition] = useState<{
      left: number;
      top: number;
      width?: number;
    } | null>(null);
    const [commandDraftSpinnerFrame, setCommandDraftSpinnerFrame] = useState(0);
    const resolvedCommandDraftShortcut =
      props.commandDraftShortcut ?? getDefaultCommandDraftShortcut();

    useImperativeHandle(
      ref,
      () => ({
        setSearchQuery: (query: string) => {
          const runtime = runtimeRef.current;
          const normalizedQuery = String(query || "").trim();
          if (!runtime) {
            return;
          }
          if (!normalizedQuery) {
            runtime.searchAddon.clearDecorations();
            runtime.term.clearSelection();
            props.onSearchResultsChange?.({ resultCount: 0, resultIndex: -1 });
            return;
          }
          runtime.searchAddon.findNext(
            normalizedQuery,
            TERMINAL_SEARCH_OPTIONS,
          );
        },
        findNext: (query: string) => {
          const runtime = runtimeRef.current;
          const normalizedQuery = String(query || "").trim();
          if (!runtime || !normalizedQuery) {
            return;
          }
          runtime.searchAddon.findNext(
            normalizedQuery,
            TERMINAL_SEARCH_OPTIONS,
          );
        },
        findPrevious: (query: string) => {
          const runtime = runtimeRef.current;
          const normalizedQuery = String(query || "").trim();
          if (!runtime || !normalizedQuery) {
            return;
          }
          runtime.searchAddon.findPrevious(
            normalizedQuery,
            TERMINAL_SEARCH_OPTIONS,
          );
        },
        clearSearch: () => {
          const runtime = runtimeRef.current;
          if (!runtime) {
            return;
          }
          runtime.searchAddon.clearDecorations();
          runtime.term.clearSelection();
          props.onSearchResultsChange?.({ resultCount: 0, resultIndex: -1 });
        },
      }),
      [props],
    );

    useEffect(() => {
      aliveRef.current = true;
      return () => {
        aliveRef.current = false;
        if (commandDraftFailureTimerRef.current !== null) {
          window.clearTimeout(commandDraftFailureTimerRef.current);
          commandDraftFailureTimerRef.current = null;
        }
      };
    }, []);

    const resolveDraftPosition = useCallback(
      (
        placement: "center" | "pointer",
      ): { left: number; top: number; width?: number } | null => {
        const hostEl = hostRef.current;
        if (!hostEl) return null;
        const rect = hostEl.getBoundingClientRect();
        const preferredWidth = Math.min(
          460,
          Math.max(320, Math.floor(rect.width * 0.48)),
        );
        const pointer = placement === "pointer" ? lastPointerRef.current : null;
        const leftFromPointer = pointer
          ? pointer.x - Math.floor(preferredWidth * 0.25)
          : rect.left + Math.round((rect.width - preferredWidth) / 2);
        const topFromPointer = pointer ? pointer.y + 18 : rect.top + 28;
        const minLeft = 12;
        const maxLeft = Math.max(
          minLeft,
          window.innerWidth - preferredWidth - 12,
        );
        const left = Math.min(
          maxLeft,
          Math.max(minLeft, Math.round(leftFromPointer)),
        );
        const estimatedHeight = 138;
        const minTop = Math.max(8, rect.top + 8);
        const maxTop = Math.max(
          minTop,
          Math.min(
            window.innerHeight - estimatedHeight - 12,
            rect.bottom - estimatedHeight - 8,
          ),
        );
        const top = Math.min(
          maxTop,
          Math.max(minTop, Math.round(topFromPointer)),
        );
        return {
          left,
          top,
          width: preferredWidth,
        };
      },
      [],
    );

    const openCommandDraft = useCallback(
      (placement: "center" | "pointer") => {
        if (commandDraftPending) {
          return;
        }
        setCommandDraftInput("");
        setCommandDraftPosition(resolveDraftPosition(placement));
        setCommandDraftOpen(true);
      },
      [commandDraftPending, resolveDraftPosition],
    );

    const submitCommandDraft = useCallback(async () => {
      const prompt = commandDraftInput.trim();
      const profileId = String(props.commandDraftProfileId || "").trim();
      if (!prompt || commandDraftPending || !profileId) return;

      if (commandDraftFailureTimerRef.current !== null) {
        window.clearTimeout(commandDraftFailureTimerRef.current);
        commandDraftFailureTimerRef.current = null;
      }
      setCommandDraftFailed(false);
      setCommandDraftOpen(false);
      setCommandDraftPending(true);
      setCommandDraftPosition(null);
      setCommandDraftInput("");
      const startedAt = Date.now();
      console.debug("[TerminalCommandDraftUI] Start", {
        terminalId: props.config.id,
        profileId,
        promptChars: prompt.length,
      });

      try {
        const result = await window.gyshell.terminal.generateCommandDraft(
          props.config.id,
          prompt,
          profileId,
        );
        const command =
          typeof result?.command === "string" ? result.command : "";
        const runtime = runtimeRef.current;
        if (
          !runtime ||
          runtime.terminalId !== props.config.id ||
          !command.trim()
        ) {
          console.debug("[TerminalCommandDraftUI] Empty result", {
            terminalId: props.config.id,
            profileId,
            elapsedMs: Date.now() - startedAt,
          });
          return;
        }
        if (isActiveRef.current) {
          runtime.term.focus();
        }
        runtime.term.paste(command);
        console.debug("[TerminalCommandDraftUI] Finished", {
          terminalId: props.config.id,
          profileId,
          elapsedMs: Date.now() - startedAt,
          commandChars: command.length,
        });
      } catch (error) {
        console.warn("[TerminalCommandDraftUI] Failed", {
          terminalId: props.config.id,
          profileId,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (aliveRef.current) {
          setCommandDraftFailed(true);
          commandDraftFailureTimerRef.current = window.setTimeout(() => {
            commandDraftFailureTimerRef.current = null;
            if (aliveRef.current) {
              setCommandDraftFailed(false);
            }
          }, COMMAND_DRAFT_FAILURE_VISIBILITY_MS);
        }
      } finally {
        if (aliveRef.current) {
          setCommandDraftPending(false);
        }
      }
    }, [
      commandDraftInput,
      commandDraftPending,
      props.commandDraftProfileId,
      props.config.id,
    ]);

    useEffect(() => {
      if (!commandDraftPending) {
        setCommandDraftSpinnerFrame(0);
        return;
      }
      const timer = window.setInterval(() => {
        setCommandDraftSpinnerFrame(
          (current) => (current + 1) % COMMAND_DRAFT_SPINNER_FRAMES.length,
        );
      }, 90);
      return () => {
        window.clearInterval(timer);
      };
    }, [commandDraftPending]);

    useEffect(() => {
      if (props.isActive !== false) {
        return;
      }
      if (commandDraftFailureTimerRef.current !== null) {
        window.clearTimeout(commandDraftFailureTimerRef.current);
        commandDraftFailureTimerRef.current = null;
      }
      setCommandDraftOpen(false);
      setCommandDraftFailed(false);
      setCommandDraftPosition(null);
    }, [props.isActive]);

    useEffect(() => {
      isActiveRef.current = props.isActive !== false;
    }, [props.isActive]);

    useEffect(() => {
      const request = props.commandDraftOpenRequest;
      if (
        !request ||
        request.terminalId !== props.config.id ||
        commandDraftPending
      ) {
        return;
      }
      if (request.id === lastHandledDraftRequestIdRef.current) {
        return;
      }
      lastHandledDraftRequestIdRef.current = request.id;
      openCommandDraft(request.placement);
      props.onCommandDraftOpenRequestHandled?.(request.id, request.terminalId);
    }, [
      commandDraftPending,
      openCommandDraft,
      props.commandDraftOpenRequest,
      props.config.id,
      props.onCommandDraftOpenRequestHandled,
    ]);

    useEffect(() => {
      const hostEl = hostRef.current;
      if (!hostEl) return;

      const runtime = acquireRuntime(
        props.config,
        props.theme,
        props.terminalSettings,
        props.isOwnedByUi,
        props.remoteOs,
        props.systemInfo,
      );
      runtime.selectionHandler = props.onSelectionChange;
      runtime.settings = props.terminalSettings;
      runtime.uiOwnershipCheck = props.isOwnedByUi;
      runtime.isActive = props.isActive ?? false;
      runtimeRef.current = runtime;
      attachRuntimeToHost(runtime, hostEl);

      const handleResize = () => {
        const activeRuntime = runtimeRef.current;
        if (!activeRuntime?.isActive) return;
        scheduleRuntimeRefit(activeRuntime);
      };

      const handleRecoveryHint = () => {
        const recoveryEpoch = noteTerminalRecoveryEvent();
        const activeRuntime = runtimeRef.current;
        if (!activeRuntime?.isActive) return;
        scheduleRuntimeRecoveryRefit(activeRuntime, recoveryEpoch);
      };

      const handleVisibilityChange = () => {
        if (document.visibilityState !== "visible") return;
        handleRecoveryHint();
      };

      window.addEventListener("resize", handleResize);
      window.addEventListener("pageshow", handleRecoveryHint);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      const resizeObserver =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(() => {
              const activeRuntime = runtimeRef.current;
              if (!activeRuntime?.isActive) return;
              scheduleRuntimeRefit(activeRuntime);
            })
          : null;
      resizeObserver?.observe(hostEl);
      const removeRecoveryHintListener =
        typeof window.gyshell.terminal.onRecoveryHint === "function"
          ? window.gyshell.terminal.onRecoveryHint((payload) => {
              if (!normalizeTerminalRecoveryReason(payload?.reason)) return;
              handleRecoveryHint();
            })
          : () => {};

      return () => {
        window.removeEventListener("resize", handleResize);
        window.removeEventListener("pageshow", handleRecoveryHint);
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
        resizeObserver?.disconnect();
        removeRecoveryHintListener();
        hostEl.classList.remove("is-scrollbar-visible");
        const activeRuntime = runtimeRef.current;
        if (activeRuntime && activeRuntime.terminalId === props.config.id) {
          runtimeRef.current = null;
        }
        releaseRuntime(props.config.id);
      };
    }, [props.config.id]);

    useEffect(() => {
      const hostEl = hostRef.current;
      if (!hostEl || !resolvedCommandDraftShortcut) return;

      const handleMouseMove = (event: MouseEvent) => {
        lastPointerRef.current = { x: event.clientX, y: event.clientY };
      };

      const handleKeyDown = (event: KeyboardEvent) => {
        if (!props.isActive || commandDraftPending) {
          return;
        }
        if (
          event.repeat ||
          !matchesCommandDraftShortcut(event, resolvedCommandDraftShortcut)
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        openCommandDraft("pointer");
      };

      hostEl.addEventListener("mousemove", handleMouseMove, true);
      hostEl.addEventListener("keydown", handleKeyDown, true);

      return () => {
        hostEl.removeEventListener("mousemove", handleMouseMove, true);
        hostEl.removeEventListener("keydown", handleKeyDown, true);
      };
    }, [
      commandDraftPending,
      openCommandDraft,
      props.isActive,
      resolvedCommandDraftShortcut,
    ]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.selectionHandler = props.onSelectionChange;
    }, [props.onSelectionChange, props.config.id]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime || !props.onSearchResultsChange) {
        return;
      }
      const disposable = runtime.searchAddon.onDidChangeResults((payload) => {
        props.onSearchResultsChange?.({
          resultCount: payload.resultCount,
          resultIndex: payload.resultIndex,
        });
      });
      return () => {
        disposable.dispose();
      };
    }, [props.config.id, props.onSearchResultsChange]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.settings = props.terminalSettings;
    }, [props.terminalSettings, props.config.id]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.uiOwnershipCheck = props.isOwnedByUi;
    }, [props.isOwnedByUi, props.config.id]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.isActive = props.isActive ?? false;
      if (runtime.isActive) {
        if (
          shouldScheduleTerminalRecoveryOnActivate({
            recoveryEpoch: terminalRecoveryEpoch,
            lastHandledRecoveryEpoch: runtime.lastHandledRecoveryEpoch,
            pendingRecoveryRefit: runtime.pendingRecoveryRefit,
          })
        ) {
          scheduleRuntimeRecoveryRefit(runtime, terminalRecoveryEpoch);
        } else {
          scheduleRuntimeRefit(runtime);
        }
      }
    }, [props.isActive, props.config.id]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;

      const nextWindowsPty = resolveTerminalWindowsPty(
        props.remoteOs,
        props.systemInfo,
      );
      const currentWindowsPty = runtime.term.options.windowsPty;
      if (windowsPtyOptionsEqual(currentWindowsPty, nextWindowsPty)) {
        return;
      }

      runtime.term.options.windowsPty = nextWindowsPty ?? {};
      if (runtime.isActive) {
        requestAnimationFrame(() => {
          const activeRuntime = runtimeRef.current;
          if (!activeRuntime || activeRuntime.terminalId !== props.config.id)
            return;
          scheduleRuntimeRecoveryRefit(activeRuntime);
        });
        return;
      }

      runtime.pendingRecoveryRefit = true;
    }, [props.remoteOs, props.systemInfo?.release, props.config.id]);

    // Live-update theme (Tabby-style behavior)
    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.term.options.theme = props.theme;
    }, [props.theme, props.config.id]);

    // Live-update terminal settings
    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.settings = props.terminalSettings;
      const options = runtime.term.options;
      if (props.terminalSettings?.fontSize)
        options.fontSize = props.terminalSettings.fontSize;
      if (props.terminalSettings?.lineHeight)
        options.lineHeight = Math.max(1, props.terminalSettings.lineHeight);
      if (props.terminalSettings?.scrollback)
        options.scrollback = props.terminalSettings.scrollback;
      if (props.terminalSettings?.cursorStyle)
        options.cursorStyle = props.terminalSettings.cursorStyle;
      if (props.terminalSettings?.cursorBlink !== undefined)
        options.cursorBlink = props.terminalSettings.cursorBlink;

      // Refit after changes
      requestAnimationFrame(() => {
        if (!props.isActive) return;
        const activeRuntime = runtimeRef.current;
        if (!activeRuntime || activeRuntime.terminalId !== props.config.id)
          return;
        scheduleRuntimeRefit(activeRuntime);
      });
    }, [
      props.terminalSettings?.fontSize,
      props.terminalSettings?.lineHeight,
      props.terminalSettings?.scrollback,
      props.terminalSettings?.cursorStyle,
      props.terminalSettings?.cursorBlink,
      props.config.id,
      props.isActive,
    ]);

    // Re-fit when the tab becomes active (Tabby-like behavior)
    useEffect(() => {
      if (!props.isActive) return;
      const runtime = runtimeRef.current;
      if (!runtime || runtime.terminalId !== props.config.id) return;
      requestAnimationFrame(() => {
        const activeRuntime = runtimeRef.current;
        if (!activeRuntime || activeRuntime.terminalId !== props.config.id)
          return;
        scheduleRuntimeRefit(activeRuntime);
      });
    }, [props.isActive, props.layoutSignature, props.config.id]);

    return (
      <>
        <div className="xterm-shell">
          <div className="xterm-host" ref={hostRef} />
          {commandDraftPending || commandDraftFailed ? (
            <div
              className={
                commandDraftFailed
                  ? "xterm-command-draft-status is-error"
                  : "xterm-command-draft-status"
              }
              aria-hidden="true"
            >
              <span className="xterm-command-draft-status-frame">
                {commandDraftPending
                  ? `[${COMMAND_DRAFT_SPINNER_FRAMES[commandDraftSpinnerFrame]}]`
                  : "[x]"}
              </span>
              <span className="xterm-command-draft-status-text">
                {commandDraftPending
                  ? props.commandDraftLabels?.pending || "drafting command"
                  : props.commandDraftLabels?.failed || "draft failed"}
              </span>
            </div>
          ) : null}
        </div>
        <TerminalCommandDraft
          open={commandDraftOpen}
          value={commandDraftInput}
          position={commandDraftPosition}
          profileId={props.commandDraftProfileId || ""}
          profileOptions={props.commandDraftProfileOptions || []}
          labels={
            props.commandDraftLabels || {
              title: "Command Draft",
              placeholder:
                "Describe what command you want to generate for this terminal tab.",
              send: "Generate",
              shortcutHint: "Open with Cmd/Ctrl+O",
              pending: "drafting command",
              failed: "draft failed",
              noProfile: "no profile",
            }
          }
          onChange={setCommandDraftInput}
          onProfileChange={(profileId) => {
            props.onCommandDraftProfileChange?.(profileId);
          }}
          onSubmit={() => {
            void submitCommandDraft();
          }}
          onCancel={() => {
            if (commandDraftPending) return;
            setCommandDraftOpen(false);
          }}
        />
      </>
    );
  },
);
