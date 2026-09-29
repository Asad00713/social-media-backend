import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { PresignAvatarDto, SetAvatarDto } from './dto/avatar.dto';
import { CloudflareR2Service } from '../media/cloudflare-r2.service';
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
  constructor(
    private readonly usersService: UsersService,
    private readonly r2: CloudflareR2Service,
  ) {}

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

  /**
   * A presigned URL to upload a profile picture to.
   *
   * Two steps rather than one multipart POST: the image goes straight from the
   * browser to R2, so a photo never travels through this server and an upload
   * does not hold a Node request open. The caller then PATCHes the returned
   * public URL back with `setAvatar`.
   *
   * Self only — not even a super admin, who has no business choosing what
   * someone's face looks like.
   */
  @Post(':id/avatar/presign')
  @HttpCode(HttpStatus.OK)
  presignAvatar(
    @Param('id') id: string,
    @Body() dto: PresignAvatarDto,
    @CurrentUser() caller: Caller,
  ) {
    if (id !== caller.userId) {
      throw new ForbiddenException('You can only change your own picture.');
    }
    return this.r2.createPresignedUpload({
      // An avatar's key leaves the workspace out — see the R2 service. The
      // field is required by the shared signature, so it is passed and
      // ignored rather than making every other caller pass an optional.
      workspaceId: 'user',
      userId: caller.userId,
      kind: 'avatar',
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
      filename: dto.filename,
    });
  }

  /**
   * Set or clear the user's profile picture. Self only, as above.
   *
   * The URL must be one we issued. A client is trusted to send back what it
   * uploaded; a hostile one is trusted to send anything, and an arbitrary URL
   * stored here would render on every screen that lists this person — a
   * tracking pixel, or an image that changes after someone approves it.
   */
  @Patch(':id/avatar')
  setAvatar(
    @Param('id') id: string,
    @Body() dto: SetAvatarDto,
    @CurrentUser() caller: Caller,
  ) {
    if (id !== caller.userId) {
      throw new ForbiddenException('You can only change your own picture.');
    }
    const avatarUrl = dto.avatarUrl ?? null;
    if (avatarUrl && !this.r2.isOwnPublicUrl(avatarUrl, 'avatar')) {
      throw new BadRequestException(
        'That is not an uploaded avatar. Upload the image first.',
      );
    }
    return this.usersService.setAvatar(id, avatarUrl);
  }
}
