import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { DbType } from 'src/drizzle/db';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { workspace, Workspace } from 'src/drizzle/schema';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { UsageService } from 'src/billing/services/usage.service';

type GetAllREsponse = {
    data: Workspace[],
    pagination: {
        page: number,
        limit: number,
        total: number,
        totalPages: number
    }
};

@Injectable()
export class WorkspaceService {
    constructor(
        @Inject(DRIZZLE) private db: DbType,
        private usageService: UsageService,
    ) { }

    async create(createWorkspaceDto: CreateWorkspaceDto, userId: string): Promise<Workspace> {
        // Check workspace limit before creating
        try {
            await this.usageService.enforceWorkspaceLimit(userId);
        } catch (error) {
            // Only throw if it's a ForbiddenException (limit reached)
            // Other errors (like no subscription) should allow first workspace creation
            if (error.status === 403) {
                throw error;
            }
        }

        const slug = this.generateSlug(createWorkspaceDto.name);

        const existingWorkspace = await this.db.query.workspace.findFirst({
            where: eq(workspace.slug, slug)
        });

        if (existingWorkspace) {
            throw new ConflictException(
                `Workspace with name "${createWorkspaceDto.name}" already exists. Please choose a different name.`
            );
        }

        const [newWorkspace] = await this.db
            .insert(workspace)
            .values({
                name: createWorkspaceDto.name,
                slug: slug,
                description: createWorkspaceDto.description || null,
                logo: createWorkspaceDto.logo || null,
                timezone: createWorkspaceDto.timezone || 'UTC',
                ownerId: userId
            })
            .returning()

        return newWorkspace
    }

    private generateSlug(name: string): string {
        return name
            .toLowerCase()
            .trim()
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    async findAllPaginated(
        userId: string,
        page: number = 1,
        limit: number = 10,
        search?: string,
        isActive?: boolean
    ): Promise<GetAllREsponse> {
        const offset = (page - 1) * limit;

        const conditions = [eq(workspace.ownerId, userId)];

        if (typeof isActive === 'boolean') {
            conditions.push(eq(workspace.isActive, isActive));
        }

        const workspaces = await this.db.query.workspace.findMany({
            where: and(...conditions),
            limit: limit,
            offset: offset,
            orderBy: (workspace, { desc }) => [desc(workspace.createdAt)]
        });

        const [{ count }] = await this.db
            .select({ count: sql<number>`count(*)` })
            .from(workspace)
            .where(and(...conditions));

        return {
            data: workspaces,
            pagination: {
                page,
                limit,
                total: Number(count),
                totalPages: Math.ceil(Number(count) / limit),
            },
        }
    }

    async findOne(
        identifier: string,
        userId: string,
        bySlug: boolean = false
    ): Promise<Workspace> {
        const condition = bySlug
            ? eq(workspace.slug, identifier)
            : eq(workspace.id, identifier);

        const result = await this.db.query.workspace.findFirst({
            where: and(
                condition,
                eq(workspace.ownerId, userId)
            ),
            with: {
                owner: {
                    columns: {
                        id: true,
                        name: true,
                        email: true,
                    }
                }
            }
        });

        if (!result) {
            throw new NotFoundException(
                `Workspace with ${bySlug ? 'slug' : 'id'} "${identifier}" not found or you don't have access`
            );
        }

        return result;
    };

    async update(
        workspaceId: string,
        updateWorkspaceDto: UpdateWorkspaceDto,
        userId: string
    ): Promise<Workspace> {
        const existingWorkspace = await this.db.query.workspace.findFirst({
            where: eq(workspace.id, workspaceId)
        });

        if (!existingWorkspace) {
            throw new NotFoundException(`Workspace with id "${workspaceId}" not found`);
        }

        if (existingWorkspace.ownerId !== userId) {
            throw new ForbiddenException('You do not have permission to update this workspace');
        }

        if (updateWorkspaceDto.name) {
            const newSlug = this.generateSlug(updateWorkspaceDto.name);

            if (newSlug !== existingWorkspace.slug) {
                const slugExists = await this.db.query.workspace.findFirst({
                    where: and(
                        eq(workspace.slug, newSlug),
                        sql`${workspace.id} != ${workspaceId}`
                    )
                });

                if (slugExists) {
                    throw new ConflictException(
                        `Workspace with name "${updateWorkspaceDto.name}" already exists. Please choose a different name.`
                    );
                }

                const [updatedWorkspace] = await this.db
                    .update(workspace)
                    .set({
                        ...updateWorkspaceDto,
                        slug: newSlug,
                        updatedAt: new Date(),
                    })
                    .where(eq(workspace.id, workspaceId))
                    .returning();

                return updatedWorkspace;
            }
        }

        const [updatedWorkspace] = await this.db
            .update(workspace)
            .set({
                ...updateWorkspaceDto,
                updatedAt: new Date(),
            })
            .where(eq(workspace.id, workspaceId))
            .returning();

        return updatedWorkspace;
    }

    async remove(workspaceId: string, userId: string): Promise<{ message: string }> {
        const existingWorkspace = await this.db.query.workspace.findFirst({
            where: eq(workspace.id, workspaceId)
        });

        if (!existingWorkspace) {
            throw new NotFoundException(`Workspace with id "${workspaceId}" not found`);
        }

        if (existingWorkspace.ownerId !== userId) {
            throw new ForbiddenException('You do not have permission to delete this workspace');
        }

        await this.db
            .delete(workspace)
            .where(eq(workspace.id, workspaceId));

        return { message: 'Workspace permanently deleted' };
    }
}
