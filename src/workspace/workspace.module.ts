import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from 'src/auth/auth.module';
import { BillingModule } from 'src/billing/billing.module';

@Module({
  imports: [
    PassportModule,
    AuthModule,
    JwtModule.register({}),
    BillingModule,
  ],
  controllers: [WorkspaceController],
  providers: [WorkspaceService]
})

export class WorkspaceModule { }
