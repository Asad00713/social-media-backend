import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { MaestroService } from './services/maestro.service';
import { BridgeService } from './bridge/services/bridge.service';
import { TelegramLinkTokenDto } from './bridge/dto/bridge.dto';
import {
  CreateMaestroConversationDto,
  PresignMaestroAttachmentDto,
  SendMaestroMessageDto,
  SetFeedbackDto,
} from './dto/send-message.dto';

@Controller('maestro')
@UseGuards(JwtAuthGuard)
export class MaestroController {
  private readonly logger = new Logger(MaestroController.name);

  constructor(
    private readonly maestro: MaestroService,
    private readonly bridge: BridgeService,
  ) {}

  /** List the caller's Maestro bridge connections (Telegram/WhatsApp/Email). */
  @Get('bridge/links')
  async listBridgeLinks(
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return { links: await this.bridge.listLinks(user.userId) };
  }

  /** Issue a Telegram connect deep link for the in-app "Connect Telegram" button. */
  @Post('bridge/telegram/link-token')
  @HttpCode(HttpStatus.OK)
  async createTelegramLinkToken(
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: TelegramLinkTokenDto,
  ) {
    const deepLink = await this.bridge.telegramDeepLink(
      user.userId,
      dto.workspaceId,
    );
    return { deepLink };
  }

  /** Create a new Maestro conversation. */
  @Post('conversations')
  @HttpCode(HttpStatus.CREATED)
  async createConversation(
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: CreateMaestroConversationDto,
  ) {
    const conversation = await this.maestro.createConversation(
      user.userId,
      dto.workspaceId,
      dto.title,
    );
    return { conversation };
  }

  /** List the caller's conversations in a workspace (history panel). */
  @Get('conversations')
  async listConversations(
    @CurrentUser() user: { userId: string; email: string },
    @Query('workspaceId') workspaceId: string,
  ) {
    const conversations = await this.maestro.listConversations(
      user.userId,
      workspaceId,
    );
    return { conversations };
  }

  /** Issue a presigned R2 upload URL for a chat attachment (image/PDF). */
  @Post('attachments/presign')
  @HttpCode(HttpStatus.OK)
  async presignAttachment(
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: PresignMaestroAttachmentDto,
  ) {
    return this.maestro.presignAttachment(user.userId, dto);
  }

  /** Current AI-token budget for the workspace (powers the UI meter). */
  @Get('usage')
  async getUsage(@Query('workspaceId') workspaceId: string) {
    const budget = await this.maestro.getUsage(workspaceId);
    return { budget };
  }

  /** Load a past conversation's messages (replayed into the chat view). */
  @Get('conversations/:id/messages')
  async getMessages(
    @CurrentUser() user: { userId: string; email: string },
    @Param('id') conversationId: string,
  ) {
    const messages = await this.maestro.getConversationMessages(
      conversationId,
      user.userId,
    );
    return { messages };
  }

  /** Record 👍/👎 feedback on an assistant message. */
  @Patch('messages/:id/feedback')
  async setFeedback(
    @CurrentUser() user: { userId: string; email: string },
    @Param('id') messageId: string,
    @Body() dto: SetFeedbackDto,
  ) {
    return this.maestro.setFeedback(
      messageId,
      user.userId,
      dto.feedback ?? null,
    );
  }

  /** Send a message and stream the agent's response over SSE. */
  @Post('conversations/:id/messages')
  async sendMessage(
    @CurrentUser() user: { userId: string; email: string },
    @Param('id') conversationId: string,
    @Body() dto: SendMaestroMessageDto,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const abortController = new AbortController();
    res.on('close', () => abortController.abort());

    try {
      for await (const ev of this.maestro.streamMessage(
        {
          conversationId,
          userId: user.userId,
          message: dto.message,
          model: dto.model,
          confirmBeforeSend: dto.confirmBeforeSend,
          webSearch: dto.webSearch,
          attachments: dto.attachments,
        },
        abortController.signal,
      )) {
        if (abortController.signal.aborted) break;
        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
      }
    } catch (err) {
      this.logger.error(`Maestro SSE error: ${err}`);
      if (!abortController.signal.aborted) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            message: err instanceof Error ? err.message : 'Maestro failed',
          })}\n\n`,
        );
      }
    } finally {
      res.end();
    }
  }
}
