import React from "react";
import { GripVertical, RefreshCw, Save } from "lucide-react";
import { observer } from "mobx-react-lite";
import type { AppStore } from "../../stores/AppStore";
import { PanelFindBar } from "../Common/PanelFindBar";
import {
  cycleSearchIndex,
  findTextMatches,
  isFindShortcutEvent,
} from "../../lib/textSearch";
import "./fileEditor.scss";

interface FileEditorPanelProps {
  store: AppStore;
  panelId: string;
  onLayoutHeaderContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
}

const replaceSelectionInTextarea = (
  textarea: HTMLTextAreaElement,
  text: string,
  onNextValue: (nextValue: string) => void,
): void => {
  const selectionStart = textarea.selectionStart ?? 0;
  const selectionEnd = textarea.selectionEnd ?? selectionStart;
  const value = textarea.value || "";
  const nextValue = `${value.slice(0, selectionStart)}${text}${value.slice(selectionEnd)}`;
  onNextValue(nextValue);

  const nextCursor = selectionStart + text.length;
  queueMicrotask(() => {
    textarea.focus();
    textarea.setSelectionRange(nextCursor, nextCursor);
  });
};

const revealTextareaMatch = (
  textarea: HTMLTextAreaElement,
  value: string,
  start: number,
  end: number,
): void => {
  textarea.setSelectionRange(start, end);

  const lineHeight = Number.parseFloat(
    window.getComputedStyle(textarea).lineHeight || "",
  );
  const resolvedLineHeight =
    Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 16;
  const lineNumber = value.slice(0, start).split("\n").length - 1;
  const targetTop = lineNumber * resolvedLineHeight;
  const targetBottom = targetTop + resolvedLineHeight;

  if (targetTop < textarea.scrollTop) {
    textarea.scrollTop = Math.max(0, targetTop - resolvedLineHeight * 2);
    return;
  }
  if (targetBottom > textarea.scrollTop + textarea.clientHeight) {
    textarea.scrollTop = Math.max(
      0,
      targetBottom - textarea.clientHeight + resolvedLineHeight * 2,
    );
  }
};

export const FileEditorPanel: React.FC<FileEditorPanelProps> = observer(
  ({ store, panelId, onLayoutHeaderContextMenu }) => {
    const t = store.i18n.t;
    const fileEditor = store.fileEditor;
    const isLayoutDragSource =
      store.layout.isDragging && store.layout.draggingPanelId === panelId;
    const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
    const contextMenuId = React.useMemo(
      () => `file-editor:${panelId}`,
      [panelId],
    );
    const searchInputRef = React.useRef<HTMLInputElement | null>(null);
    const [findOpen, setFindOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState("");
    const [searchResultIndex, setSearchResultIndex] = React.useState(-1);

    const canSave = fileEditor.canSave;
    const currentPath = fileEditor.filePath || "";
    const normalizedSearchQuery = React.useMemo(
      () => searchQuery.trim(),
      [searchQuery],
    );
    const searchMatches = React.useMemo(
      () =>
        normalizedSearchQuery && fileEditor.mode === "text"
          ? findTextMatches(fileEditor.content, normalizedSearchQuery)
          : [],
      [fileEditor.content, fileEditor.mode, normalizedSearchQuery],
    );
    const activeSearchMatch =
      searchResultIndex >= 0 ? searchMatches[searchResultIndex] || null : null;

    React.useEffect(() => {
      const removeListener = window.gyshell.ui.onContextMenuAction(
        (payload) => {
          if (payload.id !== contextMenuId) return;
          const textarea = textareaRef.current;
          if (!textarea) return;

          if (payload.action === "copy") {
            const selectionStart = textarea.selectionStart ?? 0;
            const selectionEnd = textarea.selectionEnd ?? selectionStart;
            if (selectionEnd <= selectionStart) return;
            const selectedText = textarea.value.slice(
              selectionStart,
              selectionEnd,
            );
            if (!selectedText) return;
            navigator.clipboard.writeText(selectedText).catch(() => {
              // ignore
            });
            return;
          }

          navigator.clipboard
            .readText()
            .then((clipboardText) => {
              if (!clipboardText) return;
              replaceSelectionInTextarea(
                textarea,
                clipboardText,
                (nextValue) => {
                  fileEditor.updateContent(nextValue);
                },
              );
            })
            .catch(() => {
              // ignore
            });
        },
      );
      return () => {
        removeListener();
      };
    }, [contextMenuId, fileEditor]);

    React.useEffect(() => {
      if (!normalizedSearchQuery) {
        setSearchResultIndex(-1);
        return;
      }
      setSearchResultIndex(0);
    }, [currentPath, normalizedSearchQuery]);

    React.useEffect(() => {
      setSearchResultIndex((current) => {
        if (!normalizedSearchQuery || searchMatches.length <= 0) {
          return -1;
        }
        if (current < 0 || current >= searchMatches.length) {
          return 0;
        }
        return current;
      });
    }, [normalizedSearchQuery, searchMatches.length]);

    React.useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea || !activeSearchMatch || fileEditor.mode !== "text") {
        return;
      }
      revealTextareaMatch(
        textarea,
        fileEditor.content,
        activeSearchMatch.start,
        activeSearchMatch.end,
      );
    }, [activeSearchMatch, fileEditor.content, fileEditor.mode]);

    const focusSearchInput = React.useCallback(() => {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    }, []);

    const openFind = React.useCallback(() => {
      setFindOpen(true);
      focusSearchInput();
    }, [focusSearchInput]);

    const closeFind = React.useCallback(() => {
      setFindOpen(false);
      setSearchQuery("");
      setSearchResultIndex(-1);
    }, []);

    const moveSearchResult = React.useCallback(
      (direction: "next" | "previous") => {
        if (!normalizedSearchQuery || searchMatches.length <= 0) {
          return;
        }
        setSearchResultIndex((current) =>
          cycleSearchIndex(current, searchMatches.length, direction),
        );
      },
      [normalizedSearchQuery, searchMatches.length],
    );

    const handlePanelKeyDownCapture = React.useCallback(
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

    return (
      <div
        className={`panel panel-file-editor${isLayoutDragSource ? " is-dragging-source" : ""}`}
        onKeyDownCapture={handlePanelKeyDownCapture}
      >
        <div
          className="file-editor-header is-draggable"
          draggable
          data-layout-panel-draggable="true"
          data-layout-panel-id={panelId}
          data-layout-panel-kind="fileEditor"
          onContextMenu={onLayoutHeaderContextMenu}
        >
          <div className="panel-tab-drag-handle" aria-hidden="true">
            <GripVertical size={12} strokeWidth={2.4} />
          </div>
          <div className="file-editor-header-main">
            <span className="file-editor-title">{t.fileEditor.title}</span>
            {currentPath ? (
              <span className="file-editor-path">{currentPath}</span>
            ) : null}
          </div>
          {fileEditor.mode === "text" && fileEditor.dirty ? (
            <span className="file-editor-dirty">
              {t.fileEditor.unsavedChanges}
            </span>
          ) : null}
          <button
            className="icon-btn-sm"
            title={t.common.refresh}
            onClick={() => {
              void fileEditor.refresh();
            }}
            disabled={
              !fileEditor.hasActiveDocument ||
              fileEditor.mode === "loading" ||
              fileEditor.busy
            }
          >
            <RefreshCw size={14} strokeWidth={2} />
          </button>
          <button
            className="icon-btn-sm primary"
            title={t.common.save}
            onClick={() => {
              void fileEditor.save();
            }}
            disabled={!canSave}
          >
            <Save size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="file-editor-status-bar">
          {fileEditor.errorMessage ? (
            <span className="file-editor-status-error">
              {fileEditor.errorMessage}
            </span>
          ) : fileEditor.statusMessage ? (
            <span className="file-editor-status-message">
              {fileEditor.statusMessage}
            </span>
          ) : (
            <span className="file-editor-status-placeholder" />
          )}
        </div>

        {findOpen ? (
          <PanelFindBar
            inputRef={searchInputRef}
            value={searchQuery}
            placeholder={t.fileEditor.searchPlaceholder}
            resultLabel={
              normalizedSearchQuery
                ? searchMatches.length > 0
                  ? t.common.findResults(
                      Math.max(0, searchResultIndex + 1),
                      searchMatches.length,
                    )
                  : t.common.findNoResults
                : ""
            }
            onChange={setSearchQuery}
            onPrevious={() => moveSearchResult("previous")}
            onNext={() => moveSearchResult("next")}
            onClose={closeFind}
            disableNavigation={searchMatches.length <= 0}
          />
        ) : null}

        <div className="panel-body file-editor-body">
          {!fileEditor.hasActiveDocument || fileEditor.mode === "idle" ? (
            <div className="file-editor-empty-state">
              {t.fileEditor.emptyHint}
            </div>
          ) : fileEditor.mode === "loading" ? (
            <div className="file-editor-empty-state">
              {t.fileEditor.loadingPreview}
            </div>
          ) : fileEditor.mode === "error" ? (
            <div className="file-editor-error">
              {fileEditor.errorMessage || t.fileEditor.previewErrorFallback}
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              className="file-editor-textarea"
              value={fileEditor.content}
              onChange={(event) => fileEditor.updateContent(event.target.value)}
              onContextMenu={(event) => {
                event.preventDefault();
                const textarea = textareaRef.current;
                const selectionStart = textarea?.selectionStart ?? 0;
                const selectionEnd = textarea?.selectionEnd ?? selectionStart;
                void window.gyshell.ui.showContextMenu({
                  id: contextMenuId,
                  canCopy: selectionEnd > selectionStart,
                  canPaste: true,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
              onKeyDown={(event) => {
                const isSaveShortcut =
                  (event.metaKey || event.ctrlKey) &&
                  !event.altKey &&
                  event.key.toLowerCase() === "s";
                if (!isSaveShortcut) return;
                event.preventDefault();
                void fileEditor.save();
              }}
              disabled={fileEditor.busy}
            />
          )}
        </div>
      </div>
    );
  },
);
