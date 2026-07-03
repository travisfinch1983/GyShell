import React, { useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { observer } from 'mobx-react-lite';
import { X } from 'lucide-react';
import { AppStore } from '../../stores/AppStore';
import {
  createImagePreviewDataUrl,
  extractClipboardImageFiles,
  isRecognizedImageFile,
  type ComposerDraft,
  type ComposerImageAttachment,
  type InputImageAttachment
} from '../../lib/userInput';
import {
  encodeTerminalScopedFilePath,
  getFileMentionDisplayName,
  parseFileSystemPanelDragPayload
} from '../../lib/filesystemDragDrop';
import { matchSlashCommands, type SlashCommand } from './slashCommands';
import './richInput.scss';

type DraftInputImageAttachment = InputImageAttachment & {
  id?: string;
  localFile?: File;
  previewUrl?: string;
}

export interface RichInputHandle {
  focus: () => void;
  getValue: () => string;
  setValue: (val: string) => void;
  getDraft: () => ComposerDraft;
  setDraft: (draft: { text?: string; images?: DraftInputImageAttachment[] }) => void;
  clear: () => void;
}

interface RichInputProps {
  store: AppStore;
  placeholder?: string;
  onSend: (draft: ComposerDraft) => void;
  onInput?: (draft: ComposerDraft) => void;
  disabled?: boolean;
}

export const RichInput = observer(forwardRef<RichInputHandle, RichInputProps>(({ 
  store, 
  placeholder, 
  onSend, 
  onInput,
  disabled 
}, ref) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<{ type: 'skill' | 'terminal' | 'file' | 'paste'; name: string; id?: string; preview?: string }[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [suggestionPos, setSuggestionPos] = useState({ top: 0, left: 0 });
  // Slash-command palette (task #5) — mirrors the mention dropdown, plain text.
  const [slashCmds, setSlashCmds] = useState<SlashCommand[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [imageAttachments, setImageAttachments] = useState<ComposerImageAttachment[]>([]);
  const imageAttachmentsRef = useRef<ComposerImageAttachment[]>([]);
  const pendingMentionDeleteRef = useRef<HTMLElement | null>(null);
  const cursorMarker = '\uFEFF';

  const isBlobPreview = (url: string): boolean => String(url || '').startsWith('blob:');

  const releasePreviewUrl = (url: string) => {
    if (!isBlobPreview(url)) return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore revoke errors
    }
  };

  const normalizeAttachment = (input: DraftInputImageAttachment, fallbackId?: string): ComposerImageAttachment | null => {
    const attachmentId = String(input.attachmentId || '').trim();
    const localFile = (input as any).localFile;
    const hasLocalFile = localFile instanceof File;
    if (!attachmentId && !hasLocalFile) return null;
    const previewUrlInput = String((input as any).previewUrl || '').trim();
    const previewDataUrl = String(input.previewDataUrl || '').trim();
    const previewUrl = previewDataUrl || previewUrlInput || (hasLocalFile ? createPreviewUrlForLocalFile(localFile) : '');
    const fallbackName = hasLocalFile ? String(localFile.name || '').trim() : '';
    return {
      id: String((input as any).id || '').trim() || fallbackId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...(attachmentId ? { attachmentId } : {}),
      fileName: input.fileName || fallbackName || `image-${attachmentId || 'local'}`,
      mimeType: input.mimeType || (hasLocalFile ? localFile.type || undefined : undefined),
      sizeBytes:
        input.sizeBytes
        ?? (hasLocalFile && Number.isFinite(localFile.size) ? localFile.size : undefined),
      sha256: input.sha256,
      ...(previewDataUrl ? { previewDataUrl } : {}),
      status: input.status,
      previewUrl,
      ...(hasLocalFile ? { localFile } : {})
    };
  };

  const createPreviewUrlForLocalFile = (file: File): string => URL.createObjectURL(file);

  const buildDraft = (): ComposerDraft => ({
    text: serialize(),
    images: imageAttachments
  });

  const updateImageAttachments = (updater: (current: ComposerImageAttachment[]) => ComposerImageAttachment[]) => {
    setImageAttachments((current) => {
      const next = updater(current);
      const nextIds = new Set(next.map((item) => item.id));
      current.forEach((item) => {
        if (!nextIds.has(item.id)) {
          releasePreviewUrl(item.previewUrl);
        }
      });
      return next;
    });
  };

  const buildImageFromLocalFile = async (file: File): Promise<ComposerImageAttachment | null> => {
    if (!isRecognizedImageFile(file)) return null;
    let previewDataUrl = '';
    try {
      previewDataUrl = await createImagePreviewDataUrl(file);
    } catch {
      previewDataUrl = '';
    }
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fileName: file.name || 'image',
      mimeType: file.type || undefined,
      sizeBytes: Number.isFinite(file.size) ? file.size : undefined,
      ...(previewDataUrl ? { previewDataUrl } : {}),
      previewUrl: previewDataUrl || createPreviewUrlForLocalFile(file),
      localFile: file
    };
  };

  const getMentionInfo = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    
    if (!range.collapsed) return null;

    const textNode = range.startContainer;
    
    // Case 1: Cursor is in an element node (like the editor div)
    if (textNode.nodeType !== Node.TEXT_NODE) {
      const siblingBefore = textNode.childNodes[range.startOffset - 1];
      if (siblingBefore instanceof HTMLElement && siblingBefore.classList.contains('mention-tag')) {
        return { query: siblingBefore.dataset.name || '', index: 0, isReSelect: true, targetTag: siblingBefore };
      }
      return null;
    }

    // Case 2: Cursor is in a text node
    const textBefore = textNode.textContent?.slice(0, range.startOffset) || '';
    
    // Check if we are at the beginning of a text node that follows a tag
    const siblingBefore = textNode.previousSibling;
    if (range.startOffset === 0 && siblingBefore instanceof HTMLElement && siblingBefore.classList.contains('mention-tag')) {
      return { query: siblingBefore.dataset.name || '', index: 0, isReSelect: true, targetTag: siblingBefore };
    }

    // If cursor is after one or more marker chars right after a mention tag, still treat as re-select.
    if (
      siblingBefore instanceof HTMLElement &&
      siblingBefore.classList.contains('mention-tag') &&
      textBefore.length > 0 &&
      new RegExp(`^${cursorMarker}+$`).test(textBefore)
    ) {
      return { query: siblingBefore.dataset.name || '', index: 0, isReSelect: true, targetTag: siblingBefore };
    }

    const lastAtIdx = textBefore.lastIndexOf('@');
    if (lastAtIdx === -1) return null;
    
    return { query: textBefore.slice(lastAtIdx + 1), index: lastAtIdx };
  };

  const updateSuggestions = useCallback(() => {
    const info = getMentionInfo();
    if (!info) {
      setShowSuggestions(false);
      return;
    }

    const query = info.query.toLowerCase();
    
    // Only show enabled skills
    const enabledSkills = store.skills.filter(s => store.settings?.tools?.skills?.[s.name] !== false);
    const skills = enabledSkills.map(s => ({ type: 'skill' as const, name: s.name }));
    const tabs = store.terminalTabs.map(t => ({ type: 'terminal' as const, name: t.title, id: t.id }));
    
    const filtered = [...skills, ...tabs]
      .filter(item => item.name.toLowerCase().includes(query))
      .sort((a, b) => {
        const aLower = a.name.toLowerCase();
        const bLower = b.name.toLowerCase();
        if (aLower === query && bLower !== query) return -1;
        if (bLower === query && aLower !== query) return 1;
        const aStarts = aLower.startsWith(query);
        const bStarts = bLower.startsWith(query);
        if (aStarts && !bStarts) return -1;
        if (bStarts && !aStarts) return 1;
        if (a.name.length !== b.name.length) return a.name.length - b.name.length;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 10);

    if (filtered.length > 0) {
      setSuggestions(filtered);
      setSelectedIndex(0);
      setShowSuggestions(true);
      
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0).cloneRange();
        const rects = range.getClientRects();
        if (rects.length > 0) {
          const rect = rects[0];
          setSuggestionPos({ top: rect.top - 8, left: rect.left });
        }
      }
    } else {
      setShowSuggestions(false);
    }
  }, [store.skills, store.terminalTabs]);

  const buildMentionHtml = (
    item: { type: 'skill' | 'terminal' | 'file' | 'paste'; name: string; id?: string; preview?: string },
    uid: string
  ): string => {
    const fileName = getFileMentionDisplayName(item.name) || item.name;
    const displayText = item.type === 'file' ? (item.preview || fileName) : (item.type === 'paste' ? (item.preview || '') : `@${item.name}`);
    return `<span class="mention-tag" contenteditable="false" data-insert-id="${uid}" data-type="${item.type}" data-name="${item.name}" ${item.id ? `data-id="${item.id}"` : ''} ${item.preview ? `data-preview="${item.preview}"` : ''}>${displayText}</span>${cursorMarker}`;
  };

  const setSelectionRange = (range: Range) => {
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const placeCaretAfterInsertedTag = (tag: HTMLElement) => {
    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    const nextSibling = tag.nextSibling;
    if (nextSibling?.nodeType === Node.TEXT_NODE) {
      const textNode = nextSibling as Text;
      const text = textNode.textContent || '';
      let markerLen = 0;
      while (markerLen < text.length && text[markerLen] === cursorMarker) markerLen++;
      range.setStart(textNode, markerLen);
    } else {
      range.setStartAfter(tag);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const insertMention = (item: { type: 'skill' | 'terminal' | 'file' | 'paste'; name: string; id?: string; preview?: string }) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    
    const info = getMentionInfo() as any;
    const replacementRange = document.createRange();

    // 1. Handle the re-select case where we have a direct targetTag
    if (info?.isReSelect && info.targetTag) {
      replacementRange.setStartBefore(info.targetTag);
      const nextSibling = info.targetTag.nextSibling;
      if (nextSibling?.nodeType === Node.TEXT_NODE) {
        const nextText = (nextSibling as Text).textContent || '';
        const markerMatch = nextText.match(/^\uFEFF+/);
        if (markerMatch && markerMatch[0].length > 0) {
          replacementRange.setEnd(nextSibling, markerMatch[0].length);
        } else {
          replacementRange.setEndAfter(info.targetTag);
        }
      } else {
        replacementRange.setEndAfter(info.targetTag);
      }
    } else if (info && !info.isReSelect) {
      // 2. Standard insertion case (triggered by '@')
      const textNode = range.startContainer;
      if (textNode.nodeType !== Node.TEXT_NODE) return;
      replacementRange.setStart(textNode, info.index);
      replacementRange.setEnd(textNode, range.startOffset);
    } else {
      // 3. Fallback for file drops or pastes (no '@' context)
      replacementRange.setStart(range.startContainer, range.startOffset);
      replacementRange.setEnd(range.startContainer, range.startOffset);
      if (editorRef.current && !editorRef.current.contains(range.commonAncestorContainer)) {
        replacementRange.selectNodeContents(editorRef.current);
        replacementRange.collapse(false);
      }
    }

    setSelectionRange(replacementRange);
    const insertId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const html = buildMentionHtml(item, insertId);
    document.execCommand('insertHTML', false, html);
    const insertedTag = editorRef.current?.querySelector(`.mention-tag[data-insert-id="${insertId}"]`) as HTMLElement | null;
    if (insertedTag) {
      insertedTag.removeAttribute('data-insert-id');
      placeCaretAfterInsertedTag(insertedTag);
    }

    editorRef.current?.focus();
    pendingMentionDeleteRef.current = null;
    setShowSuggestions(false);
  };

  const serialize = (): string => {
    if (!editorRef.current) return '';
    let result = '';
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent?.replace(/\u00A0/g, ' ').replace(/\uFEFF/g, '') || '';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (el.classList.contains('mention-tag')) {
          const type = el.dataset.type;
          const name = el.dataset.name;
          const id = el.dataset.id;
          if (type === 'skill') {
            result += `[MENTION_SKILL:#${name}#]`;
          } else if (type === 'terminal') {
            result += `[MENTION_TAB:#${name}##${id}#]`;
          } else if (type === 'file') {
            result += `[MENTION_FILE:#${name}#]`;
          } else if (type === 'paste') {
            const preview = el.dataset.preview || '';
            result += `[MENTION_USER_PASTE:#${name}##${preview}#]`;
          }
        } else if (el.tagName === 'BR') {
          result += '\n';
        } else {
          for (let i = 0; i < el.childNodes.length; i++) {
            walk(el.childNodes[i]);
          }
          if (window.getComputedStyle(el).display === 'block') {
            result += '\n';
          }
        }
      }
    };
    for (let i = 0; i < editorRef.current.childNodes.length; i++) {
      walk(editorRef.current.childNodes[i]);
    }
    return result.trim();
  };

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    getValue: () => serialize(),
    setValue: (val: string) => {
      if (editorRef.current) {
        // Parser for [MENTION_XXX:#...#] labels to restore them as rich DOM nodes
        const parts = val.split(/(\[MENTION_(?:SKILL|TAB|FILE|IMAGE|USER_PASTE):#.+?#(?:#.+?#)?\])/g);
        editorRef.current.innerHTML = '';
        
        parts.forEach(part => {
          const skillMatch = part.match(/\[MENTION_SKILL:#(.+?)#\]/);
          const terminalMatch = part.match(/\[MENTION_TAB:#(.+?)##(.+?)#\]/);
          
          if (skillMatch) {
            const span = document.createElement('span');
            span.className = 'mention-tag';
            span.contentEditable = 'false';
            span.dataset.type = 'skill';
            span.dataset.name = skillMatch[1];
            span.textContent = `@${skillMatch[1]}`;
            editorRef.current?.appendChild(span);
          } else if (terminalMatch) {
            const span = document.createElement('span');
            span.className = 'mention-tag';
            span.contentEditable = 'false';
            span.dataset.type = 'terminal';
            span.dataset.name = terminalMatch[1];
            span.dataset.id = terminalMatch[2];
            span.textContent = `@${terminalMatch[1]}`;
            editorRef.current?.appendChild(span);
          } else if (part.match(/\[MENTION_FILE:#(.+?)#\]/)) {
            const fileMatch = part.match(/\[MENTION_FILE:#(.+?)#\]/);
            if (fileMatch) {
              const span = document.createElement('span');
              span.className = 'mention-tag';
              span.contentEditable = 'false';
              span.dataset.type = 'file';
              span.dataset.name = fileMatch[1];
              // Extract only the file/folder name for display
              const fileName = getFileMentionDisplayName(fileMatch[1]) || fileMatch[1];
              span.textContent = fileName;
              editorRef.current?.appendChild(span);
            }
          } else if (part.match(/\[MENTION_IMAGE:#(.+?)(?:##(.+?))?#\]/)) {
            const imageMatch = part.match(/\[MENTION_IMAGE:#(.+?)(?:##(.+?))?#\]/);
            if (imageMatch) {
              const span = document.createElement('span');
              span.className = 'mention-tag';
              span.contentEditable = 'false';
              span.dataset.type = 'file';
              span.dataset.name = imageMatch[1];
              const imageName = imageMatch[2] || getFileMentionDisplayName(imageMatch[1]) || imageMatch[1];
              span.textContent = imageName;
              editorRef.current?.appendChild(span);
            }
          } else if (part.match(/\[MENTION_USER_PASTE:#(.+?)##(.+?)#\]/)) {
            const pasteMatch = part.match(/\[MENTION_USER_PASTE:#(.+?)##(.+?)#\]/);
            if (pasteMatch) {
              const span = document.createElement('span');
              span.className = 'mention-tag';
              span.contentEditable = 'false';
              span.dataset.type = 'paste';
              span.dataset.name = pasteMatch[1];
              span.dataset.preview = pasteMatch[2];
              span.textContent = pasteMatch[2];
              editorRef.current?.appendChild(span);
            }
          } else if (part) {
            editorRef.current?.appendChild(document.createTextNode(part.replace(/\u00A0/g, ' ').replace(/\uFEFF/g, '')));
          }
        });
      }
      updateImageAttachments(() => []);
    },
    getDraft: () => buildDraft(),
    setDraft: (draft: { text?: string; images?: DraftInputImageAttachment[] }) => {
      const nextText = typeof draft?.text === 'string' ? draft.text : '';
      const nextImages = Array.isArray(draft?.images) ? draft.images : [];
      if (editorRef.current) {
        // Reuse token parser to restore text mentions.
        const parts = nextText.split(/(\[MENTION_(?:SKILL|TAB|FILE|IMAGE|USER_PASTE):#.+?#(?:#.+?#)?\])/g);
        editorRef.current.innerHTML = '';
        parts.forEach(part => {
          const skillMatch = part.match(/\[MENTION_SKILL:#(.+?)#\]/);
          const terminalMatch = part.match(/\[MENTION_TAB:#(.+?)##(.+?)#\]/);
          if (skillMatch) {
            const span = document.createElement('span');
            span.className = 'mention-tag';
            span.contentEditable = 'false';
            span.dataset.type = 'skill';
            span.dataset.name = skillMatch[1];
            span.textContent = `@${skillMatch[1]}`;
            editorRef.current?.appendChild(span);
          } else if (terminalMatch) {
            const span = document.createElement('span');
            span.className = 'mention-tag';
            span.contentEditable = 'false';
            span.dataset.type = 'terminal';
            span.dataset.name = terminalMatch[1];
            span.dataset.id = terminalMatch[2];
            span.textContent = `@${terminalMatch[1]}`;
            editorRef.current?.appendChild(span);
          } else if (part.match(/\[MENTION_FILE:#(.+?)#\]/)) {
            const fileMatch = part.match(/\[MENTION_FILE:#(.+?)#\]/);
            if (fileMatch) {
              const span = document.createElement('span');
              span.className = 'mention-tag';
              span.contentEditable = 'false';
              span.dataset.type = 'file';
              span.dataset.name = fileMatch[1];
              const fileName = getFileMentionDisplayName(fileMatch[1]) || fileMatch[1];
              span.textContent = fileName;
              editorRef.current?.appendChild(span);
            }
          } else if (part.match(/\[MENTION_IMAGE:#(.+?)(?:##(.+?))?#\]/)) {
            const imageMatch = part.match(/\[MENTION_IMAGE:#(.+?)(?:##(.+?))?#\]/);
            if (imageMatch) {
              const span = document.createElement('span');
              span.className = 'mention-tag';
              span.contentEditable = 'false';
              span.dataset.type = 'file';
              span.dataset.name = imageMatch[1];
              const imageName = imageMatch[2] || getFileMentionDisplayName(imageMatch[1]) || imageMatch[1];
              span.textContent = imageName;
              editorRef.current?.appendChild(span);
            }
          } else if (part.match(/\[MENTION_USER_PASTE:#(.+?)##(.+?)#\]/)) {
            const pasteMatch = part.match(/\[MENTION_USER_PASTE:#(.+?)##(.+?)#\]/);
            if (pasteMatch) {
              const span = document.createElement('span');
              span.className = 'mention-tag';
              span.contentEditable = 'false';
              span.dataset.type = 'paste';
              span.dataset.name = pasteMatch[1];
              span.dataset.preview = pasteMatch[2];
              span.textContent = pasteMatch[2];
              editorRef.current?.appendChild(span);
            }
          } else if (part) {
            editorRef.current?.appendChild(document.createTextNode(part.replace(/\u00A0/g, ' ').replace(/\uFEFF/g, '')));
          }
        });
      }
      updateImageAttachments(() => {
        const mapped = nextImages
          .map((item, index) => normalizeAttachment(item, `rollback-${Date.now()}-${index}`))
          .filter((item): item is ComposerImageAttachment => item !== null);
        return mapped;
      });
    },
    clear: () => {
      if (editorRef.current) editorRef.current.innerHTML = '';
      updateImageAttachments(() => []);
    }
  }));

  const removeReselectedMentionTag = (targetTag: HTMLElement) => {
    const range = document.createRange();
    range.setStartBefore(targetTag);
    const nextSibling = targetTag.nextSibling;
    if (nextSibling?.nodeType === Node.TEXT_NODE) {
      const nextText = (nextSibling as Text).textContent || '';
      const markerMatch = nextText.match(/^\uFEFF+/);
      if (markerMatch && markerMatch[0].length > 0) {
        range.setEnd(nextSibling, markerMatch[0].length);
      } else {
        range.setEndAfter(targetTag);
      }
    } else {
      range.setEndAfter(targetTag);
    }
    setSelectionRange(range);
    document.execCommand('delete');
  };

  const completeSlash = (cmd?: SlashCommand) => {
    if (!cmd || !editorRef.current) return;
    const el = editorRef.current;
    el.textContent = `/${cmd.name} `;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    setSelectionRange(range);
    setSlashCmds(cmd.argHint ? [] : matchSlashCommands(`/${cmd.name}`));
    setSlashIndex(0);
    onInput?.(buildDraft());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Backspace') {
      const info = getMentionInfo() as any;
      if (info?.isReSelect && info.targetTag instanceof HTMLElement) {
        e.preventDefault();
        if (pendingMentionDeleteRef.current === info.targetTag) {
          removeReselectedMentionTag(info.targetTag);
          pendingMentionDeleteRef.current = null;
          setShowSuggestions(false);
          onInput?.(buildDraft());
        } else {
          pendingMentionDeleteRef.current = info.targetTag;
          updateSuggestions();
        }
        return;
      }
      pendingMentionDeleteRef.current = null;
    }

    if (slashCmds.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => (i + 1) % slashCmds.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => (i - 1 + slashCmds.length) % slashCmds.length); return; }
      if (e.key === 'Tab' || e.key === 'Enter') {
        const cmd = slashCmds[slashIndex];
        // Enter on an EXACT no-arg command falls through to send; otherwise complete.
        const exact = cmd && buildDraft().text.trim() === `/${cmd.name}`;
        if (!(e.key === 'Enter' && exact && !cmd.argHint)) {
          e.preventDefault();
          completeSlash(cmd);
          return;
        }
        setSlashCmds([]);
      }
      if (e.key === 'Escape') { e.preventDefault(); setSlashCmds([]); return; }
    }

    if (showSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(suggestions[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        pendingMentionDeleteRef.current = null;
        setShowSuggestions(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const draft = buildDraft();
      if (draft.text.trim() || draft.images.length > 0) {
        onSend(draft);
      }
    }
  };

  const handleInput = () => {
    pendingMentionDeleteRef.current = null;
    updateSuggestions();
    const draft = buildDraft();
    setSlashCmds(matchSlashCommands(draft.text));
    setSlashIndex(0);
    onInput?.(draft);
  };

  // Close suggestions when disabled or when overlay opens
  React.useEffect(() => {
    if (disabled || store.view !== 'main') {
      setShowSuggestions(false);
      setSlashCmds([]);
    }
  }, [disabled, store.view]);

  React.useEffect(() => {
    imageAttachmentsRef.current = imageAttachments;
    onInput?.(buildDraft());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageAttachments]);

  const attachLocalImages = async (files: File[]): Promise<void> => {
    if (!Array.isArray(files) || files.length === 0) return;
    const created: ComposerImageAttachment[] = [];
    for (const file of files) {
      try {
        const attachment = await buildImageFromLocalFile(file);
        if (attachment) created.push(attachment);
      } catch (err) {
        console.error('[RichInput] Failed to attach image:', err);
      }
    }

    if (created.length === 0) return;
    updateImageAttachments((current) => [...current, ...created]);
  };

  const decodeBase64ToFile = (contentBase64: string, fileName: string, mimeType?: string): File => {
    const cleaned = String(contentBase64 || '').replace(/^data:[^,]+,/, '');
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const resolvedType = String(mimeType || '').trim() || 'application/octet-stream';
    return new File([bytes], fileName || 'attachment', { type: resolvedType, lastModified: Date.now() });
  };

  const handleFileSystemPanelDrop = async (
    payload: ReturnType<typeof parseFileSystemPanelDragPayload>
  ): Promise<void> => {
    if (!payload) return;
    const sourceTerminal = store.terminalTabs.find((tab) => tab.id === payload.sourceTerminalId) || null;
    const isLocalSourceTerminal = sourceTerminal?.config?.type === 'local';
    const createdImages: ComposerImageAttachment[] = [];
    for (const entry of payload.entries) {
      if (!entry) continue;
      const isImageEntry = !entry.isDirectory
        && isRecognizedImageFile({ name: entry.name, type: '' } as Pick<File, 'name' | 'type'>);
      // Remote filesystem drops (e.g., SFTP) should never fetch image bytes here.
      // They are represented as regular file mentions to avoid slow remote download on drop.
      if (isImageEntry && isLocalSourceTerminal) {
        try {
          const read = await window.gyshell.filesystem.readFileBase64(payload.sourceTerminalId, entry.path);
          const file = decodeBase64ToFile(read.contentBase64, entry.name || read.path, read.mimeType);
          const image = await buildImageFromLocalFile(file);
          if (image) {
            createdImages.push(image);
          }
        } catch (error) {
          console.error('[RichInput] Failed to attach dropped filesystem image:', error);
        }
        continue;
      }
      const mentionPath = encodeTerminalScopedFilePath(payload.sourceTerminalId, entry.path);
      insertMention({
        type: 'file',
        name: mentionPath,
        preview: entry.name || getFileMentionDisplayName(entry.path)
      });
    }
    if (createdImages.length > 0) {
      updateImageAttachments((current) => [...current, ...createdImages]);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const imageFiles = extractClipboardImageFiles(e.clipboardData);
    if (imageFiles.length > 0) {
      e.preventDefault();
      void attachLocalImages(imageFiles);
      return;
    }

    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    
    if (text.length > 500) {
      try {
        console.log('[RichInput] Large paste detected, saving to temp file...');
        const tempPath = await (window as any).gyshell.system.saveTempPaste(text);
        console.log('[RichInput] Temp file saved at:', tempPath);
        const preview = text.slice(0, 10).replace(/\n/g, ' ') + '...';
        
        // Use a small timeout to ensure the paste event finishes and editor is ready for DOM manipulation
        setTimeout(() => {
          insertMention({ type: 'paste', name: tempPath, preview });
        }, 0);
      } catch (err) {
        console.error('[RichInput] Failed to save large paste:', err);
        document.execCommand('insertText', false, text);
      }
    } else {
      document.execCommand('insertText', false, text);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const filesystemPayload = parseFileSystemPanelDragPayload(e.dataTransfer);
    if (filesystemPayload) {
      void handleFileSystemPanelDrop(filesystemPayload);
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const imageCandidates = files.filter((file) => isRecognizedImageFile(file));
      if (imageCandidates.length > 0) {
        void attachLocalImages(imageCandidates);
      }
      const localTerminalId = store.getPreferredLocalTerminalId();
      files.forEach(f => {
        const path = (f as any).path;
        if (path && !isRecognizedImageFile(f)) {
          const mentionPath = localTerminalId
            ? encodeTerminalScopedFilePath(localTerminalId, path)
            : path;
          insertMention({
            type: 'file',
            name: mentionPath,
            preview: getFileMentionDisplayName(path)
          });
        }
      });
    }
  };

  React.useEffect(() => {
    return () => {
      imageAttachmentsRef.current.forEach((item) => releasePreviewUrl(item.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rich-input-wrapper">
      {imageAttachments.length > 0 && (
        <div className="rich-input-image-strip">
          <button
            type="button"
            className="rich-input-image-clear-all"
            onClick={() => {
              updateImageAttachments(() => []);
            }}
            aria-label="Remove all images"
            title="Remove all images"
          >
            <X size={18} strokeWidth={2.5} />
          </button>
          {imageAttachments.map((image) => (
            <div key={image.id} className="rich-input-image-chip">
              <button
                type="button"
                className="rich-input-image-remove"
                onClick={() => {
                  updateImageAttachments((current) => current.filter((item) => item.id !== image.id));
                }}
                aria-label="Remove image"
                title="Remove image"
              >
                <X size={13} strokeWidth={2.7} />
              </button>
              {image.previewUrl ? (
                <img src={image.previewUrl} alt="Attached image" />
              ) : (
                <div className="rich-input-image-missing">IMG</div>
              )}
            </div>
          ))}
        </div>
      )}
      <div
        ref={editorRef}
        className={`rich-input-editor ${disabled ? 'disabled' : ''}`}
        contentEditable={!disabled}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={e => e.preventDefault()}
        data-placeholder={placeholder}
      />
      
      {slashCmds.length > 0 && createPortal(
        <div
          className="mention-suggestions slash-palette"
          style={{
            position: 'fixed',
            top: (editorRef.current?.getBoundingClientRect().top ?? 0) - 6,
            left: (editorRef.current?.getBoundingClientRect().left ?? 0) + 8,
            transform: 'translateY(-100%)',
            zIndex: 10000
          }}
        >
          {slashCmds.map((cmd, i) => (
            <div
              key={cmd.name}
              className={`suggestion-item ${i === slashIndex ? 'active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); completeSlash(cmd); }}
            >
              <div className="item-content">
                <span className="item-name slash-name">/{cmd.name}{cmd.argHint ? ` <${cmd.argHint}>` : ''}</span>
                <span className="slash-desc">{cmd.description}</span>
              </div>
            </div>
          ))}
        </div>,
        document.body
      )}

      {showSuggestions && createPortal(
        <div 
          className="mention-suggestions"
          style={{ 
            position: 'fixed',
            top: suggestionPos.top,
            left: suggestionPos.left,
            transform: 'translateY(-100%)',
            zIndex: 10000
          }}
        >
          {suggestions.map((item, i) => (
            <div
              key={`${item.type}-${item.name}-${i}`}
              className={`suggestion-item ${i === selectedIndex ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(item);
              }}
            >
              <div className="item-content">
                <span className={`item-type ${item.type}`}>{item.type === 'skill' ? 'Skill' : 'Tab'}</span>
                <span className="item-name">{item.name}</span>
              </div>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}));
