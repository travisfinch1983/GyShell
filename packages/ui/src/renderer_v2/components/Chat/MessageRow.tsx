import React from "react";
import { observer } from "mobx-react-lite";
import { Check, Copy, CornerUpLeft } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Map minion role/model names to muted colors for chat message tinting */
function getMinionRoleColor(name: string): string {
  const lower = (name || '').toLowerCase()
  if (lower.includes('coder') || lower.includes('kat-dev')) return '#6ba3e0'
  if (lower.includes('creative') || lower.includes('darkidol') || lower.includes('ballad')) return '#d68cb5'
  if (lower.includes('architect') || lower.includes('27b')) return '#d4a853'
  if (lower.includes('scout') || lower.includes('4b')) return '#6bc78f'
  if (lower.includes('orchestrator')) return '#a78bdb'
  if (lower.includes('chat') || lower.includes('122b')) return '#5cb8a0'
  if (lower.includes('minion')) return '#7b9ec4'
  return '#8892a4'
}
import type { AppStore } from "../../stores/AppStore";
import type { ChatMessage } from "../../stores/ChatStore";
import { renderMentionContent } from "../../lib/MentionParser";
import {
  CommandBanner,
  ToolCallBanner,
  FileEditBanner,
  SubToolBanner,
  ReasoningBanner,
  CompactionBanner,
  AskBanner,
  AlertBanner,
  SeamlessToolGroupBanner,
} from "./ChatBanner";
import type { ChatBannerUiState } from "./chatBannerUiState";

interface MessageRowProps {
  store: AppStore;
  sessionId: string;
  messageId: string;
  onAskDecision: (messageId: string, decision: "allow" | "deny") => void;
  onRollback: (msg: ChatMessage) => void;
  askLabels: { allow: string; deny: string; allowed: string; denied: string };
  isThinking: boolean;
  mergeWithPreviousAssistant?: boolean;
  showAssistantGroupCopy?: boolean;
  assistantGroupMessageIds?: string[];
  // Seamless mode: when set, render a grouped tool-activity banner
  seamlessGroupMessageIds?: string[];
  bannerUiState?: ChatBannerUiState;
  onBannerUiStateChange?: (patch: Partial<ChatBannerUiState>) => void;
  isSearchMatch?: boolean;
  isActiveSearchMatch?: boolean;
}

const COPY_FEEDBACK_MS = 1200;

const extractNodeText = (node: React.ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node))
    return node.map((item) => extractNodeText(item)).join("");
  if (React.isValidElement(node)) return extractNodeText(node.props.children);
  return "";
};

const isCompletedWhitespaceAssistantText = (message: ChatMessage): boolean =>
  message.role === "assistant" &&
  message.type === "text" &&
  message.streaming !== true &&
  !/\S/.test(String(message.content || ""));

export const MessageRow: React.FC<MessageRowProps> = observer(
  ({
    store,
    sessionId,
    messageId,
    onAskDecision,
    onRollback,
    askLabels,
    isThinking,
    mergeWithPreviousAssistant = false,
    showAssistantGroupCopy = false,
    assistantGroupMessageIds = [],
    seamlessGroupMessageIds,
    bannerUiState,
    onBannerUiStateChange,
    isSearchMatch = false,
    isActiveSearchMatch = false,
  }) => {
    const session = store.chat.getSessionById(sessionId);
    const msg = session?.messagesById.get(messageId);

    const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
    const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );

    React.useEffect(() => {
      return () => {
        if (copyTimerRef.current) {
          clearTimeout(copyTimerRef.current);
        }
      };
    }, []);

    const markCopied = React.useCallback((key: string) => {
      setCopiedKey(key);
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, COPY_FEEDBACK_MS);
    }, []);

    const normalizedAssistantGroupMessageIds = assistantGroupMessageIds.filter(
      (id) => typeof id === "string" && id.length > 0,
    );
    const groupCopyKey =
      normalizedAssistantGroupMessageIds.length > 0
        ? `assistant-group:${normalizedAssistantGroupMessageIds.join(":")}`
        : "";
    const shouldShowGroupCopy =
      showAssistantGroupCopy && normalizedAssistantGroupMessageIds.length > 0;

    const copyConnectedAssistantRun = React.useCallback(async () => {
      if (!shouldShowGroupCopy) return;
      const formatted = await window.gyshell.agent.formatMessagesMarkdown(
        sessionId,
        normalizedAssistantGroupMessageIds,
      );
      const payload = String(formatted || "").trim();
      if (!payload) return;
      await navigator.clipboard.writeText(payload);
      markCopied(groupCopyKey);
    }, [
      groupCopyKey,
      markCopied,
      normalizedAssistantGroupMessageIds,
      sessionId,
      shouldShowGroupCopy,
    ]);

    const copyCodeBlock = React.useCallback(
      async (rawCode: string) => {
        const payload = String(rawCode || "").replace(/\n$/, "");
        if (!payload) return;
        const feedbackKey = `code:${payload.length}:${payload.slice(0, 32)}`;
        await navigator.clipboard.writeText(payload);
        markCopied(feedbackKey);
      },
      [markCopied],
    );

    if (!session) return null;

    // Seamless mode: render a grouped tool-activity banner for multiple messages
    if (seamlessGroupMessageIds && seamlessGroupMessageIds.length > 0) {
      const groupMessages = seamlessGroupMessageIds
        .map((id) => session.messagesById.get(id))
        .filter((m): m is ChatMessage => !!m);
      if (groupMessages.length === 0) return null;
      return (
        <div
          className={`message-row-container role-assistant${mergeWithPreviousAssistant ? " is-group-continuation" : ""}${isSearchMatch ? " is-search-match" : ""}${isActiveSearchMatch ? " is-search-active" : ""}`}
        >
          <div className={`message-role-label assistant ${msg.metadata?.modelName ? 'minion-role' : ''}`} style={msg.metadata?.modelName ? { color: getMinionRoleColor(msg.metadata.modelName) } : undefined}>{msg.metadata?.modelName ? msg.metadata.modelName.toUpperCase() : 'ASSISTANT'}</div>
          <SeamlessToolGroupBanner
            messages={groupMessages}
            expanded={bannerUiState?.expanded}
            onExpandedChange={(expanded) =>
              onBannerUiStateChange?.({ expanded })
            }
          />
        </div>
      );
    }

    if (!msg) return null;
    const isUser = msg.role === "user";

    // Logic: If this is an 'alert' (retry hint), only show it if it's the absolute last message in the session
    // We check messageIds to see if this ID is the very last one.
    const isLastMessage =
      session.messageIds[session.messageIds.length - 1] === messageId;
    const isRetryHint =
      msg.type === "alert" && msg.metadata?.subToolLevel === "info";

    if (isRetryHint && !isLastMessage) {
      return null;
    }
    if (
      (msg.type === "reasoning" || msg.type === "compaction") &&
      !isLastMessage
    ) {
      return null;
    }

    // Handle special message types
    if (msg.type === "tokens_count") {
      return null;
    }
    if (isCompletedWhitespaceAssistantText(msg)) {
      return null;
    }
    const canRollback =
      isUser && !!msg.backendMessageId && !msg.streaming && !isThinking;

    const minionColor = msg.metadata?.modelName ? getMinionRoleColor(msg.metadata.modelName) : null
    const renderAssistantRow = (children: React.ReactNode) => (
      <div
        className={`message-row-container role-assistant${mergeWithPreviousAssistant ? " is-group-continuation" : ""}${isSearchMatch ? " is-search-match" : ""}${isActiveSearchMatch ? " is-search-active" : ""}${minionColor ? " minion-message" : ""}`}
        style={minionColor ? { borderLeftColor: minionColor, background: `color-mix(in srgb, ${minionColor} 5%, transparent)` } as React.CSSProperties : undefined}
      >
        {children}
        {shouldShowGroupCopy && (
          <div className="message-assistant-group-actions">
            <button
              className="message-copy-btn message-assistant-copy-btn"
              title="Copy assistant message group"
              aria-label="Copy assistant message group"
              onClick={() => {
                void copyConnectedAssistantRun();
              }}
            >
              {copiedKey === groupCopyKey ? (
                <Check size={12} />
              ) : (
                <Copy size={12} />
              )}
            </button>
          </div>
        )}
      </div>
    );

    if (isUser) {
      const inputImages = msg.metadata?.inputImages || [];
      return (
        <div
          className={`message-row-container role-user${isSearchMatch ? " is-search-match" : ""}${isActiveSearchMatch ? " is-search-active" : ""}`}
        >
          <div className="message-role-label user">USER</div>
          <div className="message-user-row">
            <div className={`message-text ${msg.role}`}>
              <div className="plain-text">
                {renderMentionContent(msg.content)}
                {msg.streaming && <span className="cursor-blink" />}
              </div>
              {inputImages.length > 0 && (
                <div className="message-user-images">
                  {inputImages.map((image, index) => {
                    const src = String(image.previewDataUrl || "").trim();
                    return (
                      <div
                        key={`${image.attachmentId || "image"}-${index}`}
                        className="message-user-image-item"
                      >
                        {src ? (
                          <img src={src} alt="Attached image" loading="lazy" />
                        ) : (
                          <div className="message-user-image-missing">IMG</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <button
              className="message-rollback-btn"
              title="Rollback and re-edit"
              onClick={() => onRollback(msg)}
              disabled={!canRollback}
            >
              <CornerUpLeft size={14} />
            </button>
          </div>
        </div>
      );
    }

    if (msg.type === "command") {
      return renderAssistantRow(
        <CommandBanner
          msg={msg}
          expanded={bannerUiState?.expanded}
          onExpandedChange={(expanded) => onBannerUiStateChange?.({ expanded })}
          isSkipping={bannerUiState?.isSkipping}
          onSkippingChange={(isSkipping) =>
            onBannerUiStateChange?.({ isSkipping })
          }
        />,
      );
    }
    if (msg.type === "tool_call") {
      return renderAssistantRow(
        <ToolCallBanner
          msg={msg}
          expanded={bannerUiState?.expanded}
          onExpandedChange={(expanded) => onBannerUiStateChange?.({ expanded })}
        />,
      );
    }
    if (msg.type === "file_edit") {
      return renderAssistantRow(
        <FileEditBanner
          msg={msg}
          expanded={bannerUiState?.expanded}
          onExpandedChange={(expanded) => onBannerUiStateChange?.({ expanded })}
        />,
      );
    }
    if (msg.type === "sub_tool") {
      return renderAssistantRow(
        <SubToolBanner
          msg={msg}
          expanded={bannerUiState?.expanded}
          onExpandedChange={(expanded) => onBannerUiStateChange?.({ expanded })}
        />,
      );
    }
    if (msg.type === "reasoning") {
      return renderAssistantRow(
        <ReasoningBanner
          msg={msg}
          expanded={bannerUiState?.expanded}
          onExpandedChange={(expanded) => onBannerUiStateChange?.({ expanded })}
        />,
      );
    }
    if (msg.type === "compaction") {
      return renderAssistantRow(<CompactionBanner msg={msg} />);
    }
    if (msg.type === "ask") {
      return renderAssistantRow(
        <AskBanner
          msg={msg}
          expanded={bannerUiState?.expanded}
          onExpandedChange={(expanded) => onBannerUiStateChange?.({ expanded })}
          onDecision={(id, decision) => onAskDecision(id, decision)}
          labels={askLabels}
        />,
      );
    }
    if (msg.type === "alert" || msg.type === "error") {
      return renderAssistantRow(
        <AlertBanner
          msg={msg}
          onRemove={() => store.chat.removeMessage(msg.id, sessionId)}
          showDetails={bannerUiState?.showDetails}
          onShowDetailsChange={(showDetails) =>
            onBannerUiStateChange?.({ showDetails })
          }
        />,
      );
    }

    return renderAssistantRow(
      <>
        <div className={`message-role-label assistant ${msg.metadata?.modelName ? 'minion-role' : ''}`} style={msg.metadata?.modelName ? { color: getMinionRoleColor(msg.metadata.modelName) } : undefined}>{msg.metadata?.modelName ? msg.metadata.modelName.toUpperCase() : 'ASSISTANT'}</div>
        <div className={`message-text ${msg.role}`}>
          <div
            className={
              msg.role === "assistant" ? "markdown-body" : "plain-text"
            }
          >
            {msg.role === "assistant" ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  pre: ({ children, ...props }) => {
                    const codeText = extractNodeText(children);
                    const feedbackKey = `code:${codeText.length}:${codeText.slice(0, 32)}`;
                    return (
                      <div className="markdown-pre-wrap">
                        <pre {...props}>{children}</pre>
                        <button
                          className="message-copy-btn markdown-pre-copy-btn"
                          title="Copy code"
                          aria-label="Copy code"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void copyCodeBlock(codeText);
                          }}
                        >
                          {copiedKey === feedbackKey ? (
                            <Check size={12} />
                          ) : (
                            <Copy size={12} />
                          )}
                        </button>
                      </div>
                    );
                  },
                  a: ({ node, ...props }) => (
                    <a {...props} target="_blank" rel="noopener noreferrer" />
                  ),
                }}
              >
                {msg.content}
              </ReactMarkdown>
            ) : (
              msg.content
            )}
            {msg.streaming && <span className="cursor-blink" />}
          </div>
        </div>
      </>,
    );
  },
);
