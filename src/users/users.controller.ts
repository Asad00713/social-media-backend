import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

/** The caller, as the JWT strategy attaches it. */
interface Caller {
  userId: string;
  role?: string;
}

/**
 * The id in the path must belong to the caller, unless the caller is a super
 * admin.
 *
 * Deliberately the SAME message either way. Answering "no such user" for an
 * unused id and "not yours" for a real one would turn this endpoint into a way
 * to discover which ids exist.
 */
function assertSelfOrSuperAdmin(targetId: string, caller: Caller): void {
  if (caller.role === 'SUPER_ADMIN') return;
  if (caller.userId !== targetId) {
    throw new ForbiddenException('You can only access your own account');
  }
}

/**
 * These routes were previously UNGUARDED: no authentication at all, and the
 * target id read straight from the URL. Anyone who could reach the API could
 * read any user's record, change any user's name, email or password, or delete
 * any account, simply by typing a different id.
 *
 * Every route now requires a valid token, and the id in the path must match the
 * id in that TOKEN, which the caller cannot forge. Listing every user is super
 * admin only.
 *
 * The path still carries an id rather than becoming `/users/me`: account
 * settings already calls `/users/:id`, and changing the URL shape and the
 * authorization in one step would make any regression hard to attribute.
 * `/users/me` stays the tidier destination for later.
 */
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /** Every user on the platform — super admin only. */
  @Get()
  @UseGuards(SuperAdminGuard)
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() caller: Caller) {
    assertSelfOrSuperAdmin(id, caller);
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
    @CurrentUser() caller: Caller,
  ) {
    assertSelfOrSuperAdmin(id, caller);
    return this.usersService.update(id, updateUserDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    assertSelfOrSuperAdmin(id, caller);
    return this.usersService.remove(id);
  }
}
