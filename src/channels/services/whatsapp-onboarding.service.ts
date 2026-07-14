import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import {
  WhatsAppService,
  WhatsAppApiError,
  WA_ERROR_PIN_MISMATCH,
} from './whatsapp.service';
import { ChannelService, isChannelHealthy } from './channel.service';
import { InboxService } from '../../inbox/inbox.service';
import type { ChannelResponseDto } from '../dto/channel.dto';

/**
 * Machine-readable marker on the 400 body. The client keys the "enter your PIN"
 * retry off this rather than the prose, which is free to change.
 */
export const WHATSAPP_PIN_REQUIRED = 'WHATSAPP_PIN_REQUIRED';

export interface EmbeddedSignupInput {
  code: string;
  /** Present only when Meta's `WA_EMBEDDED_SIGNUP` postMessage reached the browser. */
  wabaId?: string;
  /** Same — and Meta omits it entirely on `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`. */
  phoneNumberId?: string;
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
   *
   * `wabaId` and `phoneNumberId` are best-effort inputs. Meta hands them to the
   * browser over `postMessage`, which can silently never arrive — and its
   * `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` event omits `phone_number_id`
   * outright. So the code is the only input we insist on: the business token it
   * mints is authoritative about which WABA the customer granted, and the WABA is
   * authoritative about its own phone numbers. Anything missing is derived.
   */
  async completeEmbeddedSignup(
    workspaceId: string,
    userId: string,
    input: EmbeddedSignupInput,
  ): Promise<ChannelResponseDto> {
    await this.inbox.assertWorkspaceAccessPublic(workspaceId, userId);
    this.logger.log(
      `Embedded Signup start: waba=${input.wabaId ?? '(not sent)'} phone=${
        input.phoneNumberId ?? '(not sent)'
      }`,
    );

    // 1. Duplicate guard. When Meta told us the phone number id we can run this
    //    before even spending the code; otherwise it runs post-exchange, still
    //    ahead of every mutating Meta call (see step 5).
    if (input.phoneNumberId) {
      await this.assertNoConflictingChannel(workspaceId, input.phoneNumberId);
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

    // 3. Resolve the WABA — from the message if we got one, else off the token.
    const wabaId = input.wabaId ?? (await this.resolveWabaId(accessToken));

    // 4. Resolve the phone number, plus its verified name for the channel label.
    //    This lookup is cosmetic when Meta already told us the id, but
    //    load-bearing when it did not.
    let phones: Array<{
      id: string;
      displayPhoneNumber: string | null;
      verifiedName: string | null;
    }> = [];
    let phoneLookupError: string | null = null;
    try {
      phones = await this.whatsapp.getWabaPhoneNumbers(accessToken, wabaId);
    } catch (err) {
      phoneLookupError = (err as Error).message;
      this.logger.warn(
        `getWabaPhoneNumbers failed for waba=${wabaId}: ${phoneLookupError}`,
      );
    }

    const phoneNumberId =
      input.phoneNumberId ??
      this.pickPhoneNumberId(phones, wabaId, phoneLookupError);
    if (!input.phoneNumberId) {
      await this.assertNoConflictingChannel(workspaceId, phoneNumberId);
    }

    const match = phones.find((p) => p.id === phoneNumberId) ?? phones[0];
    const displayPhoneNumber = match?.displayPhoneNumber ?? null;
    const verifiedName = match?.verifiedName ?? null;
    this.logger.log(
      `Embedded Signup resolved: waba=${wabaId} phone=${phoneNumberId}`,
    );

    // 5. Register the phone number for Cloud API (idempotent).
    await this.registerNumber(accessToken, phoneNumberId, input.pin);

    // 6. Subscribe our app to the WABA — BLOCKING. A channel that never
    //    receives webhooks is worse than a visible failure.
    await this.whatsapp.subscribeWaba(accessToken, wabaId);

    // 7. Persist. A healthy same-workspace duplicate was already rejected, so any
    //    same-workspace row reaching here is broken/expired — createChannel's
    //    reconnect branch refreshes it in place.
    const accountName = verifiedName || phoneNumberId;
    return this.channels.createChannel(workspaceId, userId, {
      platform: 'whatsapp',
      accountType: 'business_account',
      platformAccountId: phoneNumberId,
      accountName,
      accessToken,
      tokenExpiresAt: expiresIn
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : undefined,
      metadata: {
        wabaId,
        displayPhoneNumber: displayPhoneNumber ?? phoneNumberId,
        connectMethod: 'embedded_signup',
      },
    });
  }

  /**
   * Register the number for Cloud API. A number that already has two-step
   * verification on rejects our PIN, and the customer is the only one who knows
   * theirs — so that is a question to ask, not a 500 to bury. Everything else
   * bubbles up unchanged.
   *
   * On a number with two-step verification OFF, Meta adopts whatever PIN we send
   * as its PIN, which is why the default is a fixed '000000'.
   */
  private async registerNumber(
    accessToken: string,
    phoneNumberId: string,
    pin: string | undefined,
  ): Promise<void> {
    try {
      await this.whatsapp.registerPhoneNumber(
        accessToken,
        phoneNumberId,
        pin ?? '000000',
      );
    } catch (err) {
      const isPinMismatch =
        err instanceof WhatsAppApiError && err.code === WA_ERROR_PIN_MISMATCH;
      if (!isPinMismatch) throw err;

      this.logger.warn(
        `Register rejected our PIN for phone=${phoneNumberId} (two-step verification is on; pin ${
          pin ? 'supplied' : 'defaulted'
        })`,
      );
      throw new BadRequestException({
        code: WHATSAPP_PIN_REQUIRED,
        message: pin
          ? "That PIN doesn't match this number's two-step verification PIN. Check it and try again."
          : 'This number has two-step verification turned on. Enter its 6-digit PIN and connect again — or turn two-step verification off in WhatsApp Manager (Account tools → Phone numbers → gear icon).',
      });
    }
  }

  /**
   * Reject a number already owned by a DIFFERENT workspace (webhook routing is
   * keyed on phone_number_id), or already healthy in this one. Must run before
   * any mutating Meta call.
   */
  private async assertNoConflictingChannel(
    workspaceId: string,
    phoneNumberId: string,
  ): Promise<void> {
    const existing =
      await this.channels.findChannelsByPlatformAccountAllWorkspaces(
        'whatsapp',
        phoneNumberId,
      );

    if (existing.some((c) => c.workspaceId !== workspaceId)) {
      throw new ConflictException(
        'This WhatsApp number is already connected to another workspace. Disconnect it there first.',
      );
    }

    // A healthy channel here means there is nothing to do — reject before burning
    // the (idempotent but rate-limited) Meta calls. A broken/expired one falls
    // through so those calls can mint a fresh token and createChannel's reconnect
    // branch updates it in place.
    if (
      existing.some((c) => c.workspaceId === workspaceId && isChannelHealthy(c))
    ) {
      throw new ConflictException(
        'This WhatsApp number is already connected to this workspace.',
      );
    }
  }

  /** Read the granted WABA off the business token when the browser never told us. */
  private async resolveWabaId(accessToken: string): Promise<string> {
    let granted: string[];
    try {
      granted = await this.whatsapp.getGrantedWabaIds(accessToken);
    } catch (err) {
      throw new BadRequestException(
        `Could not read your WhatsApp Business account from the sign-in — ${
          (err as Error).message
        }. Please try connecting again.`,
      );
    }
    if (granted.length === 0) {
      throw new BadRequestException(
        'The Facebook sign-in did not grant access to any WhatsApp Business account. Complete the WhatsApp steps in the popup, then try again.',
      );
    }
    if (granted.length > 1) {
      this.logger.warn(
        `Token grants ${granted.length} WABAs (${granted.join(', ')}); using the most recently onboarded.`,
      );
    }
    return granted[0]; // Meta lists the most recently onboarded WABA first.
  }

  /** Pick the WABA's phone number when the browser never told us which one. */
  private pickPhoneNumberId(
    phones: Array<{ id: string }>,
    wabaId: string,
    lookupError: string | null,
  ): string {
    if (phones.length === 0) {
      throw new BadRequestException(
        lookupError
          ? `Could not read the phone numbers on WhatsApp Business account ${wabaId} — ${lookupError}. Please try connecting again.`
          : `WhatsApp Business account ${wabaId} has no phone number yet. Add and verify a number in WhatsApp Manager, then connect again.`,
      );
    }
    if (phones.length > 1) {
      this.logger.warn(
        `WABA ${wabaId} has ${phones.length} phone numbers and Meta sent none; using the first (${phones[0].id}).`,
      );
    }
    return phones[0].id;
  }
}
