import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { ChannelService, isChannelHealthy } from './channel.service';
import { InboxService } from '../../inbox/inbox.service';
import type { ChannelResponseDto } from '../dto/channel.dto';

export interface EmbeddedSignupInput {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  pin?: string;
}

@Injectable()
export class WhatsAppOnboardingService {
  private readonly logger = new Logger(WhatsAppOnboardingService.name);

  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly channels: ChannelService,
    private readonly inbox: InboxService,
  ) {}

  /**
   * Complete WhatsApp Embedded Signup (Tech Provider flow): guard cross-workspace
   * and healthy same-workspace duplicates, exchange the code for a business
   * token, register the phone number, subscribe our app to the WABA, then
   * persist the channel.
   */
  async completeEmbeddedSignup(
    workspaceId: string,
    userId: string,
    input: EmbeddedSignupInput,
  ): Promise<ChannelResponseDto> {
    await this.inbox.assertWorkspaceAccessPublic(workspaceId, userId);

    // 1. Cross-workspace guard: reject if this phone number is already owned by
    //    a DIFFERENT workspace (webhook routing is keyed on phone_number_id).
    //    Runs BEFORE any mutating Meta call so a cross-workspace collision never
    //    triggers registerPhoneNumber/subscribeWaba against the caller's token.
    const existing =
      await this.channels.findChannelsByPlatformAccountAllWorkspaces(
        'whatsapp',
        input.phoneNumberId,
      );
    const otherWorkspace = existing.find((c) => c.workspaceId !== workspaceId);
    if (otherWorkspace) {
      throw new ConflictException(
        'This WhatsApp number is already connected to another workspace. Disconnect it there first.',
      );
    }

    // A healthy channel in THIS workspace means there is nothing to do — reject before
    // burning the (idempotent but rate-limited) Meta calls. A broken/expired channel
    // falls through so the Meta calls can mint a fresh token and createChannel's
    // reconnect branch updates it in place.
    const healthySameWorkspace = existing.find(
      (c) => c.workspaceId === workspaceId && isChannelHealthy(c),
    );
    if (healthySameWorkspace) {
      throw new ConflictException(
        'This WhatsApp number is already connected to this workspace.',
      );
    }

    // 2. Exchange the short-lived code for a customer-scoped business token.
    let accessToken: string;
    let expiresIn: number | null;
    try {
      const exchanged = await this.whatsapp.exchangeCodeForBusinessToken(input.code);
      accessToken = exchanged.accessToken;
      expiresIn = exchanged.expiresIn;
    } catch (err) {
      throw new BadRequestException(
        `Could not complete WhatsApp signup — ${
          (err as Error).message
        }. The signup code expires within ~30 seconds; please try connecting again.`,
      );
    }

    // 3. Resolve display name / verified name (also validates the number).
    let displayPhoneNumber: string | null = null;
    let verifiedName: string | null = null;
    try {
      const phones = await this.whatsapp.getWabaPhoneNumbers(accessToken, input.wabaId);
      const match = phones.find((p) => p.id === input.phoneNumberId) ?? phones[0];
      displayPhoneNumber = match?.displayPhoneNumber ?? null;
      verifiedName = match?.verifiedName ?? null;
    } catch (err) {
      this.logger.warn(
        `getWabaPhoneNumbers failed for waba=${input.wabaId}: ${(err as Error).message}`,
      );
    }

    // 4. Register the phone number for Cloud API (idempotent).
    await this.whatsapp.registerPhoneNumber(
      accessToken,
      input.phoneNumberId,
      input.pin ?? '000000',
    );

    // 5. Subscribe our app to the WABA — BLOCKING. A channel that never
    //    receives webhooks is worse than a visible failure.
    await this.whatsapp.subscribeWaba(accessToken, input.wabaId);

    // 6. Persist. A healthy same-workspace duplicate was already rejected above
    //    (step 1.5), so any same-workspace row reaching here is broken/expired —
    //    createChannel's reconnect branch refreshes it in place.
    const accountName = verifiedName || input.phoneNumberId;
    return this.channels.createChannel(workspaceId, userId, {
      platform: 'whatsapp',
      accountType: 'business_account',
      platformAccountId: input.phoneNumberId,
      accountName,
      accessToken,
      tokenExpiresAt: expiresIn
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : undefined,
      metadata: {
        wabaId: input.wabaId,
        displayPhoneNumber: displayPhoneNumber ?? input.phoneNumberId,
        connectMethod: 'embedded_signup',
      },
    });
  }
}
