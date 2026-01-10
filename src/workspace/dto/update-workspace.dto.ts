import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength, IsUrl } from "class-validator";
import { Transform } from 'class-transformer';

export class UpdateWorkspaceDto {
    @IsString()
    @IsOptional()
    @IsNotEmpty({ message: 'Workspace name cannot be empty' })
    @MinLength(1, { message: 'Workspace name must be at least 1 character' })
    @MaxLength(40, { message: 'Workspace name must not exceed 40 characters' })
    @Transform(({ value }) => value?.trim())
    name?: string;

    @IsString()
    @IsOptional()
    @MaxLength(500, { message: 'Description must not exceed 500 characters' })
    description?: string;

    @IsString()
    @IsOptional()
    @IsUrl({}, { message: 'Logo must be a valid URL' })
    logo?: string;

    @IsString()
    @IsOptional()
    timezone?: string;
}