import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { DbType } from 'src/drizzle/db';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import { CreateUserDto } from './dto/create-user.dto';
import { NewUser, User, users } from 'src/drizzle/schema';
import { eq } from 'drizzle-orm';
import * as bcrypt from 'bcrypt';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
    constructor(@Inject(DRIZZLE) private db: DbType) { }

    async create(createUserDto: CreateUserDto): Promise<Omit<User, 'password'>> {
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
            })
            .returning();

        const { password, ...userWithoutPassword } = newUser;
        return userWithoutPassword;
    }

    async findAll(): Promise<Omit<User, 'password'>[]> {
        const allUsers = await this.db.query.users.findMany({
            columns: {
                id: true,
                email: true,
                name: true,
                createdAt: true,
                updatedAt: true,
            }
        });

        return allUsers
    }

    async findOne(id: string): Promise<Omit<User, 'password'>> {
        const user = await this.db.query.users.findFirst({
            where: eq(users.id, id),
            columns: {
                id: true,
                email: true,
                name: true,
                createdAt: true,
                updatedAt: true,
            },
            // with: {
            //     socialAccounts: true,
            //     posts: true,
            // },
        });

        if (!user) {
            throw new NotFoundException(`User with ID ${id} not found`)
        }

        return user;
    }

    async findByEmail(email: string): Promise<User | undefined> {
        const user = await this.db.query.users.findFirst({
            where: eq(users.email, email)
        });

        return user;
    }

    async update(id: string, updateUserDto: UpdateUserDto): Promise<Omit<User, 'password'>> {
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

        const { password, ...userWithoutPassword } = updatedUser;
        return userWithoutPassword;
    }

    async remove(id: string): Promise<void> {
        const user = await this.findOne(id);

        if (!user) {
            throw new NotFoundException(`User with ID ${id} not found`);
        }

        await this.db.delete(users).where(eq(users.id, id));
    }
}
