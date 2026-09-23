import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailModule } from '../email/email.module';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';

/**
 * The marketing site's contact form.
 *
 * Holds no state and touches no table: a submission becomes two emails and
 * nothing else. If enquiries ever need to be tracked rather than forwarded,
 * that is a schema change, not a reshape of this module.
 */
@Module({
  imports: [ConfigModule, EmailModule],
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
