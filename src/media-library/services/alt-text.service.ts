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
  ALT_TEXT_SYSTEM_PROMPT,
  ALT_TEXT_USER_PROMPT,
  cleanAltText,
  visionImageUrl,
} from '../lib/vision';
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

function notAnImage(message: string) {
  return new UnprocessableEntityException({ code: 'NOT_AN_IMAGE', message });
}

function tooLarge() {
  return notAnImage('This image is too large to describe.');
}

function tokensExhausted() {
  return new HttpException(
    {
      code: 'AI_TOKENS_EXHAUSTED',
      message: 'Your workspace is out of AI tokens.',
    },
    402,
  );
}

@Injectable()
export class AltTextService {
  constructor(
    private readonly mediaItems: MediaItemService,
    private readonly storageObjects: StorageObjectService,
    private readonly aiTokens: AiTokenService,
    private readonly aiText: AiTextService,
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
        `alt text: ${item.name}`,
        async () => {
          started = true;
          const image = await this.fetchImage(visionImageUrl(item.fileUrl));
          const raw = await this.aiText.describeImage(
            ALT_TEXT_SYSTEM_PROMPT,
            ALT_TEXT_USER_PROMPT,
            image,
            { maxTokens: 120 },
          );
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
  ): Promise<{ mimeType: string; data: string }> {
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
    if (!VISION_MIME_TYPES.has(mimeType)) {
      throw notAnImage(
        'Alt text can only be written for PNG, JPEG, WebP or HEIC images.',
      );
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
