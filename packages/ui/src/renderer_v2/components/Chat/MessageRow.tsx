import React from "react";
import { observer } from "mobx-react-lite";
import { Brain, Check, ChevronDown, ChevronUp, Code, Copy, CornerUpLeft, Pencil, Send, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Convert hex color to rgba string */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Format a timestamp for display in message headers */
function formatMessageTimestamp(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()

  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  if (isToday) return time
  if (isYesterday) return `Yesterday ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

/** Map minion role/model names to muted colors for chat message tinting */
function getMinionRoleColor(name: string): string {
  const lower = (name || '').toLowerCase()
  if (lower.includes('coder') || lower.includes('kat-dev')) return '#5b9bd5'
  if (lower.includes('creative') || lower.includes('darkidol') || lower.includes('ballad')) return '#d67ec4'
  if (lower.includes('architect') || lower.includes('27b')) return '#e0a832'
  if (lower.includes('scout') || lower.includes('4b')) return '#c084fc'
  if (lower.includes('orchestrator')) return '#a78bdb'
  if (lower.includes('chat') || lower.includes('122b')) return '#34d399'
  if (lower.includes('thinking')) return '#c084fc'
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
          <div className={`message-role-label assistant ${msg.metadata?.modelName ? 'minion-role' : ''}`} style={msg.metadata?.modelName ? { color: getMinionRoleColor(msg.metadata.modelName) } : undefined}>{msg.metadata?.modelName ? msg.metadata.modelName.toUpperCase() : 'ASSISTANT'}{msg.timestamp ? <span className="message-timestamp">{formatMessageTimestamp(msg.timestamp)}</span> : null}</div>
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
    const isMinionMessage = isUser && msg.id?.startsWith('minion-');
    const canEditResend = isMinionMessage && !msg.streaming;

    const minionColor = msg.metadata?.modelName ? getMinionRoleColor(msg.metadata.modelName) : null
    const minionBg = minionColor ? hexToRgba(minionColor, 0.12) : undefined
    const renderAssistantRow = (children: React.ReactNode) => (
      <div
        className={`message-row-container role-assistant${mergeWithPreviousAssistant ? " is-group-continuation" : ""}${isSearchMatch ? " is-search-match" : ""}${isActiveSearchMatch ? " is-search-active" : ""}${minionColor ? " minion-message" : ""}`}
        style={minionColor ? { borderLeftColor: minionColor, backgroundColor: minionBg } : undefined}
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
      if (canEditResend) {
        return (
          <MinionEditableMessage msg={msg} isSearchMatch={isSearchMatch} isActiveSearchMatch={isActiveSearchMatch} />
        );
      }
      return (
        <div
          className={`message-row-container role-user${isSearchMatch ? " is-search-match" : ""}${isActiveSearchMatch ? " is-search-active" : ""}`}
        >
          <div className="message-role-label user">USER{msg.timestamp ? <span className="message-timestamp">{formatMessageTimestamp(msg.timestamp)}</span> : null}</div>
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

    // Check for structured minion message metadata
    const isMinionParsed = msg.metadata?.minionParsed === true
    const minionThinking = msg.metadata?.minionThinking as string | null
    const minionSummary = msg.metadata?.minionSummary as string | undefined
    const minionTo = msg.metadata?.minionTo as string | undefined
    const minionCodeBlocks = msg.metadata?.minionCodeBlocks as string[] | undefined
    const isToUser = !minionTo || minionTo === 'user'

    // For minion messages: render with summary/detail/thinking structure
    if (isMinionParsed) {
      return renderAssistantRow(
        <MinionParsedMessage
          msg={msg}
          thinking={minionThinking}
          summary={minionSummary || ''}
          codeBlocks={minionCodeBlocks || []}
          isToUser={isToUser}
          copiedKey={copiedKey}
          copyCodeBlock={copyCodeBlock}
          markCopied={markCopied}
        />
      )
    }

    return renderAssistantRow(
      <>
        <div className={`message-role-label assistant ${msg.metadata?.modelName ? 'minion-role' : ''}`} style={msg.metadata?.modelName ? { color: getMinionRoleColor(msg.metadata.modelName) } : undefined}>{msg.metadata?.modelName ? msg.metadata.modelName.toUpperCase() : 'ASSISTANT'}{msg.timestamp ? <span className="message-timestamp">{formatMessageTimestamp(msg.timestamp)}</span> : null}</div>
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

// ─── Editable minion message — shows full message with edit/resend capability ──

// Pencil, Send, X imported at top of file

const MinionEditableMessage: React.FC<{
  msg: ChatMessage;
  isSearchMatch?: boolean;
  isActiveSearchMatch?: boolean;
}> = ({ msg, isSearchMatch, isActiveSearchMatch }) => {
  const [editing, setEditing] = React.useState(false);
  const [editText, setEditText] = React.useState('');

  const getOriginalText = () => {
    let text = msg.content || '';
    text = text.replace(/^\*\*\[.*?\]\*\*\s*\n*/, '').trim();
    return text;
  };

  const startEdit = () => {
    setEditText(getOriginalText());
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  const resend = () => {
    if (!editText.trim()) return;
    const minionStore = (window as any).__minionStore;
    const minionRouter = (window as any).__minionRouter;
    if (!minionStore || !minionRouter) return;

    const headerMatch = msg.content?.match(/\[Sent to (\w+)\]/);
    const targetRole = headerMatch ? headerMatch[1].toLowerCase() : null;

    if (targetRole && minionStore.getMinionByRole(targetRole)) {
      minionRouter.sendToSpecialist(targetRole, editText.trim());
    } else if (minionStore.selectedTarget) {
      minionRouter.sendToSpecialist(minionStore.selectedTarget, editText.trim());
    } else {
      minionRouter.routeViaOrchestrator(editText.trim());
    }
    setEditing(false);
  };

  return (
    <div
      className={`message-row-container role-user${isSearchMatch ? " is-search-match" : ""}${isActiveSearchMatch ? " is-search-active" : ""}`}
    >
      <div className="message-role-label user">USER{msg.timestamp ? <span className="message-timestamp">{formatMessageTimestamp(msg.timestamp)}</span> : null}</div>
      <div className="message-user-row">
        {editing ? (
          <div className="minion-edit-resend" onClick={(e) => e.stopPropagation()}>
            <textarea
              className="minion-edit-textarea"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); resend(); }
                if (e.key === 'Escape') cancelEdit();
              }}
              autoFocus
            />
            <div className="minion-edit-actions">
              <button className="minion-edit-send" onClick={resend} title="Resend (Enter)">
                <Send size={12} /> Resend
              </button>
              <button className="minion-edit-cancel" onClick={cancelEdit} title="Cancel (Esc)">
                <X size={12} /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className={`message-text ${msg.role}`}>
              <div className="plain-text">
                {renderMentionContent(msg.content)}
              </div>
            </div>
            <button
              className="message-rollback-btn"
              title="Edit and resend"
              onClick={startEdit}
            >
              <Pencil size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
};

// ─── Parsed minion message — structured summary/detail/thinking rendering ──

const MinionMarkdownContent: React.FC<{
  content: string;
  copiedKey: string | null;
  copyCodeBlock: (code: string) => void;
  markCopied: (key: string) => void;
}> = ({ content, copiedKey, copyCodeBlock }) => (
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
              {copiedKey === feedbackKey ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
        );
      },
      a: ({ node, ...props }) => (
        <a {...props} target="_blank" rel="noopener noreferrer" />
      ),
    }}
  >
    {content}
  </ReactMarkdown>
);

const MinionParsedMessage: React.FC<{
  msg: ChatMessage;
  thinking: string | null;
  summary: string;
  codeBlocks: string[];
  isToUser: boolean;
  copiedKey: string | null;
  copyCodeBlock: (code: string) => void;
  markCopied: (key: string) => void;
}> = ({ msg, thinking, summary, codeBlocks, isToUser, copiedKey, copyCodeBlock, markCopied }) => {
  // Messages to user: detail expanded by default. Messages to models: collapsed.
  const [detailExpanded, setDetailExpanded] = React.useState(isToUser);
  const [thinkingExpanded, setThinkingExpanded] = React.useState(false);
  const [codeExpanded, setCodeExpanded] = React.useState(false);

  const modelName = msg.metadata?.modelName || 'Assistant';
  const roleColor = getMinionRoleColor(modelName);

  // Extract the body content (strip the header line we prepend)
  const bodyContent = (msg.content || '').replace(/^\*\*\[.*?\]\*\*\s*\n*/, '').trim();

  return (
    <>
      {/* Role label + timestamp */}
      <div
        className="message-role-label assistant minion-role"
        style={{ color: roleColor }}
      >
        {modelName.toUpperCase()}
        {thinking && (
          <button
            className={`minion-thinking-toggle ${thinkingExpanded ? 'active' : ''}`}
            style={{ color: roleColor }}
            onClick={(e) => { e.stopPropagation(); setThinkingExpanded(!thinkingExpanded); }}
            title={thinkingExpanded ? 'Hide thinking' : 'Show thinking'}
          >
            <Brain size={12} />
          </button>
        )}
        {codeBlocks.length > 0 && (
          <button
            className={`minion-thinking-toggle ${codeExpanded ? 'active' : ''}`}
            style={{ color: roleColor }}
            onClick={(e) => { e.stopPropagation(); setCodeExpanded(!codeExpanded); }}
            title={codeExpanded ? 'Hide code' : `Show code (${codeBlocks.length} block${codeBlocks.length > 1 ? 's' : ''})`}
          >
            <Code size={12} />
          </button>
        )}
        {msg.timestamp ? <span className="message-timestamp">{formatMessageTimestamp(msg.timestamp)}</span> : null}
      </div>

      {/* Thinking block — expands upward from the message */}
      {thinking && thinkingExpanded && (
        <div className="minion-thinking-block">
          <div className="minion-thinking-header">
            <Brain size={11} />
            <span>Thinking</span>
          </div>
          <div className="minion-thinking-content markdown-body">
            <MinionMarkdownContent
              content={thinking}
              copiedKey={copiedKey}
              copyCodeBlock={copyCodeBlock}
              markCopied={markCopied}
            />
          </div>
        </div>
      )}

      {/* Code blocks — expandable, not read by TTS */}
      {codeBlocks.length > 0 && codeExpanded && (
        <div className="minion-code-blocks">
          <div className="minion-thinking-header" style={{ color: roleColor }}>
            <Code size={11} />
            <span>Code ({codeBlocks.length} block{codeBlocks.length > 1 ? 's' : ''})</span>
          </div>
          {codeBlocks.map((code, i) => (
            <div key={i} className="minion-code-block">
              <div className="markdown-pre-wrap">
                <pre><code>{code}</code></pre>
                <button
                  className="message-copy-btn markdown-pre-copy-btn"
                  title="Copy code"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); copyCodeBlock(code); }}
                >
                  {copiedKey === `code:${code.length}:${code.slice(0, 32)}` ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Summary line (always present, visible when detail is collapsed for model-to-model, hidden label for user messages) */}
      {!isToUser && !detailExpanded && (
        <div className="minion-summary-line">
          <span className="minion-summary-text">{summary}</span>
          <button
            className="minion-detail-toggle"
            onClick={() => setDetailExpanded(true)}
            title="Show full message"
          >
            <ChevronDown size={12} />
            <span>Show detail</span>
          </button>
        </div>
      )}

      {/* Detail body */}
      {detailExpanded && (
        <div className={`message-text ${msg.role}`}>
          <div className="markdown-body">
            <MinionMarkdownContent
              content={bodyContent}
              copiedKey={copiedKey}
              copyCodeBlock={copyCodeBlock}
              markCopied={markCopied}
            />
            {msg.streaming && <span className="cursor-blink" />}
          </div>
          {!isToUser && (
            <button
              className="minion-detail-toggle minion-collapse-toggle"
              onClick={() => setDetailExpanded(false)}
              title="Collapse to summary"
            >
              <ChevronUp size={12} />
              <span>Collapse</span>
            </button>
          )}
        </div>
      )}

      {/* For messages to user: show a small summary badge below (for chat model context, not visually prominent) */}
      {isToUser && detailExpanded && summary && (
        <div className="minion-summary-badge" title="Summary used for chat model context">
          {summary}
        </div>
      )}
    </>
  );
};
