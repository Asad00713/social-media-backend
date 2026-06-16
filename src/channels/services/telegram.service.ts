import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string; first_name?: string; last_name?: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  voice?: { file_id: string; file_unique_id: string; duration: number; mime_type?: string; file_size?: number };
  audio?: { file_id: string; file_unique_id: string; duration: number; mime_type?: string; file_size?: number; title?: string; performer?: string; file_name?: string };
  video?: { file_id: string; file_unique_id: string; width: number; height: number; duration: number; mime_type?: string; file_size?: number; file_name?: string };
  video_note?: { file_id: string; file_unique_id: string; length: number; duration: number; file_size?: number };
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
  sticker?: { file_id: string; file_unique_id: string; file_size?: number; mime_type?: string };
  reply_to_message?: TgMessage;
}

export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TgUser;
}

export interface TgInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string;
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN', '');
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${this.botToken}`;
  }

  isConfigured(): boolean {
    return !!this.botToken;
  }

  private async callJson<T>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    if (!this.isConfigured()) {
      throw new InternalServerErrorException(
        'TELEGRAM_BOT_TOKEN not configured.',
      );
    }
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as TgResponse<T>;
    if (!json.ok || json.result === undefined) {
      throw new BadRequestException(
        `tg.${method} failed: ${json.description ?? `HTTP ${res.status}`}`,
      );
    }
    return json.result;
  }

  private async callMultipart<T>(
    method: string,
    form: FormData,
  ): Promise<T> {
    if (!this.isConfigured()) {
      throw new InternalServerErrorException(
        'TELEGRAM_BOT_TOKEN not configured.',
      );
    }
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      body: form,
    });
    const json = (await res.json()) as TgResponse<T>;
    if (!json.ok || json.result === undefined) {
      throw new BadRequestException(
        `tg.${method} failed: ${json.description ?? `HTTP ${res.status}`}`,
      );
    }
    return json.result;
  }

  async getMe(): Promise<TgUser> {
    return this.callJson<TgUser>('getMe', {});
  }

  async setWebhook(url: string, secretToken: string): Promise<true> {
    return this.callJson<true>('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'],
    });
  }

  async sendMessage(
    chatId: string | number,
    text: string,
    options: {
      replyToMessageId?: number;
      replyMarkup?: { inline_keyboard: TgInlineKeyboardButton[][] };
      parseMode?: 'MarkdownV2' | 'HTML';
    } = {},
  ): Promise<TgMessage> {
    return this.callJson<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      ...(options.replyToMessageId && { reply_to_message_id: options.replyToMessageId }),
      ...(options.replyMarkup && { reply_markup: options.replyMarkup }),
      ...(options.parseMode && { parse_mode: options.parseMode }),
    });
  }

  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
  ): Promise<true | TgMessage> {
    return this.callJson<true | TgMessage>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
    });
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
    showAlert = false,
  ): Promise<true> {
    return this.callJson<true>('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text && { text }),
      show_alert: showAlert,
    });
  }

  async getChatAdministrators(
    chatId: string | number,
  ): Promise<Array<{ user: TgUser; status: string }>> {
    return this.callJson('getChatAdministrators', { chat_id: chatId });
  }

  async getFile(fileId: string): Promise<{ file_path: string; file_size?: number }> {
    return this.callJson('getFile', { file_id: fileId });
  }

  /** Returns the `file_id` of the largest resolution of a user's current
   *  profile photo, or null when the user has no photo / hides it via privacy
   *  settings. Never throws — avatar resolution is best-effort and must not
   *  block message ingest. */
  async getUserProfilePhotoFileId(
    userId: number | string,
  ): Promise<string | null> {
    try {
      const res = await this.callJson<{
        total_count: number;
        photos: Array<Array<{ file_id: string; file_size?: number }>>;
      }>('getUserProfilePhotos', { user_id: userId, limit: 1 });
      const firstPhoto = res.photos?.[0];
      if (!firstPhoto || firstPhoto.length === 0) return null;
      // Telegram orders sizes ascending — last entry is the largest.
      return firstPhoto[firstPhoto.length - 1].file_id;
    } catch (err) {
      this.logger.warn(
        `getUserProfilePhotos failed for user ${userId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** No auth header needed — the bot token is embedded in `fileBaseUrl` per
   *  Telegram's file API spec. */
  async downloadFile(
    filePath: string,
  ): Promise<{ buffer: Buffer; contentType: string; sizeBytes: number }> {
    if (!this.isConfigured()) {
      throw new InternalServerErrorException(
        'TELEGRAM_BOT_TOKEN not configured.',
      );
    }
    const res = await fetch(`${this.fileBaseUrl}/${filePath}`);
    if (!res.ok) {
      throw new BadRequestException(
        `tg file download failed: ${res.status} ${res.statusText}`,
      );
    }
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    const contentType =
      res.headers.get('content-type')?.split(';')[0]?.trim() ||
      'application/octet-stream';
    return { buffer, contentType, sizeBytes: buffer.length };
  }

  private buildMediaForm(
    chatId: string | number,
    fieldName: 'photo' | 'voice' | 'audio' | 'video' | 'video_note' | 'document',
    buffer: Buffer,
    filename: string,
    contentType: string,
    caption?: string,
  ): FormData {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    const blob = new Blob([new Uint8Array(buffer)], { type: contentType });
    form.append(fieldName, blob, filename);
    return form;
  }

  async sendPhoto(chatId: string | number, buffer: Buffer, filename: string, contentType: string, caption?: string): Promise<TgMessage> {
    return this.callMultipart<TgMessage>('sendPhoto', this.buildMediaForm(chatId, 'photo', buffer, filename, contentType, caption));
  }

  async sendVoice(chatId: string | number, buffer: Buffer, filename: string, contentType: string, caption?: string): Promise<TgMessage> {
    return this.callMultipart<TgMessage>('sendVoice', this.buildMediaForm(chatId, 'voice', buffer, filename, contentType, caption));
  }

  async sendAudio(chatId: string | number, buffer: Buffer, filename: string, contentType: string, caption?: string): Promise<TgMessage> {
    return this.callMultipart<TgMessage>('sendAudio', this.buildMediaForm(chatId, 'audio', buffer, filename, contentType, caption));
  }

  async sendVideo(chatId: string | number, buffer: Buffer, filename: string, contentType: string, caption?: string): Promise<TgMessage> {
    return this.callMultipart<TgMessage>('sendVideo', this.buildMediaForm(chatId, 'video', buffer, filename, contentType, caption));
  }

  async sendDocument(chatId: string | number, buffer: Buffer, filename: string, contentType: string, caption?: string): Promise<TgMessage> {
    return this.callMultipart<TgMessage>('sendDocument', this.buildMediaForm(chatId, 'document', buffer, filename, contentType, caption));
  }

  /** Replace `text_mention` entity ranges with `@<first_name>` so the inbox
   *  shows a human-readable mention instead of opaque user_id markup. Other
   *  entity types (plain `@username`, URLs, hashtags) pass through untouched. */
  resolveEntities(text: string, entities: TgEntity[] | undefined): string {
    if (!text || !entities || entities.length === 0) return text;
    const sorted = [...entities].sort((a, b) => a.offset - b.offset);
    let out = '';
    let cursor = 0;
    for (const e of sorted) {
      out += text.slice(cursor, e.offset);
      if (e.type === 'text_mention' && e.user) {
        const name = e.user.username
          ? `@${e.user.username}`
          : `@${e.user.first_name}`;
        out += name;
      } else {
        out += text.slice(e.offset, e.offset + e.length);
      }
      cursor = e.offset + e.length;
    }
    out += text.slice(cursor);
    return out;
  }
}
