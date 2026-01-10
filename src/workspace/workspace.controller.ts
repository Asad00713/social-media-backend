import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseBoolPipe, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';

@Controller('workspace')
export class WorkspaceController {
    constructor(private readonly workspaceService: WorkspaceService) { }

    @Post()
    @UseGuards(JwtAuthGuard)
    async create(
        @Body() dto: CreateWorkspaceDto,
        @CurrentUser() user: { userId: string; email: string }
    ) {
        return this.workspaceService.create(dto, user.userId);
    }

    @Get()
    @UseGuards(JwtAuthGuard)
    async findAll(
        @CurrentUser() user: { userId: string; email: string },
        @Query('page', new ParseIntPipe({ optional: true })) page: number = 1,
        @Query('limit', new ParseIntPipe({ optional: true })) limit: number = 10,
        @Query('search') search?: string,
        @Query('isActive', new ParseBoolPipe({ optional: true })) isActive?: boolean,
    ) {
        const result = await this.workspaceService.findAllPaginated(
            user.userId,
            page,
            limit,
            search,
            isActive,
        );

        return {
            success: true,
            ...result,
        };
    };

    @Get(':id')
    @UseGuards(JwtAuthGuard)
    async findOne(
        @Param('id') id: string,
        @CurrentUser() user: { userId: string; email: string },
    ) {
        const workspace = await this.workspaceService.findOne(id, user.userId);

        return {
            success: true,
            data: workspace,
        };
    }

    @Get('slug/:slug')
    @UseGuards(JwtAuthGuard)
    async findBySlug(
        @Param('slug') slug: string,
        @CurrentUser() user: { userId: string; email: string },
    ) {
        const workspace = await this.workspaceService.findOne(slug, user.userId, true);

        return {
            success: true,
            data: workspace,
        };
    }

    @Patch(':id')
    @UseGuards(JwtAuthGuard)
    async update(
        @Param('id') id: string,
        @Body() updateWorkspaceDto: UpdateWorkspaceDto,
        @CurrentUser() user: { userId: string; email: string },
    ) {
        const workspace = await this.workspaceService.update(
            id,
            updateWorkspaceDto,
            user.userId,
        );

        return {
            success: true,
            message: 'Workspace updated successfully',
            data: workspace,
        };
    };

    @Delete(':id/permanent')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    async removePermanently(
        @Param('id') id: string,
        @CurrentUser() user: { userId: string; email: string },
    ) {
        const result = await this.workspaceService.remove(id, user.userId);

        return {
            success: true,
            ...result,
        };
    }
}
