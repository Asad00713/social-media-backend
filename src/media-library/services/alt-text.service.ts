import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  HttpException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AiTextService } from '../../ai/ai-text.service';
import { AiTokenService } from '../../ai/services/ai-token.service';
import {
  CLAUDE_IMAGE_TYPES,
  ClaudeTextService,
  isClaudeImageType,
} from '../../ai/claude-text.service';
import {
  ALT_TEXT_SYSTEM_PROMPT,
  ALT_TEXT_USER_PROMPT,
  cleanAltText,
  visionImageUrl,
} from '../lib/vision';
import type { AiTokensExhaustedError, NotAnImageError } from '../dto/contract';
import { MediaItemService } from './media-item.service';
import { StorageObjectService } from './storage-object.service';

const OPERATION = 'generate_alt_text';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Formats Gemini accepts as inline image data.
const VISION_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const GEMINI_FORMATS = 'PNG, JPEG, WebP or HEIC';
// Formats the Claude Messages API accepts as an image block.
const CLAUDE_MIME_TYPES: ReadonlySet<string> = new Set(CLAUDE_IMAGE_TYPES);
const CLAUDE_FORMATS = 'PNG, JPEG, WebP or GIF';

type Image = { mimeType: string; data: string };

function notAnImage(message: string) {
  const body: NotAnImageError = { code: 'NOT_AN_IMAGE', message };
  return new UnprocessableEntityException(body);
}

function tooLarge() {
  return notAnImage('This image is too large to describe.');
}

function tokensExhausted() {
  const body: AiTokensExhaustedError = {
    code: 'AI_TOKENS_EXHAUSTED',
    message: 'Your workspace is out of AI tokens.',
  };
  return new HttpException(body, 402);
}

@Injectable()
export class AltTextService {
  constructor(
    private readonly mediaItems: MediaItemService,
    private readonly storageObjects: StorageObjectService,
    private readonly aiTokens: AiTokenService,
    private readonly aiText: AiTextService,
    private readonly claude: ClaudeTextService,
  ) {}

  /** Writes alt text for a stored image. Never saves it; the caller decides. */
  async generate(
    workspaceId: string,
    userId: string,
    itemId: string,
  ): Promise<{ altText: string }> {
    const item = await this.mediaItems.findOne(workspaceId, itemId);
    if (item.isDeleted) throw new NotFoundException('Media item not found');

    if (
      (item.type !== 'image' && item.type !== 'gif') ||
      !this.storageObjects.isOwnStorageUrl(item.fileUrl)
    ) {
      throw notAnImage(
        'Alt text can only be written for images stored in the Library.',
      );
    }

    return this.metered(workspaceId, userId, `alt text: ${item.name}`, () =>
      this.describeWithGemini(item.fileUrl),
    );
  }

  /**
   * Writes alt text for a photo on a DRAFT, by its URL — the composer's
   * "Write it for me". A draft photo need not be a Library item, so this
   * takes the URL, and refuses any URL that is not our own storage: we fetch
   * it server-side, and a free-form URL would be a request to any host.
   *
   * Claude Sonnet when ANTHROPIC_API_KEY is set (vision where quality
   * matters); Gemini otherwise, the same model the Library uses. Never saves:
   * the editor puts the text in its field and the person keeps or edits it.
   */
  async generateForUrl(
    workspaceId: string,
    userId: string,
    url: string,
  ): Promise<{ altText: string }> {
    if (!this.storageObjects.isOwnStorageUrl(url)) {
      throw notAnImage(
        'Alt text can only be written for photos uploaded to Schedura.',
      );
    }
    return this.metered(workspaceId, userId, 'alt text: draft photo', () =>
      this.claude.isReady()
        ? this.describeWithClaude(url)
        : this.describeWithGemini(url),
    );
  }

  private async describeWithGemini(fileUrl: string): Promise<string> {
    const image = await this.fetchImage(
      visionImageUrl(fileUrl),
      VISION_MIME_TYPES,
      GEMINI_FORMATS,
    );
    return this.aiText.describeImage(
      ALT_TEXT_SYSTEM_PROMPT,
      ALT_TEXT_USER_PROMPT,
      image,
      { maxTokens: 120 },
    );
  }

  private async describeWithClaude(fileUrl: string): Promise<string> {
    const image = await this.fetchImage(
      visionImageUrl(fileUrl),
      CLAUDE_MIME_TYPES,
      CLAUDE_FORMATS,
    );
    if (!isClaudeImageType(image.mimeType)) {
      throw notAnImage(
        `Alt text can only be written for ${CLAUDE_FORMATS} images.`,
      );
    }
    // Room for the model's own thinking, which counts against max_tokens.
    return this.claude.describeImage(
      ALT_TEXT_SYSTEM_PROMPT,
      ALT_TEXT_USER_PROMPT,
      { mimeType: image.mimeType, data: image.data },
      { maxTokens: 2048 },
    );
  }

  /** One metered description: 402 when out of tokens, nothing charged on failure. */
  private async metered(
    workspaceId: string,
    userId: string,
    summary: string,
    describe: () => Promise<string>,
  ): Promise<{ altText: string }> {
    const check = await this.aiTokens.checkTokens(workspaceId, OPERATION);
    if (!check.hasAccess) throw tokensExhausted();

    // The balance can change between the pre-check and executeWithTokens' own
    // re-check, which then throws 403/400. Only those pre-run throws map to 402.
    let started = false;
    try {
      const { result } = await this.aiTokens.executeWithTokens(
        workspaceId,
        userId,
        OPERATION,
        undefined,
        summary,
        async () => {
          started = true;
          const raw = await describe();
          const altText = cleanAltText(raw);
          if (!altText) {
            throw new BadGatewayException(
              'The AI returned no usable description. Please try again.',
            );
          }
          return { result: altText, outputLength: altText.length };
        },
      );
      return { altText: result };
    } catch (err) {
      if (
        !started &&
        (err instanceof ForbiddenException ||
          err instanceof BadRequestException)
      ) {
        throw tokensExhausted();
      }
      throw err;
    }
  }

  private async fetchImage(
    url: string,
    allowed: ReadonlySet<string>,
    formats: string,
  ): Promise<Image> {
    const controller = new AbortController();
    const res = await fetch(url, {
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ]),
      // Own-storage URLs must not bounce us to another host.
      redirect: 'error',
    });
    if (!res.ok) {
      throw notAnImage('The image could not be read from the Library.');
    }
    const mimeType = (res.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!allowed.has(mimeType)) {
      throw notAnImage(`Alt text can only be written for ${formats} images.`);
    }
    // A missing or invalid content-length is unknown, not 0; the streaming
    // cap below applies either way.
    const declaredHeader = res.headers.get('content-length');
    const declared = declaredHeader === null ? NaN : Number(declaredHeader);
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      controller.abort();
      throw tooLarge();
    }
    const bytes = await this.readCapped(res, controller);
    return { mimeType, data: bytes.toString('base64') };
  }

  /** Reads the body chunk by chunk, aborting as soon as the cap is exceeded. */
  private async readCapped(
    res: Response,
    controller: AbortController,
  ): Promise<Buffer> {
    if (!res.body)
      throw notAnImage('The image could not be read from the Library.');
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
}
