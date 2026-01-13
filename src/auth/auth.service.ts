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
import { workspace } from '../drizzle/schema';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { generateSecureToken, hash } from '../common/utils/encryption.util';
import { DRIZZLE } from '../drizzle/drizzle.module';
import type { DbType } from '../drizzle/db';
import { eq } from 'drizzle-orm';

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
    workspaces: Workspace[];
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
    ) { }

    async register(registerDto: CreateUserDto): Promise<AuthResponse> {
        // Determine role based on SUPER_ADMIN_EMAILS environment variable
        const role = this.determineUserRole(registerDto.email);

        const user = await this.usersService.create(registerDto, role);

        // Generate verification token and send email
        await this.sendVerificationEmailInternal(user.id, user.email, user.name);

        const accessToken = await this.generateAccessToken(user.id, user.email);

        return {
            accessToken,
            user,
            message: 'Registration successful. Please check your email to verify your account.',
        };
    }

    /**
     * Determine user role based on SUPER_ADMIN_EMAILS environment variable
     */
    private determineUserRole(email: string): UserRole {
        const superAdminEmails = this.configService.get<string>('SUPER_ADMIN_EMAILS', '');

        if (!superAdminEmails) {
            return 'USER';
        }

        const adminEmailList = superAdminEmails
            .split(',')
            .map(e => e.trim().toLowerCase())
            .filter(e => e.length > 0);

        if (adminEmailList.includes(email.toLowerCase())) {
            return 'SUPER_ADMIN';
        }

        return 'USER';
    }

    async login(loginDto: LoginDto): Promise<AuthResponse> {
        const user = await this.validateUser(loginDto.email, loginDto.password);

        if (!user) {
            throw new UnauthorizedException('Invalid credentials');
        }

        // Block login if email is not verified (only for SUPER_ADMIN)
        if (user.role === 'SUPER_ADMIN' && !user.isEmailVerified) {
            throw new UnauthorizedException(
                'Please verify your email before logging in. Check your inbox for the verification link.',
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
            throw new UnauthorizedException('User not found')
        }

        // Get all workspaces for the user
        const workspaces = await this.db.query.workspace.findMany({
            where: eq(workspace.ownerId, userId),
            orderBy: (workspace, { desc }) => [desc(workspace.createdAt)]
        });

        // Get last accessed workspace if exists
        let lastAccessedWorkspace: Workspace | null = null;
        if (user.lastAccessedWorkspaceId) {
            const foundWorkspace = await this.db.query.workspace.findFirst({
                where: eq(workspace.id, user.lastAccessedWorkspaceId)
            });
            lastAccessedWorkspace = foundWorkspace || null;
        }

        return {
            user,
            workspaces,
            lastAccessedWorkspace,
        }
    }

    // ==================== Email Verification ====================

    /**
     * Internal method to generate token and send verification email
     */
    private async sendVerificationEmailInternal(
        userId: string,
        email: string,
        name?: string | null,
    ): Promise<void> {
        // Generate a secure token
        const rawToken = generateSecureToken(32);
        // Hash it before storing (we'll compare hashes later)
        const hashedToken = hash(rawToken);

        // Token expires in 24 hours
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);

        // Store hashed token in database
        await this.usersService.setEmailVerificationToken(userId, hashedToken, expiresAt);

        // Send email with raw token (user will click link with raw token)
        await this.emailService.sendVerificationEmail(email, rawToken, name || undefined);
    }

    /**
     * Resend verification email
     */
    async resendVerificationEmail(email: string): Promise<{ message: string }> {
        const user = await this.usersService.findByEmail(email);

        if (!user) {
            // Don't reveal if user exists
            return { message: 'If an account with that email exists, a verification email has been sent.' };
        }

        if (user.isEmailVerified) {
            throw new BadRequestException('Email is already verified.');
        }

        // Rate limiting: Check if token was sent recently (within 1 minute)
        if (user.emailVerificationTokenExpiresAt) {
            const tokenAge = new Date().getTime() - (user.emailVerificationTokenExpiresAt.getTime() - 24 * 60 * 60 * 1000);
            if (tokenAge < 60 * 1000) { // Less than 1 minute ago
                throw new BadRequestException('Please wait before requesting another verification email.');
            }
        }

        await this.sendVerificationEmailInternal(user.id, user.email, user.name);

        return { message: 'Verification email sent. Please check your inbox.' };
    }

    /**
     * Verify email with token
     */
    async verifyEmail(token: string): Promise<{ message: string }> {
        // Hash the provided token to compare with stored hash
        const hashedToken = hash(token);

        const user = await this.usersService.findByVerificationToken(hashedToken);

        if (!user) {
            throw new BadRequestException('Invalid or expired verification token.');
        }

        // Check if token has expired
        if (!user.emailVerificationTokenExpiresAt || user.emailVerificationTokenExpiresAt < new Date()) {
            throw new BadRequestException('Verification token has expired. Please request a new one.');
        }

        // Verify the email
        await this.usersService.verifyEmail(user.id);

        return { message: 'Email verified successfully. You can now log in.' };
    }

    // ==================== Password Reset ====================

    /**
     * Request password reset (forgot password)
     */
    async forgotPassword(email: string): Promise<{ message: string }> {
        const user = await this.usersService.findByEmail(email);

        // Always return same message to prevent email enumeration
        const successMessage = 'If an account with that email exists, a password reset link has been sent.';

        if (!user) {
            return { message: successMessage };
        }

        // Rate limiting: Check if reset was requested recently (within 5 minutes)
        if (user.passwordResetTokenExpiresAt) {
            const tokenAge = new Date().getTime() - (user.passwordResetTokenExpiresAt.getTime() - 60 * 60 * 1000);
            if (tokenAge < 5 * 60 * 1000) { // Less than 5 minutes ago
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
        await this.usersService.setPasswordResetToken(user.id, hashedToken, expiresAt);

        // Send email with raw token
        await this.emailService.sendPasswordResetEmail(user.email, rawToken, user.name || undefined);

        return { message: successMessage };
    }

    /**
     * Reset password with token
     */
    async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
        // Hash the provided token to compare with stored hash
        const hashedToken = hash(token);

        const user = await this.usersService.findByPasswordResetToken(hashedToken);

        if (!user) {
            throw new BadRequestException('Invalid or expired reset token.');
        }

        // Check if token has expired
        if (!user.passwordResetTokenExpiresAt || user.passwordResetTokenExpiresAt < new Date()) {
            throw new BadRequestException('Reset token has expired. Please request a new one.');
        }

        // Reset the password
        await this.usersService.resetPassword(user.id, newPassword);

        return { message: 'Password reset successfully. You can now log in with your new password.' };
    }
}
