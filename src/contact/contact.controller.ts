import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ContactService } from './contact.service';
import { CreateContactDto } from './dto';

@Controller('contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  /**
   * Accept a message from the marketing site's contact form.
   *
   * Deliberately unauthenticated — the people most likely to use it do not have
   * an account yet — so it is rate limited instead: five submissions per IP per
   * ten minutes, which is far more than a person needs and far less than a
   * script wants. The DTO also carries a honeypot field for the automated
   * traffic that does get through.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  async submit(@Body() dto: CreateContactDto) {
    const { delivered } = await this.contactService.submit(dto);

    if (!delivered) {
      // The form must not show a success screen for a message nobody received.
      // 503 rather than 500: the enquiry itself was fine, the mail transport
      // was not, and the client can honestly say "try emailing us directly".
      throw new ServiceUnavailableException(
        'We could not deliver your message right now. Please email info@schedura.ai directly.',
      );
    }

    return {
      success: true,
      message: 'Thanks — your message reached us. We reply within one business day.',
    };
  }
}
