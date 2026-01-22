import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { DbType } from 'src/drizzle/db';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import { CreateUserDto } from './dto/create-user.dto';
import { NewUser, User, users, UserRole } from 'src/drizzle/schema';
import { eq, sql } from 'drizzle-orm';
import * as bcrypt from 'bcrypt';
import { UpdateUserDto } from './dto/update-user.dto';

// Public user type that excludes sensitive fields
export type PublicUser = Pick<User, 'id' | 'email' | 'name' | 'role' | 'isEmailVerified' | 'lastAccessedWorkspaceId' | 'createdAt' | 'updatedAt'>;

@Injectable()
export class UsersService {
    constructor(@Inject(DRIZZLE) private db: DbType) { }

    async create(createUserDto: CreateUserDto, role: UserRole = 'USER'): Promise<PublicUser> {
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
            })
            .returning();

        return {
            id: newUser.id,
            email: newUser.email,
            name: newUser.name,
            role: newUser.role,
            isEmailVerified: newUser.isEmailVerified,
            lastAccessedWorkspaceId: newUser.lastAccessedWorkspaceId,
            createdAt: newUser.createdAt,
            updatedAt: newUser.updatedAt,
        };
    }

    async findAll(): Promise<PublicUser[]> {
        const allUsers = await this.db.query.users.findMany({
            columns: {
                id: true,
                email: true,
                name: true,
                role: true,
                isEmailVerified: true,
                lastAccessedWorkspaceId: true,
                createdAt: true,
                updatedAt: true,
            }
        });

        return allUsers;
    }

    async findOne(id: string): Promise<PublicUser> {
        const user = await this.db.query.users.findFirst({
            where: eq(users.id, id),
            columns: {
                id: true,
                email: true,
                name: true,
                role: true,
                isEmailVerified: true,
                lastAccessedWorkspaceId: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        if (!user) {
            throw new NotFoundException(`User with ID ${id} not found`)
        }

        return user;
    }

    async findOneWithSuspension(id: string): Promise<PublicUser & { isActive: boolean; suspendedReason: string | null }> {
        const user = await this.db.query.users.findFirst({
            where: eq(users.id, id),
            columns: {
                id: true,
                email: true,
                name: true,
                role: true,
                isEmailVerified: true,
                lastAccessedWorkspaceId: true,
                isActive: true,
                suspendedReason: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        if (!user) {
            throw new NotFoundException(`User with ID ${id} not found`)
        }

        return user;
    }

    async findByVerificationToken(token: string): Promise<User | undefined> {
        const user = await this.db.query.users.findFirst({
            where: eq(users.emailVerificationToken, token)
        });

        return user;
    }

    async findByPasswordResetToken(token: string): Promise<User | undefined> {
        const user = await this.db.query.users.findFirst({
            where: eq(users.passwordResetToken, token)
        });

        return user;
    }

    async setEmailVerificationToken(userId: string, token: string, expiresAt: Date): Promise<void> {
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

    async setPasswordResetToken(userId: string, token: string, expiresAt: Date): Promise<void> {
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
            where: eq(users.email, email)
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
            updatedAt: new Date()
        };

        if (updateUserDto.password) {
            updateData.password = await bcrypt.hash(updateUserDto.password, 10);
        }

        const [updatedUser] = await this.db
            .update(users)
            .set(updateData)
            .where(eq(users.id, id))
            .returning();

        return {
            id: updatedUser.id,
            email: updatedUser.email,
            name: updatedUser.name,
            role: updatedUser.role,
            isEmailVerified: updatedUser.isEmailVerified,
            lastAccessedWorkspaceId: updatedUser.lastAccessedWorkspaceId,
            createdAt: updatedUser.createdAt,
            updatedAt: updatedUser.updatedAt,
        };
    }

    async setLastAccessedWorkspace(userId: string, workspaceId: string): Promise<void> {
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
}
