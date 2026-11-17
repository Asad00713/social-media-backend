import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SetPauseDto } from './dto/set-pause.dto';
import {
  NotificationPauseService,
  type PauseState,
} from './notification-pause.service';

/** The caller, as the JWT strategy attaches it. */
interface Caller {
  userId: string;
}

/**
 * The signed-in person's own notification pause. Always the caller's row: the
 * id comes from the JWT, never from the URL. Three path segments after
 * `users`, so UsersController's `users/:id` (one segment) cannot shadow it.
 */
@Controller('users/me/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationPauseController {
  constructor(private readonly pause: NotificationPauseService) {}

  @Get('pause')
  get(@CurrentUser() caller: Caller): Promise<PauseState> {
    return this.pause.get(caller.userId);
  }

  @Put('pause')
  set(
    @CurrentUser() caller: Caller,
    @Body() dto: SetPauseDto,
  ): Promise<PauseState> {
    return this.pause.set(
      caller.userId,
      dto.until === null ? null : new Date(dto.until),
    );
  }
}
