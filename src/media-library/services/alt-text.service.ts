import {
  BadRequestException,
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

function notAnImage(message: string) {
  return new UnprocessableEntityException({ code: 'NOT_AN_IMAGE', message });
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
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw notAnImage('The image could not be read from the Library.');
    }
    const mimeType = (res.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!mimeType.startsWith('image/')) {
      throw notAnImage('Alt text can only be written for images.');
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_IMAGE_BYTES) {
      throw notAnImage('This image is too large to describe.');
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw notAnImage('This image is too large to describe.');
    }
    return { mimeType, data: bytes.toString('base64') };
  }
}
