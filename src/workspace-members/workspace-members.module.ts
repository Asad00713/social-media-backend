import { Module } from '@nestjs/common';
import { WorkspaceMembersService } from './workspace-members.service';
import { WorkspaceMembersController } from './workspace-members.controller';
import { PassportModule } from '@nestjs/passport';
import { AuthModule } from 'src/auth/auth.module';
import { JwtModule } from '@nestjs/jwt';
import { BillingModule } from 'src/billing/billing.module';

@Module({
  imports: [
    PassportModule,
    AuthModule,
    JwtModule.register({}),
    BillingModule,
  ],
  providers: [WorkspaceMembersService],
  controllers: [WorkspaceMembersController]
})
export class WorkspaceMembersModule { }
