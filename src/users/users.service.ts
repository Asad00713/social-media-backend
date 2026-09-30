import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { DbType } from 'src/drizzle/db';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import { CreateUserDto } from './dto/create-user.dto';
import {
  MaestroTone,
  NewUser,
  User,
  users,
  UserRole,
} from 'src/drizzle/schema';
import { eq, sql } from 'drizzle-orm';
import * as bcrypt from 'bcrypt';
import { UpdateUserDto } from './dto/update-user.dto';
import { pickAvatarColor } from './avatar-colors';

// Public user type that excludes sensitive fields
export type PublicUser = Pick<
  User,
  | 'id'
  | 'email'
  | 'name'
  | 'role'
  | 'isEmailVerified'
  | 'lastAccessedWorkspaceId'
  | 'onboardingCompletedAt'
  | 'maestroTone'
  | 'avatarUrl'
  | 'avatarColor'
  | 'createdAt'
  | 'updatedAt'
>;

/**
 * The columns a relational query selects to build a `PublicUser`.
 *
 * One list, used by every read, because the alternative is what this replaced:
 * the same ten keys written out in three places and the same object assembled
 * by hand in three more. A field added to `PublicUser` but missed in one of
 * those six came back undefined for some callers and not others — which is the
 * hardest kind of bug to see, because the type says it is there.
 */
const PUBLIC_USER_COLUMNS = {
  id: true,
  email: true,
  name: true,
  role: true,
  isEmailVerified: true,
  lastAccessedWorkspaceId: true,
  onboardingCompletedAt: true,
  maestroTone: true,
  avatarUrl: true,
  avatarColor: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Narrow a full row to the public shape. Counterpart to PUBLIC_USER_COLUMNS
 *  for the paths that write and get the whole row back. */
function toPublicUser(row: User): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isEmailVerified: row.isEmailVerified,
    lastAccessedWorkspaceId: row.lastAccessedWorkspaceId,
    onboardingCompletedAt: row.onboardingCompletedAt,
    maestroTone: row.maestroTone,
    avatarUrl: row.avatarUrl,
    avatarColor: row.avatarColor,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE) private db: DbType) {}

  async create(
    createUserDto: CreateUserDto,
    role: UserRole = 'USER',
  ): Promise<PublicUser> {
    const existingUser = await this.db.query.users.findFirst({
      where: eq(users.email, createUserDto.email),
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(createUserDto.password, 10);

    const [newUser] = await this.db
      .insert(users)
      .values({
        email: createUserDto.email,
        name: createUserDto.name,
        password: hashedPassword,
        role,
        // Assigned here, at the one moment a person enters the system, and
        // never recomputed. An avatar is how colleagues pick someone out of a
        // list, so it has to outlive a rename and a palette edit both.
        avatarColor: pickAvatarColor(),
      })
      .returning();

    return toPublicUser(newUser);
  }

  async findAll(): Promise<PublicUser[]> {
    const allUsers = await this.db.query.users.findMany({
      columns: PUBLIC_USER_COLUMNS,
    });

    return allUsers;
  }

  async findOne(id: string): Promise<PublicUser> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, id),
      columns: PUBLIC_USER_COLUMNS,
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    return user;
  }

  async findOneWithSuspension(
    id: string,
  ): Promise<
    PublicUser & { isActive: boolean; suspendedReason: string | null }
  > {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, id),
      columns: {
        ...PUBLIC_USER_COLUMNS,
        isActive: true,
        suspendedReason: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    return user;
  }

  async findByVerificationToken(token: string): Promise<User | undefined> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.emailVerificationToken, token),
    });

    return user;
  }

  async findByPasswordResetToken(token: string): Promise<User | undefined> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.passwordResetToken, token),
    });

    return user;
  }

  async setEmailVerificationToken(
    userId: string,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.db
      .update(users)
      .set({
        emailVerificationToken: token,
        emailVerificationTokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }

  async verifyEmail(userId: string): Promise<void> {
    // Use raw SQL to avoid Drizzle timestamp null mapping issues
    await this.db.execute(sql`
            UPDATE users
            SET
                is_email_verified = true,
                email_verification_token = NULL,
                email_verification_token_expires_at = NULL,
                updated_at = ${new Date()}
            WHERE id = ${userId}
        `);
  }

  async setPasswordResetToken(
    userId: string,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.db
      .update(users)
      .set({
        passwordResetToken: token,
        passwordResetTokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }

  async resetPassword(userId: string, newPassword: string): Promise<void> {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    // Use raw SQL to avoid Drizzle timestamp null mapping issues
    await this.db.execute(sql`
            UPDATE users
            SET
                password = ${hashedPassword},
                password_reset_token = NULL,
                password_reset_token_expires_at = NULL,
                updated_at = ${new Date()}
            WHERE id = ${userId}
        `);
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.email, email),
    });

    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<PublicUser> {
    const user = await this.findOne(id);

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    const updateData: Partial<NewUser> = {
      ...updateUserDto,
      updatedAt: new Date(),
    };

    if (updateUserDto.password) {
      updateData.password = await bcrypt.hash(updateUserDto.password, 10);
    }

    const [updatedUser] = await this.db
      .update(users)
      .set(updateData)
      .where(eq(users.id, id))
      .returning();

    return toPublicUser(updatedUser);
  }

  /**
   * Idempotent: stamps onboardingCompletedAt with the current time. If
   * already set, leaves the original timestamp untouched so we don't
   * accidentally reset analytics that depend on the first completion time.
   */
  /**
   * The user's Maestro reply style. Falls back to 'professional' -- the voice
   * Maestro had before this setting existed -- if the row is missing, so a
   * failed lookup degrades to the old behaviour instead of breaking a chat turn.
   */
  async getMaestroTone(userId: string): Promise<MaestroTone> {
    const row = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { maestroTone: true },
    });
    return row?.maestroTone ?? 'professional';
  }

  /** Set the user's Maestro reply style. */
  async setMaestroTone(userId: string, tone: MaestroTone): Promise<void> {
    await this.db
      .update(users)
      .set({ maestroTone: tone, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  async markOnboardingCompleted(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({
        onboardingCompletedAt: sql`COALESCE(${users.onboardingCompletedAt}, NOW())`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }

  async setLastAccessedWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.db
      .update(users)
      .set({
        lastAccessedWorkspaceId: workspaceId,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }

  async remove(id: string): Promise<void> {
    const user = await this.findOne(id);

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    await this.db.delete(users).where(eq(users.id, id));
  }

  /**
   * Point the user's avatar at an uploaded file, or clear it.
   *
   * `null` removes the picture and falls back to the initials, which still
   * carry the colour assigned at sign-up — so removing a photo returns someone
   * to the avatar their colleagues already knew them by, not to a blank.
   *
   * The previous file is NOT deleted from R2. Two reasons: a stale URL may
   * still be rendering in an open tab, and an avatar is a few kilobytes
   * against a bucket that holds video. A sweep of orphaned keys is a
   * background job, not part of a click.
   */
  async setAvatar(id: string, avatarUrl: string | null): Promise<PublicUser> {
    const [updated] = await this.db
      .update(users)
      .set({ avatarUrl, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    return toPublicUser(updated);
  }
}
