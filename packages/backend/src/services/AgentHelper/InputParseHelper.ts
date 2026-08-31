import fs from 'fs/promises';
import type { ISkillRuntime } from '../runtimeContracts';
import { TerminalService } from '../TerminalService';
import { USEFUL_SKILL_TAG, USER_INPUT_TAGS, FILE_CONTENT_TAG, TERMINAL_CONTENT_TAG } from './prompts';
import { detectFileKind, readImageFile } from './tools/read_tools';
import type { InputImageAttachment, UserInputPayload } from '../../types';
import { ImageAttachmentService } from '../ImageAttachmentService';
import { parseTerminalScopedFilePath } from './terminalScopedFilePath';

/**
 * Helper to parse user input for special labels like skills, terminal tabs, and pastes.
 * It enriches the message content for the AI by fetching referenced data.
 */
export class InputParseHelper {
  static readonly DEFAULT_USER_INPUT_TAG = USER_INPUT_TAGS[0];
  private static readonly MAX_MODEL_IMAGE_BYTES = 8 * 1024 * 1024;
  /**
   * Regex to match skill labels: [MENTION_SKILL:#name#]
   */
  private static SKILL_REGEX = /\[MENTION_SKILL:#(.+?)#\]/g;

  /**
   * Regex to match terminal tab labels: [MENTION_TAB:#name##id#]
   */
  private static TAB_REGEX = /\[MENTION_TAB:#(.+?)##(.+?)#\]/g;

  /**
   * Regex to match user paste labels: [MENTION_USER_PASTE:#path##preview#]
   */
  private static PASTE_REGEX = /\[MENTION_USER_PASTE:#(.+?)##(.+?)#\]/g;

  /**
   * Regex to match mentioned files: [MENTION_FILE:#path#] or [MENTION_FILE:#path##name#]
   */
  private static FILE_REGEX = /\[MENTION_FILE:#(.+?)(?:##.+?)?#\]/g;

  /**
   * Parses the input, fetches skill contents and large pastes, and returns enriched 
   * content for AI and display content for the UI.
   */
  static async parseAndEnrich(
    input: string | UserInputPayload,
    skillService: ISkillRuntime,
    terminalService: TerminalService,
    options?: {
      userInputTag?: string
      includeContextDetails?: boolean
      userInputInstruction?: string
      keepTaggedBodyLiteral?: boolean
      modelSupportsImage?: boolean
      maxImageAttachments?: number
      imageAttachmentService?: ImageAttachmentService
    }
  ): Promise<{
    enrichedContent: string
    displayContent: string
    inputImages: InputImageAttachment[]
    modelImages: Array<{ mimeType: string; dataUrl: string }>
  }> {
    const normalized = this.normalizeInputPayload(input);
    const userInputTag = options?.userInputTag || USER_INPUT_TAGS[0];
    const includeContextDetails = options?.includeContextDetails !== false;
    const modelSupportsImage = options?.modelSupportsImage === true;
    const maxImageAttachments =
      Number.isInteger(options?.maxImageAttachments) && Number(options?.maxImageAttachments) >= 0
        ? Number(options?.maxImageAttachments)
        : Number.POSITIVE_INFINITY;

    // 1. Fetch Skill Details
    let skillDetails = '';
    if (includeContextDetails) {
      const skillMatches = Array.from(normalized.text.matchAll(this.SKILL_REGEX));
      const skillNames = Array.from(new Set(skillMatches.map(m => m[1])));
      for (const name of skillNames) {
        try {
          const { info, content } = await skillService.readSkillContentByName(name);
          skillDetails += `${USEFUL_SKILL_TAG}Skill Name: ${name}\nSkill Path: ${info.filePath}\nContent:\n${content}\n\n`;
        } catch (err) {
          console.warn(`[InputParseHelper] Failed to fetch skill: ${name}`, err);
        }
      }
    }
    this.SKILL_REGEX.lastIndex = 0; // Reset regex state

    // 2. Fetch Terminal Tab Details
    let tabDetails = '';
    if (includeContextDetails) {
      const tabMatches = Array.from(normalized.text.matchAll(this.TAB_REGEX));
      const tabIds = Array.from(new Set(tabMatches.map(m => m[2])));
      for (const id of tabIds) {
        try {
          const tab = terminalService.getAllTerminals().find(t => t.id === id);
          if (tab) {
            const recentOutput = terminalService.getRecentOutput(id);
            tabDetails += `${TERMINAL_CONTENT_TAG}Terminal Tab: ${tab.title} (ID: ${id})
<terminal_content>
${recentOutput}
</terminal_content>\n\n`;
          }
        } catch (err) {
          console.warn(`[InputParseHelper] Failed to fetch terminal output: ${id}`, err);
        }
      }
    }
    this.TAB_REGEX.lastIndex = 0; // Reset regex state

    // 3. Fetch Large Paste & Mentioned File Details
    let fileDetails = '';
    if (includeContextDetails) {
      const referencedFiles: Array<{ terminalId: string | null; filePath: string }> = [];
      const pushUniqueReference = (terminalId: string | null, filePath: string): void => {
        const normalizedTerminalId = terminalId ? terminalId.trim() : null;
        const normalizedPath = String(filePath || '').trim();
        if (!normalizedPath) return;
        const key = normalizedTerminalId ? `${normalizedTerminalId}::${normalizedPath}` : normalizedPath;
        if (seenReferences.has(key)) return;
        seenReferences.add(key);
        referencedFiles.push({
          terminalId: normalizedTerminalId,
          filePath: normalizedPath
        });
      };
      const seenReferences = new Set<string>();

      const pasteMatches = Array.from(normalized.text.matchAll(this.PASTE_REGEX));
      pasteMatches.forEach((match) => {
        pushUniqueReference(null, match[1]);
      });

      const fileMatches = Array.from(normalized.text.matchAll(this.FILE_REGEX));
      fileMatches.forEach((match) => {
        const resolved = parseTerminalScopedFilePath(match[1]);
        if (resolved) {
          pushUniqueReference(resolved.terminalId, resolved.filePath);
          return;
        }
        pushUniqueReference(null, match[1]);
      });

      for (const reference of referencedFiles) {
        const fileContent = reference.terminalId
          ? await this.readSmallTextFileViaTerminal(terminalService, reference.terminalId, reference.filePath)
          : await this.readSmallTextFileViaLocalPath(reference.filePath);
        if (typeof fileContent !== 'string') {
          continue;
        }
        fileDetails += `${FILE_CONTENT_TAG}<${reference.filePath}>\n${fileContent}\n\n`;
      }
    }
    this.PASTE_REGEX.lastIndex = 0; // Reset regex state
    this.FILE_REGEX.lastIndex = 0; // Reset regex state

    const preparedImages = await this.prepareImagesForInput(normalized.images, {
      modelSupportsImage,
      maxImageAttachments,
      imageAttachmentService: options?.imageAttachmentService
    });

    const normalizedInstruction = String(options?.userInputInstruction || '').trim();
    const keepTaggedBodyLiteral = options?.keepTaggedBodyLiteral === true;
    const taggedInputLiteral = `"${userInputTag}${normalized.text}`;
    const userBody = normalizedInstruction
      ? keepTaggedBodyLiteral
        ? `${normalizedInstruction}\n${taggedInputLiteral}`
        : `${normalizedInstruction}\n${normalized.text}`
      : normalized.text;

    // enrichedContent structure: [Skill Details] + [Tab Details] + [File Details] + [User Body]
    // For inserted mode with keepTaggedBodyLiteral=true, userBody already contains the tagged block.
    let prefix = skillDetails + tabDetails + fileDetails;
    const decoratedBody = keepTaggedBodyLiteral ? userBody : `${userInputTag}${userBody}`;
    const imageNames = preparedImages.inputImages.map((item) => item.fileName || item.attachmentId || 'image');
    const missingNames = preparedImages.inputImages
      .filter((item) => item.status === 'missing')
      .map((item) => item.fileName || item.attachmentId || 'image');
    const nonInjectedNote =
      preparedImages.inputImages.length > 0 && preparedImages.modelImages.length === 0
        ? `\n\nAttached images (not injected as model image inputs): ${imageNames.join(', ')}`
        : '';
    const missingNote =
      missingNames.length > 0
        ? `\n\nMissing image attachments (kept as references only): ${missingNames.join(', ')}`
        : '';
    const imageFallbackNote = `${nonInjectedNote}${missingNote}`;
    const enrichedContent = `${prefix}${decoratedBody}${imageFallbackNote}`;

    return {
      enrichedContent,
      displayContent: normalized.text,
      inputImages: preparedImages.inputImages,
      modelImages: preparedImages.modelImages
    };
  }

  private static async readSmallTextFileViaLocalPath(filePath: string): Promise<string | null> {
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile() || stats.size >= 4000) {
        return null;
      }
      const buffer = await fs.readFile(filePath);
      const kind = detectFileKind(filePath, new Uint8Array(buffer));
      if (kind !== 'text') {
        return null;
      }
      return buffer.toString('utf-8');
    } catch (err) {
      console.warn(`[InputParseHelper] Failed to read local file: ${filePath}`, err);
      return null;
    }
  }

  private static async readSmallTextFileViaTerminal(
    terminalService: TerminalService,
    terminalId: string,
    filePath: string
  ): Promise<string | null> {
    try {
      const stat = await terminalService.statFile(terminalId, filePath);
      if (!stat.exists || stat.isDirectory || (typeof stat.size === 'number' && stat.size >= 4000)) {
        return null;
      }
      const buffer = await terminalService.readFile(terminalId, filePath);
      if (buffer.length >= 4000) {
        return null;
      }
      const kind = detectFileKind(filePath, new Uint8Array(buffer));
      if (kind !== 'text') {
        return null;
      }
      return buffer.toString('utf-8');
    } catch (err) {
      console.warn(
        `[InputParseHelper] Failed to read terminal-scoped file: terminal=${terminalId} path=${filePath}`,
        err
      );
      return null;
    }
  }

  private static normalizeInputPayload(input: string | UserInputPayload): {
    text: string
    images: InputImageAttachment[]
  } {
    if (typeof input === 'string') {
      return {
        text: input,
        images: []
      };
    }

    if (!input || typeof input !== 'object') {
      return {
        text: '',
        images: []
      };
    }

    const text = typeof input.text === 'string' ? input.text : '';
    const images = Array.isArray(input.images)
      ? input.images
          .map((item) => this.sanitizeImageAttachment(item))
          .filter((item): item is InputImageAttachment => item !== null)
      : [];
    return { text, images };
  }

  private static sanitizeImageAttachment(raw: unknown): InputImageAttachment | null {
    if (!raw || typeof raw !== 'object') return null;
    const input = raw as Record<string, unknown>;
    const attachmentId = typeof input.attachmentId === 'string' ? input.attachmentId.trim() : '';
    if (!attachmentId) return null;
    const fileName = typeof input.fileName === 'string' ? input.fileName.trim() : '';
    const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim() : '';
    const sizeBytes = Number.isFinite(input.sizeBytes as number) ? Number(input.sizeBytes) : undefined;
    const sha256 = typeof input.sha256 === 'string' ? input.sha256.trim() : '';
    const previewDataUrl = typeof input.previewDataUrl === 'string' ? input.previewDataUrl.trim() : '';
    const status = input.status === 'ready' || input.status === 'missing' ? input.status : undefined;
    return {
      ...(attachmentId ? { attachmentId } : {}),
      ...(fileName ? { fileName } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(typeof sizeBytes === 'number' && sizeBytes >= 0 ? { sizeBytes } : {}),
      ...(sha256 ? { sha256 } : {}),
      ...(previewDataUrl ? { previewDataUrl } : {}),
      ...(status ? { status } : {})
    };
  }

  private static async prepareImagesForInput(
    images: InputImageAttachment[],
    options: {
      modelSupportsImage: boolean
      maxImageAttachments: number
      imageAttachmentService?: ImageAttachmentService
    }
  ): Promise<{
    inputImages: InputImageAttachment[]
    modelImages: Array<{ mimeType: string; dataUrl: string }>
  }> {
    const inputImages: InputImageAttachment[] = [];
    const modelImages: Array<{ mimeType: string; dataUrl: string }> = [];
    for (const candidate of images.slice(0, options.maxImageAttachments)) {
      const resolved = await this.resolveImageCandidate(candidate, options.imageAttachmentService);
      if (!resolved) continue;
      const { normalizedAttachment, bytes } = resolved;
      if (normalizedAttachment.status === 'missing') {
        inputImages.push({
          ...normalizedAttachment,
          status: 'missing'
        });
        continue;
      }
      const imageHint = normalizedAttachment.fileName || normalizedAttachment.attachmentId || 'image';
      try {
        const kind = detectFileKind(imageHint, new Uint8Array(bytes));
        if (kind !== 'image') {
          // The user SEES an attachment; the model never gets it; nothing said
          // so anywhere — a dropped input with no witness. One line per drop.
          console.warn(`[InputParseHelper] attachment '${imageHint}' dropped — sniffed as '${kind}', not an image; the model will not see it`);
          continue;
        }

        const sizeBytes = bytes.byteLength;
        const image = readImageFile({ bytes: new Uint8Array(bytes), filePath: imageHint });
        const normalized: InputImageAttachment = {
          ...normalizedAttachment,
          fileName: normalizedAttachment.fileName || imageHint,
          mimeType: normalizedAttachment.mimeType || image.mimeType,
          sizeBytes,
          status: normalizedAttachment.status || 'ready'
        };
        inputImages.push(normalized);

        if (!options.modelSupportsImage) {
          // The transcript shows the attachment as ready while the model never
          // received it — say which model and why, so "it ignored my image"
          // has a findable cause.
          console.warn(`[InputParseHelper] image '${imageHint}' not sent to the model — the active model has no image input; it still renders in the transcript`);
          continue;
        }
        if (sizeBytes > this.MAX_MODEL_IMAGE_BYTES) {
          console.warn(
            `[InputParseHelper] Skipped oversized image attachment (> ${this.MAX_MODEL_IMAGE_BYTES} bytes): ${normalizedAttachment.attachmentId}`
          );
          continue;
        }
        modelImages.push({
          mimeType: normalized.mimeType || image.mimeType,
          dataUrl: `data:${image.mimeType};base64,${image.base64}`
        });
      } catch (err) {
        console.warn(`[InputParseHelper] Failed to process input image: ${normalizedAttachment.attachmentId}`, err);
      }
    }

    return { inputImages, modelImages };
  }

  private static async resolveImageCandidate(
    candidate: InputImageAttachment,
    attachmentService?: ImageAttachmentService
  ): Promise<{
    normalizedAttachment: InputImageAttachment
    bytes: Uint8Array
  } | null> {
    if (attachmentService) {
      const loaded = await attachmentService.loadImageBytes(candidate);
      if (!loaded) return null;
      return {
        normalizedAttachment: loaded.attachment,
        bytes: loaded.bytes
      };
    }
    return null;
  }
}
