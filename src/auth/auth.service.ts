import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService, PublicUser } from '../users/users.service';
import { EmailService } from '../email/email.service';
import { LoginDto } from './dto/login.dto';
import type { User, UserRole, Workspace } from '../drizzle/schema';
import { users, workspace, workspaceInvitation } from '../drizzle/schema';
import { CreateUserDto } from '../users/dto/create-user.dto';
import {
  generateOtp,
  generateSecureToken,
  hash,
} from '../common/utils/encryption.util';
import { DRIZZLE } from '../drizzle/drizzle.module';
import type { DbType } from '../drizzle/db';
import { and, eq } from 'drizzle-orm';
import { NotificationEmitterService } from '../notifications/notification-emitter.service';
import { AdminChallengeService } from './admin-challenge.service';
import {
  mergeWorkspacesWithRoles,
  type WorkspaceWithRole,
} from './workspace-membership.util';

// OTP expires in 10 minutes — short-lived because the code space is small (1M).
const OTP_TTL_MS = 10 * 60 * 1000;
// Resend rate-limit window: must wait at least this long between requests.
const RESEND_COOLDOWN_MS = 60 * 1000;

export interface TokenPayload {
  sub: string;
  email: string;
}

export interface AuthResponse {
  accessToken: string;
  user: PublicUser;
  message?: string;
}

export interface MeResponse {
  user: PublicUser;
  workspaces: WorkspaceWithRole[];
  lastAccessedWorkspace: Workspace | null;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailService: EmailService,
    private notificationEmitter: NotificationEmitterService,
    // One-way dependency: the challenge service knows nothing about AuthService,
    // so this needs no forwardRef.
    private adminChallengeService: AdminChallengeService,
  ) {}

  async register(registerDto: CreateUserDto): Promise<AuthResponse> {
    // Signup always produces a plain user. Role is never derived from the
    // address someone typed into a public form — SUPER_ADMIN_EMAILS used to do
    // exactly that, which meant anyone who learned a listed address could grant
    // themselves the platform by registering with it first. Promotion is a
    // deliberate database change now, made by someone who already has access.
    const user = await this.usersService.create(registerDto, 'USER');

    // Generate verification token and send email
    await this.sendVerificationEmailInternal(user.id, user.email, user.name);

    const accessToken = await this.generateAccessToken(user.id, user.email);

    return {
      accessToken,
      user,
      message:
        'Registration successful. Please check your email to verify your account.',
    };
  }


  async login(loginDto: LoginDto): Promise<AuthResponse> {
    const user = await this.validateUser(loginDto.email, loginDto.password);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Block login for suspended accounts. Without this, a suspended user
    // "logs in" successfully, then immediately 401s on /auth/me — confusing.
    if (!user.isActive) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        code: 'ACCOUNT_SUSPENDED',
        reason: user.suspendedReason ?? 'manual',
        message: 'Your account has been suspended.',
      });
    }

    // Block login if email is not verified (only for SUPER_ADMIN)
    if (user.role === 'SUPER_ADMIN' && !user.isEmailVerified) {
      throw new UnauthorizedException(
        'Please verify your email before logging in. Check your inbox for the verification link.',
      );
    }

    // Second factor, super admins only. A correct password on its own is not
    // enough to reach an account that can read every customer's data — the
    // caller must also have proved control of the mailbox in this same flow.
    //
    // Scoped to SUPER_ADMIN deliberately: making every customer type an
    // emailed code on every sign-in would cost far more in abandoned logins
    // than it buys, and their accounts are not the ones worth this friction.
    if (user.role === 'SUPER_ADMIN') {
      this.adminChallengeService.verifyChallengeToken(
        loginDto.challengeToken,
        user.id,
      );
    }

    const accessToken = await this.generateAccessToken(user.id, user.email);

    const {
      password: _password,
      emailVerificationToken: _evt,
      emailVerificationTokenExpiresAt: _evte,
      passwordResetToken: _prt,
      passwordResetTokenExpiresAt: _prte,
      ...publicUser
    } = user;

    return {
      accessToken,
      user: publicUser,
    };
  }

  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.usersService.findByEmail(email);

    if (!user) {
      return null;
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return null;
    }

    return user;
  }

  async generateAccessToken(userId: string, email: string): Promise<string> {
    const payload = { sub: userId, email };
    const secret = this.configService.get<string>('JWT_ACCESS_SECRET');

    if (!secret) {
      throw new Error('JWT_ACCESS_SECRET is not defined');
    }

    return this.jwtService.sign(payload, {
      secret,
      expiresIn: '15m',
    });
  }

  async generateRefreshToken(userId: string, email: string): Promise<string> {
    const payload = { sub: userId, email };
    const secret = this.configService.get<string>('JWT_REFRESH_SECRET');

    if (!secret) {
      throw new Error('JWT_REFRESH_SECRET is not defined');
    }

    return this.jwtService.sign(payload, {
      secret,
      expiresIn: '7d',
    });
  }

  async refreshTokens(userId: string, email: string): Promise<string> {
    const accessToken = await this.generateAccessToken(userId, email);
    return accessToken;
  }

  async whoAmI(userId: string): Promise<MeResponse> {
    const user = await this.usersService.findOne(userId);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Get all workspaces for the user
    const workspaces = await this.db.query.workspace.findMany({
      where: eq(workspace.ownerId, userId),
      orderBy: (workspace, { desc }) => [desc(workspace.createdAt)],
    });

    // Get accepted memberships (workspaces the user belongs to but doesn't own)
    const memberRows = await this.db.query.workspaceInvitation.findMany({
      where: and(
        eq(workspaceInvitation.userId, userId),
        eq(workspaceInvitation.status, 'ACCEPTED'),
      ),
      with: { workspace: true },
    });
    const memberships = memberRows
      .filter((r) => r.workspace)
      .map((r) => ({
        workspace: r.workspace!,
        role: r.role as 'ADMIN' | 'MEMBER' | 'GUEST',
      }));
    const merged = mergeWorkspacesWithRoles(workspaces, memberships);

    // Get last accessed workspace if exists
    let lastAccessedWorkspace: Workspace | null = null;
    if (user.lastAccessedWorkspaceId) {
      const foundWorkspace = await this.db.query.workspace.findFirst({
        where: eq(workspace.id, user.lastAccessedWorkspaceId),
      });
      lastAccessedWorkspace = foundWorkspace || null;
    }

    return {
      user,
      workspaces: merged,
      lastAccessedWorkspace,
    };
  }

  /**
   * Stamps the user as having completed the multi-step onboarding flow and
   * returns the fresh `whoAmI` payload so the frontend can replace its
   * cached /auth/me without a second round-trip.
   */
  async markOnboardingCompleted(userId: string): Promise<MeResponse> {
    await this.usersService.markOnboardingCompleted(userId);
    return this.whoAmI(userId);
  }

  // ==================== Email Verification ====================

  /**
   * Internal method to generate an OTP and send the verification email.
   *
   * Stores the SHA-256 hash of the OTP so a database leak doesn't expose
   * codes. The plain OTP is sent to the user via email and is what they
   * type into the OTP form.
   */
  private async sendVerificationEmailInternal(
    userId: string,
    email: string,
    name?: string | null,
  ): Promise<void> {
    const otp = generateOtp(6);
    const hashedOtp = hash(otp);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await this.usersService.setEmailVerificationToken(
      userId,
      hashedOtp,
      expiresAt,
    );

    await this.emailService.sendVerificationEmail(
      email,
      otp,
      name || undefined,
    );
  }

  /**
   * Resend verification email
   */
  async resendVerificationEmail(email: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);

    if (!user) {
      // Don't reveal if user exists
      return {
        message:
          'If an account with that email exists, a verification email has been sent.',
      };
    }

    if (user.isEmailVerified) {
      throw new BadRequestException('Email is already verified.');
    }

    // Rate limiting: enforce a cooldown between resend requests so users
    // can't spam the email service.
    if (user.emailVerificationTokenExpiresAt) {
      const issuedAt =
        user.emailVerificationTokenExpiresAt.getTime() - OTP_TTL_MS;
      const ageMs = Date.now() - issuedAt;
      if (ageMs < RESEND_COOLDOWN_MS) {
        throw new BadRequestException(
          'Please wait before requesting another verification email.',
        );
      }
    }

    await this.sendVerificationEmailInternal(user.id, user.email, user.name);

    return { message: 'Verification email sent. Please check your inbox.' };
  }

  /**
   * Verify email with token (legacy link-based flow).
   *
   * Kept for backwards compatibility — the primary verification path is now
   * OTP-based via `verifyEmailWithOtp`, which is auth-required and looks up
   * by user ID to avoid cross-user OTP collisions.
   */
  async verifyEmail(token: string): Promise<{ message: string }> {
    const hashedToken = hash(token);

    const user = await this.usersService.findByVerificationToken(hashedToken);

    if (!user) {
      throw new BadRequestException('Invalid or expired verification token.');
    }

    if (
      !user.emailVerificationTokenExpiresAt ||
      user.emailVerificationTokenExpiresAt < new Date()
    ) {
      throw new BadRequestException(
        'Verification token has expired. Please request a new one.',
      );
    }

    await this.usersService.verifyEmail(user.id);

    await this.notificationEmitter.emailVerified(user.id);

    return { message: 'Email verified successfully. You can now log in.' };
  }

  /**
   * Verify email with OTP for an authenticated user.
   *
   * Looks up the OTP hash on the user's own record (no cross-user search),
   * so two users with the same 6-digit code don't collide.
   */
  async verifyEmailWithOtp(
    userId: string,
    otp: string,
  ): Promise<{ message: string }> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    if (user.isEmailVerified) {
      return { message: 'Email is already verified.' };
    }

    if (!user.emailVerificationToken || !user.emailVerificationTokenExpiresAt) {
      throw new BadRequestException(
        'No verification code is pending. Please request a new one.',
      );
    }

    if (user.emailVerificationTokenExpiresAt < new Date()) {
      throw new BadRequestException(
        'Verification code has expired. Please request a new one.',
      );
    }

    const hashedOtp = hash(otp);
    if (hashedOtp !== user.emailVerificationToken) {
      throw new BadRequestException('Invalid verification code.');
    }

    await this.usersService.verifyEmail(user.id);
    await this.notificationEmitter.emailVerified(user.id);

    return { message: 'Email verified successfully.' };
  }

  // ==================== Password Reset ====================

  /**
   * Request password reset (forgot password)
   */
  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);

    // Always return same message to prevent email enumeration
    const successMessage =
      'If an account with that email exists, a password reset link has been sent.';

    if (!user) {
      return { message: successMessage };
    }

    // Rate limiting: Check if reset was requested recently (within 5 minutes)
    if (user.passwordResetTokenExpiresAt) {
      const tokenAge =
        new Date().getTime() -
        (user.passwordResetTokenExpiresAt.getTime() - 60 * 60 * 1000);
      if (tokenAge < 5 * 60 * 1000) {
        // Less than 5 minutes ago
        return { message: successMessage }; // Silent fail for rate limiting
      }
    }

    // Generate a secure token
    const rawToken = generateSecureToken(32);
    const hashedToken = hash(rawToken);

    // Token expires in 1 hour
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);

    // Store hashed token in database
    await this.usersService.setPasswordResetToken(
      user.id,
      hashedToken,
      expiresAt,
    );

    // Send email with raw token
    await this.emailService.sendPasswordResetEmail(
      user.email,
      rawToken,
      user.name || undefined,
    );

    return { message: successMessage };
  }

  /**
   * Reset password with token
   */
  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    // Hash the provided token to compare with stored hash
    const hashedToken = hash(token);

    const user = await this.usersService.findByPasswordResetToken(hashedToken);

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token.');
    }

    // Check if token has expired
    if (
      !user.passwordResetTokenExpiresAt ||
      user.passwordResetTokenExpiresAt < new Date()
    ) {
      throw new BadRequestException(
        'Reset token has expired. Please request a new one.',
      );
    }

    // Reset the password
    await this.usersService.resetPassword(user.id, newPassword);

    // Send notification
    await this.notificationEmitter.passwordChanged(user.id);

    return {
      message:
        'Password reset successfully. You can now log in with your new password.',
    };
  }
}
